// The same main entry, sandboxed preload and renderer as the launch check.
// Only this temporary build links the service to the test's own feed.
import { expect, test as base, type Page } from "@playwright/test";
import { once } from "node:events";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  chmodSync,
  statSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  rmSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import type { DesktopUpdates } from "../packages/core/src/desktop-updates.ts";
import { join } from "node:path";
import { sidebarGateway } from "../apps/desktop/test/update/sidebar-gateway.ts";
import { feedFor, feedServer, json, payload } from "../apps/desktop/test/update/harness.ts";
import { fileKeyFor, FILE_EXTENSION } from "../apps/desktop/src/main/update/feed.ts";
import { appEnv, debuggingPort } from "../e2e-packaged/desktop-driver.ts";
import { askToClose, forceEnd } from "../e2e-packaged/windows.ts";

type TestApp = {
  page: Page;
  relaunch: (version: string) => Promise<Page>;
  server: Awaited<ReturnType<typeof feedServer>>;
  filePath: string;
  body: Buffer;
  profile: string;
  resume: () => void;
  manifest: Record<string, unknown>;
  rendererRequests: string[];
};
async function stopElectron(app: ChildProcess) {
  const { pid } = app;
  if (!pid || app.exitCode !== null || app.signalCode !== null) return;
  const deadline = AbortSignal.timeout(25_000);
  const exited = once(app, "exit", { signal: deadline });
  const windows = process.platform === "win32";
  const force = () => {
    if (windows) forceEnd(pid);
    else app.kill("SIGKILL");
  };
  const timer = setTimeout(force, 15_000);
  try {
    if (windows) {
      if (askToClose(pid)) force();
    } else app.kill("SIGTERM");
    await exited;
  } catch (error) {
    if (deadline.aborted)
      throw new Error(`Electron PID ${pid} did not exit after forced shutdown`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const test = base.extend<{ desktopApp: TestApp; installer: "unsigned" | "mac" | "manual" }>({
  installer: ["unsigned", { option: true }],
  desktopApp: async ({ playwright, installer }, use) => {
    const desktop = join(import.meta.dirname, "../apps/desktop");
    const require = createRequire(join(desktop, "package.json"));
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-update-app-")));
    const cleanup = new AsyncDisposableStack();
    cleanup.defer(() =>
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    );
    const resume = Promise.withResolvers<void>();
    try {
      const server = await feedServer();
      cleanup.defer(() => server.close());
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
        {
          cwd: desktop,
          env: { ...env, UPDATE_SCREEN_TEST_PORT: String(server.port) },
          timeout: 60_000,
          killSignal: "SIGKILL",
        },
      );
      cpSync(join(desktop, "resources"), join(dir, "resources"), { recursive: true });
      symlinkSync(
        join(desktop, "node_modules"),
        join(dir, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const profile = join(dir, "profile");
      const rendererRequests: string[] = [];
      let previous: ChildProcess | undefined;
      async function launch(version: string) {
        if (previous) {
          await stopElectron(previous);
          rmSync(join(profile, "DevToolsActivePort"), { force: true });
        }
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            name: "update-screen-test",
            version,
            type: "module",
            main: "out/main/index.js",
          }),
        );
        const app = spawn(
          require("electron"),
          [dir, "--user-data-dir=" + profile, "--remote-debugging-port=0"],
          {
            cwd: dir,
            env: {
              ...env,
              UPDATE_SCREEN_TEST_INSTALLER: installer,
              CLAWTRATE_DEV_INSTANCE: "update-ui-test",
            },
            stdio: "ignore",
          },
        );
        previous = app;
        cleanup.defer(() => stopElectron(app));
        await once(app, "spawn");
        const port = await debuggingPort(profile, app);
        const browser = await playwright.chromium.connectOverCDP("http://127.0.0.1:" + port);
        cleanup.defer(() => browser.close());
        const context = browser.contexts()[0]!;
        const page = context.pages()[0] ?? (await context.waitForEvent("page"));
        await page.locator(".app").waitFor();
        page.on("request", (r) => {
          if (/^https?:/.test(r.url())) rendererRequests.push(r.url());
        });
        return page;
      }
      await use({
        page: await launch("0.1.0"),
        relaunch: launch,
        server,
        filePath,
        body,
        profile,
        resume: resume.resolve,
        manifest,
        rendererRequests,
      });
    } finally {
      resume.resolve();
      await cleanup.disposeAsync();
    }
  },
});
test("F-231: checks only the chosen feed and downloads matching bytes on request", async ({
  desktopApp,
}) => {
  const { page, server, filePath, body, manifest, resume, rendererRequests } = desktopApp;
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  const line = page.locator(".updates-section dd").last();
  await expect(line).toHaveText("Not checked yet.");
  await expect(
    page.getByText("Checks 127.0.0.1 for a newer build, only when you choose to."),
  ).toBeVisible();
  await expect(page.getByText("Clawtrate 0.1.0", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("radio", { name: "Stable" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect(server.requests).toEqual([]);
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await expect(line).toHaveText("Clawtrate 1.1.0 is offered by the update source.");
  expect(server.requests).toEqual(["/stable"]);
  await expect(page.locator("#update-source")).toHaveText(
    "Downloads Clawtrate 1.1.0 from 127.0.0.1, only when you choose to.",
  );
  const download = page.getByRole("button", { name: "Download", exact: true });
  await download.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("group", { name: "Update status" })).toBeFocused();
  // Windows prepares two protected directories before it requests the first byte.
  await expect.poll(() => server.requests, { timeout: 35_000 }).toContain(filePath);
  await expect
    .poll(async () => Number(await page.getByRole("progressbar").getAttribute("value")))
    .toBeGreaterThan(0);
  const bar = page.getByRole("progressbar");
  expect(Number(await bar.getAttribute("value"))).toBeLessThan(body.length);
  await expect(bar).toHaveAttribute("max", String(body.length));
  const total = await page.evaluate((size) => size.toLocaleString(), body.length);
  await expect(line).toContainText(`of ${total} bytes`);
  expect(server.requests).toEqual(["/stable", filePath]);
  await expect(line).not.toContainText("checksum");
  resume();
  await expect(line).toHaveText(
    "Clawtrate 1.1.0 is downloaded, and its size and checksum match the update source. Installation isn't available from this screen.",
  );
  await expect(page.getByRole("button", { name: "Restart to Update" })).toHaveCount(0);
  const nightly = page.getByRole("radio", { name: "Nightly" });
  await nightly.click();
  await expect(nightly).toBeChecked();
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
  const stable = page.getByRole("radio", { name: "Stable" });
  await stable.click();
  await expect(stable).toBeChecked();
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(line).toHaveText("The downloaded file doesn't match the update source.");
  await expect(page.getByRole("button", { name: "Restart to Update" })).toHaveCount(0);
  const key = fileKeyFor(process.platform, process.arch)!;
  const files = manifest.files as Record<string, { size: number; sha512: string; url: string }>;
  server.route(
    "/stable",
    json({ ...manifest, files: { [key]: { ...files[key]!, size: body.length + 1 } } }),
  );
  server.route(filePath, (_req, res) => res.end(body));
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await expect(line).toHaveText("Clawtrate 1.1.0 is offered by the update source.");
  expect(server.requests).toEqual([
    "/stable",
    filePath,
    "/nightly",
    "/stable",
    filePath,
    "/stable",
  ]);

  await download.click();
  await expect(line).toHaveText("The downloaded file doesn't match the update source.");
  await expect(page.getByRole("button", { name: "Restart to Update" })).toHaveCount(0);
  const reading = await page.evaluate(() =>
    (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.get(),
  );
  expect(reading.state).toMatchObject({
    kind: "failed",
    stage: "download",
    reason: "size-mismatch",
  });
  expect(server.requests).toEqual([
    "/stable",
    filePath,
    "/nightly",
    "/stable",
    filePath,
    "/stable",
    filePath,
  ]);
  expect(rendererRequests).toEqual([]);
});

type ProbeWindow = Window & {
  clawtrateHost: { desktopUpdates: DesktopUpdates };
  seenUpdates: string[];
};
async function checkStable() {
  const api = (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates;
  return api.check("stable", (await api.get()).revision);
}
for (const stage of ["check", "download"] as const) {
  test(`F-231: retires a held ${stage} while saving a track`, async ({ desktopApp }) => {
    const { page, server, filePath, body, profile, manifest, resume } = desktopApp;
    const delayed = Promise.withResolvers<void>();
    if (stage === "check")
      server.route("/stable", async (req, res) => {
        await delayed.promise;
        json(manifest)(req, res);
      });
    try {
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByRole("button", { name: "Updates", exact: true }).click();
      await page.evaluate(() => {
        const w = window as unknown as ProbeWindow;
        w.seenUpdates = [];
        const updates = w.clawtrateHost.desktopUpdates;
        updates.subscribe(() => {
          throw new Error("A subscriber failed");
        });
        updates.subscribe((s) => {
          w.seenUpdates.push(s.state.kind);
        });
      });
      const status = page.getByRole("group", { name: "Update status" });
      const check = page.getByRole("button", { name: "Check for Updates" });
      const download = page.getByRole("button", { name: "Download", exact: true });
      const stable = page.getByRole("radio", { name: "Stable" }),
        nightly = page.getByRole("radio", { name: "Nightly" });
      await check.focus();
      await page.keyboard.press("Enter");
      await expect(status).toBeFocused();
      await expect.poll(() => server.requests).toEqual(["/stable"]);
      let id = "";
      if (stage === "download") {
        await expect(download).toBeVisible();
        id = await page.evaluate(async () => {
          const s = await (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.get();
          return s.state.kind === "offered" ? s.state.offerId : "";
        });
        expect(id).not.toBe("");
        await download.click();
        await expect.poll(() => server.requests, { timeout: 35_000 }).toContain(filePath);
        await expect
          .poll(async () => Number(await page.getByRole("progressbar").getAttribute("value")))
          .toBeGreaterThan(0);
        await page.keyboard.press("Escape");
        await page.keyboard.press("ControlOrMeta+,");
        await expect(page.getByRole("progressbar")).toBeVisible();
      }
      const before = stage === "check" ? ["/stable"] : ["/stable", filePath];
      writeFileSync(join(profile, "hold-choice"), "");
      if (stage === "download") writeFileSync(join(profile, "refuse-choice"), "");
      await nightly.click();
      const pending = page
        .locator(".b-hint")
        .filter({ hasText: "Saving Nightly as the update track…" });
      await expect(pending).toBeVisible();
      await expect(stable).toBeChecked();
      await expect(check).toHaveCount(0);
      await expect(download).toHaveCount(0);
      await expect(page.locator("#update-source")).toHaveCount(0);
      await expect(page.getByRole("progressbar")).toHaveCount(0);
      await nightly.press("ArrowLeft");
      await nightly.press("Space");
      await expect(stable).toBeChecked();
      const busy = await page.evaluate(checkStable);
      expect(busy.outcome).toBe("busy");
      delayed.resolve();
      resume();
      await expect(status.locator("dd")).toHaveText("Not checked yet.");
      await expect(pending).toBeVisible();
      rmSync(join(profile, "hold-choice"));
      await expect(pending).toHaveCount(0);
      await expect(stage === "check" ? nightly : stable).toBeChecked();
      await expect(check).toBeVisible();
      if (stage === "download") {
        const notice = page.getByText("Couldn't save the track. Stable is still selected.", {
          exact: true,
        });
        await expect(notice).toBeVisible();
        const stale = await page.evaluate(
          (id) => (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.download(id),
          id,
        );
        expect(stale.outcome).toBe("stale");
        await expect(notice).toBeVisible();
      } else {
        const stale = await page.evaluate(checkStable);
        expect(stale.outcome).toBe("stale");
      }
      expect(server.requests).toEqual(before);
      const seen = await page.evaluate(() => (window as unknown as ProbeWindow).seenUpdates);
      expect(seen).toContain("checking");
      if (stage === "download")
        expect(seen).toEqual(expect.arrayContaining(["offered", "downloading", "not-checked"]));
      server.route("/stable", json(manifest));
      server.route(filePath, (_req, r) => r.end(body));
      if (stage === "check") {
        await stable.click();
        await expect(stable).toBeChecked();
      }
      await check.click();
      await download.click();
      await expect(status).toContainText("checksum match");
      expect(await page.evaluate(() => (window as unknown as ProbeWindow).seenUpdates)).toContain(
        "verified",
      );
    } finally {
      delayed.resolve();
      resume();
      rmSync(join(profile, "hold-choice"), { force: true });
    }
  });
}

test("F-231: a stale check or download reconciles the screen without contacting a different source or file", async ({
  desktopApp,
}) => {
  const { page, profile, server, manifest } = desktopApp;
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  const line = page.locator(".update-result dd");
  const check = page.getByRole("button", { name: "Check for Updates" });
  const download = page.getByRole("button", { name: "Download", exact: true });
  const hold = join(profile, "hold-events");
  writeFileSync(hold, "");
  const choice = await page.evaluate(() =>
    (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.chooseTrack("nightly"),
  );
  expect(choice.outcome).toBe("accepted");
  await expect(page.getByRole("radio", { name: "Stable" })).toBeChecked();
  await check.click();
  await expect(page.getByRole("radio", { name: "Nightly" })).toBeChecked();
  await expect(page.locator(".update-result")).toContainText(
    "The update track changed. Check the selected source again.",
  );
  expect(server.requests).toEqual([]);
  rmSync(hold);
  await page.getByRole("radio", { name: "Stable" }).click();
  await expect(page.getByRole("radio", { name: "Stable" })).toBeChecked();
  await check.click();
  await expect(line).toContainText("1.1.0 is offered");
  writeFileSync(hold, "");
  server.route("/stable", json({ ...manifest, version: "1.2.0" }));
  const second = await page.evaluate(checkStable);
  expect(second.snapshot.state.kind).toBe("offered");
  await expect(line).toContainText("1.1.0 is offered");
  await download.click();
  await expect(line).toContainText("1.2.0 is offered");
  expect(server.requests).toEqual(["/stable", "/stable"]);
});

test("F-231: an older Check on the same track preserves the verified download", async ({
  desktopApp,
}) => {
  const { page, profile, server, filePath, body, resume } = desktopApp;
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  const line = page.locator(".update-result dd");
  writeFileSync(join(profile, "hold-events"), "");
  const {
    snapshot: { state: offer },
  } = await page.evaluate(checkStable);
  if (offer.kind !== "offered") throw new Error("Expected an offer");
  resume();
  const verified = await page.evaluate(
    (id) => (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.download(id),
    offer.offerId,
  );
  expect(verified.snapshot.state).toMatchObject({ kind: "verified", offerId: offer.offerId });
  const offerDir = join(profile, "updates", offer.offerId);
  const files = readdirSync(offerDir);
  expect(files).toHaveLength(1);
  const artifact = join(offerDir, files[0]!);
  expect(readFileSync(artifact).equals(body)).toBe(true);
  await expect(line).toHaveText("Not checked yet.");
  expect(server.requests).toEqual(["/stable", filePath]);
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await expect(line).toContainText("its size and checksum match the update source.");
  await expect(
    page.getByRole("button", { name: /^(Check for Updates|Download|Restart to Update)$/ }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.get(),
    ),
  ).toEqual(verified.snapshot);
  expect(readFileSync(artifact).equals(body)).toBe(true);
  expect(server.requests).toEqual(["/stable", filePath]);
});

if (process.platform !== "win32")
  test("F-231 F-030: a storage-blocked check opens from the sidebar and retries the chosen feed", async ({
    desktopApp,
  }) => {
    const { page, profile, server } = desktopApp;
    const gateway = await sidebarGateway();
    const mode = statSync(profile).mode & 0o777;
    try {
      await page.getByPlaceholder("Gateway address").fill(gateway.url);
      await page.getByRole("button", { name: "Connect a gateway", exact: true }).click();
      await expect(page.locator(".rail")).toBeVisible();
      const entry = page.getByRole("button", { name: "Open Updates" });
      await expect(entry).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByRole("button", { name: "Updates", exact: true }).click();
      chmodSync(profile, 0o770);
      await page.getByRole("button", { name: "Check for Updates" }).click();
      const line = page.locator(".update-result dd");
      const notice = page
        .locator(".update-result")
        .getByText("Couldn't prepare update storage on this device.", { exact: true });
      await expect(line).toHaveText("Couldn't check for updates.");
      await expect(notice).toBeVisible();
      const retry = page.getByRole("button", { name: "Try again" });
      await expect(retry).toBeVisible();
      await page.keyboard.press("Escape");
      await entry.click();
      await expect(line).toHaveText("Couldn't check for updates.");
      await expect(notice).toBeVisible();
      expect(server.requests).toEqual([]);
      chmodSync(profile, mode);
      await retry.click();
      await expect(line).toContainText("is offered by the update source.");
      await expect(notice).toHaveCount(0);
      expect(server.requests).toEqual(["/stable"]);
    } finally {
      chmodSync(profile, mode);
      await gateway.close();
    }
  });

async function openUpdates(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  if (!(await page.locator(".updates-section").isVisible()))
    await page.getByRole("button", { name: "Updates", exact: true }).click();
}
async function requestFile(page: Page) {
  await page.getByRole("button", { name: "Check for Updates", exact: true }).click();
  await page.getByRole("button", { name: "Download", exact: true }).click();
}
for (const mode of ["mac", "manual"] as const) {
  test.describe(mode, () => {
    test.use({ installer: mode });
    test("F-231: confirms one shown offer, follows handoff and reads the version on a later launch", async ({
      desktopApp,
    }) => {
      const { page, profile, server, filePath, rendererRequests, relaunch } = desktopApp;
      desktopApp.resume();
      await openUpdates(page);
      expect(server.requests).toEqual([]);
      await requestFile(page);
      const restart = page.getByRole("button", { name: "Restart to Update", exact: true });
      const cancel = page.getByRole("button", { name: "Cancel", exact: true });
      const confirm = page.getByRole("button", { name: "Restart", exact: true });
      const result = page.getByRole("group", { name: "Update status" });
      await restart.click();
      const dialog = page.getByRole("alertdialog", { name: "Restart to update?" });
      await expect(dialog).toContainText(
        "Clawtrate will close and start again to update to version 1.1.0.",
      );
      const mac =
        "macOS installs the update when Clawtrate next quits, also if the restart does not complete.";
      if (mode === "mac") await expect(dialog).toContainText(mac);
      else await expect(dialog).not.toContainText(mac);
      await expect(cancel).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(confirm).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(cancel).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(restart).toBeFocused();
      await restart.click();
      await cancel.click();
      expect(existsSync(join(profile, "restart-calls"))).toBe(false);
      const id = await page.evaluate(async () => {
        const { install } = await (
          window as unknown as ProbeWindow
        ).clawtrateHost.desktopUpdates.get();
        return install.kind === "restart-available" && install.offerId;
      });
      expect(typeof id).toBe("string");
      writeFileSync(join(profile, "hold-inspect"), "");
      writeFileSync(join(profile, "hold-launch"), "");
      if (mode === "manual") writeFileSync(join(profile, "block-quit"), "");
      await restart.click();
      await confirm.click();
      async function locked(text: string) {
        await expect(result).toContainText(text);
        await expect(result.getByRole("button")).toHaveCount(0);
        await expect(page.getByRole("radio", { name: "Nightly" })).toBeDisabled();
        await expect(result).toBeFocused();
      }
      await locked("Preparing Clawtrate");
      rmSync(join(profile, "hold-inspect"));
      await locked("Handing Clawtrate");
      rmSync(join(profile, "hold-launch"));
      expect(
        readFileSync(join(profile, "restart-calls"), "utf8")
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s)),
      ).toEqual([id]);
      if (mode === "mac") {
        await locked("Clawtrate handed the update to the macOS updater.");
        for (const [version, line] of [
          ["1.1.0", "Clawtrate 1.1.0 is running."],
          ["0.1.0", "Clawtrate is still running 0.1.0."],
          ["1.2.0", "Clawtrate 1.2.0 is running. Couldn't confirm the update attempt."],
        ] as const) {
          const next = await relaunch(version);
          await openUpdates(next);
          await expect(next.locator(".update-result")).toContainText(line);
        }
        expect(server.requests).toEqual(["/stable", filePath]);
      } else {
        await expect(result).toContainText("Clawtrate stayed open.");
        await expect(restart).toHaveCount(0);
        rmSync(join(profile, "block-quit"));
        await requestFile(page);
        await restart.click();
        await confirm.click();
        await locked("Handing Clawtrate");
        const ids = readFileSync(join(profile, "restart-calls"), "utf8")
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
        expect(ids).toHaveLength(2);
        expect(ids[1]).not.toBe(id);
        expect(server.requests).toEqual(["/stable", filePath, "/stable", filePath]);
      }
      expect(rendererRequests).toEqual([]);
    });
  });
}

test.describe("installer refusals", () => {
  test.use({ installer: "manual" });
  test("F-231: each unavailable installer reason withholds Restart after verification", async ({
    desktopApp,
  }) => {
    const { page, resume, profile, server, filePath, rendererRequests } = desktopApp;
    test.setTimeout(300_000);
    resume();
    await openUpdates(page);
    const reasons = [
      "no-verified-download",
      "build-not-signed",
      "no-installer-path",
      "artifact-changed",
      "mac-designated-requirement",
      "authenticode-trust",
      "publisher-mismatch",
      "installation-context",
      "inspection-failed",
      "running-signature-untrusted",
      "running-publisher-mismatch",
      "installer-product",
      "installer-version",
      "mac-archive",
      "mac-bundle-identifier",
      "mac-architecture",
      "quit-blocked",
      "handoff-unconfirmed",
    ] as const;
    const requests: string[] = [];
    for (const reason of reasons) {
      writeFileSync(join(profile, "inspect-refusal"), reason);
      await page.evaluate(checkStable);
      await page.getByRole("button", { name: "Download", exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const s = await (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.get();
            return (
              (s.state.kind === "verified" ||
                (s.state.kind === "failed" && s.state.reason === "artifact-changed")) &&
              s.install.kind === "unavailable-in-this-build" &&
              s.install.reason
            );
          }),
        )
        .toBe(reason);
      await expect(page.locator(".update-result dd")).toContainText(
        reason === "artifact-changed"
          ? "Couldn't verify the saved update again."
          : "its size and checksum match",
      );
      await expect(page.getByRole("button", { name: "Restart to Update" })).toHaveCount(0);
      requests.push("/stable", filePath);
      expect(server.requests).toEqual(requests);
    }
    expect(existsSync(join(profile, "restart-calls"))).toBe(false);
    expect(rendererRequests).toEqual([]);
  });
});
