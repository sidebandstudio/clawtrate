// Model catalogue probe for docs/research/model-catalog.md.
// Research code: it prints what it saw and checks the facts the document states
// from it, exiting 1 if any check fails.
//
//   pnpm dev-gateway start --instance <name> --with-accounts --no-seed
//   CLAWTRATE_DEV_INSTANCE=<name> node docs/research/dev-gateway/models/probe.mjs
//   pnpm dev-gateway stop --instance <name> && pnpm dev-gateway reset --instance <name>
//
// The target check is the provider-account probes' instance-guard.mjs: a named
// instance this checkout started, whose recorded gateway is still running,
// reporting 2026.10.6. Only the instance's scripted providers are used. It
// changes the instance's config, bots and sessions, so reset the instance
// afterwards.

import { resolveInstance } from "../provider-accounts/instance-guard.mjs";
import { connectGateway, sendAndCapture } from "../provider-accounts/probe-client.mjs";

const inst = resolveInstance();
const show = (label, value) =>
  console.log(`\n## ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
};
const ids = (answer, provider) =>
  (answer.models ?? []).filter((m) => !provider || m.provider === provider).map((m) => `${m.provider}/${m.id}`);
const scripted = async (path) => (await fetch(`http://127.0.0.1:${inst.scriptedPort}${path}`)).json();

const gw = await connectGateway(inst);
try {
  // 1. The catalogue views, before any allowlist.
  const plain = await gw.call("models.list", { agentId: "main" });
  const all = await gw.call("models.list", { agentId: "main", view: "all" });
  const acme = await gw.call("models.list", { agentId: "main", view: "all", provider: "acme" });
  show("models.list {agentId} (no allowlist)", ids(plain));
  show("models.list {agentId, view:all}", ids(all));
  show("models.list {agentId, view:all, provider:acme}", ids(acme));
  show("result keys", Object.keys(all));
  check("view:all with provider lists that provider only", ids(acme).every((id) => id.startsWith("acme/")) && ids(acme).length === 2, ids(acme));

  // 2. With an allowlist (`agents.defaults.models`), as onboarding writes one.
  await gw.patchConfig({ agents: { defaults: { models: { "acme/dev-1": {} } } } });
  const allowDefault = await gw.call("models.list", { agentId: "main" });
  const allowAll = await gw.call("models.list", { agentId: "main", view: "all" });
  show("allowlist acme/dev-1: models.list {agentId}", ids(allowDefault));
  show("allowlist acme/dev-1: models.list {agentId, view:all}", ids(allowAll));
  // Models a provider entry in `models.providers` declares count as configured, so the
  // allowlist does not hide them; the scripted providers are all of that kind.
  check("with configured providers, the default view equals view:all", ids(allowDefault).join() === ids(allowAll).join(), { allowDefault: ids(allowDefault), allowAll: ids(allowAll) });
  const dev2 = (allowAll.models ?? []).find((m) => m.provider === "acme" && m.id === "dev-2");
  show("acme/dev-2 under view:all", dev2);

  // 3. A bot on a model id no catalogue lists, with the allowlist in place.
  const workspace = `${inst.stateDir}/workspaces/unlisted`;
  const created = await gw
    .call("agents.create", { name: "unlisted", workspace, model: "acme/dev-9@acme:work" })
    .catch((e) => ({ error: String(e?.message ?? e) }));
  show("agents.create {model: acme/dev-9@acme:work}", created);
  check("agents.create accepts an unlisted model id", created.ok === true, created);
  const patched = await gw
    .patchConfig({ agents: { entries: { unlisted: { model: { primary: "acme/dev-9@acme:work", fallbacks: [] } } } } })
    .then(() => "ok", (e) => String(e?.message ?? e));
  show("config.patch the bot's model object", patched);
  check("config.patch accepts the unlisted model object", patched === "ok", patched);
  const listed = await gw.call("agents.list", {});
  show("agents.list unlisted bot", (listed.agents ?? []).find((a) => a.id === "unlisted"));
  const forBot = await gw.call("models.list", { agentId: "unlisted" });
  show("models.list {agentId: unlisted}", ids(forBot));
  check("the bot's own unlisted model is not in its catalogue", !ids(forBot).includes("acme/dev-9"), ids(forBot));

  const key = "agent:unlisted:probe";
  await gw.call("sessions.create", { agentId: "unlisted", key, label: "probe" }).catch(() => {});
  const run = await sendAndCapture(gw, key, "#text");
  show("run on the unlisted model: terminal", {
    state: run.terminal.state,
    errorMessage: run.terminal.errorMessage,
    errorKind: run.terminal.errorKind,
    errorDetail: run.terminal.errorDetail,
  });
  const served = (await scripted("/scripted/requests")).requests?.filter((r) => r.session === key) ?? [];
  show("scripted model's record for that session", served);
  check("the run on the unlisted id ended normally", run.terminal.state === "final", run.terminal);
  check("the provider was asked for dev-9 on the bound account", served.length > 0 && served.every((r) => r.model === "dev-9" && r.account === "acme:work"), served);

  // 4. The same id on a task, through sessions.patch.
  const patchKey = "agent:main:probe-unlisted";
  await gw.call("sessions.create", { agentId: "main", key: patchKey, label: "probe" }).catch(() => {});
  const sessionPatch = await gw
    .call("sessions.patch", { key: patchKey, model: "acme/dev-9" })
    .then((r) => ({ ok: true, model: r?.entry?.model ?? r?.model ?? null }), (e) => ({ error: String(e?.message ?? e) }));
  show("sessions.patch {model: acme/dev-9}", sessionPatch);
  check("sessions.patch accepts an unlisted id", sessionPatch.ok === true, sessionPatch);

  // 5. Update signals a client can read.
  show("hello-ok server", gw.hello?.server);
  show("hello-ok snapshot.updateAvailable", gw.hello?.snapshot?.updateAvailable ?? null);
  const status = await gw.call("update.status", {}).catch((e) => ({ error: String(e?.message ?? e) }));
  show("update.status", { updateAvailable: status.updateAvailable ?? null, keys: Object.keys(status) });
  show("refresh markers on models.list", { refreshFailed: all.refreshFailed ?? null, pendingProviders: all.pendingProviders ?? null, providerOutcomes: all.providerOutcomes ?? null });
} finally {
  await gw.stop();
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
