// A message the gateway couldn't run (#663) and the mark of a task's latest run (#664), with each
// OpenClaw version's frames as a development gateway sent them, names made up. On both 2026.10.6
// and 2026.11.10 the send is answered `started`; a message the gateway fails before any run of it
// starts then gets one `chat` error (`seq: 1`, no lifecycle `start`), and history keeps a
// "run-failed-before-reply" row for it. 2026.10.6 keeps the reason in that row and in the task's
// row (`status: "failed"`, `lastRunError`); 2026.11.10, failing it at dispatch, keeps neither.

import { describe, expect, it } from "vitest";
import { mergeSessionRow } from "../src/mapping.ts";
import { RawTable, runsFromHistory } from "../src/runs.ts";
import { neverRan, neverStarted, notRunCause, MAX_NOT_RUN_WORDS } from "../src/not-run.ts";
import { WaitingIndex } from "../src/waiting.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { sleep, until, type FakeGateway } from "./fake-gateway.ts";

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
  // marked `suppressErrorNotice`; 2026.10.6 sends no such mark.
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
      transcript().runs.some((run) => run.id === "wake-1" && run.state === "failed"),
    );
    const run = transcript().runs.find((each) => each.id === "wake-1")!;
    expect(run.error?.quiet).toBe(true);
    expect(neverRan(run)).toBe(false);
    // Even with no start of its own seen, the mark keeps it from being one the gateway couldn't run.
    expect(neverRan({ ...run, reportedStartAt: null })).toBe(false);
    await sleep(50);
    expect(task(client)?.status).not.toBe("failed");
    client.stop();
  });

  it("the index: the marked error is a quiet end, the same error unmarked (2026.10.6's form) a failure", () => {
    const index = new WaitingIndex();
    const frame = { sessionKey: KEY, runId: "r1", state: "error", errorMessage: QUIET };
    expect(index.onChat({ ...frame, suppressErrorNotice: true }, 1_000)).toBe(true);
    expect(index.failedAt(KEY)).toBeNull();
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
    index.onChat({ sessionKey: KEY, runId: "r4", state: "error" }, 4_000);
    // The same run's lifecycle end, after its error, keeps it failed.
    index.onAgent(
      { sessionKey: KEY, runId: "r4", stream: "lifecycle", ts: 4_001, data: { phase: "error" } },
      4_001,
    );
    expect(index.failedAt(KEY)).not.toBeNull();
    expect(index.failedAt(OTHER)).toBeNull();
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
    // With no run going, a message failed before running is the task's latest outcome.
    expect(index.onChat({ sessionKey: KEY, runId: "r3", state: "error" }, 4_000)).toBe(true);
    expect(index.failedAt(KEY)).toBe(4_000);
  });
});
