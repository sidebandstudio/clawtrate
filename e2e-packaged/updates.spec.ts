// The same main entry, sandboxed preload and renderer as the launch check.
// Only this temporary build links the service to the test's own feed.
import { _electron, expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { feedFor, feedServer, json, payload } from "../apps/desktop/test/update/harness.ts";
import { fileKeyFor, FILE_EXTENSION } from "../apps/desktop/src/main/update/feed.ts";
import { appEnv } from "./global-setup.ts";

test("F-231 checks only the chosen feed and downloads matching bytes on request", async () => {
  test.setTimeout(120000);
  const desktop = join(import.meta.dirname, "../apps/desktop");
  const require = createRequire(join(desktop, "package.json"));
  const dir = mkdtempSync(join(desktop, ".screen-test-"));
  const server = await feedServer();
  const resume = Promise.withResolvers<void>();
  let app: ElectronApplication | undefined;
  try {
    const key = fileKeyFor(process.platform, process.arch);
    if (!key) throw new Error("The desktop check needs a supported package target");
    const { body, sha512 } = payload(4000000);
    const filePath = "/file." + FILE_EXTENSION[key];
    const file = { url: server.origin + filePath, size: body.length, sha512 };
    const manifest = feedFor(server.origin, "1.1.0", file, { files: { [key]: file } });
    server.route("/stable", json(manifest));
    server.route(
      "/nightly",
      json({ ...manifest, track: "nightly", version: "0.1.0-nightly.20261101.1" }),
    );
    server.route(filePath, async (_, response) => {
      response.writeHead(200, { "content-length": body.length });
      response.write(body.subarray(0, 2000000));
      await resume.promise;
      response.end(body.subarray(2000000));
    });
    const env = appEnv();
    execFileSync(
      process.execPath,
      [
        join(desktop, "node_modules/electron-vite/bin/electron-vite.js"),
        "build",
        "--config",
        "test/update/electron.config.ts",
        "--outDir",
        join(dir, "out"),
      ],
      { cwd: desktop, env: { ...env, UPDATE_SCREEN_TEST_PORT: String(server.port) } },
    );
    cpSync(join(desktop, "resources"), join(dir, "resources"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "update-screen-test",
        version: "0.1.0",
        type: "module",
        main: "out/main/index.js",
      }),
    );
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [dir, "--user-data-dir=" + join(dir, "profile")],
      env: { ...env, CLAWTRATE_DEV_INSTANCE: "update-screen-test" },
    });
    const page = await app.firstWindow();
    await page.locator(".app").waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByRole("button", { name: "Updates", exact: true }).click();
    const line = page.locator(".updates-section dd").last();
    await expect(line).toHaveText("Not checked yet.");
    await expect(
      page.getByText("Checks 127.0.0.1 for a newer build, only when you choose to."),
    ).toBeVisible();
    expect(server.requests).toEqual([]);
    await page.getByRole("button", { name: "Check for Updates" }).click();
    await expect(line).toHaveText("Clawtrate 1.1.0 is offered by the update source.");
    expect(server.requests).toEqual(["/stable"]);
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await expect
      .poll(async () => Number(await page.getByRole("progressbar").getAttribute("value")))
      .toBeGreaterThan(0);
    await expect(line).toContainText("of 4,000,000 bytes");
    expect(server.requests).toEqual(["/stable", filePath]);
    await expect(line).not.toContainText("checksum");
    resume.resolve();
    await expect(line).toHaveText(
      "Clawtrate 1.1.0 is downloaded, and its size and checksum match the update source. Installation isn't available from this screen.",
    );
    await expect(page.getByRole("button", { name: "Restart to Update" })).toHaveCount(0);
    await page.getByRole("radio", { name: "Nightly" }).check();
    await expect(line).toHaveText("Not checked yet.");
    expect(server.requests).toEqual(["/stable", filePath]);
    await page.getByRole("button", { name: "Check for Updates" }).click();
    await expect(line).toHaveText(
      "No newer Nightly build was offered. Clawtrate 0.1.0 is still running.",
    );
    expect(server.requests).toEqual(["/stable", filePath, "/nightly"]);

    // Same size, different checksum. Only a new check can offer another download.
    const damaged = Buffer.from(body);
    damaged[0] = damaged[0]! ^ 1;
    server.route(filePath, (_req, res) => res.end(damaged));
    await page.getByRole("radio", { name: "Stable" }).check();
    await page.getByRole("button", { name: "Check for Updates" }).click();
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await expect(line).toHaveText("Couldn't download the update. Try again.");
    await expect(page.getByRole("button", { name: "Restart to Update" })).toHaveCount(0);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(line).toHaveText("Clawtrate 1.1.0 is offered by the update source.");
    expect(server.requests).toEqual([
      "/stable",
      filePath,
      "/nightly",
      "/stable",
      filePath,
      "/stable",
    ]);
  } finally {
    resume.resolve();
    try {
      await app?.close();
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
