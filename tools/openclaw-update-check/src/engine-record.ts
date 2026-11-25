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
/** The tag as core reads it back from a gateway record (`openclaw-update.ts`): anything else is dropped. */
const TAG = /^clawtrate-update:[A-Za-z0-9._-]{8,64}$/;
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
    /**
     * After the reopen, until the first `update.status` answered: how long the engine showed the
     * gateway, its offer and admin with nothing holding Update (the button would be pressable).
     */
    unheldMs: number | null;
  };
};

const sentOf = (entries: readonly EngineEntry[]) =>
  entries.filter((e): e is Extract<EngineEntry, { kind: "sent" }> => e.kind === "sent");
const markAt = (entries: readonly EngineEntry[], name: string) =>
  entries.findIndex((e) => e.kind === "mark" && e.name === name);

/** The answer to a request: the first one after it with the same socket and id, and where it is. */
function answerTo(
  entries: readonly EngineEntry[],
  request: Extract<EngineEntry, { kind: "sent" }>,
): { e: Extract<EngineEntry, { kind: "answer" }>; i: number } | null {
  const from = entries.indexOf(request);
  for (let i = from + 1; i < entries.length; i += 1) {
    const e = entries[i]!;
    if (e.kind === "answer" && e.socket === request.socket && e.id === request.id) return { e, i };
  }
  return null;
}

