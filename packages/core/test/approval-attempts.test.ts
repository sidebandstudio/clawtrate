// Every decision and every read-back on an approval takes the next attempt
// number (conversation.md section 12, "What happens to a decision"). A
// response settles only its own attempt; a read-back's answer counts only if
// nothing newer began after it was sent; an unknown outcome stays unknown
// until a read-back sent after it returns. At most one decision is on its way,
// except that a Deny may follow an allow.
import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
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

describe("F-163: decision attempts belong to the approval, not to the task showing it", () => {
  const busy = () => {
    throw unavailable("approval get");
  };

  it("a Deny on its way still holds its guard after the task is closed and opened again", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [item];
    gateway.handlers["exec.approval.resolve"] = () => new Promise(() => undefined);
    gateway.handlers["approval.get"] = busy;
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvals.length === 1);
      void client.resolveApproval(KEY, item.id, "deny").catch(() => undefined);
      await until(() => decisions(gateway).length === 1);
      client.closeSession(KEY);
      expect(client.state.transcripts[KEY]).toBeUndefined();
      client.openSession(KEY);
      await until(() => transcript()?.approvals.length === 1);
      expect(transcript().approvals[0]).toMatchObject({
        inFlight: [{ decision: "deny" }],
        decisionError: "unknown",
        unknownDeny: true,
      });
      await expect(client.resolveApproval(KEY, item.id, "deny")).rejects.toThrow(/on its way/);
      await expect(client.resolveApproval(KEY, item.id, "allow-once")).rejects.toThrow(
        /on its way/,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(decisions(gateway)).toEqual(["deny"]);
    } finally {
      client.stop();
    }
  });

  it("an outcome that became unknown while the task was closed is not cleared by the list read on opening it again", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [item];
    let failOld!: (error: unknown) => void;
    gateway.handlers["exec.approval.resolve"] = () =>
      new Promise((_, reject) => (failOld = reject));
    const reads: Array<(value: unknown) => void> = [];
    gateway.handlers["approval.get"] = () => new Promise((resolve) => reads.push(resolve));
    const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 5000 } });
    try {
      await until(() => transcript().approvals.length === 1);
      const old = client.resolveApproval(KEY, item.id, "allow-once").catch((e: unknown) => e);
      await until(() => decisions(gateway).length === 1);
      let answerList: ((value: unknown) => void) | undefined;
      gateway.handlers["exec.approval.list"] = () =>
        new Promise((resolve) => (answerList = resolve));
      client.closeSession(KEY);
      client.openSession(KEY);
      await until(() => answerList !== undefined);
      // The outcome becomes unknown while no task shows the approval; the list was asked before.
      failOld(unavailable("approval resolve"));
      await old;
      answerList!([item]);
      await until(() => transcript()?.approvals.length === 1);
      expect(transcript().approvals[0]!.decisionError).toBe("unknown");
      await expect(client.resolveApproval(KEY, item.id, "allow-once")).rejects.toThrow(
        /not known yet/,
      );
      expect(decisions(gateway)).toEqual(["allow-once"]);
      // The read-back sent when it became unknown predates the task's reopening: only the one
      // sent after it, once the card was admitted again, settles it.
      await until(() => reads.length === 2);
      reads[0]!(pending());
      await tick();
      await tick();
      expect(transcript().approvals[0]!.decisionError).toBe("unknown");
      reads[1]!(pending());
      await until(() => transcript().approvals[0]!.decisionError === null);
      void client.resolveApproval(KEY, item.id, "allow-once").catch(() => undefined);
      await until(() => decisions(gateway).length === 2);
      expect(decisions(gateway)).toEqual(["allow-once", "allow-once"]);
    } finally {
      client.stop();
    }
  });

  it("a read-back sent before the task opened again does not clear the outcome after it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [item];
    gateway.handlers["exec.approval.resolve"] = () => {
      throw unavailable("approval resolve");
    };
    const reads: Array<(value: unknown) => void> = [];
    gateway.handlers["approval.get"] = () => new Promise((resolve) => reads.push(resolve));
    const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 5000 } });
    try {
      await until(() => transcript().approvals.length === 1);
      await client.resolveApproval(KEY, item.id, "allow-once").catch(() => undefined);
      await until(() => reads.length === 1);
      client.closeSession(KEY);
      client.openSession(KEY);
      await until(() => transcript()?.approvals.length === 1 && reads.length === 2);
      reads[0]!(pending());
      await tick();
      await tick();
      expect(transcript().approvals[0]!.decisionError).toBe("unknown");
      reads[1]!(pending());
      await until(() => transcript().approvals[0]!.decisionError === null);
    } finally {
      client.stop();
    }
  });

  it("an Allow on its way when the task opened again, then refused, still leaves no Allow until a read-back sent after the opening", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [item];
    let refuseOld!: (error: unknown) => void;
    gateway.handlers["exec.approval.resolve"] = () =>
      new Promise((_, reject) => (refuseOld = reject));
    const reads: Array<(value: unknown) => void> = [];
    gateway.handlers["approval.get"] = () => new Promise((resolve) => reads.push(resolve));
    const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 5000 } });
    try {
      await until(() => transcript().approvals.length === 1);
      const old = client.resolveApproval(KEY, item.id, "allow-once").catch((e: unknown) => e);
      await until(() => decisions(gateway).length === 1);
      client.closeSession(KEY);
      client.openSession(KEY);
      await until(() => transcript()?.approvals.length === 1 && reads.length === 1);
      refuseOld(refused());
      await old;
      expect(transcript().approvals[0]!.decisionError).toBe("unknown");
      await expect(client.resolveApproval(KEY, item.id, "allow-once")).rejects.toThrow(
        /not known yet/,
      );
      // The refusal is read back too; the read-back sent at the opening is then not the latest.
      await until(() => reads.length === 2);
      reads[0]!(pending());
      await tick();
      expect(transcript().approvals[0]!.decisionError).toBe("unknown");
      reads[1]!(pending());
      await until(() => transcript().approvals[0]!.decisionError === null);
      void client.resolveApproval(KEY, item.id, "allow-once").catch(() => undefined);
      await until(() => decisions(gateway).length === 2);
    } finally {
      client.stop();
    }
  });

  it("a reconnect keeps the attempts: an Allow on its way becomes unknown, no Allow leaves, and a read-back newer than the reconnect is sent", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [item];
    gateway.handlers["exec.approval.resolve"] = () => new Promise(() => undefined);
    gateway.handlers["approval.get"] = busy;
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvals.length === 1);
      void client.resolveApproval(KEY, item.id, "allow-once").catch(() => undefined);
      await until(() => decisions(gateway).length === 1);
      const before = transcript().approvals[0]!.attempt;
      const readsBefore = gateway.calls("approval.get").length;
      gateway.dropAll();
      await until(() => client.state.connection.status === "connected");
      await until(() => gateway.calls("approval.get").length > readsBefore);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(transcript().approvals[0]!.attempt).toBeGreaterThan(before);
      expect(transcript().approvals[0]!.decisionError).toBe("unknown");
      await expect(client.resolveApproval(KEY, item.id, "allow-once")).rejects.toThrow(
        /not known yet/,
      );
      expect(decisions(gateway)).toEqual(["allow-once"]);
    } finally {
      client.stop();
    }
  });

  it("a viewer that reloads, releasing the task, finds the guard when it opens the task again", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [item];
    gateway.handlers["exec.approval.resolve"] = () => new Promise(() => undefined);
    gateway.handlers["approval.get"] = busy;
    const { client, transcript } = await openTask({ gateway });
    const first = createBridgeSession(client);
    let second: ReturnType<typeof createBridgeSession> | null = null;
    try {
      await first.apply({ type: "openSession", key: KEY });
      client.closeSession(KEY);
      await until(() => transcript()?.approvals.length === 1);
      const command = {
        type: "resolveApproval",
        key: KEY,
        approvalId: item.id,
        decision: "deny",
        expiresInDays: null,
      } as const;
      void first.apply(command).catch(() => undefined);
      await until(() => decisions(gateway).length === 1);
      // The renderer reloads: its session goes, and with it the last interest in the task.
      first.dispose();
      expect(client.state.transcripts[KEY]).toBeUndefined();
      second = createBridgeSession(client);
      await second.apply({ type: "openSession", key: KEY });
      await until(() => transcript()?.approvals.length === 1);
      await expect(second.apply(command)).rejects.toThrow(/on its way/);
      expect(decisions(gateway)).toEqual(["deny"]);
    } finally {
      second?.dispose();
      client.stop();
    }
  });

  it("a second viewer keeps the task, and the guard, when the first closes it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["exec.approval.list"] = () => [item];
    gateway.handlers["exec.approval.resolve"] = () => new Promise(() => undefined);
    gateway.handlers["approval.get"] = busy;
    const { client, transcript } = await openTask({ gateway });
    try {
      await until(() => transcript().approvals.length === 1);
      client.openSession(KEY);
      void client.resolveApproval(KEY, item.id, "deny").catch(() => undefined);
      await until(() => decisions(gateway).length === 1);
      client.closeSession(KEY);
      expect(transcript().approvals[0]!.inFlight).toEqual([
        { attempt: expect.any(Number), decision: "deny" },
      ]);
      await expect(client.resolveApproval(KEY, item.id, "deny")).rejects.toThrow(/on its way/);
      expect(decisions(gateway)).toEqual(["deny"]);
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

/** One decision as the gateway received it, and what it did with it. */
type Sent = {
  decision: string;
  /** No answer yet, refused, or its outcome unknown to the client. */
  state: "pending" | "refused" | "unknown";
  /** When its outcome became unknown, on the gateway's clock of requests and answers. */
  unknownSince: number;
  /**
   * Its outcome stays unknown, though answered: it was on its way when the task
   * showing it opened again, so only a read-back sent after that settles it.
   */
  reopened: boolean;
  /** A fresh read-back sent after it became unknown answered that the request is still pending. */
  cleared: boolean;
  fail: ((error: unknown) => void) | null;
};
/** One read-back as the gateway received it. */
type Read = { sentAt: number; answer: (value: unknown) => void; fail: (error: unknown) => void };

const SEQUENCES = 200;
const STEPS = 18;

describe("F-163: decision attempts over interleavings", () => {
  it(`hold over ${SEQUENCES} seeded interleavings of ${STEPS} steps`, async () => {
    for (let seed = 1; seed <= SEQUENCES; seed += 1) {
      await interleaving(seed);
    }
  }, 240_000);
});

/**
 * Decisions, their answers, read-backs and their answers in any order, dropped
 * connections, the task closed and opened again by the direct caller, a
 * second viewer opening and closing it through its own bridge session, and
 * the approval lists of each opening answered late. The gateway's clock
 * counts every request it receives and every answer it gives; a read-back
 * is fresh when nothing else reached the gateway between it and its answer,
 * and the task did not show the approval anew meanwhile.
 */
async function interleaving(seed: number): Promise<void> {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  let clock = 0;
  /** When the gateway last received anything, or the task last showed the approval anew. */
  let lastBegun = 0;
  const sent: Sent[] = [];
  let reads: Read[] = [];
  let lists: Array<(value: unknown) => void> = [];
  const violations: string[] = [];
  const unsettled = (each: Sent) =>
    each.state === "pending" || ((each.state === "unknown" || each.reopened) && !each.cleared);

  const gateway = grantingGateway();
  gateway.handlers["exec.approval.list"] = () => new Promise((resolve) => lists.push(resolve));
  gateway.handlers["exec.approval.resolve"] = (params) => {
    const decision = (params as { decision: string }).decision;
    clock += 1;
    lastBegun = clock;
    // No decision leaves twice: none while an earlier one of the same kind has no known outcome.
    if (sent.some((each) => each.decision === decision && unsettled(each))) {
      violations.push(`seed ${seed}: ${decision} sent again before the first's outcome was known`);
    }
    // No Allow leaves while any decision is on its way or its outcome is unknown.
    if (decision !== "deny" && sent.some(unsettled)) {
      violations.push(`seed ${seed}: ${decision} sent while another outcome was not known`);
    }
    const record: Sent = {
      decision,
      state: "pending",
      unknownSince: 0,
      reopened: false,
      cleared: false,
      fail: null,
    };
    sent.push(record);
    return new Promise((_, reject) => (record.fail = reject));
  };
  gateway.handlers["approval.get"] = () => {
    clock += 1;
    lastBegun = clock;
    const sentAt = clock;
    return new Promise((resolve, reject) => reads.push({ sentAt, answer: resolve, fail: reject }));
  };

  // The direct caller holds the task open; a second viewer may too.
  const { client } = await openTask({ gateway, client: { requestTimeoutMs: 60_000 } });
  const viewer = createBridgeSession(client);
  let direct = true;
  let viewing = false;
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await tick();
  };
  const card = () => client.state.transcripts[KEY]?.approvals.find((each) => each.id === item.id);
  /** Answer the approval lists asked for; the task shows the approval anew if it did not before. */
  const answerLists = async (which: Array<(value: unknown) => void>) => {
    const before = card() !== undefined;
    clock += which.length;
    const shownAt = clock;
    for (const answer of which) answer([item]);
    await settle();
    if (!before && card()) {
      // Shown anew with something outstanding: only a read-back sent after this settles it.
      lastBegun = Math.max(lastBegun, shownAt);
      for (const each of sent) {
        if (each.state === "pending") {
          each.reopened = true;
          each.cleared = false;
          each.unknownSince = shownAt;
        } else if ((each.state === "unknown" || each.reopened) && !each.cleared) {
          each.unknownSince = shownAt;
        }
      }
    }
  };

  /** A read-back answers that the request is still pending. */
  const stillPending = (read: Read) => {
    const fresh = lastBegun === read.sentAt;
    clock += 1;
    if (fresh) {
      for (const each of sent) {
        if ((each.state === "unknown" || each.reopened) && each.unknownSince < read.sentAt)
          each.cleared = true;
      }
    }
    read.answer(pending());
  };

  const unknown = (each: Sent) => {
    each.state = "unknown";
    each.unknownSince = clock;
    each.cleared = false;
  };

  /** Deny is always possible: refused only while an earlier Deny is on its way or not known. */
  const deny = async (mustLeave: boolean) => {
    const shown = card();
    if (!shown || shown.status !== "pending") return;
    const before = sent.length;
    let error: unknown = null;
    void client.resolveApproval(KEY, item.id, "deny").catch((e: unknown) => (error = e));
    await settle();
    const left = sent.length > before;
    const earlierDeny = sent
      .slice(0, before)
      .some((each) => each.decision === "deny" && unsettled(each));
    if (!left && !earlierDeny) {
      violations.push(
        `seed ${seed}: Deny refused with no earlier Deny unsettled: ${String(error)}`,
      );
    }
    if (mustLeave && !left) violations.push(`seed ${seed}: Deny did not leave once all was known`);
  };

  try {
    await until(() => lists.length > 0);
    await answerLists(lists.splice(0));
    await until(() => card() !== undefined);
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
        "answer-list",
        "drop",
        "close",
        "open",
        "viewer-open",
        "viewer-close",
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
      } else if (action === "answer-list") {
        if (lists.length > 0) await answerLists(lists.splice(0, 1));
      } else if (action === "drop") {
        clock += 1;
        for (const each of sent) if (each.state === "pending") unknown(each);
        reads = [];
        lists = [];
        gateway.dropAll();
        await until(() => client.state.connection.status === "connected");
      } else if (action === "close") {
        if (direct) client.closeSession(KEY);
        direct = false;
      } else if (action === "open") {
        if (!direct) client.openSession(KEY);
        direct = true;
      } else if (action === "viewer-open") {
        if (!viewing) await viewer.apply({ type: "openSession", key: KEY });
        viewing = true;
      } else {
        if (viewing) await viewer.apply({ type: "closeSession", key: KEY });
        viewing = false;
      }
      await settle();
    }

    // Everything answered, the task open and read back: Deny leaves.
    if (!direct) client.openSession(KEY);
    direct = true;
    await settle();
    for (const each of sent.filter((one) => one.state === "pending")) {
      clock += 1;
      each.state = "refused";
      each.fail!(refused());
    }
    await settle();
    for (let round = 0; round < 6 && (lists.length > 0 || !card()); round += 1) {
      await until(() => lists.length > 0 || card() !== undefined);
      await answerLists(lists.splice(0));
    }
    for (const read of reads.splice(0)) stillPending(read);
    await settle();
    for (let round = 0; round < 6 && card()?.decisionError === "unknown"; round += 1) {
      if (card()?.readingAt === null) {
        void client.checkApproval(KEY, item.id).catch(() => undefined);
      }
      await until(() => reads.length > 0);
      for (const read of reads.splice(0)) stillPending(read);
      await settle();
    }
    expect(card()?.decisionError, `seed ${seed}`).not.toBe("unknown");
    await deny(true);
  } finally {
    viewer.dispose();
    client.stop();
  }
  expect(violations).toEqual([]);
}
