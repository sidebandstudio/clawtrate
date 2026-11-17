// Every decision and every read-back on an approval takes the next attempt
// number (conversation.md section 12, "What happens to a decision"). A
// response settles only its own attempt; a read-back's answer counts only if
// nothing newer began after it was sent; an unknown outcome stays unknown
// until a read-back sent after it returns. At most one decision is on its way,
// except that a Deny may follow an allow.
import { describe, expect, it } from "vitest";
import { grantingGateway, KEY, openTask } from "./client-harness.ts";
import { GatewayError, until, type FakeGateway } from "./fake-gateway.ts";

const FAR = 9_000_000_000_000;
const item = {
  id: "ap-attempts",
  request: {
    command: "printf ok",
    host: "gateway",
    agentId: "otto",
    sessionKey: KEY,
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  },
  createdAtMs: 1,
  expiresAtMs: FAR,
};
const pending = () => ({
  approval: {
    id: item.id,
    status: "pending",
    presentation: {
      kind: "exec",
      commandText: "printf ok",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    createdAtMs: 1,
    expiresAtMs: FAR,
  },
});
const unavailable = (what: string) =>
  new GatewayError({ code: "UNAVAILABLE", message: `${what} unavailable` });
/** Refused before the handler looks the request up (`approval-refusals.ts`). */
const refused = () => new GatewayError({ code: "INVALID_REQUEST", message: "invalid decision" });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const decisions = (gateway: FakeGateway) =>
  gateway.calls("exec.approval.resolve").map((each) => (each as { decision: string }).decision);

describe("F-163: decision attempts", () => {
  it("a refused Allow does not release the Deny still on its way", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [item];
    let refuseAllow!: (error: unknown) => void;
    gateway.handlers["exec.approval.resolve"] = (params) =>
      (params as { decision: string }).decision === "allow-always"
        ? new Promise((_, reject) => (refuseAllow = reject))
        : new Promise(() => undefined);
    gateway.handlers["approval.get"] = () => {
      throw unavailable("approval get");
    };
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvals.length === 1);
      const allow = client.resolveApproval(KEY, item.id, "allow-always").catch((e: unknown) => e);
      await until(() => decisions(gateway).length === 1);
      void client.resolveApproval(KEY, item.id, "deny").catch(() => undefined);
      await until(() => decisions(gateway).length === 2);
      refuseAllow(
        new GatewayError({
          code: "INVALID_REQUEST",
          message: "allow-always is unavailable for this command",
          details: { reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" },
        }),
      );
      await allow;
      await until(() => gateway.calls("approval.get").length === 1);
      // The Deny is still on its way: its guard holds.
      expect(transcript().approvals[0]).toMatchObject({
        submitting: true,
        submittingDecision: "deny",
        inFlight: [{ attempt: 2, decision: "deny" }],
      });
      await expect(client.resolveApproval(KEY, item.id, "deny")).rejects.toThrow(/on its way/);
      await expect(client.resolveApproval(KEY, item.id, "allow-once")).rejects.toThrow(
        /on its way/,
      );
      await tick();
      expect(decisions(gateway)).toEqual(["allow-always", "deny"]);
    } finally {
      client.stop();
    }
  });

  it("a refused Deny does not let an Allow follow the first Allow, still without an outcome", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [item];
    gateway.handlers["exec.approval.resolve"] = (params) => {
      if ((params as { decision: string }).decision === "deny") throw refused();
      return new Promise(() => undefined);
    };
    gateway.handlers["approval.get"] = () => {
      throw unavailable("approval get");
    };
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvals.length === 1);
      void client.resolveApproval(KEY, item.id, "allow-once").catch(() => undefined);
      await until(() => decisions(gateway).length === 1);
      await expect(client.resolveApproval(KEY, item.id, "deny")).rejects.toThrow(
        /invalid decision/,
      );
      expect(transcript().approvals[0]).toMatchObject({
        submitting: true,
        submittingDecision: "allow-once",
      });
      await expect(client.resolveApproval(KEY, item.id, "allow-once")).rejects.toThrow(
        /on its way/,
      );
      await tick();
      expect(decisions(gateway)).toEqual(["allow-once", "deny"]);
    } finally {
      client.stop();
    }
  });

  it("a read-back sent before an unknown outcome does not clear it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [item];
    gateway.handlers["exec.approval.resolve"] = () => {
      throw unavailable("approval resolve");
    };
    const answers: Array<(value: unknown) => void> = [];
    gateway.handlers["approval.get"] = () => new Promise((resolve) => answers.push(resolve));
    const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 5000 } });
    try {
      await until(() => transcript().approvals.length === 1);
      await client.resolveApproval(KEY, item.id, "allow-once").catch(() => undefined);
      await until(() => answers.length === 1);
      await client.resolveApproval(KEY, item.id, "deny").catch(() => undefined);
      await until(() => answers.length === 2);
      expect(transcript().approvals[0]!.decisionError).toBe("unknown");
      // The first read-back was sent before the Deny's outcome became unknown.
      answers[0]!(pending());
      await tick();
      await tick();
      expect(transcript().approvals[0]).toMatchObject({
        decisionError: "unknown",
        unknownDeny: true,
      });
      await expect(client.resolveApproval(KEY, item.id, "allow-once")).rejects.toThrow(
        /not known yet/,
      );
      await expect(client.resolveApproval(KEY, item.id, "deny")).rejects.toThrow(/not known yet/);
      // The second was sent after it, and nothing began since: it settles it.
      answers[1]!(pending());
      await until(() => transcript().approvals[0]!.decisionError === null);
      expect(transcript().approvals[0]).toMatchObject({ unknownDeny: false, unknownAt: null });
      expect(answers).toHaveLength(2);
      await client.resolveApproval(KEY, item.id, "allow-once").catch(() => undefined);
      expect(decisions(gateway)).toEqual(["allow-once", "deny", "allow-once"]);
    } finally {
      client.stop();
    }
  });

  it("a stale read-back's answer does not start another while a newer one is on its way", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [item];
    gateway.handlers["exec.approval.resolve"] = () => {
      throw unavailable("approval resolve");
    };
    const answers: Array<(value: unknown) => void> = [];
    gateway.handlers["approval.get"] = () => new Promise((resolve) => answers.push(resolve));
    const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 5000 } });
    try {
      await until(() => transcript().approvals.length === 1);
      await client.resolveApproval(KEY, item.id, "allow-once").catch(() => undefined);
      await until(() => answers.length === 1);
      void client.checkApproval(KEY, item.id).catch(() => undefined);
      await until(() => answers.length === 2);
      answers[0]!(pending());
      await tick();
      await tick();
      expect(answers).toHaveLength(2);
      answers[1]!(pending());
      await until(() => transcript().approvals[0]!.decisionError === null);
      expect(answers).toHaveLength(2);
    } finally {
      client.stop();
    }
  });
});

