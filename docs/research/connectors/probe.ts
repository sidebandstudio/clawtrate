// The probe behind docs/research/connectors.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <yours>
//   CONNECTORS_PROBE_TOKEN=<that instance's token> \
//     node docs/research/connectors/probe.ts --url ws://127.0.0.1:<its port>
//
// It connects only to the address it is given, with the token it is given, and
// to nothing else:
//   - the address must be ws:// on 127.0.0.1, ::1 or localhost, and never port
//     18789, the port a person's own OpenClaw uses by default;
//   - it reads no saved gateway, token store, profile or instance folder: the
//     client starts in a new empty folder made for this run and removed at
//     exit, connects with `connect({url, token})` and never with `start()`,
//     which would resume a saved gateway;
//   - once connected, it refuses to go on unless the gateway reports
//     OpenClaw 2026.10.6 or 2026.11.10 and is configured as a development
//     gateway is: `models.mode: "replace"`, every model provider on
//     loopback, and an egress proxy set (on loopback, or hidden by the gateway);
//   - it runs no `openclaw` command. Pairing and the admin upgrade are
//     approved by the person, with `pnpm dev-gateway approve --instance
//     <yours> <requestId>`, which the probe prints and then waits for.
//
// It writes only entries whose names start with `probe-`, and one tool rule
// on each of the two bots it uses, and puts back every rule it changed. The
// only tool server it serves is the stand-in below, in this process, on
// 127.0.0.1. Every secret is a made-up `example-…` string. Every line it
// prints passes through `redact`.
//
// What it does, in order: reads the gateway's facts; adds a server by address
// (without a revision, with a stale one, then properly) and reads it back;
// tries the shapes the gateway refuses; gives the server to one bot and not
// the other, runs one turn for each and reads each task's tool listing; asks
// for the gateway's sign-in and sign-out on an OAuth entry; removes everything
// and reads back.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { ClawtrateClient } from "../../../packages/core/src/client.ts";
import { createNodeHost } from "../../../packages/core/src/node/index.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: "string" },
    task: { type: "string", default: "agent:pip:errands-saturday" },
    "other-task": { type: "string", default: "agent:otto:disk-space" },
    max: { type: "string", default: "1600" },
  },
});

const VERSIONS = ["2026.10.6", "2026.11.10"];
const url = values.url ?? "";
const token = process.env.CONNECTORS_PROBE_TOKEN?.trim() ?? "";
{
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("--url ws://127.0.0.1:<port> is required");
  }
  if (parsed.protocol !== "ws:") throw new Error("only a ws:// address on this computer is probed");
  if (!["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)) throw new Error("only a loopback address is probed");
  if (parsed.port === "" || parsed.port === "18789") throw new Error("port 18789 is never probed: give your development gateway's port");
  if (!token) throw new Error("set CONNECTORS_PROBE_TOKEN to your development gateway's token");
}
const botOf = (key: string) => key.split(":")[1] ?? "";
const task = values.task!;
const otherTask = values["other-task"]!;
const [bot, other] = [botOf(task), botOf(otherTask)];

const machine = [hostname(), hostname().split(".")[0]!].filter((w) => w.length >= 3);
const redact = (text: string) => {
  let out = text.split(token).join("<token>").split(homedir()).join("~");
  for (const word of machine) out = out.split(word).join("<this machine>");
  return out.replace(/("(?:token|deviceToken|bootstrapToken|publicKey|signature)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const max = Number(values.max);
const say = (...parts: unknown[]) => {
  const line = redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  console.log(line.length > max ? `${line.slice(0, max)} …(${line.length} chars)` : line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const folder = mkdtempSync(join(tmpdir(), "clawtrate-connectors-probe-"));
const cleanup = () => rmSync(folder, { recursive: true, force: true });
process.on("exit", cleanup);

type Request = (m: string, p: unknown) => Promise<unknown>;
type Answer = { ok: true; result: unknown } | { ok: false; error: { code?: string; message: string; details?: unknown } };
async function attempt(request: Request, method: string, params: unknown): Promise<Answer> {
  try {
    return { ok: true, result: await request(method, params) };
  } catch (error) {
    const e = error as Error & { code?: string; details?: unknown };
    return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
  }
}
async function until(done: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await sleep(200);
  return done();
}

/** A tool server written for this probe: Streamable HTTP on loopback, one tool, `echo`. */
function standIn() {
  const seen: { method?: string; headers: Record<string, string> }[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => resolve(body));
    });
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await read(req);
      let rpc: { id?: number; method?: string; params?: { protocolVersion?: string } } = {};
      try {
        rpc = body ? JSON.parse(body) : {};
      } catch {
        // not JSON
      }
      const headers: Record<string, string> = {};
      if (req.headers["x-example"]) headers["x-example"] = String(req.headers["x-example"]);
      seen.push({ method: rpc.method ?? req.method, headers });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") return json(404, { error: "not found" });
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      if (rpc.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (rpc.method === "initialize")
        return json(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "probe-stand-in", version: "0.0.0" },
          },
        });
      if (rpc.method === "tools/list")
        return json(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            tools: [
              {
                name: "echo",
                description: "Return the text it is given.",
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
              },
            ],
          },
        });
      return json(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } });
    })();
  });
  return new Promise<{ base: string; seen: typeof seen; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, seen, close: () => server.close() });
    }),
  );
}

