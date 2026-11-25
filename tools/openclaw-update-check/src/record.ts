// What the real OpenClaw update check saw, and its verdict. Everything here is pure, so the
// rules are tested against constructed records; check.ts does the connecting.

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** One thing the driver saw, at a wall-clock time in ms. */
export type Entry =
  | {
      at: number;
      kind: "hello";
      serverVersion: string | null;
      updateAvailable: unknown;
      uptimeMs: number | null;
    }
  /** `own` marks a close the driver caused itself, reopening its client. */
  | { at: number; kind: "close"; code: number; reason: string; own?: boolean }
  | { at: number; kind: "event"; event: string; payload: unknown }
  | { at: number; kind: "sent"; method: string; params: unknown }
  | { at: number; kind: "answer"; method: string; result: unknown }
  | { at: number; kind: "refused"; method: string; code: string; message: string }
  | { at: number; kind: "note"; text: string };

/** What the run is expected to do: update, or be refused on a package install in a folder. */
export type Expectation = "updated" | "unmanaged";

/** What the driver did besides the one press, which the verdict checks as well. */
export type Plan = {
  expect: Expectation;
  /** The requester each press carries, as Clawtrate sends it: `webchat` and a tag of its own. */
  requesterPrefix?: string;
  /** A second `update.run` sent while the first runs. */
  secondPress?: boolean;
  /** The client closed and opened again while the run was validating. */
  reopen?: boolean;
  /** A chat turn on this session key was running when `update.run` was sent. */
  busySession?: string;
  /** The connection was closed right after the press, so its answer was lost. */
  dropAnswer?: boolean;
  /** The press came while the gateway's own automatic update waited: it adopts that campaign. */
  campaign?: boolean;
};

/**
 * The check calls `update.run` and a global package install follows, so it runs only on a
 * GitHub-hosted runner, which GitHub discards after the job, and only on a profile of ours.
 */
export function refusalToRun(env: NodeJS.ProcessEnv, profile: string): string | null {
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted") {
    return "this check updates OpenClaw for real and runs only on a GitHub-hosted runner";
  }
  if (!/^clawtrate-dev-[a-z0-9][a-z0-9-]{0,40}$/.test(profile)) {
    return `refusing profile "${profile}": only a clawtrate-dev-<name> profile`;
  }
  return null;
}

