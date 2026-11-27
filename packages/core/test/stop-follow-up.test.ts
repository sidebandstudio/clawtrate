// The turn the gateway starts on its own in a task once a recipient's run that this client
// stopped for a Stop in that task has ended (#645). On OpenClaw 2026.10.6 and 2026.11.10 alike, a
// send that left its reply to come later (`delivery: {status: "pending"}`) makes the gateway wait
// for the recipient's run; when that run ends without a reply, it starts one turn in the sending
// task, sent as the recipient's: "sessions_send delivery to … failed … retry or report the
// failure" (`runSessionsSendA2AFlow`). This client stops that turn as the Stop would have, found by
// what the gateway sends: never by its words.

import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLLOW_UP_WAIT_MS } from "../src/client.ts";
import { agentEvent, KEY, openTask } from "./client-harness.ts";
import { sleep, until, type FakeGateway } from "./fake-gateway.ts";

const PEER = "agent:marlow:main";
const NOTE =
  "sessions_send delivery to agent:marlow:main failed. The target may not have received the message; retry or report the failure instead of assuming delivery succeeded.";

/** The send's result as both versions give it for a recipient still working. */
const pending = (runId: string, sessionKey = PEER) => ({
  runId,
  status: "accepted",
  sessionKey,
  targetDisposition: "queued",
  delivery: { status: "pending" },
});

/** `run-s` messages each recipient, with each result's details as given. */
function messaged(gateway: FakeGateway, results: Array<Record<string, unknown>>, run = "run-s") {
  gateway.emit("agent", agentEvent(run, 1, "lifecycle", { phase: "start" }));
  results.forEach((details, index) =>
    gateway.emit(
      "agent",
      agentEvent(run, index + 2, "tool", {
        phase: "result",
        name: "sessions_send",
        toolCallId: `${run}-c${index}`,
        isError: false,
        result: { content: [{ type: "text", text: JSON.stringify(details) }], details },
      }),
    ),
  );
}

/**
 * The row the gateway keeps for a turn another session's message started, as 2026.11.10 keeps it
 * (2026.10.6 the same, without `senderIsOwner`): an assistant row keyed `<run>:user`.
 */
const startedRow = (
  runId: string,
  provenance: Record<string, unknown> | null,
  text = NOTE,
  role = "assistant",
) => ({
  role,
  content: [{ type: "text", text }],
  timestamp: 2_000,
  idempotencyKey: `${runId}:user`,
  ...(provenance ? { provenance } : {}),
  __openclaw: { senderIsOwner: false, id: `row-${runId}`, idempotencyKey: `${runId}:user` },
});

const fromPeer = { kind: "inter_session", sourceSessionKey: PEER, sourceTool: "sessions_send" };

type Abort = { sessionKey: string; runId?: string };

/** A gateway whose aborts each succeed, and end the run they name. */
function aborting(gateway: FakeGateway, recipient: { aborted: boolean } = { aborted: true }) {
  gateway.handlers["chat.abort"] = (params) => {
    const { sessionKey, runId } = params as Abort;
    if (sessionKey !== KEY)
      return { ok: true, ...recipient, runIds: recipient.aborted ? [runId] : [] };
    setTimeout(
      () =>
        gateway.emit(
          "agent",
          agentEvent(runId!, 90, "lifecycle", { phase: "end", status: "cancelled", aborted: true }),
        ),
      0,
    );
    return { ok: true, aborted: true, runIds: [runId] };
  };
}

/** Stop `run-s`, whose message to Marlow started `run-r`, and let `run-r` end as stopped. */
async function stopTheExchange(
  opened: Awaited<ReturnType<typeof openTask>>,
  results: Array<Record<string, unknown>> = [pending("run-r")],
  before: () => Promise<void> = async () => {},
) {
  const { client, gateway, transcript } = opened;
  messaged(gateway, results);
  await before();
  gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
  await until(() => transcript().linkedRuns["run-r"]?.state === "running");
  await client.stopRun(KEY, "run-s");
  await until(() => transcript().runs[0]!.stoppedWith?.recipientsAsked === true);
  await sleep(10);
  gateway.emit(
    "agent",
    agentEvent("run-r", 9, "lifecycle", { phase: "end", status: "cancelled", aborted: true }, PEER),
  );
  await until(() => transcript().linkedRuns["run-r"]?.state === "stopped");
}

