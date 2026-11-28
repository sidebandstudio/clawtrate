// Account-pin probe for docs/research/provider-accounts-and-t3-code.md, section A.13.
// Research code: it records what it saw, checks the facts the document states,
// and exits 1 if any of those checks fails.
//
//   pnpm dev-gateway start --instance <name> --no-seed
//   CLAWTRATE_DEV_INSTANCE=<name> node docs/research/dev-gateway/provider-accounts/pin-probe.mjs [--out <file.json>]
//   pnpm dev-gateway stop --instance <name> && pnpm dev-gateway reset --instance <name>
// or pass --reset-after to have the probe stop and reset the instance itself when it ends.
//
// The target check is instance-guard.mjs: a named instance this checkout started,
// whose recorded gateway is still running. OpenClaw's command line is run only
// with `--profile clawtrate-dev-<name>` and that instance's state folder.
//
// What it does. One scripted provider per scenario, each with two API-key
// profiles `<provider>:one` and `<provider>:two` saved with
// `openclaw models auth paste-api-key --profile-id`. All of them point at one
// recording server, which tells the accounts apart by the scripted key it
// receives. A second recording server stands for an unrelated provider
// (`other`) that `agents.defaults.model.fallbacks` names, so an inherited
// cross-provider fallback would show there.
//   - baseline: bot `on-one` pinned to `acct:one`, bot `on-two` to `acct:two`;
//   - for each of 401, 402 and 429: bot `pin-<code>` pinned to `<p>:one` with
//     `{primary:"<p>/dev-1@<p>:one", fallbacks: []}`; one run while it works, then
//     the recording server fails `<p>:one`'s key with that status and two more
//     runs follow;
//   - the same with bot `ord-<code>`, which also has a stored one-profile order
//     `[<p>:one]` set with `openclaw models auth order set --agent ord-<code>`;
//   - an explicit session selection of the other account on an ordered bot;
//   - what a client can read after a switch: `logs.tail` (on a read-only
//     connection) with the instance's log written to a file in its own state
//     folder, `models.authStatus` `lastUsedAt` for a bot whose two profiles are
//     in its own store (`loc-401`), and a configured `displayName` label;
//   - two other ways to start a run on the other account of an ordered bot: a
//     new task from `sessions.create {model:"…@<p>:two"}` and a routine whose
//     `payload.model` names `…@<p>:two` (an agent-turn routine, removed after).
// Each run's message carries a `RUN-…` tag that the recording server logs, so
// requests are attributed to the run that caused them, not to a time window.
// No real provider, credential or sign-in is involved.

import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { instanceCli, resetInstance, resolveInstance } from "./instance-guard.mjs";
import { connectGateway, sendAndCapture, sleep, startRecorders, summarizeEvents } from "./probe-client.mjs";

const { values: opts } = parseArgs({ options: { out: { type: "string" }, "reset-after": { type: "boolean", default: false } } });
const inst = resolveInstance();
const cli = instanceCli(inst);
const accountsPort = inst.scriptedPort + 1;
const otherPort = inst.scriptedPort + 2;
if (otherPort >= inst.gatewayPort + 20 || accountsPort <= inst.scriptedPort) {
  console.error("recording ports would leave the instance's block");
  process.exit(2);
}

const recorders = await startRecorders([
  { port: accountsPort, label: "accounts" },
  { port: otherPort, label: "other" },
]);
const gw = await connectGateway(inst);

