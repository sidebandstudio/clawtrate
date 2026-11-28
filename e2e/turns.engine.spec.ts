// The engine itself against this run's development gateway, without the
// interface: the orders of events and answers that a person cannot time by
// hand, made exact. Each check pairs a client of its own, uses tasks of its
// own, waits for the gateway to be idle in them before it ends, and unpairs.
// Named to run after the preview and scenario checks (files run in name order):
// the tasks it makes would change the seeded counts those read.

import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClawtrateClient } from "../packages/core/src/client.ts";
import { replyRow, runningRunId, textPlaced } from "../packages/core/src/runs.ts";
import { createNodeHost } from "../packages/core/src/node/index.ts";
import { HOLD_PATH } from "../tools/dev-gateway/src/fake-provider.ts";
import {
  instanceForm,
  instancePorts,
  openInstance,
  openOperator,
  readDevConnection,
} from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Engine = { client: ClawtrateClient; close: () => Promise<void> };

/** A client paired with this run's instance, with write access. */
async function engine(name: string): Promise<Engine> {
  const inst = openInstance(INSTANCE);
  const connection = readDevConnection(inst.connectionFile)!;
  const dataDir = mkdtempSync(join(tmpdir(), "clawtrate-e2e-engine-"));
  const host = createNodeHost({
    dataDir,
    client: { displayName: `Clawtrate ${name}`, version: "0.0.0", platform: process.platform },
  });
  const client = new ClawtrateClient(host, {});
  await client.start();
  await client.connect({ url: connection.url, token: connection.token });
  const approved = new Set<string>();
  const approve = async (requestId: string | null | undefined) => {
    if (!requestId || approved.has(requestId)) return;
    approved.add(requestId);
    const out = await inst.runner.run(["devices", "approve", requestId]);
    if (out.status !== 0) throw new Error(`could not approve ${requestId}: ${out.stderr}`);
  };
  await expect
    .poll(
      async () => {
        await approve(client.state.connection.pairing?.requestId);
        return client.state.connection.status;
      },
      { timeout: 60_000 },
    )
    .toBe("connected");
  if (!client.state.connection.canWrite) {
    await client.requestAccess();
    await expect
      .poll(
        async () => {
          await approve(client.state.connection.upgrade.requestId);
          return client.state.connection.canWrite;
        },
        { timeout: 60_000 },
      )
      .toBe(true);
  }
  const { deviceId } = await host.signer.loadIdentity();
  return {
    client,
    close: async () => {
      client.stop();
      await inst.runner.run(["devices", "remove", deviceId]);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A new task of Otto's, open in the client, history loaded. */
async function openNewTask(client: ClawtrateClient, tag: string): Promise<string> {
  const key = `agent:otto:e2e-${tag}-${randomBytes(3).toString("hex")}`;
  client.openSession(key);
  await expect.poll(() => client.state.transcripts[key]?.status, { timeout: 30_000 }).toBe("ready");
  return key;
}

/**
 * What the gateway has in flight and waiting in the task. An input it withdrew stays listed as
 * `cancelled`, and waits for nothing.
 */
async function gatewayWork(op: OperatorSession, key: string) {
  const history = await op.request<{
    inFlightRun?: { runId?: string };
    pendingInputs?: { items?: Array<{ runId?: string; state?: string }> };
  }>("chat.history", { sessionKey: key, limit: 1 });
  return {
    inFlight: history.inFlightRun ? (history.inFlightRun.runId ?? "unnamed") : null,
    pending: (history.pendingInputs?.items ?? [])
      .filter((item) => item.state !== "cancelled")
      .map((item) => [item.runId, item.state]),
  };
}

/** Whether the gateway has nothing in flight or waiting in the task. */
async function gatewayIdle(op: OperatorSession, key: string): Promise<boolean> {
  const work = await gatewayWork(op, key);
  return work.inFlight === null && work.pending.length === 0;
}

const runs = (client: ClawtrateClient, key: string) => client.state.transcripts[key]?.runs ?? [];

/** The scripted model's holds on a task's replies (`ReplyHolds` in the development tool). */
function replyHolds() {
  const url = `http://127.0.0.1:${instancePorts(openInstance(INSTANCE)).providerPort}${HOLD_PATH}`;
  return {
    post: async (session: string, action: "hold" | "next" | "release") => {
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ session, action }),
      });
      if (!response.ok)
        throw new Error(`hold ${action}: ${response.status} ${await response.text()}`);
    },
    /** Until the task's `n`th reply since the hold waits before its end. */
    reached: (session: string, n: number) =>
      expect
        .poll(
          async () => {
            const state = (await (
              await fetch(`${url}?session=${encodeURIComponent(session)}`)
            ).json()) as { reached: number; waiting: number };
            return state.waiting > 0 ? state.reached : 0;
          },
          { message: `the task's reply ${n} waits before its end`, timeout: 60_000 },
        )
        .toBe(n),
  };
}