/** Run records in an answer: `update.status` activeRun/lastRun, `update.runs.get`, `.list`. */
function recordsIn(payload: unknown): JsonRecord[] {
  const p = asRecord(payload);
  return [p.activeRun, p.lastRun, p.run, ...(Array.isArray(p.runs) ? p.runs : [])]
    .map(asRecord)
    .filter((r) => typeof r.runId === "string");
}

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
  /** The gateway the press was made on: the identity its connection read just before it. */
  let pressedGateway: string | null = null;
  if (press) {
    const requester = asRecord(asRecord(press.params).requester);
    const keys = Object.keys(asRecord(press.params));
    if (
      keys.length !== 1 ||
      requester.channel !== "webchat" ||
      typeof requester.senderId !== "string" ||
      !TAG.test(requester.senderId)
    ) {
      failures.push(`update.run was sent with ${JSON.stringify(press.params)}`);
    }
    // An identity read on the press's own connection, answered with an identity before the press.
    const pressIndex = entries.indexOf(press);
    for (const s of sentOf(entries.slice(0, pressIndex))) {
      if (s.method !== "gateway.identity.get" || s.socket !== press.socket) continue;
      const reply = answerTo(entries, s);
      const id = asRecord(reply?.e.payload).deviceId;
      if (
        reply !== null &&
        reply.i < pressIndex &&
        reply.e.ok &&
        typeof id === "string" &&
        id !== ""
      ) {
        pressedGateway = id;
      }
    }
    if (pressedGateway === null) {
      failures.push("update.run was sent with no identity read on its connection");
    }
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
  // The engine's last word before the driver stopped it (stopping resets the state).
  const stopAt = markAt(entries, "stop");
  const final =
    (stopAt === -1 ? states : states.filter((s) => entries.indexOf(s) < stopAt)).at(-1)?.view ??
    null;
  const run = final?.run ?? null;
  // The press's own run: from its answer, or, when the answer was lost, the record carrying its tag.
  const tag = press ? asRecord(asRecord(press.params).requester).senderId : null;
  const reply = press ? answerTo(entries, press) : null;
  const answered = reply?.e.ok ? asRecord(reply.e.payload).runId : null;
  const tagged = entries
    .filter((e): e is Extract<EngineEntry, { kind: "answer" }> => e.kind === "answer" && e.ok)
    .flatMap((e) => recordsIn(e.payload))
    .find((r) => tag !== null && asRecord(asRecord(r.origin).requester).senderId === tag)?.runId;
  const pressRun =
    typeof answered === "string" ? answered : typeof tagged === "string" ? tagged : null;
  if (!run) {
    failures.push("the engine showed no run");
  } else {
    if (pressRun === null) {
      failures.push("no answer or gateway record names the press's run");
    } else if (run.runId !== pressRun) {
      failures.push(`the engine followed run ${run.runId}, not the press's run ${pressRun}`);
    }
    if (run.outcome !== "updated") failures.push(`the engine's outcome is ${run.outcome}`);
    if (run.mine !== true) failures.push(`the engine showed the run as mine: ${String(run.mine)}`);
    if (run.outcome === "updated" && (run.to === null || final?.serverVersion == null)) {
      failures.push('"updated" with no version named');
    } else if (run.outcome === "updated" && run.to !== final?.serverVersion) {
      failures.push(`"updated" to ${run.to}, but the gateway reports ${final?.serverVersion}`);
    }
    if (run.gatewayId !== final?.gatewayId) {
      failures.push("the run's gateway is not the connected one");
    }
    // Both must be the gateway the press was made on.
    if (pressedGateway !== null && final?.gatewayId !== pressedGateway) {
      failures.push(
        `the engine ended on gateway ${final?.gatewayId}, not ${pressedGateway}, where Update was pressed`,
      );
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
    // What the first connection after the drop asked, on that connection only.
    const nextHello = indexed.find(({ e, i }) => i > dropAt && e.kind === "hello");
    const socket = (nextHello?.e as { socket?: number } | undefined)?.socket;
    afterDrop = nextHello
      ? sentIn(nextHello.i, entries.length)
          .filter((s) => s.socket === socket && UPDATE_METHOD.test(s.method))
          .slice(0, 4)
          .map((s) => s.method)
      : [];
    if (afterDrop[0] !== "update.status") {
      failures.push(
        `after the drop the engine asked ${afterDrop[0] ?? "nothing"} first, not update.status`,
      );
    }
  }

  // A reopen: a press before the gateway's status answers is refused, and how long Update showed
  // as pressable meanwhile is measured.
  let unheldMs: number | null = null;
  if (plan.reopen) {
    const reopenAt = markAt(entries, "reopen");
    if (reopenAt === -1) {
      failures.push("the client was not reopened");
    } else {
      // The first successful status answer after the reopen, paired with its request by socket
      // and id: a failed read keeps the hold, so the window goes on through it.
      const statusAnswers = sentOf(entries.slice(reopenAt + 1))
        .filter((s) => s.method === "update.status")
        .map((s) => answerTo(entries, s))
        .filter((a): a is NonNullable<typeof a> => a !== null && a.e.ok)
        .sort((a, b) => a.i - b.i);
      const answered = statusAnswers[0];
      if (!answered) failures.push("update.status never answered after the reopen");
      // The states between the reopen and that answer, in trace order.
      const endIndex = answered?.i ?? entries.length;
      const end = entries[endIndex]?.at ?? entries.at(-1)?.at ?? 0;
      const window = indexed.filter(
        ({ e, i }) => i > reopenAt && i < endIndex && e.kind === "state",
      ) as { e: Extract<EngineEntry, { kind: "state" }>; i: number }[];
      let unheld = 0;
      window.forEach(({ e }, k) => {
        const v = e.view;
        const pressable =
          v.status === "connected" &&
          v.canAdmin &&
          v.gatewayId !== null &&
          v.offer !== null &&
          !v.looking &&
          !v.starting &&
          !["running", "late", "away"].includes(v.run?.outcome ?? "");
        const next = window[k + 1]?.e.at ?? end;
        if (pressable) unheld += next - e.at;
      });
      unheldMs = unheld;
      // The press must have gone out before the status answered: the refusal may land after it.
      const refusedAt = markAt(entries, "press-refused");
      const sentAt = markAt(entries, "press-sent");
      const pressesAfter = entries.filter(
        (e) => e.kind === "mark" && e.name === "press-sent",
      ).length;
      if (pressesAfter > 1)
        failures.push(`the reopened client was pressed ${pressesAfter} times, not once`);
      const pressedAt = sentAt === -1 ? refusedAt : sentAt;
      if (refusedAt === -1) {
        failures.push("a press right after the reopen was not refused");
      } else if (answered && pressedAt > answered.i) {
        failures.push(
          "the press after the reopen came after the status answered, so it shows no hold",
        );
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
      unheldMs,
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
    ...(f.unheldMs === null
      ? []
      : [
          `- After the reopen, Update showed as pressable for ${f.unheldMs} ms before the status answered`,
        ]),
    `- Outcomes: ${f.outcomes.map((o) => `${s(o.atMs)} ${o.outcome}/${o.phase}`).join(", ")}`,
  ].join("\n")}\n`;
}
