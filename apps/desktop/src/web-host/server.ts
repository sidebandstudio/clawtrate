// The web host: serves the renderer to a browser and bridges it to a core client
// running in this Node process. The browser never holds the device key, the
// gateway token or the gateway socket; it only receives state and sends commands.

import {
  AttachmentTooLargeError,
  batchSnapshots,
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

export type WebHostOptions = {
  runtime: HostRuntime;
  staticDir: string;
  host: string;
  port: number;
  /** null disables the access check (only allowed against the development gateway). */
  accessToken: string | null;
};

export function startWebHost(options: WebHostOptions) {
  const { runtime, accessToken } = options;
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
      const access = authorized(req, url);
      if (url.pathname === ATTACHMENTS_PATH) {
        await receiveAttachment(req, res, url, access !== "denied" && sameOrigin(req));
        return;
      }
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
   * the body. Needs the access cookie and a same-origin request, like the
   * bridge. The declared length is checked against the gateway's ceiling for
   * that type before any byte is read, and the count is enforced while reading.
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
    try {
      store.check(meta, declared);
    } catch (error) {
      const status = error instanceof AttachmentTooLargeError ? 413 : 400;
      return refuse(status, error instanceof Error ? error.message : String(error));
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let overflow = false;
    await new Promise<void>((resolveRead, rejectRead) => {
      req.on("data", (chunk: Buffer) => {
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
      req.on("error", (error) => (overflow ? resolveRead() : rejectRead(error)));
    });
    if (overflow || received !== declared) {
      if (!res.headersSent) reply(400, { error: "The body does not match its declared length." });
      return;
    }
    try {
      const data = Buffer.concat(chunks, received);
      reply(
        200,
        store.add(meta, received, () => data.toString("base64")),
      );
    } catch (error) {
      const status = error instanceof AttachmentTooLargeError ? 413 : 400;
      reply(status, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

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
    const send = (message: BridgeServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    send({ type: "hello", info: runtime.info, state: runtime.client.state });
    const stop = batchSnapshots(runtime.client.store.subscribe, (state) =>
      send({ type: "state", state }),
    );
    // Each tab is its own viewer: its open transcripts are released when it goes away.
    const session = createBridgeSession(runtime.client, runtime.policy);
    ws.on("message", (data) => {
      let id = "";
      try {
        const message = JSON.parse(String(data)) as {
          type?: unknown;
          id?: unknown;
          command?: unknown;
        };
        if (message.type !== "command" || typeof message.id !== "string")
          throw new Error("invalid message");
        id = message.id;
        const command = parseBridgeCommand(message.command);
        session.apply(command).then(
          (value) =>
            send(
              value === undefined
                ? { type: "result", id, ok: true }
                : { type: "result", id, ok: true, value },
            ),
          (error: unknown) =>
            send({
              type: "result",
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
      } catch (error) {
        send({
          type: "result",
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    ws.on("close", () => {
      stop();
      session.dispose();
    });
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
