// The end-to-end tests' approve step (e2e/approve.ts): every kind of try that doesn't approve is
// tried again until the helper's own deadline, and the failure says how the last one ended. Tries
// are stand-ins on a clock of the test's own; nothing runs and nothing waits.
import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tempDir } from "./fixtures.ts";
import { classify, runTry, untilApproved, type ApproveTry } from "../../../e2e/approve.ts";

const APPROVED = "Approved Clawtrate Web (req-1)\n";
const NOTHING = "No pending Clawtrate requests\n";
const CUT_OFF =
  "openclaw --profile clawtrate-dev-e2e devices list --json failed:\ngateway timeout after 10000ms\n";
const SUPERSEDED =
  "openclaw --profile clawtrate-dev-e2e devices approve req-0 failed:\nunknown requestId\nThat request was superseded by a newer pending request.\n";

/** A clock that only moves when a try takes time or the helper waits. */
function clock() {
  let at = 0;
  return {
    now: () => at,
    wait: async (ms: number) => void (at += ms),
    advance: (ms: number) => void (at += ms),
  };
}

/** Tries that end as listed, each taking `ms`, and then approve. */
function tries(c: ReturnType<typeof clock>, ends: Array<[ApproveTry["outcome"], string, number]>) {
  let made = 0;
  const attempt = async (): Promise<ApproveTry> => {
    const [outcome, output, ms] = ends[made] ?? ["approved", APPROVED, 0];
    made += 1;
    c.advance(ms);
    return { outcome, output };
  };
  return { attempt, made: () => made };
}

describe("approving the device in an end-to-end test", () => {
  it("tries again after a try that failed, as a superseded request makes it", async () => {
    const c = clock();
    const t = tries(c, [["failed", SUPERSEDED, 2_000]]);
    await expect(untilApproved(t.attempt, {}, c.now, c.wait)).resolves.toBe(APPROVED);
    expect(t.made()).toBe(2);
  });

  it("tries again after a try that OpenClaw cut off, however long it took", async () => {
    const c = clock();
    const t = tries(c, [
      ["timed out", CUT_OFF, 12_000],
      ["timed out", CUT_OFF, 25_000],
    ]);
    await expect(untilApproved(t.attempt, {}, c.now, c.wait)).resolves.toBe(APPROVED);
    expect(t.made()).toBe(3);
  });

  it("tries again while there is nothing to approve yet", async () => {
    const c = clock();
    const t = tries(c, [
      ["nothing yet", NOTHING, 500],
      ["nothing yet", NOTHING, 500],
    ]);
    await expect(untilApproved(t.attempt, {}, c.now, c.wait)).resolves.toBe(APPROVED);
    expect(t.made()).toBe(3);
  });

  it("keeps trying until its deadline, and then says how the last try ended", async () => {
    const c = clock();
    const ends: Array<[ApproveTry["outcome"], string, number]> = [
      ["failed", SUPERSEDED, 3_000],
      ["nothing yet", NOTHING, 3_000],
    ];
    for (let i = 0; i < 20; i += 1) ends.push(["timed out", CUT_OFF, 10_000]);
    const t = tries(c, ends);
    const failure = untilApproved(t.attempt, { timeoutMs: 60_000 }, c.now, c.wait);
    await expect(failure).rejects.toThrow(
      /^The device was not approved: 7 tries in 62\.0 s \(limit 60 s\)\. The last one timed out:\n.*gateway timeout after 10000ms/s,
    );
    expect(c.now()).toBe(62_000);
  });

  it("names a last try that failed, and one that found nothing", async () => {
    const failed = clock();
    await expect(
      untilApproved(
        tries(failed, [["failed", SUPERSEDED, 40_000]]).attempt,
        { timeoutMs: 30_000 },
        failed.now,
        failed.wait,
      ),
    ).rejects.toThrow(
      /^The device was not approved: 1 try in 40\.0 s .* last one failed:\n.*superseded/s,
    );
    const nothing = clock();
    const always: Array<[ApproveTry["outcome"], string, number]> = Array.from(
      { length: 40 },
      () => ["nothing yet", NOTHING, 0],
    );
    await expect(
      untilApproved(
        tries(nothing, always).attempt,
        { timeoutMs: 5_000 },
        nothing.now,
        nothing.wait,
      ),
    ).rejects.toThrow(/found nothing to approve yet:\nNo pending Clawtrate requests/);
  });

  it("returns at the first try that approves, without waiting", async () => {
    const c = clock();
    const t = tries(c, []);
    await expect(untilApproved(t.attempt, {}, c.now, c.wait)).resolves.toBe(APPROVED);
    expect([t.made(), c.now()]).toEqual([1, 0]);
  });

  it("reads each try from the command's exit status and what it printed", () => {
    expect(classify(0, APPROVED)).toBe("approved");
    expect(classify(0, `Approved Clawtrate Web (req-1)\nApproved Clawtrate Web (req-2)\n`)).toBe(
      "approved",
    );
    expect(classify(0, NOTHING)).toBe("nothing yet");
    expect(classify(1, CUT_OFF)).toBe("timed out");
    expect(classify(1, "gateway request timeout for device.pair.list\n")).toBe("timed out");
    expect(classify(1, "devices approve req-1 failed:\nOpenClaw took too long to respond.\n")).toBe(
      "timed out",
    );
    // A request approved and then a refusal: the command failed, so the try failed.
    expect(classify(1, `${APPROVED}${SUPERSEDED}`)).toBe("failed");
    expect(classify(1, "")).toBe("failed");
  });

  it("stops a try that hangs past its limit, and what it started, and counts it as timed out", async () => {
    const dir = tempDir("clawtrate-approve-try-");
    const pids = `${dir}/pids`;
    try {
      // A stand-in for the command whose OpenClaw call never returns: it starts a child that sleeps.
      const started = Date.now();
      const ended = await runTry(
        "/bin/sh",
        ["-c", `sleep 600 & echo "$$ $!" > ${pids}; echo listing; wait`],
        3_000,
      );
      expect(ended.outcome).toBe("timed out");
      expect(ended.output).toBe("listing\nstopped after 3 s");
      expect(Date.now() - started).toBeLessThan(15_000);
      const [shell, sleeper] = readFileSync(pids, "utf8").trim().split(" ").map(Number);
      const alive = (pid: number | undefined) => {
        try {
          process.kill(pid!, 0);
          return true;
        } catch {
          return false;
        }
      };
      await expect.poll(() => [shell, sleeper].map(alive)).toEqual([false, false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a try that ends by itself from its status and output", async () => {
    await expect(
      runTry("/bin/sh", ["-c", "echo 'Approved Clawtrate Web (req-1)'"]),
    ).resolves.toEqual({
      outcome: "approved",
      output: APPROVED,
    });
    await expect(
      runTry("/bin/sh", ["-c", "echo 'unknown requestId' >&2; exit 1"]),
    ).resolves.toEqual({
      outcome: "failed",
      output: "unknown requestId\n",
    });
  });
});
