// Probes behind docs/research/connectors.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name>
//   node docs/research/connectors/probe.ts <experiment> --instance <name> --data <dir> [...]
//
// It acts only on a named development instance this checkout started, reads
// that instance's address, token and ports from the tool's own run files, and
// runs `openclaw` only through the tool's guarded runner (so always with
// `--profile clawtrate-dev-<name>`). Every line it prints passes through
// `redact`. The client folder given with `--data` is kept between experiments,
// so one device pairs once and is reused; `--data` names a second folder for
// the read-only device.
//
// Nothing here reaches beyond loopback. The instance's gateway sends every
// request for another host to its scripted model, which refuses it and logs
// it (`proxy` in devConfig); `refused` prints those lines. The only tool
// servers it configures are the stand-in below, on 127.0.0.1, and the tool's
// own stand-in coding agent as a command. Every secret is a made-up
// `example-…` string.
//
// Experiments:
//   pair       this project's client connects with the shared token, approved
//              with the gateway's own `devices approve <requestId>`
//   upgrade    the same device asks for --tier interactive or admin
//   call       one request: --method <m> [--params <json>]
//   catalog    every catalog read on this device, as it is
//   plugins    as admin: install from ClawHub (refused beyond loopback),
//              enable and disable a bundled plugin, uninstall one; each read back
//   servers    as admin: add, read back, list tools of, and remove tool servers,
//              good and bad; where headers and a client secret are kept
//   signin     mcp.authLogin on each kind of connection and server; with
//              --browser, a connection that declares a loopback browser origin,
//              against the stand-in's OAuth, played to its end on loopback
//   refused    the requests beyond loopback the fence refused so far

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ClawtrateClient } from "../../../packages/core/src/client.ts";
import { createNodeHost } from "../../../packages/core/src/node/index.ts";
import {
  CODING_AGENT_SCRIPT,
  openInstance,
  readDevConnection,
} from "../../../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../../../tools/dev-gateway/src/env.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    instance: { type: "string" },
    data: { type: "string" },
    tier: { type: "string", default: "admin" },
    method: { type: "string" },
    params: { type: "string", default: "{}" },
    max: { type: "string", default: "1400" },
    browser: { type: "boolean", default: false },
    outcome: { type: "string", default: "approve" },
  },
  allowPositionals: true,
});
const experiment = positionals[0];
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
const connection = readDevConnection(inst.connectionFile);
if (!connection || connection.instance !== values.instance) throw new Error("no connection record for this instance");
const url = connection.url;
const ports = JSON.parse(readFileSync(inst.runFile, "utf8")) as { gatewayPort: number; providerPort: number };

const secrets: string[] = [connection.token];
const machineWords = [hostname(), hostname().split(".")[0]!].filter((w) => w.length >= 3);
const addresses = Object.values(networkInterfaces())
  .flat()
  .map((i) => i?.address)
  .filter((a): a is string => Boolean(a) && a !== "127.0.0.1" && a !== "::1");
