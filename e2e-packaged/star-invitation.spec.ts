import { _electron, expect, test } from "@playwright/test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { devGateway } from "../e2e/global-setup.ts";
import { provenEndpoint } from "../tools/dev-gateway/src/endpoint.ts";
import { runDirFor } from "../tools/dev-gateway/src/instance.ts";

test("F-520 F-521: Electron opens About on choice and the invitation click starts one fixed CLI command", async () => {
  test.skip(process.platform !== "darwin", "This stand-in is a macOS executable script.");
  test.setTimeout(150_000);
  const desktop = join(import.meta.dirname, "../apps/desktop");
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-star-"));
  const refuse = join(dir, "refuse");
  const executable = join(dir, "stand-in");
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' "$@" >> "$HOME/args"
printf '%s\\n' "$GH_CONFIG_DIR" "$XDG_CONFIG_HOME" "$GH_TELEMETRY/$GH_PROMPT_DISABLED/$GH_NO_UPDATE_NOTIFIER/$GH_NO_EXTENSION_UPDATE_NOTIFIER" "$GH_HOST$GITHUB_TOKEN$GH_TOKEN$HTTPS_PROXY" >> "$HOME/env"
/bin/sleep 0.2
printf 'HTTP/2.0 204 No Content\\r\\n'
`,
    { mode: 0o700 },
  );
  symlinkSync(executable, join(dir, "gh"));
  const opened = () =>
    existsSync(join(dir, "opened"))
      ? readFileSync(join(dir, "opened"), "utf8").trim().split("\n")
      : [];
  const app = await _electron.launch({
    executablePath: createRequire(join(desktop, "package.json"))("electron"),
    args: [
      join(import.meta.dirname, "star-main.mjs"),
      "--user-data-dir=" + join(dir, "user-data"),
      "--disable-background-networking",
    ],
    env: {
      HOME: dir,
      CLAWTRATE_DATA_DIR: join(dir, "gateway"),
      CLAWTRATE_STAR_TEST_DIR: dir,
      CLAWTRATE_DEV_INSTANCE: "star-test-offline",
      GH_CONFIG_DIR: join(dir, "cli-config"),
      XDG_CONFIG_HOME: join(dir, "xdg"),
      GH_HOST: "unused",
      GH_TOKEN: "unused",
      GITHUB_TOKEN: "unused",
      HTTPS_PROXY: "unused",
      GH_TELEMETRY: "1",
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "Clawtrate", exact: true })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByRole("button", { name: "About", exact: true }).click();
    const link = page.getByRole("link", { name: "Star Clawtrate on GitHub" });
    await expect(link).toBeVisible();
    expect(opened()).toEqual([]);
    expect(existsSync(join(dir, "args"))).toBe(false);
    writeFileSync(refuse, "");
    await link.focus();
    await link.press("Enter");
    await expect(page.getByRole("dialog")).toContainText(
      "Couldn't open GitHub. Try again from About.",
    );
    await expect(link).toBeFocused();
    const url = "https://github.com/sidebandstudio/clawtrate";
    expect(opened()).toEqual([url]);
    rmSync(refuse);
    await link.click();
    await expect(page.getByRole("dialog")).not.toContainText("Couldn't open GitHub.");
    expect(opened()).toEqual([url, url]);
    expect(existsSync(join(dir, "args"))).toBe(false);
    await page.getByRole("button", { name: "Close settings" }).filter({ visible: true }).click();
    const instance = process.env.CLAWTRATE_DEV_INSTANCE!;
    expect(instance).toMatch(/^e2e-[0-9a-f]{8}$/);
    const checkout = realpathSync(join(desktop, "../.."));
    const endpoint = provenEndpoint({
      instance,
      home: homedir(),
      checkout,
      runDir: runDirFor(instance, join(checkout, "tools/dev-gateway/.run")),
    });
    if ("refusal" in endpoint) throw new Error(endpoint.refusal);
    await page.getByPlaceholder("Gateway address").fill(endpoint.url);
    await page.getByPlaceholder("Token, for the first pairing only").fill(endpoint.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
    const approve = () =>
      expect
        .poll(() => devGateway(instance, "approve"), { timeout: 30_000 })
        .toMatch(/^Approved /m);
    await approve();
    await page
      .getByTestId("bot-list")
      .getByRole("button", { name: /^Pip\b/ })
      .first()
      .click();
    const access = page.getByRole("region", { name: "Access" });
    await access.getByRole("button", { name: "Request access" }).click();
    await expect(access).toContainText("Waiting for the gateway's owner.");
    await approve();
    const field = page.getByTestId("composer-input");
    await expect(field).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => localStorage.setItem("clawtrate.star-invitation", "5"));
    await field.fill("Desktop reply #stream 3");
    await field.press("Enter");
    const notice = page.getByRole("region", { name: "GitHub invitation" });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    expect(existsSync(join(dir, "args"))).toBe(false);
    await notice.getByRole("button", { name: "Star with GitHub CLI" }).click();
    await expect(notice).toHaveText("Starred. Thank you.");
    expect(readFileSync(join(dir, "args"), "utf8").trimEnd().split("\n")).toEqual([
      "api",
      "--method",
      "PUT",
      "/user/starred/sidebandstudio/clawtrate",
      "--hostname",
      "github.com",
      "--silent",
      "--include",
    ]);
    expect(readFileSync(join(dir, "env"), "utf8").split("\n")).toEqual([
      join(dir, "cli-config"),
      join(dir, "xdg"),
      "0/1/1/1",
      "",
      "",
    ]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
