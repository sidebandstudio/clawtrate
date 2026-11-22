// A defensive stand-in for the authority contract in
// docs/design/main-bot-onboarding.md, sections 6 to 10. Research code, not a
// check of the product and not the plugin.
//
//   node docs/research/bot-self-management/fixture.mjs
//
// It talks to no gateway and makes no privileged call. "The gateway" here is a
// small in-memory stand-in that records writes and refuses one whose
// precondition token is stale, as config.patch {baseHash},
// agents.files.set {expectedHash} and cron.update {expectedConfigRevision} do.
// What it shows: whatever a turn's scopes are (an admin's chat, no operator,
// a routine with its creator's authority), a bot's tool only proposes; only an
// authenticated admin's decision applies a proposal, under the precondition,
// once; a field without a conditional write isn't applied; a revoked agent's
// suggestion can't be applied; Undo takes both values from the journal,
// compares with the journaled result first, and restores the journaled
// before-value only when nothing changed since.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ADMIN = "operator.admin";

/** The gateway stand-in: values with a token that changes on every write. */
function standInGateway(initial) {
  const fields = new Map(Object.entries(initial).map(([k, v]) => [k, { value: v, token: digest([k, v, 0]) }]));
  const writes = [];
  let n = 0;
  return {
    writes,
    read: (field) => ({ ...fields.get(field) }),
    // An independent admin elsewhere.
    external(field, value) {
      fields.set(field, { value, token: digest([field, value, ++n]) });
    },
    conditionalWrite(caller, field, value, token) {
      if (!caller.authenticated || !caller.scopes.includes(ADMIN)) return { ok: false, reason: "missing scope" };
      const cur = fields.get(field);
      if (cur.token !== token) return { ok: false, reason: "precondition" };
      const next = { value, token: digest([field, value, ++n]) };
      fields.set(field, next);
      writes.push({ field, value });
      return { ok: true, ...next };
    },
  };
}

/** The plugin's contract, as the design draws it. */
function standInPlugin(gw, { managers }) {
  const ledger = { open: new Map(), grants: new Map() }; // the one authoritative row
  const journal = [];
  const conditional = new Set(["label", "instructions", "model", "effort", "autonomy"]); // no "name": gated
  let seq = 0;
  return {
    journal,
    ledger,
    // A bot's tool. ctx comes from the tool context, never from arguments.
    tool(ctx, args) {
      const target = args.bot ?? ctx.agentId;
      if (target !== ctx.agentId && !managers.includes(ctx.agentId)) return { status: "refused" };
      const changes = args.changes;
      const tokens = Object.fromEntries(Object.keys(changes).map((f) => [f, gw.read(f).token]));
      const before = Object.fromEntries(Object.keys(changes).map((f) => [f, gw.read(f).value]));
      const id = `p${++seq}`;
      const source = ctx.grant ? { kind: "agent", grant: ctx.grant, generation: ledger.grants.get(ctx.grant) } : { kind: "bot", bot: ctx.agentId };
      ledger.open.set(id, { state: "open", target, changes, tokens, before, digest: digest(changes), source });
      return { status: "proposed", proposalId: id };
    },
    revoke(grant) {
      ledger.grants.set(grant, (ledger.grants.get(grant) ?? 0) + 1);
      for (const p of ledger.open.values())
        if (p.state === "open" && p.source.kind === "agent" && p.source.grant === grant) p.state = "withdrawn";
    },
    // An admin's decision, on their own connection.
    accept(caller, id, shownDigest) {
      const p = ledger.open.get(id);
      if (!p || p.state !== "open") return { outcome: p?.state ?? "missing" };
      if (!caller.authenticated || !caller.scopes.includes(ADMIN)) return { outcome: "below-admin" };
      if (shownDigest !== p.digest) return { outcome: "changed" };
      if (p.source.kind === "agent" && ledger.grants.get(p.source.grant) !== p.source.generation) return { outcome: "withdrawn" };
      p.state = "committing"; // the claim
      const result = {};
      for (const [field, value] of Object.entries(p.changes)) {
        if (!conditional.has(field)) {
          result[field] = "gated";
          continue;
        }
        const w = gw.conditionalWrite(caller, field, value, p.tokens[field]);
        if (!w.ok) {
          result[field] = "not-applied";
          break;
        }
        journal.push({
          id: `j${journal.length + 1}`,
          field,
          before: { value: p.before[field], token: p.tokens[field] },
          after: { value, token: w.token },
        });
        result[field] = "applied";
      }
      p.state = "accepted";
      return { outcome: "accepted", result };
    },
    // Undo takes both values from the journal: it compares the field with the
    // journaled result, then restores the journaled before-value with the
    // token from that same read. The caller supplies only which entry.
    undo(caller, journalId) {
      const j = journal.find((e) => e.id === journalId);
      const now = gw.read(j.field);
      if (now.value !== j.after.value) return { outcome: "changed-since", now: now.value, expected: j.after.value };
      const w = gw.conditionalWrite(caller, j.field, j.before.value, now.token);
      return w.ok ? { outcome: "undone", restored: j.before.value } : { outcome: "changed-since" };
    },
  };
}

