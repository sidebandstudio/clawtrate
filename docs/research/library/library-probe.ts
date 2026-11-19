// Probes behind docs/research/library.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name>      (with the hand-over scenarios, see the note)
//   node docs/research/library/library-probe.ts <experiment> --instance <name> --data <dir> [--data2 <dir>]
//
// It acts only on a named development instance this checkout started, reads
// that instance's address and token from the tool's own run files, and runs
// `openclaw` only through the tool's guarded runner (so always with
// `--profile clawtrate-dev-<name>`). The connection is this project's own
// client (packages/core), as the desktop app makes it: client id
// `gateway-client`, mode `ui`, read first, the interactive tier only when
// asked for. It approves only its own pairing and upgrade requests, by id.
// Every line it prints passes through `redact`: no token, and no capability
// from a hosted surface's address.
//
// Experiments:
//   pair      a new device connects read-only and is approved by request id
//   read      on that read-only connection: the handshake, every Library
//             method, and the write methods it must be refused
//   upgrade   the same device asks for the interactive tier; it is approved
//   make      interactive: a task with Marlow, hand-overs, a page shared twice,
//             a link; then artifacts.list and chat.history as the Library reads them
//   pages     canvas documents of the probe's own, written into the instance's
//             canvas folder: what canvas.document.view returns for each
//   surface   the hosted canvas address: where it points, what it serves, with
//             and without its capability, what refresh returns; who listens where
//   prefs     users.prefs on the interactive connection, its limits, a
//             conflict, and what a second connection (--data2) is told
//   frame     what a page's HTML can do in Clawtrate's frame (sandbox="",
//             scripts removed, default-src 'none'), in Chromium, offline

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { ClawtrateClient } from "../../../packages/core/src/client.ts";
import { createNodeHost } from "../../../packages/core/src/node/index.ts";
import { openInstance, readDevConnection } from "../../../tools/dev-gateway/src/cli.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    instance: { type: "string" },
    data: { type: "string" },
    data2: { type: "string" },
    session: { type: "string" },
  },
  allowPositionals: true,
});
const experiment = positionals[0];
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
const connection = readDevConnection(inst.connectionFile);
if (!connection || connection.instance !== values.instance) throw new Error("no connection record for this instance");
const gatewayPort = Number(new URL(connection.url).port);

