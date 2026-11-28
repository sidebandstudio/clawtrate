// A message the gateway couldn't run (#663) and the mark of a task's latest run (#664), with each
// OpenClaw version's frames as a development gateway sent them, names made up. On both 2026.10.6
// and 2026.11.10 the send is answered `started`; a message the gateway fails before any run of it
// starts then gets one `chat` error (`seq: 1`, no lifecycle `start`), and history keeps a
// "run-failed-before-reply" row for it. 2026.10.6 keeps the reason in that row and in the task's
// row (`status: "failed"`, `lastRunError`); 2026.11.10, failing it at dispatch, keeps neither.

import { describe, expect, it, vi } from "vitest";
import { ADMIN_SCOPES } from "../src/scopes.ts";
import { mapHistory, mergeSessionRow } from "../src/mapping.ts";
import {
  applyAgentEvent,
  applyChatEvent,
  applyQuestionRequested,
  emptyActivity,
  historyQueuePairs,
  mergeHistoryRuns,
  newRun,
  RawTable,
  runsFromHistory,
  type TaskActivity,
  type OutgoingMessage,
} from "../src/runs.ts";
import {
  neverRan,
  neverStarted,
  notRunCause,
  repeatedNotRun,
  NotRunFiles,
  MAX_NOT_RUN_WORDS,
  MAX_NOT_RUN_FILE_BYTES,
  MAX_NOT_RUN_FILE_MESSAGES,
} from "../src/not-run.ts";
import { fromActivity, WaitingIndex } from "../src/waiting.ts";
import {
  agentEvent,
  grantingGateway,
  KEY,
  openTask,
  questionRecord,
  stampOn,
  URL_A,
} from "./client-harness.ts";
import {
  sleep,
  until,
  GatewayError,
  memoryStorage,
  tokenKey,
  type FakeGateway,
} from "./fake-gateway.ts";

const OTHER = "agent:otto:weekly-report";
const T0 = 1_795_000_000_000;

type Row = Record<string, unknown>;

/** A gateway that names a run by the send's own key, as OpenClaw does. */
function gatewayWith(rows: Row[]): FakeGateway {
  const gateway = grantingGateway();
  gateway.handlers["agents.list"] = () => ({
    defaultId: "otto",
    agents: [{ id: "otto", identity: { name: "Otto" } }],
  });
  gateway.handlers["sessions.subscribe"] = () => ({
    subscribed: true,
    list: { sessions: rows, hasMore: false },
  });
  gateway.handlers["sessions.list"] = () => ({ sessions: rows, hasMore: false });
  gateway.handlers["chat.send"] = (params) => ({
    runId: (params as { idempotencyKey: string }).idempotencyKey,
    status: "started",
  });
  return gateway;
}

const task = (
  client: { state: { tasksByBot: Record<string, Array<{ key: string; status: string }>> } },
  key = KEY,
) => client.state.tasksByBot.otto?.find((each) => each.key === key);

/** A `sessions.changed` as both versions send it: the flat fields, and the row under `session`. */
function changed(gateway: FakeGateway, reason: string | null, session: Row, key = KEY): void {
  gateway.emit("sessions.changed", {
    sessionKey: key,
    agentId: "otto",
    ...(reason ? { reason } : {}),
    ...session,
    session: { key, agentId: "otto", ...session },
  });
}

const userRow = (runId: string, text = "hello") => ({
  role: "user",
  content: text,
  timestamp: T0,
  idempotencyKey: `${runId}:user`,
  __openclaw: { id: `u-${runId}`, seq: 1, idempotencyKey: `${runId}:user` },
});

describe("why the gateway couldn't run a message, from its own words", () => {
  it("names the kind of account a model needs, from the text both versions throw", () => {
    // `assertAuthModeAllowedForModel` (both versions), with a provider's own policy reason.
    const said =
      'Auth profile "acme:default" uses oauth auth, but acme/acme-responses requires an Acme API key profile.';
    expect(notRunCause(said)).toEqual({ kind: "needs-api-key", words: null });
    expect(notRunCause(`Error: ${said}`)?.kind).toBe("needs-api-key");
    expect(
      notRunCause(
        'Auth profile "acme:work" uses api-key auth, but acme/acme-chat-responses requires a Acme subscription (OAuth or token) profile.',
      )?.kind,
    ).toBe("needs-sign-in");
    // A provider's own word for a sign-in where the model needs a key: the same text on both
    // versions (OpenAI's provider plugin, beside "No API key found for provider").
    expect(
      notRunCause(
        'No API key found for provider "acme". You are authenticated with Acme ChatGPT/Codex OAuth. Use acme/acme-codex with the ChatGPT/Codex OAuth profile, or set ACME_API_KEY for direct Acme API access.',
      ),
    ).toEqual({ kind: "needs-api-key", words: null });
  });

  it("any other account-kind reason is the gateway's own, with its own remedy: its words, never ours", () => {
    // The policy's other reasons (both versions): a consent to give, an operation a sign-in can't do.
    const consent =
      'Auth profile "acme:me" uses oauth auth, but acme/acme-responses requires token-sharing consent. Sign in again and enable sharing, or explicitly choose another inference credential.';
    expect(notRunCause(consent)).toEqual({
      kind: "other",
      words:
        'Auth profile "acme:me" uses oauth auth, but acme/acme-responses requires token-sharing consent. Sign in again and enable sharing, or explicitly choose another inference credential.',
    });
    expect(
      notRunCause(
        'Auth profile "acme:me" uses oauth auth, but acme/embedding does not support this operation with Sign in with ChatGPT. Configure a credential that supports it.',
      )?.kind,
    ).toBe("other");
    // A requirement with more said after it is read as the gateway's, not as ours.
    expect(
      notRunCause(
        'Auth profile "acme:me" uses oauth auth, but acme/acme-responses requires an Acme API key profile, or explicitly choose another inference credential.',
      )?.kind,
    ).toBe("other");
    // A subscription token is not a sign-in: the requirement holds, our sentence wouldn't.
    expect(
      notRunCause(
        'Auth profile "acme:team" uses token auth, but acme/acme-responses requires an Acme API key profile.',
      )?.kind,
    ).toBe("other");
  });

  it("knows each other failure a message takes before any run, on either version", () => {
    // The gateway's rewrite of `selected_auth_profile_unavailable`, 2026.10.6 then 2026.11.10.
    for (const said of [
      "This saved login isn't available. Choose another login under Models in the Control UI or run `openclaw configure`.",
      "This saved login isn't available. Choose another login under Models in the OpenClaw app or run `openclaw configure`.",
      'FailoverError: Selected auth profile "acme:nosuch" is unavailable.',
      'No credentials found for profile "acme:gone".',
    ])
      expect(notRunCause(said)?.kind).toBe("account-missing");
    expect(notRunCause('Error: Auth profile "acme:work" is not configured for globex.')?.kind).toBe(
      "account-other-provider",
    );
    for (const said of [
      "Unknown model: nope/dev-1. Run `openclaw models list --refresh --provider nope` to inspect this provider's model choices, then retry with a model supported by your account.",
      "⚠️ This model was not found. Choose another model in the OpenClaw app or run `openclaw configure`.",
      "Your request couldn't be completed: ⚠️ This model was not found. Choose another model in the Control UI or run `openclaw configure`.",
    ])
      expect(notRunCause(said)?.kind).toBe("model-unknown");
    // Its words carry the gateway's store path: they are never shown, the kind is.
    expect(
      notRunCause(
        'No API key found for provider "globex". Auth store: /var/lib/gateway/agents/otto/auth.json.',
      ),
    ).toEqual({ kind: "no-account", words: null });
  });

  it("shows anything else in the gateway's words, one line, cut; and says when it kept none", () => {
    expect(notRunCause("Error: The‮ session\n\nis   locked.")).toEqual({
      kind: "other",
      words: "The session is locked.",
    });
    expect(notRunCause(`Error: ${"x".repeat(900)}`)?.words).toHaveLength(MAX_NOT_RUN_WORDS);
    // 2026.11.10's row for a message failed at dispatch.
    expect(notRunCause("Your request couldn't be completed.")).toEqual({
      kind: "unsaid",
      words: null,
    });
    expect(notRunCause("")).toBeNull();
    expect(notRunCause(null)).toBeNull();
  });
});