/**
 * The gateway starts a turn in the task, started by the last of these rows, and the client reads
 * them: resolved once that read has been taken in.
 */
async function turnStarts(gateway: FakeGateway, runId: string, rows: unknown[], at = 1_500) {
  const before = gateway.calls("chat.history").length;
  gateway.handlers["chat.history"] = () => ({
    messages: rows,
    inFlightRun: { runId, status: "running", startedAt: at, events: [] },
    hasMore: false,
  });
  gateway.emit("agent", { ...agentEvent(runId, 1, "lifecycle", { phase: "start" }), ts: at });
  gateway.emit("session.message", { sessionKey: KEY });
  await until(() => gateway.calls("chat.history").length > before);
  await sleep(30);
}

const abortsOf = (gateway: FakeGateway) => gateway.calls("chat.abort") as Abort[];
const run = (opened: Awaited<ReturnType<typeof openTask>>, id: string) =>
  opened.transcript().runs.find((each) => each.id === id);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the gateway's own turn after a Stop that stopped a recipient (#645)", () => {
  it("#645: the turn the gateway starts on its own once the stopped recipient's run ends is stopped too, by its id, and both notes say so", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => abortsOf(gateway).some((each) => each.runId === "run-f"));
    expect(abortsOf(gateway)).toEqual([
      { sessionKey: KEY, runId: "run-s" },
      { sessionKey: PEER, runId: "run-r" },
      { sessionKey: KEY, runId: "run-f" },
    ]);
    await until(() => run(opened, "run-f")?.state === "stopped");
    expect(run(opened, "run-f")!.stoppedAsFollowUp).toBe(true);
    expect(run(opened, "run-s")!.stoppedWith?.followUps).toEqual([PEER]);
    client.stop();
  });

  it("#645: the turn the gateway starts in reply to a stopped turn that had resent the message is stopped as well: one Stop ends the chain", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    // The bot resends at once, before the client has read what started its turn: a new run of
    // Marlow's.
    messaged(gateway, [pending("run-r2")], "run-f");
    gateway.emit("agent", agentEvent("run-r2", 1, "lifecycle", { phase: "start" }, PEER));
    await until(() => opened.transcript().linkedRuns["run-r2"]?.state === "running");
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => run(opened, "run-f")?.state === "stopped");
    await until(() => abortsOf(gateway).some((each) => each.runId === "run-r2"));
    gateway.emit(
      "agent",
      agentEvent(
        "run-r2",
        9,
        "lifecycle",
        { phase: "end", status: "cancelled", aborted: true },
        PEER,
      ),
    );
    await until(() => opened.transcript().linkedRuns["run-r2"]?.state === "stopped");
    await turnStarts(
      gateway,
      "run-f2",
      [startedRow("run-f", fromPeer), startedRow("run-f2", fromPeer)],
      1_800,
    );
    await until(() => abortsOf(gateway).some((each) => each.runId === "run-f2"));
    expect(run(opened, "run-f")!.stoppedWith?.followUps).toEqual([PEER]);
    client.stop();
  });

  it("#645: look-alikes are left alone (a person's message, another bot's, another tool's), and the awaited turn is stopped once only", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    const others: Array<[string, unknown]> = [
      ["run-person", startedRow("run-person", { kind: "external_user" }, "Go on.", "user")],
      [
        "run-juniper",
        startedRow("run-juniper", { ...fromPeer, sourceSessionKey: "agent:juniper:main" }),
      ],
      ["run-spawn", startedRow("run-spawn", { ...fromPeer, sourceTool: "sessions_spawn" })],
      ["run-plain", startedRow("run-plain", null)],
      // A turn with no row of its own, drawn after a message from Marlow that started another.
      ["run-after", startedRow("run-old", fromPeer, NOTE, "user")],
    ];
    const rows: unknown[] = [];
    for (const [id, row] of others) {
      rows.push(row);
      await turnStarts(gateway, id, [...rows]);
      await until(() => run(opened, id) !== undefined);
      await sleep(30);
      gateway.emit("agent", agentEvent(id, 80, "lifecycle", { phase: "end", status: "completed" }));
      await until(() => run(opened, id)?.state === "completed");
    }
    expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r"]);
    rows.push(startedRow("run-f", fromPeer));
    await turnStarts(gateway, "run-f", [...rows]);
    await until(() => run(opened, "run-f")?.state === "stopped");
    rows.push(startedRow("run-again", fromPeer));
    await turnStarts(gateway, "run-again", [...rows], 1_900);
    await until(() => run(opened, "run-again") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r", "run-f"]);
    client.stop();
  });

  it("#645: two messages to the same bot stopped by one Stop: the turn the gateway starts for each is stopped", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened, [pending("run-r"), pending("run-r2")], async () => {
      gateway.emit("agent", agentEvent("run-r2", 1, "lifecycle", { phase: "start" }, PEER));
      await until(() => opened.transcript().linkedRuns["run-r2"]?.state === "running");
    });
    gateway.emit(
      "agent",
      agentEvent(
        "run-r2",
        9,
        "lifecycle",
        { phase: "end", status: "cancelled", aborted: true },
        PEER,
      ),
    );
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => run(opened, "run-f")?.state === "stopped");
    await turnStarts(gateway, "run-f2", [
      startedRow("run-f", fromPeer),
      startedRow("run-f2", fromPeer),
    ]);
    await until(() => run(opened, "run-f2")?.state === "stopped");
    expect(run(opened, "run-s")!.stoppedWith?.followUps).toEqual([PEER, PEER]);
    client.stop();
  });

  it("#645: nothing is awaited for a send answered in time, a recipient whose run had ended already, or a result with no pending delivery", async () => {
    for (const [results, recipient] of [
      [
        [
          {
            runId: "run-r",
            status: "ok",
            sessionKey: PEER,
            delivery: { status: "skipped" },
            reply: "Done.",
          },
        ],
        { aborted: true },
      ],
      [[pending("run-r")], { aborted: false }],
      [[{ runId: "run-r", status: "accepted", sessionKey: PEER }], { aborted: true }],
      [[{ ...pending("run-r"), delivery: "pending" }], { aborted: true }],
      [[{ ...pending("run-r"), delivery: { status: 1 } }], { aborted: true }],
    ] as const) {
      const opened = await openTask();
      const { client, gateway } = opened;
      aborting(gateway, recipient);
      await stopTheExchange(opened, [...results] as Array<Record<string, unknown>>).catch(() => {});
      await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
      await until(() => run(opened, "run-f") !== undefined);
      await sleep(50);
      expect(abortsOf(gateway).some((each) => each.runId === "run-f")).toBe(false);
      client.stop();
    }
  });

  it("#645: a turn that could be the relay of another send's reply to the same bot is not stopped", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    // An earlier message to Marlow, whose run finished well just before the Stop: its reply comes
    // as a turn of the same form.
    await stopTheExchange(opened, [pending("run-earlier"), pending("run-r")], async () => {
      gateway.emit("agent", agentEvent("run-earlier", 1, "lifecycle", { phase: "start" }, PEER));
      gateway.emit(
        "agent",
        agentEvent("run-earlier", 5, "lifecycle", { phase: "end", status: "completed" }, PEER),
      );
      await until(() => opened.transcript().linkedRuns["run-earlier"]?.state === "completed");
    });
    expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r"]);
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => run(opened, "run-f") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).some((each) => each.runId === "run-f")).toBe(false);
    client.stop();
  });

  it("#645: once the wait is over, a turn of that form is someone's message, and stays", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    const later = Date.now() + FOLLOW_UP_WAIT_MS + 1;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => run(opened, "run-f") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).some((each) => each.runId === "run-f")).toBe(false);
    client.stop();
  });
});
