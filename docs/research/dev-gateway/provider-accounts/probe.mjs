// Provider-account probe for docs/research/provider-accounts-and-t3-code.md.
// Research code: it prints what it saw and asserts nothing about the gateway.
//
//   pnpm dev-gateway start --instance <name> --no-seed
//   CLAWTRATE_DEV_INSTANCE=<name> node docs/research/dev-gateway/provider-accounts/probe.mjs
//   pnpm dev-gateway reset --instance <name>
//
// It runs only against a named development instance that this checkout started:
//   - CLAWTRATE_DEV_INSTANCE must be a valid instance name other than the default;
//   - the endpoint and token come from this checkout's run folder for that instance,
//     whose run id must match the instance state folder's marker;
//   - the endpoint must be ws://127.0.0.1:<port> with the port in 19200-19999;
//   - after connecting, the gateway must report 2026.10.6.
// It starts three recording model servers (recording-model.mjs) on the
// instance's scripted-model port + 1, + 2 and + 3, inside the instance's block,
// and stops them by PID at the end. Every provider it configures points at one
// of them or at the instance's own scripted model. No real provider is used.
// It pairs its own device and approves it with `pnpm dev-gateway approve`.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(here, "../../../..");
const name = process.env.CLAWTRATE_DEV_INSTANCE ?? "";
if (!/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(name) || name.includes("--") || ["default", "dev"].includes(name)) {
  console.error("Set CLAWTRATE_DEV_INSTANCE to a named development instance started from this checkout.");
  process.exit(2);
}
const runDir = path.join(checkout, "tools/dev-gateway/.run/instances", name);
const stateDir = path.join(homedir(), `.openclaw-clawtrate-dev-${name}`);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const refuse = (why) => {
  console.error(`probe refuses this target: ${why}`);
  process.exit(2);
};
if (!existsSync(path.join(runDir, "connection.json")) || !existsSync(path.join(runDir, "state.json"))) refuse("no run files for this instance in this checkout");
if (!existsSync(stateDir) || lstatSync(stateDir).isSymbolicLink()) refuse("instance state folder missing or a link");
const connection = readJson(path.join(runDir, "connection.json"));
const runState = readJson(path.join(runDir, "state.json"));
const marker = readJson(path.join(stateDir, ".clawtrate-dev-gateway"));
if (connection.instance !== name || runState.instance !== name || marker.instance !== name) refuse("instance names disagree");
if (connection.runId !== runState.runId || marker.runId !== runState.runId) refuse("run ids disagree");
const url = new URL(connection.url);
const gatewayPort = Number(url.port);
if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || gatewayPort < 19200 || gatewayPort > 19999 || gatewayPort !== runState.gatewayPort) refuse("endpoint is not this named instance");
const scriptedPort = runState.providerPort;
const recPorts = [scriptedPort + 1, scriptedPort + 2, scriptedPort + 3];
if (recPorts.some((p) => p >= gatewayPort + 20)) refuse("recording ports would leave the instance's block");

