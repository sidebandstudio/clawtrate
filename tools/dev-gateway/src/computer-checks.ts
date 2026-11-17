// The computer checks: the clawtrate-computer plugin on a real development
// gateway, asserted from the gateway's answers. `pnpm scenarios` runs them on
// an instance of their own started with `--with-plugin clawtrate-computer`,
// whose `botBrowsers` gives Marlow and Pip browsers of their own.
//
// Clients: two paired operators with read and write (the holder and another
// device) and a read-only one. A further operator is opened and closed by the
// check of a caller that leaves. Bots act through the scripted model's
// browser directives (#browse, #browse-read, #browse-slow, #browse-outside).

import { spawnSync } from "node:child_process";
import { browserProcesses, listProcesses } from "./cli.ts";
import type { OperatorSession, GatewayEvent } from "./operator.ts";
import { OTHER_LOOPBACK, OUTSIDE_ADDRESS } from "./scenarios.ts";
import { PAGES_RECORD_PATH, REFUSED_TITLE, SLOW_PAGE_MS, type Refusal } from "./scripted-pages.ts";

type JsonRecord = Record<string, unknown>;
const rec = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ComputerCheckFailure extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ComputerCheckFailure(message);
}
const show = (value: unknown) => JSON.stringify(value)?.slice(0, 300) ?? String(value);
function same(actual: unknown, expected: unknown, what: string): void {
  expect(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${what}: expected ${show(expected)}, got ${show(actual)}`,
  );
}

export const COMPUTER_CLIENTS = {
  holder: { scopes: ["operator.read", "operator.write"], caps: ["tool-events"] },
  other: { scopes: ["operator.read", "operator.write"], caps: ["tool-events"] },
  reader: { scopes: ["operator.read"], caps: ["tool-events"] },
} as const;
export type ComputerClient = keyof typeof COMPUTER_CLIENTS;

/** The message the plugin blocks a bot's browser call with (plugins/clawtrate-computer). */
export const BLOCKED_WHILE_HELD =
  "A person has control of this bot's browser. Wait until they give it back.";
const CONTROL_EVENT = "plugin.clawtrate-computer.control";
const GENERATION = /^[0-9a-f]{32}$/;
/** What the sign-in page says once the person's input has reached it. */
const SIGNED_IN = "Signed in: yes. Clicks: 1. Name: scripted reader. Scrolled: yes.";

export type ComputerContext = {
  clients: Record<ComputerClient, OperatorSession>;
  /** Open one more read-and-write operator, which the check closes itself. */
  openExtra(label: string): Promise<OperatorSession>;
  gatewayPort: number;
  /** The scripted pages' origin, `http://127.0.0.1:<port>`. */
  pagesOrigin: string;
  /** The instance's state folder, which names its browser's profiles in their processes' arguments. */
  stateDir: string;
  /** The two bots with browsers of their own, and each one's debugging port. */
  bots: { id: string; cdpPort: number }[];
  /** How long a lease or view lives without renewal, as configured. */
  renewTimeoutMs: number;
  drainTimeoutMs: number;
};

type ToolCall = {
  name: string;
  args: JsonRecord;
  isError: boolean;
  text: string;
  details: JsonRecord;
};
type BotRun = { state: string; calls: ToolCall[]; reply: string };

/** What one bot run did: its end, its tool calls with their results, its final text. */
async function botRun(op: OperatorSession, key: string, message: string): Promise<BotRun> {
  const sent = await op.send(key, message);
  const runId = String(sent.runId);
  const end = await op.terminal(runId, 120_000);
  await sleep(300);
  const calls: ToolCall[] = [];
  for (const event of op.runEvents(runId)) {
    const payload = rec(event.payload);
    if (event.event !== "agent" || payload.stream !== "tool") continue;
    const data = rec(payload.data);
    if (data.phase === "start") {
      calls.push({
        name: String(data.name),
        args: rec(data.args),
        isError: false,
        text: "",
        details: {},
      });
    } else if (data.phase === "result") {
      const call = calls.at(-1);
      if (!call) continue;
      const result = rec(data.result);
      const blocks = Array.isArray(result.content) ? (result.content as JsonRecord[]) : [];
      call.isError = data.isError === true;
      call.text = blocks.map((block) => String(block.text ?? "")).join("\n");
      call.details = rec(result.details);
    }
  }
  const message_ = rec(end.message);
  const content = Array.isArray(message_.content) ? (message_.content as JsonRecord[]) : [];
  return {
    state: String(end.state),
    calls,
    reply: content.map((block) => String(block.text ?? "")).join(""),
  };
}

type Answer =
  { ok: true; payload: JsonRecord } | { ok: false; code: string; reason: string; message: string };

/** Call one of the plugin's methods and return its answer, refused or not. */
async function call(op: OperatorSession, method: string, params: JsonRecord): Promise<Answer> {
  try {
    return {
      ok: true,
      payload: rec(await op.request(`clawtrate-computer.${method}`, params, 30_000)),
    };
  } catch (error) {
    const e = rec(error);
    return {
      ok: false,
      code: String(e.gatewayCode ?? e.code ?? ""),
      reason: String(rec(e.details).reason ?? ""),
      message: String(e.message ?? error),
    };
  }
}

function answered(answer: Answer, what: string): JsonRecord {
  expect(
    answer.ok,
    `${what} was refused: ${answer.ok ? "" : `${answer.code} ${answer.reason} ${answer.message}`}`,
  );
  return answer.payload;
}

function refused(answer: Answer, code: string, reason: string | null, what: string): void {
  expect(!answer.ok, `${what} was answered: ${show(answer.ok ? answer.payload : null)}`);
  same(answer.code, code, `${what}: error code`);
  if (reason !== null) same(answer.reason, reason, `${what}: reason`);
}

/** The control event about one lease in one state, already received or still to come. */
const controlEvent = (
  op: OperatorSession,
  generation: string,
  state: string,
  timeoutMs = 20_000,
): Promise<GatewayEvent> =>
  op.waitFor(
    `a ${state} control event for lease ${generation.slice(0, 8)}`,
    (event) =>
      event.event === CONTROL_EVENT &&
      rec(event.payload).generation === generation &&
      rec(event.payload).state === state,
    timeoutMs,
  );

const controlStates = (op: OperatorSession, generation: string) =>
  op.events
    .filter((e) => e.event === CONTROL_EVENT && rec(e.payload).generation === generation)
    .map((e) => String(rec(e.payload).state));

type Stream = {
  socket: WebSocket;
  texts: JsonRecord[];
  frames: { header: JsonRecord; jpeg: boolean }[];
  closed: Promise<{ code: number; reason: string }>;
};

/** Open a view's stream on the gateway and collect what it sends. */
function openStream(ctx: ComputerContext, wsPath: string): Promise<Stream> {
  const socket = new WebSocket(`ws://127.0.0.1:${ctx.gatewayPort}${wsPath}`);
  socket.binaryType = "arraybuffer";
  const stream: Stream = {
    socket,
    texts: [],
    frames: [],
    closed: new Promise((resolve) =>
      socket.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason }),
      ),
    ),
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      stream.texts.push(rec(JSON.parse(event.data)));
      return;
    }
    const bytes = Buffer.from(event.data as ArrayBuffer);
    const length = bytes.readUInt32BE(0);
    stream.frames.push({
      header: rec(JSON.parse(bytes.subarray(4, 4 + length).toString("utf8"))),
      jpeg: bytes[4 + length] === 0xff && bytes[5 + length] === 0xd8,
    });
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ComputerCheckFailure("the stream did not open in 15 s")),
      15_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(stream);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new ComputerCheckFailure("the stream was refused"));
    });
  });
}

