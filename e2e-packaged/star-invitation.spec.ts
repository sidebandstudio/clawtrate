import { _electron, expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("F-520 F-521: Electron opens About on choice and the real preload starts one fixed CLI command", async () => {
  test.skip(process.platform !== "darwin", "This stand-in is a macOS executable script.");
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
    expect(
      await page.evaluate(async () => {
        const { clawtrateHost } = window as unknown as {
          clawtrateHost: { starWithCli(): Promise<boolean> };
        };
        return Promise.all([clawtrateHost.starWithCli(), clawtrateHost.starWithCli()]);
      }),
    ).toEqual([true, false]);
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