async function connect() {
  const client = new ClawtrateClient(
    createNodeHost({
      dataDir: folder,
      client: { displayName: "Clawtrate connectors probe", version: "0.0.0-research", platform: process.platform },
    }),
    { reconnect: { initialMs: 500, maxMs: 2000 } },
  );
  const conn = () => client.state.connection;
  await client.connect({ url, token });
  await until(() => ["connected", "pairing", "error"].includes(conn().status), 20_000);
  const pairing = conn().pairing?.requestId;
  if (conn().status === "pairing" && pairing) {
    say(`waiting for approval: pnpm dev-gateway approve --instance <yours> ${pairing}`);
    await until(() => conn().status === "connected", 180_000);
  }
  if (conn().status !== "connected") throw new Error(`not connected: ${conn().status}`);
  const request = (client as unknown as { request: Request }).request.bind(client);

  // The guard: a development gateway, configured as the development tool does it.
  const version = String(conn().serverVersion ?? "");
  const got = (await request("config.get", {})) as {
    config?: { models?: { mode?: string; providers?: Record<string, { baseUrl?: string }> }; proxy?: { proxyUrl?: string } };
  };
  const loopback = (address?: string) => {
    try {
      return ["127.0.0.1", "[::1]", "localhost"].includes(new URL(address ?? "").hostname);
    } catch {
      return false;
    }
  };
  const providers = Object.values(got.config?.models?.providers ?? {});
  // `config.get` hides the proxy's address; a hidden one counts, an absent one doesn't.
  const fenced = (address?: string) => address === "__OPENCLAW_REDACTED__" || loopback(address);
  if (
    !VERSIONS.includes(version) ||
    got.config?.models?.mode !== "replace" ||
    providers.length === 0 ||
    !providers.every((p) => loopback(p.baseUrl)) ||
    !fenced(got.config?.proxy?.proxyUrl)
  ) {
    client.stop();
    throw new Error(
      `refused: this gateway (OpenClaw ${version || "unknown"}) is not configured as a development gateway: ${JSON.stringify({ version: VERSIONS.includes(version), mode: got.config?.models?.mode, providers: providers.map((p) => loopback(p.baseUrl)), proxy: fenced(got.config?.proxy?.proxyUrl) })}`,
    );
  }

  if (!conn().canAdmin) {
    void client.requestAccess("admin").catch((e: unknown) => say("requestAccess:", String(e)));
    await until(() => Boolean(conn().upgrade.requestId) || conn().canAdmin, 15_000);
    if (conn().upgrade.requestId) say(`waiting for approval: pnpm dev-gateway approve --instance <yours> ${conn().upgrade.requestId}`);
    await until(() => conn().canAdmin, 180_000);
    await sleep(1500);
  }
  if (!conn().canAdmin) throw new Error("admin access was not approved");
  return { client, request, version };
}

