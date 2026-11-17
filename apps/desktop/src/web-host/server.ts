// The web host: serves the renderer to a browser and bridges it to a core client
// running in this Node process. The browser never holds the device key, the
// gateway token or the gateway socket; it only receives state and sends commands.

import {
  AttachmentTooLargeError,
  batchSnapshots,
  HostFullError,
  type HostLedger,
  type AttachmentReservation,
  MAX_BRIDGE_FRAME_BYTES,
  type ClawtrateState,
  createBridgeSession,
  parseBridgeCommand,
  type BridgeServerMessage,
} from "@clawtrate/core";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { HostRuntime } from "../host/runtime.ts";

export const ACCESS_COOKIE = "clawtrate_access";
export const ATTACHMENTS_PATH = "/attachments";
/** Bridge sockets served at once. */
export const MAX_WEB_VIEWERS = 32;
/** Longest command id a viewer may use; it is echoed back in the result. */
export const MAX_COMMAND_ID_CHARS = 64;
/** While a viewer's socket buffers more than this, state snapshots wait and only the latest is sent. */
export const SNAPSHOT_SOFT_BUFFER_BYTES = 1024 * 1024;
/** A viewer buffering more than this is too slow to keep: its socket is closed. */
export const SNAPSHOT_HARD_BUFFER_BYTES = 16 * 1024 * 1024;
/** How often a held-back snapshot is retried. */
const SNAPSHOT_RETRY_MS = 50;
/**
 * How long one upload may take from its headers to its last byte. Its room is
 * held meanwhile, so a body that never ends gives it back at this deadline
 * and is answered 408; nothing of it is kept.
 */
export const UPLOAD_DEADLINE_MS = 60_000;

type ViewerSocket = {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

/**
 * Sending to one viewer within bounded memory. Results and the hello always go
 * out; state snapshots wait while the socket is backed up, and only the latest
 * is kept. A viewer that backs up past the hard bound is closed.
 */
export function createViewerChannel(ws: ViewerSocket, ledger?: HostLedger) {
  let latest: ClawtrateState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // What this viewer's socket buffers is part of what the host keeps.
  const untrack = ledger?.track("viewer", () => ws.bufferedAmount) ?? (() => {});
  const tooSlow = () => {
    if (ws.bufferedAmount <= SNAPSHOT_HARD_BUFFER_BYTES) return false;
    ws.close(1013, "viewer too slow");
    return true;
  };
  const write = (message: BridgeServerMessage) => {
    if (ws.readyState !== ws.OPEN || tooSlow()) return;
    ws.send(JSON.stringify(message));
  };
  const flush = () => {
    timer = null;
    if (!latest || ws.readyState !== ws.OPEN || tooSlow()) return;
    // Held back while the socket is backed up, or while the host is at its budget.
    if (ws.bufferedAmount > SNAPSHOT_SOFT_BUFFER_BYTES || (ledger && !ledger.admits(0))) {
      timer = setTimeout(flush, SNAPSHOT_RETRY_MS);
      return;
    }
    const state = latest;
    latest = null;
    write({ type: "state", state });
  };
  return {
    send: write,
    sendState(state: ClawtrateState) {
      latest = state;
      if (!timer) flush();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      latest = null;
      untrack();
    },
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

export function createAccessToken(): string {
  return randomBytes(24).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A cookie's value, or null when it is absent or not validly encoded. */
export function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null; // a malformed escape is an invalid credential, not an error
    }
  }
  return null;
}

/** Same-origin check for the bridge socket, so another site cannot drive the host. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients send no Origin; they still need the token.
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * The upload path's origin policy, stricter than the bridge's. A browser
 * sends `Origin` with every POST, so one without it is refused, and the
 * origin must be exactly this plain-HTTP listener's own: same scheme, host and
 * port. The host terminates no TLS, so an `https` origin is not its own.
 */
export function uploadOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && url.host === host && url.origin === origin;
  } catch {
    return false;
  }
}

export type WebHostOptions = {
  runtime: HostRuntime;
  staticDir: string;
  host: string;
  port: number;
  /** null disables the access check (only allowed against the development gateway). */
  accessToken: string | null;
  /** `UPLOAD_DEADLINE_MS` unless a test shortens it. */
  uploadDeadlineMs?: number;
};

