// The turn the gateway starts on its own in a task once a recipient's run that this client
// stopped for a Stop in that task has ended (#645). On OpenClaw 2026.10.6 and 2026.11.10 alike, a
// send that left its reply to come later (`delivery: {status: "pending"}`) makes the gateway wait
// for the recipient's run; when that run ends without a reply, it starts one turn in the sending
// task, sent as the recipient's: "sessions_send delivery to … failed … retry or report the
// failure" (`runSessionsSendA2AFlow`). This client stops that turn as the Stop would have, found by
// what the gateway sends: never by its words.

import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLLOW_UP_WAIT_MS, MAX_FOLLOW_UPS } from "../src/client.ts";
import { emptyActivity, newRun, unmarkStoppedAsFollowUp } from "../src/runs.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { agentEvent, KEY, openTask, URL_A, URL_B } from "./client-harness.ts";
import {
  GatewayError,
  memoryStorage,
  sleep,
  tokenKey,
  until,
  type FakeGateway,
} from "./fake-gateway.ts";

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

/** `run-s` messages each recipient, with each result's details as given; its events from `at` on. */
function messaged(
  gateway: FakeGateway,
  results: Array<Record<string, unknown>>,
  run = "run-s",
  at = 1_000,
) {
  const event = (seq: number, stream: string, data: Record<string, unknown>) => ({
    ...agentEvent(run, seq, stream, data),
    ts: at + seq,
  });
  gateway.emit("agent", event(1, "lifecycle", { phase: "start" }));
  results.forEach((details, index) =>
    gateway.emit(
      "agent",
      event(index + 2, "tool", {
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
  await until(
    () =>
      transcript().runs.find((each) => each.id === "run-s")?.stoppedWith?.recipientsAsked === true,
  );
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
    messaged(gateway, [pending("run-r2")], "run-f", 1_500);
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
      // A routine's turn in the task, as the gateway writes it.
      [
        "run-routine",
        startedRow(
          "run-routine",
          { kind: "internal_system", sourceTool: "cron", sourceSessionKey: KEY },
          "Daily check.",
          "user",
        ),
      ],
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

  it("#645: a message the person sends after the Stop starts a turn that is left alone", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    gateway.handlers["chat.send"] = () => ({ runId: "run-mine", status: "started" });
    client.sendMessage(KEY, "Go on with the plan.");
    await until(() => gateway.calls("chat.send").length === 1);
    const mine = {
      role: "user",
      content: [{ type: "text", text: "Go on with the plan." }],
      timestamp: 2_000,
      idempotencyKey: "run-mine:user",
      __openclaw: { id: "row-mine", idempotencyKey: "run-mine:user" },
    };
    await turnStarts(gateway, "run-mine", [mine]);
    await until(() => run(opened, "run-mine") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r"]);
    // The gateway's own turn comes after it, and is still the one stopped.
    gateway.emit(
      "agent",
      agentEvent("run-mine", 80, "lifecycle", { phase: "end", status: "completed" }),
    );
    await turnStarts(gateway, "run-f", [mine, startedRow("run-f", fromPeer)], 1_900);
    await until(() => abortsOf(gateway).some((each) => each.runId === "run-f"));
    client.stop();
  });

  it("#645: the gateway's turn that ended before it was seen is the awaited one: the bot's own later message is left alone", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    // A quick answer to the gateway's note: started and ended before any read showed its row.
    gateway.emit("agent", {
      ...agentEvent("run-f", 1, "lifecycle", { phase: "start" }),
      ts: 1_500,
    });
    gateway.emit("agent", {
      ...agentEvent("run-f", 2, "lifecycle", { phase: "end", status: "completed" }),
      ts: 1_600,
    });
    await until(() => run(opened, "run-f")?.state === "completed");
    const answered = {
      role: "assistant",
      content: [{ type: "text", text: "The message to Marlow failed." }],
      timestamp: 2_100,
      __openclaw: { id: "row-f-reply", runId: "run-f" },
    };
    const before = gateway.calls("chat.history").length;
    gateway.handlers["chat.history"] = () => ({
      messages: [startedRow("run-f", fromPeer), answered],
      hasMore: false,
    });
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("chat.history").length > before);
    await until(() => run(opened, "run-f")?.anchorKeyed === true);
    // Then Marlow, asked again by the person in its own task, messages this one.
    await turnStarts(
      gateway,
      "run-m",
      [startedRow("run-f", fromPeer), answered, startedRow("run-m", fromPeer, "Here is the plan.")],
      1_900,
    );
    await until(() => run(opened, "run-m") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r"]);
    client.stop();
  });

  it("#645: a turn of that form from before the Stop (an earlier relayed reply) is not the awaited one", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    // Earlier, Marlow's reply to another message was relayed here as a turn, which ended.
    const earlier = [
      startedRow("run-old", fromPeer, "Earlier reply."),
      {
        role: "assistant",
        content: [{ type: "text", text: "Thanks." }],
        timestamp: 950,
        __openclaw: { id: "row-old-reply", runId: "run-old" },
      },
    ];
    gateway.emit("agent", {
      ...agentEvent("run-old", 1, "lifecycle", { phase: "start" }),
      ts: 900,
    });
    gateway.emit("agent", {
      ...agentEvent("run-old", 2, "lifecycle", { phase: "end", status: "completed" }),
      ts: 950,
    });
    const before = gateway.calls("chat.history").length;
    gateway.handlers["chat.history"] = () => ({ messages: earlier, hasMore: false });
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("chat.history").length > before);
    await until(() => run(opened, "run-old")?.anchorKeyed === true);
    await stopTheExchange(opened);
    await turnStarts(gateway, "run-f", [...earlier, startedRow("run-f", fromPeer)]);
    await until(() => abortsOf(gateway).some((each) => each.runId === "run-f"));
    client.stop();
  });

  it("#645: when the recipient's run finished well despite its stop, the gateway's relay of its reply is left alone", async () => {
    const opened = await openTask();
    const { client, gateway, transcript } = opened;
    aborting(gateway);
    messaged(gateway, [pending("run-r")]);
    gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
    await until(() => transcript().linkedRuns["run-r"]?.state === "running");
    await client.stopRun(KEY, "run-s");
    await until(() => transcript().runs[0]!.stoppedWith?.recipientsAsked === true);
    await sleep(10);
    // The abort came as it finished: its run ended well, and its reply is relayed.
    gateway.emit(
      "agent",
      agentEvent("run-r", 9, "lifecycle", { phase: "end", status: "completed" }, PEER),
    );
    await until(() => transcript().linkedRuns["run-r"]?.state === "completed");
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer, "Here is the plan.")]);
    await until(() => run(opened, "run-f") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r"]);
    client.stop();
  });

  it("#645: once the wait is over, a turn of that form is someone's message, and stays", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    // The wall clock set back meanwhile doesn't stretch the wait (#842).
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - 10 * 60_000);
    const clock = (globalThis as unknown as { performance: { now(): number } }).performance;
    vi.spyOn(clock, "now").mockReturnValue(clock.now() + FOLLOW_UP_WAIT_MS + 1);
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => run(opened, "run-f") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).some((each) => each.runId === "run-f")).toBe(false);
    client.stop();
  });
});

