// The Computer tab's engine (`computer.ts`) against a scripted computer
// plugin: what each answer of the plugin's makes the pane say, the view from
// its ticket to its end, and control from the take to a confirmed hand-back.
// The plugin's answers are its own shapes (plugins/clawtrate-computer/README.md).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerViews,
  initialComputerState,
  LIVE_FOR_MS,
  MAX_FRAME_BYTES,
  MAX_QUEUED_INPUTS,
  parseFrame,
  pictureAge,
  streamUrl,
  type ComputerContext,
  type ComputerState,
} from "../src/computer.ts";
import type { WebSocketLike } from "../src/host.ts";
import { utf8Bytes } from "../src/bytes.ts";
import type { QuestionCard } from "../src/runs.ts";

const KEY = "agent:pip:trip";
const TAB = "TAB0000000000000000000000000000A";
const OTHER = "TAB0000000000000000000000000000B";
const GEN = "a".repeat(32);
const GEN2 = "b".repeat(32);
const TICKET = "f00dfacef00dfacef00dfacef00dfacef00dfacef00dface";

type Handler = (params: Record<string, unknown>) => unknown;
const refused = (code: string, reason: string) =>
  Object.assign(new Error(`refused: ${reason}`), { gatewayCode: code, details: { reason } });
const policy = () =>
  Object.assign(new Error("policy"), {
    gatewayCode: "FORBIDDEN",
    details: { code: "SESSION_RESOURCE_TOOL_POLICY" },
  });
const never = () => new Promise<never>(() => {});
const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

