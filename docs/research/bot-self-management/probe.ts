// Probes behind docs/research/bot-self-management.md. Research code, not a check.
//
//   cp -R docs/research/bot-self-management/probe-plugin plugins/clawtrate-bots-probe
//   pnpm dev-gateway start --instance <name> --with-plugin clawtrate-bots-probe
//   node docs/research/bot-self-management/probe.ts --instance <name> [--provider <port>]
//   pnpm dev-gateway reset --instance <name>; rm -r plugins/clawtrate-bots-probe
//
// The probe needs three scripted scenarios that are not on main: `#probe-self`
// calls `clawtrate_probe_self` with a new name for the calling bot,
// `#probe-other` with a new name for Otto, and `#probe-writes` with
// `writes: true`. The research note gives them.
//
// It acts only on a named development instance this checkout started, through
// the tool's own operator client (a new paired device per connection,
// approved by request id through the tool's guarded runner). It never prints
// a token or a grant.

import { parseArgs } from "node:util";
import { openInstance } from "../../../tools/dev-gateway/src/cli.ts";
import { provenEndpoint } from "../../../tools/dev-gateway/src/endpoint.ts";
import { readRunRecord } from "../../../tools/dev-gateway/src/state-guard.ts";
import { OperatorSession } from "../../../tools/dev-gateway/src/operator.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { instance: { type: "string" }, provider: { type: "string" } },
});
if (!values.instance) throw new Error("--instance <name> is required");
const inst = openInstance(values.instance);
const initialRun = readRunRecord(inst.runFile);

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === "object" ? (v as Rec) : {});
const READ = ["operator.read"];
const WRITE = ["operator.read", "operator.write"];
const ADMIN = ["operator.read", "operator.write", "operator.admin"];
const opened: OperatorSession[] = [];
const PLUGIN = "clawtrate-bots-probe";

function endpoint() {
  const proof = provenEndpoint({
    instance: inst.name,
    home: inst.home,
    runDir: inst.runDir,
    checkout: inst.checkout,
  });
  if ("refusal" in proof) throw new Error(proof.refusal);
  if (!initialRun || readRunRecord(inst.runFile)?.runId !== initialRun.runId)
    throw new Error("The named instance restarted during the probe");
  return proof;
}

async function cli(args: string[]): Promise<string> {
  endpoint();
  const result = await inst.runner.run(args);
  if (result.status !== 0) throw new Error(`gateway command failed: ${args[0]} ${args[1]}`);
  return result.stdout;
}

async function connect(name: string, scopes: string[]): Promise<OperatorSession> {
  const { url, token } = endpoint();
  const op = await OperatorSession.open({
    url,
    token,
    scopes,
    caps: ["tool-events"],
    displayName: `Clawtrate bots probe ${name}`,
    approvePairing: async (requestId) => {
      await cli(["devices", "approve", requestId]);
    },
  });
  opened.push(op);
  return op;
}

async function call(op: OperatorSession, method: string, params: unknown = {}) {
  try {
    return { ok: true, value: rec(await op.request(method, params)) };
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error).slice(0, 300) };
  }
}

async function names(op: OperatorSession): Promise<Rec> {
  const list = rec(await op.request("agents.list", {}));
  const agents = Array.isArray(list.agents) ? (list.agents as Rec[]) : [];
  return Object.fromEntries(agents.map((a) => [a.id, rec(a.identity).name ?? a.name ?? null]));
}

async function turn(op: OperatorSession, key: string, message: string): Promise<void> {
  await op.request("sessions.messages.subscribe", { key });
  const sent = await op.send(key, message);
  const runId = String(sent.runId ?? "");
  if (runId) await op.terminal(runId);
}

async function lastRecord(op: OperatorSession): Promise<Rec | null> {
  const out = rec(await op.request(`${PLUGIN}.results`, {}));
  const list = Array.isArray(out.records) ? (out.records as Rec[]) : [];
  return list.at(-1) ?? null;
}

async function offered(key: string): Promise<unknown> {
  if (!values.provider) return "(no --provider port given)";
  const res = await fetch(
    `http://127.0.0.1:${values.provider}/scripted/offered-tools?session=${encodeURIComponent(key)}`,
  );
  return rec(await res.json()).tools;
}

async function patch(admin: OperatorSession, body: Rec): Promise<void> {
  const before = rec(await admin.request("config.get", {}));
  const out = rec(
    await admin.request("config.patch", { raw: JSON.stringify(body), baseHash: before.hash }),
  );
  if (out.ok !== true) throw new Error(`config.patch refused: ${JSON.stringify(out)}`);
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const now = rec(await admin.request("config.get", {}).catch(() => ({})));
    if (now.configRevisionHash !== before.configRevisionHash && now.appliedConfigHash === now.configRevisionHash) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("patched config not applied within 30 s");
}

const show = (label: string, value: unknown) =>
  console.log(`\n## ${label}\n${JSON.stringify(value, null, 2)}`);

