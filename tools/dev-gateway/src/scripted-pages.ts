// The scripted pages: the only pages a development instance's browser can
// open. The tool starts Chromium with `--host-rules=MAP * 127.0.0.1:<this
// port>` (cli.ts, `confinementArgs`), so every connection the browser makes,
// to any host, address or port, arrives here. A request is answered with a
// page only when it was addressed to this server's own origin and to a path
// under /scripted/pages/; everything else gets the refusal page and is
// recorded. Nothing here makes a connection of its own.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const PAGES_PREFIX = "/scripted/pages/";
/** Where the record of input and refusals is read (by the checks, not the browser's pages). */
export const PAGES_RECORD_PATH = "/scripted/pages/record";
export const REFUSED_TITLE = "Refused by the development gateway";
/** How long the slow page takes to answer. */
export const SLOW_PAGE_MS = 8000;
/** How long the scripted download takes to arrive, a piece at a time. */
export const SLOW_DOWNLOAD_MS = 8000;

export type PageEvent = { seq: number; at: number; page: string; kind: string; value: string };
export type Refusal = { seq: number; at: number; host: string; method: string; path: string };

/**
 * The sign-in page. Its controls sit at fixed places so a check can click
 * them by coordinates: the name field at (40, 110) to (440, 150), the Sign in
 * button at (40, 180) to (240, 240). The page is tall, so it can scroll.
 */
function signInPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Scripted sign-in</title>
<style>
  body { margin: 0; font: 16px system-ui, sans-serif; height: 3000px; }
  h1 { position: absolute; left: 40px; top: 20px; margin: 0; font-size: 24px; }
  #name { position: absolute; left: 40px; top: 110px; width: 400px; height: 40px; box-sizing: border-box; }
  #go { position: absolute; left: 40px; top: 180px; width: 200px; height: 60px; }
  #status { position: absolute; left: 40px; top: 260px; }
  #more { position: absolute; left: 40px; top: 2800px; }
</style></head>
<body>
<h1>Sign in to the scripted library</h1>
<input id="name" aria-label="Name" autocomplete="off">
<button id="go">Sign in</button>
<p id="status">Signed in: no. Clicks: 0. Name: (empty). Scrolled: no.</p>
<p id="more"><a href="${PAGES_PREFIX}welcome">Continue to the welcome page</a></p>
<script>
  let clicks = 0;
  let scrolled = false;
  const status = document.getElementById("status");
  const name = document.getElementById("name");
  const show = () => {
    status.textContent = "Signed in: " + (clicks > 0 ? "yes" : "no") + ". Clicks: " + clicks +
      ". Name: " + (name.value || "(empty)") + ". Scrolled: " + (scrolled ? "yes" : "no") + ".";
  };
  const record = (kind, value) => {
    fetch("${PAGES_PREFIX}events", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "sign-in", kind, value }) }).catch(() => {});
  };
  document.getElementById("go").addEventListener("click", () => { clicks += 1; show(); record("click", String(clicks)); });
  name.addEventListener("input", () => { show(); record("text", name.value); });
  addEventListener("scroll", () => { if (!scrolled && scrollY > 0) { scrolled = true; show(); record("scroll", String(scrollY)); } });
</script>
</body></html>
`;
}

const welcomePage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Scripted welcome</title></head>
<body><h1>Welcome to the scripted library</h1><p>This page is served by the development gateway's scripted side.</p></body></html>
`;

