// A minimal Chrome DevTools Protocol client for one bot's browser, on literal
// loopback only. Every wait has a deadline and every step takes an abort
// signal: discovery, the WebSocket connection and every command's reply.
// A connection that finishes opening after its caller gave up is closed at
// once and never used.

/** Default deadlines, in milliseconds. */
export const TIMEOUTS = Object.freeze({ discoveryMs: 3000, connectMs: 3000, commandMs: 5000 });

/** The largest target list accepted from a browser. */
const MAX_LIST_BYTES = 1024 * 1024;
const TARGET_ID = /^[A-Za-z0-9]{8,64}$/;
const BROWSER_ID = /^[A-Za-z0-9-]{8,64}$/;

/** A failure with a stable reason a caller can act on. */
export class CdpError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.name = "CdpError";
    this.reason = reason;
  }
}

const aborted = (signal) =>
  new CdpError("aborted", typeof signal?.reason === "string" ? signal.reason : "aborted");

/** A signal that aborts with `signal` or after `ms`, whichever comes first. */
function deadline(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Read a response body, refusing more than `limit` bytes. */
async function readLimited(response, limit, signal) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new CdpError("discovery_timeout", "target list timed out");
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new CdpError("discovery_failed", "target list too large");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** GET one of the browser's JSON endpoints on its own address, with no redirect and a deadline. */
async function browserJson(bot, path, options) {
  const { signal, timeouts = TIMEOUTS, fetchImpl = globalThis.fetch } = options;
  if (signal?.aborted) throw aborted(signal);
  const limit = deadline(signal, timeouts.discoveryMs);
  const url = `${bot.base}${path}`;
  let response;
  try {
    response = await fetchImpl(url, { redirect: "error", signal: limit });
  } catch {
    if (signal?.aborted) throw aborted(signal);
    if (limit.aborted)
      throw new CdpError("discovery_timeout", "the browser did not list its tabs in time");
    throw new CdpError("browser_unavailable", "the bot's browser is not running");
  }
  // A redirect followed anyway (an unusual fetch) is refused just the same.
  if (response.redirected || (response.url && response.url !== url) || response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    throw new CdpError("discovery_failed", `the browser answered ${response.status}`);
  }
  try {
    return JSON.parse(await readLimited(response, MAX_LIST_BYTES, limit));
  } catch (error) {
    if (signal?.aborted) throw aborted(signal);
    if (error instanceof CdpError) throw error;
    throw new CdpError("discovery_failed", "the target list is not JSON");
  }
}

/**
 * The live page targets of one bot's browser. Redirects are refused; a target
 * is kept only when its debugger URL is exactly this endpoint and this
 * target: `ws://<same host>:<same port>/devtools/page/<id>`.
 */
export async function cdpTargets(bot, options = {}) {
  const list = await browserJson(bot, "/json/list", options);
  const out = [];
  for (const target of Array.isArray(list) ? list : []) {
    if (target?.type !== "page" || typeof target.id !== "string" || !TARGET_ID.test(target.id)) {
      continue;
    }
    if (target.webSocketDebuggerUrl !== `ws://${bot.host}:${bot.port}/devtools/page/${target.id}`) {
      continue;
    }
    out.push({
      id: target.id,
      url: typeof target.url === "string" ? target.url.slice(0, 2048) : "",
      title: typeof target.title === "string" ? target.title.slice(0, 512) : "",
      ws: target.webSocketDebuggerUrl,
    });
  }
  return out;
}

/**
 * The browser's own debugger URL, `ws://<same host>:<same port>/devtools/browser/<id>`,
 * or a CdpError when the browser does not give exactly that.
 */
export async function browserEndpoint(bot, options = {}) {
  const version = await browserJson(bot, "/json/version", options);
  const url = version?.webSocketDebuggerUrl;
  const prefix = `ws://${bot.host}:${bot.port}/devtools/browser/`;
  if (
    typeof url !== "string" ||
    !url.startsWith(prefix) ||
    !BROWSER_ID.test(url.slice(prefix.length))
  ) {
    throw new CdpError("discovery_failed", "the browser's own debugger address is not its own");
  }
  return url;
}

/**
 * Connect to one validated page target. The session closes itself when
 * `signal` aborts; every command has its own reply deadline and may take a
 * further signal of its own.
 */
export async function openCdp(bot, targetId, options = {}) {
  const target = (await cdpTargets(bot, options)).find((t) => t.id === targetId);
  if (!target) throw new CdpError("target_gone", "the tab is not in this bot's browser");
  return connect(target.ws, target, options);
}

/**
 * Connect to the bot's browser itself, for commands and events of every tab
 * through flattened sessions (`sessionId`).
 */
export async function openBrowserCdp(bot, options = {}) {
  const url = await browserEndpoint(bot, options);
  return connect(url, { url }, options);
}

async function connect(url, target, options) {
  const { signal, timeouts = TIMEOUTS, WebSocketImpl = globalThis.WebSocket } = options;
  if (signal?.aborted) throw aborted(signal);
  const ws = new WebSocketImpl(url);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!error) return resolve();
      // A connection that opens after this point is closed at once.
      ws.addEventListener("open", () => ws.close(), { once: true });
      try {
        ws.close();
      } catch {
        // closing a socket that never opened can throw; it is gone either way
      }
      reject(error);
    };
    const onAbort = () => finish(aborted(signal));
    const timer = setTimeout(
      () =>
        finish(
          new CdpError("connect_timeout", "the browser did not accept the connection in time"),
        ),
      timeouts.connectMs,
    );
    ws.addEventListener("open", () => finish(signal?.aborted ? aborted(signal) : undefined), {
      once: true,
    });
    ws.addEventListener(
      "error",
      () => finish(new CdpError("connect_failed", "could not connect to the tab")),
      {
        once: true,
      },
    );
    ws.addEventListener(
      "close",
      () => finish(new CdpError("connect_failed", "the tab closed the connection")),
      {
        once: true,
      },
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Set();
  const closeListeners = new Set();
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", close);
    for (const entry of pending.values())
      entry.fail(new CdpError("closed", "the connection to the tab closed"));
    pending.clear();
    try {
      ws.close();
    } catch {
      // already closing
    }
    for (const listener of closeListeners) {
      try {
        listener();
      } catch {
        // a listener's failure must not stop the others
      }
    }
    closeListeners.clear();
    listeners.clear();
  };
  ws.addEventListener("message", (event) => {
    if (closed || typeof event.data !== "string") return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof message?.id === "number") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error)
        entry.fail(
          new CdpError("command_failed", String(message.error.message ?? "command failed")),
        );
      else entry.done(message.result ?? {});
    } else if (typeof message?.method === "string") {
      for (const listener of listeners) {
        try {
          listener(message);
        } catch {
          // keep the other listeners
        }
      }
    }
  });
  ws.addEventListener("close", close);
  signal?.addEventListener("abort", close, { once: true });

  return {
    target,
    get closed() {
      return closed;
    },
    /** Send one command and wait for its reply, at most `commandMs`. */
    send(method, params = {}, sendOptions = {}) {
      const commandSignal = sendOptions.signal;
      const { sessionId } = sendOptions;
      return new Promise((resolve, reject) => {
        if (closed) return reject(new CdpError("closed", "the connection to the tab closed"));
        if (commandSignal?.aborted) return reject(aborted(commandSignal));
        const id = ++nextId;
        const entry = {
          done: (result) => {
            cleanup();
            resolve(result);
          },
          fail: (error) => {
            cleanup();
            reject(error);
          },
        };
        const onAbort = () => {
          pending.delete(id);
          entry.fail(aborted(commandSignal));
        };
        const timer = setTimeout(() => {
          pending.delete(id);
          entry.fail(new CdpError("command_timeout", `${method} was not answered in time`));
        }, timeouts.commandMs);
        function cleanup() {
          clearTimeout(timer);
          commandSignal?.removeEventListener("abort", onAbort);
        }
        commandSignal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, entry);
        try {
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch {
          pending.delete(id);
          entry.fail(new CdpError("closed", "the connection to the tab closed"));
        }
      });
    },
    /** Call `listener` with every event; returns the function that stops it. */
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: (listener) => {
      if (closed) queueMicrotask(listener);
      else closeListeners.add(listener);
    },
    close,
  };
}