async function main(): Promise<void> {
  const admin = await connect("admin", ADMIN);
  const writer = await connect("write", WRITE);
  const reader = await connect("read", READ);
  show("roster before", await names(admin));

  // 1. A bot renames itself in a turn an admin operator started.
  await turn(admin, "agent:marlow:probe-admin", "#probe-self");
  show("1. marlow, turn sent by an admin device", await lastRecord(admin));
  show("   offered tools", await offered("agent:marlow:probe-admin"));
  show("   roster after 1", await names(admin));

  // 2. The same, in a turn a write-only device started.
  await turn(writer, "agent:pip:probe-write", "#probe-self");
  show("2. pip, turn sent by a write device", await lastRecord(admin));
  show("   roster after 2", await names(admin));

  // 3. A bot renames another bot, in an admin's turn.
  await turn(admin, "agent:pip:probe-other", "#probe-other");
  show("3. pip renames otto, turn sent by an admin device", await lastRecord(admin));
  show("   roster after 3", await names(admin));

  // 3b. The other writes (label, a file, a new bot) in an admin's turn.
  await turn(admin, "agent:marlow:probe-writes", "#probe-writes");
  show("3b. marlow writes label, SOUL.md and creates a bot, admin turn", rec(await lastRecord(admin)).writes);
  const cfg3 = rec(await admin.request("config.get", {}));
  const marlow = rec(rec(rec(rec(rec(cfg3.config).agents).entries).marlow).identity);
  show("   read back: marlow identity.theme", marlow.theme ?? null);
  show("   read back: SOUL.md", rec(rec(await admin.request("agents.files.get", { agentId: "marlow", name: "SOUL.md" })).file).content ?? null);
  show("   roster after 3b", await names(admin));

  // 4. A per-bot deny keeps the tool from the model.
  await patch(admin, { agents: { entries: { main: { tools: { deny: ["clawtrate_probe_self"] } } } } }).catch(
    (e) => show("4. patch failed", String(e)),
  );
  const before4 = (await lastRecord(admin))?.at;
  await turn(admin, "agent:main:probe-denied", "#probe-self");
  show("4. main with the tool denied: offered", await offered("agent:main:probe-denied"));
  show("   a new record?", (await lastRecord(admin))?.at !== before4);

  // 5. Caller-scoped dispatch from a plugin RPC method registered at read.
  show("5a. update via plugin RPC, read device", await call(reader, `${PLUGIN}.update`, { agentId: "otto", name: "Otto R" }));
  show("5b. update via plugin RPC, write device", await call(writer, `${PLUGIN}.update`, { agentId: "otto", name: "Otto W" }));
  show("5c. update via plugin RPC, admin device", await call(admin, `${PLUGIN}.update`, { agentId: "otto", name: "Otto A" }));
  show("   roster after 5", await names(admin));

  // 6. A completion with no tools, from an admin RPC method.
  show("6a. describe, default agent", await call(admin, `${PLUGIN}.describe`, { words: "a sleepy lantern" }));
  show("6b. describe for marlow, no override allowed", await call(admin, `${PLUGIN}.describe`, { words: "a sleepy lantern", agentId: "marlow" }));
  await patch(admin, { plugins: { entries: { [PLUGIN]: { llm: { allowAgentIdOverride: true } } } } }).catch(
    (e) => show("6. llm patch failed", String(e)),
  );
  show("6c. describe for marlow, override allowed", await call(admin, `${PLUGIN}.describe`, { words: "a sleepy lantern", agentId: "marlow" }));
  show("6d. describe from a write device", await call(writer, `${PLUGIN}.describe`, { words: "x" }));

  // 7. Plugin state.
  show("7. state", await call(admin, `${PLUGIN}.state`, {}));

  // 8. The gateway's own MCP surface: an attach grant for one of pip's sessions.
  const grant = await call(admin, "attach.grant", { sessionKey: "agent:pip:probe-mcp", ttlMs: 120_000 });
  show("8a. attach.grant from a write device", await call(writer, "attach.grant", { sessionKey: "agent:pip:probe-mcp" }));
  if (grant.ok) {
    const g = rec(grant.value);
    const server = rec(rec(rec(g.mcpConfig).mcpServers).openclaw);
    show("8b. attach grant shape", { keys: Object.keys(g).sort(), url: server.url, expiresAtMs: g.expiresAtMs, sessionKey: g.sessionKey });
    const mcp = async (body: Rec) => {
      const res = await fetch(String(server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${String(g.token)}`,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      const json = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5);
      try {
        return { status: res.status, body: JSON.parse(json) };
      } catch {
        return { status: res.status, body: text.slice(0, 300) };
      }
    };
    await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } });
    const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = (rec(rec(tools.body).result).tools as Rec[] | undefined)?.map((t) => t.name) ?? tools;
    show("8c. MCP tools/list over the attach grant", listed);
    const called = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "clawtrate_probe_self", arguments: { name: "MCP Renamed" } } });
    show("8d. MCP tools/call clawtrate_probe_self", { status: called.status, record: await lastRecord(admin) });
    show("   roster after 8", await names(admin));
    show("8e. attach.revoke", await call(admin, "attach.revoke", { token: g.token }));
    const after = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    show("8f. tools/list after revoke", { status: after.status });
  } else show("8. attach.grant (admin)", grant);
}

try {
  await main();
} finally {
  for (const op of opened) {
    await cli(["devices", "remove", op.deviceId]).catch(() => {});
    await op.close().catch(() => {});
  }
}
