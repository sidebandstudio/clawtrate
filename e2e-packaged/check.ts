import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const args = [cli, "test", "-c", "playwright.packaged.config.ts", ...process.argv.slice(2)];
if (
  process.platform !== "win32" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  process.env.GITHUB_ACTIONS !== "true"
) {
  process.exitCode = spawnSync(process.execPath, args, { stdio: "inherit" }).status ?? 1;
} else {
  const root = mkdtempSync(join(tmpdir(), "clawtrate-pairing-"));
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  for (const dir of [
    join(home, "tmp"),
    join(home, "AppData", "Local"),
    join(home, "AppData", "Roaming"),
    runtime,
  ])
    mkdirSync(dir, { recursive: true });
  const npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  execFileSync(
    process.execPath,
    [npm, "install", "--prefix", runtime, "--no-audit", "--no-fund", "openclaw@2026.10.6"],
    { cwd: runtime, stdio: "inherit" },
  );
  const run = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      join(import.meta.dirname, "windows-job.ps1"),
      ...args,
    ],
    {
      env: {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        CLAWTRATE_PACKAGED_NODE: process.execPath,
        CLAWTRATE_PACKAGED_HOME: home,
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (run.error) throw run.error;
  if (run.status === 0) {
    rmSync(root, { recursive: true, maxRetries: 5, retryDelay: 200 });
    console.log("Removed the Windows pairing home and private runtime");
  }
  process.exitCode = run.status ?? 1;
}
