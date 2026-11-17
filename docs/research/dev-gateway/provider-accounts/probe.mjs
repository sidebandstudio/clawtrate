// Provider-account probe for docs/research/provider-accounts-and-t3-code.md.
// Research code: it prints what it saw and checks the facts the document states
// from it, exiting 1 if any check fails.
//
//   pnpm dev-gateway start --instance <name> --no-seed
//   CLAWTRATE_DEV_INSTANCE=<name> node docs/research/dev-gateway/provider-accounts/probe.mjs
//   pnpm dev-gateway stop --instance <name> && pnpm dev-gateway reset --instance <name>
//
// The target check is instance-guard.mjs: a named instance this checkout started,
// whose recorded gateway is still running; after connecting, the gateway must
// report 2026.10.6. It starts three recording model servers (recording-model.mjs)
// on the instance's scripted-model port + 1, + 2 and + 3, inside the instance's
// block, waits until each listens, and stops them by PID at the end. Every
// provider it configures points at one of them or at the instance's own scripted
// model. No real provider is used. It pairs its own device and approves it with
// `pnpm dev-gateway approve --instance <name>`. It changes the instance's config,
// bots and sessions, so reset the instance afterwards.

import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstance } from "./instance-guard.mjs";
import { connectGateway, sendAndCapture, sleep, startRecorders } from "./probe-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const inst = resolveInstance();
const { stateDir, gatewayPort, scriptedPort } = inst;
const recPorts = [scriptedPort + 1, scriptedPort + 2, scriptedPort + 3];
if (recPorts.some((p) => p >= gatewayPort + 20)) {
  console.error("recording ports would leave the instance's block");
  process.exit(2);
}