const out = { instance: inst.name, steps: [] };
const checks = [];
const check = (ok, label) => {
  checks.push({ ok: Boolean(ok), label });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
};
const record = (label, value) => {
  out.steps.push({ label, value });
  console.log(`\n## ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
};
const keyOf = (provider, account) => `scripted-${provider}-${account}`;
const accountOfKey = (auth) => (auth ? auth.replace(/^Bearer scripted-/, "") : "none");
const model = { id: "dev-1", name: "Scripted dev model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 };

/** One run: the requests it caused, its terminal event, its events, and what the client can read back afterwards. */
const newTag = () => `RUN-${crypto.randomBytes(5).toString("hex")}`;
const tagged = (tag) => recorders.requests().filter((x) => x.tag === tag);
async function run(agentId, sessionName, message, key = `agent:${agentId}:${sessionName}`) {
  const sessionKey = key;
  const tag = newTag();
  const r = await sendAndCapture(gw, sessionKey, `${message} ${tag}`);
  const reached = tagged(tag);
  const history = await gw.call("chat.history", { sessionKey, limit: 4 });
  const lastAssistant = (history.messages ?? []).filter((m) => m.role === "assistant").at(-1);
  const sessions = await gw.call("sessions.list", { limit: 100 });
  const row = (sessions.sessions ?? []).find((s) => s.key === sessionKey);
  let metadata;
  try {
    const m = await gw.call("chat.metadata", { sessionKey });
    metadata = { accountSelection: m.accountSelection, model: m.model ?? m.selectedModel };
  } catch (err) {
    metadata = { error: String(err?.message ?? err) };
  }
  const { message: _m, ...terminal } = r.terminal;
  const phases = r.events.filter((e) => e.event === "agent" && e.payload?.stream === "lifecycle").map((e) => e.payload.data ?? {});
  return {
    sessionKey,
    runId: r.runId,
    reached: reached.map((x) => ({ server: x.label, account: accountOfKey(x.auth), marker: x.marker })),
    fallbackSteps: phases.filter((d) => d.phase === "fallback_step"),
    receipt: phases.find((d) => d.terminalReceipt)?.terminalReceipt ?? null,
    rawEvents: r.events,
    terminal: { ...terminal, finalText: r.terminal.state === "final" ? JSON.stringify(r.terminal.message?.content ?? r.terminal.message ?? null).slice(0, 120) : undefined },
    events: summarizeEvents(r.events),
    historyLastAssistant: lastAssistant ? Object.fromEntries(Object.entries(lastAssistant).filter(([k]) => k !== "content")) : null,
    sessionRow: row ? Object.fromEntries(Object.entries(row).filter(([k]) => /auth|model|provider|account|fallback/i.test(k))) : null,
    metadata,
  };
}
const profilesOf = async (agentId, provider) => {
  const s = await gw.call("models.authStatus", { agentId });
  const p = s.providers.find((x) => x.provider === provider);
  return p ? { status: p.status, profileOrder: p.profileOrder, profileOrderLocked: p.profileOrderLocked, profiles: p.profiles.map((x) => ({ profileId: x.profileId, type: x.type, status: x.status, reasonCode: x.reasonCode, source: x.source })) } : null;
};

const hash12 = (profileId) => `sha256:${crypto.createHash("sha256").update(profileId).digest("hex").slice(0, 12)}`;
let reader;
/** Log records for one run, read back through logs.tail on the read-only connection. */
async function logRecordsFor(runId) {
  const t = await reader.call("logs.tail", { limit: 5000, maxBytes: 1_000_000 });
  return {
    fileName: path.basename(t.file),
    records: t.lines
      .filter((l) => l.includes(runId))
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l.slice(0, 300) };
        }
      }),
  };
}
const failoverDecisions = (records) =>
  records
    .map((r) => Object.values(r).find((v) => v && typeof v === "object" && v.event === "embedded_run_failover_decision") ?? (r.event === "embedded_run_failover_decision" ? r : null))
    .filter(Boolean)
    .map((d) => ({ decision: d.decision, stage: d.stage, failoverReason: d.failoverReason, provider: d.provider, model: d.model, profileId: d.profileId }));
const sameRoute = (receipt) => receipt && receipt.requested?.provider === receipt.effective?.provider && receipt.requested?.model === receipt.effective?.model;

try {
  record("hello", { version: gw.hello.server?.version, scopes: gw.hello.auth?.scopes });

  // 0. The instance's log goes to a file in its own state folder, and a second, read-only connection reads it.
  const logFile = path.join(inst.stateDir, "logs", "probe-gateway.log");
  await gw.patchConfig({ logging: { file: logFile } });
  await sleep(1500);
  reader = await connectGateway(inst, ["operator.read"]);
  const firstTail = await reader.call("logs.tail", { limit: 1 });
  record("logs.tail on an operator.read connection", { scopes: reader.hello.auth?.scopes, fileName: path.basename(firstTail.file), inStateFolder: firstTail.file === logFile });
  check(firstTail.file === logFile, "logs.tail reads the instance's own log file, on an operator.read connection");

  // 1. Providers: `acct` for the baseline, one per scenario, and `other` as an inherited fallback.
  const scenarios = [401, 402, 429].flatMap((code) => [
    { code, mode: "pin", provider: `pin${code}`, bot: `pin-${code}` },
    { code, mode: "ord", provider: `ord${code}`, bot: `ord-${code}` },
  ]);
  const providers = { acct: { baseUrl: `http://127.0.0.1:${accountsPort}/v1`, api: "openai-completions", models: [model] }, other: { baseUrl: `http://127.0.0.1:${otherPort}/v1`, api: "openai-completions", apiKey: "scripted-other-key", models: [model] } };
  for (const s of scenarios) providers[s.provider] = { baseUrl: `http://127.0.0.1:${accountsPort}/v1`, api: "openai-completions", models: [model] };
  await gw.patchConfig({ models: { providers }, agents: { defaults: { model: { primary: "scripted/dev-1", fallbacks: ["other/dev-1"] } } } });
  await sleep(1500);
  record("config.patch", { providers: Object.keys(providers), "agents.defaults.model": { primary: "scripted/dev-1", fallbacks: ["other/dev-1"] } });

  // 2. Two API-key profiles per provider through the instance's command line.
  for (const provider of ["acct", ...scenarios.map((s) => s.provider)]) {
    for (const account of ["one", "two"]) {
      const r = await cli(["models", "auth", "paste-api-key", "--provider", provider, "--profile-id", `${provider}:${account}`], `${keyOf(provider, account)}\n`);
      if (provider === "acct") record(`cli paste-api-key ${provider}:${account}`, r);
      if (r.status !== 0) throw new Error(`paste-api-key ${provider}:${account} failed: ${r.stderr || r.stdout}`);
    }
  }
  const cfg = (await gw.call("config.get", {})).config;
  record("config after paste-api-key (acct)", { providerApiKey: cfg?.models?.providers?.acct?.apiKey ?? null, authProfiles: Object.fromEntries(Object.entries(cfg?.auth?.profiles ?? {}).filter(([k]) => k.startsWith("acct:"))), authOrder: cfg?.auth?.order ?? null });

  // 3. Bots pinned with model@profile and empty fallbacks.
  const bots = [
    { bot: "on-one", provider: "acct", account: "one" },
    { bot: "on-two", provider: "acct", account: "two" },
    ...scenarios.map((s) => ({ bot: s.bot, provider: s.provider, account: "one" })),
  ];
  for (const b of bots) await gw.call("agents.create", { name: b.bot, workspace: path.join(inst.stateDir, `workspace-${b.bot}`), model: `${b.provider}/dev-1@${b.provider}:${b.account}` });
  await gw.patchConfig({ agents: { entries: Object.fromEntries(bots.map((b) => [b.bot, { model: { primary: `${b.provider}/dev-1@${b.provider}:${b.account}`, fallbacks: [] } }])) } });
  await sleep(1500);
  const listed = (await gw.call("agents.list", {})).agents;
  record("agents.list model fields", listed.filter((a) => bots.some((b) => b.bot === a.id)).map((a) => ({ id: a.id, model: a.model })));
  const entries = (await gw.call("config.get", {})).config?.agents?.entries ?? {};
  for (const b of bots) check(entries[b.bot]?.model?.primary === `${b.provider}/dev-1@${b.provider}:${b.account}` && Array.isArray(entries[b.bot]?.model?.fallbacks) && entries[b.bot].model.fallbacks.length === 0, `config keeps ${b.bot}'s model@profile with empty fallbacks`);

  // 4. Stored one-profile orders for the ord-* bots, through the command line.
  for (const s of scenarios.filter((x) => x.mode === "ord")) {
    const set = await cli(["models", "auth", "order", "set", "--provider", s.provider, "--agent", s.bot, `${s.provider}:one`]);
    const get = await cli(["models", "auth", "order", "get", "--provider", s.provider, "--agent", s.bot, "--json"]);
    if (s.code === 401) record(`cli order set/get ${s.bot}`, { set, get });
    check(set.status === 0, `stored order set for ${s.bot}`);
  }
  try {
    const rpc = await gw.call("models.authOrderSet", { provider: "ord401", profileIds: ["ord401:one"], agentId: "pin-401" });
    record("models.authOrderSet one-profile order over RPC", rpc);
  } catch (err) {
    record("models.authOrderSet one-profile order over RPC refused", String(err?.message ?? err));
  }
  record("models.authStatus ord-401 / pin-401", { "ord-401": await profilesOf("ord-401", "ord401"), "pin-401": await profilesOf("pin-401", "pin401") });

  // 5. Baseline: which account each bot reaches.
  for (const b of bots) {
    const r = await run(b.bot, "baseline", "Which account answers?");
    if (b.provider === "acct") record(`baseline ${b.bot}`, r);
    check(r.terminal.state === "final" && r.reached.length === 1 && r.reached[0].account === `${b.provider}-${b.account}`, `baseline: ${b.bot} reached only ${b.provider}:${b.account} and the run ended final`);
  }

  // 6. Fail the pinned account with 401, 402, 429; pin only, then pin plus stored order.
  const failedAt = {};
  for (const s of scenarios) {
    await recorders.control(accountsPort, { [keyOf(s.provider, "one")]: s.code });
    const first = await run(s.bot, `fail-${s.code}`, "First run after the account starts failing");
    const second = await run(s.bot, `fail-${s.code}`, "Second run while the account still fails");
    await recorders.control(accountsPort, {});
    failedAt[s.bot] = Date.now();
    const after = await profilesOf(s.bot, s.provider);
    const third = await run(s.bot, `fail-${s.code}`, "Run after the account works again");
    record(`${s.bot}: ${s.code} on ${s.provider}:one`, { first, second, profilesAfter: after, afterRecovery: third });
    const servedBy = (r) => (r.terminal.state === "final" ? r.reached.at(-1)?.account : null);
    out.steps.at(-1).value.summary = {
      first: { reached: first.reached.map((x) => x.account), state: first.terminal.state, servedBy: servedBy(first) },
      second: { reached: second.reached.map((x) => x.account), state: second.terminal.state, servedBy: servedBy(second) },
      afterRecovery: { reached: third.reached.map((x) => x.account), state: third.terminal.state, servedBy: servedBy(third) },
    };
    console.log(JSON.stringify(out.steps.at(-1).value.summary));
    for (const r of [first, second]) check(!r.reached.some((x) => x.server === "other"), `${s.bot} ${s.code}: no request reached the inherited fallback provider`);
    const one = `${s.provider}-one`;
    const two = `${s.provider}-two`;
    const reason = { 401: "auth", 402: "billing", 429: "rate_limit" }[s.code];
    const logs = await logRecordsFor(first.runId);
    const decisions = failoverDecisions(logs.records);
    out.steps.at(-1).value.firstRunLog = { fileName: logs.fileName, decisions, recordCount: logs.records.length };
    console.log(JSON.stringify({ decisions }));
    if (s.mode === "pin") {
      const ones = first.reached.filter((x) => x.account === one).length;
      check(first.terminal.state === "final" && first.reached.at(-1)?.account === two && ones === (s.code === 429 ? 10 : 1) && first.reached.length === ones + 1, `${s.bot} ${s.code}: the first run tried ${s.provider}:one${s.code === 429 ? " ten times" : ""}, then finished on ${s.provider}:two`);
      check(first.fallbackSteps.length === 0 && sameRoute(first.receipt), `${s.bot} ${s.code}: no fallback_step, and the receipt's requested and effective provider and model agree`);
      check(!first.rawEvents.some((e) => JSON.stringify(e.payload ?? {}).includes(`${s.provider}:`)), `${s.bot} ${s.code}: no event the client received names either profile`);
      check(second.terminal.state === "final" && second.reached.length === 1 && second.reached[0].account === two, `${s.bot} ${s.code}: the second run went straight to ${s.provider}:two`);
      check(decisions.some((d) => d.decision === "rotate_profile" && d.profileId === hash12(`${s.provider}:one`)), `${s.bot} ${s.code}: logs.tail has a rotate_profile decision for the run, with the hash of ${s.provider}:one`);
      check(!decisions.some((d) => d.profileId === hash12(`${s.provider}:two`)), `${s.bot} ${s.code}: the log names no decision for ${s.provider}:two (the destination)`);
    } else {
      for (const r of [first, second]) check(!r.reached.some((x) => x.account === two), `${s.bot} ${s.code}: with the stored one-profile order no request used ${s.provider}:two`);
      check(first.terminal.state === "error" && first.terminal.errorDetail?.failoverReason === reason && first.fallbackSteps.some((d) => d.fallbackStepFinalOutcome === "chain_exhausted"), `${s.bot} ${s.code}: the first run ended in error with errorDetail.failoverReason ${reason} and a chain_exhausted fallback_step`);
      check(second.terminal.state === "error" && second.reached.length === 0 && !second.terminal.errorDetail && typeof second.terminal.errorMessage === "string", `${s.bot} ${s.code}: the second run made no request and ended in error with a message and no errorDetail`);
      check(!decisions.some((d) => d.decision === "rotate_profile"), `${s.bot} ${s.code}: logs.tail has no rotate_profile decision for the run`);
    }
  }

  // 6a. A bot whose two profiles live in its own store: lastUsedAt before and after a switch.
  await gw.patchConfig({ models: { providers: { loc401: { baseUrl: `http://127.0.0.1:${accountsPort}/v1`, api: "openai-completions", models: [model] } } } });
  await gw.call("agents.create", { name: "loc-401", workspace: path.join(inst.stateDir, "workspace-loc-401"), model: "loc401/dev-1@loc401:one" });
  for (const account of ["one", "two"]) {
    const r = await cli(["models", "auth", "paste-api-key", "--agent", "loc-401", "--provider", "loc401", "--profile-id", `loc401:${account}`], `${keyOf("loc401", account)}\n`);
    if (r.status !== 0) throw new Error(`paste-api-key --agent loc-401 loc401:${account} failed: ${r.stderr || r.stdout}`);
  }
  await gw.patchConfig({ agents: { entries: { "loc-401": { model: { primary: "loc401/dev-1@loc401:one", fallbacks: [] } } } } });
  await sleep(1500);
  const lastUsed = async (agentId, provider, connection = gw) => {
    const st = await connection.call("models.authStatus", { agentId });
    return Object.fromEntries((st.providers.find((x) => x.provider === provider)?.profiles ?? []).map((x) => [x.profileId, { source: x.source, lastUsedAt: x.lastUsedAt ?? null }]));
  };
  const locBase = await run("loc-401", "switch", "Baseline on the local profile");
  const locAfterBase = await lastUsed("loc-401", "loc401");
  await recorders.control(accountsPort, { [keyOf("loc401", "one")]: 401 });
  const locSwitch = await run("loc-401", "switch", "First run after the local account starts failing");
  await recorders.control(accountsPort, {});
  const locAfterSwitch = await lastUsed("loc-401", "loc401");
  const locAfterSwitchReadOnly = await lastUsed("loc-401", "loc401", reader);
  const sharedPin = await lastUsed("pin-401", "pin401");
  record("lastUsedAt: bot-local profiles (loc-401) and shared profiles (pin-401)", {
    baseline: { reached: locBase.reached.map((x) => x.account), state: locBase.terminal.state, lastUsed: locAfterBase },
    switch: { reached: locSwitch.reached.map((x) => x.account), state: locSwitch.terminal.state, lastUsedAdmin: locAfterSwitch, lastUsedReadOnly: locAfterSwitchReadOnly, finishedAt: Date.now() },
    sharedPin401: sharedPin,
  });
  check(locBase.reached.length === 1 && locBase.reached[0].account === "loc401-one" && locAfterBase["loc401:one"]?.lastUsedAt && !locAfterBase["loc401:two"]?.lastUsedAt, "loc-401 baseline: served by loc401:one, which alone has lastUsedAt");
  check(locSwitch.terminal.state === "final" && locSwitch.reached.at(-1)?.account === "loc401-two" && locAfterSwitch["loc401:two"]?.lastUsedAt > locAfterBase["loc401:one"].lastUsedAt, "loc-401 switch: served by loc401:two, whose lastUsedAt is now set and newest (admin connection)");
  check(Object.values(locAfterSwitchReadOnly).every((x) => x.lastUsedAt === null), "lastUsedAt is withheld from an operator.read connection");
  check(Object.values(sharedPin).every((x) => x.lastUsedAt === null), "shared profiles used by pin-401 report no lastUsedAt");

  // 6c. A configured display name as the account's label.
  await gw.patchConfig({ auth: { profiles: { "acct:one": { provider: "acct", mode: "api_key", displayName: "Work account" } } } });
  await sleep(1500);
  const labelled = (await gw.call("models.authStatus", { agentId: "on-one" })).providers.find((x) => x.provider === "acct")?.profiles.find((x) => x.profileId === "acct:one");
  const labelledReadOnly = (await reader.call("models.authStatus", { agentId: "on-one" })).providers.find((x) => x.provider === "acct")?.profiles.find((x) => x.profileId === "acct:one");
  const labelMeta = await gw.call("chat.metadata", { sessionKey: "agent:on-one:baseline" });
  record("auth.profiles.acct:one.displayName = \"Work account\"", { authStatusAdmin: labelled?.displayName ?? null, authStatusReadOnly: labelledReadOnly?.displayName ?? null, chatMetadataLabel: labelMeta.accountSelection?.label ?? null });
  check(labelled?.displayName === "Work account", "a configured displayName is returned by models.authStatus to an admin connection");

  // 6b. After the 401 cooldown (30 s for a first auth failure) has passed.
  for (const bot of ["pin-401", "ord-401"]) {
    const wait = failedAt[bot] + 40_000 - Date.now();
    if (wait > 0) await sleep(wait);
    const r = await run(bot, "fail-401", "Run after the cooldown has passed");
    record(`${bot} after the 401 cooldown`, { reached: r.reached, state: r.terminal.state, metadata: r.metadata });
    check(r.terminal.state === "final" && r.reached.length === 1 && r.reached[0].account === `${bot.replace("-", "")}-one`, `${bot}: after the cooldown the run went back to its pinned account`);
  }

  // 7. An explicit session selection of the other account on a bot with a stored order.
  const sessionKey = "agent:ord-401:explicit";
  const patched = await gw.call("sessions.patch", { key: sessionKey, model: "ord401/dev-1@ord401:two" });
  record("sessions.patch model ord401/dev-1@ord401:two on ord-401", { ok: patched?.ok, entry: Object.fromEntries(Object.entries(patched?.entry ?? {}).filter(([k]) => /auth|model|provider/i.test(k))) });
  const explicit = await run("ord-401", "explicit", "Which account answers with the session selection?");
  record("ord-401 run after the session selected ord401:two", explicit);
  check(explicit.terminal.state === "final" && explicit.reached.length === 1 && explicit.reached[0].account === "ord401-two", "an explicit session selection of ord401:two on ord-401 overrode the stored order");

  // 8. A new task created with the other account.
  const created = await gw.call("sessions.create", { agentId: "ord-401", key: "agent:ord-401:new-task", model: "ord401/dev-1@ord401:two" });
  record("sessions.create {agentId:ord-401, model:ord401/dev-1@ord401:two}", { ok: created?.ok, key: created?.key, entry: Object.fromEntries(Object.entries(created?.entry ?? {}).filter(([k]) => /auth|model|provider/i.test(k))) });
  const newTask = await run("ord-401", "new-task", "Which account answers in the new task?", created?.key ?? "agent:ord-401:new-task");
  record("ord-401 run in the task created with ord401:two", { reached: newTask.reached, state: newTask.terminal.state, metadata: newTask.metadata });
  check(newTask.terminal.state === "final" && newTask.reached.length === 1 && newTask.reached[0].account === "ord401-two", "a task created with sessions.create {model:…@ord401:two} ran on ord401:two despite the stored order");

  // 9. A routine whose payload names the other account.
  const tag = newTag();
  const job = await gw.call("cron.add", { name: "probe-account-routine", agentId: "ord-401", enabled: false, schedule: { kind: "at", at: new Date(Date.now() + 86_400_000).toISOString() }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: `Which account answers in the routine? ${tag}`, model: "ord401/dev-1@ord401:two" } });
  const jobId = job?.id ?? job?.job?.id ?? job?.jobId;
  let ran;
  try {
    ran = await gw.call("cron.run", { id: jobId, mode: "force", waitTimeoutMs: 120_000 }, 150_000);
  } finally {
    await gw.call("cron.remove", { id: jobId }).catch(() => {});
  }
  for (let i = 0; i < 30 && tagged(tag).length === 0; i += 1) await sleep(1000);
  const routineReached = tagged(tag).map((x) => x.account ?? accountOfKey(x.auth));
  record("routine (agentTurn, payload.model ord401/dev-1@ord401:two) on ord-401", { jobId, run: ran ? Object.fromEntries(Object.entries(ran).filter(([k]) => /status|ok|ran|error|outcome/i.test(k))) : null, reached: routineReached });
  check(routineReached.length >= 1 && routineReached.every((a) => a === "ord401-two"), "a routine whose payload names ord401:two ran on ord401:two despite the stored order");
} catch (err) {
  record("probe stopped", String(err?.stack ?? err));
  check(false, "probe ran to the end");
} finally {
  await gw.stop();
  await reader?.stop();
  recorders.stop();
  out.checks = checks;
  if (opts.out) writeFileSync(opts.out, `${JSON.stringify(out, null, 2)}\n`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (opts["reset-after"]) resetInstance(inst);
  process.exitCode = failed.length ? 1 : 0;
}