export const STATUS_DONE = new Set(["succeeded", "failed", "rolled-back", "skipped"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL_CHAT = new Set(["final", "aborted", "error"]);

/** A run record's fields the verdict reads. */
export type RunView = {
  runId: string | null;
  phase: string | null;
  status: string | null;
  reason: string | null;
  before: string | null;
  target: string | null;
  after: string | null;
  trigger: string | null;
  /** `origin.requester`, as the gateway kept it. */
  requester: unknown;
  /** The record's notice steps (`notice:<phase>`) and whether a notice was delivered. */
  notices: { step: string; status: string | null; detail: unknown }[];
  noticeDelivered: unknown;
};

export function readRun(value: unknown): RunView {
  const run = asRecord(value);
  return {
    runId: text(run.runId),
    phase: text(run.phase),
    status: text(run.status),
    reason: text(run.reason),
    before: text(asRecord(run.before).version),
    target: text(asRecord(run.target).version),
    after: text(asRecord(run.after).version),
    trigger: text(run.trigger),
    requester: asRecord(run.origin).requester ?? null,
    notices: (Array.isArray(run.steps) ? run.steps : [])
      .map(asRecord)
      .filter((step) => text(step.step ?? step.name)?.startsWith("notice:"))
      .map((step) => ({
        step: text(step.step ?? step.name) ?? "",
        status: text(step.status),
        detail: step.detail ?? null,
      })),
    noticeDelivered: asRecord(run.verification).noticeDelivered ?? null,
  };
}

/** A session as `sessions.list` lists it: its key and what changes when something lands in it. */
function sessionsOf(result: unknown): Map<string, string> {
  const list = asRecord(result).sessions;
  const out = new Map<string, string>();
  for (const item of Array.isArray(list) ? list : []) {
    const session = asRecord(item);
    const key = text(session.key);
    if (key) out.set(key, JSON.stringify([session.updatedAt ?? null, session.lastMessage ?? null]));
  }
  return out;
}

type Window = { count: number; firstMs: number | null; lastMs: number | null };
const emptyWindow = (): Window => ({ count: 0, firstMs: null, lastMs: null });
const mark = (window: Window, ms: number) => {
  window.count += 1;
  window.firstMs ??= ms;
  window.lastMs = ms;
};

export type Verdict = {
  passed: boolean;
  failures: string[];
  facts: {
    /** How many `update.run` requests were sent, and with which parameters. */
    presses: { count: number; params: unknown[] };
    /** The first `update.run`'s answer and how long it took. */
    handoff: {
      ok: unknown;
      reason: string | null;
      handoff: string | null;
      runId: string | null;
      answerMs: number;
    } | null;
    /** The second press's answer, when there was one. */
    secondPress: { ok: unknown; reason: string | null; runId: string | null } | null;
    /** Each new phase/status pair, in the order seen, ms after `update.run` was sent. */
    phases: { atMs: number; phase: string; status: string; from: "event" | "runs.get" }[];
    /** The first close the gateway caused after `update.run`, and the first hello after it. */
    dropMs: number | null;
    reconnectMs: number | null;
    /** When the restarted gateway started, from that hello's `uptimeMs`. */
    restartedMs: number | null;
    closes: number;
    /** Whether an `update.run.changed` arrived before that first close. */
    changedBeforeDrop: boolean;
    /** `update.runs.get` answers of UNAVAILABLE. */
    unavailable: Window;
    /** When a status other than running was first seen. */
    terminalMs: number | null;
    /** Terminal `update.run.changed` events for the run after the reconnect. */
    terminalRepeats: Window;
    /** The run as the first `update.status` after the drop listed it: its phase, or null. */
    activeRunAfterDrop: { phase: string | null } | null;
    /** The reopened client's `update.status`: whether it listed the same run as active. */
    reopen: { sameRun: boolean; phase: string | null } | null;
    /** The chat turn in flight: how it ended and when, and whether it ended before the drop. */
    busy: { state: string | null; endedMs: number | null; endedBeforeDrop: boolean | null } | null;
    /** What each press sent as its requester, what the run record kept, and the run's trigger. */
    requester: { sent: unknown; kept: unknown; trigger: string | null } | null;
    /** The runs `update.runs.list` lists with this press's tag, after the run. */
    foundByTag: string[] | null;
    /** Anything delivered because of the run: notices, and sessions new or changed since before. */
    delivery: {
      notices: RunView["notices"];
      noticeDelivered: unknown;
      newSessions: string[];
      changedSessions: string[];
      chatEventsElsewhere: number;
      /** Messages in the sessions' transcripts after the run that mention an update. */
      updateMessages: string[];
    };
    /** The longest gap between the run's events while connected and running, in ms. */
    longestQuietMs: number | null;
    /** Answers and refusals that said "database is locked". */
    databaseLocked: number;
    /** Events whose payload carried the press's tag. */
    tagInEvents: string[];
    /** Whether the run went through the `repairing` phase. */
    repairing: boolean;
    /** Answer times per method: count, median and longest, in ms. */
    latency: Record<string, { count: number; medianMs: number; maxMs: number }>;
    latestBefore: string | null;
    serverVersionBefore: string | null;
    serverVersionAfter: string | null;
    run: RunView | null;
  };
};

/** Answer times of each method, pairing each request with the next answer or refusal. */
function latencies(entries: readonly Entry[]): Verdict["facts"]["latency"] {
  const open = new Map<string, number[]>();
  const times = new Map<string, number[]>();
  for (const e of entries) {
    if (e.kind === "sent") open.set(e.method, [...(open.get(e.method) ?? []), e.at]);
    if (e.kind !== "answer" && e.kind !== "refused") continue;
    const sentAt = open.get(e.method)?.shift();
    if (sentAt === undefined) continue;
    times.set(e.method, [...(times.get(e.method) ?? []), e.at - sentAt]);
  }
  const out: Verdict["facts"]["latency"] = {};
  for (const [method, list] of times) {
    const sorted = [...list].sort((a, b) => a - b);
    out[method] = {
      count: sorted.length,
      medianMs: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
      maxMs: sorted.at(-1) ?? 0,
    };
  }
  return out;
}

/** The verdict of report section 7, "Updated is said only when", from what was seen. */
export function judge(entries: readonly Entry[], runId: string | null, plan: Plan): Verdict {
  const failures: string[] = [];
  const presses = entries.filter(
    (e): e is Extract<Entry, { kind: "sent" }> => e.kind === "sent" && e.method === "update.run",
  );
  const sentRun = presses[0];
  const t0 = sentRun?.at ?? entries[0]?.at ?? 0;
  const rel = (at: number) => at - t0;
  // Split by order, not time: an answer read just before the send can share its millisecond.
  const sentAt = sentRun ? entries.indexOf(sentRun) : entries.length;
  const before = entries.slice(0, sentAt + 1);
  const after = entries.slice(sentAt + 1);

  const answers = (list: readonly Entry[], method: string) =>
    list.filter(
      (e): e is Extract<Entry, { kind: "answer" }> => e.kind === "answer" && e.method === method,
    );
  const hellos = entries.filter((e): e is Extract<Entry, { kind: "hello" }> => e.kind === "hello");

  // One press (two with a planned second one), always with no parameters.
  const expectedPresses = plan.secondPress ? 2 : 1;
  if (presses.length !== expectedPresses) {
    failures.push(`update.run was sent ${presses.length} times, not ${expectedPresses}`);
  }
  const prefix = plan.requesterPrefix;
  const isPress = (params: unknown) => {
    const keys = Object.keys(asRecord(params));
    const requester = asRecord(asRecord(params).requester);
    return prefix === undefined
      ? keys.length === 0
      : keys.length === 1 &&
          requester.channel === "webchat" &&
          Object.keys(requester).length === 2 &&
          typeof requester.senderId === "string" &&
          requester.senderId.startsWith(prefix);
  };
  if (presses.some((p) => !isPress(p.params))) {
    failures.push(
      prefix === undefined
        ? "update.run was sent with parameters"
        : "update.run was sent with parameters other than a webchat requester and its tag",
    );
  }

  // Before the run: what the gateway reported as the newest version, and who it was.
  const statusBefore = answers(before, "update.status").at(-1);
  const latestBefore = text(asRecord(asRecord(statusBefore?.result).updateAvailable).latestVersion);
  const identityBefore = text(
    asRecord(answers(before, "gateway.identity.get")[0]?.result).deviceId,
  );
  const serverVersionBefore = hellos[0]?.serverVersion ?? null;
  if (!identityBefore) failures.push("gateway.identity.get named no identity before the run");

  // The answers to update.run, in order.
  const runAnswers = answers(after, "update.run");
  const readAnswer = (e: Extract<Entry, { kind: "answer" }> | undefined) => {
    const answer = asRecord(e?.result);
    return {
      ok: answer.ok,
      reason: text(asRecord(answer.result).reason),
      handoff: text(asRecord(answer.handoff).status),
      runId: text(answer.runId),
    };
  };
  const handoff = runAnswers[0]
    ? { ...readAnswer(runAnswers[0]), answerMs: rel(runAnswers[0].at) }
    : null;
  const secondPress = plan.secondPress && runAnswers[1] ? readAnswer(runAnswers[1]) : null;
  const runRefused = after.find((e) => e.kind === "refused" && e.method === "update.run");
  if (plan.dropAnswer) {
    // The answer was lost on purpose; the run is found by its tag instead.
  } else if (runRefused?.kind === "refused" && !handoff) {
    failures.push(`update.run was refused: ${runRefused.code} ${runRefused.message}`);
  } else if (!handoff) {
    failures.push("update.run was not answered");
  }

  // The run as it moved: events for it and update.runs.get answers.
  const phases: Verdict["facts"]["phases"] = [];
  let terminalMs: number | null = null;
  let finalRun: RunView | null = null;
  const seen = (
    at: number,
    phase: string | null,
    status: string | null,
    from: "event" | "runs.get",
  ) => {
    if (!phase || !status) return;
    const last = phases.at(-1);
    if (!last || last.phase !== phase || last.status !== status) {
      phases.push({ atMs: rel(at), phase, status, from });
    }
    if (terminalMs === null && STATUS_DONE.has(status)) terminalMs = rel(at);
  };
  const unavailable = emptyWindow();
  const terminalRepeats = emptyWindow();
  let closes = 0;
  let dropAt: number | null = null;
  let reconnect: Extract<Entry, { kind: "hello" }> | null = null;
  let changedBeforeDrop = false;
  let reopenedAt: number | null = null;
  let longestQuietMs: number | null = null;
  let lastRunEventAt: number | null = null;
  let finished = false;
  let chatEventsElsewhere = 0;
  let busy: Verdict["facts"]["busy"] = plan.busySession
    ? { state: null, endedMs: null, endedBeforeDrop: null }
    : null;
  for (const e of after) {
    if (e.kind === "event" && e.event === "update.run.changed") {
      const payload = asRecord(e.payload);
      if (runId !== null && payload.runId !== runId) continue;
      if (dropAt === null) changedBeforeDrop = true;
      const status = text(payload.status);
      if (!finished && lastRunEventAt !== null) {
        longestQuietMs = Math.max(longestQuietMs ?? 0, e.at - lastRunEventAt);
      }
      lastRunEventAt = e.at;
      if (status !== null && STATUS_DONE.has(status)) finished = true;
      seen(e.at, text(payload.phase), status, "event");
      if (reconnect !== null && status !== null && STATUS_DONE.has(status)) {
        mark(terminalRepeats, rel(e.at));
      }
    } else if (e.kind === "event" && e.event === "chat") {
      const payload = asRecord(e.payload);
      if (payload.sessionKey !== plan.busySession) chatEventsElsewhere += 1;
      if (!busy || busy.state !== null) continue;
      const state = text(payload.state);
      if (payload.sessionKey === plan.busySession && state !== null && TERMINAL_CHAT.has(state)) {
        busy = { state, endedMs: rel(e.at), endedBeforeDrop: dropAt === null };
      }
    } else if (e.kind === "answer" && e.method === "update.runs.get") {
      const run = readRun(asRecord(e.result).run);
      if (run.runId === null || (runId !== null && run.runId !== runId)) continue;
      seen(e.at, run.phase, run.status, "runs.get");
      finalRun = run;
    } else if (e.kind === "refused" && e.method === "update.runs.get" && e.code === "UNAVAILABLE") {
      mark(unavailable, rel(e.at));
    } else if (e.kind === "close") {
      if (e.own) {
        reopenedAt = e.at;
        continue;
      }
      closes += 1;
      dropAt ??= e.at;
      // A gap across a disconnection is the restart's, not a quiet run's.
      lastRunEventAt = null;
    } else if (e.kind === "hello" && dropAt !== null) {
      reconnect ??= e;
    }
  }
  const reconnectAt = (reconnect as Extract<Entry, { kind: "hello" }> | null)?.at ?? null;
  const reconnectUptime = (reconnect as Extract<Entry, { kind: "hello" }> | null)?.uptimeMs;

  // update.status after the reconnect, and after the client reopened.
  const firstStatusAfter = (at: number | null) =>
    at === null ? undefined : answers(after, "update.status").find((e) => e.at >= at);
  const activeOf = (e: Extract<Entry, { kind: "answer" }> | undefined) =>
    e === undefined ? null : readRun(asRecord(e.result).activeRun);
  const afterDrop = activeOf(firstStatusAfter(reconnectAt));
  const activeRunAfterDrop =
    afterDrop === null ? null : { phase: afterDrop.runId === runId ? afterDrop.phase : null };
  const reopened = activeOf(firstStatusAfter(reopenedAt));
  const reopen =
    reopened === null
      ? null
      : { sameRun: runId !== null && reopened.runId === runId, phase: reopened.phase };
  if (plan.reopen && !reopen?.sameRun) {
    failures.push("after reopening mid-run, update.status did not list the same run as active");
  }

  const run = finalRun as RunView | null;

  // The requester: kept on the record, and the run found by its tag.
  const sentRequester = sentRun ? (asRecord(sentRun.params).requester ?? null) : null;
  const requester = run ? { sent: sentRequester, kept: run.requester, trigger: run.trigger } : null;
  const tag = text(asRecord(sentRequester).senderId);
  const listed = answers(after, "update.runs.list").at(-1);
  const foundByTag =
    listed === undefined || tag === null
      ? null
      : (Array.isArray(asRecord(listed.result).runs)
          ? (asRecord(listed.result).runs as unknown[])
          : []
        )
          .map(asRecord)
          .filter((r) => text(asRecord(asRecord(r.origin).requester).senderId) === tag)
          .map((r) => text(r.runId) ?? "");
  const expectedTrigger = plan.campaign ? "campaign" : "api";
  if (run && run.trigger !== expectedTrigger) {
    failures.push(`the run's trigger is ${run.trigger}, not ${expectedTrigger}`);
  }
  // An adopted campaign's record is the campaign's own; the press's tag is recorded as found.
  if (prefix !== undefined && run && !plan.campaign) {
    if (JSON.stringify(run.requester) !== JSON.stringify(sentRequester)) {
      failures.push(
        `the run record kept requester ${JSON.stringify(run.requester)}, not ${JSON.stringify(sentRequester)}`,
      );
    }
    if (foundByTag === null || foundByTag.length !== 1 || foundByTag[0] !== runId) {
      failures.push(`update.runs.list found ${JSON.stringify(foundByTag)} by the tag, not the run`);
    }
  }

  // Nothing is delivered because of the run: no notice, no new or changed session.
  const sessionLists = answers(entries, "sessions.list");
  const sessionsBefore = sessionsOf(sessionLists[0]?.result);
  const sessionsAfter = sessionsOf(sessionLists.at(-1)?.result);
  const busyKey = plan.busySession;
  const newSessions = [...sessionsAfter.keys()].filter((k) => !sessionsBefore.has(k));
  const changedSessions = [...sessionsAfter]
    .filter(([k, v]) => k !== busyKey && sessionsBefore.has(k) && sessionsBefore.get(k) !== v)
    .map(([k]) => k);
  // Each transcript read after the run: any message about an update was delivered by it.
  const textOf = (message: unknown): string => {
    const content = asRecord(message).content;
    if (typeof content === "string") return content;
    return (Array.isArray(content) ? content : [])
      .map((part) => text(asRecord(part).text) ?? "")
      .join(" ");
  };
  const updateMessages = answers(after, "chat.history").flatMap((e) =>
    (Array.isArray(asRecord(e.result).messages) ? (asRecord(e.result).messages as unknown[]) : [])
      .map((m) => `${text(asRecord(m).role) ?? "?"}: ${textOf(m).slice(0, 200)}`)
      .filter((line) => /\bupdat/i.test(line)),
  );
  const delivery = {
    notices: run?.notices ?? [],
    noticeDelivered: run?.noticeDelivered ?? null,
    newSessions,
    changedSessions,
    chatEventsElsewhere,
    updateMessages,
  };
  if (updateMessages.length > 0) {
    failures.push(`a transcript mentions the update: ${updateMessages.join(" | ")}`);
  }
  if (sessionLists.length >= 2) {
    if (newSessions.length > 0) failures.push(`a session appeared: ${newSessions.join(", ")}`);
    if (changedSessions.length > 0) {
      failures.push(`a session changed: ${changedSessions.join(", ")}`);
    }
  }
  // `verification.noticeDelivered` is kept as a fact only: real runs posted the completion
  // message with it true and with it false (#572). The transcripts are what count.
  if (delivery.notices.some((n) => n.status === "completed")) {
    failures.push("the gateway delivered an update notice");
  }
  if (chatEventsElsewhere > 0) {
    failures.push(`${chatEventsElsewhere} chat events arrived for a session other than the turn`);
  }
  const tagInEvents =
    tag === null
      ? []
      : entries
          .filter((e) => e.kind === "event" && JSON.stringify(e.payload).includes(tag))
          .map((e) => (e.kind === "event" ? e.event : ""));
  if (tagInEvents.length > 0)
    failures.push(`the tag appeared in events: ${tagInEvents.join(", ")}`);
  const databaseLocked = entries.filter(
    (e) => e.kind === "refused" && /database is locked/i.test(e.message),
  ).length;
  if (databaseLocked > 0) failures.push(`${databaseLocked} answers said "database is locked"`);

  const lastHello = hellos.at(-1);
  const serverVersionAfter = lastHello && lastHello.at > t0 ? lastHello.serverVersion : null;
  const identityAfter = lastHello
    ? text(
        asRecord(
          answers(after, "gateway.identity.get")
            .filter((e) => e.at >= lastHello.at)
            .at(-1)?.result,
        ).deviceId,
      )
    : null;

  if (plan.expect === "unmanaged") {
    // A package installed in a folder: refused at once, as a skipped run, with no restart.
    if (handoff && handoff.ok !== false)
      failures.push(`update.run answered ok: ${String(handoff.ok)}`);
    if (run?.status !== "skipped" || run.reason !== "unmanaged-package-install") {
      failures.push(
        `the run ended ${run?.status ?? "unseen"} (${run?.reason ?? "no reason"}), not skipped (unmanaged-package-install)`,
      );
    }
    if (closes > 0) failures.push("the gateway closed the connection after a refused update");
  } else {
    if (!latestBefore) failures.push("update.status reported no newer OpenClaw before the run");
    if (!plan.dropAnswer && handoff && (handoff.ok !== true || handoff.handoff !== "started")) {
      failures.push(
        `update.run answered ok: ${String(handoff.ok)}, handoff ${handoff.handoff} (${handoff.reason ?? "no reason"})`,
      );
    }
    if (!plan.dropAnswer && handoff && (handoff.runId === null || !UUID.test(handoff.runId))) {
      failures.push(`update.run answered run id ${handoff.runId}, not a UUID`);
    }
    if (plan.secondPress && secondPress?.reason !== "managed-service-handoff-already-running") {
      failures.push(
        `the second update.run answered ${secondPress?.reason ?? "nothing"}, not managed-service-handoff-already-running`,
      );
    }
    if (!run || run.status === null || !STATUS_DONE.has(run.status)) {
      failures.push("update.runs.get never reported the run finished");
    } else if (run.status !== "succeeded") {
      failures.push(`the run ended ${run.status} (${run.reason ?? "no reason"})`);
    }
    if (run?.status === "succeeded") {
      if (reconnectAt === null || serverVersionAfter === null) {
        failures.push("no connection after the gateway restarted");
      }
      if (identityAfter === null) {
        failures.push("gateway.identity.get was not read after the restart");
      } else if (identityAfter !== identityBefore) {
        failures.push(
          `the gateway's identity changed: ${identityBefore} before, ${identityAfter} after`,
        );
      }
      const expected = run.after ?? run.target;
      if (expected === null) {
        failures.push("the run record names neither after.version nor target.version");
      } else if (serverVersionAfter !== null && serverVersionAfter !== expected) {
        failures.push(
          `hello-ok server.version is ${serverVersionAfter}, the run record says ${expected}`,
        );
      }
      if (run.after === null) {
        failures.push("the run record has no after.version");
      } else {
        if (latestBefore !== null && run.after !== latestBefore) {
          failures.push(`after.version is ${run.after}, but the gateway offered ${latestBefore}`);
        }
        if (run.target !== null && run.after !== run.target) {
          failures.push(`after.version is ${run.after}, but target.version is ${run.target}`);
        }
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    facts: {
      presses: { count: presses.length, params: presses.map((p) => p.params) },
      handoff,
      secondPress,
      phases,
      dropMs: dropAt === null ? null : rel(dropAt),
      reconnectMs: reconnectAt === null ? null : rel(reconnectAt),
      restartedMs:
        reconnectAt === null || typeof reconnectUptime !== "number"
          ? null
          : rel(reconnectAt - reconnectUptime),
      closes,
      changedBeforeDrop,
      unavailable,
      terminalMs,
      terminalRepeats,
      activeRunAfterDrop,
      reopen,
      busy,
      requester,
      foundByTag,
      delivery,
      longestQuietMs,
      databaseLocked,
      tagInEvents,
      repairing: phases.some((p) => p.phase === "repairing"),
      latency: latencies(entries),
      latestBefore,
      serverVersionBefore,
      serverVersionAfter,
      run,
    },
  };
}

const seconds = (ms: number) => `${ms < 0 ? "-" : "+"}${(Math.abs(ms) / 1000).toFixed(2)}s`;

/** A short form of a value for the timeline: one line, bounded. */
function brief(value: unknown, max = 240): string {
  const line = JSON.stringify(value) ?? "undefined";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** One entry without its time. */
export function describe(e: Entry): string {
  switch (e.kind) {
    case "hello":
      return `hello      server.version=${e.serverVersion} uptimeMs=${e.uptimeMs} updateAvailable=${brief(e.updateAvailable)}`;
    case "close":
      return `close      ${e.code} ${e.reason}${e.own ? " (the check's own)" : ""}`.trimEnd();
    case "event":
      return `event      ${e.event} ${brief(e.payload)}`;
    case "sent":
      return `sent       ${e.method} ${brief(e.params)}`;
    case "answer":
      return `answer     ${e.method} ${brief(e.result, 600)}`;
    case "refused":
      return `refused    ${e.method} ${e.code} ${e.message}`;
    case "note":
      return `note       ${e.text}`;
  }
}

/** One line per entry, timed from the `update.run` send. */
export function timeline(entries: readonly Entry[]): string[] {
  const t0 =
    entries.find((e) => e.kind === "sent" && e.method === "update.run")?.at ?? entries[0]?.at ?? 0;
  return entries.map((e) => `${seconds(e.at - t0).padStart(9)}  ${describe(e)}`);
}

/** The facts as a short Markdown summary for the run's page. */
export function summary(verdict: Verdict, mode: string): string {
  const f = verdict.facts;
  const ms = (value: number | null) => (value === null ? "not seen" : seconds(value));
  const window = (w: Window) => `${w.count}, from ${ms(w.firstMs)} to ${ms(w.lastMs)}`;
  const lines = [
    `### OpenClaw update through update.run (${mode}): ${verdict.passed ? "passed" : "failed"}`,
    "",
    ...verdict.failures.map((failure) => `- **Failed:** ${failure}`),
    `- Versions: ${f.serverVersionBefore} before, offered ${f.latestBefore}, ${f.serverVersionAfter ?? "none"} after; run record before ${f.run?.before}, target ${f.run?.target}, after ${f.run?.after}`,
    `- update.run sent ${f.presses.count} times; answered in ${ms(f.handoff?.answerMs ?? null)}: ok ${String(f.handoff?.ok)}, reason ${f.handoff?.reason}, handoff ${f.handoff?.handoff}`,
    ...(f.secondPress
      ? [`- Second press: ok ${String(f.secondPress.ok)}, reason ${f.secondPress.reason}`]
      : []),
    `- Drop ${ms(f.dropMs)}, gateway restarted ${ms(f.restartedMs)}, reconnect ${ms(f.reconnectMs)}, closes ${f.closes}, update.run.changed before the drop: ${f.changedBeforeDrop}`,
    `- update.runs.get UNAVAILABLE: ${window(f.unavailable)}`,
    `- Finished ${ms(f.terminalMs)}: ${f.run?.status} (${f.run?.reason ?? "no reason"}); first update.status after the drop: ${f.activeRunAfterDrop === null ? "none" : `active run phase ${f.activeRunAfterDrop.phase}`}`,
    `- Terminal update.run.changed after the reconnect: ${window(f.terminalRepeats)}`,
    ...(f.reopen
      ? [`- Reopened mid-run: same run active ${f.reopen.sameRun}, phase ${f.reopen.phase}`]
      : []),
    ...(f.busy
      ? [
          `- Turn in flight: ended ${f.busy.state ?? "unseen"} at ${ms(f.busy.endedMs)}, before the drop: ${String(f.busy.endedBeforeDrop)}`,
        ]
      : []),
    `- Requester sent ${JSON.stringify(f.requester?.sent ?? null)}, kept ${JSON.stringify(f.requester?.kept ?? null)}, trigger ${f.requester?.trigger}; found by its tag: ${JSON.stringify(f.foundByTag)}`,
    `- Delivered: notices ${JSON.stringify(f.delivery.notices.map((n) => `${n.step} ${n.status}`))}, noticeDelivered ${String(f.delivery.noticeDelivered)}, new sessions ${f.delivery.newSessions.length}, changed sessions ${f.delivery.changedSessions.length}, chat events elsewhere ${f.delivery.chatEventsElsewhere}, transcript messages about the update ${f.delivery.updateMessages.length}`,
    `- Longest quiet gap while running and connected: ${ms(f.longestQuietMs)}; "database is locked": ${f.databaseLocked}; tag in events: ${f.tagInEvents.length}; repairing phase: ${f.repairing}`,
    `- Answer times: ${Object.entries(f.latency)
      .map(([method, l]) => `${method} ${l.count}× median ${l.medianMs} ms, max ${l.maxMs} ms`)
      .join("; ")}`,
    "",
    "| After update.run | Phase | Status | Seen in |",
    "| --- | --- | --- | --- |",
    ...f.phases.map((p) => `| ${seconds(p.atMs)} | ${p.phase} | ${p.status} | ${p.from} |`),
  ];
  return `${lines.join("\n")}\n`;
}