class Stream implements WebSocketLike {
  readyState = 1;
  binaryType?: string;
  closed: number | null = null;
  readonly url: string;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(): void {
    throw new Error("a viewer sends nothing on the stream");
  }
  close(code = 1000): void {
    this.closed = code;
    this.readyState = 3;
  }
  text(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  frame(width = 1280, height = 720, size = 64, ts = 1) {
    this.onmessage?.({ data: frameBytes(width, height, size, ts).buffer });
  }
  end(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

function frameBytes(width: number, height: number, size: number, ts = 1): Uint8Array {
  const header = utf8Bytes(
    JSON.stringify({
      url: "http://127.0.0.1:1/p",
      cssWidth: width,
      cssHeight: height,
      scrollX: 0,
      scrollY: 0,
      ts,
    }),
  );
  const jpeg = new Uint8Array(size).fill(7);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  const out = new Uint8Array(4 + header.length + jpeg.length);
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  out.set(jpeg, 4 + header.length);
  return out;
}

const tabsAnswer = (lease: unknown = null, extra: unknown[] = []) => ({
  agentId: "pip",
  profile: "bot-pip",
  browser: "running",
  tabs: [{ targetId: TAB, url: "http://127.0.0.1:1/sign-in", title: "Sign in", lease }, ...extra],
});

function question(overrides: Partial<QuestionCard> = {}): QuestionCard {
  return {
    id: "ask_1",
    runId: "run-1",
    status: "pending",
    questions: [
      {
        id: "q1",
        header: "Sign in",
        question: "Sign in, then hand the browser back.",
        options: [
          { index: 0, label: "I'm done", description: null, value: null },
          { index: 1, label: "Skip", description: null, value: null },
        ],
        optionsOmitted: 0,
        multiSelect: false,
        allowsOther: true,
      },
    ],
    createdAt: 0,
    expiresAt: null,
    answers: null,
    submitting: false,
    error: null,
    raw: null,
    ordinary: true,
    sent: null,
    settledBy: [],
    ...overrides,
  };
}

function harness(handlers: Record<string, Handler> = {}, options: { write?: boolean } = {}) {
  let state: ComputerState = initialComputerState;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const streams: Stream[] = [];
  const logs: string[] = [];
  const env = { write: options.write ?? true, online: true, question: null as QuestionCard | null };
  const answered: Array<{ key: string; id: string; answers: unknown }> = [];
  const all: Record<string, Handler> = {
    "clawtrate-computer.tabs": () => tabsAnswer(),
    "clawtrate-computer.view.open": () => ({
      streamId: "stream-1",
      wsPath: `/clawtrate-computer/stream?ticket=${TICKET}`,
      expiresAtMs: Date.now() + 60_000,
      renewWithinMs: 20_000,
      targetId: TAB,
    }),
    "clawtrate-computer.view.renew": (p) => ({
      ok: true,
      renewWithinMs: 20_000,
      streamRenewed: p.streamId === "stream-1",
      leaseRenewed: p.generation === GEN,
    }),
    "clawtrate-computer.control.take": (p) => ({
      state: "granted",
      generation: GEN,
      renewWithinMs: 20_000,
      targetId: p.targetId,
      guarantee: [],
    }),
    "clawtrate-computer.control.release": (p) => ({
      state: "released",
      generation: p.generation,
      targetId: p.targetId,
    }),
    "clawtrate-computer.input": () => ({ ok: true }),
    ...handlers,
  };
  const ctx: ComputerContext = {
    request: async (method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      requests.push({ method, params: p });
      const handler = all[method];
      if (!handler) throw new Error(`unscripted ${method}`);
      return handler(p);
    },
    openStream: (url) => {
      const stream = new Stream(url);
      streams.push(stream);
      return stream;
    },
    gatewayUrl: () => "ws://127.0.0.1:19999",
    canWrite: () => env.online && env.write,
    online: () => env.online,
    now: () => Date.now(),
    get: () => state,
    set: (next) => {
      state = next;
    },
    pendingQuestion: () => (env.question?.status === "pending" ? env.question : null),
    questionStatus: (_key, id) => (env.question?.id === id ? env.question.status : null),
    answer: async (key, id, answers) => {
      answered.push({ key, id, answers });
    },
    stopTask: vi.fn(async () => {}),
    log: (_level, message) => logs.push(message),
  };
  const views = new ComputerViews(ctx);
  const viewer = views.newViewer();
  const pane = () => state.panes[viewer]!;
  const calls = (method: string) =>
    requests.filter((r) => r.method === method).map((r) => r.params);
  return {
    views,
    viewer,
    pane,
    state: () => state,
    requests,
    calls,
    streams,
    logs,
    env,
    answered,
    ctx,
  };
}

async function ready(h: ReturnType<typeof harness>) {
  h.views.hello(["clawtrate-computer.tabs"]);
  h.views.show(h.viewer, KEY);
  await flush();
  expect(h.pane().availability).toBe("ready");
}

async function live(h: ReturnType<typeof harness>) {
  await ready(h);
  await h.views.watch(h.viewer);
  h.streams.at(-1)!.frame();
  expect(h.pane().view?.status).toBe("live");
}

async function granted(h: ReturnType<typeof harness>) {
  await live(h);
  await h.views.take(h.viewer);
  expect(h.pane().control.status).toBe("granted");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("what the plugin answers for the task's bot (F-141, section 19)", () => {
  it("F-141: says the plugin is not loaded from the hello's methods, and asks it nothing", async () => {
    const h = harness();
    h.views.hello(["chat.send"]);
    h.views.show(h.viewer, KEY);
    await flush();
    expect(h.state().plugin).toBe(false);
    expect(h.pane().availability).toBe("absent");
    expect(h.requests).toEqual([]);
  });

  it("F-141: tells a bot that is not configured from a task whose policy denies the browser, and from any other refusal", async () => {
    const h = harness({
      "clawtrate-computer.tabs": () => {
        throw refused("UNAVAILABLE", "bot_not_configured");
      },
    });
    await (h.views.hello(["clawtrate-computer.tabs"]), h.views.show(h.viewer, KEY), flush());
    expect(h.pane().availability).toBe("not-configured");

    const p = harness({
      "clawtrate-computer.tabs": () => {
        throw policy();
      },
    });
    p.views.hello(["clawtrate-computer.tabs"]);
    p.views.show(p.viewer, KEY);
    await flush();
    expect(p.pane().availability).toBe("not-allowed");

    const e = harness({
      "clawtrate-computer.tabs": () => {
        throw refused("FORBIDDEN", "session_access_required");
      },
    });
    e.views.hello(["clawtrate-computer.tabs"]);
    e.views.show(e.viewer, KEY);
    await flush();
    expect(e.pane().availability).toBe("error");
    expect(e.pane().error).toMatch(/session_access_required/);
  });

  it("F-141: an empty tab list is only that: no tabs, nothing said of a stopped browser", async () => {
    const h = harness({
      "clawtrate-computer.tabs": () => ({
        agentId: "pip",
        profile: "bot-pip",
        browser: "not-running",
        reason: "browser_unavailable",
        tabs: [],
      }),
    });
    await ready(h);
    expect(h.pane().tabs).toEqual([]);
    expect(h.pane().shown).toBeNull();
  });

  it("a read-only connection asks for none of the plugin's methods and is never shown a view", async () => {
    const h = harness({}, { write: false });
    h.views.hello(["clawtrate-computer.tabs"]);
    h.views.show(h.viewer, KEY);
    await flush();
    expect(h.pane().availability).toBe("read-only");
    await h.views.watch(h.viewer);
    await h.views.take(h.viewer);
    expect(h.requests).toEqual([]);
    expect(h.streams).toEqual([]);
    expect(h.pane().view).toBeNull();
    expect(h.pane().control.status).toBe("none");
  });

  it("shows the first real tab, not the browser's new-tab page, and names who holds each lease", async () => {
    const h = harness({
      "clawtrate-computer.tabs": () => ({
        browser: "running",
        tabs: [
          { targetId: OTHER, url: "chrome://newtab/", title: "New Tab", lease: null },
          {
            targetId: TAB,
            url: "http://127.0.0.1:1/sign-in",
            title: "Sign in",
            lease: { state: "granted", mine: false },
          },
        ],
      }),
    });
    await ready(h);
    expect(h.pane().shown).toBe(TAB);
    expect(h.pane().tabs[1]!.lease).toEqual({ state: "granted", holder: "elsewhere" });
  });
});

describe("a view from start to end (F-142, section 17)", () => {
  it("opens the stream on the gateway's own address with the ticket, and keeps the ticket out of the state", async () => {
    const h = harness();
    await ready(h);
    await h.views.watch(h.viewer);
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]!.url).toBe(
      `ws://127.0.0.1:19999/clawtrate-computer/stream?ticket=${TICKET}`,
    );
    expect(h.streams[0]!.binaryType).toBeUndefined();
    expect(JSON.stringify(h.state())).not.toContain(TICKET);
    expect(h.pane().view).toMatchObject({ status: "connecting", targetId: TAB });
    h.streams[0]!.text({
      type: "ready",
      targetId: TAB,
      url: "http://127.0.0.1:1/sign-in",
      title: "Sign in",
    });
    h.streams[0]!.frame(756, 413);
    expect(h.pane().view).toMatchObject({ status: "live", frame: 1, width: 756, height: 413 });
    expect(JSON.stringify(h.state())).not.toContain(TICKET);
    expect(h.logs.join("\n")).not.toContain(TICKET);
  });

  it("refuses a stream path that would leave the gateway's origin", () => {
    expect(streamUrl("ws://127.0.0.1:1", "/clawtrate-computer/stream?ticket=x")).toBe(
      "ws://127.0.0.1:1/clawtrate-computer/stream?ticket=x",
    );
    expect(
      streamUrl("ws://127.0.0.1:1", "//elsewhere.example/clawtrate-computer/stream?ticket=x"),
    ).toBeNull();
    expect(streamUrl("ws://127.0.0.1:1", "/other?ticket=x")).toBeNull();
    expect(streamUrl("http://127.0.0.1:1", "/clawtrate-computer/stream?ticket=x")).toBeNull();
  });

  it("hands the viewer only the newest frame, once, and drops it when the view ends", async () => {
    const h = harness();
    await live(h);
    const n = h.pane().view!.n;
    h.streams[0]!.frame(1280, 720, 80);
    h.streams[0]!.frame(1280, 720, 90);
    const first = await h.views.frame(h.viewer, n, 0);
    expect(first?.seq).toBe(3);
    // Drawn once: the host keeps nothing of it.
    const waiting = h.views.frame(h.viewer, n, 3);
    h.views.stopWatching(h.viewer);
    expect(await waiting).toBeNull();
    expect(await h.views.frame(h.viewer, n, 0)).toBeNull();
    expect(h.streams[0]!.closed).toBe(1000);
    expect(h.pane().view).toBeNull();
  });

  it("drops a frame larger than it keeps, and counts it", async () => {
    const h = harness();
    await live(h);
    h.streams[0]!.frame(1280, 720, 200_000);
    expect(h.pane().view).toMatchObject({ frame: 1, framesTooLarge: 1 });
  });

  it("disposes of a ticket that arrives after the person stopped watching: the stream is never opened", async () => {
    let answer!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.view.open": () => new Promise((resolve) => (answer = resolve)),
    });
    await ready(h);
    const watching = h.views.watch(h.viewer);
    await flush();
    h.views.stopWatching(h.viewer);
    answer({
      streamId: "stream-1",
      wsPath: `/clawtrate-computer/stream?ticket=${TICKET}`,
      renewWithinMs: 20_000,
    });
    await watching;
    expect(h.streams).toEqual([]);
    expect(h.pane().view).toBeNull();
  });

  it("says how the view ended for each close code: tab closed, browser stopped answering, gateway ended it", async () => {
    for (const [code, end] of [
      [4004, "tab-closed"],
      [1011, "browser-gone"],
      [4006, "gateway-ended"],
      [1012, "gateway-ended"],
    ] as const) {
      const h = harness();
      await live(h);
      h.streams[0]!.end(code);
      expect(h.pane().view, String(code)).toMatchObject({ status: "ended", end });
    }
  });

  it("renews the view well within its deadline, and ends it when a renewal no longer renews the stream", async () => {
    vi.useFakeTimers();
    let renews = 0;
    const h = harness({
      "clawtrate-computer.view.renew": () => ({
        ok: true,
        renewWithinMs: 20_000,
        streamRenewed: (renews += 1) < 2,
        leaseRenewed: false,
      }),
    });
    await live(h);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.calls("clawtrate-computer.view.renew")).toEqual([
      { sessionKey: KEY, targetId: TAB, streamId: "stream-1" },
    ]);
    expect(h.pane().view?.status).toBe("live");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.pane().view).toMatchObject({ status: "ended", end: "gateway-ended" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls("clawtrate-computer.view.renew")).toHaveLength(2);
  });

