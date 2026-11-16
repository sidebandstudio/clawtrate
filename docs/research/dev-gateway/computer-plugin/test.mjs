// Offline tests for the clawtrate-computer prototype. No gateway, no browser,
// no network: the host API, fetch and WebSocket are mocked, and the plugin's
// real register() and handlers run against them.
//
//   node test.mjs              # tests ./index.js
//   node test.mjs <plugin.js>  # tests another copy, e.g. an older version
//
// Covers review items C-01 (tab authority), C-02 (drain fails closed),
// C-03 (lease holder, generation and input serialization), C-05 (CDP
// endpoint confinement) and R3-01, R3-02, R3-03, R3-05 (selector spelling,
// run-scoped call tracking, profile import, host-only routing). Exits 1 if
// any test fails.

import path from "node:path";
import { pathToFileURL } from "node:url";

const pluginFile = path.resolve(process.argv[2] ?? new URL("./index.js", import.meta.url).pathname);

const ATLAS = "http://127.0.0.1:19113";
const PIXEL = "http://127.0.0.1:19114";
const ATLAS_TAB = "A".repeat(32);
const PIXEL_TAB = "B".repeat(32);
const FOREIGN_TAB = "C".repeat(32);
const page = (base, id) => ({ id, type: "page", url: "https://example.com/", title: "Example", webSocketDebuggerUrl: `${base.replace("http", "ws")}/devtools/page/${id}` });

// ---- mocked network ----
let lists = {};
let fetchCalls = [];
let wsLog = [];
let wsOpenDelayMs = 0;
globalThis.fetch = async (url, opts = {}) => {
  fetchCalls.push({ url: String(url), opts });
  const u = new URL(String(url));
  const list = lists[`${u.protocol}//${u.host}`] ?? [];
  return { ok: true, status: 200, json: async () => list };
};
globalThis.WebSocket = class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    wsLog.push({ t: performance.now(), kind: "connect", url });
    setTimeout(() => this.emit("open", {}), wsOpenDelayMs);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type, ev) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  send(raw) {
    const msg = JSON.parse(raw);
    wsLog.push({ t: performance.now(), kind: "send", method: msg.method, url: this.url });
    setTimeout(() => this.emit("message", { data: JSON.stringify({ id: msg.id, result: {} }) }), 1);
  }
  close() {}
};

// ---- mocked host ----
const loaded = [];
async function load(config, hostConfig = { browser: {} }) {
  for (const s of Object.getOwnPropertySymbols(globalThis)) if (String(s).includes("clawtrate-computer")) delete globalThis[s];
  const mod = await import(`${pathToFileURL(pluginFile).href}?t=${Math.random()}`);
  const host = { methods: new Map(), hooks: new Map(), routes: [], services: [] };
  const api = {
    pluginConfig: config,
    config: hostConfig,
    logger: { info() {}, warn() {}, error() {} },
    registerGatewayMethod: (name, handler, opts) => host.methods.set(name, { handler, opts }),
    registerHttpRoute: (route) => host.routes.push(route),
    registerService: (svc) => host.services.push(svc),
    on: (name, fn) => (host.hooks.get(name) ?? host.hooks.set(name, []).get(name)).push(fn),
  };
  mod.default.register(api);
  for (const svc of host.services) svc.start?.({ gatewayEvents: { emit() {} } });
  loaded.push(host);
  return host;
}
function authFor(agentId, sessionKey) {
  return {
    target: { agentId, sessionKey, sessionId: `sid-${sessionKey}` },
    assertCurrent() {},
    retain: () => ({ signal: new AbortController().signal, assertCurrent() {}, release() {} }),
  };
}
async function call(host, method, params, { agentId = "atlas", sessionKey = "agent:atlas:main", connId = "conn-A" } = {}) {
  const entry = host.methods.get(method);
  if (!entry) throw new Error(`no method ${method}`);
  let out;
  await entry.handler({
    params,
    client: { connId },
    sessionAccessAuthority: authFor(agentId, sessionKey),
    respond: (ok, payload, error) => (out = { ok, payload, error }),
  });
  return out ?? { ok: false, error: { message: "no response" } };
}
async function hook(host, name, event, ctx) {
  let result;
  for (const fn of host.hooks.get(name) ?? []) result = (await fn(event, ctx)) ?? result;
  return result;
}
async function upgrade(host, wsPath) {
  const route = host.routes.find((r) => wsPath.startsWith(r.path));
  const socket = { destroyed: false, writableLength: 0, write() {}, end() { this.destroyed = true; }, on() {} };
  await route.handleUpgrade({ url: wsPath, headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } }, socket, Buffer.alloc(0));
}
const baseConfig = (extra = {}) => ({
  cdpUrl: "http://127.0.0.1:19112", // read by the older single-endpoint prototype
  bots: { atlas: { profile: "bot-atlas", cdpUrl: ATLAS }, pixel: { profile: "bot-pixel", cdpUrl: PIXEL } },
  ...extra,
});
function resetNet() {
  lists = {
    [ATLAS]: [page(ATLAS, ATLAS_TAB)],
    [PIXEL]: [page(PIXEL, PIXEL_TAB)],
    "http://127.0.0.1:19112": [page("http://127.0.0.1:19112", ATLAS_TAB), page("http://127.0.0.1:19112", PIXEL_TAB), page("http://127.0.0.1:19112", FOREIGN_TAB)],
  };
  fetchCalls = [];
  wsLog = [];
  wsOpenDelayMs = 0;
}
// The older prototype only serves tabs it saw in a browser result; give it that
// ownership so the C-02 and C-03 tests fail for their own reasons there.
// The current prototype ignores result data, so this is a no-op for it.
const seedLegacyOwnership = (h) =>
  hook(h, "after_tool_call", { toolName: "browser", toolCallId: "seed", result: { details: { targetId: ATLAS_TAB } } }, { agentId: "atlas", sessionKey: "agent:atlas:main" });
