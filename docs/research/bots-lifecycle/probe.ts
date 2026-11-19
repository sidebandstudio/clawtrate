// Probes behind docs/research/bots-lifecycle.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name>
//   node docs/research/bots-lifecycle/probe.ts <experiment> --instance <name>
//
// It acts only on a named development instance this checkout started. It
// connects through the development tool's own paired operator (a new device
// whose pairing request is approved by id through the tool's guarded runner),
// and runs `openclaw` only with that instance's profile and state folder. It
// creates its own scratch bots ("Probe …") and never changes the seeded ones,
// except where an experiment says so and puts the value back. Paths are printed
// relative to the instance's state folder (`<state>`) or the home folder (`~`).
//
// Experiments:
//   list     agents.list: the default bot, its ownership, each bot's fields
//   primary  users.prefs on two paired devices; agents.defaults.systemAgent
//            set and cleared, and what agents.list's defaultId does
//   edit     a scratch bot: rename, label (identity.theme), pictures of three
//            sizes, instructions with and without the hash read, and the
//            events a second device sees for each
//   chat     a scratch bot writes a file in a run: what the tool events carry
//   image    whether image_generate is offered to a bot
//   copy     what agents.create puts in a new workspace, and what a copy can set
//   delete   delete with and without files, a shared workspace, a routine and a
//            task, a refusal, a partial failure and its retry
//   claws    the gateway's own package format: export, then a dry-run add
//   file     a bot written to Clawtrate's own file (name, label, a picture that
//            decodes, model by name, effort, the two instruction files) and read
//            back into a new bot, compared field by field by the gateway's reads;
//            and the refusals that come before anything is used
//   limits   an instruction file at, and one byte over, the gateway's bound

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openInstance, openOperator } from "../../../tools/dev-gateway/src/cli.ts";
import { openclawEnv, parseJsonOutput } from "../../../tools/dev-gateway/src/env.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { instance: { type: "string" } },
  allowPositionals: true,
});
const experiment = positionals[0];
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
const refusal = inst.runner.refusal();
if (refusal) throw new Error(refusal);