let op: OperatorSession;
test.beforeAll(async () => {
  op = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate engine check",
    ["operator.read", "operator.write"],
    ["tool-events"],
  );
  // sessions.changed, which names a queued turn's own run id, reaches only a subscribed client.
  await op.request("sessions.subscribe", {});
});
test.afterAll(async () => {
  await op?.close();
  if (op?.deviceId) await openInstance(INSTANCE).runner.run(["devices", "remove", op.deviceId]);
});

test("F-097: Stop pressed before the gateway has taken the send stops the turn on the gateway", async () => {
  const { client, close } = await engine("early stop check");
  try {
    const key = await openNewTask(client, "early-stop");
    const id = client.sendMessage(key, "Take your time. #slow 20");
    // In the same turn of the event loop: the gateway cannot have answered the send yet.
    expect(runs(client, key)[0]).toMatchObject({ id, bound: false, state: "running" });
    await client.stopRun(key, id);
    expect(runs(client, key)[0]!.state).toBe("stopping");
    // Stopped by the gateway, well before the 20-second turn could have finished by itself.
    await expect.poll(() => runs(client, key)[0]?.state, { timeout: 15_000 }).toBe("stopped");
    expect(runs(client, key)[0]!.finishedBeforeStop).not.toBe(true);
    await expect.poll(() => gatewayIdle(op, key), { timeout: 15_000 }).toBe(true);
  } finally {
    await close();
  }
});

test("a turn the gateway runs from its queue under an id of its own is one run, and it ends", async () => {
  const { client, close } = await engine("queued turn check");
  try {
    const key = await openNewTask(client, "queued-turn");
    // Another device's two sends: the second waits in the gateway's queue behind the first.
    const first = await op.send(key, "First, slowly. #slow 6", { queueMode: "followup" });
    await op.waitFor(
      "the first turn's reasoning",
      (e) =>
        e.event === "agent" &&
        (e.payload as { runId?: string }).runId === first.runId &&
        (e.payload as { stream?: string }).stream === "thinking",
    );
    // A follow-up, not a steer: the gateway queues it behind the first turn.
    const second = await op.send(key, "Then this. #text", { queueMode: "followup" });
    const ids = [first.runId, second.runId] as string[];
    // The gateway's own id for the queued turn, named beside the send's id. 2026.11.10 runs the
    // queued turn under the send's id and names none.
    const own = instanceForm(openInstance(INSTANCE)).queuedTurnOwnId
      ? (
          (
            await op.waitFor("the queued turn's own id", (e) => {
              const p = e.payload as { runId?: string; clientRunId?: string };
              return (
                e.event === "sessions.changed" &&
                p.clientRunId === second.runId &&
                p.runId !== second.runId
              );
            })
          ).payload as { runId: string }
        ).runId
      : null;
    await expect.poll(() => gatewayIdle(op, key), { timeout: 60_000 }).toBe(true);
    await expect
      .poll(() => runs(client, key).map((run) => [run.id, run.state]), { timeout: 15_000 })
      .toEqual(ids.map((runId) => [runId, "completed"]));
    await sleep(500);
    if (own) expect(runs(client, key).some((run) => run.id === own)).toBe(false);
    expect(runs(client, key).map((run) => [run.id, run.state])).toEqual(
      ids.map((runId) => [runId, "completed"]),
    );
  } finally {
    await close();
  }
});

