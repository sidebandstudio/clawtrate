// clawtrate-computer: research prototype.
//
// Gives a non-admin client a live view of a bot's browser and lets the user
// take control of a tab. Isolation model: one managed browser profile per bot.
// The plugin pins every `browser` tool call of a configured bot to that bot's
// profile (before_tool_call params rewrite) and blocks any other agent from
// naming it. Which tabs a caller may view therefore follows from which bot the
// caller's session belongs to, checked by the host, plus the live target list
// of that bot's own CDP endpoint. Nothing is inferred from tool results.
//
// Entry points (all available to an ordinary user-installed plugin):
//   api.registerGatewayMethod with sessionAccess (operator.write, browser tool)
//   api.registerHttpRoute with handleUpgrade (auth: "plugin", ticket checked here)
//   api.on("before_tool_call") / api.on("after_tool_call")
//   api.registerService (ctx.gatewayEvents.emit)
//   api.pluginConfig: { bots: { <agentId>: { profile, cdpUrl } }, drainTimeoutMs? }
//   Node's global fetch and WebSocket, for CDP on literal loopback only
// No dependencies. Not production code. Tests: node test.mjs

import crypto from "node:crypto";

const PLUGIN = "clawtrate-computer";
const TICKET_TTL_MS = 60_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
// A plugin is not told when a gateway connection ends, so viewers renew over
// their authenticated connection; unrenewed streams and leases expire.
const RENEW_TIMEOUT_MS = 20_000;

// The host can load this module more than once (one instance served the agent
// hooks, another the gateway methods, live), so shared state lives on one
// process-wide slot. Tests reset it through STATE_KEY.
export const STATE_KEY = Symbol.for("clawtrate-computer.state.v2");
const STATE = (globalThis[STATE_KEY] ??= {});
STATE.inflight ??= new Map(); // toolCallId -> { profile, runId, startedAt }
STATE.leases ??= new Map(); // leaseKey(profile, targetId) -> lease
STATE.tickets ??= new Map(); // ticket -> { bot, targetId, streamId, expiresAt, retained }
STATE.streams ??= new Map(); // streamId -> { bot, targetId, renewedAt }

const leaseKey = (profile, targetId) => `${profile}\n${targetId}`;

/** Accept only a literal loopback HTTP origin: http://127.0.0.1:<port> or http://[::1]:<port>. */
export function parseCdpUrl(raw) {
  const m = /^http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/?$/.exec(String(raw ?? ""));
  if (!m) throw new Error(`cdpUrl must be http://127.0.0.1:<port> or http://[::1]:<port>, got ${JSON.stringify(raw)}`);
  const port = Number(m[2]);
  if (port < 1 || port > 65535) throw new Error("cdpUrl port out of range");
  return { host: m[1], port, base: `http://${m[1]}:${port}` };
}

/** Parse and validate the plugin config. Throws on anything unexpected. */
export function parseConfig(raw = {}) {
  const bots = new Map();
  const profiles = new Set();
  for (const [agentId, entry] of Object.entries(raw.bots ?? {})) {
    const profile = String(entry?.profile ?? "");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile)) throw new Error(`bad profile for ${agentId}`);
    if (profiles.has(profile)) throw new Error(`profile ${profile} is assigned to two bots`);
    profiles.add(profile);
    bots.set(agentId, { agentId, profile, ...parseCdpUrl(entry?.cdpUrl) });
  }
  const drain = Number(raw.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  const drainTimeoutMs = Number.isFinite(drain) ? Math.min(Math.max(drain, 10), 60_000) : DEFAULT_DRAIN_TIMEOUT_MS;
  return { bots, profiles, drainTimeoutMs };
}