describe("a message the gateway fails before any run of it (#663)", () => {
  for (const version of [
    {
      name: "2026.10.6",
      said: 'Error: Auth profile "acme:work" is not configured for globex.',
      // What history and the task's row keep afterwards.
      stored: {
        content:
          'Your request couldn\'t be completed: Error: Auth profile "acme:work" is not configured for globex.',
      },
      failedRow: {
        status: "failed",
        lastRunError: 'Error: Auth profile "acme:work" is not configured for globex.',
        hasActiveRun: false,
      },
      kind: "account-other-provider",
      afterReload: "account-other-provider",
    },
    {
      name: "2026.11.10",
      said: "This saved login isn't available. Choose another login under Models in the OpenClaw app or run `openclaw configure`.",
      stored: {
        content: "Your request couldn't be completed.",
        openclawRunError: { summary: "Your request couldn't be completed." },
      },
      failedRow: { hasActiveRun: false, abortedLastRun: false },
      kind: "account-missing",
      afterReload: "unsaid",
    },
  ] as const) {
    it(`fails the message's run with the gateway's reason, and keeps it after a reload (${version.name})`, async () => {
      const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 - 60_000 }]);
      const { client, transcript } = await openTask({ gateway });
      const id = client.sendMessage(KEY, "hello");
      await until(() => transcript().runs[0]?.bound === true);
      changed(gateway, "participants", {
        status: version.name === "2026.10.6" ? "running" : "queued",
        hasActiveRun: true,
        updatedAt: T0,
      });
      gateway.emit("chat", {
        runId: id,
        sessionKey: KEY,
        seq: 1,
        state: "error",
        errorMessage: version.said,
      });
      changed(gateway, "chat.dispatch-error", { ...version.failedRow, updatedAt: T0 });
      await until(() => transcript().runs[0]?.state === "failed");
      const run = transcript().runs[0]!;
      expect(neverRan(run)).toBe(true);
      expect(notRunCause(run.error?.message)?.kind).toBe(version.kind);
      // The bot's row says its latest run failed, whatever the row kept of it.
      await until(() => task(client)?.status === "failed");

      // Opened again: history rebuilds the run from the gateway's row for it.
      gateway.handlers["chat.history"] = () => ({
        messages: [
          userRow(id),
          {
            role: "custom",
            customType: "run-failed-before-reply",
            display: true,
            timestamp: T0 + 400,
            ...version.stored,
            ...("openclawRunError" in version.stored
              ? { openclawRunError: { runId: id, ...version.stored.openclawRunError } }
              : {}),
            __openclaw: { id: "c-1", seq: 2, runId: id },
          },
        ],
        hasMore: false,
      });
      // Another device opens the task, or this one after a restart: only history to go by.
      const other = await openTask({ gateway });
      await until(() => other.transcript().runs.length === 1);
      const rebuilt = other.transcript().runs[0]!;
      expect(rebuilt.origin).toBe("history");
      expect(rebuilt).toMatchObject({ id, state: "failed", outcomeKnown: true });
      expect(rebuilt.error?.beforeReply).toBe(true);
      expect(neverRan(rebuilt)).toBe(true);
      expect(notRunCause(rebuilt.error?.message)?.kind).toBe(version.afterReload);
      // Its task is marked by its runs there too.
      await until(() => task(other.client)?.status === "failed");
      other.client.stop();
      client.stop();
    });
  }

  it("says the gateway started no run when it accepted the message and then said nothing", async () => {
    const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 - 60_000 }]);
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "hello");
    await until(() => transcript().runs[0]?.bound === true);
    // History holds the message and no row of a run, with nothing in flight: the gateway's word.
    gateway.handlers["chat.history"] = () => ({ messages: [userRow(id)], hasMore: false });
    gateway.emit("session.message", { sessionKey: KEY, messageSeq: 1 });
    await until(() => transcript().runs[0]?.state === "completed");
    expect(neverStarted(transcript().runs[0]!)).toBe(true);
    client.stop();
  });
});

describe("never under a message that was answered", () => {
  /** A reply of the run in history, as the gateway writes one, with no stop reason of its own. */
  const replyRow = (runId: string) => ({
    role: "assistant",
    content: [{ type: "text", text: "Here it is." }],
    timestamp: T0 + 500,
    __openclaw: { id: `a-${runId}`, seq: 2, runId },
  });

  it("a reply whose events this client missed: the run ran, so no 'didn't start a run' line", async () => {
    const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 - 60_000 }]);
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "hello");
    await until(() => transcript().runs[0]?.bound === true);
    // No event of the run reached this client; history has its reply, with nothing in flight.
    gateway.handlers["chat.history"] = () => ({
      messages: [userRow(id), replyRow(id)],
      hasMore: false,
    });
    gateway.emit("session.message", { sessionKey: KEY, messageSeq: 2 });
    await until(() => transcript().runs[0]?.state === "completed");
    const run = transcript().runs[0]!;
    expect(run).toMatchObject({ origin: "local", reportedStartAt: null, text: "" });
    expect(run.ranInHistory).toBe(true);
    expect(neverStarted(run)).toBe(false);
    client.stop();
  });

  it("a failure with no start seen, whose run history shows replied: not one the gateway couldn't run", async () => {
    const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 - 60_000 }]);
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "hello");
    await until(() => transcript().runs[0]?.bound === true);
    gateway.emit("chat", {
      runId: id,
      sessionKey: KEY,
      seq: 9,
      state: "error",
      errorMessage: "boom",
    });
    await until(() => transcript().runs[0]?.state === "failed");
    expect(neverRan(transcript().runs[0]!)).toBe(true);
    gateway.handlers["chat.history"] = () => ({
      messages: [userRow(id), replyRow(id)],
      hasMore: false,
    });
    gateway.emit("session.message", { sessionKey: KEY, messageSeq: 2 });
    await until(() => transcript().runs[0]?.ranInHistory === true);
    expect(neverRan(transcript().runs[0]!)).toBe(false);
    client.stop();
  });
});

describe("a task's mark is its latest run's outcome (#664)", () => {
  it("2026.10.6: a later success clears the failed mark at once, by the live rows alone", async () => {
    const gateway = gatewayWith([
      {
        key: KEY,
        agentId: "otto",
        status: "failed",
        lastRunError: "⚠️ This model was not found.",
        hasActiveRun: false,
        updatedAt: T0,
      },
      {
        key: OTHER,
        agentId: "otto",
        status: "failed",
        lastRunError: "⚠️ This model was not found.",
        hasActiveRun: false,
        updatedAt: T0,
      },
    ]);
    const { client } = await openTask({ gateway });
    await until(() => task(client)?.status === "failed");
    // The rows of the next run, as 2026.10.6 sends them: the `session` row keeps `lastRunError`
    // while the run starts, and leaves it out from then on.
    changed(gateway, "send", {
      status: "running",
      hasActiveRun: true,
      lastRunError: "⚠️ This model was not found.",
      updatedAt: T0 + 9_000,
    });
    changed(gateway, "agent.run.started", {
      status: "running",
      hasActiveRun: true,
      updatedAt: T0 + 9_500,
    });
    gateway.emit("agent", {
      ...agentEvent("run-2", 1, "lifecycle", { phase: "start", startedAt: T0 + 9_600 }),
      ts: T0 + 9_600,
    });
    gateway.emit("chat", {
      runId: "run-2",
      sessionKey: KEY,
      seq: 2,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Hi." }] },
    });
    changed(gateway, "agent.input.settled", {
      status: "done",
      hasActiveRun: false,
      lastRunId: "run-2",
      startedAt: T0 + 9_600,
      updatedAt: T0 + 10_000,
    });
    await until(() => task(client)?.status === "done");
    // The bot's other task's latest run failed, and its mark stays.
    expect(task(client, OTHER)?.status).toBe("failed");
    await sleep(50);
    expect(task(client)?.status).toBe("done");
    client.stop();
  });

  it("2026.11.10: a message failed at dispatch marks the task until a later run, live or listed", async () => {
    const rows: Row[] = [
      {
        key: KEY,
        agentId: "otto",
        status: "done",
        hasActiveRun: false,
        lastRunId: "run-0",
        startedAt: T0 - 90_000,
        updatedAt: T0 - 60_000,
      },
      { key: OTHER, agentId: "otto", status: "done", hasActiveRun: false, updatedAt: T0 - 60_000 },
    ];
    const gateway = gatewayWith(rows);
    const { client } = await openTask({ gateway, key: "agent:otto:elsewhere" });
    changed(gateway, "participants", { status: "queued", hasActiveRun: true, updatedAt: T0 });
    gateway.emit("chat", {
      runId: "run-1",
      sessionKey: KEY,
      seq: 1,
      state: "error",
      errorMessage: 'Error: Auth profile "acme:work" is not configured for globex.',
    });
    changed(gateway, "chat.dispatch-error", {
      hasActiveRun: false,
      abortedLastRun: false,
      updatedAt: T0,
    });
    changed(gateway, "agent.input.settled", {
      hasActiveRun: false,
      abortedLastRun: false,
      updatedAt: T0,
    });
    // The row says nothing failed; the `chat` error did. The earlier run's id is still the row's.
    await until(() => task(client)?.status === "failed");
    expect(task(client, OTHER)?.status).toBe("done");

    // A list read alone, after a later run elsewhere succeeded: the row names a run started since.
    rows[0] = {
      ...rows[0],
      status: "done",
      lastRunId: "run-2",
      startedAt: T0 + 9_000,
      updatedAt: T0 + 10_000,
    };
    gateway.dropAll();
    await until(
      () => client.state.connection.status === "connected" && task(client)?.status === "done",
    );
    client.stop();
  });

  it("2026.11.10: the next run's own start and end clear the mark, before any row says so", async () => {
    const gateway = gatewayWith([
      { key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 },
    ]);
    const { client } = await openTask({ gateway, key: "agent:otto:elsewhere" });
    gateway.emit("chat", {
      runId: "run-1",
      sessionKey: KEY,
      seq: 1,
      state: "error",
      errorMessage: "Your request couldn't be completed.",
    });
    await until(() => task(client)?.status === "failed");
    gateway.emit("agent", {
      ...agentEvent("run-2", 1, "lifecycle", { phase: "start" }),
      ts: T0 + 9_000,
    });
    await until(() => task(client)?.status !== "failed");
    client.stop();
  });
});

