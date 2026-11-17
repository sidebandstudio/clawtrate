// Account-pin probe for docs/research/provider-accounts-and-t3-code.md, section A.13.
// Research code: it records what it saw, checks the facts the document states,
// and exits 1 if any of those checks fails.
//
//   pnpm dev-gateway start --instance <name> --no-seed
//   CLAWTRATE_DEV_INSTANCE=<name> node docs/research/dev-gateway/provider-accounts/pin-probe.mjs [--out <file.json>]
//   pnpm dev-gateway stop --instance <name> && pnpm dev-gateway reset --instance <name>
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
//   - an explicit session selection of the other account on an ordered bot.
// No real provider, credential or sign-in is involved.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { instanceCli, resolveInstance } from "./instance-guard.mjs";
import { connectGateway, sendAndCapture, sleep, startRecorders, summarizeEvents } from "./probe-client.mjs";

const { values: opts } = parseArgs({ options: { out: { type: "string" } } });
const inst = resolveInstance();
const cli = instanceCli(inst);
const accountsPort = inst.scriptedPort + 1;
const otherPort = inst.scriptedPort + 2;
if (otherPort >= inst.gatewayPort + 20 || accountsPort <= inst.scriptedPort) {
  console.error("recording ports would leave the instance's block");
  process.exit(2);
}

const logDir = mkdtempSync(path.join(tmpdir(), "clawtrate-pin-probe-"));
const recorders = await startRecorders(
  [
    { port: accountsPort, label: "accounts" },
    { port: otherPort, label: "other" },
  ],
  path.join(logDir, "requests.jsonl"),
);
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
async function run(agentId, sessionName, message) {
  const sessionKey = `agent:${agentId}:${sessionName}`;
  const before = recorders.requests().length;
  const r = await sendAndCapture(gw, sessionKey, message);
  const reached = recorders.requests().slice(before);
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
  return {
    sessionKey,
    reached: reached.map((x) => ({ server: x.label, account: accountOfKey(x.auth), marker: x.marker })),
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

try {
  record("hello", { version: gw.hello.server?.version, scopes: gw.hello.auth?.scopes });

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
    if (s.mode === "ord") for (const r of [first, second]) check(!r.reached.some((x) => x.account === `${s.provider}-two`), `${s.bot} ${s.code}: with the stored one-profile order no request used ${s.provider}:two`);
  }

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
} catch (err) {
  record("probe stopped", String(err?.stack ?? err));
  check(false, "probe ran to the end");
} finally {
  await gw.stop();
  recorders.stop();
  out.checks = checks;
  if (opts.out) writeFileSync(opts.out, `${JSON.stringify(out, null, 2)}\n`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}
