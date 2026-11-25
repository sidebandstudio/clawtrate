// What Clawtrate's own update engine (packages/core/src/openclaw-update.ts) did against a real
// update, and its verdict. Pure, so the rules are tested against constructed traces; engine.ts
// drives the client and writes the trace.

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};

/** What the engine showed: the parts of `ClawtrateState` the verdict reads. */
export type EngineView = {
  status: string;
  gatewayId: string | null;
  serverVersion: string | null;
  canAdmin: boolean;
  offer: string | null;
  run: {
    runId: string;
    gatewayId: string;
    mine: boolean | null;
    phase: string;
    outcome: string;
    from: string | null;
    to: string | null;
    reported: string | null;
  } | null;
  starting: boolean;
  looking: boolean;
  error: string | null;
};

/** One thing the driver saw. `socket` counts the client's sockets, so a request has its connection. */
export type EngineEntry =
  | { at: number; kind: "sent"; socket: number; id: string; method: string; params: unknown }
  | { at: number; kind: "answer"; socket: number; id: string; ok: boolean; payload: unknown }
  | { at: number; kind: "event"; socket: number; event: string; payload: unknown }
  | { at: number; kind: "hello"; socket: number }
  | { at: number; kind: "state"; view: EngineView }
  /** A step of the driver's script: `reconnect`, `confirm`, `press`, `reopen`, … */
  | { at: number; kind: "mark"; name: string; detail?: string }
  | { at: number; kind: "note"; text: string };

export type EnginePlan = {
  /** The connection drops right after `update.run` is sent, so its answer is lost. */
  dropAnswer?: boolean;
  /** The client is closed and a new one opened on the same storage while the run validates. */
  reopen?: boolean;
  /** How many reconnects the driver forced before the confirmation. */
  reconnects: number;
};

export const TAG_PREFIX = "clawtrate-update:";
const UPDATE_METHOD = /^update\.(status|run|runs\.)/;

export type EngineVerdict = {
  passed: boolean;
  failures: string[];
  facts: {
    /** Update requests before the confirmation opened, across the forced reconnects. */
    updateRequestsBeforeConfirm: string[];
    /** `update.status` requests between opening the confirmation and the press. */
    statusOnConfirm: number;
    presses: number;
    /** The final run as the engine showed it, and the gateway version it reported then. */
    run: EngineView["run"];
    serverVersion: string | null;
    /** `models.list` requests after the engine first said "updated". */
    modelReadsAfterUpdated: number;
    /** Update requests after "updated" (none should follow). */
    updateRequestsAfterUpdated: string[];
    /** The outcomes the engine went through, in order, with ms after the press. */
    outcomes: { atMs: number; outcome: string; phase: string }[];
    /** After a lost answer: what the engine asked on the next connection, in order. */
    afterDrop: string[];
    /** After the reopen: whether Update was held until the first `update.status` answered. */
    heldOnReopen: boolean | null;
  };
};

const sentOf = (entries: readonly EngineEntry[]) =>
  entries.filter((e): e is Extract<EngineEntry, { kind: "sent" }> => e.kind === "sent");
const markAt = (entries: readonly EngineEntry[], name: string) =>
  entries.findIndex((e) => e.kind === "mark" && e.name === name);