const isLoopback = (url) => /^(http|ws):\/\/(127\.0\.0\.1|\[::1\]):\d+\//.test(url);

// ---- tests ----
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

test("C-01a: a tab listing in a tool result does not grant the session other tabs", async () => {
  resetNet();
  const h = await load(baseConfig());
  await hook(h, "after_tool_call", { toolName: "browser", toolCallId: "t1", params: { action: "tabs" }, result: { details: { tabs: [{ targetId: PIXEL_TAB }, { targetId: FOREIGN_TAB }] } } }, { agentId: "atlas", sessionKey: "agent:atlas:main" });
  for (const id of [PIXEL_TAB, FOREIGN_TAB]) {
    const r = await call(h, "clawtrate-computer.view.open", { sessionKey: "agent:atlas:main", targetId: id });
    assert(!r.ok, `view.open for listed tab ${id.slice(0, 4)} was granted`);
  }
});

test("C-01b: a nested, page-controlled targetId in a result grants nothing", async () => {
  resetNet();
  const h = await load(baseConfig());
  await hook(h, "after_tool_call", { toolName: "browser", toolCallId: "t2", params: { action: "act" }, result: { details: { result: { targetId: FOREIGN_TAB } } } }, { agentId: "atlas", sessionKey: "agent:atlas:main" });
  const r = await call(h, "clawtrate-computer.view.open", { sessionKey: "agent:atlas:main", targetId: FOREIGN_TAB });
  assert(!r.ok, "view.open for a nested result id was granted");
});

test("C-01c: one bot's session cannot view or take another bot's tab", async () => {
  resetNet();
  const h = await load(baseConfig());
  const pixelCaller = { agentId: "pixel", sessionKey: "agent:pixel:main" };
  assert(!(await call(h, "clawtrate-computer.view.open", { sessionKey: "agent:pixel:main", targetId: ATLAS_TAB }, pixelCaller)).ok, "pixel viewed atlas's tab");
  assert(!(await call(h, "clawtrate-computer.control.take", { sessionKey: "agent:pixel:main", targetId: ATLAS_TAB }, pixelCaller)).ok, "pixel took atlas's tab");
});

test("C-01d: bot browser calls are pinned to the bot's own profile; others cannot name it", async () => {
  resetNet();
  const h = await load(baseConfig());
  const pinned = await hook(h, "before_tool_call", { toolName: "browser", runId: "run-1", toolCallId: "t3", params: { action: "open", url: "https://example.com", profile: "bot-pixel" } }, { agentId: "atlas" });
  assert(pinned?.params?.profile === "bot-atlas", "atlas's call was not pinned to bot-atlas");
  await hook(h, "after_tool_call", { toolName: "browser", runId: "run-1", toolCallId: "t3" }, { agentId: "atlas" });
  const foreign = await hook(h, "before_tool_call", { toolName: "browser", toolCallId: "t4", params: { action: "snapshot", profile: "bot-atlas" } }, { agentId: "ledger" });
  assert(foreign?.block === true, "an unconfigured agent could name bot-atlas");
  const routed = await hook(h, "before_tool_call", { toolName: "browser", runId: "run-1", toolCallId: "t5", params: { action: "snapshot", target: "node", node: "n1" } }, { agentId: "atlas" });
  assert(routed?.block === true, "node routing was not blocked for a pinned bot");
});