  it("ends the view at once when the connection drops, and says so", async () => {
    const h = harness();
    await live(h);
    h.env.online = false;
    h.views.connectionLost();
    expect(h.pane().view).toMatchObject({ status: "ended", end: "dropped" });
    expect(h.streams[0]!.closed).toBe(1000);
  });
});

describe("taking control (F-142, F-144, section 18)", () => {
  it("F-142: says it waits while the take drains, then You have control only once the gateway grants it", async () => {
    let grant!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.control.take": () => new Promise((resolve) => (grant = resolve)),
    });
    await live(h);
    const taking = h.views.take(h.viewer);
    await flush();
    expect(h.pane().control.status).toBe("draining");
    // Frames still arriving prove nothing.
    h.streams[0]!.frame();
    expect(h.pane().control.status).toBe("draining");
    grant({
      state: "granted",
      generation: GEN,
      renewWithinMs: 6_000,
      targetId: TAB,
      guarantee: [],
    });
    await taking;
    expect(h.pane().control).toMatchObject({ status: "granted", renewWithinMs: 6_000 });
    // The generation stays in the engine.
    expect(JSON.stringify(h.state().panes)).not.toContain(GEN);
  });

  it("F-142: a take refused while the bot acts says so, and one refused while its work has not settled says that, each with Try again", async () => {
    const h = harness({
      "clawtrate-computer.control.take": () => ({
        state: "busy",
        reason: "bot-still-acting",
        runningCalls: 1,
        generation: GEN,
      }),
    });
    await live(h);
    await h.views.take(h.viewer);
    expect(h.pane().control).toMatchObject({
      status: "busy",
      busyReason: "bot-still-acting",
      busyCount: 1,
    });
    await h.views.take(h.viewer);
    await h.views.take(h.viewer);
    expect(h.pane().control.busyCount).toBe(3);

    for (const reason of ["browser-not-quiet", "download-in-progress", "browser-not-watched"]) {
      const u = harness({
        "clawtrate-computer.control.take": () => ({
          state: "busy",
          reason,
          runningCalls: 0,
          generation: GEN,
        }),
      });
      await live(u);
      await u.views.take(u.viewer);
      expect(u.pane().control, reason).toMatchObject({
        status: "unsettled",
        busyReason: reason,
        busyCount: 1,
      });
    }
  });

  it("F-142: someone else holding the tab is a conflict, not control", async () => {
    const h = harness({
      "clawtrate-computer.control.take": () => {
        throw refused("UNAVAILABLE", "control_held");
      },
    });
    await live(h);
    await h.views.take(h.viewer);
    expect(h.pane().control.status).toBe("conflict");
  });

  it("F-142: Cancel withdraws the take with the draining event's generation, and a grant that wins the race is given back at once with no input", async () => {
    let grant!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.control.take": () => new Promise((resolve) => (grant = resolve)),
    });
    await live(h);
    const taking = h.views.take(h.viewer);
    await flush();
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "user",
      state: "draining",
      generation: GEN,
    });
    h.views.cancelTake(h.viewer);
    await flush();
    expect(h.calls("clawtrate-computer.control.release")).toEqual([
      { sessionKey: KEY, targetId: TAB, generation: GEN },
    ]);
    expect(h.pane().control.status).toBe("none");
    grant({
      state: "granted",
      generation: GEN2,
      renewWithinMs: 20_000,
      targetId: TAB,
      guarantee: [],
    });
    await taking;
    await flush();
    expect(h.calls("clawtrate-computer.control.release").at(-1)).toEqual({
      sessionKey: KEY,
      targetId: TAB,
      generation: GEN2,
    });
    expect(h.pane().control.status).toBe("none");
    expect(h.views.input(h.viewer, { kind: "text", text: "x" })).toBe(false);
    expect(h.calls("clawtrate-computer.input")).toEqual([]);
  });

  it("F-142: sends input to the held tab one call at a time, in order, with the generation, and only while held", async () => {
    let release!: () => void;
    const h = harness({
      "clawtrate-computer.input": () =>
        new Promise((resolve) => (release = () => resolve({ ok: true }))),
    });
    expect(h.views.input(h.viewer, { kind: "text", text: "no" })).toBe(false);
    await granted(h);
    expect(h.views.input(h.viewer, { kind: "click", x: 10, y: 20 })).toBe(true);
    h.views.input(h.viewer, { kind: "text", text: "pa" });
    h.views.input(h.viewer, { kind: "text", text: "ss" });
    h.views.input(h.viewer, { kind: "scroll", x: null, y: null, deltaX: 0, deltaY: 120 });
    await flush();
    expect(h.calls("clawtrate-computer.input")).toHaveLength(1);
    release();
    await flush();
    release();
    await flush();
    release();
    await flush();
    expect(h.calls("clawtrate-computer.input")).toEqual([
      { sessionKey: KEY, targetId: TAB, generation: GEN, kind: "click", x: 10, y: 20 },
      { sessionKey: KEY, targetId: TAB, generation: GEN, kind: "text", text: "pass" },
      { sessionKey: KEY, targetId: TAB, generation: GEN, kind: "scroll", deltaX: 0, deltaY: 120 },
    ]);
    // Nothing typed is kept in the state or logged.
    expect(JSON.stringify(h.state())).not.toContain("pass");
    expect(h.logs.join("")).not.toContain("pass");
  });

  it("keeps at most MAX_QUEUED_INPUTS inputs waiting and drops the rest", async () => {
    const h = harness({ "clawtrate-computer.input": never });
    await granted(h);
    let accepted = 0;
    for (let i = 0; i < MAX_QUEUED_INPUTS + 5; i++)
      if (h.views.input(h.viewer, { kind: "click", x: i, y: i })) accepted += 1;
    // One is on its way; the queue holds the rest up to its bound.
    expect(accepted).toBe(MAX_QUEUED_INPUTS + 1);
  });

  it("F-142: You have control holds only while each renewal confirms the lease; one that does not says control ended, with no cause", async () => {
    vi.useFakeTimers();
    let renewed = true;
    const h = harness({
      "clawtrate-computer.view.renew": (p) => ({
        ok: true,
        renewWithinMs: 20_000,
        streamRenewed: true,
        leaseRenewed: renewed && p.generation === GEN,
      }),
    });
    await granted(h);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.calls("clawtrate-computer.view.renew").at(-1)).toEqual({
      sessionKey: KEY,
      targetId: TAB,
      streamId: "stream-1",
      generation: GEN,
    });
    expect(h.pane().control.status).toBe("granted");
    renewed = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.pane().control).toMatchObject({ status: "ended", endCause: null });
  });

  it("F-142: a control event for this lease that it expired or was revoked ends control with its cause; one for another lease changes nothing", async () => {
    const h = harness();
    await granted(h);
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "bot",
      state: "expired",
      generation: GEN2,
    });
    expect(h.pane().control.status).toBe("granted");
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "bot",
      state: "revoked",
      generation: GEN,
      reason: "connection-closed",
    });
    expect(h.pane().control).toMatchObject({ status: "ended", endCause: "revoked" });
    expect(h.views.input(h.viewer, { kind: "text", text: "x" })).toBe(false);
  });

  it("F-144: every reader keeps the latest control event of each bot's tab, so a read-only device sees someone else hold it", () => {
    const h = harness({}, { write: false });
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "user",
      state: "granted",
      generation: GEN,
    });
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "bot",
      state: "released",
      generation: GEN,
    });
    expect(h.state().control).toEqual([
      expect.objectContaining({
        agentId: "pip",
        targetId: TAB,
        state: "released",
        generation: GEN,
      }),
    ]);
    // Anything else is not a control event.
    h.views.controlEvent({
      agentId: "pip",
      targetId: "bad id!",
      state: "granted",
      generation: GEN,
    });
    h.views.controlEvent({ agentId: "pip", targetId: TAB, state: "granted", generation: "short" });
    expect(h.state().control).toHaveLength(1);
  });
});