const show = (label, value) => console.log(`\n## ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
const checks = [];
const check = (ok, label) => {
  checks.push({ ok: Boolean(ok), label });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
};

const recorders = await startRecorders(
  recPorts.map((port, i) => ({ port, label: ["acct-a", "acct-b", "acct-x"][i] })),
  path.join(mkdtempSync(path.join(tmpdir(), "clawtrate-accounts-probe-")), "requests.jsonl"),
);
const requests = recorders.requests;
const gw = await connectGateway(inst);
const { hello, call, waitFor, patchConfig } = gw;

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => c.text ?? "").join(""));
async function send(sessionKey, message) {
  const before = requests().length;
  const r = await sendAndCapture(gw, sessionKey, message);
  const own = r.events.filter((e) => e.payload?.runId === r.runId);
  const model = own.find((e) => e.event === "agent" && e.payload?.stream === "lifecycle" && e.payload?.data?.phase === "model");
  const lifecycleEnd = own.filter((e) => e.event === "agent" && e.payload?.stream === "lifecycle" && !["model", "start"].includes(e.payload?.data?.phase));
  const { message: finalMessage, ...terminal } = r.terminal;
  return {
    sessionKey,
    terminal: { ...terminal, text: finalMessage ? textOf(finalMessage) : undefined },
    lifecycleModel: model?.payload?.data,
    lifecycleOther: lifecycleEnd.map((e) => e.payload.data),
    reached: requests().slice(before),
  };
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
const answeredBy = (r, label) => r.terminal.state === "final" && r.terminal.text === `Answered by ${label}.` && r.reached.length === 1 && r.reached[0].label === label;

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
  const bots = [["probe-a", "acct-a/dev-1"], ["probe-a2", "acct-a/dev-1"], ["probe-b", "acct-b/dev-1"], ["probe-x1", "acct-x/dev-1"], ["probe-x2", "acct-x/dev-1"], ["probe-fb", "acct-b/dev-1"]];
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
  const keyResults = [];
  for (const [agentId, apiKey] of [["probe-x1", "scripted-key-x1"], ["probe-x2", "scripted-key-x2"]]) {
    const r = await call("models.authSetApiKey", { provider: "acct-x", apiKey, agentId });
    keyResults.push(r);
    show(`models.authSetApiKey ${agentId}`, r);
  }
  check(keyResults.every((r) => r.profileId === "acct-x:manual"), "authSetApiKey for two bots returned the same profile acct-x:manual");
  const cfgAfterKeys = await call("config.get", {});
  show("config after authSetApiKey", { acctXApiKey: cfgAfterKeys.config?.models?.providers?.["acct-x"]?.apiKey, auth: cfgAfterKeys.config?.auth });
  for (const agentId of ["probe-x1", "probe-x2"]) show(`models.authStatus ${agentId} acct-x`, (await authStatus(agentId)).filter((p) => p.provider === "acct-x"));
  try {
    show("models.authOrderSet acct-x probe-x1", await call("models.authOrderSet", { provider: "acct-x", profileIds: ["acct-x:manual"], agentId: "probe-x1" }));
    check(false, "authOrderSet refuses an order when the provider config binds the profile");
  } catch (err) {
    show("models.authOrderSet acct-x probe-x1 refused", String(err?.message ?? err));
    check(/provider configuration/.test(String(err?.message ?? err)), "authOrderSet refuses an order when the provider config binds the profile");
  }

  // 3. Which server and key each bot's run reached, and that the streamed answer arrived.
  const runs = {};
  for (const agentId of ["main", "probe-a", "probe-b", "probe-x1", "probe-x2"]) {
    runs[agentId] = await send(`agent:${agentId}:probe`, "Which account answers?");
    show(`run ${agentId}`, runs[agentId]);
  }
  check(runs.main.terminal.state === "final" && runs.main.reached.length === 0, "main ran on the tool's scripted model and reached no recording server");
  check(answeredBy(runs["probe-a"], "acct-a") && runs["probe-a"].reached[0].auth === "Bearer scripted-key-a", "probe-a: final streamed answer from acct-a with key a");
  check(answeredBy(runs["probe-b"], "acct-b") && runs["probe-b"].reached[0].auth === "Bearer scripted-key-b", "probe-b: final streamed answer from acct-b with key b");
  for (const id of ["probe-x1", "probe-x2"]) check(answeredBy(runs[id], "acct-x") && runs[id].reached[0].auth === "Bearer scripted-key-x2", `${id}: final answer from acct-x sent with the second key`);
  const histB = await call("chat.history", { sessionKey: "agent:probe-b:probe", limit: 10 });
  const lastB = (histB.messages ?? []).filter((m) => m.role === "assistant").at(-1);
  check(lastB?.provider === "acct-b" && textOf(lastB) === "Answered by acct-b.", "chat.history keeps probe-b's streamed answer with provider acct-b");
  for (const agentId of ["probe-a", "probe-x1"]) {
    const m = await call("models.list", { agentId });
    show(`models.list ${agentId}`, { models: m.models.map((x) => `${x.provider}/${x.id} available=${x.available}`), accountSelection: m.accountSelection });
  }

  // 3b. A tool server for one bot: global mcp.servers entry, denied on another bot by glob.
  const standIn = path.resolve(here, "../fake-coding-mcp.mjs");
  await patchConfig({ mcp: { servers: { t3stand: { command: process.execPath, args: [standIn] } } }, agents: { entries: { "probe-b": { tools: { deny: ["t3stand__*"] } } } } });
  await sleep(1500);
  await call("agents.create", { name: "probe-new", workspace: path.join(stateDir, "workspace-probe-new"), model: "acct-a/dev-1" });
  const offered = {};
  for (const agentId of ["probe-a", "probe-b", "probe-new"]) {
    const r = await send(`agent:${agentId}:tools`, "Which tools do you have?");
    offered[agentId] = r.reached.flatMap((x) => x.serverTools);
    show(`tool-server tools offered to ${agentId}`, r.reached.map((x) => x.serverTools));
  }
  check(offered["probe-a"].includes("t3stand__send_message") && offered["probe-new"].includes("t3stand__send_message") && offered["probe-b"].length === 0, "the tool server reached probe-a and the later probe-new, not probe-b with the deny");

  // 4. Change a bot's account while its run is in progress.
  const slowRun = await call("chat.send", { sessionKey: "agent:probe-a:switch", message: "SLOW first", idempotencyKey: crypto.randomUUID() });
  await sleep(1200);
  await call("agents.update", { agentId: "probe-a", model: "acct-b/dev-1" });
  const slowDone = await waitFor((e) => e.event === "chat" && e.payload?.runId === slowRun.runId && ["final", "aborted", "error"].includes(e.payload?.state));
  const slowReached = requests().filter((r) => r.marker === "SLOW");
  show("run in progress when probe-a moved to acct-b", { state: slowDone.payload.state, text: textOf(slowDone.payload.message), reached: slowReached });
  check(slowDone.payload.state === "final" && slowReached.length === 1 && slowReached[0].label === "acct-a", "the run in progress finished on acct-a");
  const next = await send("agent:probe-a:switch", "Which account answers after the change?");
  show("next run of probe-a", next);
  check(answeredBy(next, "acct-b"), "the next run used acct-b");
  const switchHistory = await call("chat.history", { sessionKey: "agent:probe-a:switch", limit: 20 });
  const rows = (switchHistory.messages ?? []).map((m) => ({ role: m.role, provider: m.provider, model: m.model, text: textOf(m).slice(0, 80) }));
  show("probe-a:switch history roles and text", rows);
  check(rows.map((r) => `${r.role}:${r.provider ?? ""}`).join(",") === "user:,assistant:acct-a,user:,assistant:acct-b", "history is user, assistant on acct-a, user, assistant on acct-b, with no line marking the change");
  await call("agents.update", { agentId: "probe-a", model: "acct-a/dev-1" });

  // 5. Errors on a bot with a plain model string (no fallbacks of its own).
  const e401 = await send("agent:probe-b:errors-401", "FAIL401 please");
  show("run probe-b FAIL401", e401);
  check(e401.terminal.state === "error" && e401.terminal.errorDetail?.failoverReason === "auth", "401: chat error with errorDetail.failoverReason auth");
  const e402 = await send("agent:probe-a:errors-402", "FAIL402 please");
  show("run probe-a FAIL402", e402);
  check(e402.terminal.state === "error" && e402.terminal.errorDetail?.failoverReason === "billing", "402: chat error with errorDetail.failoverReason billing");
  show("authStatus after errors", (await authStatus("probe-a")).filter((p) => ["acct-a", "acct-b"].includes(p.provider)));
  const again = await send("agent:probe-a:errors-402", "Try again");
  show("run probe-a again after its 402", again);
  check(again.terminal.state === "error" && again.reached.length === 0, "probe-a's next run after its 402 was refused without a request");
  const other = await send("agent:probe-a2:after-402", "Does another bot on acct-a still run?");
  show("run probe-a2 (same provider and config key) after probe-a's 402", other);
  check(answeredBy(other, "acct-a"), "probe-a2, on the same provider and key, still ran after probe-a's billing failure");

  // 6. A bot whose model has a fallback on another account.
  await patchConfig({ agents: { entries: { "probe-fb": { model: { primary: "acct-b/dev-1", fallbacks: ["acct-x/dev-1"] } } } } });
  await sleep(1500);
  show("agents.list probe-fb model", (await call("agents.list", {})).agents.find((a) => a.id === "probe-fb")?.model);
  const fb = await send("agent:probe-fb:fallback", "FAIL401 fallback test");
  show("run probe-fb FAIL401 (primary acct-b, fallback acct-x)", fb);
  const step = fb.lifecycleOther.find((d) => d.phase === "fallback_step" && d.fallbackStepToModel);
  check(fb.reached.map((r) => r.label).join(",") === "acct-b,acct-x" && step?.fallbackStepFromModel === "acct-b/dev-1" && step?.fallbackStepToModel === "acct-x/dev-1", "probe-fb went from acct-b to its fallback acct-x in the same run, with a fallback_step event");

  // 7. Remove one bot's account and run both bots that used that provider.
  show("models.authLogout acct-x for probe-x2", await call("models.authLogout", { provider: "acct-x", agentId: "probe-x2" }));
  show("models.authStatus probe-x1 after logout", (await authStatus("probe-x1")).filter((p) => p.provider === "acct-x"));
  const keyAfter = (await call("config.get", {})).config?.models?.providers?.["acct-x"]?.apiKey ?? null;
  show("config after logout", { acctXApiKey: keyAfter });
  const x2 = await send("agent:probe-x2:probe", "Which account answers now?");
  const x1 = await send("agent:probe-x1:probe", "Which account answers now?");
  show("run probe-x2 after logout", x2);
  show("run probe-x1 after probe-x2's logout", x1);
  check(keyAfter === null && [x1, x2].every((r) => r.reached.length === 1 && r.reached[0].auth === null), "after the logout both bots' runs reached acct-x with no Authorization header");

  // 8. What a client can read back about keys, and what a turn records.
  const cfg = await call("config.get", {});
  show("config.get providers apiKey fields", Object.fromEntries(Object.entries(cfg.config?.models?.providers ?? {}).map(([k, v]) => [k, v.apiKey ?? null])));
  const history = await call("chat.history", { sessionKey: "agent:probe-b:probe", limit: 10 });
  const last = (history.messages ?? []).filter((m) => m.role === "assistant").at(-1);
  show("chat.history last assistant row (probe-b)", { keys: Object.keys(last ?? {}), provider: last?.provider, model: last?.model, openclawKeys: Object.keys(last?.__openclaw ?? {}) });
  check(last && !Object.keys(last).some((k) => /auth|profile|account/i.test(k)), "the assistant history row has no field naming an account");
  const sessions = await call("sessions.list", { limit: 50 });
  const row = (sessions.sessions ?? []).find((s) => s.key === "agent:probe-b:probe");
  show("sessions.list row fields about auth or model (probe-b)", Object.fromEntries(Object.entries(row ?? {}).filter(([k]) => /auth|model|provider|account/i.test(k))));
  show("all recorded requests", requests());
} catch (err) {
  show("probe stopped", String(err?.stack ?? err));
  check(false, "probe ran to the end");
} finally {
  await gw.stop();
  recorders.stop();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}
