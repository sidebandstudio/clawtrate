// Probes behind docs/research/skills.md. Research code, not a check.
//
//   git apply docs/research/skills/scripted-model.patch   # #learn, #learn-workshop, #skills
//   pnpm dev-gateway start --instance <name>
//   node docs/research/skills/probe.ts pair --instance <name> --data <dir> [--tier read|interactive|admin]
//   node docs/research/skills/probe.ts <experiment> --instance <name> --data <dir> [--data2 <dir>] [--read <dir>] [--admin <dir>]
//
// It acts only on a named development instance this checkout started, reads
// that instance's address and token from the tool's own run files, and runs
// `openclaw` only through the tool's guarded runner (always with
// `--profile clawtrate-dev-<name>`). Each device is this project's own client
// (`packages/core`), paired the way the desktop app pairs, its keys kept in
// the folder `--data` names. Every printed line passes through `redact`.
//
// Experiments (each prints what it saw and asserts nothing):
//   pair       pair a device, approved with `devices approve <requestId>`, and
//              raise it to --tier with `devices approve` again
//   tiers      every skills.library and skills.workshop method on the read,
//              interactive and admin devices, with harmless arguments
//   library    save, compare-and-set between two devices, refused saves,
//              support files, each mutate verb, list scopes
//   task       a task's pinned revisions: attach, refresh, detach, remove,
//              and what the bot was given (the scripted model's #skills)
//   running    a refresh while a run is in progress
//   perbot     agents.entries.main.skills through config.patch (admin):
//              missing, [], an unknown name, one name; restart and runs
//   extra      a stale mutate, an existing task after a list change, what
//              each tier reads of the config, a stale baseHash
//   stalecfg   a config.patch on a stale baseHash
//   round2     frontmatter a save keeps or loses, a disabled skill's
//              defaults, opposite share writes, an inherited empty list
//   call       one request: --method <m> [--params <json>]
//   workshop   the bot's skill_workshop from a non-admin and an admin
//              device (#learn, #learn-workshop), the change feed, archive
//              and restore
//
// Nothing here reaches beyond loopback, and nothing names a real person: the
// skills are made-up trail and kitchen procedures.

import { mkdirSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, hostname, userInfo } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { ClawtrateClient } from "../../../packages/core/src/client.ts";
import { createNodeHost } from "../../../packages/core/src/node/index.ts";
import { openInstance, readDevConnection } from "../../../tools/dev-gateway/src/cli.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    instance: { type: "string" },
    data: { type: "string" },
    data2: { type: "string" },
    read: { type: "string" },
    admin: { type: "string" },
    tier: { type: "string", default: "interactive" },
    max: { type: "string", default: "1600" },
    method: { type: "string" },
    params: { type: "string", default: "{}" },
  },
  allowPositionals: true,
});
const experiment = positionals[0];
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
const connection = readDevConnection(inst.connectionFile);
if (!connection || connection.instance !== values.instance) throw new Error("no connection record for this instance");

