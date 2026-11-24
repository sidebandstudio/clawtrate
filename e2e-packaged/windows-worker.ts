import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCli } from "./run-cli.ts";

export function waitForJobPermit() {
  if (readFileSync(0, "utf8").trim() !== "start") throw new Error("No Windows job launch permit");
}

if (import.meta.main) {
  waitForJobPermit();
  const home = process.env.CLAWTRATE_PACKAGED_HOME!;
  const runtime = join(dirname(home), "runtime");
  for (const dir of [
    join(home, "tmp"),
    join(home, "AppData/Local"),
    join(home, "AppData/Roaming"),
    runtime,
  ])
    mkdirSync(dir, { recursive: true });
  const npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  execFileSync(
    process.execPath,
    [npm, "install", "--prefix", runtime, "--no-audit", "--no-fund", "openclaw@2026.10.6"],
    { cwd: runtime, stdio: ["ignore", "inherit", "inherit"] },
  );
  const args: string[] = JSON.parse(process.env.CLAWTRATE_PACKAGED_ARGS!);
  await runCli(args);
}