describe("an end the gateway marks not to show is no failure (#680)", () => {
  // 2026.11.10 ends a turn it started itself, which the bot answered quietly, with this error,
  // marked `suppressErrorNotice`; 2026.10.6 sends no such mark. How such an end is drawn, and when
  // it is a failure after all, is `quiet-end.test.ts`.
  const QUIET = "No answer was returned. Ask again if you still need one.";

  it("its chat error neither fails the message as one the gateway couldn't run nor marks the task", async () => {
    const gateway = gatewayWith([
      { key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 },
    ]);
    const { client, transcript } = await openTask({ gateway });
    // A turn the gateway started, as 2026.11.10 sends it, then its end marked not to show.
    gateway.emit("agent", {
      ...agentEvent("wake-1", 1, "lifecycle", { phase: "start" }),
      ts: T0 + 1,
    });
    gateway.emit("chat", {
      runId: "wake-1",
      sessionKey: KEY,
      seq: 2,
      state: "error",
      errorMessage: QUIET,
      suppressErrorNotice: true,
    });
    await until(() =>
      transcript().runs.some((run) => run.id === "wake-1" && run.quietEnd === "settled"),
    );
    const run = transcript().runs.find((each) => each.id === "wake-1")!;
    expect(run.state).toBe("completed");
    expect(neverRan(run)).toBe(false);
    // Failed after all (its history said it answered nothing), the mark keeps it from being one the
    // gateway couldn't run, even with no start of its own seen.
    const failed = {
      ...run,
      state: "failed" as const,
      error: { message: QUIET, kind: null, quiet: true as const },
    };
    expect(neverRan(failed)).toBe(false);
    expect(neverRan({ ...failed, reportedStartAt: null })).toBe(false);
    await sleep(50);
    expect(task(client)?.status).not.toBe("failed");
    client.stop();
  });

  it("the index: the marked error is a quiet end, the same error unmarked (2026.10.6's form) a failure", () => {
    const index = new WaitingIndex();
    const frame = { sessionKey: KEY, runId: "r1", state: "error", errorMessage: QUIET };
    expect(index.onChat({ ...frame, suppressErrorNotice: true }, 1_000)).toBe(true);
    expect(index.failedAt(KEY)).toBeNull();
    // The next message admitted (its row), then its error.
    index.noteInput(KEY);
    index.onChat({ ...frame, runId: "r2" }, 2_000);
    expect(index.failedAt(KEY)).toBe(2_000);
  });

  it("history's hidden row for such an end does not fail its run", () => {
    const rows = [
      userRow("run-1"),
      {
        role: "custom",
        customType: "run-failed-before-reply",
        content: QUIET,
        display: false,
        timestamp: T0 + 400,
        __openclaw: { id: "c-1", seq: 2, runId: "run-1" },
      },
    ];
    const [run] = runsFromHistory(rows, null, {
      sessionKey: KEY,
      now: T0 + 500,
      raw: new RawTable(),
    });
    expect(run?.state).not.toBe("failed");
    expect(run?.error ?? null).toBeNull();
  });
});

