// clawtrate-computer: a browser of its own for each configured bot, a live
// view of it for the people who can use that bot, and a controlled way for a
// person to take it over (a sign-in, a captcha) and hand it back.
//
// What it adds to an OpenClaw gateway, and what it cannot guarantee, is in
// README.md beside this file. In short:
//
//   before_tool_call   pins each configured bot's `browser` calls to its own
//                      profile on the gateway host, allows it only tab
//                      actions, blocks it while a person holds control, and
//                      keeps every other agent out of the bots' profiles
//   after_tool_call    ends the record of a running bot call
//   gateway methods    clawtrate-computer.tabs, .view.open, .view.renew,
//                      .control.take, .control.release, .input
//                      (operator.write, session access with the browser tool)
//   HTTP upgrade       /clawtrate-computer/stream?ticket=…, the live frames
//   event              plugin.clawtrate-computer.control (operator.read)
//
// Rights come only from the session the gateway admitted (its bot) and that
// bot's live tab list from its own browser on loopback; never from tool
// results. Every wait has a deadline; a lease or view ends when its caller's
// connection closes, when it is not renewed, when its tab closes, when the
// session's access is revoked, or when the plugin stops.

import { randomBytes, randomUUID } from "node:crypto";
import {
  BOT_ACTIONS,
  DEFAULT_IMPORT_PROFILE,
  PLUGIN_ID,
  browserConfigProblems,
  defaultProfileOf,
  parseConfig,
  profileSelector,
  toolString,
} from "./lib/config.js";
import { CdpError, TIMEOUTS, cdpTargets, openCdp } from "./lib/cdp.js";
import {
  acceptUpgrade,
  binaryFrame,
  closeFrame,
  frameReader,
  frame,
  refuseUpgrade,
  textFrame,
} from "./lib/websocket.js";

/**
 * The host can load this module more than once (one copy served the tool
 * hooks, another the gateway methods), so shared state lives in one
 * process-wide slot.
 */
export const STATE_KEY = Symbol.for("clawtrate-computer.state.v1");
export const STREAM_PATH = `/${PLUGIN_ID}/stream`;
/** How long a view ticket can be used. A late or unused ticket is harmless. */
export const TICKET_TTL_MS = 60_000;
/** The longest a release, expiry or shutdown waits for queued input to settle. */
const SETTLE_CAP_MS = 1000;
const MAX_STREAMS = 64;
const MAX_STREAMS_PER_CONNECTION = 8;
/** Frames are dropped, not queued, while this much is still unsent to a viewer. */
const STREAM_BUFFER_LIMIT = 4 * 1024 * 1024;
const TARGET_ID = /^[A-Za-z0-9]{8,64}$/;
const GENERATION = /^[0-9a-f]{32}$/;
const COORDINATE_LIMIT = 100000;
const TEXT_LIMIT = 2000;

/** Messages the bot and people see. */
export const BLOCKED_WHILE_HELD =
  "A person has control of this bot's browser. Wait until they give it back.";

export function newState() {
  return {
    /** runId + toolCallId -> { agentId, profile } for each bot browser call running now */
    inflight: new Map(),
    /** profile + targetId -> lease */
    leases: new Map(),
    /** streamId -> stream */
    streams: new Map(),
    /** ticket -> streamId */
    tickets: new Map(),
    /** callbacks run whenever a call or a lease changes */
    waiters: new Set(),
  };
}

const callKey = (runId, toolCallId) => `${runId}\n${toolCallId}`;
const leaseKey = (profile, targetId) => `${profile}\n${targetId}`;
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isSignal = (value) =>
  value !== null &&
  typeof value === "object" &&
  typeof value.aborted === "boolean" &&
  typeof value.addEventListener === "function";
const finite = (value, limit) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
const unref = (timer) => {
  timer?.unref?.();
  return timer;
};

class RequestError extends Error {
  constructor(code, reason, message) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}
const refuse = (code, reason, message) => {
  throw new RequestError(code, reason, message);
};