const fullName = (() => {
  try {
    return execFileSync("/usr/bin/id", ["-F"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();
const words = [connection.token, fullName, userInfo().username, hostname(), hostname().split(".")[0]!].filter(
  (w) => w && w.length >= 3,
);
const redact = (text: string) => {
  let out = text.split(homedir()).join("~");
  for (const word of words) out = out.split(word).join("<redacted>");
  return out.replace(/("(?:token|deviceToken|publicKey)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const max = Number(values.max);
const say = (...parts: unknown[]) => {
  const line = redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  console.log(line.length > max ? `${line.slice(0, max)} …(${line.length} chars)` : line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Rec = Record<string, any>;
type Event = { at: number; event: string; payload: Rec };

async function settle(done: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await sleep(100);
}

function runOpenclaw(args: string[]) {
  const result = inst.runner.runSync(args);
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

class Device {
  events: Event[] = [];
  readonly name: string;
  readonly client: ClawtrateClient;
  constructor(name: string, client: ClawtrateClient) {
    this.name = name;
    this.client = client;
    const self = this.client as unknown as { handleEvent: (e: unknown, g: number) => void };
    const original = self.handleEvent.bind(this.client);
    self.handleEvent = (e, g) => {
      const frame = e as { event: string; payload: Rec };
      this.events.push({ at: Date.now(), event: frame.event, payload: frame.payload });
      original(e, g);
    };
  }
  get scopes() {
    return this.client.state.connection.scopes;
  }
  async request(method: string, params: unknown): Promise<any> {
    return (this.client as unknown as { request: (m: string, p: unknown) => Promise<unknown> }).request(method, params);
  }
  async attempt(method: string, params: unknown) {
    try {
      return { ok: true as const, result: await this.request(method, params) };
    } catch (error) {
      const e = error as Error & { code?: string; gatewayCode?: string; details?: Rec };
      return { ok: false as const, error: { code: e.gatewayCode ?? e.code, message: e.message, details: e.details } };
    }
  }
  stop() {
    this.client.stop();
  }
}

function coreClient(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return new ClawtrateClient(
    createNodeHost({
      dataDir: dir,
      client: { displayName: "Clawtrate Desktop", version: "0.0.0-research", platform: process.platform },
    }),
    { reconnect: { initialMs: 500, maxMs: 2000 } },
  );
}

async function device(dir: string | undefined, name: string): Promise<Device> {
  if (!dir) throw new Error(`a folder for device ${name} is required`);
  const client = coreClient(dir);
  const d = new Device(name, client);
  await client.start();
  await settle(() => client.state.connection.status === "connected");
  if (client.state.connection.status !== "connected") throw new Error(`${name} not connected: ${client.state.connection.status}`);
  await sleep(300);
  return d;
}

async function pair() {
  if (!values.data) throw new Error("--data <dir> is required");
  const client = coreClient(values.data);
  await client.start();
  await client.connect({ url: connection!.url, token: connection!.token });
  await settle(() => ["connected", "pairing", "error"].includes(client.state.connection.status));
  const requestId = client.state.connection.pairing?.requestId;
  if (requestId) say(`devices approve <request>: exit ${runOpenclaw(["devices", "approve", requestId]).status}`);
  await settle(() => client.state.connection.status === "connected", 20_000);
  say("paired:", { status: client.state.connection.status, scopes: client.state.connection.scopes });
  if (values.tier !== "read") {
    const tier = values.tier === "admin" ? "admin" : "interactive";
    void client.requestAccess(tier).catch((e: unknown) => say("requestAccess:", String(e)));
    await settle(() => !["idle", "requesting"].includes(client.state.connection.upgrade.status), 10_000);
    const upgradeId = client.state.connection.upgrade.requestId;
    if (upgradeId) say(`devices approve <upgrade>: exit ${runOpenclaw(["devices", "approve", upgradeId]).status}`);
    await settle(() => (tier === "admin" ? client.state.connection.canAdmin : client.state.connection.canWrite), 20_000);
    await sleep(1000);
    say("scopes now:", client.state.connection.scopes);
  }
  client.stop();
}

// ---------------------------------------------------------------------------
// Skills used below: made-up procedures.

const skillText = (slug: string, description: string, body: string) =>
  `---\nname: ${slug}\ndescription: ${description}\n---\n\n${body}\n`;
const tag = randomUUID().slice(0, 6);
const short = (r: unknown) => {
  const x = r as { ok: boolean; result?: Rec; error?: Rec };
  if (!x.ok) return { error: x.error };
  return x.result;
};
const entryView = (e: Rec | undefined) =>
  e && {
    skillId: e.skillId,
    slug: e.slug,
    name: e.name,
    ownerLabel: e.ownerLabel,
    ownerProfileId: e.ownerProfileId ? "<profile>" : e.ownerProfileId,
    shared: e.shared,
    enabled: e.enabled,
    removed: e.removed,
    revision: String(e.revision).slice(0, 12),
    canEdit: e.canEdit,
    description: e.description,
  };
const receipt = (r: unknown) => {
  const x = r as { ok: boolean; result?: Rec; error?: Rec };
  if (!x.ok) return { error: x.error };
  return { state: x.result!.state, target: x.result!.target, sessionActivation: x.result!.sessionActivation, nextAction: x.result!.nextAction, entry: entryView(x.result!.entry) };
};

async function tiers() {
  const r = await device(values.read, "read");
  const a = await device(values.data, "interactive");
  const x = await device(values.admin, "admin");
  try {
    const seeded = await a.attempt("skills.library.save", {
      expectedRevision: null,
      slug: `tier-check-${tag}`,
      content: skillText(`tier-check-${tag}`, "Use when checking the tiers.", "Say which tier you are."),
    });
    const id = seeded.ok ? seeded.result.entry.skillId : "00000000-0000-0000-0000-000000000000";
    const rev = seeded.ok ? seeded.result.entry.revision : "0".repeat(64);
    say("seed save (interactive):", receipt(seeded));
    const task = await a.request("sessions.create", { agentId: "main", label: `tiers ${tag}` });
    const calls: [string, unknown][] = [
      ["skills.library.list", { scope: "all" }],
      ["skills.library.read", { skillId: id }],
      ["skills.library.save", { expectedRevision: null, slug: `tier-new-${tag}`, content: skillText(`tier-new-${tag}`, "Use when testing.", "Nothing.") }],
      ["skills.library.mutate", { skillId: id, expectedRevision: rev, action: "disable" }],
      ["skills.library.activate", { sessionKey: task.key, action: "attach", skillId: id }],
      ["skills.workshop.list", { agentId: "main" }],
      ["skills.workshop.changes", { agentId: "main", limit: 5 }],
      ["skills.workshop.read", { agentId: "main", name: "no-such-skill" }],
      ["skills.workshop.archive", { agentId: "main", name: "no-such-skill" }],
      ["skills.workshop.restore", { agentId: "main", name: "no-such-skill" }],
      ["skills.status", { agentId: "main" }],
    ];
    for (const d of [r, a, x]) {
      say(`== ${d.name} device, scopes`, d.scopes);
      for (const [method, params] of calls) {
        const res = await d.attempt(method, params);
        const brief = res.ok
          ? method === "skills.library.list"
            ? { profileId: res.result.profileId ? "<profile>" : res.result.profileId, defaultTarget: res.result.defaultTarget, multipleProfiles: res.result.multipleProfiles, canManageWorkspace: res.result.canManageWorkspace, entries: res.result.entries.length }
            : method === "skills.status"
              ? { skills: res.result.skills?.length }
              : method.startsWith("skills.library")
                ? receipt(res)
                : res.result
          : res;
        say(`  ${method}:`, brief);
        // Put a state-changing success back where it was.
        if (res.ok && method === "skills.library.mutate") {
          const back = await a.attempt("skills.library.mutate", { skillId: id, expectedRevision: res.result.entry.revision, action: "enable" });
          say("    enabled again:", back.ok);
        }
      }
    }
  } finally {
    for (const d of [r, a, x]) d.stop();
  }
}

async function library() {
  const a = await device(values.data, "A");
  const b = await device(values.data2, "B");
  const r = await device(values.read, "read");
  try {
    const slug = `trail-checklist-${tag}`;
    const v1 = skillText(slug, "Use when planning a weekend walk.", "1. Check the forecast.\n2. Pack water.");
    const saved = await a.attempt("skills.library.save", { expectedRevision: null, slug, content: v1 });
    say("1. A saves a new skill:", receipt(saved));
    const id = saved.result.entry.skillId;
    const rev1 = saved.result.entry.revision;
    say("   whole result keys:", Object.keys(saved.result), "entry keys:", Object.keys(saved.result.entry));
    const readB = await b.attempt("skills.library.read", { skillId: id });
    say("2. B reads it:", { entry: entryView(readB.result?.entry), revisions: readB.result?.revisions?.length, content: readB.result?.content, files: readB.result?.files });
    const v2a = v1.replace("Pack water.", "Pack water and a map.");
    const saveA = await a.attempt("skills.library.save", { skillId: id, expectedRevision: rev1, slug, content: v2a });
    say("3. A saves an edit on revision 1:", receipt(saveA));
    const v2b = v1.replace("Check the forecast.", "Check the forecast and the sunset.");
    const saveB = await b.attempt("skills.library.save", { skillId: id, expectedRevision: rev1, slug, content: v2b });
    say("4. B saves its own edit, also on revision 1:", saveB.ok ? receipt(saveB) : saveB.error);
    const now = await b.attempt("skills.library.read", { skillId: id });
    say("   what B reads now:", { revision: String(now.result.entry.revision).slice(0, 12), content: now.result.content, revisions: now.result.revisions.map((x: Rec) => String(x.revision).slice(0, 12)) });
    const retryB = await b.attempt("skills.library.save", { skillId: id, expectedRevision: now.result.entry.revision, slug, content: v2b });
    say("5. B saves again on the current revision (its text replaces A's):", receipt(retryB));
    const old = await a.attempt("skills.library.read", { skillId: id, revision: saveA.result.entry.revision });
    say("   A's revision is still readable by id:", { ok: old.ok, content: old.result?.content });
    const same = await a.attempt("skills.library.save", { skillId: id, expectedRevision: retryB.result.entry.revision, slug, content: v2b });
    say("6. the same text saved again:", receipt(same));

    say("7. refused saves:");
    const tries: [string, Rec][] = [
      ["a name already taken (new skill, same slug)", { expectedRevision: null, slug, content: skillText(slug, "Other.", "Other.") }],
      ["an invalid name (capitals and a space)", { expectedRevision: null, slug: "Trail Checklist", content: v1 }],
      ["a name of 64 characters", { expectedRevision: null, slug: "a".repeat(64), content: v1 }],
      ["frontmatter name differs from the slug", { expectedRevision: null, slug: `other-name-${tag}`, content: v1 }],
      ["an empty body", { expectedRevision: null, slug: `empty-${tag}`, content: "" }],
      ["frontmatter only, no instructions", { expectedRevision: null, slug: `bare-${tag}`, content: `---\nname: bare-${tag}\ndescription: Use when bare.\n---\n` }],
      ["no description", { expectedRevision: null, slug: `nodesc-${tag}`, content: `---\nname: nodesc-${tag}\n---\n\nDo it.\n` }],
      ["no frontmatter", { expectedRevision: null, slug: `nofm-${tag}`, content: "Just do it.\n" }],
      ["a description of 1,025 characters", { expectedRevision: null, slug: `longdesc-${tag}`, content: skillText(`longdesc-${tag}`, "x".repeat(1025), "Do it.") }],
      ["instructions of 1,048,576 characters", { expectedRevision: null, slug: `big-${tag}`, content: skillText(`big-${tag}`, "Use when big.", "y".repeat(1_048_576 - 60)) }],
      ["instructions of 1,048,577 characters", { expectedRevision: null, slug: `huge-${tag}`, content: "z".repeat(1_048_577) }],
      ["a literal key in the instructions", { expectedRevision: null, slug: `key-${tag}`, content: skillText(`key-${tag}`, "Use when calling the weather service.", "Call it with the key sk-ant-api03-" + "A".repeat(93) + "AA.") }],
      ["a wrong expectedRevision on a new skill", { expectedRevision: rev1, slug: `newrev-${tag}`, content: skillText(`newrev-${tag}`, "Use.", "Do.") }],
    ];
    for (const [label, params] of tries) {
      const res = await a.attempt("skills.library.save", params);
      say(`   ${label}:`, res.ok ? receipt(res) : res.error);
      if (res.ok) await a.attempt("skills.library.mutate", { skillId: res.result.entry.skillId, expectedRevision: res.result.entry.revision, action: "remove" });
    }
    const big = (await a.attempt("skills.library.list", { scope: "mine" })).result.entries.find((e: Rec) => e.slug === `big-${tag}`);
    say("   the 1 MiB one listed afterwards?", Boolean(big));

    say("8. support files:");
    const withFiles = await a.attempt("skills.library.save", {
      expectedRevision: null,
      slug: `kitchen-timer-${tag}`,
      content: skillText(`kitchen-timer-${tag}`, "Use when timing a recipe.", "Run scripts/timer.sh with the minutes.\nRead references/times.md for common times."),
      files: [
        { path: "scripts/timer.sh", content: "#!/bin/sh\nsleep $(( $1 * 60 )); echo done\n", executable: true },
        { path: "references/times.md", content: "Rice: 18 minutes.\n" },
      ],
    });
    say("   saved with a script and a note:", receipt(withFiles));
    const fid = withFiles.result?.entry.skillId;
    const frev = withFiles.result?.entry.revision;
    const fread = await r.attempt("skills.library.read", { skillId: fid });
    say("   read (read-only device):", { files: fread.result?.files?.map((f: Rec) => ({ path: f.path, executable: f.executable, encoding: f.encoding, bytes: String(f.content ?? "").length })) });
    const dir = join(inst.stateDir, "skill-library", fid, "revisions", frev);
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [`${relative(inst.stateDir, join(d, n))} mode ${(statSync(join(d, n)).mode & 0o777).toString(8)}`]));
    say("   on disk, under the state folder:", existsSync(dir) ? walk(dir) : "not found");
    const kept = await a.attempt("skills.library.save", { skillId: fid, expectedRevision: frev, slug: `kitchen-timer-${tag}`, content: skillText(`kitchen-timer-${tag}`, "Use when timing a recipe.", "Run scripts/timer.sh."), retainFiles: ["scripts/timer.sh"] });
    say("   an edit that keeps only the script (retainFiles):", receipt(kept));
    const kread = await a.attempt("skills.library.read", { skillId: fid });
    say("   files now:", kread.result?.files?.map((f: Rec) => f.path));
    const dropped = await a.attempt("skills.library.save", { skillId: fid, expectedRevision: kept.result.entry.revision, slug: `kitchen-timer-${tag}`, content: skillText(`kitchen-timer-${tag}`, "Use when timing a recipe.", "Time it by hand.") });
    const dread = await a.attempt("skills.library.read", { skillId: fid });
    say("   an edit without files or retainFiles:", receipt(dropped), "files now:", dread.result?.files?.map((f: Rec) => f.path));
    const requires = await a.attempt("skills.library.save", {
      expectedRevision: null,
      slug: `weather-${tag}`,
      content: `---\nname: weather-${tag}\ndescription: Use when asked about the weather.\nmetadata: {"openclaw":{"requires":{"bins":["curl"],"env":["WEATHER_API_KEY"]},"primaryEnv":"WEATHER_API_KEY"}}\n---\n\nCall the weather service with curl and $WEATHER_API_KEY.\n`,
    });
    say("   a skill that names a program and an environment value:", receipt(requires));
    const status = await a.attempt("skills.status", { agentId: "main" });
    const st = status.result?.skills?.find((s: Rec) => String(s.name).includes("weather") || String(s.skillKey).includes(`weather-${tag}`));
    say("   skills.status for Juniper lists it?", st ? { name: st.name, source: st.source, eligible: st.eligible, missing: st.missing, primaryEnv: st.primaryEnv } : `no (${status.result?.skills?.length} skills listed)`);

    say("9. mutate, each verb, on A's skill:");
    let cur = (await a.attempt("skills.library.read", { skillId: id })).result.entry;
    for (const action of ["disable", "enable", "share", "unshare", "transfer", "rollback", "remove"]) {
      const params: Rec = { skillId: id, expectedRevision: cur.revision, action };
      if (action === "rollback") params.revision = rev1;
      const res = await a.attempt("skills.library.mutate", params);
      say(`   ${action}:`, receipt(res));
      if (res.ok) cur = res.result.entry;
      for (const scope of ["mine", "team", "all"]) {
        const l = await b.attempt("skills.library.list", { scope });
        const found = l.result?.entries?.find((e: Rec) => e.skillId === id);
        if (action === "share" || action === "unshare" || action === "remove") say(`     B lists scope ${scope}:`, found ? { shared: found.shared, enabled: found.enabled } : "absent");
      }
    }
    const stale = await a.attempt("skills.library.mutate", { skillId: id, expectedRevision: rev1, action: "enable" });
    say("   a mutate on a removed skill:", stale.ok ? receipt(stale) : stale.error);
    const readRemoved = await a.attempt("skills.library.read", { skillId: id });
    say("   read a removed skill by id:", readRemoved.ok ? { removed: readRemoved.result.entry.removed } : readRemoved.error);
    const sameName = await a.attempt("skills.library.save", { expectedRevision: null, slug, content: v1 });
    say("   a new skill with the removed one's name:", receipt(sameName));
    const conflictMutate = await b.attempt("skills.library.mutate", { skillId: sameName.result.entry.skillId, expectedRevision: rev1, action: "disable" });
    say("   a mutate with a stale revision:", conflictMutate.ok ? receipt(conflictMutate) : conflictMutate.error);
    const readOnlySave = await r.attempt("skills.library.save", { expectedRevision: null, slug: `ro-${tag}`, content: v1 });
    say("   a save from the read-only device:", readOnlySave.ok ? receipt(readOnlySave) : readOnlySave.error);
    say("   events A received during all this:", [...new Set(a.events.map((e) => e.event))]);
    say("   events B received during all this:", [...new Set(b.events.map((e) => e.event))]);
  } finally {
    for (const d of [a, b, r]) d.stop();
  }
}

/** Send a message and wait for its run's terminal chat event; return the run's id and final text. */
async function turn(d: Device, key: string, message: string, ms = 60_000) {
  const mark = d.events.length;
  const sent = await d.request("chat.send", { sessionKey: key, message, idempotencyKey: randomUUID() });
  const runId = sent.runId;
  const deadline = Date.now() + ms;
  let end: Event | undefined;
  while (Date.now() < deadline && !end) {
    end = d.events.slice(mark).find((e) => e.event === "chat" && e.payload?.runId === runId && ["final", "error", "aborted"].includes(e.payload?.state));
    if (!end) await sleep(150);
  }
  const text = end?.payload?.message?.content?.map?.((c: Rec) => c.text ?? "").join("") ?? end?.payload?.errorMessage ?? null;
  return { runId, state: end?.payload?.state ?? "timeout", text, events: d.events.slice(mark).filter((e) => e.payload?.runId === runId) };
}

const selections = async (d: Device, key: string) => {
  const l = await d.attempt("skills.library.list", { sessionKey: key });
  if (!l.ok) return l.error;
  return (l.result.session?.selections ?? []).map((s: Rec) => ({ slug: s.slug, revision: String(s.revision).slice(0, 12) }));
};
const libraryLines = (text: string | null, slug: string) =>
  (text ?? "").split("\n").filter((l) => l.includes(slug.replace(/-+/g, "_").slice(0, 9).replace(/_+$/, "")) || l.startsWith("I was given no"));

async function task() {
  const a = await device(values.data, "A");
  try {
    const slug = `pack-list-${tag}`;
    const s1 = await a.attempt("skills.library.save", { expectedRevision: null, slug, content: skillText(slug, "Use when packing for a trip.", "Pack light.") });
    const id = s1.result.entry.skillId;
    say("saved", slug, "revision", String(s1.result.entry.revision).slice(0, 12), "command name", s1.result.entry.name);
    const created = await a.request("sessions.create", { agentId: "main", label: `pins ${tag}` });
    const key = created.key;
    say("1. a new task, before any message: selections", await selections(a, key));
    const t1 = await turn(a, key, "#skills");
    say("   after its first message: selections", await selections(a, key));
    say("   the bot was given (library lines):", libraryLines(t1.text, slug), "| all:", t1.text);
    const s2 = await a.attempt("skills.library.save", { skillId: id, expectedRevision: s1.result.entry.revision, slug, content: skillText(slug, "Use when packing for a trip.", "Pack light, and bring a layer.") });
    say("2. a saved edit, revision", String(s2.result.entry.revision).slice(0, 12), "; the task's selections:", await selections(a, key));
    const t2 = await turn(a, key, "#skills");
    say("   the bot was given:", libraryLines(t2.text, slug));
    const created2 = await a.request("sessions.create", { agentId: "main", label: `pins new ${tag}` });
    await turn(a, created2.key, "#skills");
    say("   a task created after the edit: selections", await selections(a, created2.key));
    const refresh = await a.attempt("skills.library.activate", { sessionKey: key, action: "refresh" });
    say("3. activate refresh:", refresh.ok ? { sessionActivation: refresh.result.sessionActivation, selections: refresh.result.selections.map((x: Rec) => ({ name: x.name, revision: String(x.revision).slice(0, 12) })) } : refresh.error);
    const t3 = await turn(a, key, "#skills");
    say("   the next turn was given:", libraryLines(t3.text, slug));
    const detach = await a.attempt("skills.library.activate", { sessionKey: key, action: "detach", skillId: id });
    say("4. detach:", detach.ok ? { selections: detach.result.selections.length } : detach.error);
    const t4 = await turn(a, key, "#skills");
    say("   the next turn was given:", libraryLines(t4.text, slug));
    const attachOld = await a.attempt("skills.library.activate", { sessionKey: key, action: "attach", skillId: id, revision: s1.result.entry.revision });
    say("5. attach revision 1 explicitly:", attachOld.ok ? attachOld.result.selections.map((x: Rec) => String(x.revision).slice(0, 12)) : attachOld.error);
    const readPinned = await a.attempt("skills.library.read", { skillId: id, revision: s1.result.entry.revision, sessionKey: key });
    say("   read with the task's key and its pinned revision:", readPinned.ok ? { revision: String(readPinned.result.entry.revision).slice(0, 12), canEdit: readPinned.result.entry.canEdit, content: readPinned.result.content } : readPinned.error);
    const readOther = await a.attempt("skills.library.read", { skillId: id, revision: s2.result.entry.revision, sessionKey: key });
    say("   read with the task's key and another revision:", readOther.ok ? "ok" : readOther.error);
    const cur = (await a.attempt("skills.library.read", { skillId: id })).result.entry;
    const removed = await a.attempt("skills.library.mutate", { skillId: id, expectedRevision: cur.revision, action: "remove" });
    say("6. remove the skill:", receipt(removed));
    say("   the task's selections:", await selections(a, key));
    const t6 = await turn(a, key, "#skills");
    say("   the next turn:", t6.state, libraryLines(t6.text, slug));
    const refreshAfter = await a.attempt("skills.library.activate", { sessionKey: key, action: "refresh" });
    say("   refresh after the remove:", refreshAfter.ok ? refreshAfter.result.selections.length : refreshAfter.error);
    const attachRemoved = await a.attempt("skills.library.activate", { sessionKey: key, action: "attach", skillId: id });
    say("   attach after the remove:", attachRemoved.ok ? "ok" : attachRemoved.error);
    const created3 = await a.request("sessions.create", { agentId: "main", label: `pins after ${tag}` });
    const t7 = await turn(a, created3.key, "#skills");
    say("   a new task after the remove:", await selections(a, created3.key), libraryLines(t7.text, slug));
    const desc = await a.attempt("sessions.describe", { key });
    say("   sessions.describe carries the selections?", JSON.stringify(desc.result ?? desc.error).includes("skillLibrarySelections"), Object.keys(desc.result?.session ?? {}).filter((k) => /skill/i.test(k)));
    const list = await a.attempt("sessions.list", { agentId: "main", limit: 5 });
    say("   sessions.list rows carry them?", JSON.stringify(list.result ?? {}).includes("skillLibrarySelections"));
  } finally {
    a.stop();
  }
}

async function running() {
  const a = await device(values.data, "A");
  try {
    const slug = `river-crossing-${tag}`;
    const s1 = await a.attempt("skills.library.save", { expectedRevision: null, slug, content: skillText(slug, "Use when a trail crosses a river.", "Unbuckle the hip belt.") });
    const id = s1.result.entry.skillId;
    const created = await a.request("sessions.create", { agentId: "main", label: `running ${tag}` });
    const key = created.key;
    await turn(a, key, "#text");
    say("pinned:", await selections(a, key));
    const s2 = await a.attempt("skills.library.save", { skillId: id, expectedRevision: s1.result.entry.revision, slug, content: skillText(slug, "Use when a trail crosses a river.", "Unbuckle the hip belt and face upstream.") });
    say("saved revision", String(s2.result.entry.revision).slice(0, 12));
    const pending = turn(a, key, "#slow-tool 6 #skills", 90_000);
    await sleep(2500);
    const refresh = await a.attempt("skills.library.activate", { sessionKey: key, action: "refresh" });
    say("refresh during the run:", refresh.ok ? { sessionActivation: refresh.result.sessionActivation, selections: refresh.result.selections.map((x: Rec) => String(x.revision).slice(0, 12)) } : refresh.error);
    const done = await pending;
    say("the running turn, after its slow tool, was given:", done.state, libraryLines(done.text, slug));
    const next = await turn(a, key, "#skills");
    say("the next turn was given:", libraryLines(next.text, slug));
  } finally {
    a.stop();
  }
}

async function perbot() {
  const x = await device(values.admin, "admin");
  const a = await device(values.data, "A");
  try {
    const slug = `lake-loop-${tag}`;
    const s = await a.attempt("skills.library.save", { expectedRevision: null, slug, content: skillText(slug, "Use when walking the lake loop.", "Go clockwise.") });
    const commandName = s.result.entry.name;
    say("library skill", slug, "command name", commandName);
    const cfg = await x.request("config.get", {});
    const entry = cfg.config.agents?.entries?.main ?? {};
    say("Juniper's entry has skills?", Object.hasOwn(entry, "skills"), "defaults.skills:", cfg.config.agents?.defaults?.skills ?? "unset");
    const seen = async (label: string) => {
      const created = await a.request("sessions.create", { agentId: "main", label: `${label} ${tag}` });
      const t = await turn(a, created.key, "#skills");
      const status = await a.attempt("skills.status", { agentId: "main", sessionKey: created.key });
      const lib = status.result?.skills?.filter((k: Rec) => k.source === "openclaw-library") ?? [];
      const bundled = status.result?.skills?.find((k: Rec) => k.name === "weather");
      say(`  ${label}: a new task was given:`, t.text?.split("\n").length ?? 0, "lines;", libraryLines(t.text, slug), "| skills.status, this skill:", lib.filter((k: Rec) => k.name === commandName).map((k: Rec) => ({ name: k.name, blockedByAllowlist: k.blockedByAllowlist, eligible: k.eligible })), "a bundled one:", bundled && { name: bundled.name, blockedByAllowlist: bundled.blockedByAllowlist, eligible: bundled.eligible });
      return t;
    };
    await seen("missing list");
    const patchSkills = async (value: unknown) => {
      const { hash } = await x.request("config.get", {});
      const before = x.client.state.connection.status;
      const mark = x.events.length;
      const res = await x.attempt("config.patch", { raw: JSON.stringify({ agents: { entries: { main: { skills: value } } } }), baseHash: hash, replacePaths: ["agents.entries.main.skills"] });
      await sleep(1500);
      const back = await x.request("config.get", {});
      say(`config.patch skills=${JSON.stringify(value)}:`, res.ok ? { keys: Object.keys(res.result), changedPaths: res.result.changedPaths, restart: res.result.restart ?? "absent", sentinel: res.result.sentinel, noop: res.result.noop } : res.error, "| events on the admin device:", [...new Set(x.events.slice(mark).map((e) => e.event))], "| connection before/after:", before, x.client.state.connection.status, "| read back:", Object.hasOwn(back.config.agents.entries.main, "skills") ? back.config.agents.entries.main.skills : "missing");
      return res;
    };
    await patchSkills([]);
    await seen("empty list");
    await patchSkills(["no-such-skill"]);
    await seen("unknown name only");
    await patchSkills([commandName]);
    await seen("its command name");
    await patchSkills([slug]);
    await seen("its slug");
    // A write while a run is in progress.
    const created = await a.request("sessions.create", { agentId: "main", label: `during ${tag}` });
    const mark = a.events.length;
    const pending = turn(a, created.key, "#slow 8", 60_000);
    await sleep(2000);
    await patchSkills(null);
    const done = await pending;
    say("a run in progress during the write ended:", done.state, "| A's connection:", a.client.state.connection.status, "| events A saw meanwhile:", [...new Set(a.events.slice(mark).map((e) => e.event))]);
    const restored = await x.request("config.get", {});
    say("Juniper's entry has skills after null?", Object.hasOwn(restored.config.agents.entries.main, "skills"));
  } finally {
    x.stop();
    a.stop();
  }
}

/** One tool call of a run, as the agent stream and the history show it. */
function toolCalls(events: Event[]) {
  return events
    .filter((e) => e.event === "agent" && e.payload?.stream === "tool")
    .map((e) => ({ phase: e.payload.data?.phase, name: e.payload.data?.name, args: e.payload.data?.args, isError: e.payload.data?.isError, result: JSON.stringify(e.payload.data?.result ?? null).slice(0, 700) }));
}

async function workshop() {
  const x = await device(values.admin, "admin");
  const a = await device(values.data, "A");
  const r = await device(values.read, "read");
  try {
    // Offer the bot its skill_workshop tool, which the development config denies.
    const cfg = await x.request("config.get", {});
    const deny = (cfg.config.tools.deny as string[]).filter((t) => t !== "skill_workshop");
    const allow = [...new Set([...(cfg.config.tools.allow as string[]), "skill_workshop"])];
    const res = await x.attempt("config.patch", { raw: JSON.stringify({ tools: { deny, allow } }), baseHash: cfg.hash, replacePaths: ["tools.deny"] });
    say("config.patch tools.deny without skill_workshop, tools.allow with it:", res.ok ? { changedPaths: res.result.changedPaths, restart: res.result.restart } : res.error);
    await sleep(2000);
    for (const [d, label] of [
      [a, "interactive (non-admin) device"],
      [x, "admin device"],
    ] as const) {
      for (const directive of ["#learn", "#learn-workshop"]) {
        const created = await d.request("sessions.create", { agentId: "main", label: `${directive} ${label} ${tag}` });
        await d.attempt("sessions.messages.subscribe", { key: created.key });
        const all = d.events.length;
        const t = await turn(d, created.key, directive);
        say(`${label} ${directive}: run ${t.state}, reply:`, t.text);
        say("  tool events:", toolCalls(t.events));
        const kinds = [...new Set(d.events.slice(all).map((e) => e.event))];
        say("  event kinds meanwhile:", kinds, "| approvals:", d.events.slice(all).filter((e) => /approval/.test(e.event)).length);
        const hist = await d.request("chat.history", { sessionKey: created.key, limit: 20 });
        const rows = (hist.messages ?? []).map((m: Rec) => ({ role: m.role, content: (Array.isArray(m.content) ? m.content : [{ type: "string", text: m.content }]).map((c: Rec) => ({ type: c.type, name: c.name, args: c.arguments ?? c.input, text: typeof c.text === "string" ? c.text.slice(0, 300) : undefined })) }));
        say("  history rows:", rows);
      }
    }
    const lib = await a.attempt("skills.library.list", { scope: "mine" });
    say("library now has:", lib.result.entries.filter((e: Rec) => e.slug === "trail-checklist").map(entryView));
    for (const d of [r, a, x]) {
      say(`== workshop reads on the ${d.name} device`);
      const list = await d.attempt("skills.workshop.list", { agentId: "main" });
      say("  list:", list.ok ? { mode: list.result.mode, root: list.result.root, skills: list.result.skills, archived: list.result.archived } : list.error);
      const read = await d.attempt("skills.workshop.read", { agentId: "main", name: "trail-checklist" });
      say("  read:", read.ok ? read.result : read.error);
      const changes = await d.attempt("skills.workshop.changes", { agentId: "main", limit: 10 });
      say("  changes:", changes.ok ? changes.result : changes.error);
    }
    const archA = await a.attempt("skills.workshop.archive", { agentId: "main", name: "trail-checklist", reason: "Not needed." });
    say("archive from the interactive device:", archA.ok ? archA.result : archA.error);
    const arch = await x.attempt("skills.workshop.archive", { agentId: "main", name: "trail-checklist", reason: "Not needed this season." });
    say("archive from the admin device:", arch.ok ? arch.result : arch.error);
    say("  list after:", short(await x.attempt("skills.workshop.list", { agentId: "main" })));
    const readArchived = await x.attempt("skills.workshop.read", { agentId: "main", name: "trail-checklist" });
    say("  read the archived skill:", readArchived.ok ? "ok" : readArchived.error);
    const again = await x.attempt("skills.workshop.archive", { agentId: "main", name: "trail-checklist" });
    say("  archive it again:", again.ok ? again.result : again.error);
    const restore = await x.attempt("skills.workshop.restore", { agentId: "main", name: "trail-checklist" });
    say("restore from the admin device:", restore.ok ? restore.result : restore.error);
    say("  list after:", short(await x.attempt("skills.workshop.list", { agentId: "main" })));
    say("  changes after:", short(await r.attempt("skills.workshop.changes", { agentId: "main", limit: 10 })));
    // Workshop skills and the per-bot list.
    const { hash } = await x.request("config.get", {});
    const p = await x.attempt("config.patch", { raw: JSON.stringify({ agents: { entries: { main: { skills: [] } } } }), baseHash: hash });
    say("with skills [] for Juniper:", p.ok ? "patched" : p.error);
    await sleep(1500);
    const created = await a.request("sessions.create", { agentId: "main", label: `workshop and list ${tag}` });
    const t = await turn(a, created.key, "#skills");
    say("  a new task was given:", t.text);
    say("  events the read-only device received:", [...new Set(r.events.map((e) => e.event))]);
    const { hash: h2 } = await x.request("config.get", {});
    const back = await x.attempt("config.patch", { raw: JSON.stringify({ agents: { entries: { main: { skills: null } } } }), baseHash: h2, replacePaths: ["agents.entries.main.skills"] });
    say("  Juniper's list put back:", back.ok ? "ok" : back.error);
  } finally {
    for (const d of [x, a, r]) d.stop();
  }
}


async function extra() {
  const x = await device(values.admin, "admin");
  const a = await device(values.data, "A");
  const r = await device(values.read, "read");
  try {
    const slug = `ridge-walk-${tag}`;
    const s1 = await a.attempt("skills.library.save", { expectedRevision: null, slug, content: skillText(slug, "Use when walking the ridge.", "Start early.") });
    const id = s1.result.entry.skillId;
    const s2 = await a.attempt("skills.library.save", { skillId: id, expectedRevision: s1.result.entry.revision, slug, content: skillText(slug, "Use when walking the ridge.", "Start early, carry water.") });
    const stale = await a.attempt("skills.library.mutate", { skillId: id, expectedRevision: s1.result.entry.revision, action: "disable" });
    say("1. a mutate naming the earlier revision:", stale.ok ? receipt(stale) : stale.error);
    const staleShare = await a.attempt("skills.library.mutate", { skillId: id, expectedRevision: s1.result.entry.revision, action: "share" });
    say("   a share naming the earlier revision:", staleShare.ok ? receipt(staleShare) : staleShare.error);
    say("   (current revision", String(s2.result.entry.revision).slice(0, 12), ")");
    // An existing task, then a list change.
    const created = await a.request("sessions.create", { agentId: "main", label: `existing ${tag}` });
    const t1 = await turn(a, created.key, "#skills");
    say("2. an existing task's turn before the change:", libraryLines(t1.text, slug));
    const { hash } = await x.request("config.get", {});
    const pr = await x.attempt("config.patch", { raw: JSON.stringify({ agents: { entries: { main: { skills: [] } } } }), baseHash: hash, replacePaths: ["agents.entries.main.skills"] });
    say("   config.patch skills=[]:", pr.ok ? "ok" : pr.error);
    await sleep(1500);
    const t2 = await turn(a, created.key, "#skills");
    say("   the same task's next turn:", t2.text);
    say("   its selections still:", (await selections(a, created.key)).filter((x: Rec) => x.slug === slug));
    // What each tier reads of the config.
    for (const d of [r, a, x]) {
      const got = await d.attempt("config.get", {});
      say(`3. config.get on the ${d.name} device:`, got.ok ? { keys: Object.keys(got.result), mainSkills: got.result.config?.agents?.entries?.main?.skills ?? "missing", hasHash: Boolean(got.result.hash) } : got.error);
      const agents = await d.attempt("agents.list", {});
      say(`   agents.list on the ${d.name} device, Juniper's row keys:`, agents.ok ? Object.keys(agents.result.agents.find((g: Rec) => g.id === "main") ?? {}) : agents.error);
    }
    say("   config.changed reached the read-only device?", r.events.some((e) => e.event === "config.changed"), "payload:", r.events.find((e) => e.event === "config.changed")?.payload);
    const { hash: h2 } = await x.request("config.get", {});
    const back = await x.attempt("config.patch", { raw: JSON.stringify({ agents: { entries: { main: { skills: null } } } }), baseHash: h2, replacePaths: ["agents.entries.main.skills"] });
    say("   put back (skills removed):", back.ok ? "ok" : back.error);
    const stalePatch = await x.attempt("config.patch", { raw: JSON.stringify({ agents: { entries: { main: { skills: [] } } } }), baseHash: hash, replacePaths: ["agents.entries.main.skills"] });
    say("4. a config.patch on a stale baseHash:", stalePatch.ok ? "ok (applied)" : stalePatch.error);
    const after = await x.request("config.get", {});
    say("   Juniper's list now:", after.config.agents.entries.main.skills ?? "missing");
  } finally {
    for (const d of [x, a, r]) d.stop();
  }
}

async function stalecfg() {
  const x = await device(values.admin, "admin");
  try {
    const patch = (value: unknown, baseHash: string) => x.attempt("config.patch", { raw: JSON.stringify({ agents: { entries: { main: { skills: value } } } }), baseHash, replacePaths: ["agents.entries.main.skills"] });
    const h0 = (await x.request("config.get", {})).hash;
    const one = await patch(["first-list"], h0);
    say("1. patch on the current hash:", one.ok ? "ok" : one.error);
    const two = await patch(["second-list"], h0);
    say("2. another patch on the first hash, now stale:", two.ok ? "ok (applied)" : two.error);
    say("   the list now:", (await x.request("config.get", {})).config.agents.entries.main.skills);
    const h1 = (await x.request("config.get", {})).hash;
    const back = await patch(null, h1);
    say("   put back:", back.ok ? "ok" : back.error, (await x.request("config.get", {})).config.agents.entries.main.skills ?? "missing");
  } finally {
    x.stop();
  }
}

async function call() {
  const d = await device(values.admin ?? values.data, "caller");
  try {
    say("as:", d.scopes);
    say(`${values.method}:`, await d.attempt(values.method!, JSON.parse(values.params!)));
  } finally {
    d.stop();
  }
}

/** Second round: frontmatter kept or lost by a save, defaults for a disabled skill, opposite share writes, an inherited list. */
async function round2() {
  const a = await device(values.data, "A");
  const b = await device(values.data2, "B");
  const x = await device(values.admin, "admin");
  try {
    const slug = `ferry-times-${tag}`;
    const head = `---\nname: ${slug}\ndescription: Use when checking the ferry.\nuser-invocable: false\nmetadata: {"openclaw":{"requires":{"bins":["curl"]}}}\n---\n\n`;
    const s1 = await a.attempt("skills.library.save", { expectedRevision: null, slug, content: `${head}Check the timetable.\n`, files: [{ path: "references/times.md", content: "First ferry 6:10.\n" }] });
    say("1. saved with user-invocable and metadata:", receipt(s1));
    const id = s1.result.entry.skillId;
    const t1 = await a.request("sessions.create", { agentId: "main", label: `ferry ${tag}` });
    const status = async (key: string) => {
      const st = await a.attempt("skills.status", { agentId: "main", sessionKey: key });
      const row = st.result?.skills?.find((k: Rec) => k.name === s1.result.entry.name);
      return row ? { eligible: row.eligible, userInvocable: row.userInvocable } : "not listed";
    };
    say("   skills.status in a new task:", await status(t1.key));
    // The first round's editor wrote name, description and body only.
    const plain = await a.attempt("skills.library.save", { skillId: id, expectedRevision: s1.result.entry.revision, slug, content: `---\nname: ${slug}\ndescription: Use when checking the ferry.\n---\n\nCheck the timetable twice.\n`, retainFiles: ["references/times.md"] });
    const r1 = await a.attempt("skills.library.read", { skillId: id });
    say("2. a save of name, description and body only:", { state: plain.result?.state, keepsUserInvocable: r1.result.content.includes("user-invocable"), keepsMetadata: r1.result.content.includes("metadata"), files: r1.result.files.map((f: Rec) => f.path) });
    const t2 = await a.request("sessions.create", { agentId: "main", label: `ferry2 ${tag}` });
    say("   skills.status in a task created after it:", await status(t2.key), "| the first task:", await status(t1.key));
    // Replacing only the body, inside the frontmatter as read.
    const kept = await a.attempt("skills.library.save", { skillId: id, expectedRevision: r1.result.entry.revision, slug, content: `${head}Check the timetable twice.\n`, retainFiles: ["references/times.md"] });
    const r2 = await a.attempt("skills.library.read", { skillId: id });
    say("3. a save that keeps the frontmatter as read:", { state: kept.result?.state, keepsUserInvocable: r2.result.content.includes("user-invocable: false"), keepsMetadata: r2.result.content.includes('"bins":["curl"]') });
    // Disabled, then saved.
    const dis = await a.attempt("skills.library.mutate", { skillId: id, expectedRevision: r2.result.entry.revision, action: "disable" });
    const s3 = await a.attempt("skills.library.save", { skillId: id, expectedRevision: dis.result.entry.revision, slug, content: `${head}Check the timetable three times.\n`, retainFiles: ["references/times.md"] });
    const t3 = await a.request("sessions.create", { agentId: "main", label: `ferry3 ${tag}` });
    say("4. saved while disabled:", { enabled: s3.result.entry.enabled, nextAction: s3.result.nextAction, newTaskPins: (await selections(a, t3.key)).filter((y: Rec) => y.slug === slug) });
    const att = await a.attempt("skills.library.activate", { sessionKey: t3.key, action: "attach", skillId: id });
    say("   attached explicitly:", att.ok ? att.result.selections.filter((y: Rec) => y.skillId === id).map((y: Rec) => String(y.revision).slice(0, 12)) : att.error);
    // Opposite share writes on the same revision.
    const cur = (await a.attempt("skills.library.read", { skillId: id })).result.entry;
    const [sh, un] = await Promise.all([
      a.attempt("skills.library.mutate", { skillId: id, expectedRevision: cur.revision, action: "share" }),
      b.attempt("skills.library.mutate", { skillId: id, expectedRevision: cur.revision, action: "unshare" }),
    ]);
    const team = (await a.attempt("skills.library.list", { scope: "team" })).result.entries.some((e: Rec) => e.skillId === id);
    say("5. share from A and unshare from B on one revision:", { share: sh.ok ? sh.result.entry.shared : sh.error, unshare: un.ok ? un.result.entry.shared : un.error, inTeamListAfter: team });
    // A removed skill's refusal, as the client receives it.
    const before = (await a.attempt("skills.library.read", { skillId: id })).result.entry;
    await a.attempt("skills.library.mutate", { skillId: id, expectedRevision: before.revision, action: "remove" });
    const again = await a.attempt("skills.library.save", { skillId: id, expectedRevision: before.revision, slug, content: `${head}x\n` });
    say("6. a save on the removed skill:", again.error);
    // An inherited empty default list, with no key for the bot.
    const lake = `lake-path-${tag}`;
    await a.attempt("skills.library.save", { expectedRevision: null, slug: lake, content: skillText(lake, "Use when walking the lake path.", "Go clockwise.") });
    const c0 = await x.request("config.get", {});
    say("7. Juniper's key:", Object.hasOwn(c0.config.agents.entries.main, "skills") ? c0.config.agents.entries.main.skills : "missing", "| defaults.skills:", c0.config.agents.defaults?.skills ?? "missing");
    const set = await x.attempt("config.patch", { raw: JSON.stringify({ agents: { defaults: { skills: [] } } }), baseHash: c0.hash });
    await sleep(1500);
    const t4 = await a.request("sessions.create", { agentId: "main", label: `inherit ${tag}` });
    const g4 = await turn(a, t4.key, "#skills");
    say("   with defaults.skills [] and no key:", set.ok ? "patched" : set.error, "| pins hold it:", (await selections(a, t4.key)).some((y: Rec) => y.slug === lake), "| the turn was given:", g4.text);
    const c1 = await x.request("config.get", {});
    const back = await x.attempt("config.patch", { raw: JSON.stringify({ agents: { defaults: { skills: null } } }), baseHash: c1.hash, replacePaths: ["agents.defaults.skills"] });
    await sleep(1500);
    const g5 = await turn(a, t4.key, "#skills");
    say("   defaults removed:", back.ok ? "patched" : back.error, "| the same task's next turn:", libraryLines(g5.text, lake));
  } finally {
    for (const d of [a, b, x]) d.stop();
  }
}

const experiments: Record<string, () => Promise<void>> = { pair, tiers, library, task, running, perbot, workshop, extra, stalecfg, call, round2 };
const run = experiments[experiment ?? ""];
if (!run) throw new Error(`unknown experiment ${experiment}; one of ${Object.keys(experiments).join(", ")}`);
await run();
process.exit(0);