async function main() {
  const { client, request, version } = await connect();
  say("OpenClaw", version, "scopes", client.state.connection.scopes);
  const s = await standIn();

  const get = async () =>
    (await request("config.get", {})) as {
      hash: string;
      config: {
        mcp?: { servers?: Record<string, unknown> };
        tools?: { allow?: string[] };
        agents?: { entries?: Record<string, { tools?: { allow?: string[]; deny?: string[] } }> };
      };
    };
  const patch = async (raw: unknown, options: { baseHash?: string | null; replacePaths?: string[] } = {}) => {
    const baseHash = options.baseHash === undefined ? (await get()).hash : options.baseHash;
    const r = await attempt(request, "config.patch", {
      raw: JSON.stringify(raw),
      ...(baseHash ? { baseHash } : {}),
      ...(options.replacePaths ? { replacePaths: options.replacePaths } : {}),
    });
    if (!r.ok) return r;
    const { config: _config, ...rest } = r.result as { config?: unknown };
    return { ok: true, ...rest };
  };
  const listing = async (sessionKey: string, server: string) => {
    const r = await attempt(request, "tools.effective", { agentId: botOf(sessionKey), sessionKey });
    if (!r.ok) return r;
    const result = r.result as {
      groups?: { id?: string; source?: string; tools?: { id?: string; mcpServer?: string }[] }[];
      notices?: unknown[];
    };
    const tools = (result.groups ?? []).flatMap((g) =>
      (g.tools ?? []).filter((t) => t.mcpServer === server || t.id?.startsWith(`${server}__`)).map((t) => ({ id: t.id, mcpServer: t.mcpServer, group: g.id })),
    );
    const notices = (result.notices ?? []).filter((n) => JSON.stringify(n).includes(server));
    return { tools, notices };
  };
  const turn = async (sessionKey: string) => {
    const before = ((await request("chat.history", { sessionKey, limit: 1 })) as { messages?: unknown[] }).messages?.length ?? 0;
    const sent = await attempt(request, "chat.send", { sessionKey, message: "#steps", idempotencyKey: randomUUID(), queueMode: "followup" });
    const t0 = Date.now();
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const h = (await request("chat.history", { sessionKey, limit: 3 })) as { messages?: { role?: string }[] };
      if (i > 2 && h.messages?.at(-1)?.role === "assistant") break;
    }
    return { sent: sent.ok, seconds: Math.round((Date.now() - t0) / 1000), before };
  };

  say("1. facts");
  say("   config.schema.lookup mcp.servers.*:", await attempt(request, "config.schema.lookup", { path: "mcp.servers.*" }));
  say("   config.schema.lookup agents.entries.*.tools:", await attempt(request, "config.schema.lookup", { path: "agents.entries.*.tools" }));
  const start = await get();
  const allowBefore = start.config.tools?.allow;
  const entryTools = (id: string) => start.config.agents?.entries?.[id]?.tools ?? {};
  say("   gateway tools.allow:", allowBefore ?? "none");
  say(`   ${bot} tools:`, entryTools(bot), `${other} tools:`, entryTools(other));

  const entry = { url: `${s.base}/mcp`, transport: "streamable-http", headers: { "X-Example": "example-header-value" } };
  say("2. add probe-notes by address");
  say("   without a revision:", await patch({ mcp: { servers: { "probe-notes": entry } } }, { baseHash: null }));
  const stale = start.hash;
  await patch({ mcp: { servers: { "probe-other": { url: `${s.base}/mcp`, transport: "streamable-http" } } } });
  say("   with a revision read before another write:", await patch({ mcp: { servers: { "probe-notes": entry } } }, { baseHash: stale }));
  say("   with the current revision:", await patch({ mcp: { servers: { "probe-notes": entry } } }));
  say("   read back:", (await get()).config.mcp?.servers?.["probe-notes"]);
  say("   the same name again, with another address:", await patch({ mcp: { servers: { "probe-notes": { url: "http://127.0.0.1:9/mcp" } } } }));
  say("   read back:", (await get()).config.mcp?.servers?.["probe-notes"]);
  await patch({ mcp: { servers: { "probe-notes": entry } } });

  say("3. shapes the gateway refuses or accepts");
  say("   an address and a command together:", await patch({ mcp: { servers: { "probe-mixed": { url: `${s.base}/mcp`, command: "/bin/echo" } } } }));
  say("   a client id and secret:", await patch({ mcp: { servers: { "probe-bad": { url: `${s.base}/mcp`, auth: "oauth", oauth: { clientId: "example-id", clientSecret: "example-secret" } } } } }));
  say("   not an address:", await patch({ mcp: { servers: { "probe-bad": { url: "not an address" } } } }));
  say("   an empty command:", await patch({ mcp: { servers: { "probe-empty": { command: "" } } } }));
  say("   a command with no arguments:", await patch({ mcp: { servers: { "probe-cmd": { command: "/nonexistent/example-server", args: [] } } } }));
  say("   read back:", Object.keys((await get()).config.mcp?.servers ?? {}));

  say("4. which bots can use it");
  say(`   before any turn, ${bot}:`, await listing(task, "probe-notes"));
  // The development gateway offers bots only the tools on its allowlist.
  if (allowBefore) say("   gateway allowlist plus probe-notes__*:", await patch({ tools: { allow: [...allowBefore, "probe-notes__*"] } }));
  const denyBefore = entryTools(other).deny;
  say(`   ${other} denied probe-notes__*:`, await patch({ agents: { entries: { [other]: { tools: { deny: [...(denyBefore ?? []), "probe-notes__*"] } } } } }));
  say(`   turn for ${bot}:`, await turn(task));
  say(`   ${bot}'s listing:`, await listing(task, "probe-notes"));
  say(`   turn for ${other}:`, await turn(otherTask));
  say(`   ${other}'s listing:`, await listing(otherTask, "probe-notes"));
  say("   what the stand-in received:", s.seen.map((r) => r.method));
  say("   the header reached it:", s.seen.some((r) => r.headers["x-example"] === "example-header-value"));
  if (allowBefore) {
    say("   only a bot-level allow, gateway allowlist without it:", await patch({ tools: { allow: allowBefore } }, { replacePaths: ["tools.allow"] }));
    const allowEntry = entryTools(bot).allow;
    say(`   ${bot} allow plus probe-notes__*:`, await patch({ agents: { entries: { [bot]: { tools: { allow: [...(allowEntry ?? []), "probe-notes__*"] } } } } }));
    say(`   turn for ${bot}:`, await turn(task));
    say(`   ${bot}'s listing:`, await listing(task, "probe-notes"));
    say(`   ${bot} allow put back:`, allowEntry ? await patch({ agents: { entries: { [bot]: { tools: { allow: allowEntry } } } } }, { replacePaths: [`agents.entries.${bot}.tools.allow`] }) : await patch({ agents: { entries: { [bot]: { tools: { allow: null } } } } }, { replacePaths: [`agents.entries.${bot}.tools.allow`] }));
  }

  say("5. sign-in and sign-out on an OAuth entry");
  say("   add probe-oauth:", await patch({ mcp: { servers: { "probe-oauth": { url: `${s.base}/mcp`, transport: "streamable-http", auth: "oauth" } } } }));
  say("   mcp.authLogin:", await attempt(request, "mcp.authLogin", { sessionId: randomUUID(), serverName: "probe-oauth" }));
  say("   mcp.authLogin, an entry without OAuth:", await attempt(request, "mcp.authLogin", { sessionId: randomUUID(), serverName: "probe-notes" }));
  say("   mcp.authLogout:", await attempt(request, "mcp.authLogout", { serverName: "probe-oauth" }));
  say("   mcp.authLogout, an entry without OAuth:", await attempt(request, "mcp.authLogout", { serverName: "probe-notes" }));
  say("   device.pair.code, a code no browser asked for:", await attempt(request, "device.pair.code", { code: "ABCD-EFGH" }));

  say("6. remove");
  const gone = { "probe-notes": null, "probe-other": null, "probe-oauth": null, "probe-cmd": null, "probe-empty": null, "probe-mixed": null, "probe-bad": null };
  say("   null, no replacePaths:", await patch({ mcp: { servers: gone } }));
  say("   null, with replacePaths for the argument list:", await patch({ mcp: { servers: gone } }, { replacePaths: ["mcp.servers.probe-cmd.args"] }));
  say("   read back:", Object.keys((await get()).config.mcp?.servers ?? {}));
  say(`   ${other} deny put back:`, denyBefore ? await patch({ agents: { entries: { [other]: { tools: { deny: denyBefore } } } } }, { replacePaths: [`agents.entries.${other}.tools.deny`] }) : await patch({ agents: { entries: { [other]: { tools: { deny: null } } } } }, { replacePaths: [`agents.entries.${other}.tools.deny`] }));
  if (allowBefore) say("   gateway allowlist as it was:", JSON.stringify((await get()).config.tools?.allow) === JSON.stringify(allowBefore));
  say(`   turn for ${bot}, then its listing:`, await turn(task), await listing(task, "probe-notes"));

  s.close();
  client.stop();
}

main()
  .catch((error: unknown) => {
    say("probe stopped:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 500));