/** The verdict on one engine run. */
export function judgeEngine(entries: readonly EngineEntry[], plan: EnginePlan): EngineVerdict {
  const failures: string[] = [];
  const confirmAt = markAt(entries, "confirm");
  const pressAt = markAt(entries, "press");
  const indexed = entries.map((e, i) => ({ e, i }));
  const sentIn = (from: number, to: number) =>
    indexed
      .filter(({ e, i }) => i > from && i < to && e.kind === "sent")
      .map(({ e }) => e as Extract<EngineEntry, { kind: "sent" }>);

  // Nothing about updating is asked on a plain connect or reconnect.
  const reconnects = entries.filter((e) => e.kind === "mark" && e.name === "reconnected").length;
  if (reconnects < plan.reconnects) {
    failures.push(`${reconnects} reconnects were seen, not ${plan.reconnects}`);
  }
  const before = sentIn(-1, confirmAt === -1 ? entries.length : confirmAt).filter((s) =>
    UPDATE_METHOD.test(s.method),
  );
  if (confirmAt === -1) failures.push("the confirmation was never opened");
  if (before.length > 0) {
    failures.push(`asked ${before.map((s) => s.method).join(", ")} before anything asked it to`);
  }

  // Opening the confirmation asks update.status once.
  const statusOnConfirm =
    confirmAt === -1
      ? 0
      : sentIn(confirmAt, pressAt === -1 ? entries.length : pressAt).filter(
          (s) => s.method === "update.status",
        ).length;
  if (confirmAt !== -1 && statusOnConfirm !== 1) {
    failures.push(
      `opening the confirmation asked update.status ${statusOnConfirm} times, not once`,
    );
  }

  // One press, one update.run, tagged, after the identity was read on the same connection.
  const presses = sentOf(entries).filter((s) => s.method === "update.run");
  if (presses.length !== 1) failures.push(`update.run was sent ${presses.length} times, not once`);
  const press = presses[0];
  if (press) {
    const requester = asRecord(asRecord(press.params).requester);
    const keys = Object.keys(asRecord(press.params));
    if (
      keys.length !== 1 ||
      requester.channel !== "webchat" ||
      typeof requester.senderId !== "string" ||
      !requester.senderId.startsWith(TAG_PREFIX)
    ) {
      failures.push(`update.run was sent with ${JSON.stringify(press.params)}`);
    }
    const pressIndex = entries.indexOf(press);
    const identity = indexed.some(
      ({ e, i }) =>
        i < pressIndex &&
        e.kind === "sent" &&
        e.method === "gateway.identity.get" &&
        e.socket === press.socket,
    );
    if (!identity) failures.push("update.run was sent with no identity read on its connection");
  }

  // The outcomes the engine showed, and its last word.
  const states = entries.filter(
    (e): e is Extract<EngineEntry, { kind: "state" }> => e.kind === "state",
  );
  const t0 = pressAt === -1 ? 0 : entries[pressAt]!.at;
  const outcomes: EngineVerdict["facts"]["outcomes"] = [];
  for (const s of states) {
    const run = s.view.run;
    if (!run) continue;
    const last = outcomes.at(-1);
    if (!last || last.outcome !== run.outcome || last.phase !== run.phase) {
      outcomes.push({ atMs: s.at - t0, outcome: run.outcome, phase: run.phase });
    }
  }
  const final = states.at(-1)?.view ?? null;
  const run = final?.run ?? null;
  if (!run) {
    failures.push("the engine showed no run");
  } else {
    if (run.outcome !== "updated") failures.push(`the engine's outcome is ${run.outcome}`);
    if (run.mine !== true) failures.push(`the engine showed the run as mine: ${String(run.mine)}`);
    if (run.outcome === "updated" && run.to !== final?.serverVersion) {
      failures.push(`"updated" to ${run.to}, but the gateway reports ${final?.serverVersion}`);
    }
    if (run.gatewayId !== final?.gatewayId) {
      failures.push("the run's gateway is not the connected one");
    }
  }

  // After "updated": the model list once, and nothing more about the update.
  const updatedAt = entries.findIndex(
    (e) => e.kind === "state" && e.view.run?.outcome === "updated",
  );
  const afterUpdated = updatedAt === -1 ? [] : sentIn(updatedAt, entries.length);
  const modelReadsAfterUpdated = afterUpdated.filter((s) => s.method === "models.list").length;
  const updateRequestsAfterUpdated = afterUpdated
    .filter((s) => UPDATE_METHOD.test(s.method))
    .map((s) => s.method);
  if (updatedAt !== -1) {
    if (modelReadsAfterUpdated !== 1) {
      failures.push(
        `the model list was read ${modelReadsAfterUpdated} times after "updated", not once`,
      );
    }
    if (updateRequestsAfterUpdated.length > 0) {
      failures.push(`asked ${updateRequestsAfterUpdated.join(", ")} after "updated"`);
    }
  }

  // A lost answer: the next connection asks at once and finds the run by its tag.
  let afterDrop: string[] = [];
  if (plan.dropAnswer) {
    const dropAt = markAt(entries, "dropped");
    if (dropAt === -1) failures.push("the connection was not dropped after the press");
    const answered = indexed.some(
      ({ e, i }) =>
        i > entries.indexOf(press ?? entries[0]!) &&
        e.kind === "answer" &&
        e.id === press?.id &&
        e.socket === press?.socket,
    );
    if (answered) failures.push("the update.run answer arrived before the connection dropped");
    const nextHello = indexed.find(({ e, i }) => i > dropAt && e.kind === "hello");
    afterDrop = nextHello
      ? sentIn(nextHello.i, entries.length)
          .filter((s) => UPDATE_METHOD.test(s.method))
          .slice(0, 4)
          .map((s) => s.method)
      : [];
    if (afterDrop[0] !== "update.status") {
      failures.push(
        `after the drop the engine asked ${afterDrop[0] ?? "nothing"} first, not update.status`,
      );
    }
  }

  // A reopen: Update held from the first moment, until the gateway's status answered.
  let heldOnReopen: boolean | null = null;
  if (plan.reopen) {
    const reopenAt = markAt(entries, "reopen");
    if (reopenAt === -1) {
      failures.push("the client was not reopened");
    } else {
      const firstStatus = indexed.find(
        ({ e, i }) => i > reopenAt && e.kind === "sent" && e.method === "update.status",
      );
      const answeredAt = firstStatus
        ? indexed.find(
            ({ e, i }) =>
              i > firstStatus.i &&
              e.kind === "answer" &&
              e.id === (firstStatus.e as { id: string }).id,
          )?.i
        : undefined;
      const window = indexed.filter(
        ({ e, i }) =>
          i > reopenAt &&
          (answeredAt === undefined || i < answeredAt) &&
          e.kind === "state" &&
          e.view.status === "connected" &&
          e.view.canAdmin,
      );
      heldOnReopen =
        window.length > 0 &&
        window.every(({ e }) => {
          const view = (e as Extract<EngineEntry, { kind: "state" }>).view;
          return view.looking || view.run?.outcome === "running";
        });
      if (!heldOnReopen)
        failures.push("Update was not held after the reopen before the status answered");
      if (!entries.some((e) => e.kind === "mark" && e.name === "press-refused")) {
        failures.push("a press right after the reopen was not refused");
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    facts: {
      updateRequestsBeforeConfirm: before.map((s) => s.method),
      statusOnConfirm,
      presses: presses.length,
      run,
      serverVersion: final?.serverVersion ?? null,
      modelReadsAfterUpdated,
      updateRequestsAfterUpdated,
      outcomes,
      afterDrop,
      heldOnReopen,
    },
  };
}

/** The verdict as a short Markdown summary for the run's page. */
export function engineSummary(verdict: EngineVerdict, mode: string): string {
  const f = verdict.facts;
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  return `${[
    `### Clawtrate's update engine against a real update (${mode}): ${verdict.passed ? "passed" : "failed"}`,
    "",
    ...verdict.failures.map((failure) => `- **Failed:** ${failure}`),
    `- Final: ${f.run?.outcome} (mine ${String(f.run?.mine)}), ${f.run?.from} to ${f.run?.to}; the gateway reports ${f.serverVersion}`,
    `- Update requests before the confirmation: ${f.updateRequestsBeforeConfirm.length}; update.status on opening it: ${f.statusOnConfirm}; update.run sent ${f.presses}×`,
    `- After "updated": models.list ${f.modelReadsAfterUpdated}×, update requests ${f.updateRequestsAfterUpdated.length}`,
    ...(f.afterDrop.length > 0
      ? [`- After the lost answer the engine asked: ${f.afterDrop.join(", ")}`]
      : []),
    ...(f.heldOnReopen === null
      ? []
      : [`- Update held after the reopen until the status answered: ${f.heldOnReopen}`]),
    `- Outcomes: ${f.outcomes.map((o) => `${s(o.atMs)} ${o.outcome}/${o.phase}`).join(", ")}`,
  ].join("\n")}\n`;
}