const admin = { authenticated: true, scopes: ["operator.read", "operator.write", ADMIN] };
const writer = { authenticated: true, scopes: ["operator.read", "operator.write"] };
let passed = 0;
const check = (name, run) => {
  run();
  passed += 1;
  console.log(`ok ${name}`);
};

check("a bot's tool only proposes, whatever the turn's scopes", () => {
  const gw = standInGateway({ label: "research" });
  const plugin = standInPlugin(gw, { managers: [] });
  for (const turn of [{ operatorScopes: [ADMIN] }, { operatorScopes: null }, { routineCreator: [ADMIN] }]) {
    const r = plugin.tool({ agentId: "pip", ...turn }, { changes: { label: "planning" } });
    assert.equal(r.status, "proposed");
  }
  assert.equal(gw.writes.length, 0);
});

check("only a manager proposes for another bot", () => {
  const gw = standInGateway({ label: "x" });
  const plugin = standInPlugin(gw, { managers: ["main"] });
  assert.equal(plugin.tool({ agentId: "pip" }, { bot: "otto", changes: { label: "y" } }).status, "refused");
  assert.equal(plugin.tool({ agentId: "main" }, { bot: "otto", changes: { label: "y" } }).status, "proposed");
});

check("below admin can't apply; an admin applies once, under the precondition", () => {
  const gw = standInGateway({ label: "x" });
  const plugin = standInPlugin(gw, { managers: [] });
  const { proposalId } = plugin.tool({ agentId: "pip" }, { changes: { label: "y" } });
  const shown = digest({ label: "y" });
  assert.equal(plugin.accept(writer, proposalId, shown).outcome, "below-admin");
  assert.equal(plugin.accept(admin, proposalId, shown).result.label, "applied");
  assert.equal(plugin.accept(admin, proposalId, shown).outcome, "accepted"); // a second device
  assert.equal(gw.writes.length, 1);
});

check("an independent write between the card and Apply refuses the field", () => {
  const gw = standInGateway({ instructions: "a" });
  const plugin = standInPlugin(gw, { managers: [] });
  const { proposalId } = plugin.tool({ agentId: "pip" }, { changes: { instructions: "b" } });
  gw.external("instructions", "c");
  assert.equal(plugin.accept(admin, proposalId, digest({ instructions: "b" })).result.instructions, "not-applied");
  assert.equal(gw.read("instructions").value, "c");
});

check("a name has no conditional write, so it isn't applied", () => {
  const gw = standInGateway({ name: "Pip", instructions: "a" });
  const plugin = standInPlugin(gw, { managers: [] });
  const changes = { name: "Scout", instructions: "b" };
  const { proposalId } = plugin.tool({ agentId: "pip" }, { changes });
  const r = plugin.accept(admin, proposalId, digest(changes)).result;
  assert.deepEqual(r, { name: "gated", instructions: "applied" });
  assert.equal(gw.read("name").value, "Pip");
});

check("a revoked agent's suggestion can't be applied on any device", () => {
  const gw = standInGateway({ label: "x" });
  const plugin = standInPlugin(gw, { managers: [] });
  plugin.ledger.grants.set("g1", 1);
  const { proposalId } = plugin.tool({ agentId: "pip", grant: "g1" }, { changes: { label: "y" } });
  plugin.revoke("g1");
  assert.equal(plugin.accept(admin, proposalId, digest({ label: "y" })).outcome, "withdrawn");
  assert.equal(gw.writes.length, 0);
});

check("Undo restores the journaled before-value when nothing changed since", () => {
  const gw = standInGateway({ instructions: "Check backups on Mondays." });
  const plugin = standInPlugin(gw, { managers: [] });
  const { proposalId } = plugin.tool({ agentId: "otto" }, { changes: { instructions: "Check backups daily." } });
  plugin.accept(admin, proposalId, digest({ instructions: "Check backups daily." }));
  assert.equal(plugin.journal[0].before.value, "Check backups on Mondays.");
  const r = plugin.undo(admin, "j1");
  assert.deepEqual(r, { outcome: "undone", restored: "Check backups on Mondays." });
  assert.equal(gw.read("instructions").value, "Check backups on Mondays.");
  assert.equal(gw.writes.length, 2);
});

check("Undo refuses, with the comparison, after an intervening edit", () => {
  const gw = standInGateway({ autonomy: "ask" });
  const plugin = standInPlugin(gw, { managers: [] });
  const { proposalId } = plugin.tool({ agentId: "pip" }, { changes: { autonomy: "full" } });
  plugin.accept(admin, proposalId, digest({ autonomy: "full" }));
  gw.external("autonomy", "allowlist");
  const r = plugin.undo(admin, "j1");
  assert.deepEqual(r, { outcome: "changed-since", now: "allowlist", expected: "full" });
  assert.equal(gw.read("autonomy").value, "allowlist");
  assert.equal(gw.writes.length, 1);
});

console.log(`${passed} ok`);