/** Resolves when `test` holds, checking every 100 ms, or fails at the deadline. */
async function until(what: string, test: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() > deadline)
      throw new ComputerCheckFailure(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(100);
  }
}

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new ComputerCheckFailure(`timed out after ${ms} ms waiting for ${what}`)),
        ms,
      ),
    ),
  ]);

/**
 * The check's own connection to one tab of a bot's browser, through its
 * debugging port on loopback, recording when each frame starts loading and
 * commits a navigation. It sends nothing to the page but `Page.enable`.
 */
async function watchTab(cdpPort: number, targetId: string) {
  const list = (await (
    await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(10_000) })
  ).json()) as JsonRecord[];
  const target = list.find((t) => t.id === targetId);
  expect(target, `the bot's browser does not list tab ${targetId}`);
  const url = String(target.webSocketDebuggerUrl);
  expect(
    url === `ws://127.0.0.1:${cdpPort}/devtools/page/${targetId}`,
    `unexpected debugger URL ${url}`,
  );
  const socket = new WebSocket(url);
  const seen: { at: number; method: string; url: string }[] = [];
  socket.addEventListener("message", (event) => {
    const message = rec(JSON.parse(String(event.data)));
    const method = String(message.method ?? "");
    if (["Page.frameStartedLoading", "Page.frameNavigated"].includes(method)) {
      seen.push({ at: Date.now(), method, url: String(rec(rec(message.params).frame).url ?? "") });
    }
  });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new ComputerCheckFailure("no CDP connection")));
    }),
    10_000,
    "the check's connection to the tab",
  );
  socket.send(JSON.stringify({ id: 1, method: "Page.enable", params: {} }));
  return { seen, close: () => socket.close() };
}