const redact = (text: string) => {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  out = out.split(homedir()).join("~");
  for (const word of machineWords) out = out.split(word).join("<this machine>");
  for (const address of addresses) out = out.split(address).join("<an address>");
  return out.replace(/("(?:token|deviceToken|bootstrapToken|publicKey)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const max = Number(values.max);
const say = (...parts: unknown[]) => {
  const line = redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  console.log(line.length > max ? `${line.slice(0, max)} …(${line.length} chars)` : line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runOpenclaw(args: string[]) {
  const result = inst.runner.runSync(args);
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function coreClient() {
  if (!values.data) throw new Error("--data <dir> is required");
  mkdirSync(values.data, { recursive: true, mode: 0o700 });
  return new ClawtrateClient(
    createNodeHost({
      dataDir: values.data,
      client: { displayName: "Clawtrate Desktop", version: "0.0.0-research", platform: process.platform },
    }),
    { reconnect: { initialMs: 500, maxMs: 2000 } },
  );
}

async function settle(done: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await sleep(100);
}

type Request = (m: string, p: unknown) => Promise<unknown>;

async function connected() {
  const client = coreClient();
  await client.start();
  await settle(() => client.state.connection.status === "connected");
  if (client.state.connection.status !== "connected") throw new Error(`not connected: ${client.state.connection.status}`);
  const request = (client as unknown as { request: Request }).request.bind(client);
  return { client, request, scopes: client.state.connection.scopes };
}

async function attempt(request: Request, method: string, params: unknown) {
  try {
    return { ok: true, result: await request(method, params) };
  } catch (error) {
    const e = error as Error & { code?: string; details?: unknown };
    return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
  }
}

async function pair() {
  const client = coreClient();
  await client.start();
  await client.connect({ url, token: connection!.token });
  await settle(() => ["connected", "pairing", "error"].includes(client.state.connection.status));
  const requestId = client.state.connection.pairing?.requestId;
  if (requestId) say(`devices approve <request>: exit ${runOpenclaw(["devices", "approve", requestId]).status}`);
  await settle(() => client.state.connection.status === "connected", 20_000);
  say("paired:", { status: client.state.connection.status, scopes: client.state.connection.scopes });
  client.stop();
}

async function upgrade() {
  const { client } = await connected();
  const tier = values.tier === "admin" ? "admin" : "interactive";
  void client.requestAccess(tier).catch((e: unknown) => say("requestAccess:", String(e)));
  await settle(() => !["idle", "requesting"].includes(client.state.connection.upgrade.status), 10_000);
  const requestId = client.state.connection.upgrade.requestId;
  if (requestId) say(`devices approve <request>: exit ${runOpenclaw(["devices", "approve", requestId]).status}`);
  await settle(() => (tier === "admin" ? client.state.connection.canAdmin : client.state.connection.canWrite), 20_000);
  await sleep(1500);
  say("scopes now:", client.state.connection.scopes);
  client.stop();
}

async function call() {
  if (!values.method) throw new Error("--method is required");
  const { client, request, scopes } = await connected();
  say("as:", scopes);
  say(`${values.method}:`, await attempt(request, values.method, JSON.parse(values.params!)));
  client.stop();
}

/** The fence's log: every request the gateway made for a host beyond loopback. */
function refusedLines(): string[] {
  const log = join(inst.runDir, "provider.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.includes("refused a request beyond loopback"));
}

/** A short view of a catalog answer: how many items, their names and local facts, any remote error. */
function items(result: unknown) {
  const r = result as { items?: { id: string; catalog: { name: string; official?: boolean; categories?: string[] }; local: unknown }[]; remoteError?: string; categories?: unknown[]; nextCursor?: string };
  return {
    count: r.items?.length ?? null,
    first: (r.items ?? []).slice(0, 4).map((i) => ({ id: i.id, name: i.catalog.name, official: i.catalog.official, categories: i.catalog.categories, local: i.local })),
    ...(r.categories ? { categories: r.categories.length } : {}),
    ...(r.nextCursor ? { nextCursor: true } : {}),
    ...(r.remoteError ? { remoteError: r.remoteError } : {}),
  };
}

async function catalog() {
  const { client, request, scopes } = await connected();
  say("as:", scopes);
  const before = refusedLines().length;
  const list = await attempt(request, "plugins.list", {});
  const plugins = ((list.result as { plugins?: Record<string, unknown>[] })?.plugins ?? []);
  say("plugins.list:", list.ok ? {
    count: plugins.length,
    mutationAllowed: (list.result as { mutationAllowed?: boolean }).mutationAllowed,
    diagnostics: ((list.result as { diagnostics?: unknown[] }).diagnostics ?? []).length,
    plugins: plugins.map((p) => ({ id: p.id, state: p.state, enabled: p.enabled, origin: p.origin, removable: p.removable, runtime: p.runtime, catalogId: p.catalogId, categories: p.categories })),
  } : list);
  const first = plugins.find((p) => p.id === "github") ?? plugins[0];
  say("plugins.list, one row whole:", first);
  say("plugins.catalog.categories:", await attempt(request, "plugins.catalog.categories", {}));
  for (const params of [{}, { intent: "bundled" }, { intent: "featured" }, { intent: "official" }, { query: "notes" }, { category: "productivity" }]) {
    const r = await attempt(request, "plugins.catalog.browse", params);
    say(`plugins.catalog.browse ${JSON.stringify(params)}:`, r.ok ? items(r.result) : r);
  }
  if (first?.catalogId) say("plugins.catalog.get <a local id>:", await attempt(request, "plugins.catalog.get", { id: first.catalogId }));
  say("plugins.catalog.get <a ClawHub id>:", await attempt(request, "plugins.catalog.get", { id: "clawhub:example-notes" }));
  say("plugins.inspect github:", await attempt(request, "plugins.inspect", { pluginId: "github" }));
  say("plugins.search:", await attempt(request, "plugins.search", { query: "notes" }));
  say("skills.search:", await attempt(request, "skills.search", { query: "notes" }));
  say("plugins.install (this scope):", await attempt(request, "plugins.install", { source: "clawhub", packageName: "example-notes" }));
  await sleep(500);
  say("refused beyond loopback during this experiment:", refusedLines().slice(before));
  client.stop();
}

async function pluginsLifecycle() {
  const { client, request, scopes } = await connected();
  say("as:", scopes);
  const row = async (id: string) => {
    const r = await attempt(request, "plugins.list", {});
    const p = ((r.result as { plugins?: Record<string, unknown>[] })?.plugins ?? []).find((x) => x.id === id);
    return p ? { id: p.id, state: p.state, enabled: p.enabled, runtime: p.runtime, removable: p.removable } : `not listed (${id})`;
  };
  const before = refusedLines().length;
  const progress: unknown[] = [];
  const unsubscribe = (client as unknown as { onEvent?: (h: (e: { event: string; payload: unknown }) => void) => () => void }).onEvent?.((e) => {
    if (e.event.startsWith("plugins.")) progress.push({ event: e.event, payload: e.payload });
  });
  say("1. plugins.install clawhub example-notes:", await attempt(request, "plugins.install", { source: "clawhub", packageName: "example-notes" }));
  say("   plugins.install official example-notes:", await attempt(request, "plugins.install", { source: "official", pluginId: "example-notes" }));
  say("   plugins.list afterwards has it?", await row("example-notes"));
  say("   refused beyond loopback:", refusedLines().slice(before));
  say("2. plugins.setEnabled geolocation false:", await attempt(request, "plugins.setEnabled", { pluginId: "geolocation", enabled: false }));
  say("   read back:", await row("geolocation"));
  say("   plugins.inspect geolocation, enabled:", ((await attempt(request, "plugins.inspect", { pluginId: "geolocation" })).result as { plugin?: unknown })?.plugin);
  say("   plugins.setEnabled geolocation true:", await attempt(request, "plugins.setEnabled", { pluginId: "geolocation", enabled: true }));
  say("   read back:", await row("geolocation"));
  say("3. plugins.uninstall geolocation (bundled):", await attempt(request, "plugins.uninstall", { pluginId: "geolocation" }));
  say("   read back:", await row("geolocation"));
  say("4. plugins.uninstall example-notes (not installed):", await attempt(request, "plugins.uninstall", { pluginId: "example-notes" }));
  await sleep(500);
  say("events seen:", progress);
  unsubscribe?.();
  client.stop();
}

/** A stand-in MCP server over Streamable HTTP on 127.0.0.1, with one tool; with `oauth`, it asks for a sign-in first. */
function stub(options: { oauth?: boolean } = {}) {
  const seen: { method?: string; path: string; headers: Record<string, string> }[] = [];
  let port = 0;
  const base = () => `http://127.0.0.1:${port}`;
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => resolve(body));
    });
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", base()).pathname;
      const body = await read(req);
      const interesting: Record<string, string> = {};
      for (const key of ["x-example", "authorization", "content-type"]) if (req.headers[key]) interesting[key] = String(req.headers[key]);
      let rpc: { id?: number; method?: string; params?: { protocolVersion?: string } } = {};
      try {
        rpc = body ? JSON.parse(body) : {};
      } catch {
        // not JSON
      }
      seen.push({ method: rpc.method ?? req.method, path, headers: interesting });
      if (options.oauth) {
        if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")
          return json(res, 200, { resource: `${base()}/mcp`, authorization_servers: [base()] });
        if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")
          return json(res, 200, {
            issuer: base(),
            // The page a person would sign in on: a reserved name, never opened.
            authorization_endpoint: "https://signin.example/authorize",
            token_endpoint: `${base()}/token`,
            registration_endpoint: `${base()}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        if (path === "/register") {
          const asked = body ? (JSON.parse(body) as Record<string, unknown>) : {};
          return json(res, 201, { ...asked, client_id: "example-registered-client" });
        }
        if (path === "/token")
          return json(res, 200, { access_token: "example-access-token", token_type: "Bearer", expires_in: 3600, refresh_token: "example-refresh-token" });
        if (path === "/mcp" && req.headers.authorization !== "Bearer example-access-token")
          return json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"` });
      }
      if (path !== "/mcp") return json(res, 404, { error: "not found" });
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (rpc.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (rpc.method === "initialize")
        return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe-stub", version: "0.0.0" } } });
      if (rpc.method === "tools/list")
        return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "echo", description: "Return the text it is given.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
      return json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } });
    })();
  });
  return new Promise<{ base: string; seen: typeof seen; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve({ base: base(), seen, close: () => server.close() });
    }),
  );
}