test("control: the bot's own tab is viewable by its session", async () => {
  resetNet();
  const h = await load(baseConfig());
  await seedLegacyOwnership(h);
  const r = await call(h, "clawtrate-computer.view.open", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB });
  assert(r.ok && r.payload.wsPath, `own tab refused: ${r.error?.message}`);
});

test("C-02a: take fails closed when a bot call outlives the drain deadline", async () => {
  resetNet();
  const h = await load(baseConfig({ drainTimeoutMs: 200 }));
  await seedLegacyOwnership(h);
  await hook(h, "before_tool_call", { toolName: "browser", runId: "run-1", toolCallId: "slow-1", params: { action: "act" } }, { agentId: "atlas" });
  const r = await call(h, "clawtrate-computer.control.take", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB });
  assert(r.ok && r.payload.state === "busy", `expected busy, got ${JSON.stringify(r.payload ?? r.error)}`);
  const tabs = await call(h, "clawtrate-computer.tabs", { sessionKey: "agent:atlas:main" });
  assert(tabs.payload.tabs.every((t) => t.lease === null), "a lease remained after a busy take");
  await hook(h, "after_tool_call", { toolName: "browser", runId: "run-1", toolCallId: "slow-1" }, { agentId: "atlas" });
  const again = await call(h, "clawtrate-computer.control.take", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB });
  assert(again.ok && again.payload.state === "granted", "take after the call finished was not granted");
});

test("C-02b: a browser call without a toolCallId or runId is refused, not tracked under a random key", async () => {
  resetNet();
  const h = await load(baseConfig({ drainTimeoutMs: 200 }));
  await seedLegacyOwnership(h);
  const r = await hook(h, "before_tool_call", { toolName: "browser", runId: "run-1", params: { action: "snapshot" } }, { agentId: "atlas" });
  assert(r?.block === true, "untracked call was allowed");
  const noRun = await hook(h, "before_tool_call", { toolName: "browser", toolCallId: "c1", params: { action: "snapshot" } }, { agentId: "atlas" });
  assert(noRun?.block === true, "call without a run id was allowed");
  const take = await call(h, "clawtrate-computer.control.take", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB });
  assert(take.ok && take.payload.state === "granted", "an untracked call left the browser permanently busy");
});

test("C-03a: only the holder can release; a second viewer gets a conflict", async () => {
  resetNet();
  const h = await load(baseConfig());
  await seedLegacyOwnership(h);
  const A = await call(h, "clawtrate-computer.control.take", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB }, { connId: "conn-A" });
  assert(A.ok && A.payload.state === "granted", "A could not take");
  const B = { connId: "conn-B" };
  for (const generation of [undefined, A.payload.generation]) {
    const rel = await call(h, "clawtrate-computer.control.release", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB, generation }, B);
    assert(!rel.ok, `viewer B released A's lease (generation ${generation ? "known" : "absent"})`);
  }
  const take = await call(h, "clawtrate-computer.control.take", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB }, B);
  assert(!take.ok, "viewer B took a held lease");
  const wrongGen = await call(h, "clawtrate-computer.input", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB, kind: "click", x: 1, y: 1, generation: "nope" }, { connId: "conn-A" });
  assert(!wrongGen.ok, "input with a wrong generation was accepted");
});

test("C-03b: input admitted under a lease cannot land under a replacement lease", async () => {
  resetNet();
  const h = await load(baseConfig());
  await seedLegacyOwnership(h);
  const A = await call(h, "clawtrate-computer.control.take", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB }, { connId: "conn-A" });
  wsLog = [];
  wsOpenDelayMs = 150; // CDP connect is slow
  const pendingInput = call(h, "clawtrate-computer.input", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB, kind: "click", x: 5, y: 5, generation: A.payload.generation }, { connId: "conn-A" });
  await new Promise((r) => setTimeout(r, 10));
  await call(h, "clawtrate-computer.control.release", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB, generation: A.payload.generation }, { connId: "conn-A" });
  const B = await call(h, "clawtrate-computer.control.take", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB }, { connId: "conn-B" });
  const grantedB = performance.now();
  await pendingInput;
  const inputs = wsLog.filter((e) => e.kind === "send" && e.method?.startsWith("Input."));
  assert(B.ok && B.payload.state === "granted", "B could not take after A released");
  assert(inputs.every((e) => e.t < grantedB), "A's input was dispatched after B was granted control");
});