describe("the automatic stop of the gateway's own turn keeps to what the person wants (#645)", () => {
  /** Aborts of the task's own runs answer at once; `run-f`'s end comes only when `ended` is called. */
  function holdingFollowUp(gateway: FakeGateway) {
    aborting(gateway);
    const answer = gateway.handlers["chat.abort"]!;
    gateway.handlers["chat.abort"] = (params) => {
      const { sessionKey, runId } = params as Abort;
      if (sessionKey === KEY && runId === "run-f")
        return { ok: true, aborted: true, runIds: [runId] };
      return answer(params);
    };
    return () =>
      gateway.emit(
        "agent",
        agentEvent("run-f", 90, "lifecycle", { phase: "end", status: "cancelled", aborted: true }),
      );
  }

  it("#645: a wait made on one gateway never acts on another: after a switch to a gateway with the same keys, the matching turn there runs", async () => {
    // Both gateways have this device paired with write access, and the same task and bot keys.
    const paired = JSON.stringify({
      token: "device-token",
      grantedScopes: INTERACTIVE_SCOPES,
      heldScopes: INTERACTIVE_SCOPES,
    });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: paired,
      [tokenKey(URL_B)]: paired,
    });
    const opened = await openTask({ storage });
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    await client.connect({ url: URL_B });
    await until(() => client.state.discovery.status === "ready");
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    expect(client.state.connection.canWrite).toBe(true);
    const before = abortsOf(gateway).length;
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => run(opened, "run-f") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).length).toBe(before);
    expect(run(opened, "run-f")!.state).toBe("running");
    client.stop();
  });

  it("#645: a message the person types while the gateway's turn is being stopped is sent, in order, never parked", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    const end = holdingFollowUp(gateway);
    await stopTheExchange(opened);
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => run(opened, "run-f")?.state === "stopping");
    const sends = gateway.calls("chat.send").length;
    const first = client.sendMessage(KEY, "Use the other folder.");
    const second = client.sendMessage(KEY, "And keep the logs.");
    await sleep(30);
    end();
    await until(() => run(opened, "run-f")?.state === "stopped");
    // The first goes as soon as the turn has stopped; the second, queued, after the first's run.
    await until(() => gateway.calls("chat.send").length === sends + 1);
    const firstRun = opened.transcript().outbox.find((each) => each.id === first)?.runId;
    gateway.emit(
      "agent",
      agentEvent(firstRun!, 9, "lifecycle", { phase: "end", status: "completed" }),
    );
    await until(() => gateway.calls("chat.send").length === sends + 2);
    const sent = (gateway.calls("chat.send") as Array<{ message: string }>)
      .slice(sends)
      .map((each) => each.message);
    expect(sent).toEqual(["Use the other folder.", "And keep the logs."]);
    const outbox = opened.transcript().outbox;
    for (const id of [first, second])
      expect(outbox.find((each) => each.id === id)?.status).not.toBe("not-sent");
    expect(run(opened, "run-f")!.stoppedAsFollowUp).toBe(true);
    client.stop();
  });

  it("#645: a turn the person steered is theirs: a steer that joined it, or one the gateway still holds, and the automatic stop leaves it running", async () => {
    for (const joined of [true, false]) {
      const opened = await openTask();
      const { client, gateway } = opened;
      aborting(gateway);
      await stopTheExchange(opened);
      gateway.emit("agent", {
        ...agentEvent("run-f", 1, "lifecycle", { phase: "start" }),
        ts: 1_500,
      });
      await until(() => run(opened, "run-f")?.state === "running");
      gateway.handlers["chat.send"] = () => ({ runId: "run-f", status: "in_flight" });
      const steer = client.sendMessage(KEY, "Also check the photos.", { mode: "auto" });
      await until(() => gateway.calls("chat.send").length > 0);
      // The gateway's bare final under the steer's own id: it joined the run.
      if (joined) gateway.emit("chat", { runId: steer, sessionKey: KEY, state: "final" });
      await sleep(20);
      await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
      await sleep(50);
      expect(opened.transcript().outbox.find((each) => each.id === steer)?.mode).toBe("steer");
      expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r"]);
      expect(run(opened, "run-f")!.state).toBe("running");
      client.stop();
    }
  });

  it("#645: a turn the person steered from another device (their message after the one that started it) runs", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    const steered = {
      role: "user",
      content: [{ type: "text", text: "Also check the photos." }],
      timestamp: 2_100,
      __openclaw: { id: "row-steer", idempotencyKey: "steer-elsewhere" },
    };
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer), steered]);
    await until(() => run(opened, "run-f") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r"]);
    client.stop();
  });

  it("#645: a reconnect lets the wait go: the gateway's turn shown on the new connection runs", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    const sockets = gateway.sockets.length;
    gateway.dropAll();
    await until(
      () => gateway.sockets.length > sockets && client.state.connection.status === "connected",
    );
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => run(opened, "run-f") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r"]);
    client.stop();
  });

  it("#645: a recipient's stop answered only on a later connection records no wait there", async () => {
    const opened = await openTask();
    const { client, gateway, transcript } = opened;
    aborting(gateway);
    const answer = gateway.handlers["chat.abort"]!;
    let first = true;
    gateway.handlers["chat.abort"] = (params) => {
      const { sessionKey } = params as Abort;
      // The first abort of the recipient gets no answer: the connection drops under it.
      if (sessionKey === PEER && first) {
        first = false;
        setTimeout(() => gateway.dropAll(), 0);
        return new Promise(() => {});
      }
      return answer(params);
    };
    messaged(gateway, [pending("run-r")]);
    gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
    await until(() => transcript().linkedRuns["run-r"]?.state === "running");
    await client.stopRun(KEY, "run-s");
    // Asked again on the new connection, where it answers.
    await until(() => abortsOf(gateway).filter((each) => each.sessionKey === PEER).length === 2);
    await until(() => client.state.connection.status === "connected");
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => run(opened, "run-f") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).some((each) => each.runId === "run-f")).toBe(false);
    client.stop();
  });

  it("#645: a recipient's stop that lost its answer is never asked again on another gateway", async () => {
    const paired = JSON.stringify({
      token: "device-token",
      grantedScopes: INTERACTIVE_SCOPES,
      heldScopes: INTERACTIVE_SCOPES,
    });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: paired,
      [tokenKey(URL_B)]: paired,
    });
    const opened = await openTask({
      storage,
      client: { reconnect: { initialMs: 600_000, maxMs: 600_000 } },
    });
    const { client, gateway, transcript } = opened;
    aborting(gateway);
    const answer = gateway.handlers["chat.abort"]!;
    let dropped = false;
    gateway.handlers["chat.abort"] = (params) => {
      const { sessionKey } = params as Abort;
      if (sessionKey === PEER && !dropped) {
        dropped = true;
        setTimeout(() => gateway.dropAll(), 0);
        return new Promise(() => {});
      }
      return answer(params);
    };
    messaged(gateway, [pending("run-r")]);
    gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
    await until(() => transcript().linkedRuns["run-r"]?.state === "running");
    await client.stopRun(KEY, "run-s");
    await until(() => dropped && client.state.connection.status !== "connected");
    // The person points the host at another gateway, with the same task and bot keys.
    await client.connect({ url: URL_B });
    await until(() => client.state.connection.status === "connected");
    await sleep(100);
    expect(abortsOf(gateway).filter((each) => each.sessionKey === PEER)).toHaveLength(1);
    client.stop();
  });

  it("#645: two pending sends to one bot, one recipient finishing well despite its stop: no turn is stopped, its reply is never cut", async () => {
    const opened = await openTask();
    const { client, gateway, transcript } = opened;
    aborting(gateway);
    messaged(gateway, [pending("run-r"), pending("run-r2")]);
    gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
    gateway.emit("agent", agentEvent("run-r2", 1, "lifecycle", { phase: "start" }, PEER));
    await until(() => transcript().linkedRuns["run-r2"]?.state === "running");
    await client.stopRun(KEY, "run-s");
    await until(
      () =>
        transcript().runs.find((each) => each.id === "run-s")?.stoppedWith?.recipientsAsked ===
        true,
    );
    await until(() => abortsOf(gateway).filter((each) => each.sessionKey === PEER).length === 2);
    await sleep(10);
    // Both aborts answered `aborted: true`, but `run-r` had finished: its reply is owed.
    gateway.emit(
      "agent",
      agentEvent("run-r", 9, "lifecycle", { phase: "end", status: "completed" }, PEER),
    );
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
    await until(() => transcript().linkedRuns["run-r2"]?.state === "stopped");
    await until(() => transcript().linkedRuns["run-r"]?.state === "completed");
    // The first turn could be either the reply or the note; then the second.
    await turnStarts(gateway, "run-a", [startedRow("run-a", fromPeer, "Here is the plan.")]);
    await until(() => run(opened, "run-a") !== undefined);
    await sleep(50);
    gateway.emit(
      "agent",
      agentEvent("run-a", 80, "lifecycle", { phase: "end", status: "completed" }),
    );
    await until(() => run(opened, "run-a")?.state === "completed");
    await turnStarts(
      gateway,
      "run-b",
      [startedRow("run-a", fromPeer, "Here is the plan."), startedRow("run-b", fromPeer)],
      1_900,
    );
    await until(() => run(opened, "run-b") !== undefined);
    await sleep(50);
    expect(
      abortsOf(gateway)
        .filter((each) => each.sessionKey === KEY)
        .map((each) => each.runId),
    ).toEqual(["run-s"]);
    client.stop();
  });

  it("#645: an abort of the gateway's turn answered aborted: false takes its follow-up marker back", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    const answer = gateway.handlers["chat.abort"]!;
    gateway.handlers["chat.abort"] = (params) => {
      const { sessionKey, runId } = params as Abort;
      if (sessionKey === KEY && runId === "run-f") return { ok: true, aborted: false, runIds: [] };
      return answer(params);
    };
    await stopTheExchange(opened);
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => abortsOf(gateway).some((each) => each.runId === "run-f"));
    await sleep(30);
    expect(run(opened, "run-f")!.stoppedAsFollowUp).toBeUndefined();
    expect(run(opened, "run-s")!.stoppedWith?.followUps).toEqual([]);
    client.stop();
  });

  it("#645: Pip to Marlow, Marlow to Pip on its own, Pip to Marlow again, Stop: the first send's real reply is not stopped", async () => {
    const opened = await openTask();
    const { client, gateway, transcript } = opened;
    aborting(gateway);
    // Pip's first message to Marlow; Marlow's run for it finishes well, and its reply is owed.
    messaged(gateway, [pending("run-r1")], "run-s1", 100);
    gateway.emit("agent", {
      ...agentEvent("run-s1", 9, "lifecycle", { phase: "end", status: "completed" }),
      ts: 150,
    });
    gateway.emit("agent", agentEvent("run-r1", 1, "lifecycle", { phase: "start" }, PEER));
    gateway.emit(
      "agent",
      agentEvent("run-r1", 5, "lifecycle", { phase: "end", status: "completed" }, PEER),
    );
    await until(() => transcript().linkedRuns["run-r1"]?.state === "completed");
    // Later, by this client's clock too.
    await sleep(20);
    // Marlow messages Pip on its own: a turn of the same form as the reply.
    const own = startedRow("run-m", fromPeer, "One more thing about the plan.");
    await turnStarts(gateway, "run-m", [own], 300);
    gateway.emit("agent", {
      ...agentEvent("run-m", 9, "lifecycle", { phase: "end", status: "completed" }),
      ts: 400,
    });
    await until(() => run(opened, "run-m")?.state === "completed");
    // Pip messages Marlow again, and the person stops that exchange.
    await stopTheExchange(opened);
    // The gateway's relay of Marlow's reply to the first message: left to run.
    await turnStarts(gateway, "run-reply", [
      own,
      startedRow("run-reply", fromPeer, "Here is the plan."),
    ]);
    await until(() => run(opened, "run-reply") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).some((each) => each.runId === "run-reply")).toBe(false);
    client.stop();
  });

  it('#645: a refused abort of the gateway\'s turn leaves it going, with no "Then stopped" and no error of its own', async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    const answer = gateway.handlers["chat.abort"]!;
    gateway.handlers["chat.abort"] = (params) => {
      const { sessionKey, runId } = params as Abort;
      if (sessionKey === KEY && runId === "run-f")
        throw new GatewayError({ code: "INVALID_REQUEST", message: "not allowed" });
      return answer(params);
    };
    await stopTheExchange(opened);
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => abortsOf(gateway).some((each) => each.runId === "run-f"));
    await until(() => run(opened, "run-f")?.state === "running");
    expect(run(opened, "run-s")!.stoppedWith?.followUps).toEqual([]);
    expect(run(opened, "run-f")!.stoppedAsFollowUp).toBeUndefined();
    expect(run(opened, "run-f")!.stopError ?? null).toBeNull();
    client.stop();
  });

  it("#645: the gateway's turn found while its stop had to wait (another run still active) is stopped once it can be", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    // A run of the task the client still holds as active, with no end seen yet.
    gateway.emit("agent", {
      ...agentEvent("run-stale", 1, "lifecycle", { phase: "start" }),
      ts: 1_200,
    });
    await until(() => run(opened, "run-stale")?.state === "running");
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await sleep(50);
    expect(abortsOf(gateway).some((each) => each.runId === "run-f")).toBe(false);
    gateway.emit("agent", {
      ...agentEvent("run-stale", 9, "lifecycle", { phase: "end", status: "completed" }),
      ts: 1_300,
    });
    await until(() => abortsOf(gateway).some((each) => each.runId === "run-f"));
    expect(abortsOf(gateway).filter((each) => each.runId === "run-f")).toHaveLength(1);
    client.stop();
  });
});