describe("handing back (F-145, section 18)", () => {
  it("F-145: the release is confirmed by its own success: input stops at once, and nothing says Watching until then", async () => {
    let done!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.control.release": () => new Promise((resolve) => (done = resolve)),
    });
    await granted(h);
    h.views.release(h.viewer);
    expect(h.pane().control.status).toBe("releasing");
    expect(h.views.input(h.viewer, { kind: "text", text: "x" })).toBe(false);
    done({ state: "released", generation: GEN, targetId: TAB });
    await flush();
    expect(h.pane().control).toMatchObject({ status: "none", released: true });
  });

  it("F-145: a refused release is not proof of ownership: unconfirmed, and Check settles it from a renewal", async () => {
    const h = harness({
      "clawtrate-computer.control.release": () => {
        throw refused("FORBIDDEN", "not_holder");
      },
    });
    await granted(h);
    h.views.release(h.viewer);
    await flush();
    expect(h.pane().control.status).toBe("unconfirmed");
    expect(h.views.input(h.viewer, { kind: "text", text: "x" })).toBe(false);
    await h.views.check(h.viewer);
    expect(h.pane().control).toMatchObject({ status: "granted", stillHeld: true });

    const ended = harness({
      "clawtrate-computer.control.release": () => {
        throw refused("FORBIDDEN", "not_holder");
      },
      "clawtrate-computer.view.renew": () => ({
        ok: true,
        renewWithinMs: 20_000,
        streamRenewed: true,
        leaseRenewed: false,
      }),
    });
    await granted(ended);
    ended.views.release(ended.viewer);
    await flush();
    await ended.views.check(ended.viewer);
    expect(ended.pane().control).toMatchObject({ status: "ended", endCause: null });
  });

  it("F-145: a release that is not answered becomes unconfirmed at its deadline", async () => {
    vi.useFakeTimers();
    const h = harness({ "clawtrate-computer.control.release": never });
    await granted(h);
    h.views.release(h.viewer);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.pane().control.status).toBe("unconfirmed");
  });

  it("F-145: only a released event with this lease's generation confirms the hand-back; another lease's does not", async () => {
    const h = harness({ "clawtrate-computer.control.release": never });
    await granted(h);
    h.views.release(h.viewer);
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "bot",
      state: "released",
      generation: GEN2,
    });
    expect(h.pane().control.status).toBe("releasing");
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "bot",
      state: "released",
      generation: GEN,
    });
    expect(h.pane().control.status).toBe("none");
  });

  it("F-145: an answer goes only once the release is confirmed, as the option at its place", async () => {
    let done!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.control.release": () => new Promise((resolve) => (done = resolve)),
    });
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 0 } });
    await flush();
    expect(h.answered).toEqual([]);
    expect(h.pane().control).toMatchObject({ status: "releasing", answerQueued: true });
    done({ state: "released", generation: GEN, targetId: TAB });
    await flush();
    expect(h.answered).toEqual([{ key: KEY, id: "ask_1", answers: { q1: [{ option: 0 }] } }]);
    expect(h.pane().control.outcome).toBe("answered");
  });

  it("F-145: a refused release sends no queued answer and says so", async () => {
    const h = harness({
      "clawtrate-computer.control.release": () => {
        throw refused("FORBIDDEN", "not_holder");
      },
    });
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 1 } });
    await flush();
    expect(h.answered).toEqual([]);
    expect(h.pane().control).toMatchObject({ status: "unconfirmed", outcome: "answer-not-sent" });
  });

  it("F-145: a question that closes while its answer waits removes the answer; the release goes on", async () => {
    let done!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.control.release": () => new Promise((resolve) => (done = resolve)),
    });
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 0 } });
    h.env.question = question({ status: "answered" });
    h.views.questionClosed(KEY, "answered");
    expect(h.pane().control).toMatchObject({
      status: "releasing",
      answerQueued: false,
      outcome: "dropped-answered",
    });
    done({ state: "released", generation: GEN, targetId: TAB });
    await flush();
    expect(h.answered).toEqual([]);
    expect(h.pane().control.outcome).toBe("dropped-answered");

    const r = harness();
    r.env.question = question();
    await granted(r);
    r.views.questionClosed(KEY, "run-ended");
    expect(r.pane().control).toMatchObject({ status: "granted", questionGone: "run-ended" });
  });

  it("F-145: a lost connection retires the hand-back: no queued answer is ever sent, and ownership stays unknown until the leases are read again", async () => {
    let done!: (value: unknown) => void;
    let lease: unknown = null;
    const h = harness({
      "clawtrate-computer.control.release": () => new Promise((resolve) => (done = resolve)),
      "clawtrate-computer.tabs": () => tabsAnswer(lease),
    });
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 0 } });
    h.env.online = false;
    h.views.connectionLost();
    expect(h.pane().control.status).toBe("maybe-held");
    done({ state: "released", generation: GEN, targetId: TAB });
    await flush();
    expect(h.answered).toEqual([]);
    expect(h.pane().control.status).toBe("maybe-held");
    // Back: the browser's leases are read before anything is offered.
    h.env.online = true;
    lease = { state: "granted", mine: false };
    h.views.reconnected();
    expect(h.pane().control.status).toBe("checking");
    h.views.hello(["clawtrate-computer.tabs"]);
    await flush();
    expect(h.pane().control.status).toBe("maybe-held");
    lease = null;
    await h.views.readTabs(h.viewer);
    expect(h.pane().control.status).toBe("ended");
    expect(h.answered).toEqual([]);
  });
});