test("F-088: text the bot writes beside an action is beside that action from the moment it starts, never its reply", async () => {
  const { client, close } = await engine("text beside a call check");
  const beside = "I will look first, then answer that message.";
  let key = "";
  // Each state the engine published once the run held its call: the text placed before that call.
  const seen: string[][] = [];
  const stop = client.store.subscribe((state) => {
    for (const run of state.transcripts[key]?.runs ?? []) {
      const call = run.steps.find((step) => step.kind === "tool" && step.toolName === "ls");
      if (!call) continue;
      seen.push(
        (run.preambles ?? [])
          .filter((p) => p.beforeCall === call.toolCallId)
          .map((p) => p.text.trim()),
      );
    }
  });
  try {
    key = await openNewTask(client, "beside");
    // The scripted model writes text and lists a folder in one message, then answers. 2026.10.6
    // sends the text as a `preamble` item; 2026.11.10 as an `assistant` item of its own only.
    client.sendMessage(key, "#reply-to");
    await expect.poll(() => runs(client, key)[0]?.state, { timeout: 60_000 }).toBe("completed");
    await expect.poll(() => gatewayIdle(op, key), { timeout: 15_000 }).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((texts) => texts.join() !== beside)).toEqual([]);
    const run = runs(client, key)[0]!;
    expect(run.text.trim()).toBe("This answers no message: none was named.");
  } finally {
    stop();
    await close();
  }
});

/**
 * Each state in which a run still draws its reply and history already holds that reply's row:
 * the row is found here by its words, which the app never compares, and each such state records
 * whether the engine ties the reply to it (`replyRow`): null when it does, the rows otherwise.
 */
function heldReplies(client: ClawtrateClient, key: () => string) {
  const held: Array<string | null> = [];
  const stop = client.store.subscribe((state) => {
    const transcript = state.transcripts[key()];
    for (const run of transcript?.runs ?? []) {
      const reply = run.text.trim();
      if (run.state !== "running" || !reply || textPlaced(run)) continue;
      const rows = transcript!.items.flatMap((item) =>
        item.blocks.flatMap((block, i) =>
          block.kind === "text" && block.text.trim() === reply ? [`${item.id}#${i}`] : [],
        ),
      );
      if (rows.length === 0) continue;
      const tied = replyRow(run, transcript!.items);
      held.push(tied && rows.includes(`${tied.itemId}#${tied.block}`) ? null : rows.join());
    }
  });
  return { held, stop };
}