describe("the gateway's own turn: what the automated review found at 201f4b060 (#645)", () => {
  it("#645: a pending send whose recipient's run isn't named yet keeps the turn ambiguous: a real reply to it is not stopped", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    const unnamed = { status: "accepted", sessionKey: PEER, delivery: { status: "pending" } };
    await stopTheExchange(opened, [unnamed, pending("run-r")]);
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer, "Here is the plan.")]);
    await until(() => run(opened, "run-f") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).some((each) => each.runId === "run-f")).toBe(false);
    client.stop();
  });

  it("#645: a late answer to the automatic stop never undoes a Stop of the person's on a run rebuilt since", () => {
    const stopping = newRun("run-f", { state: "stopping", origin: "history", bound: true }, 1);
    const asked = { ...stopping, stopRequestedAt: 5 };
    const activity = { ...emptyActivity, runs: [asked] };
    // Not marked as the automatic stop's: the person's Stop stands.
    expect(unmarkStoppedAsFollowUp(activity, "run-f")).toBe(activity);
    // Marked: it goes back to running.
    const marked = { ...activity, runs: [{ ...asked, stoppedAsFollowUp: true as const }] };
    const back = unmarkStoppedAsFollowUp(marked, "run-f").runs[0]!;
    expect(back.state).toBe("running");
    expect(back.stoppedAsFollowUp).toBeUndefined();
  });

  it("#645: waits of an earlier connection give way to a new one at the bound", async () => {
    const opened = await openTask();
    const { client, gateway, transcript } = opened;
    aborting(gateway);
    // In another task, one Stop stops MAX_FOLLOW_UPS recipients of another bot: as many waits.
    const OTHER = "agent:otto:other";
    const JUNIPER = "agent:juniper:main";
    client.openSession(OTHER);
    await until(() => client.state.transcripts[OTHER]?.status === "ready");
    gateway.emit("agent", agentEvent("run-o", 1, "lifecycle", { phase: "start" }, OTHER));
    for (let i = 0; i < MAX_FOLLOW_UPS; i += 1) {
      const details = pending(`run-j${i}`, JUNIPER);
      gateway.emit(
        "agent",
        agentEvent(
          "run-o",
          i + 2,
          "tool",
          {
            phase: "result",
            name: "sessions_send",
            toolCallId: `run-o-c${i}`,
            isError: false,
            result: { content: [{ type: "text", text: JSON.stringify(details) }], details },
          },
          OTHER,
        ),
      );
    }
    await until(() => client.state.transcripts[OTHER]!.runs[0]?.steps.length === MAX_FOLLOW_UPS);
    await client.stopRun(OTHER, "run-o");
    gateway.emit(
      "agent",
      agentEvent(
        "run-o",
        90,
        "lifecycle",
        { phase: "end", status: "cancelled", aborted: true },
        OTHER,
      ),
    );
    await until(
      () =>
        abortsOf(gateway).filter((each) => each.sessionKey === JUNIPER).length === MAX_FOLLOW_UPS,
    );
    await sleep(30);
    client.closeSession(OTHER);
    // A reconnect to the same gateway: those waits can stop nothing any more.
    const sockets = gateway.sockets.length;
    gateway.dropAll();
    await until(
      () => gateway.sockets.length > sockets && client.state.connection.status === "connected",
    );
    await until(() => transcript().status === "ready");
    await stopTheExchange(opened);
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => abortsOf(gateway).some((each) => each.runId === "run-f"));
    client.stop();
  });
});