const secrets: string[] = [connection.token];
const redact = (text: string) => {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  return out
    .replace(/(\/__openclaw__\/cap\/)[^/"\s?#]+/g, "$1<capability>")
    .replace(/(oc_cap=)[^&"\s#]+/g, "$1<capability>")
    .replace(/(mediaTicket=)[^&"\s#]+/g, "$1<ticket>")
    .replace(/("(?:token|deviceToken|bootstrapToken)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const show = (value: unknown, max = 1600) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
};
const say = (...parts: unknown[]) => console.log(redact(parts.map((p) => show(p)).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


type Raw = { hello: Record<string, unknown> | null; events: { event: string; payload: unknown }[] };

function coreClient(dataDir: string, raw: Raw) {
  const client = new ClawtrateClient(
    createNodeHost({
      dataDir,
      client: { displayName: "Clawtrate Desktop", version: "0.0.0-research", platform: process.platform },
    }),
    { reconnect: { initialMs: 500, maxMs: 2000 } },
  );
  // Watch what the client receives, without changing what it does with it.
  const inner = client as unknown as {
    handleHello(hello: unknown, generation: number): void;
    handleEvent(event: { event: string; payload: unknown }, generation: number): void;
  };
  const hello = inner.handleHello.bind(client);
  inner.handleHello = (h, g) => {
    raw.hello = h as Record<string, unknown>;
    hello(h, g);
  };
  const event = inner.handleEvent.bind(client);
  inner.handleEvent = (e, g) => {
    raw.events.push({ event: e.event, payload: e.payload });
    event(e, g);
  };
  return client;
}

async function settle(done: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await sleep(100);
}

async function open(dataDir: string) {
  const raw: Raw = { hello: null, events: [] };
  const client = coreClient(dataDir, raw);
  await client.start();
  await settle(() => client.state.connection.status === "connected");
  if (client.state.connection.status !== "connected") throw new Error(`not connected: ${client.state.connection.status}`);
  const request = (client as unknown as { request(m: string, p: unknown): Promise<unknown> }).request.bind(client);
  return { client, raw, request };
}

async function attempt(label: string, call: Promise<unknown>, max = 1600) {
  try {
    say(`${label}: ok`, show(await call, max));
  } catch (error) {
    const e = error as { gatewayCode?: string; code?: string; message?: string; details?: unknown };
    say(`${label}: refused`, { code: e.gatewayCode ?? e.code, message: e.message, details: e.details });
  }
}

// ---------------------------------------------------------------------------

async function pair() {
  if (!values.data) throw new Error("--data <dir> is required");
  mkdirSync(values.data, { recursive: true });
  const raw: Raw = { hello: null, events: [] };
  const client = coreClient(values.data, raw);
  await client.start();
  await client.connect({ url: connection!.url, token: connection!.token });
  await settle(() => ["connected", "pairing", "error"].includes(client.state.connection.status));
  const requestId = client.state.connection.pairing?.requestId;
  say("status:", client.state.connection.status, "requested:", client.state.connection.requestedScopes);
  if (requestId) {
    const approved = inst.runner.runSync(["devices", "approve", requestId]);
    say(`devices approve <this request>: exit ${approved.status}`);
    await settle(() => client.state.connection.status === "connected", 20_000);
  }
  say("connected with:", client.state.connection.scopes);
  client.stop();
}

async function upgrade() {
  const { client } = await open(values.data!);
  void client.requestAccess("interactive").catch((e: unknown) => say("requestAccess:", String(e)));
  await settle(() => Boolean(client.state.connection.upgrade.requestId), 10_000);
  const requestId = client.state.connection.upgrade.requestId;
  say("upgrade asks for:", client.state.connection.upgrade.scopes);
  if (requestId) {
    const approved = inst.runner.runSync(["devices", "approve", requestId]);
    say(`devices approve <this request>: exit ${approved.status}`);
  }
  await settle(() => client.state.connection.scopes.includes("operator.write"), 30_000);
  say("now holds:", client.state.connection.scopes);
  client.stop();
}

/** A seeded task of a bot, from sessions.list. */
async function taskOf(request: (m: string, p: unknown) => Promise<unknown>, agentId: string) {
  const list = (await request("sessions.list", { agentId, limit: 50 })) as { sessions: { key: string; label?: string; updatedAt?: number }[] };
  return list.sessions;
}

async function read() {
  const { client, raw, request } = await open(values.data!);
  const hello = raw.hello ?? {};
  const methods = ((hello.features as { methods?: string[] })?.methods ?? []) as string[];
  const wanted = ["artifacts.list", "artifacts.get", "artifacts.download", "canvas.document.view", "canvas.document.preview", "plugin.surface.refresh", "users.prefs.get", "users.prefs.set", "chat.send", "transcripts.export", "session.publicShare.set"];
  say("scopes:", client.state.connection.scopes);
  say("hello advertises:", Object.fromEntries(wanted.map((m) => [m, methods.includes(m)])));
  say("hello pluginSurfaceUrls:", hello.pluginSurfaceUrls ?? null, "pluginSurfaceBaseUrl:", hello.pluginSurfaceBaseUrl ?? null);
  say("hello keys:", Object.keys(hello));
  const auth = hello.auth as { method?: string; role?: string; scopes?: string[] };
  say("hello auth:", { method: auth.method, role: auth.role, scopes: auth.scopes });

  const tasks = await taskOf(request, "main");
  say("Juniper's (main) tasks:", tasks.map((t) => ({ key: t.key, label: t.label, updatedAt: t.updatedAt })));
  const show1 = tasks.find((t) => t.label === "Show your work") ?? tasks[0]!;
  await attempt("artifacts.list {sessionKey}", request("artifacts.list", { sessionKey: show1.key }));
  await attempt("artifacts.list {agentId} alone", request("artifacts.list", { agentId: "main" }));
  await attempt("artifacts.list {sessionKey, limit}", request("artifacts.list", { sessionKey: show1.key, limit: 5 }));
  await attempt("canvas.document.view trail-guide", request("canvas.document.view", { docId: "trail-guide" }), 400);
  await attempt("canvas.document.view unknown", request("canvas.document.view", { docId: "no-such-page" }));
  await attempt("canvas.document.preview", request("canvas.document.preview", { html: "<!doctype html><p>probe</p>" }), 400);
  await attempt("plugin.surface.refresh canvas", request("plugin.surface.refresh", { surface: "canvas" }));
  await attempt("users.prefs.get", request("users.prefs.get", {}));
  await attempt("users.prefs.set", request("users.prefs.set", { entries: { "clawtrate.library.pins": [] } }));
  await attempt("chat.send", request("chat.send", { sessionKey: show1.key, message: "probe", idempotencyKey: randomUUID() }));
  const probe = (await taskOf(request, "marlow")).find((t) => t.label === "Library probe");
  if (probe) {
    const got = (await request("artifacts.list", { sessionKey: probe.key, messageRole: "assistant" })) as { artifacts: { type: string; messageSeq: number }[] };
    say("read tier, Library probe task: artifacts", got.artifacts.map((a) => `${a.type}@${a.messageSeq}`));
    const h = (await request("chat.history", { sessionKey: probe.key, limit: 4 })) as { messages: unknown[]; hasMore?: boolean; nextOffset?: number };
    say("read tier, chat.history limit 4:", { rows: h.messages.length, hasMore: h.hasMore, nextOffset: h.nextOffset });
    const h2 = (await request("chat.history", { sessionKey: probe.key, limit: 4, offset: h.nextOffset })) as { messages: { __openclaw?: { seq?: number } }[] };
    say("read tier, the next page's seqs:", h2.messages.map((m) => m.__openclaw?.seq));
    await attempt("read tier, chat.send to it", request("chat.send", { sessionKey: probe.key, message: "About the page “Trail guide”: probe", idempotencyKey: randomUUID() }));
  }
  client.stop();
}

async function waitRunEnd(request: (m: string, p: unknown) => Promise<unknown>, sessionKey: string, before: number) {
  // The reply and its attachment land in history some seconds after the run ends.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const h = (await request("chat.history", { sessionKey, limit: 200 })) as { messages: { role: string }[] };
    if (h.messages.filter((m) => m.role === "assistant").length > before) break;
    await sleep(1000);
  }
  await sleep(8000);
}

async function make() {
  const { client, request } = await open(values.data!);
  say("scopes:", client.state.connection.scopes);
  const created = (await request("sessions.create", { agentId: "marlow", label: "Library probe" })) as { key: string };
  const key = created.key;
  say("task:", key);
  let assistants = 0;
  for (const message of ["#hand-several", "#hand-page", "#hand-link", "#hand-file", "#hand-page"]) {
    if (message === "#hand-page" && assistants > 2) {
      // Change the page between the two shares, as a bot editing its page would.
      const html = join(inst.stateDir, "canvas", "documents", "trail-guide", "index.html");
      if (!resolve(html).startsWith(resolve(inst.stateDir) + sep)) throw new Error("outside the instance");
      writeFileSync(html, readFileSync(html, "utf8").replace("</body>", "<p>Second version.</p></body>"));
      say("changed trail-guide's HTML on disk before the second share");
    }
    await request("chat.send", { sessionKey: key, message, idempotencyKey: randomUUID(), queueMode: "followup" });
    await waitRunEnd(request, key, assistants);
    const h = (await request("chat.history", { sessionKey: key, limit: 200 })) as { messages: { role: string }[] };
    assistants = h.messages.filter((m) => m.role === "assistant").length;
    say(`sent ${message}; assistant messages now ${assistants}`);
  }
  const all = (await request("artifacts.list", { sessionKey: key })) as { artifacts: Record<string, unknown>[] };
  say("artifacts.list {sessionKey}:", all.artifacts.map((a) => ({ ...a, data: a.data ? "<bytes>" : undefined })), 6000);
  const mine = (await request("artifacts.list", { sessionKey: key, messageRole: "assistant" })) as { artifacts: Record<string, unknown>[] };
  say("artifacts.list {messageRole: assistant} count:", mine.artifacts.length, "types:", mine.artifacts.map((a) => a.type));
  const runId = mine.artifacts[0]?.runId;
  if (runId) await attempt("artifacts.list {runId} alone", request("artifacts.list", { runId }), 600);
  await attempt("artifacts.list {sessionKey, type: image, limit: 1}", request("artifacts.list", { sessionKey: key, type: "image", limit: 1 }), 800);
  const h = (await request("chat.history", { sessionKey: key, limit: 200 })) as { messages: Record<string, unknown>[] };
  for (const m of h.messages) {
    const content = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
    const blocks = content.map((b) => (b.type === "text" ? { type: "text", text: show(b.text, 160) } : b.type === "canvas" ? b : { type: b.type, artifactId: (b as { artifactId?: string }).artifactId ?? (b.attachment as { artifactId?: string })?.artifactId }));
    say("history row:", { role: m.role, timestamp: m.timestamp, seq: (m.__openclaw as { seq?: number })?.seq, blocks }, 1200);
  }
  await attempt("canvas.document.view trail-guide now", request("canvas.document.view", { docId: "trail-guide" }), 300);
  client.stop();
}

const probePages = (origin: string): Record<string, string> => ({
  "probe-script": `<!doctype html><html><head><title>Script page</title></head><body><h1>Counter</h1><button id="b">Add</button><span id="n">0</span><script>let n=0;document.getElementById('b').onclick=()=>{n++;document.getElementById('n').textContent=n;fetch('${origin}/probe-from-page').catch(()=>{});parent.postMessage({kind:'probe-from-page'},'*');}</script></body></html>`,
  "probe-form": `<!doctype html><html><head><title>Form page</title></head><body><form action="${origin}/probe-form" method="post"><label><input type="checkbox" name="done"> Done</label><select name="route"><option>Lake</option><option>Ridge</option></select><details><summary>More</summary><p>Folded text.</p></details><button>Send</button></form><a href="${origin}/probe-link">A link</a><a href="https://trails.example/" target="_blank">A new window</a></body></html>`,
  "probe-refresh": `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${origin}/probe-refresh"><base href="${origin}/"><title>Refresh page</title><link rel="stylesheet" href="${origin}/probe-style.css"></head><body><img src="${origin}/probe-image.png" alt="remote"><p style="background:url(${origin}/probe-bg.png)">Text</p><iframe src="${origin}/probe-frame"></iframe></body></html>`,
});
const PROBE_PAGES = probePages(`http://127.0.0.1:${gatewayPort}`);

function writeProbePages() {
  for (const [id, html] of Object.entries(PROBE_PAGES)) {
    const dir = join(inst.stateDir, "canvas", "documents", id);
    if (!resolve(dir).startsWith(resolve(inst.stateDir) + sep)) throw new Error("outside the instance");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, localEntrypoint: "index.html", cspSandbox: "scripts", createdAt: new Date().toISOString() }));
  }
}

async function pages() {
  writeProbePages();
  const { request } = await open(values.data!);
  for (const id of Object.keys(PROBE_PAGES)) {
    const got = (await request("canvas.document.view", { docId: id })) as { html: string; sandboxUrl: string; sandboxPort: number };
    say(`view ${id}:`, { sameAsWritten: got.html === PROBE_PAGES[id], sandboxUrl: show(got.sandboxUrl, 120), sandboxPort: got.sandboxPort, keys: Object.keys(got) });
  }
  // A manifest that does not ask for scripts.
  const dir = join(inst.stateDir, "canvas", "documents", "probe-strict");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><p>strict</p>");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "probe-strict", localEntrypoint: "index.html", cspSandbox: "strict" }));
  await attempt("view probe-strict (cspSandbox strict)", request("canvas.document.view", { docId: "probe-strict" }), 300);
  const listeners = spawnSync("lsof", ["-nP", `-iTCP:${gatewayPort}`, `-iTCP:${gatewayPort + 1}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout;
  say("listeners on the gateway's port and the next:", listeners.split("\n").filter(Boolean).map((l) => l.split(/\s+/).slice(-2).join(" ")));
}

function get(url: string): Promise<{ status: number; type: string | undefined; body: string; headers: Record<string, unknown> }> {
  return new Promise((done, fail) => {
    const req = httpRequest(url, { method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => done({ status: res.statusCode ?? 0, type: res.headers["content-type"], body, headers: res.headers as Record<string, unknown> }));
    });
    req.on("error", fail);
    req.end();
  });
}

async function surface() {
  const { raw, request } = await open(values.data!);
  const url = (raw.hello?.pluginSurfaceUrls as Record<string, string> | undefined)?.canvas;
  say("canvas surface address:", url ?? null);
  if (!url) return;
  const u = new URL(url);
  say("host:", u.hostname, "port:", u.port, "path carries a capability:", u.pathname.includes("/__openclaw__/cap/"), "same port as the socket:", Number(u.port) === gatewayPort);
  const capability = u.pathname.split("/__openclaw__/cap/")[1]?.split("/")[0];
  if (capability) secrets.push(capability);
  for (const [label, target] of [
    ["the address itself", url],
    ["the address + /", `${url}/`],
    ["a document under it", `${url}/__openclaw__/canvas/documents/trail-guide/index.html`],
    ["the same document without the capability", `${u.origin}/__openclaw__/canvas/documents/trail-guide/index.html`],
    ["a wrong capability", `${u.origin}/__openclaw__/cap/AAAAAAAAAAAAAAAAAAAAAAAA/__openclaw__/canvas/documents/trail-guide/index.html`],
  ] as const) {
    try {
      const r = await get(target);
      say(`GET ${label}:`, { status: r.status, type: r.type, csp: r.headers["content-security-policy"] ?? null, body: show(r.body, 200) });
    } catch (error) {
      say(`GET ${label}: failed`, String(error));
    }
  }
  const refreshed = (await request("plugin.surface.refresh", { surface: "canvas" })) as { pluginSurfaceUrls: Record<string, string>; expiresAtMs?: number };
  const next = refreshed.pluginSurfaceUrls.canvas!;
  const nextCap = new URL(next).pathname.split("/__openclaw__/cap/")[1]?.split("/")[0];
  if (nextCap) secrets.push(nextCap);
  say("refresh:", { sameAddress: next === url, expiresInSeconds: refreshed.expiresAtMs ? Math.round((refreshed.expiresAtMs - Date.now()) / 1000) : null });
  const old = await get(`${url}/__openclaw__/canvas/documents/trail-guide/index.html`);
  say("the first address after the refresh:", old.status);
  const config = JSON.parse(readFileSync(join(inst.stateDir, "openclaw.json"), "utf8")) as { gateway?: { bind?: string; port?: number } };
  say("instance gateway.bind:", config.gateway?.bind ?? null);
}

async function prefs() {
  const a = await open(values.data!);
  const b = values.data2 ? await open(values.data2) : null;
  say("A scopes:", a.client.state.connection.scopes, "B scopes:", b?.client.state.connection.scopes ?? null);
  await attempt("A users.prefs.get", a.request("users.prefs.get", {}));
  await attempt("A users.prefs.set pins", a.request("users.prefs.set", { entries: { "clawtrate.library.pins": ["a"] } }));
  await attempt("A users.prefs.get again", a.request("users.prefs.get", { keys: ["clawtrate.library.pins"] }));
  await attempt("A set a 4097-byte value", a.request("users.prefs.set", { entries: { "clawtrate.library.big": "x".repeat(4095) } }));
  await attempt("A set with a stale expectation", a.request("users.prefs.set", { entries: { "clawtrate.library.pins": ["b"] }, expectedEntries: { "clawtrate.library.pins": ["zzz"] } }));
  if (b) {
    await attempt("B users.prefs.get", b.request("users.prefs.get", {}));
    await sleep(500);
    say("events B received:", b.raw.events.filter((e) => e.event.startsWith("users.")));
    say("events A received:", a.raw.events.filter((e) => e.event.startsWith("users.")));
    b.client.stop();
  }
  a.client.stop();
}

/**
 * The frame the artifacts branch builds (m42-artifacts:
 * packages/ui/src/artifacts/viewer.tsx, PAGE_POLICY and framedPage), and the
 * same with what the Library design adds: every address a page's elements
 * would follow is taken out (href, action, formaction, target, ping).
 */
function framedPage(html: string, design: boolean): string {
  const POLICY = "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; font-src data:";
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const s of doc.querySelectorAll("script, base, meta[http-equiv]")) s.remove();
  if (design) {
    for (const el of doc.querySelectorAll("[href], [action], [formaction], [target], [ping]")) {
      for (const name of ["href", "action", "formaction", "target", "ping"]) el.removeAttribute(name);
    }
  }
  const meta = doc.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = POLICY;
  doc.head.prepend(meta);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

async function frame() {
  // A loopback server of the probe's own: every request that reaches it is counted.
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("probe");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const pagesHere = probePages(origin);
  const html = pagesHere["probe-script"]! + pagesHere["probe-form"]!.replace("<!doctype html>", "") + pagesHere["probe-refresh"]!.replace("<!doctype html>", "");

  const requireFromRoot = createRequire(new URL("../../../package.json", import.meta.url));
  const { chromium } = requireFromRoot("@playwright/test") as typeof import("@playwright/test");
  const browser = await chromium.launch();
  for (const design of [false, true]) {
    hits.length = 0;
    const page = await browser.newPage();
    const notes: string[] = [];
    page.on("console", (m) => notes.push(m.text().slice(0, 90)));
    page.on("popup", (p) => notes.push(`popup ${p.url()}`));
    // The parent stands for the desktop renderer: the app's own policy, opened from disk.
    await page.goto(`data:text/html,${encodeURIComponent("<!doctype html><meta http-equiv='Content-Security-Policy' content=\"default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'\"><body></body>")}`);
    await page.evaluate(() => window.addEventListener("message", (e) => console.log(`parent got a message ${JSON.stringify(e.data)}`)));
    const srcdoc = await page.evaluate(`(${framedPage.toString()})(${JSON.stringify(html)}, ${design})`) as string;
    say(design ? "DESIGN frame" : "BRANCH frame", "keeps a script:", /<script/i.test(srcdoc), "meta refresh:", /http-equiv="refresh"/i.test(srcdoc), "an href:", /\shref=/i.test(srcdoc));
    const mount = (doc: string) =>
      page.evaluate((d) => {
        document.querySelector("iframe")?.remove();
        const f = document.createElement("iframe");
        f.setAttribute("sandbox", "");
        f.srcdoc = d;
        f.style.cssText = "width:800px;height:600px";
        document.body.append(f);
      }, doc);
    await mount(srcdoc);
    await sleep(1200);
    let f = page.frames()[1]!;
    await f.click("#b");
    say("  the page's own button: counter", await f.textContent("#n"));
    await f.check("input[name=done]");
    await f.selectOption("select[name=route]", "Ridge");
    await f.click("summary");
    say("  checkbox", await f.isChecked("input[name=done]"), "menu", await f.inputValue("select[name=route]"), "folded section open", (await f.getAttribute("details", "open")) !== null);
    await f.click("form button");
    await sleep(400);
    await f.click("text=A new window");
    await sleep(400);
    await f.click("text=A link");
    await sleep(1200);
    f = page.frames()[1]!;
    say("  after Send, the new-window link and the link: frame at", f.url().slice(0, 40), "still the page:", (await f.$("#n").catch(() => null)) !== null);
    await mount(srcdoc);
    await sleep(800);
    f = page.frames()[1]!;
    say("  opened again: checkbox", await f.isChecked("input[name=done]"), "menu", await f.inputValue("select[name=route]"));
    say("  requests that reached the probe's server:", hits);
    say("  popups and console:", notes.filter((n) => n.startsWith("popup") || n.startsWith("parent")).concat(`${notes.length} console lines`));
    await page.close();
  }
  await browser.close();
  server.close();
}

const experiments: Record<string, () => Promise<unknown>> = { pair, read, upgrade, make, pages, surface, prefs, frame };
if (!experiment || !experiments[experiment]) {
  console.log(`usage: library-probe.ts <${Object.keys(experiments).join("|")}> --instance <name> --data <dir> [--data2 <dir>]`);
  process.exit(1);
}
await experiments[experiment]!();
setTimeout(() => process.exit(0), 300);