describe("leaving (section 17, How a view ends; section 18, Leaving while in control)", () => {
  it("leaving gives control back first, then ends the view at once", async () => {
    const h = harness();
    await granted(h);
    h.views.leave(h.viewer);
    expect(h.calls("clawtrate-computer.control.release")).toEqual([
      { sessionKey: KEY, targetId: TAB, generation: GEN },
    ]);
    expect(h.pane().view).toBeNull();
    expect(h.streams[0]!.closed).toBe(1000);
    await flush();
    expect(h.pane().control.status).toBe("none");
  });

  it("leaving with the hand-back unconfirmed stops renewing and keeps one line on the tab until it is settled", async () => {
    vi.useFakeTimers();
    const h = harness({
      "clawtrate-computer.control.release": () => {
        throw refused("FORBIDDEN", "not_holder");
      },
    });
    await granted(h);
    h.views.release(h.viewer);
    await vi.advanceTimersByTimeAsync(0);
    h.views.leave(h.viewer);
    expect(h.pane().control).toMatchObject({
      status: "unconfirmed",
      outOfSight: true,
      renewWithinMs: 20_000,
    });
    const renewals = h.calls("clawtrate-computer.view.renew").length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls("clawtrate-computer.view.renew")).toHaveLength(renewals);
    // Switching task keeps the line.
    h.views.show(h.viewer, "agent:pip:other");
    expect(h.pane().control).toMatchObject({ status: "unconfirmed", outOfSight: true, key: KEY });
  });

  it("a viewer that goes away gives control back and leaves no pane", async () => {
    const h = harness();
    await granted(h);
    h.views.dispose(h.viewer);
    expect(h.calls("clawtrate-computer.control.release")).toHaveLength(1);
    expect(h.state().panes).toEqual({});
  });

  it("F-149: Stop in this task stops the task's runs through the conversation's Stop, and says so", async () => {
    const h = harness();
    await ready(h);
    await h.views.stopTask(h.viewer);
    expect(h.ctx.stopTask).toHaveBeenCalledWith(KEY);
    expect(h.pane().stopped).toBe(true);
  });
});