/** Live page targets of one bot's browser. Refuses redirects and foreign WebSocket endpoints. */
export async function cdpTargets(bot) {
  const res = await fetch(`${bot.base}/json/list`, { redirect: "error" });
  if (!res.ok) throw new Error(`CDP list failed: ${res.status}`);
  const list = await res.json();
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (t?.type !== "page" || typeof t.id !== "string") continue;
    // The debugger URL must be this endpoint, this target.
    if (t.webSocketDebuggerUrl !== `ws://${bot.host}:${bot.port}/devtools/page/${t.id}`) continue;
    out.push({ id: t.id, url: String(t.url ?? ""), title: String(t.title ?? ""), ws: t.webSocketDebuggerUrl });
  }
  return out;
}

/** Minimal CDP client over one validated page target. */
export async function openCdp(bot, targetId) {
  const target = (await cdpTargets(bot)).find((t) => t.id === targetId);
  if (!target) throw new Error("target not found");
  const ws = new WebSocket(target.ws);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP connect failed")), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  const closeListeners = new Set();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  });
  ws.addEventListener("close", () => {
    for (const p of pending.values()) p.reject(new Error("CDP closed"));
    pending.clear();
    for (const l of closeListeners) l();
  });
  return {
    target,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    on: (fn) => listeners.add(fn),
    onClose: (fn) => closeListeners.add(fn),
    close: () => ws.close(),
  };
}

/** Run fn after everything already queued on this lease (input, release, expiry). */
function exclusive(lease, fn) {
  const run = lease.queue.then(fn, fn);
  lease.queue = run.catch(() => {});
  return run;
}

// --- minimal server-side WebSocket framing (server frames are unmasked) ---
function wsAccept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) return false;
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return true;
}
function wsFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}
const wsText = (socket, obj) => socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(obj))));
const wsClose = (socket, code, reason) => {
  const b = Buffer.alloc(2 + Buffer.byteLength(reason));
  b.writeUInt16BE(code, 0);
  b.write(reason, 2);
  socket.end(wsFrame(0x8, b));
};