describe("the rules underneath", () => {
  it("history's row for a message the gateway couldn't run ends its run, even while it is busy", () => {
    const rows = [
      userRow("run-1"),
      {
        role: "custom",
        customType: "run-failed-before-reply",
        content: "Your request couldn't be completed: ⚠️ This model was not found.",
        timestamp: T0 + 400,
        __openclaw: { id: "c-1", seq: 2, runId: "run-1" },
      },
      { ...userRow("run-2", "again"), __openclaw: { id: "u-2", seq: 3 } },
    ];
    // Another message of the task is in flight, queued behind nothing yet.
    const [run] = runsFromHistory(
      rows,
      null,
      { sessionKey: KEY, now: T0 + 500, raw: new RawTable() },
      {
        busy: true,
      },
    );
    expect(run).toMatchObject({ id: "run-1", state: "failed", outcomeKnown: true });
    expect(run!.error).toMatchObject({
      message: "Your request couldn't be completed: ⚠️ This model was not found.",
      beforeReply: true,
    });
  });

  it("history's row for a message the gateway couldn't run, with no words, keeps no reason", () => {
    const rows = [
      userRow("run-1"),
      {
        role: "custom",
        customType: "run-failed-before-reply",
        timestamp: T0 + 400,
        __openclaw: { id: "c-1", seq: 2, runId: "run-1" },
      },
    ];
    const [run] = runsFromHistory(rows, null, {
      sessionKey: KEY,
      now: T0 + 500,
      raw: new RawTable(),
    });
    expect(run).toMatchObject({ id: "run-1", state: "failed" });
    expect(run!.error).toMatchObject({ message: "", beforeReply: true });
    expect(notRunCause(run!.error?.message)).toBeNull();
  });

  it("a streaming delta doesn't scan the task list; a run's end does", async () => {
    const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 }]);
    const { client } = await openTask({ gateway });
    const scan = vi.spyOn(client as unknown as { keptKeys: () => Set<string> }, "keptKeys");
    // The fake gateway's events are handled as they are emitted, so each check follows its event.
    gateway.emit("chat", { runId: "r1", sessionKey: KEY, seq: 1, state: "delta" });
    expect(scan).not.toHaveBeenCalled();
    gateway.emit("chat", { runId: "r1", sessionKey: KEY, seq: 2, state: "final" });
    expect(scan).toHaveBeenCalled();
    client.stop();
  });

  it("a run history rebuilt that failed after it started is not one the gateway couldn't run", () => {
    const rows = [
      userRow("run-1"),
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "401 Invalid API key",
        timestamp: T0 + 400,
        __openclaw: { id: "a-1", seq: 2, runId: "run-1" },
      },
    ];
    const [run] = runsFromHistory(rows, null, {
      sessionKey: KEY,
      now: T0 + 500,
      raw: new RawTable(),
    });
    expect(run).toMatchObject({ id: "run-1", state: "failed" });
    expect(neverRan(run!)).toBe(false);
  });

  it("a row that reports the run state leaves out what is unset (both versions' session rows)", () => {
    const failed = {
      key: KEY,
      status: "failed",
      lastRunError: "boom",
      hasActiveRun: false,
      label: "A",
    };
    expect(mergeSessionRow(failed, { status: "done", hasActiveRun: false })).toEqual({
      key: KEY,
      status: "done",
      hasActiveRun: false,
      label: "A",
    });
    // 2026.11.10 after a message failed at dispatch: no status at all.
    expect(
      mergeSessionRow({ key: KEY, status: "queued", hasActiveRun: true }, { hasActiveRun: false }),
    ).toEqual({
      key: KEY,
      hasActiveRun: false,
    });
    // A row that says nothing of runs changes nothing of them.
    expect(mergeSessionRow(failed, { label: "B" })).toEqual({ ...failed, label: "B" });
  });

  it("a failure is the latest until a run the gateway reports started after it", () => {
    const index = new WaitingIndex();
    expect(index.onChat({ sessionKey: KEY, runId: "r1", state: "error" }, 1_000)).toBe(true);
    expect(index.failedAt(KEY)).toBe(1_000);
    expect(index.settleFailure(KEY, 900)).toBe(false);
    expect(index.settleFailure(KEY, 1_000)).toBe(false);
    expect(index.failedAt(KEY)).toBe(1_000);
    expect(index.settleFailure(KEY, 1_001)).toBe(true);
    expect(index.failedAt(KEY)).toBeNull();
    index.onChat({ sessionKey: KEY, runId: "r2", state: "error" }, 2_000);
    index.onChat({ sessionKey: KEY, runId: "r3", state: "final" }, 3_000);
    expect(index.failedAt(KEY)).toBeNull();
    index.noteInput(KEY);
    index.onChat({ sessionKey: KEY, runId: "r4", state: "error" }, 4_000);
    // The same run's lifecycle end, after its error, keeps it failed.
    index.onAgent(
      { sessionKey: KEY, runId: "r4", stream: "lifecycle", ts: 4_001, data: { phase: "error" } },
      4_001,
    );
    expect(index.failedAt(KEY)).not.toBeNull();
    expect(index.failedAt(OTHER)).toBeNull();
  });

  it("a run's own chat end ends it, so a later message failed before running still marks the task", () => {
    const index = new WaitingIndex();
    index.onAgent(
      { sessionKey: KEY, runId: "r1", stream: "lifecycle", ts: 1_000, data: { phase: "start" } },
      1_000,
    );
    // Its final, and no lifecycle end ever arrives.
    index.onChat({ sessionKey: KEY, runId: "r1", state: "final" }, 1_500);
    index.noteInput(KEY);
    expect(index.onChat({ sessionKey: KEY, runId: "r2", state: "error" }, 2_000)).toBe(true);
    expect(index.failedAt(KEY)).toBe(2_000);
  });

  it("a run stopped elsewhere ends at its chat abort, so a later message failed before running still marks the task (#722)", () => {
    const index = new WaitingIndex();
    index.onAgent(
      { sessionKey: KEY, runId: "r1", stream: "lifecycle", ts: 1_000, data: { phase: "start" } },
      1_000,
    );
    // Its abort, and no lifecycle end ever arrives.
    index.onChat({ sessionKey: KEY, runId: "r1", state: "aborted" }, 1_500);
    index.noteInput(KEY);
    expect(index.onChat({ sessionKey: KEY, runId: "r2", state: "error" }, 2_000)).toBe(true);
    expect(index.failedAt(KEY)).toBe(2_000);
  });

  for (const state of ["final", "aborted", "error"])
    it(`an older run's late chat ${state} doesn't clear a newer run's failure`, () => {
      const index = new WaitingIndex();
      for (const [runId, ts] of [
        ["r1", 1_000],
        ["r2", 1_500],
      ] as const)
        index.onAgent(
          { sessionKey: KEY, runId, stream: "lifecycle", ts, data: { phase: "start" } },
          ts,
        );
      index.onChat({ sessionKey: KEY, runId: "r2", state: "error" }, 2_000);
      expect(index.onChat({ sessionKey: KEY, runId: "r1", state }, 3_000)).toBe(false);
      expect(index.failedAt(KEY)).toBe(1_500);
    });

  for (const quiet of [false, true])
    it(`a queued run's ${quiet ? "quiet" : "failed"} end after the run before it failed decides the mark`, () => {
      const index = new WaitingIndex();
      index.onAgent(
        { sessionKey: KEY, runId: "r1", stream: "lifecycle", ts: 1_000, data: { phase: "start" } },
        1_000,
      );
      // r2 is admitted while r1 runs, then r1 fails.
      index.noteInput(KEY);
      index.onChat({ sessionKey: KEY, runId: "r1", state: "error" }, 2_000);
      expect(
        index.onChat(
          {
            sessionKey: KEY,
            runId: "r2",
            state: "error",
            ...(quiet ? { suppressErrorNotice: true } : {}),
          },
          3_000,
        ),
      ).toBe(true);
      expect(index.latestRunId(KEY)).toBe("r2");
      expect(index.failedAt(KEY)).toBe(quiet ? null : 3_000);
    });

  it("a start sent again for a run a later start replaced says nothing", () => {
    const index = new WaitingIndex();
    for (const [runId, ts] of [
      ["r1", 1_000],
      ["r2", 1_500],
      ["r1", 1_000],
    ] as const)
      index.onAgent(
        { sessionKey: KEY, runId, stream: "lifecycle", ts, data: { phase: "start" } },
        ts,
      );
    expect(index.latestRunId(KEY)).toBe("r2");
    expect(index.onChat({ sessionKey: KEY, runId: "r2", state: "error" }, 2_000)).toBe(true);
    expect(index.failedAt(KEY)).toBe(1_500);
  });

  it("after a start sent again for a replaced run, the newer run's final ends it and the next failure marks the task", () => {
    const index = new WaitingIndex();
    for (const [runId, ts] of [
      ["r1", 1_000],
      ["r2", 1_500],
      ["r1", 1_000],
    ] as const)
      index.onAgent(
        { sessionKey: KEY, runId, stream: "lifecycle", ts, data: { phase: "start" } },
        ts,
      );
    index.onChat({ sessionKey: KEY, runId: "r2", state: "final" }, 2_000);
    expect(index.latestRunId(KEY)).toBe("r2");
    // r2 is no longer going: a message admitted after it, failed at dispatch, marks the task.
    index.noteInput(KEY);
    expect(index.onChat({ sessionKey: KEY, runId: "r3", state: "error" }, 3_000)).toBe(true);
    expect(index.failedAt(KEY)).toBe(3_000);
  });

  it("a new message stopped before its run starts clears an earlier failure's mark (#783)", () => {
    const index = new WaitingIndex();
    index.onChat({ sessionKey: KEY, runId: "r1", state: "error" }, 1_000);
    expect(index.failedAt(KEY)).toBe(1_000);
    // The next message is admitted, then stopped before its run starts: its row brings no start.
    index.noteInput(KEY);
    index.onChat({ sessionKey: KEY, runId: "r2", state: "aborted" }, 1_500);
    expect(index.failedAt(KEY)).toBeNull();
  });

  it("a run's chat abort after its own chat error keeps the task marked failed (#783)", () => {
    const index = new WaitingIndex();
    index.onChat({ sessionKey: KEY, runId: "r1", state: "error" }, 1_000);
    expect(index.onChat({ sessionKey: KEY, runId: "r1", state: "aborted" }, 1_500)).toBe(false);
    expect(index.failedAt(KEY)).toBe(1_000);
  });

  it("an older run's late chat end says nothing while a newer run of the task is going", () => {
    const index = new WaitingIndex();
    index.onAgent(
      { sessionKey: KEY, runId: "r2", stream: "lifecycle", ts: 2_000, data: { phase: "start" } },
      2_000,
    );
    expect(index.onChat({ sessionKey: KEY, runId: "r1", state: "error" }, 2_100)).toBe(false);
    expect(index.failedAt(KEY)).toBeNull();
    // Its own end then speaks for the task.
    index.onAgent(
      { sessionKey: KEY, runId: "r2", stream: "lifecycle", ts: 3_000, data: { phase: "end" } },
      3_000,
    );
    expect(index.failedAt(KEY)).toBeNull();
    // A new message admitted, then failed before running: the task's latest outcome.
    index.noteInput(KEY);
    expect(index.onChat({ sessionKey: KEY, runId: "r3", state: "error" }, 4_000)).toBe(true);
    expect(index.failedAt(KEY)).toBe(4_000);
  });
});

