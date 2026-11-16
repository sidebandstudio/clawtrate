// clawtrate-computer: research prototype.
//
// Shows the bot's managed-browser tab to a non-admin client and lets the user
// take control of that tab. Uses only entry points available to an ordinary
// user-installed plugin:
//   - api.registerGatewayMethod with sessionAccess (operator.write, browser tool)
//   - api.registerHttpRoute with handleUpgrade (auth: "plugin", ticket checked here)
//   - api.on("before_tool_call") / api.on("after_tool_call")
//   - api.pluginConfig.cdpUrl, the managed profile's loopback CDP endpoint
//   - Node's global WebSocket and fetch, to talk CDP directly
// No dependencies. Not production code.

import crypto from "node:crypto";

const PLUGIN = "clawtrate-computer";
const TICKET_TTL_MS = 60_000;
const DRAIN_TIMEOUT_MS = 15_000;
// A plugin is not told when a gateway connection ends, so viewers must renew
// over their authenticated connection; unrenewed streams and leases expire.
const RENEW_TIMEOUT_MS = 20_000;

// The host can load this module more than once (for example one instance for
// gateway methods and another for agent hooks), so shared state lives on one
// process-wide slot rather than in module scope.
const STATE = (globalThis[Symbol.for("clawtrate-computer.state")] ??= {});
// It also survives plugin replacement, so fill in each field separately.
/** targetId -> Set<sessionKey> that opened or used the tab through the browser tool. */
STATE.owners ??= new Map();
/** targetId -> { holderConnId, sessionKey, state: "draining" | "granted", since, renewedAt } */
STATE.leases ??= new Map();
/** browser tool calls currently running, keyed by toolCallId */
STATE.inflight ??= new Map();
/** ticket -> { targetId, sessionKey, expiresAt, retained, streamId } */
STATE.tickets ??= new Map();
/** streamId -> { targetId, sessionKey, renewedAt } */
STATE.streams ??= new Map();
const { owners, leases, inflight, tickets, streams } = STATE;
let cdpBase = "http://127.0.0.1:19112";
let emit = () => {};

const err = (respond, code, message) => respond(false, undefined, { code, message });

function targetsIn(value, out = new Set()) {
  if (!value || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) {
    if ((k === "targetId" || k === "nativeTargetId") && typeof v === "string" && /^[A-F0-9]{16,}$/i.test(v)) out.add(v);
    else if (v && typeof v === "object") targetsIn(v, out);
  }
  return out;
}

async function cdpTargets() {
  const res = await fetch(`${cdpBase}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: ${res.status}`);
  return (await res.json()).filter((t) => t.type === "page");
}