export default {
  id: PLUGIN,
  name: "Clawtrate computer",
  description: "Research prototype: live view and user takeover of a bot's own browser profile.",
  register(api) {
    const cfg = parseConfig(api.pluginConfig ?? {});
    const { bots, profiles, drainTimeoutMs } = cfg;
    const { inflight, leases, tickets, streams } = STATE;
    let emit = () => {};
    const err = (respond, code, message) => respond(false, undefined, { code, message });

    // Service ids are global across plugins, so make this one unique.
    api.registerService({
      id: "clawtrate-computer-events",
      start(ctx) {
        emit = ctx.gatewayEvents ? (n, p) => ctx.gatewayEvents.emit(n, p, { scope: "operator.read" }) : () => {};
        // Expire leases whose holder stopped renewing; serialized with input.
        STATE.leaseTimer = setInterval(() => {
          for (const [key, lease] of leases) {
            if (Date.now() - lease.renewedAt > RENEW_TIMEOUT_MS) endLease(key, lease, "expired");
          }
        }, 2_000);
      },
      stop() {
        clearInterval(STATE.leaseTimer);
        emit = () => {};
      },
    });

    function endLease(key, lease, state) {
      lease.ending = true;
      return exclusive(lease, () => {
        if (leases.get(key) === lease) leases.delete(key);
        lease.retained?.release?.();
        emit("control", { profile: lease.profile, targetId: lease.targetId, holder: "bot", state });
      });
    }

    // Pin each configured bot's browser calls to its own profile, refuse calls
    // that could leave it, block while a user holds control, and track running
    // calls by their host toolCallId.
    api.on("before_tool_call", (event, ctx) => {
      if (event.toolName !== "browser") return;
      const params = event.params ?? {};
      const bot = bots.get(ctx?.agentId);
      if (!bot) {
        if (typeof params.profile === "string" && profiles.has(params.profile)) {
          return { block: true, blockReason: "That browser profile belongs to another bot." };
        }
        return;
      }
      if (params.node !== undefined || params.target !== undefined || params.dashboard !== undefined) {
        return { block: true, blockReason: "This bot's browser is pinned to its own profile; node, target and dashboard routing are not allowed." };
      }
      if (typeof event.toolCallId !== "string" || !event.toolCallId) {
        return { block: true, blockReason: "Browser call without a tool call id cannot be tracked; refused." };
      }
      for (const lease of leases.values()) {
        if (lease.profile === bot.profile) {
          return { block: true, blockReason: "The user has control of this bot's browser. Wait until they release it." };
        }
      }
      inflight.set(event.toolCallId, { profile: bot.profile, runId: event.runId ?? ctx?.runId, startedAt: Date.now() });
      return { params: { ...params, profile: bot.profile } };
    });
    api.on("after_tool_call", (event) => {
      if (event.toolName === "browser" && typeof event.toolCallId === "string") inflight.delete(event.toolCallId);
    });

    /** The host checked session access and browser tool policy; map the session to its bot. */
    function admitBot(opts) {
      const auth = opts.sessionAccessAuthority;
      const bot = bots.get(auth?.target?.agentId);
      if (!auth?.target?.sessionKey || !bot) return err(opts.respond, "FORBIDDEN", "this session's bot has no browser view"), null;
      return { auth, bot };
    }
    async function admitTab(opts) {
      const admitted = admitBot(opts);
      if (!admitted) return null;
      const targetId = typeof opts.params.targetId === "string" ? opts.params.targetId : "";
      const tabs = await cdpTargets(admitted.bot).catch(() => null);
      if (!tabs) return err(opts.respond, "UNAVAILABLE", "the bot's browser is not running"), null;
      const tab = tabs.find((t) => t.id === targetId);
      if (!tab) return err(opts.respond, "FORBIDDEN", "tab is not in this bot's browser"), null;
      return { ...admitted, targetId, tab, key: leaseKey(admitted.bot.profile, targetId) };
    }
    const holderOf = (opts) => (typeof opts.client?.connId === "string" && opts.client.connId) || null;
    function currentLease(opts, admitted) {
      const lease = leases.get(admitted.key);
      const holder = holderOf(opts);
      if (!lease || !holder || lease.holderConnId !== holder || lease.generation !== opts.params.generation) return null;
      return lease;
    }

    const sessionScoped = { scope: "operator.write", sessionAccess: { mode: "write", requiredTool: "browser" } };

    api.registerGatewayMethod(
      `${PLUGIN}.tabs`,
      async (opts) => {
        const admitted = admitBot(opts);
        if (!admitted) return;
        const tabs = await cdpTargets(admitted.bot).catch(() => []);
        const live = new Set(tabs.map((t) => t.id));
        for (const [key, lease] of leases) if (lease.profile === admitted.bot.profile && !live.has(lease.targetId)) endLease(key, lease, "tab-closed");
        opts.respond(true, {
          profile: admitted.bot.profile,
          tabs: tabs.map((t) => ({ targetId: t.id, url: t.url, title: t.title, lease: leases.get(leaseKey(admitted.bot.profile, t.id))?.state ?? null })),
        });
      },
      sessionScoped,
    );

    api.registerGatewayMethod(
      `${PLUGIN}.view.open`,
      async (opts) => {
        const admitted = await admitTab(opts);
        if (!admitted) return;
        const ticket = crypto.randomBytes(24).toString("hex");
        const streamId = crypto.randomUUID();
        streams.set(streamId, { bot: admitted.bot, targetId: admitted.targetId, renewedAt: Date.now() });
        tickets.set(ticket, { bot: admitted.bot, targetId: admitted.targetId, streamId, expiresAt: Date.now() + TICKET_TTL_MS, retained: admitted.auth.retain() });
        opts.respond(true, { wsPath: `/${PLUGIN}/stream?ticket=${ticket}`, streamId, renewWithinMs: RENEW_TIMEOUT_MS, expiresAtMs: Date.now() + TICKET_TTL_MS, targetId: admitted.targetId });
      },
      sessionScoped,
    );

    // Renews a stream and, for the holder, the lease. The host re-checks
    // session access on every call, so revocation applies by the next renewal.
    api.registerGatewayMethod(
      `${PLUGIN}.view.renew`,
      async (opts) => {
        const admitted = await admitTab(opts);
        if (!admitted) return;
        const stream = streams.get(opts.params.streamId);
        if (!stream || stream.targetId !== admitted.targetId || stream.bot.profile !== admitted.bot.profile) return err(opts.respond, "NOT_FOUND", "unknown stream");
        stream.renewedAt = Date.now();
        const lease = currentLease(opts, admitted);
        if (lease) lease.renewedAt = Date.now();
        opts.respond(true, { ok: true, renewWithinMs: RENEW_TIMEOUT_MS, leaseRenewed: Boolean(lease) });
      },
      sessionScoped,
    );

    // Takes control of one tab. New bot calls on this bot's profile are blocked
    // at once; running calls must finish within drainTimeoutMs, otherwise the
    // take fails closed with state "busy" and nothing is granted.
    api.registerGatewayMethod(
      `${PLUGIN}.control.take`,
      async (opts) => {
        const admitted = await admitTab(opts);
        if (!admitted) return;
        const holder = holderOf(opts);
        if (!holder) return err(opts.respond, "FORBIDDEN", "no connection identity");
        if (leases.has(admitted.key)) return err(opts.respond, "CONFLICT", "control of this tab is already held or being taken");
        const lease = {
          generation: crypto.randomBytes(16).toString("hex"),
          holderConnId: holder,
          profile: admitted.bot.profile,
          targetId: admitted.targetId,
          bot: admitted.bot,
          state: "draining",
          renewedAt: Date.now(),
          retained: admitted.auth.retain(),
          queue: Promise.resolve(),
        };
        leases.set(admitted.key, lease);
        emit("control", { profile: lease.profile, targetId: lease.targetId, holder: "user", state: "draining" });
        const busy = () => [...inflight.values()].filter((c) => c.profile === lease.profile).length;
        const deadline = Date.now() + drainTimeoutMs;
        while (busy() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        if (leases.get(admitted.key) !== lease || lease.ending) return err(opts.respond, "CONFLICT", "lease ended while draining");
        if (busy() > 0) {
          await endLease(admitted.key, lease, "busy");
          return opts.respond(true, { state: "busy", reason: "the bot is still acting in this browser", runningCalls: busy() });
        }
        try {
          lease.retained.assertCurrent();
        } catch {
          await endLease(admitted.key, lease, "revoked");
          return err(opts.respond, "FORBIDDEN", "session access ended");
        }
        lease.state = "granted";
        emit("control", { profile: lease.profile, targetId: lease.targetId, holder: "user", state: "granted" });
        opts.respond(true, { state: "granted", generation: lease.generation, renewWithinMs: RENEW_TIMEOUT_MS });
      },
      sessionScoped,
    );

    api.registerGatewayMethod(
      `${PLUGIN}.control.release`,
      async (opts) => {
        const admitted = await admitTab(opts);
        if (!admitted) return;
        const lease = currentLease(opts, admitted);
        if (!lease) return err(opts.respond, "FORBIDDEN", "only the current holder can release, with its generation");
        await endLease(admitted.key, lease, "released");
        opts.respond(true, { state: "released" });
      },
      sessionScoped,
    );

    api.registerGatewayMethod(
      `${PLUGIN}.input`,
      async (opts) => {
        const admitted = await admitTab(opts);
        if (!admitted) return;
        const lease = currentLease(opts, admitted);
        if (!lease || lease.state !== "granted") return err(opts.respond, "FORBIDDEN", "take control first");
        const { kind, x, y, text, deltaY } = opts.params;
        if (!["click", "scroll", "text"].includes(kind)) return err(opts.respond, "INVALID_REQUEST", "kind must be click, scroll or text");
        // Re-check holder, lease and session authority before every command.
        const stillHeld = () => {
          if (leases.get(admitted.key) !== lease || lease.ending || lease.state !== "granted") throw new Error("lease ended");
          lease.retained.assertCurrent();
        };
        try {
          await exclusive(lease, async () => {
            stillHeld();
            const cdp = await openCdp(lease.bot, lease.targetId);
            try {
              const send = async (method, p) => {
                stillHeld();
                await cdp.send(method, p);
              };
              if (kind === "click") {
                for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
              } else if (kind === "scroll") {
                await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: x ?? 10, y: y ?? 10, deltaX: 0, deltaY: deltaY ?? 300 });
              } else {
                await send("Input.insertText", { text: String(text ?? "") });
              }
            } finally {
              cdp.close();
            }
          });
          lease.renewedAt = Date.now();
          opts.respond(true, { ok: true });
        } catch (e) {
          err(opts.respond, "CONFLICT", `input not delivered: ${e?.message ?? e}`);
        }
      },
      sessionScoped,
    );

    api.registerHttpRoute({
      path: `/${PLUGIN}/stream`,
      auth: "plugin",
      handler: (_req, res) => {
        res.writeHead(426, { "content-type": "text/plain" });
        res.end("websocket upgrade required");
        return true;
      },
      handleUpgrade: async (req, socket) => {
        const ticket = new URL(req.url ?? "", "http://x").searchParams.get("ticket") ?? "";
        const grant = tickets.get(ticket);
        tickets.delete(ticket);
        if (!grant || grant.expiresAt < Date.now()) {
          socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
          return true;
        }
        if (!wsAccept(req, socket)) return true;
        let cdp;
        let stopped = false;
        let url = "";
        const watchdog = setInterval(() => {
          const stream = streams.get(grant.streamId);
          if (!stream || Date.now() - stream.renewedAt > RENEW_TIMEOUT_MS) stop(4006, "authority_revoked");
        }, 2_000);
        const stop = (code, reason) => {
          if (stopped) return;
          stopped = true;
          clearInterval(watchdog);
          streams.delete(grant.streamId);
          cdp?.send("Page.stopScreencast").catch(() => {});
          cdp?.close();
          grant.retained?.release?.();
          if (!socket.destroyed) wsClose(socket, code, reason);
        };
        grant.retained?.signal?.addEventListener?.("abort", () => stop(4006, "authority_revoked"), { once: true });
        socket.on("close", () => stop(1000, "closed"));
        // Viewers send nothing but a close frame (opcode 8); answer it and end.
        socket.on("data", (chunk) => {
          if ((chunk[0] & 0x0f) === 0x8) stop(1000, "closed");
        });
        try {
          cdp = await openCdp(grant.bot, grant.targetId);
          url = cdp.target.url;
          cdp.onClose(() => stop(4004, "target_closed"));
          wsText(socket, { type: "ready", targetId: grant.targetId, url, title: cdp.target.title });
          cdp.on((msg) => {
            if (msg.method === "Page.screencastFrame") {
              const { data, metadata, sessionId } = msg.params;
              cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
              try {
                grant.retained?.assertCurrent?.();
              } catch {
                return stop(4006, "authority_revoked");
              }
              // Same header fields as the built-in screencast, so one decoder serves both.
              const header = Buffer.from(
                JSON.stringify({ url, cssWidth: metadata.deviceWidth, cssHeight: metadata.deviceHeight, scrollX: metadata.scrollOffsetX, scrollY: metadata.scrollOffsetY, ts: metadata.timestamp }),
              );
              const len = Buffer.alloc(4);
              len.writeUInt32BE(header.length, 0);
              if (socket.writableLength < 4 * 1024 * 1024) socket.write(wsFrame(0x2, Buffer.concat([len, header, Buffer.from(data, "base64")])));
            } else if (msg.method === "Page.frameNavigated" && !msg.params.frame.parentId) {
              url = String(msg.params.frame.url ?? "");
              wsText(socket, { type: "meta", url });
            } else if (msg.method === "Inspector.detached" || msg.method === "Target.targetDestroyed") {
              stop(4004, "target_closed");
            }
          });
          await cdp.send("Page.enable");
          await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
        } catch (e) {
          stop(4004, String(e?.message ?? e).slice(0, 100));
        }
        return true;
      },
    });
  },
};