describe("frames", () => {
  it("reads the plugin's frame layout and refuses anything else", () => {
    expect(parseFrame(frameBytes(756, 413, 10))?.header).toEqual({
      url: "http://127.0.0.1:1/p",
      cssWidth: 756,
      cssHeight: 413,
      capturedAt: null,
    });
    expect(parseFrame(frameBytes(756, 413, 10, 1_800_000_000.25))?.header.capturedAt).toBe(
      1_800_000_000_250,
    );
    expect(parseFrame(new Uint8Array([0, 0, 0, 2, 123, 125, 1, 2]))).toBeNull();
    const notJpeg = frameBytes(10, 10, 10);
    notJpeg[notJpeg.length - 10] = 0;
    expect(parseFrame(notJpeg)).toBeNull();
  });
});

describe("renewing within the plugin's own deadline", () => {
  it("F-142: renews a view at a quarter of the renewal time the plugin gives, timed from each renewal's start however slowly it is answered", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const h = harness({
      "clawtrate-computer.view.open": () => ({
        streamId: "stream-1",
        wsPath: `/clawtrate-computer/stream?ticket=${TICKET}`,
        renewWithinMs: 6_000,
        targetId: TAB,
      }),
      // Each renewal takes four seconds to be answered.
      "clawtrate-computer.view.renew": () => {
        sent.push(Date.now());
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({ ok: true, renewWithinMs: 6_000, streamRenewed: true, leaseRenewed: false }),
            4_000,
          ),
        );
      },
    });
    await live(h);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sent.length).toBeGreaterThanOrEqual(7);
    const gaps = sent.slice(1).map((at, i) => at - sent[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1_500);
    expect(h.pane().view?.status).toBe("live");
  });
});