describe("#686: the mark is the newest run's, never the latest-written failure's", () => {
  it("(b) events only: A's error arriving after B ended well marks nothing; a new message's does", () => {
    const index = new WaitingIndex();
    // A and B admitted; B runs and ends well; then A's error arrives late.
    index.noteInput(KEY);
    index.onAgent(
      { sessionKey: KEY, runId: "b", stream: "lifecycle", ts: 2_000, data: { phase: "start" } },
      2_000,
    );
    index.onChat({ sessionKey: KEY, runId: "b", state: "final" }, 3_000);
    expect(index.onChat({ sessionKey: KEY, runId: "a", state: "error" }, 3_100)).toBe(false);
    expect(index.failedAt(KEY)).toBeNull();
    // C admitted after B (the gateway's row says so first), then failed at dispatch: it marks.
    index.noteInput(KEY);
    expect(index.onChat({ sessionKey: KEY, runId: "c", state: "error" }, 4_000)).toBe(true);
    expect(index.failedAt(KEY)).toBe(4_000);
  });

  it("(b) through the client: rows as both versions send them", async () => {
    const gateway = gatewayWith([
      { key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 },
    ]);
    const { client } = await openTask({ gateway, key: "agent:otto:elsewhere" });
    // B's run, seen from start to final, then its done row.
    gateway.emit("agent", {
      ...agentEvent("b", 1, "lifecycle", { phase: "start" }),
      ts: T0 + 2_000,
    });
    gateway.emit("chat", { runId: "b", sessionKey: KEY, seq: 2, state: "final" });
    changed(gateway, "agent.input.settled", {
      status: "done",
      hasActiveRun: false,
      lastRunId: "b",
      startedAt: T0 + 2_000,
      updatedAt: T0 + 3_000,
    });
    await until(() => task(client)?.status === "done");
    // A's late dispatch error: no new input since B.
    gateway.emit("chat", {
      runId: "a",
      sessionKey: KEY,
      seq: 1,
      state: "error",
      errorMessage: "boom",
    });
    await sleep(50);
    expect(task(client)?.status).toBe("done");
    // C: admitted (its row), then failed at dispatch.
    changed(gateway, "participants", {
      status: "queued",
      hasActiveRun: true,
      updatedAt: T0 + 9_000,
    });
    gateway.emit("chat", {
      runId: "c",
      sessionKey: KEY,
      seq: 1,
      state: "error",
      errorMessage: "boom",
    });
    changed(gateway, "chat.dispatch-error", { hasActiveRun: false, updatedAt: T0 + 9_000 });
    await until(() => task(client)?.status === "failed");
    client.stop();
  });

  it("2026.11.10 through the client: a second message failed before the row that admits it marks the task by its own run", async () => {
    const gateway = gatewayWith([
      { key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 },
    ]);
    const { client } = await openTask({ gateway, key: "agent:otto:elsewhere" });
    const waiting = (client as unknown as { waiting: WaitingIndex }).waiting;
    // A: admitted, failed at dispatch, then its row.
    changed(gateway, "participants", {
      status: "queued",
      hasActiveRun: true,
      updatedAt: T0 + 1_000,
    });
    gateway.emit("chat", {
      runId: "a",
      sessionKey: KEY,
      seq: 1,
      state: "error",
      errorMessage: "boom",
    });
    changed(gateway, "chat.dispatch-error", { hasActiveRun: false, updatedAt: T0 + 2_000 });
    await until(() => task(client)?.status === "failed");
    // B fails at dispatch before the row that admits it, which the gateway sends later.
    gateway.emit("chat", {
      runId: "b",
      sessionKey: KEY,
      seq: 1,
      state: "error",
      errorMessage: "boom",
    });
    expect(waiting.latestRunId(KEY)).toBe("b");
    expect(waiting.failedAt(KEY)).toBe(T0 + 2_000);
    client.stop();
  });

  it("#722 through the client: a run stopped elsewhere ends at its chat abort, so the next message's failure marks the task", async () => {
    const gateway = gatewayWith([
      { key: KEY, agentId: "otto", hasActiveRun: false, updatedAt: T0 },
    ]);
    const { client } = await openTask({ gateway, key: "agent:otto:elsewhere" });
    gateway.emit("agent", {
      ...agentEvent("a", 1, "lifecycle", { phase: "start" }),
      ts: T0 + 1_000,
    });
    // Stopped elsewhere: its abort comes, its lifecycle end never does.
    gateway.emit("chat", { runId: "a", sessionKey: KEY, seq: 2, state: "aborted" });
    // B: admitted, then failed at dispatch.
    changed(gateway, "participants", {
      status: "queued",
      hasActiveRun: true,
      updatedAt: T0 + 9_000,
    });
    gateway.emit("chat", {
      runId: "b",
      sessionKey: KEY,
      seq: 1,
      state: "error",
      errorMessage: "boom",
    });
    changed(gateway, "chat.dispatch-error", { hasActiveRun: false, updatedAt: T0 + 9_000 });
    await until(() => task(client)?.status === "failed");
    client.stop();
  });

  it("a failure marker never pairs with the send before it by place; a queued turn's reply still does", () => {
    const markerAfterB = [
      userRow("a"),
      { ...userRow("b", "and this"), __openclaw: { id: "u-b", seq: 2, idempotencyKey: "b:user" } },
      // A's queued turn ran under an id of its own (2026.10.6), and failed before replying.
      {
        role: "custom",
        customType: "run-failed-before-reply",
        content: "Your request couldn't be completed.",
        display: true,
        timestamp: T0 + 900,
        __openclaw: { id: "c-a", seq: 3, runId: "gateway-a" },
      },
    ];
    expect(historyQueuePairs(markerAfterB)).toEqual([]);
    // Nor an assistant row that ends in an error.
    expect(
      historyQueuePairs([
        markerAfterB[0],
        markerAfterB[1],
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "boom",
          __openclaw: { id: "e-a", seq: 3, runId: "gateway-a" },
        },
      ]),
    ).toEqual([]);
    // A queued turn's reply under its own id still pairs with its send.
    expect(
      historyQueuePairs([
        markerAfterB[1],
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stopReason: "stop",
          __openclaw: { id: "r-b", seq: 3, runId: "gateway-b" },
        },
      ]),
    ).toEqual([["gateway-b", "b"]]);
  });

  it("an earlier message answered, or a steer, still lets a later queued turn pair with its send", () => {
    const row = (runId: string, id: string) => ({
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      stopReason: "stop",
      __openclaw: { id, runId },
    });
    const keyed = (runId: string) => ({
      role: "user",
      content: runId,
      __openclaw: { id: `u-${runId}`, idempotencyKey: `${runId}:user` },
    });
    const queued = [keyed("c"), row("gateway-c", "r-c")];
    // A message from a channel (no key), answered.
    const channel = { role: "user", content: "hi", __openclaw: { id: "u-ch" } };
    expect(historyQueuePairs([channel, row("ch-run", "r-ch"), ...queued])).toEqual([
      ["gateway-c", "c"],
    ]);
    // A steer into a run that goes on: its row sits among that run's rows.
    const steered = [keyed("base"), row("base", "r-1"), keyed("steer"), row("base", "r-2")];
    expect(historyQueuePairs([...steered, ...queued])).toEqual([["gateway-c", "c"]]);
  });

  it("the merge keeps history's word that a live failure never ran; a later reply row overrides it", () => {
    const ctx = { sessionKey: KEY, now: T0 + 1_000, raw: new RawTable() };
    // Live: the run failed with the gateway's words, nothing seen of a start.
    const live = [
      {
        ...newRun("run-a", { state: "running", origin: "local", bound: true }, T0),
        state: "failed" as const,
        outcomeKnown: true,
        error: { message: "boom", kind: null },
      },
    ];
    const history = runsFromHistory(
      [
        userRow("run-a"),
        {
          role: "custom",
          customType: "run-failed-before-reply",
          content: "Your request couldn't be completed.",
          display: true,
          timestamp: T0 + 400,
          __openclaw: { id: "c-a", seq: 2, runId: "run-a" },
        },
      ],
      null,
      ctx,
    );
    const [merged] = mergeHistoryRuns(live, history, ctx).runs;
    expect(merged!.error).toMatchObject({ message: "boom", beforeReply: true });
    expect(neverRan(merged!)).toBe(true);
    // A later read with a reply row of the run: it ran.
    expect(neverRan({ ...merged!, ranInHistory: true })).toBe(false);
  });

  it("(a) a followed task: A's failure row written after B started, B answered: no mark", () => {
    const rows = [
      userRow("run-a"),
      {
        ...userRow("run-b", "and this"),
        __openclaw: { id: "u-run-b", seq: 2, idempotencyKey: "run-b:user" },
        idempotencyKey: "run-b:user",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
        timestamp: T0 + 300,
        __openclaw: { id: "a-b", seq: 3, runId: "run-b" },
      },
      // A's failure row, written after B started.
      {
        role: "custom",
        customType: "run-failed-before-reply",
        content: "Your request couldn't be completed.",
        display: true,
        timestamp: T0 + 900,
        __openclaw: { id: "c-a", seq: 4, runId: "run-a" },
      },
    ];
    const runs = runsFromHistory(rows, null, {
      sessionKey: KEY,
      now: T0 + 1_000,
      raw: new RawTable(),
    });
    const items = mapHistory(rows);
    expect(runs.find((run) => run.id === "run-a")?.state).toBe("failed");
    expect(fromActivity({ runs, items }).failedAt).toBeNull();
    // Without the order of the messages (no items), the failure row's later time would decide.
    expect(fromActivity({ runs }).failedAt).not.toBeNull();
  });
});