test("#872: while a run still draws its reply, history's row of that reply is known as the reply's", async () => {
  test.setTimeout(180_000);
  // The gateway writes the answer's row when its message ends and ends the run right after: a
  // moment of 30 to 60 ms on 2026.10.6, often over before a read can land on 2026.11.10 and later,
  // where the row is announced and history read through the task's session actor. So the check
  // holds that moment open. The scripted model holds each reply in the task before its end until
  // the check lets it end, and a steer the gateway keeps for the answer's end makes the run ask
  // the model once more: that reply stays held, with the answer's row written, while history is
  // read.
  const { client, close } = await engine("reply drawn once check");
  let key = "";
  const { held, stop } = heldReplies(client, () => key);
  const hold = replyHolds();
  try {
    key = await openNewTask(client, "reply-once");
    await hold.post(key, "hold");
    // The scripted model thinks, writes beside a call that fails, and answers in a message of its
    // own: F-551's run.
    const id = client.sendMessage(key, "Look for my old notes. #think #tool-fail");
    await hold.reached(key, 1);
    await hold.post(key, "next");
    // The answer has streamed and waits before its end: its row is not written yet.
    await hold.reached(key, 2);
    await expect
      .poll(() => runs(client, key).find((run) => run.id === id)?.text ?? "")
      .toContain("That file does not exist");
    const steer = client.sendMessage(key, "Then run the slow tool. #slow-tool 1");
    // In the gateway's keeping for this task: its receipt waits, and it is not a turn queued behind
    // the run (`queued`), which runs on its own once the run has ended.
    await expect
      .poll(
        async () => {
          const history = await op.request<{
            inputReceipts?: Array<{ runId?: string; state?: string; queued?: boolean }>;
          }>("chat.history", { sessionKey: key, limit: 1, inputRunIds: [steer] });
          const receipt = history.inputReceipts?.find((each) => each.runId === steer);
          return receipt ? `${receipt.state}${receipt.queued ? " queued" : ""}` : "none";
        },
        { message: "the run took the steer in", timeout: 30_000 },
      )
      .toBe("pending");
    // The receipt is written when the steer is sent; the gateway then hands it to the active run,
    // which drains it at the answer's end. No read or event tells when that hand-over is done, so
    // the answer stays held well past it (a few hundred ms at most, on a loaded machine).
    await sleep(3_000);
    await hold.post(key, "next");
    // The answer's message ends and its row is written; the steer joins the run at that end, and
    // the model's next reply (reasoning and a call, no text) waits before its end. Until the check
    // lets it go, the run still draws the answer, and history holds the answer's row.
    await hold.reached(key, 3);
    expect(
      runs(client, key).find((run) => run.id === id)?.state,
      "the steer joined the answer's run",
    ).toBe("running");
    client.reloadSession(key);
    await expect
      .poll(() => held.length, {
        message: "history held the answer's row while the run still drew it",
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    expect(held.filter((row) => row !== null)).toEqual([]);
    await hold.post(key, "release");
    await expect
      .poll(() => runs(client, key).find((run) => run.id === id)?.state, { timeout: 60_000 })
      .toBe("completed");
    await expect.poll(() => gatewayIdle(op, key), { timeout: 15_000 }).toBe(true);
  } finally {
    if (key) await hold.post(key, "release");
    stop();
    await close();
  }
});

test("#872 #738: an answer a steer kept going is known by its row while the steered message's tool runs", async () => {
  const { client, close } = await engine("answer before a steer check");
  let key = "";
  const { held, stop } = heldReplies(client, () => key);
  try {
    key = await openNewTask(client, "steered-answer");
    // A text-only answer streamed slowly; a steer joins after it, and the model's next message is
    // reasoning and a slow call with no text. All the while the answer is the run's reply, and
    // history holds its row.
    const id = client.sendMessage(key, "Answer slowly. #slow 3");
    await expect
      .poll(() => runs(client, key)[0]?.text ?? "", { timeout: 60_000 })
      .toContain("part 1");
    client.sendMessage(key, "Then run the slow tool. #slow-tool 8");
    await expect
      .poll(() => runs(client, key).find((run) => run.id === id)?.state, { timeout: 90_000 })
      .toBe("completed");
    await expect.poll(() => gatewayIdle(op, key), { timeout: 15_000 }).toBe(true);
    // Where the steer joined the run (the answer's run holds a call: `#slow` makes none), the
    // moment happened, and in every state of it the row was the reply's. Where the steer ran as a
    // turn of its own, the answer's run ended first and nothing was drawn twice.
    const joined = runs(client, key)
      .find((run) => run.id === id)!
      .steps.some((step) => step.kind === "tool");
    if (joined) expect(held.length).toBeGreaterThan(0);
    expect(held.filter((row) => row !== null)).toEqual([]);
  } finally {
    stop();
    await close();
  }
});

test("F-097: a run stopped during a connection gap ends on the gateway's word, and Stop is offered on the current run", async () => {
  const { client, close } = await engine("missed end check");
  try {
    const key = await openNewTask(client, "missed-end");
    // Another device's turn, followed here until this client goes away mid-tool.
    const original = String((await op.send(key, "#slow-tool 15")).runId);
    await expect
      .poll(
        () =>
          runs(client, key)
            .find((run) => run.id === original)
            ?.steps.some((step) => step.kind === "tool"),
        { timeout: 30_000 },
      )
      .toBe(true);
    await client.suspend();
    // That device stops it and sends again while this one is away: history's rows stop at the
    // call, so they do not say the run ended, and the new run is in flight.
    await op.request("chat.abort", { sessionKey: key, runId: original });
    const current = String((await op.send(key, "Next. #slow 20")).runId);
    await expect
      .poll(
        async () =>
          (
            await op.request<{ inFlightRun?: { runId?: string } }>("chat.history", {
              sessionKey: key,
              limit: 1,
            })
          ).inFlightRun?.runId,
        { timeout: 15_000 },
      )
      .toBe(current);
    await client.retryNow();
    await expect
      .poll(() => runs(client, key).map((run) => [run.id, run.state]), { timeout: 15_000 })
      .toEqual([
        [original, "stopped"],
        [current, "running"],
      ]);
    expect(runs(client, key)[0]!.outcomeKnown).toBe(true);
    // Stop is offered on the current run and names it. The gateway lets only the device that
    // started a run abort it, so that device stops it.
    expect(runningRunId(client.state.transcripts[key]!, current)).toBe(current);
    const ended = op.terminal(current, 30_000);
    await op.request("chat.abort", { sessionKey: key, runId: current });
    expect((await ended).state).toBe("aborted");
    await expect.poll(() => runs(client, key)[1]?.state, { timeout: 15_000 }).toBe("stopped");
    // Polled as what is left, so a cleanup that fails names the run that holds the task.
    await expect
      .poll(() => gatewayWork(op, key), { timeout: 30_000 })
      .toEqual({ inFlight: null, pending: [] });
  } finally {
    await close();
  }
});
