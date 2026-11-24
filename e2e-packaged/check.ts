import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./run-cli.ts";

const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const args = [cli, "test", "-c", "playwright.packaged.config.ts", ...process.argv.slice(2)];
if (
  process.platform !== "win32" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  process.env.GITHUB_ACTIONS !== "true"
) {
  await runCli(args);
} else {
  const powershell = join(
    process.env.SystemRoot!,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const root = mkdtempSync(join(tmpdir(), "clawtrate-pairing-"));
  const home = join(root, "home");
  console.log(`Windows pairing root: ${root}`);
  const run = spawn(
    powershell,
    ["-NoProfile", "-NonInteractive", "-File", join(import.meta.dirname, "windows-job.ps1")],
    {
      env: {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        CLAWTRATE_PACKAGED_NODE: process.execPath,
        CLAWTRATE_PACKAGED_HOME: home,
        CLAWTRATE_PACKAGED_ARGS: JSON.stringify(args),
        CLAWTRATE_DEV_INSTANCE: `e2e-${randomBytes(4).toString("hex")}`,
        CLAWTRATE_PACKAGED_RUN: randomBytes(24).toString("hex"),
      },
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
    },
  );
  const cancel = () => run.stdin.end();
  process.on("SIGINT", cancel);
  process.on("SIGBREAK", cancel);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      run.once("error", reject);
      run.once("exit", (status) => resolve(status ?? 1));
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGBREAK", cancel);
    run.stdin.destroy();
  }
}