async function configHash(request: Request) {
  return ((await request("config.get", {})) as { hash: string }).hash;
}
async function patch(request: Request, servers: Record<string, unknown>, replacePaths?: string[]) {
  const r = await attempt(request, "config.patch", { raw: JSON.stringify({ mcp: { servers } }), baseHash: await configHash(request), ...(replacePaths ? { replacePaths } : {}) });
  if (!r.ok) return r;
  const { config, ...rest } = r.result as { config?: { mcp?: unknown } };
  return { ok: true, ...rest, mcp: config?.mcp };
}
async function serversNow(request: Request) {
  const got = (await request("config.get", {})) as { config?: { mcp?: { servers?: Record<string, unknown> } } };
  return got.config?.mcp?.servers ?? {};
}
/** What the gateway's tool list for a bot's task says of a server's tools. */
async function toolsFor(request: Request, server: string) {
  const r = await attempt(request, "tools.effective", { agentId: "pip", sessionKey: "agent:pip:errands-saturday" });
  if (!r.ok) return r;
  const result = r.result as { groups?: { id?: string; label?: string; source?: string; tools?: { id?: string }[] }[]; notices?: unknown[] };
  const groups = (result.groups ?? []).filter((g) => JSON.stringify(g).includes(server));
  const names = groups.flatMap((g) => (g.tools ?? []).map((t) => t.id ?? "")).filter((n) => n.startsWith(`${server}__`));
  const notices = (result.notices ?? []).filter((n) => JSON.stringify(n).includes(server));
  return { groups: groups.map((g) => ({ id: g.id, label: g.label, source: g.source })), tools: names, notices };
}