const require = createRequire(path.join(checkout, "packages/core/package.json"));
const { GatewayClient } = await import(pathToFileURL(require.resolve("@openclaw/gateway-client")).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (label, value) => console.log(`\n## ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);

// ---- recording model servers -------------------------------------------------
const logDir = mkdtempSync(path.join(tmpdir(), "clawtrate-accounts-probe-"));
const recLog = path.join(logDir, "requests.jsonl");
const children = [];
for (const [i, port] of recPorts.entries()) {
  const label = ["acct-a", "acct-b", "acct-x"][i];
  const child = spawn(process.execPath, [path.join(here, "recording-model.mjs"), "--port", String(port), "--label", label, "--log", recLog], { stdio: "ignore" });
  children.push(child);
}
const stopChildren = () => {
  for (const child of children) if (child.pid && child.exitCode === null) process.kill(child.pid, "SIGTERM");
};
process.on("exit", stopChildren);
const requests = () => (existsSync(recLog) ? readFileSync(recLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---- gateway client ----------------------------------------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const deviceIdentity = {
  deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
  publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
};
const tokens = {};
const events = [];
const waiters = new Set();

function connectOnce(scopes) {
  return new Promise((resolve, reject) => {
    const client = new GatewayClient({
      url: connection.url,
      token: connection.token,
      clientName: "gateway-client",
      mode: "ui",
      clientDisplayName: "Clawtrate probe accounts",
      clientVersion: "0.0.1",
      platform: process.platform,
      role: "operator",
      scopes,
      caps: ["tool-events"],
      minProtocol: 4,
      maxProtocol: 4,
      deviceIdentity,
      hostDeps: {
        signDevicePayload: (pem, payload) => crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(pem)).toString("base64url"),
        publicKeyRawBase64UrlFromPem: (pem) => crypto.createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
        loadDeviceAuthToken: ({ deviceId, role }) => tokens[`${deviceId}:${role}`],
        storeDeviceAuthToken: (rec) => (tokens[`${rec.deviceId}:${rec.role}`] = rec),
        clearDeviceAuthToken: ({ deviceId, role }) => delete tokens[`${deviceId}:${role}`],
      },
      onEvent: (e) => {
        const rec = { t: Date.now(), event: e.event, payload: e.payload };
        events.push(rec);
        for (const w of waiters) w(rec);
      },
      onHelloOk: (hello) => resolve({ client, hello }),
      onConnectError: (err) => {
        reject(err);
        client.stopAndWait().catch(() => {});
      },
    });
    client.start();
  });
}

async function connect(scopes) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await connectOnce(scopes);
    } catch (err) {
      const text = `${err?.message ?? err} ${JSON.stringify(err?.details ?? err?.data ?? {})}`;
      if (!/pair/i.test(text)) throw err;
      spawnSync("pnpm", ["dev-gateway", "approve", "--instance", name], { cwd: checkout, stdio: "ignore" });
      await sleep(1000);
    }
  }
  throw new Error("pairing was not approved");
}

const { client, hello } = await connect(["operator.read", "operator.write", "operator.admin"]);
if (hello?.server?.version !== "2026.10.6") refuse(`gateway reports ${hello?.server?.version}`);
const call = (method, params = {}, timeoutMs = 60_000) => client.request(method, params, { timeoutMs });
const waitFor = (pred, timeoutMs = 90_000) =>
  new Promise((res, rej) => {
    const hit = events.find(pred);
    if (hit) return res(hit);
    const t = setTimeout(() => (waiters.delete(w), rej(new Error(`timed out after ${timeoutMs} ms`))), timeoutMs);
    const w = (rec) => {
      if (pred(rec)) {
        clearTimeout(t);
        waiters.delete(w);
        res(rec);
      }
    };
    waiters.add(w);
  });
async function send(sessionKey, message) {
  const before = requests().length;
  const r = await call("chat.send", { sessionKey, message, idempotencyKey: crypto.randomUUID() });
  const done = await waitFor((e) => e.event === "chat" && e.payload?.runId === r.runId && ["final", "aborted", "error"].includes(e.payload?.state));
  const model = events.find((e) => e.event === "agent" && e.payload?.runId === r.runId && e.payload?.stream === "lifecycle" && e.payload?.data?.phase === "model");
  const lifecycleEnd = events.filter((e) => e.event === "agent" && e.payload?.runId === r.runId && e.payload?.stream === "lifecycle" && e.payload?.data?.phase !== "model" && e.payload?.data?.phase !== "start");
  const { message: _m, ...terminal } = done.payload;
  return {
    sessionKey,
    terminal,
    lifecycleModel: model?.payload?.data,
    lifecycleOther: lifecycleEnd.map((e) => e.payload.data),
    reached: requests().slice(before),
  };
}
async function patchConfig(patch) {
  const { hash } = await call("config.get", {});
  return call("config.patch", { raw: JSON.stringify(patch), baseHash: hash });
}
const provider = (port, apiKey) => ({
  baseUrl: `http://127.0.0.1:${port}/v1`,
  api: "openai-completions",
  ...(apiKey ? { apiKey } : {}),
  models: [{ id: "dev-1", name: "Scripted dev model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
});
const authStatus = async (agentId) => {
  const s = await call("models.authStatus", { agentId });
  return s.providers.map((p) => ({ provider: p.provider, status: p.status, apiKey: p.apiKey, profileOrder: p.profileOrder, profiles: p.profiles }));
};

try {
  show("hello", { version: hello.server?.version, scopes: hello.auth?.scopes });

  // 1. Three provider entries, each one account: two with a key in config, one with none.
  const fixture = {
    models: {
      providers: {
        "acct-a": provider(recPorts[0], "scripted-key-a"),
        "acct-b": provider(recPorts[1], "scripted-key-b"),
        "acct-x": provider(recPorts[2]),
      },
    },
  };
  show("config.patch fixture", fixture);
  await patchConfig(fixture);
  await sleep(1500);
  const bots = [["probe-a", "acct-a/dev-1"], ["probe-b", "acct-b/dev-1"], ["probe-x1", "acct-x/dev-1"], ["probe-x2", "acct-x/dev-1"], ["probe-fb", "acct-b/dev-1"]];
  for (const [id, model] of bots) await call("agents.create", { name: id, workspace: path.join(stateDir, `workspace-${id}`), model });
  show("agents.list model fields", (await call("agents.list", {})).agents.map((a) => ({ id: a.id, model: a.model })));
  for (const path_ of ["agents.entries", "auth.order", "auth.profiles"]) {
    try {
      const r = await call("config.schema.lookup", { path: path_ });
      show(`config.schema.lookup ${path_}`, { path: r.path, type: r.schema?.type, children: (r.children ?? []).map((c) => c.key ?? c.path).slice(0, 80) });
    } catch (err) {
      show(`config.schema.lookup ${path_} failed`, String(err?.message ?? err));
    }
  }

  // 2. Same provider, one API key per bot through models.authSetApiKey {agentId}.
  for (const [agentId, apiKey] of [["probe-x1", "scripted-key-x1"], ["probe-x2", "scripted-key-x2"]]) show(`models.authSetApiKey ${agentId}`, await call("models.authSetApiKey", { provider: "acct-x", apiKey, agentId }));
  const cfgAfterKeys = await call("config.get", {});
  show("config after authSetApiKey", { acctXApiKey: cfgAfterKeys.config?.models?.providers?.["acct-x"]?.apiKey, auth: cfgAfterKeys.config?.auth });
  for (const agentId of ["probe-x1", "probe-x2"]) show(`models.authStatus ${agentId} acct-x`, (await authStatus(agentId)).filter((p) => p.provider === "acct-x"));
  try {
    show("models.authOrderSet acct-x probe-x1", await call("models.authOrderSet", { provider: "acct-x", profileIds: ["acct-x:manual"], agentId: "probe-x1" }));
  } catch (err) {
    show("models.authOrderSet acct-x probe-x1 refused", String(err?.message ?? err));
  }

  // 3. Which server and key each bot's run reached.
  for (const agentId of ["main", "probe-a", "probe-b", "probe-x1", "probe-x2"]) show(`run ${agentId}`, await send(`agent:${agentId}:probe`, "Which account answers?"));
  for (const agentId of ["probe-a", "probe-x1"]) {
    const m = await call("models.list", { agentId });
    show(`models.list ${agentId}`, { models: m.models.map((x) => `${x.provider}/${x.id} available=${x.available}`), accountSelection: m.accountSelection });
  }

  // 3b. A tool server for one bot: global mcp.servers entry, denied on another bot by glob.
  const standIn = path.resolve(here, "../fake-coding-mcp.mjs");
  await patchConfig({ mcp: { servers: { t3stand: { command: process.execPath, args: [standIn] } } }, agents: { entries: { "probe-b": { tools: { deny: ["t3stand__*"] } } } } });
  await sleep(1500);
  await call("agents.create", { name: "probe-new", workspace: path.join(stateDir, "workspace-probe-new"), model: "acct-a/dev-1" });
  for (const agentId of ["probe-a", "probe-b", "probe-new"]) {
    const r = await send(`agent:${agentId}:tools`, "Which tools do you have?");
    show(`tool-server tools offered to ${agentId}`, r.reached.map((x) => x.serverTools));
  }


  // 4. Change a bot's account while its run is in progress.
  const slow = call("chat.send", { sessionKey: "agent:probe-a:switch", message: "SLOW first", idempotencyKey: crypto.randomUUID() });
  const slowRun = await slow;
  await sleep(1200);
  await call("agents.update", { agentId: "probe-a", model: "acct-b/dev-1" });
  const slowDone = await waitFor((e) => e.event === "chat" && e.payload?.runId === slowRun.runId && ["final", "aborted", "error"].includes(e.payload?.state));
  show("run in progress when probe-a moved to acct-b", { state: slowDone.payload.state, reached: requests().filter((r) => r.marker === "SLOW") });
  show("next run of probe-a", await send("agent:probe-a:switch", "Which account answers after the change?"));
  const switchHistory = await call("chat.history", { sessionKey: "agent:probe-a:switch", limit: 20 });
  show("probe-a:switch history roles and system text", (switchHistory.messages ?? []).map((m) => ({ role: m.role, provider: m.provider, model: m.model, text: m.role === "assistant" ? undefined : String(typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("")).slice(0, 80) })));
  await call("agents.update", { agentId: "probe-a", model: "acct-a/dev-1" });

  // 5. Errors on a bot with a plain model string (no fallbacks of its own).
  show("run probe-b FAIL401", await send("agent:probe-b:errors-401", "FAIL401 please"));
  show("run probe-a FAIL402", await send("agent:probe-a:errors-402", "FAIL402 please"));
  show("authStatus after errors", (await authStatus("probe-a")).filter((p) => ["acct-a", "acct-b"].includes(p.provider)));
  show("run probe-a again after its 402", await send("agent:probe-a:errors-402", "Try again"));

  // 6. A bot whose model has a fallback on another account.
  await patchConfig({ agents: { entries: { "probe-fb": { model: { primary: "acct-b/dev-1", fallbacks: ["acct-x/dev-1"] } } } } });
  await sleep(1500);
  show("agents.list probe-fb model", (await call("agents.list", {})).agents.find((a) => a.id === "probe-fb")?.model);
  show("run probe-fb FAIL401 (primary acct-b, fallback acct-x)", await send("agent:probe-fb:fallback", "FAIL401 fallback test"));

  // 7. Remove one bot's account and run both bots that used that provider.
  show("models.authLogout acct-x for probe-x2", await call("models.authLogout", { provider: "acct-x", agentId: "probe-x2" }));
  show("models.authStatus probe-x1 after logout", (await authStatus("probe-x1")).filter((p) => p.provider === "acct-x"));
  show("config after logout", { acctXApiKey: (await call("config.get", {})).config?.models?.providers?.["acct-x"]?.apiKey ?? null });
  show("run probe-x2 after logout", await send("agent:probe-x2:probe", "Which account answers now?"));
  show("run probe-x1 after probe-x2's logout", await send("agent:probe-x1:probe", "Which account answers now?"));

  // 8. What a client can read back about keys, and what a turn records.
  const cfg = await call("config.get", {});
  show("config.get providers apiKey fields", Object.fromEntries(Object.entries(cfg.config?.models?.providers ?? {}).map(([k, v]) => [k, v.apiKey ?? null])));
  const history = await call("chat.history", { sessionKey: "agent:probe-b:probe", limit: 10 });
  const last = (history.messages ?? []).filter((m) => m.role === "assistant").at(-1);
  show("chat.history last assistant row (probe-b)", { keys: Object.keys(last ?? {}), provider: last?.provider, model: last?.model, openclawKeys: Object.keys(last?.__openclaw ?? {}) });
  const sessions = await call("sessions.list", { limit: 50 });
  const row = (sessions.sessions ?? []).find((s) => s.key === "agent:probe-b:probe");
  show("sessions.list row fields about auth or model (probe-b)", Object.fromEntries(Object.entries(row ?? {}).filter(([k]) => /auth|model|provider|account/i.test(k))));
  show("all recorded requests", requests());
} finally {
  await client.stopAndWait().catch(() => {});
  stopChildren();
}
