import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const batch = "two";
const env = { ...process.env, CLAWTRATE_PROOF_CHILD: "1" };
if (batch === "cancel") {
  const proof = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-File", "scratch/cancel.ps1"],
    { env, stdio: "inherit" },
  );
  if (proof.status !== 0) throw new Error(`cancel proof failed with ${proof.status}`);
}
const roots = new Set();
for (let repeat = 0; repeat < (batch === "cancel" ? 1 : 2); repeat++) {
  const run = spawnSync(process.execPath, ["e2e-packaged/check.ts"], {
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  const log = run.stdout ?? "";
  if (run.status !== 0) throw new Error(`suite ended with ${run.status}`);
  for (const proof of [
    "13 passed",
    "5 skipped",
    "Verified 2 recorded Windows gateway children exited",
    "Verified the Windows packaged job has no remaining children",
    "Verified both Windows gateway ports are free",
    "Removed the Windows pairing home, records and private runtime",
    "Closed the packaged app and removed",
  ]) {
    if (!log.includes(proof)) throw new Error(`missing proof: ${proof}`);
  }
  const root = /^Windows pairing root: (.+)$/m.exec(log)?.[1].trim();
  if (!root || roots.has(root) || existsSync(root))
    throw new Error("pairing root reused or still present");
  roots.add(root);
  console.log(`Verified complete fresh Windows suite ${repeat + 1} in batch ${batch}`);
}