// Interleavings --------------------------------------------------------------------

/** A small seeded generator, so a failing interleaving can be run again by its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Sent = {
  decision: string;
  /** What the gateway did with it: no answer yet, refused it, or left its outcome unknown. */
  state: "pending" | "refused" | "unknown";
  /** When its outcome became unknown. */
  unknownSince: number;
  /** A read-back sent after it became unknown answered that the request is still pending. */
  cleared: boolean;
  answer: ((value: unknown) => void) | null;
  fail: ((error: unknown) => void) | null;
};
type Read = { sentAt: number; answer: (value: unknown) => void; fail: (error: unknown) => void };

const SEQUENCES = 150;
const STEPS = 16;

describe("F-163: decision attempts over interleavings", () => {
  it(`hold over ${SEQUENCES} seeded interleavings of ${STEPS} steps`, async () => {
    for (let seed = 1; seed <= SEQUENCES; seed += 1) {
      await interleaving(seed);
    }
  }, 120_000);
});

async function interleaving(seed: number): Promise<void> {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  let clock = 0;
  const sent: Sent[] = [];
  let reads: Read[] = [];
  const violations: string[] = [];
  const blocking = (each: Sent) =>
    each.state === "pending" || (each.state === "unknown" && !each.cleared);

  const gateway = grantingGateway();
  gateway.handlers["exec.approval.list"] = () => [item];
  gateway.handlers["exec.approval.resolve"] = (params) => {
    const decision = (params as { decision: string }).decision;
    clock += 1;
    // No decision leaves twice: none while an earlier one of the same kind has no known outcome.
    if (sent.some((each) => each.decision === decision && blocking(each))) {
      violations.push(`seed ${seed}: ${decision} sent again before the first's outcome was known`);
    }
    // No Allow leaves while any decision is on its way or its outcome is unknown.
    if (decision !== "deny" && sent.some(blocking)) {
      violations.push(`seed ${seed}: ${decision} sent while another outcome was not known`);
    }
    const record: Sent = {
      decision,
      state: "pending",
      unknownSince: 0,
      cleared: false,
      answer: null,
      fail: null,
    };
    sent.push(record);
    return new Promise((resolve, reject) => {
      record.answer = resolve;
      record.fail = reject;
    });
  };
  gateway.handlers["approval.get"] = () => {
    clock += 1;
    const sentAt = clock;
    return new Promise((resolve, reject) => {
      reads.push({ sentAt, answer: resolve, fail: reject });
    });
  };
  const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 60_000 } });
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await tick();
  };

  /** Deny is always possible: refused only while an earlier Deny is on its way or was unknown. */
  const deny = async (mustLeave: boolean) => {
    const before = sent.length;
    let error: unknown = null;
    void client.resolveApproval(KEY, item.id, "deny").catch((e: unknown) => (error = e));
    await settle();
    const left = sent.length > before;
    const earlierDeny = sent
      .slice(0, before)
      .some(
        (each) =>
          each.decision === "deny" && (each.state === "pending" || each.state === "unknown"),
      );
    if (!left && !earlierDeny) {
      violations.push(
        `seed ${seed}: Deny refused with no earlier Deny unsettled: ${String(error)}`,
      );
    }
    if (mustLeave && !left) violations.push(`seed ${seed}: Deny did not leave once all was known`);
  };

  /** A read-back answers that the request is still pending. */
  const stillPending = (read: Read) => {
    clock += 1;
    // Every decision whose outcome became unknown before this read-back was sent was not applied.
    for (const each of sent) {
      if (each.state === "unknown" && each.unknownSince < read.sentAt) each.cleared = true;
    }
    read.answer(pending());
  };

  const unknown = (each: Sent) => {
    each.state = "unknown";
    each.unknownSince = clock;
  };

  try {
    await until(() => transcript().approvals.length === 1);
    for (let step = 0; step < STEPS; step += 1) {
      const action = pick([
        "allow-once",
        "allow-always",
        "deny",
        "check",
        "answer-decision",
        "answer-decision",
        "answer-read",
        "answer-read",
        "drop",
      ] as const);
      if (action === "deny") {
        await deny(false);
      } else if (action === "allow-once" || action === "allow-always") {
        void client.resolveApproval(KEY, item.id, action).catch(() => undefined);
      } else if (action === "check") {
        void client.checkApproval(KEY, item.id).catch(() => undefined);
      } else if (action === "answer-decision") {
        const open = sent.filter((each) => each.state === "pending");
        if (open.length > 0) {
          const each = pick(open);
          clock += 1;
          if (next() < 0.5) {
            each.state = "refused";
            each.fail!(refused());
          } else {
            unknown(each);
            each.fail!(unavailable("approval resolve"));
          }
        }
      } else if (action === "answer-read") {
        if (reads.length > 0) {
          const read = pick(reads);
          reads = reads.filter((each) => each !== read);
          if (next() < 0.7) {
            stillPending(read);
          } else {
            clock += 1;
            read.fail(unavailable("approval get"));
          }
        }
      } else {
        clock += 1;
        for (const each of sent) if (each.state === "pending") unknown(each);
        reads = [];
        gateway.dropAll();
        await until(() => client.state.connection.status === "connected");
      }
      await settle();
    }

    // Everything answered and read back: Deny leaves.
    for (const each of sent.filter((one) => one.state === "pending")) {
      clock += 1;
      each.state = "refused";
      each.fail!(refused());
    }
    await settle();
    for (const read of reads) stillPending(read);
    reads = [];
    await settle();
    for (
      let round = 0;
      round < 4 && transcript().approvals[0]!.decisionError === "unknown";
      round += 1
    ) {
      void client.checkApproval(KEY, item.id).catch(() => undefined);
      await until(() => reads.length > 0);
      const all = reads;
      reads = [];
      for (const read of all) stillPending(read);
      await settle();
    }
    expect(transcript().approvals[0]!.decisionError, `seed ${seed}`).not.toBe("unknown");
    await deny(true);
  } finally {
    client.stop();
  }
  expect(violations).toEqual([]);
}