describe("#686: a failure sits only under the message its run is known to have started from", () => {
  /** The gateway's row for a message it failed before any run of it started (2026.11.10's form). */
  const failedRow = (runId: string) => ({
    role: "custom",
    customType: "run-failed-before-reply",
    display: true,
    timestamp: T0 + 400,
    content: "Your request couldn't be completed.",
    openclawRunError: { runId, summary: "Your request couldn't be completed." },
    __openclaw: { id: `c-${runId}`, seq: 3, runId },
  });
  const replyRow = (runId: string) => ({
    role: "assistant",
    content: [{ type: "text", text: "Here it is." }],
    stopReason: "stop",
    timestamp: T0 + 500,
    __openclaw: { id: `a-${runId}`, seq: 4, runId },
  });
  const textOf = (items: Array<{ id: string; blocks: unknown[] }>, id: string | null) =>
    items
      .find((item) => item.id === id)
      ?.blocks.map((block) => (block as { text?: string }).text ?? "")
      .join("");

  it("two quick sends, the first failed at dispatch: its line stays under it after history is read", async () => {
    const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 - 60_000 }]);
    const { client, transcript } = await openTask({ gateway });
    const first = client.sendMessage(KEY, "first");
    await until(() => transcript().runs[0]?.bound === true);
    gateway.emit("chat", {
      runId: first,
      sessionKey: KEY,
      seq: 1,
      state: "error",
      errorMessage: "This saved login isn't available.",
    });
    await until(() => transcript().runs[0]?.state === "failed");
    const second = client.sendMessage(KEY, "second");
    await until(() => transcript().runs.find((run) => run.id === second)?.bound === true);
    // History as the gateway wrote it: both messages, then the first's failure, then the reply.
    gateway.handlers["chat.history"] = () => ({
      messages: [
        userRow(first, "first"),
        userRow(second, "second"),
        failedRow(first),
        replyRow(second),
      ],
      hasMore: false,
    });
    gateway.emit("session.message", { sessionKey: KEY, messageSeq: 4 });
    await until(() => transcript().items.length >= 3 && transcript().outbox.length === 0);
    const failed = transcript().runs.find((run) => run.id === first)!;
    expect(failed.state).toBe("failed");
    expect(neverRan(failed)).toBe(true);
    // Under the first message, and what Try again sends is that message.
    expect(textOf(transcript().items, failed.anchorItemId)).toBe("first");
    client.stop();
  });

  /** Two quick sends; A ran from the gateway's queue under an id of its own and answered after B's prompt. */
  async function aRepliesAfterB(options: { aFromChannel: boolean }) {
    const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 - 60_000 }]);
    const { client, transcript } = await openTask({ gateway });
    const first = options.aFromChannel ? "channel-a" : client.sendMessage(KEY, "first");
    if (!options.aFromChannel) {
      await until(() => transcript().runs[0]?.bound === true);
      // The gateway names the pairing of A's two ids.
      gateway.emit("sessions.changed", {
        sessionKey: KEY,
        runId: "gateway-a",
        clientRunId: first,
        phase: "start",
      });
      await until(() => transcript().queueAliases["gateway-a"] === first);
    }
    // B goes in behind A, as a turn of its own.
    const second = client.sendMessage(KEY, "second", { mode: "queue" });
    await until(() => transcript().runs.find((run) => run.id === second)?.bound === true);
    const unkeyed = {
      role: "user",
      content: "first",
      timestamp: T0,
      __openclaw: { id: "u-ch", seq: 1 },
    };
    gateway.handlers["chat.history"] = () => ({
      messages: [
        options.aFromChannel ? unkeyed : userRow(first, "first"),
        userRow(second, "second"),
        replyRow("gateway-a"),
        failedRow(second),
      ],
      hasMore: false,
    });
    gateway.emit("session.message", { sessionKey: KEY, messageSeq: 4 });
    await until(() => transcript().items.length >= 3 && transcript().outbox.length === 0);
    return { client, transcript, first, second };
  }

  it("A, B, A's reply, B's failure: B's failure stays under B, and A's reply under A", async () => {
    const { client, transcript, first, second } = await aRepliesAfterB({ aFromChannel: false });
    const failed = transcript().runs.find((run) => run.id === second)!;
    expect(failed.state).toBe("failed");
    expect(neverRan(failed)).toBe(true);
    // Keyed to B's own row: Try again sends B.
    expect(failed.anchorKeyed).toBe(true);
    expect(textOf(transcript().items, failed.anchorItemId)).toBe("second");
    // A's reply is A's, by the gateway's own pairing, not B's by its place.
    expect(transcript().queueAliases["gateway-a"]).toBe(first);
    const answered = transcript().runs.find((run) => run.id === first)!;
    expect(answered.state).toBe("completed");
    expect(textOf(transcript().items, answered.anchorItemId)).toBe("first");
    client.stop();
  });

  it("the same with A's key missing: nothing pairs by place, and B's failure stays B's", async () => {
    const { client, transcript, second } = await aRepliesAfterB({ aFromChannel: true });
    expect(transcript().queueAliases).toEqual({});
    const failed = transcript().runs.find((run) => run.id === second)!;
    expect(neverRan(failed)).toBe(true);
    expect(textOf(transcript().items, failed.anchorItemId)).toBe("second");
    // A's reply is tied to no message: drawn where it falls, never what Try again sends.
    const answered = transcript().runs.find((run) => run.id === "gateway-a")!;
    expect(answered.state).toBe("completed");
    expect(answered.anchorKeyed).toBeUndefined();
    client.stop();
  });
});

describe("only a run that started sends these, so each says it ran (#686)", () => {
  it("a preamble with the lifecycle start missed, then a failure: not a message the gateway couldn't run", async () => {
    const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 - 60_000 }]);
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "hello");
    await until(() => transcript().runs[0]?.bound === true);
    gateway.emit(
      "agent",
      agentEvent(id, 2, "item", {
        kind: "preamble",
        itemId: "p1",
        phase: "update",
        progressText: "Reading the log first.",
      }),
    );
    await until(() => (transcript().runs[0]?.preambles?.length ?? 0) === 1);
    gateway.emit("chat", {
      runId: id,
      sessionKey: KEY,
      seq: 3,
      state: "error",
      errorMessage: "provider down",
    });
    await until(() => transcript().runs[0]?.state === "failed");
    const run = transcript().runs[0]!;
    expect(run).toMatchObject({ reportedStartAt: null, text: "", steps: [] });
    expect(neverRan(run)).toBe(false);
    expect(neverStarted({ ...run, state: "completed", outcomeKnown: false, error: null })).toBe(
      false,
    );
    client.stop();
  });

  it("each kind of evidence counts; a model choice or a status before the failure does not", () => {
    type Shown = Parameters<typeof neverRan>[0];
    const bare: Shown = {
      state: "failed" as const,
      error: { message: "boom", kind: null },
      origin: "local" as const,
      reportedStartAt: null,
      steps: [],
      text: "",
      pendingCards: [],
      suspendedCards: [],
      closedCards: [],
      omittedSteps: 0,
      ending: null,
    };
    // Lifecycle `model` and `run_status` set these: the gateway sends them for a message it fails.
    expect(neverRan({ ...bare, model: "nope/dev-1", phase: "queued" } as Shown)).toBe(true);
    const card = { id: "ap-1", kind: "approval" as const, since: T0 };
    const evidences: Array<Partial<Shown>> = [
      { reportedStartAt: T0 },
      { text: "Here" },
      { preambles: [{ id: "p1", text: "Reading", ended: false, beforeCall: null }] },
      { pendingCards: [card] },
      { suspendedCards: [card] },
      { closedCards: [{ ...card, reason: "resolved" as const }] },
      // Steps it had, dropped at their bound.
      { omittedSteps: 2 },
      // The lifecycle error itself says the provider started.
      { ending: { stopReason: null, timeoutPhase: null, providerStarted: true, status: "error" } },
    ];
    for (const evidence of evidences) expect(neverRan({ ...bare, ...evidence })).toBe(false);
  });

  it("the chat error, then the lifecycle error saying the provider started, or the reverse: it ran", async () => {
    // The lifecycle error as an attempt's (the gateway may go on) and as the run's settled end.
    for (const settled of [{}, { executionSettled: true }]) {
      for (const chatFirst of [true, false]) {
        const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 - 60_000 }]);
        const { client, transcript } = await openTask({ gateway });
        const id = client.sendMessage(KEY, "hello");
        await until(() => transcript().runs[0]?.bound === true);
        const chatError = () =>
          gateway.emit("chat", {
            runId: id,
            sessionKey: KEY,
            seq: 3,
            state: "error",
            errorMessage: "provider down",
          });
        const lifecycleError = () =>
          gateway.emit(
            "agent",
            agentEvent(id, 2, "lifecycle", {
              phase: "error",
              error: "provider down",
              providerStarted: true,
              ...settled,
            }),
          );
        if (chatFirst) {
          chatError();
          await until(() => transcript().runs[0]?.state === "failed");
          lifecycleError();
        } else {
          lifecycleError();
          chatError();
        }
        await until(() => transcript().runs[0]?.state === "failed");
        await sleep(20);
        const run = transcript().runs[0]!;
        expect(neverRan(run), `chat first: ${chatFirst}, ${JSON.stringify(settled)}`).toBe(false);
        client.stop();
      }
    }
  });

  it("each kind of evidence arriving after the run's end still counts; a model choice does not", () => {
    const ctx = { sessionKey: KEY, now: T0 + 1_000, raw: new RawTable() };
    // A run ended by the gateway's `chat` error, nothing reported started.
    const ended = (): TaskActivity => ({
      ...emptyActivity,
      runs: [
        {
          ...newRun("r", { state: "running", origin: "local", bound: true }, T0),
          state: "failed",
          outcomeKnown: true,
          endedAt: T0 + 300,
          error: { message: "provider down", kind: null },
        },
      ],
    });
    const agent = (stream: string, data: Record<string, unknown>) =>
      applyAgentEvent(ended(), { runId: "r", seq: 5, stream, ts: T0 + 400, data }, ctx).activity;
    const late: Array<[string, TaskActivity]> = [
      ["lifecycle start", agent("lifecycle", { phase: "start", startedAt: T0 + 10 })],
      ["provider started", agent("lifecycle", { phase: "end", providerStarted: true })],
      ["card", agent("lifecycle", { phase: "waiting-approval", approvalId: "ap-1" })],
      ["step", agent("tool", { phase: "start", toolCallId: "t1", name: "read", args: {} })],
      ["reasoning", agent("thinking", { delta: "Looking at it" })],
      ["reply text", agent("assistant", { delta: "Here" })],
      [
        "preamble",
        agent("item", { kind: "preamble", itemId: "p1", phase: "update", progressText: "First" }),
      ],
      [
        "chat reply text",
        applyChatEvent(
          ended(),
          { runId: "r", sessionKey: KEY, seq: 6, state: "delta" },
          "Here it is",
          ctx,
        ),
      ],
      [
        "question",
        applyQuestionRequested(ended(), { ...questionRecord("q1", "r"), status: "pending" }, ctx),
      ],
    ];
    for (const [kind, activity] of late) {
      const run = activity.runs[0]!;
      expect(neverRan(run), kind).toBe(false);
      // Only the evidence is kept: the ended run takes nothing else of the event.
      expect(run.steps, kind).toEqual([]);
      expect(run.text, kind).toBe("");
      expect(run.state, kind).toBe("failed");
    }
    // What the gateway sends for a message it then fails says nothing after the end either.
    for (const quiet of [
      agent("lifecycle", { phase: "model", model: "nope/dev-1" }),
      agent("lifecycle", { phase: "end", providerStarted: false }),
      agent("run_status", { phase: "queued" }),
    ])
      expect(neverRan(quiet.runs[0]!)).toBe(true);
  });
});