/** The CDP commands for one input, or throws INVALID_REQUEST. */
export function inputCommands(params) {
  const { kind } = params;
  if (kind === "click") {
    const { x, y } = params;
    if (!finite(x, COORDINATE_LIMIT) || !finite(y, COORDINATE_LIMIT) || x < 0 || y < 0) {
      refuse("INVALID_REQUEST", "bad_input", "a click needs x and y in the page's CSS pixels");
    }
    const at = { x, y };
    return [
      ["Input.dispatchMouseEvent", { type: "mouseMoved", ...at }],
      [
        "Input.dispatchMouseEvent",
        { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 },
      ],
      [
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 },
      ],
    ];
  }
  if (kind === "scroll") {
    const { x = 0, y = 0, deltaX = 0, deltaY } = params;
    if (
      ![x, y].every((v) => finite(v, COORDINATE_LIMIT) && v >= 0) ||
      !finite(deltaX, COORDINATE_LIMIT) ||
      !finite(deltaY, COORDINATE_LIMIT)
    ) {
      refuse("INVALID_REQUEST", "bad_input", "a scroll needs deltaY, and x, y and deltaX if given");
    }
    return [["Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY }]];
  }
  if (kind === "text") {
    const { text } = params;
    if (typeof text !== "string" || text.length === 0 || text.length > TEXT_LIMIT) {
      refuse("INVALID_REQUEST", "bad_input", `text must be 1 to ${TEXT_LIMIT} characters`);
    }
    return [["Input.insertText", { text }]];
  }
  return refuse("INVALID_REQUEST", "bad_input", "kind must be click, scroll or text");
}

/**
 * Register the plugin on `api`. Returns a handle for tests. `options` lets
 * tests replace the state slot, the deadlines and lifetimes, `fetch` and
 * `WebSocket`.
 */
export function createComputer(api, options = {}) {
  const config = parseConfig(api.pluginConfig ?? {});
  const startProblems = browserConfigProblems(api.config, config);
  if (startProblems.length > 0) {
    throw new Error(`${PLUGIN_ID}: the browser config does not match: ${startProblems.join("; ")}`);
  }
  const state = options.state ?? (globalThis[STATE_KEY] ??= newState());
  const timeouts = { ...TIMEOUTS, ...options.timeouts };
  const ticketTtlMs = options.ticketTtlMs ?? TICKET_TTL_MS;
  const net = {
    timeouts,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
  };
  const { bots, profiles } = config;
  // Tests may use shorter times than the config's bounds allow.
  const drainTimeoutMs = options.drainTimeoutMs ?? config.drainTimeoutMs;
  const renewTimeoutMs = options.renewTimeoutMs ?? config.renewTimeoutMs;
  const logger = api.logger ?? {};
  const warn = (message) => logger.warn?.(`${PLUGIN_ID}: ${message}`);
  const registration = Symbol("registration");
  let emitEvent = () => {};

  const currentConfig = () => {
    try {
      return api.runtime?.config?.current?.() ?? api.config;
    } catch {
      return api.config;
    }
  };
  const changed = () => {
    for (const waiter of [...state.waiters]) waiter();
  };
  /** Resolves true once `predicate` holds, false at the deadline or on abort. */
  const waitUntil = (predicate, ms, signal) =>
    new Promise((resolve) => {
      if (predicate()) return resolve(true);
      if (signal?.aborted) return resolve(false);
      const done = (value) => {
        clearTimeout(timer);
        state.waiters.delete(check);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const check = () => predicate() && done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(predicate()), ms);
      state.waiters.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  const emitControl = (lease, eventState, reason) =>
    emitEvent("control", {
      agentId: lease.agentId,
      profile: lease.profile,
      targetId: lease.targetId,
      holder: eventState === "draining" || eventState === "granted" ? "user" : "bot",
      state: eventState,
      generation: lease.generation,
      ...(reason ? { reason } : {}),
    });
  const runningCalls = (profile) =>
    [...state.inflight.values()].filter((call) => call.profile === profile).length;
  const leaseOnProfile = (profile) =>
    [...state.leases.values()].some((lease) => lease.profile === profile);

  // ---- leases ----

  /**
   * End a lease: stop and settle its queued input, then unblock the bot and
   * say so. Safe to call any number of times; returns the same promise.
   */
  function endLease(lease, endState, reason) {
    if (lease.ended) return lease.ended;
    // Claimed first: aborting below closes the lease's own connection to the
    // tab, whose close handler calls here again and must get this ending.
    let finish;
    lease.ended = new Promise((resolve) => (finish = resolve));
    lease.ending = true;
    clearTimeout(lease.expiry);
    for (const unbind of lease.unbind) unbind();
    lease.abort.abort(reason);
    void (async () => {
      // Every step of an input honours the abort, so this settles at once;
      // the cap only guards against a step that does not.
      let cap;
      await Promise.race([
        lease.queue,
        new Promise((resolve) => (cap = unref(setTimeout(resolve, SETTLE_CAP_MS)))),
      ]);
      clearTimeout(cap);
      lease.cdp?.close();
      try {
        lease.retained?.release();
      } catch {
        // already released
      }
      if (state.leases.get(lease.key) === lease) state.leases.delete(lease.key);
      emitControl(lease, endState, reason);
      changed();
    })().finally(finish);
    return lease.ended;
  }

  function armLeaseExpiry(lease) {
    clearTimeout(lease.expiry);
    lease.expiry = unref(
      setTimeout(() => void endLease(lease, "expired", "not-renewed"), renewTimeoutMs),
    );
  }

  /** Run `fn` after everything already queued on this lease (input, release, expiry). */
  function exclusive(lease, fn) {
    const run = lease.queue.then(fn, fn);
    lease.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // ---- streams ----

  function endStream(stream, code, reason) {
    if (stream.ended) return;
    stream.ended = true;
    state.streams.delete(stream.id);
    if (stream.ticket) state.tickets.delete(stream.ticket);
    clearTimeout(stream.expiry);
    clearTimeout(stream.ticketExpiry);
    for (const unbind of stream.unbind) unbind();
    stream.abort.abort(reason);
    stream.cdp?.close();
    try {
      stream.retained?.release();
    } catch {
      // already released
    }
    const { socket } = stream;
    if (socket && !socket.destroyed) {
      socket.write(closeFrame(code, reason));
      socket.end();
      unref(setTimeout(() => socket.destroy(), 1000));
    }
  }

  function armStreamExpiry(stream) {
    clearTimeout(stream.expiry);
    stream.expiry = unref(
      setTimeout(() => endStream(stream, 4006, "authority_revoked"), renewTimeoutMs),
    );
  }

  /** End every lease and view on a bot's tabs that its browser no longer lists. */
  function reconcile(bot, tabs) {
    const live = new Set(tabs.map((tab) => tab.id));
    for (const lease of state.leases.values()) {
      if (lease.profile === bot.profile && !live.has(lease.targetId)) {
        void endLease(lease, "tab-closed", "tab-gone");
      }
    }
    for (const stream of state.streams.values()) {
      if (stream.bot.profile === bot.profile && !live.has(stream.targetId)) {
        endStream(stream, 4004, "target_closed");
      }
    }
  }

  /** End every lease and view of a bot whose browser config no longer matches. */
  function retireBot(bot, reason) {
    for (const lease of state.leases.values()) {
      if (lease.profile === bot.profile) void endLease(lease, "revoked", reason);
    }
    for (const stream of state.streams.values()) {
      if (stream.bot.profile === bot.profile) endStream(stream, 4006, "authority_revoked");
    }
  }

  // ---- admission ----

  /** The caller's connection: its id and the signal that aborts when it closes. */
  function callerOf(opts) {
    const client = opts.client;
    const connId = typeof client?.connId === "string" && client.connId ? client.connId : null;
    const signal = isSignal(client?.connectionSignal) ? client.connectionSignal : undefined;
    const gone = () => signal?.aborted === true || client?.invalidated === true;
    if (!connId) refuse("FORBIDDEN", "no_connection", "this call needs a gateway connection");
    if (gone()) refuse("UNAVAILABLE", "connection_closed", "the connection has closed");
    return { connId, signal, gone };
  }

  /** Call `fn` once when the connection closes; returns the unbinder. */
  function onGone(signal, fn) {
    if (!signal) return () => {};
    signal.addEventListener("abort", fn, { once: true });
    return () => signal.removeEventListener("abort", fn);
  }

  /** The bot of the session the gateway admitted, with a matching browser config. */
  function admitBot(opts) {
    const auth = opts.sessionAccessAuthority;
    const agentId = auth?.target?.agentId;
    if (!auth?.target?.sessionKey || typeof agentId !== "string") {
      refuse("FORBIDDEN", "session_access_required", "this call needs access to a bot's session");
    }
    const bot = bots.get(agentId);
    if (!bot) {
      refuse(
        "UNAVAILABLE",
        "bot_not_configured",
        "this bot has no browser of its own in the computer plugin",
      );
    }
    const problems = browserConfigProblems(currentConfig(), config);
    if (problems.length > 0) {
      retireBot(bot, "browser-config-changed");
      refuse(
        "UNAVAILABLE",
        "browser_config_mismatch",
        `the browser config changed: ${problems[0]}`,
      );
    }
    return { auth, bot };
  }

  const targetIdOf = (params) => {
    const targetId = params?.targetId;
    if (typeof targetId !== "string" || !TARGET_ID.test(targetId)) {
      refuse(
        "INVALID_REQUEST",
        "bad_target",
        "targetId must be a tab id from clawtrate-computer.tabs",
      );
    }
    return targetId;
  };

  async function liveTabs(bot, signal) {
    try {
      const tabs = await cdpTargets(bot, { ...net, signal });
      reconcile(bot, tabs);
      return tabs;
    } catch (error) {
      const reason = error instanceof CdpError ? error.reason : "browser_unavailable";
      return refuse("UNAVAILABLE", reason, "the bot's browser did not answer");
    }
  }

  /** The tab, live in the session's bot's own browser. */
  async function admitTab(bot, targetId, caller) {
    const tab = (await liveTabs(bot, caller.signal)).find((t) => t.id === targetId);
    if (!tab)
      refuse("FORBIDDEN", "tab_not_in_bots_browser", "the tab is not in this bot's browser");
    return tab;
  }

  /** The caller's current lease on the tab, if it holds it with this generation. */
  function heldLease(bot, targetId, caller, generation) {
    const lease = state.leases.get(leaseKey(bot.profile, targetId));
    if (
      !lease ||
      lease.ending ||
      lease.holderConnId !== caller.connId ||
      typeof generation !== "string" ||
      lease.generation !== generation
    ) {
      return null;
    }
    return lease;
  }

  const retainOf = (auth) => {
    try {
      return auth.retain();
    } catch {
      return refuse("FORBIDDEN", "session_access_ended", "the session's access ended");
    }
  };

  // ---- methods ----

  const method = (name, handler) =>
    api.registerGatewayMethod(
      `${PLUGIN_ID}.${name}`,
      async (opts) => {
        try {
          await handler(opts, isPlainObject(opts.params) ? opts.params : {});
        } catch (error) {
          if (!(error instanceof RequestError)) throw error;
          opts.respond(false, undefined, {
            code: error.code,
            message: error.message,
            details: { reason: error.reason },
          });
        }
      },
      { scope: "operator.write", sessionAccess: { mode: "write", requiredTool: "browser" } },
    );

  method("tabs", async (opts) => {
    const caller = callerOf(opts);
    const { bot } = admitBot(opts);
    let tabs;
    try {
      tabs = await cdpTargets(bot, { ...net, signal: caller.signal });
    } catch (error) {
      // An empty list says only that there is nothing to show.
      opts.respond(true, {
        agentId: bot.agentId,
        profile: bot.profile,
        browser: "not-running",
        reason: error instanceof CdpError ? error.reason : "browser_unavailable",
        tabs: [],
      });
      return;
    }
    reconcile(bot, tabs);
    opts.respond(true, {
      agentId: bot.agentId,
      profile: bot.profile,
      browser: "running",
      tabs: tabs.map((tab) => {
        const lease = state.leases.get(leaseKey(bot.profile, tab.id));
        return {
          targetId: tab.id,
          url: tab.url,
          title: tab.title,
          lease:
            lease && !lease.ending
              ? { state: lease.state, mine: lease.holderConnId === caller.connId }
              : null,
        };
      }),
    });
  });

  method("view.open", async (opts, params) => {
    const caller = callerOf(opts);
    const { auth, bot } = admitBot(opts);
    const targetId = targetIdOf(params);
    await admitTab(bot, targetId, caller);
    const mine = [...state.streams.values()].filter((s) => s.connId === caller.connId);
    if (state.streams.size >= MAX_STREAMS || mine.length >= MAX_STREAMS_PER_CONNECTION) {
      refuse("UNAVAILABLE", "too_many_views", "too many views are open");
    }
    if (caller.gone()) refuse("UNAVAILABLE", "connection_closed", "the connection has closed");
    const ticket = randomBytes(24).toString("hex");
    const stream = {
      id: randomUUID(),
      registration,
      bot,
      targetId,
      connId: caller.connId,
      retained: retainOf(auth),
      abort: new AbortController(),
      ticket,
      socket: null,
      cdp: null,
      ended: false,
      unbind: [],
    };
    stream.unbind.push(onGone(caller.signal, () => endStream(stream, 4006, "authority_revoked")));
    if (isSignal(stream.retained.signal)) {
      stream.unbind.push(
        onGone(stream.retained.signal, () => endStream(stream, 4006, "authority_revoked")),
      );
    }
    const expiresAtMs = Date.now() + ticketTtlMs;
    stream.ticketExpiry = unref(
      setTimeout(() => {
        // A ticket that was never used ends its view.
        if (!stream.socket) endStream(stream, 4006, "ticket_expired");
      }, ticketTtlMs),
    );
    state.streams.set(stream.id, stream);
    state.tickets.set(ticket, stream.id);
    armStreamExpiry(stream);
    opts.respond(true, {
      streamId: stream.id,
      wsPath: `${STREAM_PATH}?ticket=${ticket}`,
      expiresAtMs,
      renewWithinMs: renewTimeoutMs,
      targetId,
    });
  });

  method("view.renew", async (opts, params) => {
    const caller = callerOf(opts);
    const { bot } = admitBot(opts);
    const targetId = targetIdOf(params);
    if (params.streamId === undefined && params.generation === undefined) {
      refuse("INVALID_REQUEST", "bad_request", "give a streamId, a generation, or both");
    }
    await admitTab(bot, targetId, caller);
    let streamRenewed = false;
    const stream =
      typeof params.streamId === "string" ? state.streams.get(params.streamId) : undefined;
    if (
      stream &&
      !stream.ended &&
      stream.connId === caller.connId &&
      stream.bot.profile === bot.profile &&
      stream.targetId === targetId
    ) {
      armStreamExpiry(stream);
      streamRenewed = true;
    }
    let leaseRenewed = false;
    const lease = heldLease(bot, targetId, caller, params.generation);
    if (lease && lease.state === "granted") {
      try {
        lease.retained.assertCurrent();
        armLeaseExpiry(lease);
        leaseRenewed = true;
      } catch {
        void endLease(lease, "revoked", "access-revoked");
      }
    }
    opts.respond(true, { ok: true, renewWithinMs: renewTimeoutMs, streamRenewed, leaseRenewed });
  });

  method("control.take", async (opts, params) => {
    const caller = callerOf(opts);
    const { auth, bot } = admitBot(opts);
    const targetId = targetIdOf(params);
    await admitTab(bot, targetId, caller);
    const key = leaseKey(bot.profile, targetId);
    if (state.leases.has(key)) {
      refuse("UNAVAILABLE", "control_held", "someone has or is taking control of this tab");
    }
    if (caller.gone()) refuse("UNAVAILABLE", "connection_closed", "the connection has closed");
    const lease = {
      key,
      registration,
      agentId: bot.agentId,
      profile: bot.profile,
      targetId,
      bot,
      generation: randomBytes(16).toString("hex"),
      holderConnId: caller.connId,
      state: "draining",
      retained: retainOf(auth),
      abort: new AbortController(),
      queue: Promise.resolve(),
      ending: false,
      ended: null,
      cdp: null,
      unbind: [],
    };
    state.leases.set(key, lease);
    lease.unbind.push(
      onGone(caller.signal, () => void endLease(lease, "revoked", "connection-closed")),
    );
    if (isSignal(lease.retained.signal)) {
      lease.unbind.push(
        onGone(lease.retained.signal, () => void endLease(lease, "revoked", "access-revoked")),
      );
    }
    emitControl(lease, "draining");
    changed();
    // New bot calls are blocked from now on; running ones get drainTimeoutMs.
    const drained = await waitUntil(
      () => runningCalls(bot.profile) === 0,
      drainTimeoutMs,
      lease.abort.signal,
    );
    if (lease.ending)
      refuse("UNAVAILABLE", "control_request_ended", "the request for control ended");
    if (!drained) {
      const running = runningCalls(bot.profile);
      await endLease(lease, "busy", "bot-still-acting");
      opts.respond(true, {
        state: "busy",
        reason: "the bot is still acting in this browser",
        runningCalls: running,
        generation: lease.generation,
      });
      return;
    }
    try {
      lease.retained.assertCurrent();
    } catch {
      await endLease(lease, "revoked", "access-revoked");
      refuse("FORBIDDEN", "session_access_ended", "the session's access ended");
    }
    // The lease's own connection to the tab: input goes through it, and the
    // lease ends when it closes (the tab or the browser went away).
    try {
      lease.cdp = await openCdp(bot, targetId, { ...net, signal: lease.abort.signal });
    } catch (error) {
      if (!lease.ending) {
        const gone = error instanceof CdpError && error.reason === "target_gone";
        await endLease(
          lease,
          gone ? "tab-closed" : "revoked",
          gone ? "tab-gone" : "browser-unavailable",
        );
      }
      refuse("UNAVAILABLE", "control_request_ended", "could not connect to the tab");
    }
    lease.cdp.onClose(() => void endLease(lease, "tab-closed", "target-closed"));
    if (lease.ending)
      refuse("UNAVAILABLE", "control_request_ended", "the request for control ended");
    lease.state = "granted";
    armLeaseExpiry(lease);
    emitControl(lease, "granted");
    opts.respond(true, {
      state: "granted",
      generation: lease.generation,
      renewWithinMs: renewTimeoutMs,
      targetId,
    });
  });

  method("control.release", async (opts, params) => {
    const caller = callerOf(opts);
    const { bot } = admitBot(opts);
    // No browser round trip: a release completes even when the browser is stalled.
    const targetId = targetIdOf(params);
    const lease = heldLease(bot, targetId, caller, params.generation);
    if (!lease) {
      refuse("FORBIDDEN", "not_holder", "only the current holder can release, with its generation");
    }
    await endLease(lease, "released", "released");
    opts.respond(true, { state: "released", generation: lease.generation, targetId });
  });

  method("input", async (opts, params) => {
    const caller = callerOf(opts);
    const { bot } = admitBot(opts);
    const targetId = targetIdOf(params);
    if (typeof params.generation !== "string" || !GENERATION.test(params.generation)) {
      refuse("FORBIDDEN", "not_holder", "take control first");
    }
    const commands = inputCommands(params);
    const lease = heldLease(bot, targetId, caller, params.generation);
    if (!lease || lease.state !== "granted")
      refuse("FORBIDDEN", "not_holder", "take control first");
    // The holder, the lease and the session's access are checked again
    // before every command, so input admitted under a lease cannot land
    // after it ends.
    const stillHeld = () => {
      if (lease.ending || state.leases.get(lease.key) !== lease || lease.state !== "granted") {
        throw new CdpError("lease_ended", "control ended");
      }
      lease.retained.assertCurrent();
    };
    try {
      await exclusive(lease, async () => {
        for (const [name, args] of commands) {
          stillHeld();
          if (!lease.cdp || lease.cdp.closed) throw new CdpError("closed", "the tab closed");
          await lease.cdp.send(name, args, { signal: lease.abort.signal });
        }
      });
    } catch (error) {
      if (!(error instanceof CdpError)) void endLease(lease, "revoked", "access-revoked");
      refuse(
        "UNAVAILABLE",
        "input_not_delivered",
        `input not delivered: ${error?.message ?? error}`,
      );
    }
    if (!lease.ending) armLeaseExpiry(lease);
    opts.respond(true, { ok: true });
  });

  // ---- the stream ----

  api.registerHttpRoute({
    path: STREAM_PATH,
    auth: "plugin",
    match: "exact",
    handler: (_req, res) => {
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("websocket upgrade required");
      return true;
    },
    handleUpgrade: async (req, socket, head) => {
      socket.on("error", () => {});
      const ticket = new URL(req.url ?? "", "http://127.0.0.1").searchParams.get("ticket") ?? "";
      // One use: deleted before anything else can happen.
      const streamId = state.tickets.get(ticket);
      state.tickets.delete(ticket);
      const stream = streamId ? state.streams.get(streamId) : undefined;
      if (!stream || stream.ended || stream.socket) {
        refuseUpgrade(socket, 401, "Unauthorized");
        return true;
      }
      stream.ticket = null;
      clearTimeout(stream.ticketExpiry);
      try {
        stream.retained.assertCurrent();
      } catch {
        endStream(stream, 4006, "authority_revoked");
        refuseUpgrade(socket, 401, "Unauthorized");
        return true;
      }
      if (!acceptUpgrade(req, socket)) {
        endStream(stream, 1002, "bad_upgrade");
        refuseUpgrade(socket, 400, "Bad Request");
        return true;
      }
      stream.socket = socket;
      socket.setNoDelay?.(true);
      const read = frameReader(
        ({ opcode, payload }) => {
          if (opcode === 0x8) endStream(stream, 1000, "closed");
          else if (opcode === 0x9 && !socket.destroyed) socket.write(frame(0xa, payload));
        },
        (code, reason) => endStream(stream, code, reason),
      );
      socket.on("data", read);
      socket.on("close", () => endStream(stream, 1000, "closed"));
      if (head?.length) read(head);
      let cdp;
      try {
        cdp = await openCdp(stream.bot, stream.targetId, { ...net, signal: stream.abort.signal });
      } catch (error) {
        const gone = error instanceof CdpError && error.reason === "target_gone";
        endStream(stream, gone ? 4004 : 1011, gone ? "target_closed" : "browser_unavailable");
        return true;
      }
      if (stream.ended) {
        cdp.close();
        return true;
      }
      stream.cdp = cdp;
      let url = cdp.target.url;
      cdp.onClose(() => endStream(stream, 4004, "target_closed"));
      socket.write(
        textFrame({ type: "ready", targetId: stream.targetId, url, title: cdp.target.title }),
      );
      cdp.on((message) => {
        if (stream.ended) return;
        if (message.method === "Page.screencastFrame") {
          const { data, metadata = {}, sessionId } = message.params ?? {};
          void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
          try {
            stream.retained.assertCurrent();
          } catch {
            endStream(stream, 4006, "authority_revoked");
            return;
          }
          if (typeof data !== "string" || socket.destroyed) return;
          if (socket.writableLength > STREAM_BUFFER_LIMIT) return;
          // The built-in screencast's layout, so one decoder serves both:
          // a 4-byte big-endian header length, the JSON header, the JPEG.
          const header = Buffer.from(
            JSON.stringify({
              url,
              cssWidth: metadata.deviceWidth,
              cssHeight: metadata.deviceHeight,
              scrollX: metadata.scrollOffsetX,
              scrollY: metadata.scrollOffsetY,
              ts: metadata.timestamp,
            }),
          );
          const length = Buffer.alloc(4);
          length.writeUInt32BE(header.length, 0);
          socket.write(binaryFrame(Buffer.concat([length, header, Buffer.from(data, "base64")])));
        } else if (message.method === "Page.frameNavigated" && !message.params?.frame?.parentId) {
          url = String(message.params?.frame?.url ?? "").slice(0, 2048);
          socket.write(textFrame({ type: "meta", url }));
        } else if (message.method === "Inspector.detached") {
          endStream(stream, 4004, "target_closed");
        }
      });
      try {
        await cdp.send("Page.enable", {}, { signal: stream.abort.signal });
        await cdp.send(
          "Page.startScreencast",
          { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 },
          { signal: stream.abort.signal },
        );
      } catch {
        if (!stream.ended) endStream(stream, 1011, "browser_unavailable");
      }
      return true;
    },
  });

  // ---- the bot's browser tool ----

  // Highest priority: the pin is in place before any other hook can ask for
  // approval of the call's parameters, and a block here ends the decision.
  api.on(
    "before_tool_call",
    (event, ctx) => {
      if (event?.toolName !== "browser") return undefined;
      const params = isPlainObject(event.params) ? event.params : {};
      const bot = bots.get(ctx?.agentId);
      if (!bot) {
        // Every other agent stays out of the bots' profiles, by any spelling,
        // by default, as an import destination or through a dashboard.
        const named = profileSelector(params.profile) ?? defaultProfileOf(currentConfig());
        // An import with no `into` goes to DEFAULT_IMPORT_PROFILE, which is never a bot's.
        const into = profileSelector(params.into) ?? DEFAULT_IMPORT_PROFILE;
        if (profiles.has(named) || profiles.has(into)) {
          return { block: true, blockReason: "That browser profile belongs to another bot." };
        }
        if (params.dashboard !== undefined) {
          return {
            block: true,
            blockReason: "Browser dashboards are off while bots have browsers of their own.",
          };
        }
        return undefined;
      }
      const action = toolString(params.action);
      if (!BOT_ACTIONS.has(action)) {
        return {
          block: true,
          blockReason: `Browser action "${action ?? ""}" is not available to this bot.`,
        };
      }
      const target = toolString(params.target);
      if (
        params.node !== undefined ||
        params.dashboard !== undefined ||
        params.into !== undefined ||
        (target !== undefined && target !== "host")
      ) {
        return {
          block: true,
          blockReason:
            "This bot's browser is its own, on the gateway's machine; node, sandbox, dashboard and import routing are not allowed.",
        };
      }
      const runId = toolString(event.runId) ?? toolString(ctx?.runId);
      const toolCallId = toolString(event.toolCallId) ?? toolString(ctx?.toolCallId);
      if (!runId || !toolCallId) {
        return {
          block: true,
          blockReason:
            "A browser call without a run and call id cannot be tracked, so it is refused.",
        };
      }
      if (leaseOnProfile(bot.profile)) return { block: true, blockReason: BLOCKED_WHILE_HELD };
      if (browserConfigProblems(currentConfig(), config).length > 0) {
        return {
          block: true,
          blockReason: "This bot's browser is not set up as the computer plugin expects.",
        };
      }
      const key = callKey(runId, toolCallId);
      const record = { agentId: bot.agentId, profile: bot.profile };
      state.inflight.set(key, record);
      // A cancelled call is no longer running.
      const signal = ctx?.abortSignal;
      if (isSignal(signal)) {
        const forget = () => {
          if (state.inflight.get(key) === record) {
            state.inflight.delete(key);
            changed();
          }
        };
        if (signal.aborted) forget();
        else signal.addEventListener("abort", forget, { once: true });
      }
      // target "host": never a node or sandbox browser; when host control is
      // not allowed for the session, the browser tool refuses the call.
      return { params: { ...params, action, profile: bot.profile, target: "host" } };
    },
    { matcher: ["browser"], priority: 1000 },
  );

  api.on(
    "after_tool_call",
    (event, ctx) => {
      if (event?.toolName !== "browser") return;
      const runId = toolString(event.runId) ?? toolString(ctx?.runId);
      const toolCallId = toolString(event.toolCallId) ?? toolString(ctx?.toolCallId);
      if (!runId || !toolCallId) return;
      const key = callKey(runId, toolCallId);
      const record = state.inflight.get(key);
      // Only the matching record, and only for the same agent.
      if (record && record.agentId === ctx?.agentId) {
        state.inflight.delete(key);
        changed();
        const ran = profileSelector(event.params?.profile);
        if (ran !== undefined && ran !== record.profile) {
          warn(`a browser call of ${record.agentId} ran with profile ${ran}, not its own`);
        }
      }
    },
    { matcher: ["browser"] },
  );

  // ---- events and shutdown ----

  async function stop() {
    const endings = [];
    for (const lease of state.leases.values()) {
      if (lease.registration === registration)
        endings.push(endLease(lease, "revoked", "plugin-stopped"));
    }
    for (const stream of state.streams.values()) {
      if (stream.registration === registration) endStream(stream, 1012, "shutdown");
    }
    await Promise.all(endings);
    emitEvent = () => {};
  }

  // Service ids are global across plugins, so this one carries the plugin's id.
  api.registerService({
    id: `${PLUGIN_ID}-control`,
    start(ctx) {
      const events = ctx?.gatewayEvents;
      emitEvent = events
        ? (name, payload) => events.emit(name, payload, { scope: "operator.read" })
        : () => {};
    },
    stop,
  });

  return { state, config, stop };
}

export default {
  id: PLUGIN_ID,
  name: "Clawtrate computer",
  description:
    "A browser of its own for each configured bot, a live view of it, and a person's takeover and hand-back.",
  register(api) {
    createComputer(api);
  },
};