test("C-05a: a non-loopback cdpUrl is rejected and never contacted", async () => {
  resetNet();
  let threw = false;
  let h;
  try {
    h = await load({ cdpUrl: "http://example.invalid:9222", bots: { atlas: { profile: "bot-atlas", cdpUrl: "http://example.invalid:9222" } } });
  } catch {
    threw = true;
  }
  if (!threw) await call(h, "clawtrate-computer.tabs", { sessionKey: "agent:atlas:main" });
  assert(fetchCalls.every((c) => isLoopback(c.url)), `contacted ${fetchCalls.map((c) => c.url).join(", ")}`);
  assert(threw, "configuration with a non-loopback cdpUrl was accepted");
});

test("C-05b: CDP discovery refuses redirects", async () => {
  resetNet();
  const h = await load(baseConfig());
  await call(h, "clawtrate-computer.tabs", { sessionKey: "agent:atlas:main" });
  assert(fetchCalls.length > 0 && fetchCalls.every((c) => c.opts?.redirect === "error"), "fetch was made without redirect: \"error\"");
});

test("C-05c: a debugger URL on another host or port is never connected", async () => {
  resetNet();
  const h = await load(baseConfig());
  const evil = { id: FOREIGN_TAB, type: "page", url: "https://example.com/", title: "x", webSocketDebuggerUrl: `ws://evil.invalid:9222/devtools/page/${FOREIGN_TAB}` };
  lists[ATLAS] = [evil];
  lists["http://127.0.0.1:19112"] = [evil];
  // The older prototype needs ownership first; give it the strongest form it accepts.
  await hook(h, "after_tool_call", { toolName: "browser", toolCallId: "t6", result: { details: { targetId: FOREIGN_TAB } } }, { agentId: "atlas", sessionKey: "agent:atlas:main" });
  const v = await call(h, "clawtrate-computer.view.open", { sessionKey: "agent:atlas:main", targetId: FOREIGN_TAB });
  if (v.ok) await upgrade(h, v.payload.wsPath);
  await new Promise((r) => setTimeout(r, 20));
  assert(wsLog.every((e) => isLoopback(e.url)), `connected to ${wsLog.map((e) => e.url).join(", ")}`);
});

const before = (h, agentId, runId, toolCallId, params) => hook(h, "before_tool_call", { toolName: "browser", runId, toolCallId, params }, { agentId, runId });
const after = (h, agentId, runId, toolCallId) => hook(h, "after_tool_call", { toolName: "browser", runId, toolCallId }, { agentId, runId });
const take = (h) => call(h, "clawtrate-computer.control.take", { sessionKey: "agent:atlas:main", targetId: ATLAS_TAB });

test("R3-01a: an unconfigured agent cannot reach a bot profile by padding its name", async () => {
  resetNet();
  const h = await load(baseConfig());
  for (const profile of [" bot-atlas ", "bot-atlas\n", "\tbot-pixel"]) {
    const r = await before(h, "ledger", "run-l", "c1", { action: "snapshot", profile });
    assert(r?.block === true, `profile ${JSON.stringify(profile)} was allowed`);
  }
  const plain = await before(h, "ledger", "run-l", "c2", { action: "snapshot" });
  assert(!plain?.block, "an unconfigured agent on the shared default profile was blocked");
});

test("R3-01b: a bot profile as browser.defaultProfile is rejected, so omitted profiles cannot land there", async () => {
  resetNet();
  let threw = false;
  try {
    await load(baseConfig(), { browser: { defaultProfile: " bot-atlas " } });
  } catch {
    threw = true;
  }
  assert(threw, "plugin accepted a bot profile as the browser default");
});

test("R3-01c: a configured bot's padded or foreign profile is rewritten to its own", async () => {
  resetNet();
  const h = await load(baseConfig());
  const r = await before(h, "atlas", "run-a", "c1", { action: " open ", url: "https://example.com", profile: " bot-pixel " });
  assert(r?.params?.profile === "bot-atlas" && r.params.action === "open", `got ${JSON.stringify(r)}`);
});