describe("Live only while a usable picture is recent (F-142, section 17)", () => {
  it("F-142: Live while a usable frame was drawn within the stated interval; after it the last picture and its age", () => {
    expect(LIVE_FOR_MS).toBe(10_000);
    expect(pictureAge(null, 50_000)).toEqual({ kind: "none" });
    expect(pictureAge({ at: 40_000, capturedAt: null }, 50_000)).toEqual({ kind: "live" });
    expect(pictureAge({ at: 40_000, capturedAt: null }, 50_001)).toEqual({
      kind: "last",
      ageMs: 10_001,
    });
    // A frame captured long before it was drawn is as old as its capture.
    expect(pictureAge({ at: 49_000, capturedAt: 30_000 }, 50_000)).toEqual({
      kind: "last",
      ageMs: 20_000,
    });
  });

  it("F-142: the pane keeps the newest usable frame's capture time; a frame too large, or renewals, change nothing", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const h = harness();
    await ready(h);
    await h.views.watch(h.viewer);
    const stream = h.streams.at(-1)!;
    stream.frame(1280, 720, 64, 1_799_999_999.5);
    expect(h.pane().view).toMatchObject({
      status: "live",
      capturedAt: 1_799_999_999_500,
      frameAt: 1_800_000_000_000,
    });
    const frame = await h.views.frame(h.viewer, h.pane().view!.n, 0);
    expect(frame).toMatchObject({ seq: 1, capturedAt: 1_799_999_999_500 });
    // 30 s on: renewals confirm the stream, a frame too large arrives, nothing usable does.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls("clawtrate-computer.view.renew").length).toBeGreaterThan(0);
    stream.frame(1280, 720, MAX_FRAME_BYTES + 1, 1_800_000_029.9);
    expect(h.pane().view).toMatchObject({
      frame: 1,
      framesTooLarge: 1,
      capturedAt: 1_799_999_999_500,
      frameAt: 1_800_000_000_000,
    });
    // A header without the screencast's time gives none, never this host's clock.
    stream.frame(1280, 720, 64, 0);
    expect(h.pane().view).toMatchObject({ frame: 2, capturedAt: null });
  });
});