describe("F-480 #988: recovering a message that never ran", () => {
  it("recognizes the exact Computer Use catalog deadline, with or without the nested code", () => {
    const reason = "Codex Computer Use readiness failed: plugin/list timed out";
    const code = "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED";
    expect(notRunCause(reason)?.kind).toBe("computer-use-timeout");
    expect(notRunCause(`Error: ${reason} | ${code}`)?.kind).toBe("computer-use-timeout");
    for (const other of [
      `thread/start timed out | ${code}`,
      `Codex Computer Use readiness failed: plugin/list aborted | ${code}`,
      `Codex Computer Use readiness failed: thread/start timed out | ${code}`,
      `The gateway logged: ${reason} | ${code}`,
    ])
      expect(notRunCause(other)?.kind).toBe("other");
  });

  it("matches the previous reason, with a success or a different reason resetting the streak", () => {
    const fail = (id: string, time: number, reason: string) => ({
      ...newRun(id, { state: "failed", origin: "local", bound: true }, time),
      error: { message: reason, kind: null },
    });
    const first = fail("a", 1, "The backend could not prepare.");
    const second = fail("b", 2, "Error: The backend could not prepare.");
    const success = newRun("c", { state: "completed", origin: "local", bound: true }, 3);
    const after = fail("d", 4, "The backend could not prepare.");
    const different = fail("e", 5, "The session is locked.");
    const unsaid = fail("f", 6, "Your request couldn't be completed.");
    expect(repeatedNotRun(first, [first, second])).toBe(false);
    expect(repeatedNotRun(second, [second, first])).toBe(true);
    expect(repeatedNotRun(after, [after, first, second, success])).toBe(false);
    expect(repeatedNotRun(different, [second, different])).toBe(false);
    expect(repeatedNotRun(unsaid, [unsaid, { ...unsaid, id: "g", startedAt: 5 }])).toBe(false);
  });

  it("uses keyed message order when an earlier failure was written after a successful run", () => {
    const reason = "The backend could not prepare.";
    const items = mapHistory(["a", "b", "c"].map((id) => userRow(id, id)));
    const runs = ["c", "a", "b"].map((id, index) =>
      newRun(
        id,
        {
          state: id === "b" ? "completed" : "failed",
          origin: "history",
          anchorKeyed: true,
          anchorItemId: items.find((item) => item.id.startsWith(`u-${id}:`))!.id,
          error: id === "b" ? null : { message: reason, kind: null, beforeReply: true },
        },
        10 + index,
      ),
    );
    expect(repeatedNotRun(runs[0]!, runs, items)).toBe(false);
    expect(repeatedNotRun(runs[0]!, runs.slice(0, 2), items)).toBe(true);
  });

  it("gives up the oldest retry copy at the count and decoded size limits", () => {
    const files = new NotRunFiles();
    const entry = (runId: string, bytes: number) => ({
      task: KEY,
      bot: "otto",
      runId,
      bytes,
      message: {} as OutgoingMessage,
      files: [],
    });
    for (let i = 0; i < MAX_NOT_RUN_FILE_MESSAGES; i++)
      expect(files.hold(entry(String(i), 1))).toEqual([]);
    expect(files.hold(entry("next", 1)).map((each) => each.runId)).toEqual(["0"]);
    expect(files.get(KEY, "0")).toBeUndefined();
    expect(files.get(KEY, "1")).toBeDefined();
    expect(files.hold(entry("big", MAX_NOT_RUN_FILE_BYTES - 1)).map((each) => each.runId)).toEqual(
      Array.from({ length: MAX_NOT_RUN_FILE_MESSAGES - 1 }, (_, i) => String(i + 1)),
    );
    expect(files.get(KEY, "next")).toBeDefined();
    expect(files.get(KEY, "big")).toBeDefined();
    files.drop(KEY, "big");
    expect(files.hold(entry("later", 1))).toEqual([]);
  });

  it("resends every file, word and the reply reference after history removes the send", async () => {
    const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 - 60_000 }]);
    const { client, transcript } = await openTask({ gateway });
    try {
      const files = [
        { type: "file", fileName: "a.txt", mimeType: "text/plain", content: "Zmlyc3Q=" },
        { type: "file", fileName: "b.txt", mimeType: "text/plain", content: "c2Vjb25k" },
      ];
      const text = "Read these files.";
      const id = client.sendMessage(KEY, text, { attachments: files, replyToId: "parent" });
      await until(() => transcript().runs[0]?.bound === true);
      gateway.handlers["chat.history"] = () => ({
        messages: [userRow(id, text)],
        inFlightRun: { runId: id },
        hasMore: false,
      });
      gateway.emit("session.message", { sessionKey: KEY, messageSeq: 1 });
      await until(() => transcript().outbox.length === 0);
      gateway.emit("chat", {
        runId: id,
        sessionKey: KEY,
        seq: 1,
        state: "error",
        errorMessage: "Backend unavailable.",
      });
      await until(() => transcript().runs[0]?.state === "failed");
      expect(transcript().runs[0]?.retryFiles).toBe("held");
      const next = client.retryNotRun(KEY, id);
      expect(next).not.toBe(id);
      await until(() => transcript().runs.some((run) => run.id === next && run.bound));
      const [first, second] = gateway.calls("chat.send") as Array<{
        attachments: unknown[];
        replyToId: string;
      }>;
      expect(first?.attachments).toHaveLength(2);
      expect(second).toMatchObject({ attachments: first!.attachments, replyToId: "parent" });
      expect(transcript().runs.find((run) => run.id === id)?.retryFiles).toBe("held");
      gateway.emit("agent", agentEvent(next, 1, "lifecycle", { phase: "start" }));
      await until(() => transcript().runs.find((run) => run.id === id)?.retryFiles === "gone");
      expect(() => client.retryNotRun(KEY, id)).toThrow("Its files are no longer held");
      expect(gateway.calls("chat.send")).toHaveLength(2);
    } finally {
      client.stop();
    }
  });

  it("releases the retry copy when its card is dismissed", async () => {
    const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 - 60_000 }]);
    const { client, transcript } = await openTask({ gateway });
    try {
      const id = client.sendMessage(KEY, "Read this.", {
        attachments: [
          { type: "file", fileName: "a.txt", mimeType: "text/plain", content: "Zmlyc3Q=" },
        ],
      });
      await until(() => transcript().runs[0]?.bound === true);
      gateway.emit("chat", {
        runId: id,
        sessionKey: KEY,
        seq: 1,
        state: "error",
        errorMessage: "Backend unavailable.",
      });
      await until(() => transcript().runs[0]?.state === "failed");
      gateway.handlers["chat.history"] = () => ({ messages: [userRow(id)], hasMore: false });
      gateway.emit("session.message", { sessionKey: KEY, messageSeq: 1 });
      await until(() => transcript().outbox.length === 0);
      expect(transcript().runs[0]?.retryFiles).toBe("held");
      client.dismissNotRun(KEY, id);
      expect(transcript().runs[0]?.retryFiles).toBe("gone");
      expect(() => client.retryNotRun(KEY, id)).toThrow("Its files are no longer held");
    } finally {
      client.stop();
    }
  });
});