describe("the gateway's own turn at the edges (#842)", () => {
  /** The client reads the task's history, with no run in flight. */
  async function read(gateway: FakeGateway, rows: unknown[]) {
    const before = gateway.calls("chat.history").length;
    gateway.handlers["chat.history"] = () => ({ messages: rows, hasMore: false });
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("chat.history").length > before);
    await sleep(30);
  }

  it.each([
    ["missed", false],
    ["seen live", true],
  ])(
    "#842: the gateway's turn that ended unread with no reply row is the awaited one by its row: the bot's own later message runs (its events %s)",
    async (_, seen) => {
      const opened = await openTask();
      const { client, gateway } = opened;
      aborting(gateway);
      await stopTheExchange(opened);
      // The model answered the gateway's note with nothing, and the turn ended before any read.
      if (seen) {
        gateway.emit("agent", {
          ...agentEvent("run-f", 1, "lifecycle", { phase: "start" }),
          ts: 1_500,
        });
        gateway.emit("agent", {
          ...agentEvent("run-f", 2, "lifecycle", { phase: "end", status: "completed" }),
          ts: 1_600,
        });
        await until(() => run(opened, "run-f")?.state === "completed");
      }
      await read(gateway, [startedRow("run-f", fromPeer)]);
      // No run of its own keyed to its row.
      expect(run(opened, "run-f")?.anchorKeyed).toBeUndefined();
      // Then Marlow, asked again in its own task, messages this one.
      await turnStarts(
        gateway,
        "run-m",
        [startedRow("run-f", fromPeer), startedRow("run-m", fromPeer, "Here is the plan.")],
        1_900,
      );
      await until(() => run(opened, "run-m") !== undefined);
      await sleep(50);
      expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r"]);
      client.stop();
    },
  );

  it("#842: a turn the gateway gave no start time for is not placed after the Stop, and runs", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    // History only: no start event, and a snapshot without `startedAt`.
    const before = gateway.calls("chat.history").length;
    gateway.handlers["chat.history"] = () => ({
      messages: [startedRow("run-f", fromPeer)],
      inFlightRun: { runId: "run-f", status: "running", events: [] },
      hasMore: false,
    });
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("chat.history").length > before);
    await until(() => run(opened, "run-f")?.state === "running");
    await sleep(50);
    expect(run(opened, "run-f")!.reportedStartAt).toBeNull();
    expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r"]);
    client.stop();
  });

  it("#842: the wall clock set forward doesn't end the wait: the gateway's turn is still stopped", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + FOLLOW_UP_WAIT_MS + 60_000);
    await turnStarts(gateway, "run-f", [startedRow("run-f", fromPeer)]);
    await until(() => abortsOf(gateway).some((each) => each.runId === "run-f"));
    client.stop();
  });

  it("#842: a message the person sends while the wait is open is never stopped, before or after the gateway's unread turn", async () => {
    const opened = await openTask();
    const { client, gateway } = opened;
    aborting(gateway);
    await stopTheExchange(opened);
    const mine = (id: string, text: string) => ({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 2_000,
      idempotencyKey: `${id}:user`,
      __openclaw: { id: `row-${id}`, idempotencyKey: `${id}:user` },
    });
    gateway.handlers["chat.send"] = () => ({ runId: "run-mine", status: "started" });
    client.sendMessage(KEY, "Go on with the plan.");
    await until(() => gateway.calls("chat.send").length === 1);
    const first = mine("run-mine", "Go on with the plan.");
    await turnStarts(gateway, "run-mine", [first], 1_400);
    await until(() => run(opened, "run-mine") !== undefined);
    gateway.emit(
      "agent",
      agentEvent("run-mine", 80, "lifecycle", { phase: "end", status: "completed" }),
    );
    await until(() => run(opened, "run-mine")?.state === "completed");
    await read(gateway, [first, startedRow("run-f", fromPeer)]);
    gateway.handlers["chat.send"] = () => ({ runId: "run-mine-2", status: "started" });
    client.sendMessage(KEY, "And check the tests.");
    await until(() => gateway.calls("chat.send").length === 2);
    await turnStarts(
      gateway,
      "run-mine-2",
      [first, startedRow("run-f", fromPeer), mine("run-mine-2", "And check the tests.")],
      1_900,
    );
    await until(() => run(opened, "run-mine-2") !== undefined);
    await sleep(50);
    expect(abortsOf(gateway).map((each) => each.runId)).toEqual(["run-s", "run-r"]);
    client.stop();
  });
});