async function servers() {
  const { client, request, scopes } = await connected();
  say("as:", scopes);
  const before = refusedLines().length;
  const s = await stub();
  say("config.schema.lookup mcp.servers.*:", await attempt(request, "config.schema.lookup", { path: "mcp.servers.*" }));
  say("config.schema.lookup mcp.servers.*.oauth:", await attempt(request, "config.schema.lookup", { path: "mcp.servers.*.oauth" }));
  say("0. mcp.servers as config.get shows them:", await serversNow(request));
  say("   the coder server in the tool list:", await toolsFor(request, "coder"));

  say("1a. a client id and secret for the OAuth block:", await patch(request, {
    "probe-remote": { url: `${s.base}/mcp`, transport: "streamable-http", auth: "oauth", oauth: { clientId: "example-client-id", clientSecret: "example-client-secret" } },
  }));
  say("1. add probe-remote (stand-in, loopback, a header):", await patch(request, {
    "probe-remote": { url: `${s.base}/mcp`, transport: "streamable-http", headers: { "X-Example": "example-header-value" } },
  }));
  await sleep(2000);
  say("   read back:", (await serversNow(request))["probe-remote"]);
  say("   tool list:", await toolsFor(request, "probe-remote"));
  say("   what the stand-in received:", s.seen);
  const configText = readFileSync(inst.configPath, "utf8");
  say("   on disk, the config file holds the header value in plain text:", configText.includes("example-header-value"));

  say("2. add probe-cmd, the tool's stand-in coding agent as a command:", await patch(request, {
    "probe-cmd": { command: process.execPath, args: [CODING_AGENT_SCRIPT], cwd: inst.stateDir },
  }));
  await sleep(2000);
  say("   read back:", (await serversNow(request))["probe-cmd"]);
  say("   tool list:", await toolsFor(request, "probe-cmd"));

  say("3. bad: an address that is not one:", await patch(request, { "probe-bad": { url: "not an address", transport: "streamable-http" } }));
  say("   bad: ftp:", await patch(request, { "probe-bad": { url: "ftp://127.0.0.1/mcp", transport: "streamable-http" } }));
  say("   bad: no command and no address:", await patch(request, { "probe-bad": { args: ["x"] } }));
  say("   bad: an empty command:", await patch(request, { "probe-bad": { command: "" } }));
  say("   read back after the refusals:", Object.keys(await serversNow(request)));

  say("4. a server that does not answer (a closed loopback port):", await patch(request, { "probe-closed": { url: "http://127.0.0.1:9/mcp", transport: "streamable-http" } }));
  await sleep(2000);
  say("   read back:", (await serversNow(request))["probe-closed"]);
  say("   tool list:", await toolsFor(request, "probe-closed"));
  say("5. an address beyond loopback (documentation range):", await patch(request, { "probe-far": { url: "https://192.0.2.10/mcp", transport: "streamable-http" } }));
  await sleep(2000);
  say("   tool list:", await toolsFor(request, "probe-far"));
  say("6. a command that does not exist:", await patch(request, { "probe-nocmd": { command: "/nonexistent/example-command", args: [] } }));
  await sleep(2000);
  say("   tool list:", await toolsFor(request, "probe-nocmd"));

  const gone = { "probe-remote": null, "probe-cmd": null, "probe-closed": null, "probe-far": null, "probe-nocmd": null, "probe-bad": null };
  say("7. remove them all (null):", await patch(request, gone));
  say("   again, naming the argument lists in replacePaths:", await patch(request, gone, ["mcp.servers.probe-cmd.args", "mcp.servers.probe-nocmd.args", "mcp.servers.probe-bad.args"]));
  await sleep(2000);
  say("   read back:", Object.keys(await serversNow(request)));
  say("   tool list, probe-remote:", await toolsFor(request, "probe-remote"));
  const after = readFileSync(inst.configPath, "utf8");
  say("   config file still holds the header value:", after.includes("example-header-value"));
  say("refused beyond loopback during this experiment:", refusedLines().slice(before));
  s.close();
  client.stop();
}