describe("F-480 #988: Computer Use recovery", () => {
  const reason =
    "Codex Computer Use readiness failed: plugin/list timed out | CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED";

  for (const lifecycleFirst of [true, false]) {
    it(`keeps the known reason once when ${lifecycleFirst ? "lifecycle" : "chat"} reports it`, () => {
      const ctx = { raw: new RawTable(), sessionKey: KEY, now: T0 };
      const lifecycle = (activity: TaskActivity) =>
        applyAgentEvent(
          activity,
          agentEvent("run-1", 1, "lifecycle", {
            phase: "error",
            executionSettled: true,
            error: lifecycleFirst ? reason : "Request ended.",
          }),
          ctx,
        ).activity;
      const chat = (activity: TaskActivity) =>
        applyChatEvent(
          activity,
          {
            runId: "run-1",
            sessionKey: KEY,
            seq: 1,
            state: "error",
            errorMessage: lifecycleFirst ? "Request ended." : reason,
          },
          null,
          ctx,
        );
      for (const applied of [chat(lifecycle(emptyActivity)), lifecycle(chat(emptyActivity))]) {
        expect(applied.runs).toHaveLength(1);
        expect(neverRan(applied.runs[0]!)).toBe(true);
        expect(notRunCause(applied.runs[0]!.error?.message)?.kind).toBe("computer-use-timeout");
        expect(repeatedNotRun(applied.runs[0]!, applied.runs)).toBe(false);
      }
    });
  }

  const patch = (value: boolean | null, baseHash: string) => ({
    baseHash,
    raw: JSON.stringify({
      plugins: {
        entries: {
          codex: {
            config: {
              computerUse: { enabled: value },
            },
          },
        },
      },
    }),
  });

  async function recovery(admin = true) {
    const gateway = gatewayWith([{ key: KEY, agentId: "otto", updatedAt: T0 }]);
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway" });
    let enabled: boolean | null = true;
    let revision = 1;
    gateway.handlers["config.get"] = () => ({
      hash: `hash-${revision}`,
      configRevisionHash: `rev-${revision}`,
      appliedConfigHash: `rev-${revision}`,
      config: {
        plugins: {
          entries: {
            codex: {
              config: {
                computerUse: enabled === null ? {} : { enabled },
              },
            },
          },
        },
      },
    });
    const set = (value: boolean | null) => {
      enabled = value;
      revision += 1;
    };
    gateway.handlers["config.patch"] = (params) => {
      const { raw } = params as { raw: string };
      set(JSON.parse(raw).plugins.entries.codex.config.computerUse.enabled);
      return { ok: true };
    };
    const storage = admin
      ? memoryStorage({
          connection: JSON.stringify({ url: URL_A, token: null }),
          [tokenKey(URL_A)]: JSON.stringify({
            token: "device-token",
            grantedScopes: ADMIN_SCOPES,
            heldScopes: ADMIN_SCOPES,
            adminHeld: true,
          }),
        })
      : undefined;
    const { client, transcript } = await openTask({ gateway, ...(storage ? { storage } : {}) });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = client.sendMessage(KEY, "Check the log.");
      await until(() => transcript().runs.some((run) => run.id === id && run.bound));
      gateway.emit("chat", {
        runId: id,
        sessionKey: KEY,
        seq: 1,
        state: "error",
        errorMessage: reason,
      });
      await until(() => transcript().runs.some((run) => run.id === id && run.state === "failed"));
    }
    const runId = transcript().runs.at(-1)!.id;
    const stamp = stampOn("gateway", client);
    const change = (restore: boolean) => client.changeNotRunComputerUse(KEY, runId, restore, stamp);
    return { client, gateway, runId, change, set };
  }

  it("changes just Computer Use, reads it back, and puts it back against a fresh hash", async () => {
    const { client, gateway, runId, change } = await recovery();
    try {
      const reads = gateway.calls("config.get").length;
      expect(await change(false)).toBe("off");
      expect(gateway.calls("config.patch")).toEqual([patch(false, "hash-1")]);
      expect(gateway.calls("config.get").length).toBeGreaterThanOrEqual(reads + 2);
      expect(client.state.computerUseUndo).toMatchObject({ runId, previous: true });
      expect(await change(true)).toBe("restored");
      expect(gateway.calls("config.patch")).toEqual([
        patch(false, "hash-1"),
        patch(true, "hash-2"),
      ]);
      expect(client.state.computerUseUndo).toBeUndefined();
    } finally {
      client.stop();
    }
  });

  it("waits for the running gateway to apply the new revision before offering Put back", async () => {
    const { client, gateway, change } = await recovery();
    const saved = gateway.handlers["config.get"]!;
    let observedPending = false;
    let applied = false;
    gateway.handlers["config.get"] = (params) => {
      const snapshot = saved(params) as Row;
      if (applied || gateway.calls("config.patch").length === 0) return snapshot;
      observedPending = true;
      return { ...snapshot, appliedConfigHash: "rev-1" };
    };
    try {
      const result = change(false);
      await until(() => observedPending);
      expect(client.state.computerUseUndo).toBeUndefined();
      applied = true;
      expect(await result).toBe("off");
      expect(client.state.computerUseUndo).toBeDefined();
    } finally {
      client.stop();
    }
  });

  it("puts back an unset value and refuses to replace a different value read back", async () => {
    const { client, gateway, change, set } = await recovery();
    try {
      set(null);
      expect(await change(false)).toBe("off");
      expect(await change(true)).toBe("restored");
      expect(gateway.calls("config.patch")).toEqual([
        patch(false, "hash-2"),
        patch(null, "hash-3"),
      ]);
      expect(await change(false)).toBe("off");
      set(true);
      expect(await change(true)).toBe("changed");
      expect(gateway.calls("config.patch")).toHaveLength(3);
      expect(client.state.computerUseUndo).toBeUndefined();
    } finally {
      client.stop();
    }
  });

  it("distinguishes a refused change from an answer that could not establish the outcome", async () => {
    const { client, gateway, change } = await recovery();
    try {
      for (const [code, expected] of [
        ["INVALID_REQUEST", "refused"],
        ["UNAVAILABLE", "unconfirmed"],
      ]) {
        gateway.handlers["config.patch"] = () => {
          throw new GatewayError({ code: code!, message: "No setting was confirmed." });
        };
        expect(await change(false)).toBe(expected);
        expect(client.state.computerUseUndo).toBeUndefined();
      }
      expect(gateway.calls("config.patch")).toHaveLength(2);
    } finally {
      client.stop();
    }
  });

  it("refuses before reading or writing config when this device lacks admin control", async () => {
    const { client, gateway, change } = await recovery(false);
    try {
      const reads = gateway.calls("config.get").length;
      await expect(change(false)).rejects.toThrow(/admin/i);
      expect(gateway.calls("config.patch")).toHaveLength(0);
      expect(gateway.calls("config.get").length).toBe(reads);
    } finally {
      client.stop();
    }
  });
});