const home = homedir();
const clean = (text: string) => text.split(inst.stateDir).join("<state>").split(home).join("~");
const say = (...parts: unknown[]) =>
  console.log(clean(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ADMIN = ["operator.admin", "operator.read", "operator.write"];
type Op = Awaited<ReturnType<typeof openOperator>>;
const op = (name: string, scopes = ADMIN) => openOperator(inst, `Clawtrate lifecycle probe ${name}`, scopes, ["tool-events"]);

async function call(o: Op, method: string, params: unknown) {
  try {
    return { ok: true as const, value: (await o.request(method, params)) as Record<string, unknown> };
  } catch (error) {
    const e = error as Error & { code?: string; details?: unknown };
    return { ok: false as const, error: { message: e.message, code: e.code, details: e.details } };
  }
}
const must = async (o: Op, method: string, params: unknown) => {
  const r = await call(o, method, params);
  if (!r.ok) throw new Error(`${method}: ${r.error.message}`);
  return r.value;
};
type Agent = { id: string; name?: string; identity?: Record<string, unknown>; workspace?: string; model?: unknown };
const agents = async (o: Op) => (await must(o, "agents.list", {})) as { defaultId: string; ownership?: string; selectionRequired?: boolean; agents: Agent[] };
const agent = async (o: Op, id: string) => (await agents(o)).agents.find((a) => a.id === id);
const eventsSince = (o: Op, seq: number) =>
  o.events.filter((e) => e.seq > seq && e.event !== "tick" && e.event !== "health" && e.event !== "presence").map((e) => e.event);
const lastSeq = (o: Op) => o.events.at(-1)?.seq ?? 0;
const configOf = async (o: Op) => (await must(o, "config.get", {})) as { hash: string; config: Record<string, any> };
const patch = async (o: Op, value: unknown) => {
  const { hash } = await configOf(o);
  return call(o, "config.patch", { raw: JSON.stringify(value), baseHash: hash });
};
const pngDataUrl = (bytes: number) => {
  // The PNG signature followed by filler: the gateway checks a picture's data: prefix and length, not its bytes.
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return `data:image/png;base64,${Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 7)]).toString("base64")}`;
};
async function create(o: Op, name: string, extra: Record<string, unknown> = {}) {
  const r = await call(o, "agents.create", { name, ...extra });
  const shown = Object.fromEntries(Object.entries({ name, ...extra }).map(([k, v]) => [k, typeof v === "string" && v.length > 80 ? `${v.slice(0, 22)}… (${v.length} characters)` : v]));
  say(`agents.create ${JSON.stringify(shown)}:`, r.ok ? r.value : r.error);
  return r.ok ? String(r.value.agentId) : null;
}
async function removeQuietly(o: Op, id: string | null) {
  if (!id) return;
  const r = await call(o, "agents.delete", { agentId: id, deleteFiles: false });
  if (!r.ok) say(`cleanup ${id}:`, r.error.message);
}

async function list() {
  const o = await op("list", ["operator.read"]);
  try {
    const r = await agents(o);
    say("defaultId:", r.defaultId, "ownership:", r.ownership, "selectionRequired:", r.selectionRequired);
    for (const a of r.agents)
      say(" ", a.id, { name: a.name, identity: a.identity && Object.keys(a.identity), workspace: a.workspace, model: a.model });
  } finally {
    await o.close();
  }
}

async function primary() {
  const one = await op("one");
  const two = await op("two");
  try {
    say("device one, users.prefs.get:", await call(one, "users.prefs.get", { keys: ["clawtrate.primary"] }));
    const before = lastSeq(two);
    say("device one, users.prefs.set {clawtrate.primary: {bot: pip}}:", await call(one, "users.prefs.set", { entries: { "clawtrate.primary": { bot: "pip" } } }));
    await sleep(500);
    say("device two sees events:", eventsSince(two, before), "and reads:", await call(two, "users.prefs.get", { keys: ["clawtrate.primary"] }));
    const self = await call(one, "users.self", {});
    // The profile's display name is the machine owner's: print only its id and which fields it has.
    say("users.self on device one:", self.ok ? { id: (self.value.profile as { id: string }).id, fields: Object.keys(self.value.profile as object) } : self.error);
    say("put back: users.prefs.set {clawtrate.primary: null}:", await call(one, "users.prefs.set", { entries: { "clawtrate.primary": null } }));

    const r = await agents(one);
    say("agents.list defaultId:", r.defaultId, "ownership:", r.ownership, "order:", r.agents.map((a) => a.id));
    const cfg = await configOf(one);
    say("config agents keys:", Object.keys(cfg.config.agents ?? {}), "ownership:", cfg.config.agents?.ownership, "systemAgent:", cfg.config.agents?.defaults?.systemAgent);
    const set = await patch(one, { agents: { defaults: { systemAgent: { agentId: "pip" } } } });
    say("config.patch agents.defaults.systemAgent.agentId = pip:", set.ok ? "ok" : set.error);
    await sleep(800);
    const after = await agents(one);
    say("agents.list defaultId now:", after.defaultId, "ownership:", after.ownership, "order:", after.agents.map((a) => a.id));
    const original = cfg.config.agents?.defaults?.systemAgent ?? null;
    const restored = await patch(one, { agents: { defaults: { systemAgent: original } } });
    say("put back: config.patch systemAgent", original, ":", restored.ok ? "ok" : restored.error);
    await sleep(800);
    say("agents.list defaultId after:", (await agents(one)).defaultId);
  } finally {
    await one.close();
    await two.close();
  }
}

async function edit() {
  const o = await op("edit");
  const watcher = await op("watch", ["operator.read"]);
  const id = await create(o, "Probe Edit");
  try {
    if (!id) return;
    let mark = lastSeq(watcher);
    say("agents.update name:", await call(o, "agents.update", { agentId: id, name: "Probe Edited" }));
    await sleep(500);
    say("  read back:", await agent(o, id), "second device saw:", eventsSince(watcher, mark));

    mark = lastSeq(watcher);
    say("label: config.patch identity.theme:", await patch(o, { agents: { entries: { [id]: { identity: { theme: "Errands" } } } } }));
    await sleep(500);
    say("  read back identity:", (await agent(o, id))?.identity, "second device saw:", eventsSince(watcher, mark));
    say("  agents.update name again:", await call(o, "agents.update", { agentId: id, name: "Probe Edit" }));
    say("  label survives a rename:", (await agent(o, id))?.identity?.theme);

    for (const bytes of [20_000, 1_500_000, 2_200_000]) {
      const url = pngDataUrl(bytes);
      const r = await call(o, "agents.update", { agentId: id, avatar: url });
      const a = await agent(o, id);
      say(`avatar of ${bytes} bytes (${url.length} characters):`, r.ok ? r.value : r.error, "read back avatarUrl characters:", String(a?.identity?.avatarUrl ?? "").length, "avatar starts:", String(a?.identity?.avatar ?? "").slice(0, 22));
    }
    say("avatar that is not an image, data:text/plain:", await call(o, "agents.update", { agentId: id, avatar: "data:text/plain;base64,aGVsbG8=" }));
    const odd = await agent(o, id);
    say("  read back:", { avatar: String(odd?.identity?.avatar ?? "").slice(0, 30), avatarUrl: String(odd?.identity?.avatarUrl ?? "").slice(0, 30) });

    const files = await must(o, "agents.files.list", { agentId: id });
    say("agents.files.list:", (files.files as Record<string, unknown>[]).map((f) => ({ name: f.name, missing: f.missing, size: f.size })));
    const got = (await must(o, "agents.files.get", { agentId: id, name: "AGENTS.md" })).file as { hash: string; size: number; content: string };
    say("agents.files.get AGENTS.md:", { size: got.size, hash: got.hash.slice(0, 12), firstLine: got.content.split("\n")[0] });
    mark = lastSeq(watcher);
    const saved = await call(o, "agents.files.set", { agentId: id, name: "AGENTS.md", content: got.content + "\nAlways answer in one sentence.\n", expectedHash: got.hash });
    say("agents.files.set with the hash read:", saved.ok ? { ok: true, hash: String((saved.value.file as { hash: string }).hash).slice(0, 12) } : saved.error);
    await sleep(500);
    say("  second device saw:", eventsSince(watcher, mark));
    say("agents.files.set again with the old hash:", await call(o, "agents.files.set", { agentId: id, name: "AGENTS.md", content: got.content, expectedHash: got.hash }));
    say("agents.files.set SOUL.md:", (await call(o, "agents.files.set", { agentId: id, name: "SOUL.md", content: "Calm and brief.\n" })).ok);
    say("agents.files.get notes/x.md (not a bootstrap file):", await call(o, "agents.files.get", { agentId: id, name: "notes/x.md" }));
    say("agents.files.get MEMORY.md:", await call(o, "agents.files.get", { agentId: id, name: "MEMORY.md" }));
    const ro = await op("read-only", ["operator.read"]);
    say("read-only device: agents.files.get:", (await call(ro, "agents.files.get", { agentId: id, name: "AGENTS.md" })).ok, "agents.files.set:", await call(ro, "agents.files.set", { agentId: id, name: "AGENTS.md", content: "x" }), "agents.update:", await call(ro, "agents.update", { agentId: id, name: "x" }));
    await ro.close();
  } finally {
    await removeQuietly(o, id);
    await o.close();
    await watcher.close();
  }
}

async function chat() {
  const o = await op("chat");
  const id = await create(o, "Probe Chat");
  try {
    if (!id) return;
    const key = `agent:${id}:main`;
    const before = (await must(o, "agents.files.get", { agentId: id, name: "AGENTS.md" })).file as { hash: string };
    const mark = lastSeq(o);
    const sent = await o.send(key, "#write");
    const done = await o.terminal(String(sent.runId));
    say("run ended:", done.state);
    const evs = o.events.filter((e) => e.seq > mark);
    say("events of the run:", [...new Set(evs.map((e) => e.event))]);
    const tools = evs.filter((e) => e.event === "agent" && JSON.stringify(e.payload).includes('"tool"'));
    for (const e of tools.slice(0, 4)) {
      const p = e.payload as { stream?: string; data?: Record<string, unknown> };
      say("  agent event:", { stream: p.stream, phase: p.data?.phase, name: p.data?.name, args: p.data?.args, keys: p.data && Object.keys(p.data) });
    }
    const after = (await must(o, "agents.files.get", { agentId: id, name: "AGENTS.md" })).file as { hash: string };
    say("AGENTS.md unchanged by the run:", before.hash === after.hash);
  } finally {
    await removeQuietly(o, id);
    await o.close();
  }
}

async function image() {
  const o = await op("image", ["operator.read"]);
  try {
    const catalog = await call(o, "tools.catalog", { agentId: "main" });
    const names = catalog.ok ? JSON.stringify(catalog.value).match(/"(?:id|name)":"image_generate"/g) : null;
    say("tools.catalog for main (Juniper) lists image_generate:", Boolean(names), catalog.ok ? "" : catalog.error);
    if (catalog.ok) {
      const text = JSON.stringify(catalog.value);
      const at = text.indexOf('"image_generate"');
      say("  its catalog entry:", text.slice(Math.max(0, text.lastIndexOf("{", at)), text.indexOf("}", at) + 1));
    }
    const listed = await must(o, "sessions.list", { agentId: "main", limit: 5 });
    const key = (listed.sessions as { key: string }[])[0]?.key;
    const effective = await call(o, "tools.effective", { agentId: "main", sessionKey: key });
    const tools = effective.ok ? JSON.stringify(effective.value) : "";
    say(`tools.effective for Juniper's task ${key}:`, effective.ok ? { lists: tools.includes("image_generate"), notice: effective.value.notice, keys: Object.keys(effective.value), sample: tools.match(/"(?:id|name)":"[a-z_]+"/g)?.slice(0, 16) } : effective.error);
  } finally {
    await o.close();
  }
}

async function copy() {
  const o = await op("copy");
  const made: (string | null)[] = [];
  try {
    made.push(await create(o, "Pip"));
    const id = await create(o, "Probe Pip copy");
    made.push(id);
    if (!id) return;
    const listed = await agent(o, id);
    say("the copy, as listed:", listed);
    const files = await must(o, "agents.files.list", { agentId: id });
    say("its workspace's bootstrap files:", (files.files as Record<string, unknown>[]).map((f) => `${f.name}:${f.missing ? "missing" : f.size}`));
    const source = (await must(o, "agents.files.get", { agentId: "pip", name: "AGENTS.md" })).file as { content: string };
    const fresh = (await must(o, "agents.files.get", { agentId: id, name: "AGENTS.md" })).file as { hash: string; size: number };
    const set = await call(o, "agents.files.set", { agentId: id, name: "AGENTS.md", content: source.content, expectedHash: fresh.hash });
    say("instructions copied from pip with the new bot's hash:", set.ok);
    const cfg = await configOf(o);
    say("pip's config entry keys:", Object.keys(cfg.config.agents?.entries?.pip ?? {}), "the copy's:", Object.keys(cfg.config.agents?.entries?.[id] ?? {}));
    const entry = cfg.config.agents?.entries?.pip ?? {};
    const toCopy: Record<string, unknown> = {};
    for (const key of ["tools", "skills", "thinkingDefault"]) if (key in entry) toCopy[key] = entry[key];
    const copied = await patch(o, { agents: { entries: { [id]: toCopy } } });
    say("config.patch the copy with", Object.keys(toCopy), ":", copied.ok ? "ok" : copied.error);
    const back = (await configOf(o)).config.agents?.entries?.[id] ?? {};
    say("read back equal:", Object.keys(toCopy).every((k) => JSON.stringify(back[k]) === JSON.stringify(toCopy[k])));
    say("pip's routines, cron.list {agentId: pip, includeDisabled}:", await call(o, "cron.list", { agentId: "pip", includeDisabled: true, compact: true }));
  } finally {
    for (const id of made) await removeQuietly(o, id);
    await o.close();
  }
}

async function preview(o: Op, id: string) {
  const ws = await call(o, "agents.workspace.list", { agentId: id, limit: 50 });
  const sessions = await call(o, "sessions.list", { agentId: id, limit: 50 });
  const cron = await call(o, "cron.list", { agentId: id, includeDisabled: true, compact: true });
  return {
    workspace: ws.ok ? { entries: (ws.value.entries as unknown[] | undefined)?.length, keys: Object.keys(ws.value) } : ws.error.message,
    sessions: sessions.ok ? (sessions.value.sessions as { key: string }[] | undefined)?.map((s) => s.key) : sessions.error.message,
    routines: cron.ok ? (cron.value.jobs as { name: string }[] | undefined)?.map((j) => j.name) : cron.error.message,
  };
}

async function remove() {
  const o = await op("delete");
  const made: (string | null)[] = [];
  const parent = join(inst.stateDir, "probe-parent");
  try {
    const a = await create(o, "Probe Alpha");
    made.push(a);
    const wsA = (await agent(o, a!))!.workspace!;
    const b = await create(o, "Probe Beta", { workspace: wsA });
    made.push(b);
    say("Beta's workspace is Alpha's:", (await agent(o, b!))?.workspace === wsA);
    say("cron.add for Alpha:", await call(o, "cron.add", { name: "Probe nightly", agentId: a, schedule: { kind: "every", everyMs: 86_400_000 }, sessionTarget: "isolated", wakeMode: "next-heartbeat", payload: { kind: "agentTurn", message: "#text" }, enabled: false }));
    const run = await o.send(`agent:${a}:main`, "#text");
    say("a task for Alpha:", (await o.terminal(String(run.runId))).state);
    say("what a preview can read for Alpha:", await preview(o, a!));
    say("Alpha's folders on disk before:", { workspace: existsSync(wsA), agentDir: existsSync(join(inst.stateDir, "agents", a!)) });

    say("agents.delete Alpha {deleteFiles: true}:", await call(o, "agents.delete", { agentId: a, deleteFiles: true }));
    say("  after: listed", Boolean(await agent(o, a!)), "workspace on disk", existsSync(wsA), "agents folder", existsSync(join(inst.stateDir, "agents", a!)));
    say("  what a preview reads now for Alpha:", await preview(o, a!));
    say("  routines left for Alpha in the whole list:", JSON.stringify(await call(o, "cron.list", { includeDisabled: true, compact: true })).includes("Probe nightly"));
    say("  Beta still reads its instructions:", (await call(o, "agents.files.get", { agentId: b, name: "AGENTS.md" })).ok);

    say("agents.delete Beta {} (deleteFiles left out):", await call(o, "agents.delete", { agentId: b }));
    say("  after: workspace on disk", existsSync(wsA));

    const c = await create(o, "Probe Gamma");
    made.push(c);
    const wsC = (await agent(o, c!))!.workspace!;
    const run2 = await o.send(`agent:${c}:main`, "#text");
    await o.terminal(String(run2.runId));
    say("agents.delete Gamma {deleteFiles: false}:", await call(o, "agents.delete", { agentId: c, deleteFiles: false }));
    say("  after: listed", Boolean(await agent(o, c!)), "workspace on disk", existsSync(wsC), "sessions folder on disk", existsSync(join(inst.stateDir, "agents", c!, "sessions")), "tasks listed", (await preview(o, c!)).sessions);

    mkdirSync(parent, { recursive: true });
    const d = await create(o, "Probe Delta", { workspace: join(parent, "delta") });
    made.push(d);
    chmodSync(parent, 0o555);
    say("agents.delete Delta {deleteFiles: true} with its workspace's parent read-only:", await call(o, "agents.delete", { agentId: d, deleteFiles: true }));
    say("  after: listed", Boolean(await agent(o, d!)), "workspace on disk", existsSync(join(parent, "delta")));
    chmodSync(parent, 0o755);
    say("agents.delete Delta again, parent writable:", await call(o, "agents.delete", { agentId: d, deleteFiles: true }));
    say("  after: workspace on disk", existsSync(join(parent, "delta")));
    say("agents.delete Delta a third time:", await call(o, "agents.delete", { agentId: d, deleteFiles: true }));

    const all = (await agents(o)).agents.map((x) => x.id);
    say("agents.delete of a bot that does not exist:", await call(o, "agents.delete", { agentId: "probe-nobody" }));
    say("the bots left:", all);
  } finally {
    if (existsSync(parent)) chmodSync(parent, 0o755);
    for (const id of made) await removeQuietly(o, id);
    if (existsSync(parent)) rmSync(parent, { recursive: true, force: true });
    await o.close();
  }
}

function claw(args: string[]) {
  // The tool's runner passes a fixed environment; this command also needs the
  // experimental switch, so it runs here with the same profile and folder.
  const why = inst.runner.refusal();
  if (why) throw new Error(why);
  const port = Number(JSON.parse(String(spawnSync("cat", [join(inst.stateDir, ".clawtrate-dev-gateway")]).stdout)).gatewayPort);
  const env = { ...openclawEnv(process.env, { name: values.instance!, stateDir: inst.stateDir, gatewayPort: port }), OPENCLAW_EXPERIMENTAL_CLAWS: "1" };
  const r = spawnSync("openclaw", ["--profile", `clawtrate-dev-${values.instance}`, "claws", ...args], { cwd: inst.stateDir, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const json = (r: { out: string }) => {
  try {
    return parseJsonOutput<Record<string, any>>(r.out);
  } catch {
    return { unparsed: r.out.slice(0, 800) };
  }
};
const brief = (v: Record<string, any>) => ({
  status: v.status,
  error: v.error,
  keys: Object.keys(v),
  diagnostics: (v.diagnostics ?? []).slice(0, 4).map((d: Record<string, unknown>) => d.code ?? d.message),
  planIntegrity: typeof (v.planIntegrity ?? v.plan?.planIntegrity) === "string",
  actions: (v.plan?.actions ?? v.actions ?? []).map((a: Record<string, unknown>) => a.kind ?? a.type ?? a.action).slice(0, 24),
});

async function claws() {
  const out = mkdtempSync(join(tmpdir(), "claws-"));
  const o = await op("claws");
  const id = await create(o, "Probe Pack");
  let imported: string | null = null;
  try {
    const plain = claw(["export", "pip", "--out", join(out, "pip"), "--json"]);
    say("claws export of a bot not installed from a package (pip): exit", plain.status, brief(json(plain)));
    if (!id) return;
    const look = claw(["migrate", id, "--dry-run", "--json"]);
    const plan = json(look);
    say(`claws migrate ${id} --dry-run: exit`, look.status, brief(plan));
    const digest = plan.planIntegrity ?? plan.plan?.planIntegrity;
    if (look.status === 0 && digest) {
      const applied = claw(["migrate", id, "--yes", "--plan-integrity", digest, "--json"]);
      say(`claws migrate ${id} --yes: exit`, applied.status, brief(json(applied)));
    }
    const exported = claw(["export", id, "--out", join(out, "pack"), "--json"]);
    say(`claws export ${id}: exit`, exported.status, brief(json(exported)));
    if (existsSync(join(out, "pack"))) say("package files:", readdirSync(join(out, "pack"), { recursive: true }));
    const target = ["--agent-id", "probe-pack-import", "--workspace", join(inst.stateDir, "workspace-probe-pack-import")];
    const preview = claw(["add", join(out, "pack"), ...target, "--dry-run", "--json"]);
    const addPlan = json(preview);
    say("claws add --dry-run: exit", preview.status, brief(addPlan));
    const addDigest = addPlan.planIntegrity ?? addPlan.plan?.planIntegrity;
    if (preview.status === 0 && addDigest) {
      const mark = lastSeq(o);
      const added = claw(["add", join(out, "pack"), ...target, "--yes", "--plan-integrity", addDigest, "--json"]);
      say("claws add --yes: exit", added.status, brief(json(added)));
      await sleep(1500);
      say("  the connection saw:", [...new Set(eventsSince(o, mark))], "agents.list has it:", Boolean(await agent(o, "probe-pack-import")));
      imported = "probe-pack-import";
    }
  } finally {
    await removeQuietly(o, imported);
    await removeQuietly(o, id);
    await o.close();
    rmSync(out, { recursive: true, force: true });
  }
}

// Clawtrate's own bot file (docs/design/bots-lifecycle.md, section 9): what
// Duplicate reads, written to a file; what Duplicate writes, read from one. It
// carries the name, label, picture, model by name and effort, and the two
// instruction files when chosen; nothing else, and no unknown field.
const FILE_LIMITS = { file: 5 * 1024 * 1024, text: 256, picture: 32_768, instruction: 2_097_152 };
type BotFile = {
  format: "clawtrate.bot";
  formatVersion: 1;
  writtenBy: string;
  bot: { name: string; label: string | null; picture: string | null; model: string | null; effort: string | null; instructions: { "AGENTS.md"?: string; "SOUL.md"?: string } };
};
/** A real 2 × 2 PNG, so that the picture is one that decodes. */
function realPng(): string {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
  const rows = Buffer.from([0, 88, 194, 111, 91, 141, 255, 0, 255, 133, 82, 169, 139, 255]);
  const { deflateSync } = createRequire(import.meta.url)("node:zlib") as typeof import("node:zlib");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}
/** Whether a data: picture is a PNG whose header and image data are sound (the test a client runs by decoding). */
function decodesAsPng(url: string): boolean {
  const m = /^data:image\/png;base64,(.+)$/.exec(url);
  if (!m) return false;
  const b = Buffer.from(m[1]!, "base64");
  if (b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return false;
  const { inflateSync } = createRequire(import.meta.url)("node:zlib") as typeof import("node:zlib");
  let at = 8;
  const idat: Buffer[] = [];
  while (at < b.length) {
    const len = b.readUInt32BE(at);
    const type = b.subarray(at + 4, at + 8).toString();
    if (type === "IDAT") idat.push(b.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  try {
    return inflateSync(Buffer.concat(idat)).length > 0;
  } catch {
    return false;
  }
}
async function readBot(o: Op, id: string, files: ("AGENTS.md" | "SOUL.md")[]): Promise<BotFile> {
  const a = (await agent(o, id))!;
  const entry = (await configOf(o)).config.agents?.entries?.[id] ?? {};
  const instructions: BotFile["bot"]["instructions"] = {};
  for (const name of files) {
    const f = (await must(o, "agents.files.get", { agentId: id, name })).file as { missing?: boolean; content?: string };
    if (!f.missing) instructions[name] = f.content ?? ""; // a missing file is left out, never written as empty
  }
  const model = (a.model as { primary?: string } | undefined)?.primary ?? null;
  return {
    format: "clawtrate.bot",
    formatVersion: 1,
    writtenBy: "Clawtrate 0.0.0-research",
    bot: {
      name: String(a.name ?? id),
      label: (a.identity?.theme as string | undefined) ?? null,
      picture: (a.identity?.avatarUrl as string | undefined)?.startsWith("data:") ? (a.identity!.avatarUrl as string) : null,
      model: model ? model.replace(/@.*$/, "") : null, // by name: never the account
      effort: entry.thinkingDefault ?? null,
      instructions,
    },
  };
}
const ALLOWED = { top: ["format", "formatVersion", "writtenBy", "bot"], bot: ["name", "label", "picture", "model", "effort", "instructions"], instructions: ["AGENTS.md", "SOUL.md"] };
/** Refuses with a reason before anything is read as a bot. */
function parseBotFile(raw: Buffer): BotFile {
  if (raw.length > FILE_LIMITS.file) throw new Error(`the file is ${raw.length} bytes; at most ${FILE_LIMITS.file}`);
  const v = JSON.parse(raw.toString("utf8")) as Record<string, any>;
  if (v.format !== "clawtrate.bot") throw new Error("not a Clawtrate bot file");
  if (v.formatVersion !== 1) throw new Error(`format version ${v.formatVersion} is not one this version reads`);
  const unknown = [
    ...Object.keys(v).filter((k) => !ALLOWED.top.includes(k)),
    ...Object.keys(v.bot ?? {}).filter((k) => !ALLOWED.bot.includes(k)).map((k) => `bot.${k}`),
    ...Object.keys(v.bot?.instructions ?? {}).filter((k) => !ALLOWED.instructions.includes(k)).map((k) => `bot.instructions.${k}`),
  ];
  if (unknown.length) throw new Error(`it has a field the format doesn't define: ${unknown[0]}`);
  const b = v.bot ?? {};
  const str = (x: unknown, max: number, what: string, nullable = true) => {
    if (x === null && nullable) return;
    if (typeof x !== "string" || x.length > max) throw new Error(`${what} is not text of at most ${max} characters`);
  };
  str(v.writtenBy, FILE_LIMITS.text, "writtenBy", false);
  str(b.name, FILE_LIMITS.text, "name", false);
  str(b.label, FILE_LIMITS.text, "label");
  str(b.model, FILE_LIMITS.text, "model");
  if (typeof b.model === "string" && b.model.includes("@")) throw new Error(`model names an account: ${b.model}`);
  str(b.effort, FILE_LIMITS.text, "effort");
  str(b.picture, FILE_LIMITS.picture, "picture");
  if (b.picture && !decodesAsPng(b.picture)) throw new Error("picture is not an image that decodes");
  for (const [f, text] of Object.entries(b.instructions ?? {})) {
    if (typeof text !== "string" || Buffer.byteLength(text) > FILE_LIMITS.instruction) throw new Error(`${f} is not text of at most ${FILE_LIMITS.instruction} bytes`);
  }
  return v as BotFile;
}
const hash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 12);

async function file() {
  const o = await op("file");
  const dir = mkdtempSync(join(tmpdir(), "bot-file-"));
  const made: (string | null)[] = [];
  try {
    // A source bot with every field the file carries set to a known value.
    const picture = realPng();
    say("the source picture decodes:", decodesAsPng(picture), "characters:", picture.length);
    const src = await create(o, "Probe Source", { avatar: picture });
    made.push(src);
    if (!src) return;
    const fresh = async (id: string, name: string) => ((await must(o, "agents.files.get", { agentId: id, name })).file as { hash: string }).hash;
    await must(o, "agents.files.set", { agentId: src, name: "AGENTS.md", content: "# Probe Source\n\nPlan the week.\nKeep Thursday clear — always.\n", expectedHash: await fresh(src, "AGENTS.md") });
    await must(o, "agents.files.set", { agentId: src, name: "SOUL.md", content: "Calm, brief, kind.\n", expectedHash: await fresh(src, "SOUL.md") });
    const set = await patch(o, { agents: { entries: { [src]: { identity: { theme: "Planning" }, thinkingDefault: "high" } } } });
    say("source settings written:", set.ok ? "ok" : set.error);

    // Export: read, then write the file.
    const out = await readBot(o, src, ["AGENTS.md", "SOUL.md"]);
    const path = join(dir, "probe-source.clawtrate-bot.json");
    writeFileSync(path, JSON.stringify(out, null, 2));
    say("file written:", { bytes: statSync(path).size, keys: Object.keys(out.bot), files: Object.keys(out.bot.instructions), model: out.bot.model, effort: out.bot.effort, label: out.bot.label, pictureChars: out.bot.picture?.length });

    // Import: read and check the file, check the model is offered, then Duplicate's writing half, one row per write.
    const back = parseBotFile(readFileSync(path));
    const models = ((await must(o, "models.list", {})).models as { provider: string; id: string }[]).map((m) => `${m.provider}/${m.id}`);
    say("the file's model is offered here:", models.includes(back.bot.model!));
    say("a name already taken, agents.create {name: \"Probe Source\"}:", (await call(o, "agents.create", { name: back.bot.name })).ok ? "made" : "refused");
    const id = await create(o, "Probe Imported", { model: back.bot.model, avatar: back.bot.picture });
    made.push(id);
    if (!id) return;
    for (const f of ["AGENTS.md", "SOUL.md"] as const)
      if (back.bot.instructions[f] !== undefined) say(`agents.files.set ${f}:`, (await call(o, "agents.files.set", { agentId: id, name: f, content: back.bot.instructions[f], expectedHash: await fresh(id, f) })).ok);
    const wrote = await patch(o, { agents: { entries: { [id]: { identity: { theme: back.bot.label }, thinkingDefault: back.bot.effort, model: { primary: back.bot.model, fallbacks: [] } } } } });
    say("settings written (label, effort, model with an empty fallback list):", wrote.ok ? "ok" : wrote.error);

    // Read both bots again and compare what the file carries.
    const a = await readBot(o, src, ["AGENTS.md", "SOUL.md"]);
    const b = await readBot(o, id, ["AGENTS.md", "SOUL.md"]);
    say("by the reads, the new bot's fields equal the source's:", {
      "AGENTS.md": [hash(a.bot.instructions["AGENTS.md"]!), hash(b.bot.instructions["AGENTS.md"]!), a.bot.instructions["AGENTS.md"] === b.bot.instructions["AGENTS.md"]],
      "SOUL.md": [hash(a.bot.instructions["SOUL.md"]!), hash(b.bot.instructions["SOUL.md"]!), a.bot.instructions["SOUL.md"] === b.bot.instructions["SOUL.md"]],
      label: [a.bot.label, b.bot.label],
      picture: [a.bot.picture?.length, b.bot.picture?.length, a.bot.picture === b.bot.picture, decodesAsPng(b.bot.picture ?? "")],
      model: [a.bot.model, b.bot.model],
      effort: [a.bot.effort, b.bot.effort],
    });

    // Refusals before anything is read as a bot.
    const tryParse = (what: string, raw: Buffer) => {
      try {
        parseBotFile(raw);
        say(`${what}: accepted`);
      } catch (e) {
        say(`${what}: refused, ${(e as Error).message}`);
      }
    };
    tryParse("format version 2", Buffer.from(JSON.stringify({ ...out, formatVersion: 2 })));
    tryParse("a label that is a number", Buffer.from(JSON.stringify({ ...out, bot: { ...out.bot, label: 7 } })));
    tryParse("a tools field", Buffer.from(JSON.stringify({ ...out, bot: { ...out.bot, tools: { deny: ["exec"] } } })));
    tryParse("a model that names an account", Buffer.from(JSON.stringify({ ...out, bot: { ...out.bot, model: "scripted/dev-1@work" } })));
    tryParse("a picture that is a PNG signature and filler", Buffer.from(JSON.stringify({ ...out, bot: { ...out.bot, picture: pngDataUrl(2_000) } })));
    tryParse("a file over 5 MiB", Buffer.alloc(FILE_LIMITS.file + 1, 32));
  } finally {
    for (const x of made) await removeQuietly(o, x);
    rmSync(dir, { recursive: true, force: true });
    await o.close();
  }
}

async function limits() {
  const o = await op("limits");
  const id = await create(o, "Probe Limits");
  try {
    if (!id) return;
    const get = async () => (await must(o, "agents.files.get", { agentId: id, name: "AGENTS.md" })).file as { hash: string; size: number };
    for (const [what, content] of [
      ["2,097,152 bytes of ASCII (the bound)", "a".repeat(2_097_152)],
      ["2,097,153 bytes of ASCII (one over)", "a".repeat(2_097_153)],
      ["699,051 euro signs: 699,051 characters, 2,097,153 bytes", "€".repeat(699_051)],
    ] as const) {
      const before = await get();
      const r = await call(o, "agents.files.set", { agentId: id, name: "AGENTS.md", content, expectedHash: before.hash });
      const after = await get();
      say(`agents.files.set ${what}:`, r.ok ? "ok" : r.error, "file now:", { size: after.size, changed: after.hash !== before.hash });
    }
  } finally {
    await removeQuietly(o, id);
    await o.close();
  }
}

const experiments: Record<string, () => Promise<unknown>> = { list, primary, edit, chat, image, copy, delete: remove, claws, file, limits };
if (!experiment || !experiments[experiment]) {
  console.log(`usage: probe.ts <${Object.keys(experiments).join("|")}> --instance <name>`);
  process.exit(1);
}
await experiments[experiment]!();
setTimeout(() => process.exit(0), 300);