/** Add good and bad servers, run one turn for Pip, then read what the tool list reports for each. */
async function discover() {
  const { client, request, scopes } = await connected();
  say("as:", scopes);
  const before = refusedLines().length;
  const s = await stub();
  const servers = {
    "probe-remote": { url: `${s.base}/mcp`, transport: "streamable-http", headers: { "X-Example": "example-header-value" } },
    "probe-closed": { url: `http://127.0.0.1:${await freePort()}/mcp`, transport: "streamable-http" },
    "probe-far": { url: "https://192.0.2.10/mcp", transport: "streamable-http" },
    "probe-nocmd": { command: "/nonexistent/example-command" },
    "probe-empty": { command: "" },
  };
  say("add:", (await patch(request, servers)).ok);
  const sessionKey = "agent:pip:errands-saturday";
  const t0 = Date.now();
  say("chat.send #steps:", (await attempt(request, "chat.send", { sessionKey, message: "#steps", idempotencyKey: randomUUID(), queueMode: "followup" })).ok);
  for (let i = 0; i < 60; i++) {
    const h = (await request("chat.history", { sessionKey, limit: 3 })) as { messages?: { role?: string }[] };
    if (i > 2 && h.messages?.at(-1)?.role === "assistant") break;
    await sleep(1000);
  }
  say(`turn ended after ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const name of Object.keys(servers)) say(`tool list, ${name}:`, await toolsFor(request, name));
  say("what the stand-in received:", s.seen);
  const r = await attempt(request, "tools.effective", { agentId: "pip", sessionKey });
  say("every notice:", (r.result as { notices?: unknown[] })?.notices);
  const gone = Object.fromEntries(Object.keys(servers).map((k) => [k, null]));
  say("remove:", (await patch(request, gone)).ok);
  say("read back:", Object.keys(await serversNow(request)));

  // The instance offers bots only the tools it allows, `coder__*` among them,
  // so the remote stand-in is put in coder's place for one run, then coder back.
  const coder = (await serversNow(request)).coder;
  say("coder replaced by the remote stand-in:", (await patch(request, { coder: null }, ["mcp.servers.coder.args"])).ok, (await patch(request, { coder: { url: `${s.base}/mcp`, transport: "streamable-http" } })).ok);
  say("chat.send #steps:", (await attempt(request, "chat.send", { sessionKey, message: "#steps", idempotencyKey: randomUUID(), queueMode: "followup" })).ok);
  await sleep(6000);
  say("tool list, coder as the remote stand-in:", await toolsFor(request, "coder"));
  say("coder put back:", (await patch(request, { coder: null })).ok, (await patch(request, { coder })).ok);
  say("read back:", (await serversNow(request)).coder);
  say("refused beyond loopback during this experiment:", refusedLines().slice(before));
  s.close();
  client.stop();
}

/** A loopback port nothing listens on, at this moment. */
function freePort() {
  return new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

/** A raw client that connects as a web chat client, declaring `origin`, with a device of its own. */
async function browserClient(origin: string, scopes: string[]) {
  const requireFromTool = createRequire(new URL("../../../tools/dev-gateway/package.json", import.meta.url));
  const { GatewayClient } = (await import(pathToFileURL(requireFromTool.resolve("@openclaw/gateway-client")).href)) as {
    GatewayClient: new (options: unknown) => { start(): void; stop(): void; request(m: string, p: unknown, o?: unknown): Promise<unknown> };
  };
  const keyFile = join(values.data!, "browser-device.json");
  let identity: { deviceId: string; publicKeyPem: string; privateKeyPem: string };
  if (existsSync(keyFile)) identity = JSON.parse(readFileSync(keyFile, "utf8"));
  else {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    identity = {
      deviceId: createHash("sha256").update(raw).digest("hex"),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    mkdirSync(values.data!, { recursive: true, mode: 0o700 });
    (await import("node:fs")).writeFileSync(keyFile, JSON.stringify(identity), { mode: 0o600 });
  }
  const tokenFile = join(values.data!, "browser-token.json");
  const events: { event: string; payload: unknown }[] = [];
  const open = () =>
    new Promise<{ client?: InstanceType<typeof GatewayClient>; outcome: unknown }>((resolve) => {
      const client = new GatewayClient({
        url,
        token: connection!.token,
        clientName: "webchat-ui",
        mode: "webchat",
        clientDisplayName: "Clawtrate research (web chat)",
        clientVersion: "0.0.0-research",
        platform: process.platform,
        role: "operator",
        scopes,
        caps: ["tool-events"],
        origin,
        deviceIdentity: identity,
        hostDeps: {
          signDevicePayload: (pem: string, payload: string) => sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
          publicKeyRawBase64UrlFromPem: (pem: string) => createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
          loadDeviceAuthToken: () => (existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, "utf8")) : undefined),
          storeDeviceAuthToken: (record: unknown) => void import("node:fs").then((fs) => fs.writeFileSync(tokenFile, JSON.stringify(record), { mode: 0o600 })),
          clearDeviceAuthToken: () => {},
        },
        onEvent: (e: { event: string; payload: unknown }) => events.push(e),
        onHelloOk: (hello: { auth?: { scopes?: string[] } }) => resolve({ client, outcome: { hello: true, scopes: hello.auth?.scopes } }),
        onConnectError: (error: Error & { details?: unknown; code?: string }) => {
          resolve({ outcome: { refused: error.message, code: error.code, details: error.details } });
          setTimeout(() => client.stop(), 0);
        },
        onClose: (code: number, reason: string) => resolve({ outcome: { closed: code, reason } }),
      });
      client.start();
      setTimeout(() => resolve({ outcome: "no answer in 15 s" }), 15_000);
    });
  let opened = await open();
  const details = (opened.outcome as { details?: { requestId?: string } }).details;
  if (!opened.client && details?.requestId) {
    say("web chat device: pairing requested; devices approve:", runOpenclaw(["devices", "approve", details.requestId]).status);
    await sleep(1000);
    opened = await open();
  }
  return { ...opened, events };
}

async function signin() {
  const { client, request, scopes } = await connected();
  say("as (this project's client, no browser origin):", scopes);
  const s = await stub({ oauth: true });
  say("add probe-oauth (auth: oauth) and probe-each (per-requester):", await patch(request, {
    "probe-oauth": { url: `${s.base}/mcp`, transport: "streamable-http", auth: "oauth" },
    "probe-each": { url: `${s.base}/mcp`, transport: "streamable-http", auth: "oauth", oauth: { identity: "per-requester" } },
  }));
  await sleep(1500);
  say("   tool list (no sign-in yet):", await toolsFor(request, "probe-oauth"));
  for (const serverName of ["probe-oauth", "coder", "probe-each", "probe-none"]) {
    say(`mcp.authLogin ${serverName}:`, await attempt(request, "mcp.authLogin", { sessionId: randomUUID(), serverName }));
  }
  if (values.browser) {
    const origin = `http://127.0.0.1:${ports.gatewayPort}`;
    const b = await browserClient(origin, ["operator.read", "operator.admin"]);
    say("web chat connection with origin", origin, ":", b.outcome);
    if (b.client) {
      const sessionId = randomUUID();
      const started = await b.client.request("mcp.authLogin", { sessionId, serverName: "probe-oauth" }).catch((e: Error) => ({ error: e.message }));
      say("mcp.authLogin probe-oauth, first answer:", started);
      let step = started as { done?: boolean; step?: { id: string; externalUrl?: string; type?: string; message?: string }; status?: string; error?: string };
      const t0 = Date.now();
      for (let i = 0; i < 8 && step && !step.done && !step.step?.externalUrl; i++) {
        step = (await b.client.request("wizard.next", { sessionId }).catch((e: Error) => ({ error: e.message }))) as typeof step;
        say(`wizard.next (${Math.round((Date.now() - t0) / 1000)} s):`, step);
      }
      const external = step?.step?.externalUrl;
      if (external) {
        const authUrl = new URL(external);
        say("the sign-in page's host:", authUrl.host, "its redirect_uri:", authUrl.searchParams.get("redirect_uri"));
        if (values.outcome === "cancel") {
          say("wizard.cancel:", await b.client.request("wizard.cancel", { sessionId }).catch((e: Error) => ({ error: e.message })));
        } else {
          // Playing the browser on loopback: the provider would redirect here. signin.example is never opened.
          const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);
          redirect.searchParams.set("state", authUrl.searchParams.get("state")!);
          if (values.outcome === "refuse") redirect.searchParams.set("error", "access_denied");
          else redirect.searchParams.set("code", "example-authorization-code");
          const answer = await fetch(redirect, { redirect: "manual" });
          const page = await answer.text();
          say("the gateway's callback page:", answer.status, page.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300));
          const ack = step!.step!.id;
          step = (await b.client.request("wizard.next", { sessionId, answer: { stepId: ack, value: true } }).catch((e: Error) => ({ error: e.message }))) as typeof step;
          say("wizard.next after the callback:", step);
          for (let i = 0; i < 4 && step && !step.done; i++) {
            step = (await b.client.request("wizard.next", { sessionId }).catch((e: Error) => ({ error: e.message }))) as typeof step;
            say("wizard.next:", step);
          }
        }
      }
      say("events on the web chat connection:", b.events.filter((e) => /wizard|mcp|plugins/.test(e.event)));
      say("what the stand-in received:", s.seen.map((x) => `${x.method} ${x.path}${x.headers.authorization ? " (with a bearer token)" : ""}`));
      await sleep(1500);
      say("tool list after:", await toolsFor(request, "probe-oauth"));
      b.client.stop();
    }
  }
  say("remove probe-oauth and probe-each:", await patch(request, { "probe-oauth": null, "probe-each": null }));
  say("read back:", Object.keys(await serversNow(request)));
  s.close();
  client.stop();
}

const experiments: Record<string, () => Promise<void> | void> = {
  pair,
  upgrade,
  call,
  catalog,
  plugins: pluginsLifecycle,
  servers,
  discover,
  signin,
  refused: () => say(refusedLines()),
  devices: () => say(parseJsonOutput(runOpenclaw(["devices", "list", "--json"]).out)),
};
const run = experiment ? experiments[experiment] : undefined;
if (!run) throw new Error(`experiment: ${Object.keys(experiments).join(", ")}`);
await run();
process.exit(0);