const refusedPage = (what: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${REFUSED_TITLE}</title></head>
<body><h1>${REFUSED_TITLE}</h1><p>The development browser opens only the scripted pages. ${what} was not opened.</p></body></html>
`;

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : "";

export function startScriptedPages(options: { port: number; log?: (line: string) => void }) {
  const origin = `127.0.0.1:${options.port}`;
  const log = options.log ?? (() => {});
  const events: PageEvent[] = [];
  const refused: Refusal[] = [];
  let seq = 0;
  const refuse = (host: string, method: string, path: string) => {
    refused.push({ seq: ++seq, at: Date.now(), host, method, path });
    if (refused.length > 500) refused.shift();
    log(`pages refused ${method} ${JSON.stringify(host)} ${JSON.stringify(path.slice(0, 120))}`);
  };
  const server = createServer((req, res) => {
    void (async () => {
      const host = String(req.headers.host ?? "");
      const raw = req.url ?? "/";
      // Only origin-form requests to this origin: a request for anywhere
      // else, the way the host rules deliver it, keeps its own Host header.
      if (host !== origin || !raw.startsWith("/")) {
        refuse(host, req.method ?? "", raw);
        send(
          res,
          403,
          "text/html; charset=utf-8",
          refusedPage(`http://${host || "an unnamed host"}`),
        );
        return;
      }
      const url = new URL(raw, `http://${origin}`);
      if (req.method === "GET" && url.pathname === PAGES_RECORD_PATH) {
        const since = Number(url.searchParams.get("since") ?? 0);
        send(
          res,
          200,
          "application/json",
          JSON.stringify({
            events: events.filter((e) => e.seq > since),
            refused: refused.filter((r) => r.seq > since),
            seq,
          }),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === `${PAGES_PREFIX}events`) {
        try {
          const body = JSON.parse(await readBody(req, 4096)) as Record<string, unknown>;
          events.push({
            seq: ++seq,
            at: Date.now(),
            page: text(body.page, 40),
            kind: text(body.kind, 20),
            value: text(body.value, 200),
          });
          if (events.length > 500) events.shift();
        } catch {
          // an unreadable event is not recorded
        }
        send(res, 204, "text/plain", "");
        return;
      }
      if (req.method === "GET" && url.pathname === `${PAGES_PREFIX}sign-in`) {
        send(res, 200, "text/html; charset=utf-8", signInPage());
        return;
      }
      if (req.method === "GET" && url.pathname === `${PAGES_PREFIX}slow`) {
        // A page that keeps the bot's browser call running for a while.
        const timer = setTimeout(
          () => send(res, 200, "text/html; charset=utf-8", welcomePage()),
          SLOW_PAGE_MS,
        );
        req.socket.once("close", () => clearTimeout(timer));
        return;
      }
      if (req.method === "GET" && url.pathname === `${PAGES_PREFIX}download`) {
        // An attachment that arrives slowly, so the browser keeps downloading for a while.
        // The first part at once, more than the browser reads before it decides
        // the response is a download; the rest over SLOW_DOWNLOAD_MS.
        const piece = "A piece of the scripted download, for the computer checks.\n";
        const first = piece.repeat(64);
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": 'attachment; filename="scripted-download.txt"',
          "content-length": String(Buffer.byteLength(first) + 16 * Buffer.byteLength(piece)),
          "cache-control": "no-store",
        });
        res.write(first);
        let sent = 0;
        const timer = setInterval(() => {
          res.write(piece);
          sent += 1;
          if (sent === 16) {
            clearInterval(timer);
            res.end();
          }
        }, SLOW_DOWNLOAD_MS / 16);
        req.socket.once("close", () => clearInterval(timer));
        return;
      }
      if (req.method === "GET" && url.pathname === `${PAGES_PREFIX}welcome`) {
        send(res, 200, "text/html; charset=utf-8", welcomePage());
        return;
      }
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        send(res, 404, "text/plain", "");
        return;
      }
      refuse(host, req.method ?? "", url.pathname);
      send(res, 403, "text/html; charset=utf-8", refusedPage(url.pathname));
    })().catch(() => {
      if (!res.headersSent) send(res, 500, "text/plain", "error");
      else res.end();
    });
  });
  // TLS and anything else that is not HTTP: recorded and dropped.
  server.on("clientError", (_error, socket) => {
    refuse("", "not-http", "");
    socket.destroy();
  });
  server.on("connect", (req, socket) => {
    refuse(String(req.headers.host ?? ""), "CONNECT", req.url ?? "");
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  server.listen(options.port, "127.0.0.1");
  return server;
}