/** Whether an address as `lsof -nP` prints it is on loopback. */
const onLoopback = (address: string) =>
  /^127\.\d+\.\d+\.\d+:/.test(address) || address.startsWith("[::1]:");

/**
 * The internet sockets of the instance's browser processes that are not on
 * loopback, local or remote end, as `lsof` lists them; null when the
 * processes or their sockets cannot be listed.
 */
function offLoopbackSockets(stateDir: string): { pids: number; sockets: string[] } | null {
  const rows = listProcesses();
  if (!rows) return null;
  const pids = browserProcesses(stateDir, rows);
  if (pids.length === 0) return { pids: 0, sockets: [] };
  const result = spawnSync("lsof", ["-nP", "-a", "-p", pids.join(","), "-i"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  // 1: none of them has an internet socket at this moment.
  if (result.error || (result.status !== 0 && result.status !== 1)) return null;
  const sockets: string[] = [];
  for (const line of result.stdout.split("\n").slice(1)) {
    const match = /\s(TCP|UDP)\s+(\S+?)(?:->(\S+))?(?:\s|$)/.exec(line);
    if (!match) continue;
    const [, protocol, local, remote] = match;
    if (!onLoopback(local!) || (remote !== undefined && !onLoopback(remote))) {
      sockets.push(`${protocol} ${local}${remote ? `->${remote}` : ""}`);
    }
  }
  return { pids: pids.length, sockets };
}

/** Shared between the checks, which run in order. */
type World = {
  stamp: string;
  /** Each bot's check session and the tab its #browse opened. */
  tabs: Map<string, { key: string; targetId: string }>;
  /** The lease the holder took in "taking control blocks…", released later. */
  generation?: string;
};

export type ComputerCheck = {
  name: string;
  /** The scripted directives it sends. */
  covers: string[];
  run(ctx: ComputerContext, world: World): Promise<void>;
};

const tabsOf = async (op: OperatorSession, key: string) =>
  (answered(await call(op, "tabs", { sessionKey: key }), "tabs").tabs ?? []) as JsonRecord[];

export const COMPUTER_CHECKS: ComputerCheck[] = [
  {
    name: "a bot opens a scripted loopback page in its own browser",
    covers: ["#browse"],
    async run(ctx, world) {
      const { holder } = ctx.clients;
      for (const bot of ctx.bots) {
        const key = `agent:${bot.id}:computer-${world.stamp}`;
        for (const op of Object.values(ctx.clients)) {
          await op.request("sessions.messages.subscribe", { key });
        }
        const run = await botRun(holder, key, "#browse");
        same(run.state, "final", `${bot.id}'s #browse run`);
        same(
          run.calls.map((c) => c.name),
          ["browser"],
          `${bot.id}'s tool calls`,
        );
        const [open] = run.calls;
        same(
          open!.args,
          { action: "open", url: `${ctx.pagesOrigin}/scripted/pages/sign-in` },
          "the open call",
        );
        expect(!open!.isError, `the open call failed: ${open!.text.slice(0, 200)}`);
        const targetId = String(open!.details.targetId ?? "");
        expect(
          /^[A-F0-9]{32}$/.test(targetId),
          `no targetId in the open result: ${show(open!.details)}`,
        );
        same(open!.details.title, "Scripted sign-in", "the opened page's title");
        const listing = answered(
          await call(holder, "tabs", { sessionKey: key }),
          `${bot.id}'s tabs`,
        );
        same(listing.profile, `bot-${bot.id}`, `${bot.id}'s browser profile`);
        same(listing.browser, "running", `${bot.id}'s browser`);
        const tab = (listing.tabs as JsonRecord[]).find((t) => t.targetId === targetId);
        expect(tab, `${bot.id}'s tabs do not list the opened tab`);
        same(
          [tab.url, tab.title, tab.lease],
          [`${ctx.pagesOrigin}/scripted/pages/sign-in`, "Scripted sign-in", null],
          "the tab as listed",
        );
        world.tabs.set(bot.id, { key, targetId });
      }
    },
  },
  {
    name: "a second bot's browser is not visible through the first bot's session",
    covers: [],
    async run(ctx, world) {
      const { holder } = ctx.clients;
      const [first, second] = ctx.bots.map((bot) => world.tabs.get(bot.id)!);
      expect(first && second, "the tabs of the first check are missing");
      const listed = (await tabsOf(holder, first.key)).map((t) => t.targetId);
      expect(!listed.includes(second.targetId), "the first bot's tabs list the second bot's tab");
      for (const method of ["view.open", "control.take"]) {
        refused(
          await call(holder, method, { sessionKey: first.key, targetId: second.targetId }),
          "FORBIDDEN",
          "tab_not_in_bots_browser",
          `${method} on the second bot's tab through the first bot's session`,
        );
      }
      refused(
        await call(holder, "view.renew", {
          sessionKey: first.key,
          targetId: second.targetId,
          streamId: "x",
        }),
        "FORBIDDEN",
        "tab_not_in_bots_browser",
        "view.renew on the second bot's tab through the first bot's session",
      );
      const own = (await tabsOf(holder, second.key)).map((t) => t.targetId);
      expect(own.includes(second.targetId), "the second bot's own session does not list its tab");
    },
  },
  {
    name: "a read-only connection gets no tabs, tickets, frames or input path",
    covers: [],
    async run(ctx, world) {
      const { reader } = ctx.clients;
      const { key, targetId } = world.tabs.get(ctx.bots[0]!.id)!;
      const params = { sessionKey: key, targetId };
      for (const [method, extra] of [
        ["tabs", {}],
        ["view.open", {}],
        ["view.renew", { streamId: "x" }],
        ["control.take", {}],
        ["control.release", { generation: "0".repeat(32) }],
        ["input", { generation: "0".repeat(32), kind: "click", x: 1, y: 1 }],
      ] as const) {
        const answer = await call(reader, method, { ...params, ...extra });
        expect(
          !answer.ok,
          `${method} answered a read-only connection: ${show(answer.ok && answer.payload)}`,
        );
        expect(
          /scope|operator\.write/i.test(answer.message),
          `${method} refused a read-only connection for another reason: ${answer.code} ${answer.message}`,
        );
      }
      const tickets = reader.events.filter((e) => JSON.stringify(e.payload).includes("ticket="));
      same(tickets.length, 0, "events carrying a ticket on the read-only connection");
    },
  },
  {
    name: "a watcher gets a ticket and frames",
    covers: [],
    async run(ctx, world) {
      const { holder } = ctx.clients;
      const { key, targetId } = world.tabs.get(ctx.bots[0]!.id)!;
      const opened = answered(
        await call(holder, "view.open", { sessionKey: key, targetId }),
        "view.open",
      );
      const wsPath = String(opened.wsPath);
      expect(
        /^\/clawtrate-computer\/stream\?ticket=[0-9a-f]{48}$/.test(wsPath),
        `wsPath ${wsPath}`,
      );
      const ttl = Number(opened.expiresAtMs) - Date.now();
      expect(ttl > 0 && ttl <= 60_000, `the ticket lives ${ttl} ms`);
      same(opened.renewWithinMs, ctx.renewTimeoutMs, "renewWithinMs");
      const stream = await openStream(ctx, wsPath);
      try {
        await until(
          "the ready message and a frame",
          () => stream.texts.length > 0 && stream.frames.length > 0,
          15_000,
        );
        same(
          stream.texts[0],
          {
            type: "ready",
            targetId,
            url: `${ctx.pagesOrigin}/scripted/pages/sign-in`,
            title: "Scripted sign-in",
          },
          "the stream's first message",
        );
        const [frame] = stream.frames;
        same(
          Object.keys(frame!.header).sort(),
          ["cssHeight", "cssWidth", "scrollX", "scrollY", "ts", "url"],
          "a frame's header",
        );
        expect(frame!.jpeg, "a frame is not a JPEG");
        const renewed = answered(
          await call(holder, "view.renew", {
            sessionKey: key,
            targetId,
            streamId: opened.streamId,
          }),
          "view.renew",
        );
        same(
          [renewed.streamRenewed, renewed.leaseRenewed],
          [true, false],
          "what the renewal renewed",
        );
        // The ticket was used once; it never opens a second stream.
        await openStream(ctx, wsPath).then(
          (again) => {
            again.socket.close();
            throw new ComputerCheckFailure("a used ticket opened a second stream");
          },
          () => {},
        );
      } finally {
        stream.socket.close();
      }
      same(
        (await withTimeout(stream.closed, 10_000, "the stream to close")).code,
        1000,
        "the stream's close code",
      );
    },
  },
  {
    name: "taking control blocks the bot's browser tool and the tool's result says so",
    covers: [],
    async run(ctx, world) {
      const { holder, other, reader } = ctx.clients;
      const { key, targetId } = world.tabs.get(ctx.bots[0]!.id)!;
      const taken = answered(
        await call(holder, "control.take", { sessionKey: key, targetId }),
        "control.take",
      );
      same(
        [taken.state, taken.renewWithinMs, taken.targetId],
        ["granted", ctx.renewTimeoutMs, targetId],
        "the take's answer",
      );
      const generation = String(taken.generation);
      expect(GENERATION.test(generation), `generation ${generation}`);
      world.generation = generation;
      for (const state of ["draining", "granted"]) {
        const event = rec((await controlEvent(reader, generation, state)).payload);
        same(
          [event.agentId, event.profile, event.targetId, event.holder],
          [ctx.bots[0]!.id, `bot-${ctx.bots[0]!.id}`, targetId, "user"],
          `the ${state} event`,
        );
      }
      refused(
        await call(other, "control.take", { sessionKey: key, targetId }),
        "UNAVAILABLE",
        "control_held",
        "a second take",
      );
      const listed = (await tabsOf(holder, key)).find((t) => t.targetId === targetId);
      same(listed?.lease, { state: "granted", mine: true }, "the lease in the holder's tab list");
      same(
        (await tabsOf(other, key)).find((t) => t.targetId === targetId)?.lease,
        { state: "granted", mine: false },
        "the lease in another device's tab list",
      );
      const run = await botRun(holder, key, "#browse-read");
      same(
        run.calls.map((c) => [c.name, c.isError]),
        [["browser", true]],
        "the bot's browser call while held",
      );
      expect(
        run.calls[0]!.text.includes(BLOCKED_WHILE_HELD),
        `the blocked call's result: ${run.calls[0]!.text.slice(0, 200)}`,
      );
      expect(
        run.reply.includes("A person has control of my browser"),
        `the bot's reply: ${run.reply}`,
      );
    },
  },
  {
    name: "input reaches the page",
    covers: [],
    async run(ctx, world) {
      const { holder } = ctx.clients;
      const { key, targetId } = world.tabs.get(ctx.bots[0]!.id)!;
      const generation = world.generation!;
      for (const input of [
        { kind: "click", x: 240, y: 130 },
        { kind: "text", text: "scripted reader" },
        { kind: "click", x: 140, y: 210 },
        { kind: "scroll", x: 300, y: 300, deltaY: 400 },
      ]) {
        same(
          answered(
            await call(holder, "input", { sessionKey: key, targetId, generation, ...input }),
            `input ${input.kind}`,
          ),
          { ok: true },
          `input ${input.kind}`,
        );
      }
      refused(
        await call(holder, "input", {
          sessionKey: key,
          targetId,
          generation,
          kind: "type",
          text: "x",
        }),
        "INVALID_REQUEST",
        "bad_input",
        "input of an unknown kind",
      );
      const renewed = answered(
        await call(holder, "view.renew", { sessionKey: key, targetId, generation }),
        "view.renew",
      );
      same([renewed.leaseRenewed, renewed.streamRenewed], [true, false], "a renewal by the holder");
      // What the page shows is read back by the bot after the release (next checks).
    },
  },
  {
    name: "release with a wrong generation is refused",
    covers: [],
    async run(ctx, world) {
      const { holder, other } = ctx.clients;
      const { key, targetId } = world.tabs.get(ctx.bots[0]!.id)!;
      const generation = world.generation!;
      refused(
        await call(holder, "control.release", {
          sessionKey: key,
          targetId,
          generation: "0".repeat(32),
        }),
        "FORBIDDEN",
        "not_holder",
        "a release with a wrong generation",
      );
      refused(
        await call(other, "control.release", { sessionKey: key, targetId, generation }),
        "FORBIDDEN",
        "not_holder",
        "a release by another device with the right generation",
      );
      refused(
        await call(other, "input", {
          sessionKey: key,
          targetId,
          generation,
          kind: "click",
          x: 1,
          y: 1,
        }),
        "FORBIDDEN",
        "not_holder",
        "input by another device with the right generation",
      );
      const renewed = answered(
        await call(holder, "view.renew", { sessionKey: key, targetId, generation }),
        "view.renew",
      );
      same(renewed.leaseRenewed, true, "the lease after the refused releases");
    },
  },
  {
    name: "release with the right generation frees it and the event carries that generation",
    covers: ["#browse-read"],
    async run(ctx, world) {
      const { holder, reader } = ctx.clients;
      const { key, targetId } = world.tabs.get(ctx.bots[0]!.id)!;
      const generation = world.generation!;
      same(
        answered(
          await call(holder, "control.release", { sessionKey: key, targetId, generation }),
          "control.release",
        ),
        { state: "released", generation, targetId },
        "the release's answer",
      );
      const event = rec((await controlEvent(reader, generation, "released")).payload);
      same([event.holder, event.targetId], ["bot", targetId], "the released event");
      same(
        controlStates(reader, generation),
        ["draining", "granted", "released"],
        "the lease's events",
      );
      same(
        (await tabsOf(holder, key)).find((t) => t.targetId === targetId)?.lease,
        null,
        "the lease after the release",
      );
      const run = await botRun(holder, key, "#browse-read");
      same(
        run.calls.map((c) => [c.name, c.isError]),
        [["browser", false]],
        "the bot's browser call after the release",
      );
      expect(
        run.calls[0]!.text.includes(SIGNED_IN),
        `the page after the person's input: ${run.calls[0]!.text.slice(0, 300)}`,
      );
      // A second release of the ended lease is refused, and proves nothing about who holds the tab.
      refused(
        await call(holder, "control.release", { sessionKey: key, targetId, generation }),
        "FORBIDDEN",
        "not_holder",
        "a second release",
      );
    },
  },
  {
    name: "a lease that is not renewed expires",
    covers: [],
    async run(ctx, world) {
      const { holder, reader } = ctx.clients;
      const { key, targetId } = world.tabs.get(ctx.bots[0]!.id)!;
      const taken = answered(
        await call(holder, "control.take", { sessionKey: key, targetId }),
        "control.take",
      );
      const generation = String(taken.generation);
      const started = Date.now();
      await controlEvent(reader, generation, "expired", ctx.renewTimeoutMs + 10_000);
      const after = Date.now() - started;
      expect(after >= ctx.renewTimeoutMs - 500, `the lease expired after only ${after} ms`);
      same(
        (await tabsOf(holder, key)).find((t) => t.targetId === targetId)?.lease,
        null,
        "the lease after expiry",
      );
      const renewed = answered(
        await call(holder, "view.renew", { sessionKey: key, targetId, generation }),
        "view.renew",
      );
      same(renewed.leaseRenewed, false, "a renewal of the expired lease");
      same(
        controlStates(reader, generation),
        ["draining", "granted", "expired"],
        "the lease's events",
      );
    },
  },
  {
    name: "a take while the bot acts past the drain deadline answers busy and grants nothing",
    covers: ["#browse-slow"],
    async run(ctx, world) {
      const { holder, reader } = ctx.clients;
      const { key, targetId } = world.tabs.get(ctx.bots[0]!.id)!;
      const from = holder.lastSeq;
      const running = botRun(holder, key, "#browse-slow");
      await holder.waitFor(
        "the slow browser call to start",
        (e) =>
          e.event === "agent" &&
          rec(e.payload).stream === "tool" &&
          rec(rec(e.payload).data).phase === "start",
        60_000,
        from,
      );
      const started = Date.now();
      const answer = answered(
        await call(holder, "control.take", { sessionKey: key, targetId }),
        "control.take",
      );
      const waited = Date.now() - started;
      same(
        [answer.state, answer.runningCalls],
        ["busy", 1],
        "the take's answer while the bot acts",
      );
      expect(
        waited >= ctx.drainTimeoutMs - 500,
        `busy came after ${waited} ms, before the drain deadline`,
      );
      const generation = String(answer.generation);
      await controlEvent(reader, generation, "busy");
      same(controlStates(reader, generation), ["draining", "busy"], "the busy lease's events");
      const run = await running;
      same([run.state, run.calls[0]?.isError], ["final", false], "the slow run");
      same(
        (await tabsOf(holder, key)).find((t) => t.targetId === targetId)?.lease,
        null,
        "the lease after busy",
      );
    },
  },
  {
    name: "a stopped task's slow navigation does not commit after a person is granted control",
    covers: ["#browse-slow"],
    async run(ctx, world) {
      const { holder, reader } = ctx.clients;
      const bot = ctx.bots[0]!;
      const { key, targetId } = world.tabs.get(bot.id)!;
      const tab = await watchTab(bot.cdpPort, targetId);
      let generation: string | null = null;
      try {
        const from = holder.lastSeq;
        const sent = await holder.send(key, "#browse-slow");
        const runId = String(sent.runId);
        await holder.waitFor(
          "the slow browser call to start",
          (e) =>
            e.event === "agent" &&
            rec(e.payload).runId === runId &&
            rec(e.payload).stream === "tool" &&
            rec(rec(e.payload).data).phase === "start",
          60_000,
          from,
        );
        // The navigation has really started in Chromium before the task is stopped.
        await until(
          "Chromium to start loading the slow page",
          () => tab.seen.some((e) => e.method === "Page.frameStartedLoading"),
          15_000,
        );
        const loadingAt = Date.now();
        same(
          rec(await holder.request("chat.abort", { sessionKey: key, runId })).aborted,
          true,
          "stopping the task",
        );
        const taken = answered(
          await call(holder, "control.take", { sessionKey: key, targetId }),
          "control.take after the task was stopped",
        );
        expect(
          taken.state === "granted",
          `the take after the task was stopped: ${show(taken)}; the tab: ${show(tab.seen)}`,
        );
        generation = String(taken.generation);
        const grantedAt = Date.now();
        // Held past the moment the slow page would have answered.
        while (Date.now() < loadingAt + SLOW_PAGE_MS + 3000) {
          const renewal = answered(
            await call(holder, "view.renew", { sessionKey: key, targetId, generation }),
            "view.renew while held",
          );
          same(renewal.leaseRenewed, true, "the lease while held");
          await sleep(1000);
        }
        const committed = tab.seen.filter(
          (e) => e.method === "Page.frameNavigated" && e.at >= grantedAt,
        );
        same(committed, [], "navigations committed after the grant");
        const listed = (await tabsOf(holder, key)).find((t) => t.targetId === targetId);
        expect(
          !String(listed?.url ?? "").includes("/scripted/pages/slow"),
          `the tab is on ${String(listed?.url)} after the grant`,
        );
        same(rec(await holder.terminal(runId, 30_000)).state, "aborted", "the stopped task's run");
        same(
          answered(
            await call(holder, "control.release", { sessionKey: key, targetId, generation }),
            "control.release",
          ).state,
          "released",
          "the release",
        );
        await controlEvent(reader, generation, "released");
        same(
          controlStates(reader, generation),
          ["draining", "granted", "released"],
          "the lease's events",
        );
        generation = null;
      } finally {
        tab.close();
        if (generation) {
          await call(holder, "control.release", { sessionKey: key, targetId, generation });
        }
      }
    },
  },
  {
    name: "a caller that leaves mid-take leaves nothing granted or streaming",
    covers: [],
    async run(ctx, world) {
      const { holder, reader } = ctx.clients;
      const { key, targetId } = world.tabs.get(ctx.bots[0]!.id)!;
      const leaver = await ctx.openExtra("Clawtrate computer check (leaves)");
      let stream: Stream | null = null;
      try {
        await leaver.request("sessions.messages.subscribe", { key });
        const view = answered(
          await call(leaver, "view.open", { sessionKey: key, targetId }),
          "the leaver's view.open",
        );
        stream = await openStream(ctx, String(view.wsPath));
        const from = holder.lastSeq;
        const readerFrom = reader.lastSeq;
        const running = botRun(holder, key, "#browse-slow");
        await holder.waitFor(
          "the slow browser call to start",
          (e) =>
            e.event === "agent" &&
            rec(e.payload).stream === "tool" &&
            rec(rec(e.payload).data).phase === "start",
          60_000,
          from,
        );
        const take = call(leaver, "control.take", { sessionKey: key, targetId });
        const draining = await reader.waitFor(
          "the leaver's draining event",
          (e) =>
            e.event === CONTROL_EVENT &&
            rec(e.payload).state === "draining" &&
            rec(e.payload).targetId === targetId,
          20_000,
          readerFrom,
        );
        const generation = String(rec(draining.payload).generation);
        await leaver.close();
        const revoked = rec((await controlEvent(reader, generation, "revoked")).payload);
        same(revoked.reason, "connection-closed", "why the leaver's lease ended");
        const closed = await withTimeout(stream.closed, 10_000, "the leaver's stream to close");
        same(closed.code, 4006, "the leaver's stream's close code");
        void take.catch(() => {});
        const run = await running;
        same(run.state, "final", "the slow run");
        same(
          controlStates(reader, generation),
          ["draining", "revoked"],
          "the leaver's lease's events",
        );
        same(
          (await tabsOf(holder, key)).find((t) => t.targetId === targetId)?.lease,
          null,
          "the lease after the leaver left",
        );
      } finally {
        stream?.socket.close();
        await leaver.close().catch(() => {});
      }
    },
  },
  {
    name: "closing the tab ends the view and the lease",
    covers: [],
    async run(ctx, world) {
      const { holder, reader } = ctx.clients;
      const bot = ctx.bots[0]!;
      const { key } = world.tabs.get(bot.id)!;
      const opened = await botRun(holder, key, "#browse");
      const targetId = String(opened.calls[0]?.details.targetId ?? "");
      expect(targetId, "the new tab has no id");
      const view = answered(
        await call(holder, "view.open", { sessionKey: key, targetId }),
        "view.open",
      );
      const stream = await openStream(ctx, String(view.wsPath));
      try {
        await until("the ready message", () => stream.texts.length > 0, 15_000);
        const taken = answered(
          await call(holder, "control.take", { sessionKey: key, targetId }),
          "control.take",
        );
        const generation = String(taken.generation);
        // The tab goes away in the bot's own browser (closed here through its debugging port).
        const response = await fetch(`http://127.0.0.1:${bot.cdpPort}/json/close/${targetId}`, {
          signal: AbortSignal.timeout(10_000),
        });
        same(response.status, 200, "closing the tab");
        const closed = await withTimeout(stream.closed, 15_000, "the stream to close");
        same([closed.code, closed.reason], [4004, "target_closed"], "the stream's close");
        const event = rec((await controlEvent(reader, generation, "tab-closed")).payload);
        same(event.targetId, targetId, "the tab-closed event");
        expect(
          !(await tabsOf(holder, key)).some((t) => t.targetId === targetId),
          "the closed tab is still listed",
        );
        refused(
          await call(holder, "view.renew", { sessionKey: key, targetId, generation }),
          "FORBIDDEN",
          "tab_not_in_bots_browser",
          "a renewal on the closed tab",
        );
        refused(
          await call(holder, "control.release", { sessionKey: key, targetId, generation }),
          "FORBIDDEN",
          "not_holder",
          "a release on the closed tab",
        );
      } finally {
        stream.socket.close();
      }
    },
  },
  {
    name: "the development browser is confined to loopback: an outside address is refused",
    covers: ["#browse-outside"],
    async run(ctx, world) {
      const { holder } = ctx.clients;
      const { key } = world.tabs.get(ctx.bots[1]!.id)!;
      const before = Number(
        rec(await (await fetch(`${ctx.pagesOrigin}${PAGES_RECORD_PATH}`)).json()).seq,
      );
      const run = await botRun(holder, key, "#browse-outside");
      same(
        run.calls.map((c) => [c.name, c.args.action, c.args.url ?? null]),
        [
          ["browser", "navigate", OUTSIDE_ADDRESS],
          ["browser", "navigate", OTHER_LOOPBACK],
          ["browser", "text", null],
        ],
        "the calls",
      );
      // The gateway's own navigation policy refuses the outside address.
      expect(
        run.calls[0]!.isError,
        `navigating to ${OUTSIDE_ADDRESS} was not refused: ${run.calls[0]!.text.slice(0, 200)}`,
      );
      // Another loopback port passes that policy, and the tool's confinement refuses it.
      expect(
        !run.calls[2]!.isError && run.calls[2]!.text.includes(REFUSED_TITLE),
        `${OTHER_LOOPBACK} did not show the refusal: ${run.calls[2]!.text.slice(0, 300)}`,
      );
      const record = rec(
        await (await fetch(`${ctx.pagesOrigin}${PAGES_RECORD_PATH}?since=${before}`)).json(),
      );
      const refusals = (record.refused ?? []) as Refusal[];
      expect(
        refusals.some((r) => r.host === new URL(OTHER_LOOPBACK).host),
        `the scripted pages recorded no refusal for ${new URL(OTHER_LOOPBACK).host}: ${show(refusals)}`,
      );
    },
  },
  {
    name: "the development browser's own connections stay on loopback while it runs",
    covers: [],
    async run(ctx) {
      // Chromium makes connections of its own (a time service, for one) even with
      // background networking off. Every socket of every one of the instance's
      // browser processes, sampled for a while, must be on loopback at both ends.
      const off = new Set<string>();
      let samples = 0;
      let most = 0;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const found = offLoopbackSockets(ctx.stateDir);
        expect(found, "could not list the browser's processes or their sockets");
        most = Math.max(most, found.pids);
        for (const socket of found.sockets) off.add(socket);
        samples += 1;
        await sleep(250);
      }
      expect(
        most >= ctx.bots.length,
        `found ${most} browser processes of the instance, fewer than its ${ctx.bots.length} browsers`,
      );
      expect(samples >= 5, `only ${samples} samples of the browser's sockets`);
      same([...off], [], "the browser's sockets that are not on loopback");
    },
  },
];

/** Run the checks in order. One line per check; a failure does not stop the others. */
export async function runComputerChecks(
  ctx: ComputerContext,
  log: (line: string) => void = console.log,
): Promise<{ passed: number; failed: number }> {
  const world: World = { stamp: Date.now().toString(36), tabs: new Map() };
  let passed = 0;
  let failed = 0;
  for (const check of COMPUTER_CHECKS) {
    try {
      await check.run(ctx, world);
      passed += 1;
      log(`ok    ${check.name}`);
    } catch (error) {
      failed += 1;
      log(`FAIL  ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { passed, failed };
}
