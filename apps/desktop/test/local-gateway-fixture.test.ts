// The local connect checks' own fixture (fixtures/local-gateway.ts): a
// stand-in that never gets ready leaves no process behind. No OpenClaw.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { freePort, standIn } from "./fixtures/local-gateway.ts";

it("stops a stand-in that never got ready, and waits for it to exit, before it fails", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "clawtrate-stand-in-"));
  const pidFile = join(scratch, "pid");
  try {
    // A program that writes its PID and then waits, never saying it is ready.
    const wrap = ["/bin/sh", "-c", `echo $$ > '${pidFile}'; exec sleep 60`, "sh"];
    await expect(standIn(await freePort(), null, { wrap, startMs: 500 })).rejects.toThrow(
      "the stand-in didn't start",
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