/** Minimal CDP client over one page target. */
async function openCdp(targetId) {
  const target = (await cdpTargets()).find((t) => t.id === targetId);
  if (!target) throw new Error("target not found");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP connect failed")), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
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
    close: () => ws.close(),
  };
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
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (len >= 126 && len < 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else if (len >= 65536) {
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

/** Shared admission for every method: session access is checked by the host; the tab check is ours. */
function admitTab(opts) {
  const { params, respond, sessionAccessAuthority } = opts;
  const sessionKey = sessionAccessAuthority?.target?.sessionKey;
  const targetId = typeof params.targetId === "string" ? params.targetId : "";
  if (!sessionKey) return err(respond, "FORBIDDEN", "session access required"), null;
  if (!owners.get(targetId)?.has(sessionKey)) return err(respond, "FORBIDDEN", "tab is not attached to this session"), null;
  return { sessionKey, targetId };
}

export default {
  id: PLUGIN,
  name: "Clawtrate computer",
  description: "Research prototype: live view and user takeover of a bot's browser tab.",
  register(api) {
    if (typeof api.pluginConfig?.cdpUrl === "string") cdpBase = api.pluginConfig.cdpUrl.replace(/\/$/, "");

    api.registerService({
      id: "events",
      start(ctx) {
        emit = ctx.gatewayEvents ? (n, p) => ctx.gatewayEvents.emit(n, p, { scope: "operator.read" }) : () => {};
        // Expire leases whose holder stopped renewing (closed app, lost network).
        STATE.leaseTimer = setInterval(() => {
          for (const [targetId, lease] of leases) {
            if (Date.now() - lease.renewedAt > RENEW_TIMEOUT_MS) {
              leases.delete(targetId);
              emit("control", { targetId, holder: "bot", state: "expired" });
            }
          }
        }, 2_000);
      },
      stop() {
        clearInterval(STATE.leaseTimer);
        emit = () => {};
      },
    });

    // Learn which session uses which tab, and count running browser calls.
    api.on("before_tool_call", (event, ctx) => {
      if (event.toolName !== "browser") return;
      // Conservative v1: tab handles like "t1" cannot be resolved by a plugin,
      // so any granted lease blocks every bot browser call on this profile.
      for (const [targetId, lease] of leases) {
        if (lease.state === "granted" || lease.state === "draining") {
          return { block: true, blockReason: `The user has control of a browser tab (${targetId.slice(0, 8)}). Wait until they release it.` };
        }
      }
      inflight.set(event.toolCallId ?? crypto.randomUUID(), { sessionKey: ctx.sessionKey, startedAt: Date.now() });
    });
    api.on("after_tool_call", (event, ctx) => {
      if (event.toolName !== "browser") return;
      inflight.delete(event.toolCallId);
      if (!ctx.sessionKey) return;
      for (const t of targetsIn(event.result)) {
        if (!owners.has(t)) owners.set(t, new Set());
        owners.get(t).add(ctx.sessionKey);
      }
    });

    const sessionScoped = { scope: "operator.write", sessionAccess: { mode: "write", requiredTool: "browser" } };

    api.registerGatewayMethod(
      `${PLUGIN}.tabs`,
      async ({ respond, sessionAccessAuthority }) => {
        const sessionKey = sessionAccessAuthority?.target?.sessionKey;
        const live = await cdpTargets().catch(() => []);
        respond(true, {
          tabs: live
            .filter((t) => owners.get(t.id)?.has(sessionKey))
            .map((t) => ({ targetId: t.id, url: t.url, title: t.title, lease: leases.get(t.id)?.state ?? null })),
        });
      },
      sessionScoped,
    );

    api.registerGatewayMethod(
      `${PLUGIN}.view.open`,
      (opts) => {
        const admitted = admitTab(opts);
        if (!admitted) return;
        const ticket = crypto.randomBytes(24).toString("hex");
        const streamId = crypto.randomUUID();
        streams.set(streamId, { ...admitted, renewedAt: Date.now() });
        tickets.set(ticket, { ...admitted, streamId, expiresAt: Date.now() + TICKET_TTL_MS, retained: opts.sessionAccessAuthority.retain() });
        opts.respond(true, { wsPath: `/${PLUGIN}/stream?ticket=${ticket}`, streamId, renewWithinMs: RENEW_TIMEOUT_MS, expiresAtMs: Date.now() + TICKET_TTL_MS, targetId: admitted.targetId });
      },
      sessionScoped,
    );

    // Renews a stream and, for the holder, the control lease. Session access
    // is re-checked by the host on every call, so revocation takes effect at
    // the next renewal at the latest.
    api.registerGatewayMethod(
      `${PLUGIN}.view.renew`,
      (opts) => {
        const admitted = admitTab(opts);
        if (!admitted) return;
        const stream = streams.get(opts.params.streamId);
        if (!stream || stream.targetId !== admitted.targetId || stream.sessionKey !== admitted.sessionKey) return err(opts.respond, "NOT_FOUND", "unknown stream");
        stream.renewedAt = Date.now();
        const lease = leases.get(admitted.targetId);
        if (lease && lease.holderConnId === (opts.client?.connId ?? "unknown")) lease.renewedAt = Date.now();
        opts.respond(true, { ok: true, renewWithinMs: RENEW_TIMEOUT_MS });
      },
      sessionScoped,
    );

    api.registerGatewayMethod(
      `${PLUGIN}.control.take`,
      async (opts) => {
        const admitted = admitTab(opts);
        if (!admitted) return;
        const connId = opts.client?.connId ?? "unknown";
        const held = leases.get(admitted.targetId);
        if (held && held.holderConnId !== connId) return err(opts.respond, "CONFLICT", "another viewer holds control");
        leases.set(admitted.targetId, { holderConnId: connId, sessionKey: admitted.sessionKey, state: "draining", since: Date.now(), renewedAt: Date.now() });
        emit("control", { targetId: admitted.targetId, holder: "user", state: "draining" });
        // New bot calls are already blocked; let running ones finish or time out.
        const deadline = Date.now() + DRAIN_TIMEOUT_MS;
        while (inflight.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
        const lease = leases.get(admitted.targetId);
        if (!lease || lease.holderConnId !== connId) return err(opts.respond, "CONFLICT", "lease was released while draining");
        lease.state = "granted";
        emit("control", { targetId: admitted.targetId, holder: "user", state: "granted", drainedInflight: inflight.size === 0 });
        opts.respond(true, { state: "granted", drained: inflight.size === 0 });
      },
      sessionScoped,
    );

    api.registerGatewayMethod(
      `${PLUGIN}.control.release`,
      (opts) => {
        const admitted = admitTab(opts);
        if (!admitted) return;
        leases.delete(admitted.targetId);
        emit("control", { targetId: admitted.targetId, holder: "bot", state: "released" });
        opts.respond(true, { state: "released" });
      },
      sessionScoped,
    );

    api.registerGatewayMethod(
      `${PLUGIN}.input`,
      async (opts) => {
        const admitted = admitTab(opts);
        if (!admitted) return;
        const lease = leases.get(admitted.targetId);
        if (lease?.state !== "granted" || lease.holderConnId !== (opts.client?.connId ?? "unknown")) {
          return err(opts.respond, "FORBIDDEN", "take control first");
        }
        lease.renewedAt = Date.now();
        const { kind, x, y, text, deltaY } = opts.params;
        const cdp = await openCdp(admitted.targetId);
        try {
          if (kind === "click") {
            for (const type of ["mousePressed", "mouseReleased"]) {
              await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
            }
          } else if (kind === "scroll") {
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: x ?? 10, y: y ?? 10, deltaX: 0, deltaY: deltaY ?? 300 });
          } else if (kind === "text") {
            await cdp.send("Input.insertText", { text: String(text ?? "") });
          } else return err(opts.respond, "INVALID_REQUEST", "kind must be click, scroll or text");
          opts.respond(true, { ok: true });
        } finally {
          cdp.close();
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
          cdp = await openCdp(grant.targetId);
          wsText(socket, { type: "ready", targetId: grant.targetId, url: cdp.target.url, title: cdp.target.title });
          cdp.on(async (msg) => {
            if (msg.method === "Page.screencastFrame") {
              const { data, metadata, sessionId } = msg.params;
              cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
              try {
                grant.retained?.assertCurrent?.();
              } catch {
                return stop(4006, "authority_revoked");
              }
              const header = Buffer.from(JSON.stringify({ cssWidth: metadata.deviceWidth, cssHeight: metadata.deviceHeight, scrollX: metadata.scrollOffsetX, scrollY: metadata.scrollOffsetY, ts: metadata.timestamp }));
              const len = Buffer.alloc(4);
              len.writeUInt32BE(header.length, 0);
              if (socket.writableLength < 4 * 1024 * 1024) socket.write(wsFrame(0x2, Buffer.concat([len, header, Buffer.from(data, "base64")])));
            } else if (msg.method === "Page.frameNavigated" && !msg.params.frame.parentId) {
              wsText(socket, { type: "meta", url: msg.params.frame.url });
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
