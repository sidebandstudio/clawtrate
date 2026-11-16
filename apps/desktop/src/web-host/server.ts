// The web host: serves the renderer to a browser and bridges it to a core client
// running in this Node process. The browser never holds the device key, the
// gateway token or the gateway socket; it only receives state and sends commands.

import {
  applyBridgeCommand,
  batchSnapshots,
  parseBridgeCommand,
  type BridgeServerMessage,
} from "@clawtrate/core";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { HostRuntime } from "../host/runtime.ts";

export const ACCESS_COOKIE = "clawtrate_access";

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
  "cross-origin-opener-policy": "same-origin",
};

export function createAccessToken(): string {
  return randomBytes(24).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
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

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (url.pathname !== "/bridge" || !sameOrigin(req) || authorized(req, url) === "denied") {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
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
        applyBridgeCommand(runtime.client, command, runtime.policy).then(
          () => send({ type: "result", id, ok: true }),
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
    ws.on("close", stop);
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