test("R3-02a: two runs with the same call id are tracked separately, across bots", async () => {
  resetNet();
  const h = await load(baseConfig({ drainTimeoutMs: 200 }));
  await before(h, "atlas", "run-atlas", "call_1", { action: "act" });
  await before(h, "pixel", "run-pixel", "call_1", { action: "act" });
  await after(h, "pixel", "run-pixel", "call_1");
  const r = await take(h);
  assert(r.ok && r.payload.state === "busy", `Atlas's running call was forgotten: ${JSON.stringify(r.payload ?? r.error)}`);
});

test("R3-02b: two runs of the same bot with the same call id are tracked separately", async () => {
  resetNet();
  const h = await load(baseConfig({ drainTimeoutMs: 200 }));
  await before(h, "atlas", "run-a", "call_1", { action: "act" });
  await before(h, "atlas", "run-b", "call_1", { action: "act" });
  await after(h, "atlas", "run-b", "call_1");
  const r = await take(h);
  assert(r.ok && r.payload.state === "busy", "completing one run released the other run's call");
  await after(h, "atlas", "run-a", "call_1");
  const again = await take(h);
  assert(again.ok && again.payload.state === "granted", "take not granted after both calls finished");
});

test("R3-02c: another agent's completion with the same ids does not clear a bot's call", async () => {
  resetNet();
  const h = await load(baseConfig({ drainTimeoutMs: 200 }));
  await before(h, "atlas", "run-x", "call_1", { action: "act" });
  await after(h, "ledger", "run-x", "call_1");
  const r = await take(h);
  assert(r.ok && r.payload.state === "busy", "an unconfigured agent's after hook cleared Atlas's call");
});

test("R3-03: importprofile cannot write into a bot's browser", async () => {
  resetNet();
  const h = await load(baseConfig());
  for (const params of [{ action: "importprofile", into: "bot-pixel" }, { action: "importprofile" }, { action: " importprofile " }]) {
    const r = await before(h, "atlas", "run-a", "c1", params);
    assert(r?.block === true, `bot import allowed: ${JSON.stringify(params)}`);
  }
  for (const into of ["bot-atlas", " bot-atlas ", "bot-pixel"]) {
    const r = await before(h, "ledger", "run-l", "c1", { action: "importprofile", into });
    assert(r?.block === true, `unconfigured import into ${JSON.stringify(into)} allowed`);
  }
  const elsewhere = await before(h, "ledger", "run-l", "c2", { action: "importprofile", into: "scratch" });
  assert(!elsewhere?.block, "an unconfigured import into a non-bot profile was blocked");
});

test("R3-03b: only tab actions are available to a bot", async () => {
  resetNet();
  const h = await load(baseConfig());
  for (const action of ["profiles", "stop", "download", "upload", "doctor", undefined]) {
    const r = await before(h, "atlas", "run-a", "c1", { action });
    assert(r?.block === true, `action ${action} was allowed for a bot`);
  }
});

test("R3-05: a bot's calls are pinned to the host browser; node and sandbox routing are refused", async () => {
  resetNet();
  const h = await load(baseConfig());
  const omitted = await before(h, "atlas", "run-a", "c1", { action: "open", url: "https://example.com" });
  assert(omitted?.params?.target === "host", `target not pinned: ${JSON.stringify(omitted?.params)}`);
  await after(h, "atlas", "run-a", "c1");
  const host = await before(h, "atlas", "run-a", "c2", { action: "tabs", target: " host " });
  assert(host?.params?.target === "host" && !host.block, "explicit host target was not accepted");
  await after(h, "atlas", "run-a", "c2");
  for (const params of [{ action: "tabs", target: "sandbox" }, { action: "tabs", target: "node" }, { action: "tabs", node: "n1" }, { action: "tabs", dashboard: "w1" }]) {
    const r = await before(h, "atlas", "run-a", "c3", params);
    assert(r?.block === true, `routing allowed: ${JSON.stringify(params)}`);
  }
});

let failed = 0;
console.log(`testing ${path.basename(path.dirname(pluginFile))}/${path.basename(pluginFile)}`);
for (const t of tests) {
  try {
    await t.fn();
    console.log(`PASS  ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${t.name}\n      ${e.message}`);
  }
}
for (const h of loaded) for (const svc of h.services) svc.stop?.();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