export function startWebHost(options: WebHostOptions) {
  const { runtime, accessToken } = options;
  const uploadDeadlineMs = options.uploadDeadlineMs ?? UPLOAD_DEADLINE_MS;
  const staticRoot = resolve(options.staticDir);

  const authorized = (req: IncomingMessage, url: URL): "ok" | "redirect" | "denied" => {
    if (accessToken === null) return "ok";
    const fromQuery = url.searchParams.get("token");
    if (fromQuery && safeEqual(fromQuery, accessToken)) return "redirect";
    const fromCookie = readCookie(req, ACCESS_COOKIE);
    if (fromCookie && safeEqual(fromCookie, accessToken)) return "ok";
    return "denied";
  };

  const serveStatic = async (res: ServerResponse, pathname: string) => {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    let file = resolve(staticRoot, relative);
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) file = join(staticRoot, "index.html");
    } catch {
      file = join(staticRoot, "index.html");
    }
    const body = await readFile(file);
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": type,
      "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
    });
    res.end(body);
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://placeholder");
      if (url.pathname === "/healthz") {
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/plain" }).end("ok");
        return;
      }
      if (url.pathname === ATTACHMENTS_PATH) {
        // Only the cookie admits an upload; the access link's token only establishes the cookie.
        const fromCookie = readCookie(req, ACCESS_COOKIE);
        const credential =
          accessToken === null || (fromCookie !== null && safeEqual(fromCookie, accessToken));
        await receiveAttachment(req, res, url, credential && uploadOriginAllowed(req));
        return;
      }
      const access = authorized(req, url);
      if (access === "denied") {
        res.writeHead(401, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Clawtrate</title>` +
            `<body style="font:14px system-ui;background:#0b0e14;color:#e6ebe9;display:grid;place-items:center;height:100vh;margin:0">` +
            `<p>This preview needs its access link. Open the URL the host printed when it started.</p>`,
        );
        return;
      }
      if (access === "redirect") {
        url.searchParams.delete("token");
        res.writeHead(302, {
          ...SECURITY_HEADERS,
          "set-cookie": `${ACCESS_COOKIE}=${encodeURIComponent(accessToken!)}; HttpOnly; SameSite=Strict; Path=/`,
          location: `${url.pathname}${url.search}`,
        });
        res.end();
        return;
      }
      await serveStatic(res, url.pathname);
    })().catch((error: unknown) => {
      console.error(`[web-host] ${String(error)}`);
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end();
    });
  });

  /**
   * `POST /attachments?name=<file name>&type=<mime type>` with the raw file as
   * the body. Needs the access cookie (a token in the URL is not accepted
   * here) and this listener's exact origin (`uploadOriginAllowed`). The
   * declared length is checked against the gateway's ceiling for that type
   * before any byte is read, the count is enforced while reading, and the
   * whole body must arrive within the upload deadline.
   */
  const receiveAttachment = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    allowed: boolean,
  ) => {
    const reply = (status: number, body: unknown, close = false) => {
      res.writeHead(status, {
        ...SECURITY_HEADERS,
        "content-type": "application/json",
        ...(close ? { connection: "close" } : {}),
      });
      res.end(JSON.stringify(body));
    };
    // Refused before the body is read: answer, then close rather than read a body that is not wanted.
    const refuse = (status: number, error: string) => {
      reply(status, { error }, true);
      req.resume();
    };
    if (!allowed) return refuse(401, "This preview needs its access link.");
    if (req.method !== "POST") return refuse(405, "Use POST.");
    const store = runtime.policy.attachments;
    if (!store) return refuse(503, "This host does not take files.");
    const declared = Number(req.headers["content-length"]);
    if (!req.headers["content-length"] || !Number.isSafeInteger(declared)) {
      return refuse(411, "A content length is required.");
    }
    const meta = { fileName: url.searchParams.get("name"), mimeType: url.searchParams.get("type") };
    // Room is held before any byte is read, so uploads at the same time cannot together exceed the bounds.
    let reservation: AttachmentReservation;
    try {
      reservation = store.reserve(meta, declared);
    } catch (error) {
      const status =
        error instanceof AttachmentTooLargeError ? 413 : error instanceof HostFullError ? 507 : 400;
      return refuse(status, error instanceof Error ? error.message : String(error));
    }
    let chunks: Buffer[] = [];
    let received = 0;
    let overflow = false;
    let late = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolveRead, rejectRead) => {
        deadline = setTimeout(() => {
          late = true;
          chunks = [];
          reservation.release();
          reply(408, { error: "The file did not arrive in time." }, true);
          req.destroy();
          resolveRead();
        }, uploadDeadlineMs);
        req.on("data", (chunk: Buffer) => {
          if (late) return;
          received += chunk.length;
          if (received > declared) {
            overflow = true;
            req.destroy();
            resolveRead();
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => resolveRead());
        req.on("close", () => resolveRead());
        req.on("error", (error) => (overflow || late ? resolveRead() : rejectRead(error)));
      });
    } catch (error) {
      reservation.release();
      throw error;
    } finally {
      clearTimeout(deadline);
    }
    if (late) return;
    if (overflow || received !== declared) {
      reservation.release();
      if (!res.headersSent) reply(400, { error: "The body does not match its declared length." });
      return;
    }
    try {
      const data = Buffer.concat(chunks, received);
      reply(
        200,
        reservation.commit(() => data.toString("base64")),
      );
    } catch (error) {
      reservation.release();
      const status = error instanceof AttachmentTooLargeError ? 413 : 400;
      reply(status, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_FRAME_BYTES });

  const refuseUpgrade = (socket: Duplex, status: "400 Bad Request" | "401 Unauthorized") => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    // Everything about an unauthenticated upgrade is untrusted input: any
    // parsing failure is answered and the socket closed, never thrown.
    let allowed: boolean;
    try {
      const url = new URL(req.url ?? "/", "http://placeholder");
      allowed = url.pathname === "/bridge" && sameOrigin(req) && authorized(req, url) !== "denied";
    } catch {
      refuseUpgrade(socket, "400 Bad Request");
      return;
    }
    if (!allowed) {
      refuseUpgrade(socket, "401 Unauthorized");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws));
  });

  sockets.on("connection", (ws: WebSocket) => {
    if (sockets.clients.size > MAX_WEB_VIEWERS) {
      ws.close(1013, "too many viewers");
      return;
    }
    const ledger = runtime.client.ledger as HostLedger | undefined;
    const hello = JSON.stringify({
      type: "hello",
      info: runtime.info,
      state: runtime.client.state,
    });
    // A new viewer's first snapshot is retention too: refused, visibly, when the host has no room for it.
    if (ledger && !ledger.admits(hello.length)) {
      ws.close(1013, "host is holding as much as it can");
      return;
    }
    const channel = createViewerChannel(ws, ledger);
    ws.send(hello);
    const stop = batchSnapshots(runtime.client.store.subscribe, (state) =>
      channel.sendState(state),
    );
    // Each tab is its own viewer: its open transcripts are released when it goes away.
    const session = createBridgeSession(runtime.client, runtime.policy);
    let ended = false;
    /**
     * Release everything this viewer held. Each step runs even if another
     * throws, and a failure is logged, never thrown: the socket's close or
     * error callback must not take the host down.
     */
    const end = () => {
      if (ended) return;
      ended = true;
      for (const [name, step] of [
        ["snapshots", stop],
        ["channel", () => channel.stop()],
        ["session", () => session.dispose()],
      ] as const) {
        try {
          step();
        } catch (error) {
          console.error(`[web-host] releasing a viewer's ${name} failed: ${String(error)}`);
        }
      }
    };
    ws.on("message", (data) => {
      let id = "";
      try {
        const message = JSON.parse(String(data)) as {
          type?: unknown;
          id?: unknown;
          command?: unknown;
        };
        if (
          message.type !== "command" ||
          typeof message.id !== "string" ||
          message.id.length > MAX_COMMAND_ID_CHARS
        ) {
          throw new Error("invalid message");
        }
        id = message.id;
        const command = parseBridgeCommand(message.command);
        session.apply(command).then(
          (value) =>
            channel.send(
              value === undefined
                ? { type: "result", id, ok: true }
                : { type: "result", id, ok: true, value },
            ),
          (error: unknown) =>
            channel.send({
              type: "result",
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
      } catch (error) {
        channel.send({
          type: "result",
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    // An oversized or malformed frame surfaces here; the viewer goes, the host stays.
    ws.on("error", () => {
      try {
        end();
      } finally {
        ws.terminate();
      }
    });
    ws.on("close", end);
  });

  server.listen(options.port, options.host);
  return {
    server,
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        server.close(() => resolveClose());
      }),
  };
}
