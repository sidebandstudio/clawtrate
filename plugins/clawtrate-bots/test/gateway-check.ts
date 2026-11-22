// The records' contract on development gateways, named for the parity rows
// (docs/design/main-bot-onboarding.md, section 17). It starts and resets its
// own instances: botsrec (the plugin), botsrec-b (the plugin, a
// second gateway) and botsrec-bare (no plugin).
//
//   node plugins/clawtrate-bots/test/gateway-check.ts

import assert from "node:assert/strict";
import {
  openInstance,
  openOperator,
  reset,
  start,
  stop,
} from "../../../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../../../tools/dev-gateway/src/operator.ts";

type Json = Record<string, unknown>;
const PLUGIN = "clawtrate-bots";
const a = openInstance("botsrec");
const b = openInstance("botsrec-b");
const bare = openInstance("botsrec-bare");
/** An element that must be there. */
const at = <T>(xs: T[], i: number): T => {
  const x = xs[i];
  assert(x !== undefined, `item ${i}`);
  return x;
};
const sessions: OperatorSession[] = [];
const admin = async (inst: typeof a, who: string) => {
  const op = await openOperator(
    inst,
    who,
    ["operator.admin", "operator.read", "operator.write"],
    [],
  );
  sessions.push(op);
  return op;
};
const call = <T = Json>(op: OperatorSession, method: string, params: Json = {}) =>
  op.request<T>(`${PLUGIN}.${method}`, params);
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "admitted",
    (e: { details?: { reason?: string }; message: string }) => e.details?.reason ?? e.message,
  );
const FIELDS: Record<string, Json> = {
  name: { name: "Renamed" },
  label: { label: "Helper" },
  model: { model: "scripted/model" },
  account: { account: "scripted" },
  effort: { effort: "low" },
  autonomy: { autonomy: "ask" },
  agents: { instructions: { agents: { text: "Be brief.", baseHash: null } } },
  soul: { instructions: { soul: { text: "Be kind.", baseHash: null } } },
};
const grantFor = (op: OperatorSession) =>
  call<{ id: string; generation: number }>(op, "relay.grants.set", {
    scope: "suggest",
    bots: "all",
    includeFuture: true,
    includeInstructions: true,
  });
const propose = (
  op: OperatorSession,
  g: { id: string; generation: number },
  bot: string,
  field: string,
) =>
  call<{ proposalId: string; digest: string }>(op, "relay.propose", {
    grant: g.id,
    generation: g.generation,
    bot,
    fields: FIELDS[field],
  });
const openCount = async (op: OperatorSession) => (await call<{ open: number }>(op, "status")).open;
const settings = async (op: OperatorSession) => ({
  config: (await op.request<{ hash: string }>("config.get", {})).hash,
  bots: (await op.request<{ agents: Json[] }>("agents.list", {})).agents,
});

try {
  for (const inst of [a, b, bare]) await reset(inst);
  await start(a, { plugins: [PLUGIN], seed: false });
  await start(b, { plugins: [PLUGIN], seed: false });
  await start(bare, { seed: false });

  // The plugin missing: the gateway has no such method.
  const none = await admin(bare, "Bots check, no plugin");
  await assert.rejects(call(none, "status"), /unknown method|not found/i);

  const op = await admin(a, "Bots check admin");
  const other = await admin(a, "Bots check other device");
  // Enough bots for 201 distinct bot and field pairs (supersession keeps one per pair).
  for (let i = 0; i < 22; i += 1)
    await op.request("agents.create", {
      name: `extra${i}`,
      workspace: `${a.stateDir}/workspaces/extra${i}`,
    });
  const before = await settings(op);
  const bots = before.bots.map((bot) => String(bot.id)).filter((id) => id !== "system");
  const pairs = bots.flatMap((bot) =>
    Object.keys(FIELDS).map((field): [string, string] => [bot, field]),
  );
  assert(pairs.length >= 201, `${pairs.length} bot and field pairs`);
  const status = await call<Json>(op, "status");
  assert.deepEqual(
    [status.apply, status.describe],
    [
      { available: false, reason: "incarnation" },
      { available: false, reason: "route-binding" },
    ],
  );

  // F-537: a grant used, revoked mid-call, refused after, its suggestion withdrawn on every device.
  const g = await grantFor(op);
  const first = await propose(op, g, "pip", "label");
  const marker = other.lastSeq;
  const [during] = await Promise.all([
    outcome(propose(op, g, "pip", "model")),
    call(op, "relay.grants.set", { id: g.id, revoke: true }),
  ]);
  await other.waitFor(
    "the change event",
    ({ event }) => event === `plugin.${PLUGIN}.changed`,
    10_000,
    marker,
  );
  const listed = (await call<{ proposals: Json[] }>(other, "proposals.list")).proposals.filter(
    (p) => p.source === `agent:${g.id}`,
  );
  assert(["admitted", "grant-revoked"].includes(during), during);
  assert.equal(
    listed.length,
    during === "admitted" ? 2 : 1,
    "a call admitted before the revocation is recorded",
  );
  assert(
    listed.every((p) => p.state === "withdrawn"),
    JSON.stringify(listed),
  );
  assert.equal(
    await outcome(call(other, "proposals.accept", { id: first.proposalId, digest: first.digest })),
    "settled",
  );
  assert.equal(
    await outcome(propose(op, { id: g.id, generation: 2 }, "pip", "label")),
    "grant-revoked",
  );
  const again = await call<{ generation: number }>(op, "relay.grants.set", {
    id: g.id,
    scope: "suggest",
    bots: ["pip"],
  });
  assert.equal(again.generation, 3);
  assert.equal(
    await outcome(propose(op, { id: g.id, generation: 2 }, "pip", "label")),
    "grant-generation",
    "a reconnect with an old generation",
  );

  // A gateway switch mid-proposal: the request and the grant stay with their gateway.
  const switched = await propose(op, { id: g.id, generation: 3 }, "pip", "effort");
  const opB = await admin(b, "Bots check, second gateway");
  assert.notEqual((await call<Json>(opB, "status")).gateway, status.gateway);
  assert.equal(await outcome(call(opB, "proposals.get", { id: switched.proposalId })), "unknown");
  assert.equal(
    await outcome(propose(opB, { id: g.id, generation: 3 }, "pip", "label")),
    "grant-missing",
  );
  assert.equal((await call<Json>(op, "proposals.get", { id: switched.proposalId })).state, "open");
  await call(op, "proposals.decline", { id: switched.proposalId, digest: switched.digest });
  assert.equal(await openCount(op), 0);

  // F-536: the last slot of one source (20), then of the gateway (200).
  const grants = await Promise.all(Array.from({ length: 11 }, () => grantFor(op)));
  let next = 0;
  for (let i = 0; i < 19; i += 1)
    await propose(op, at(grants, 0), at(pairs, next)[0], at(pairs, next++)[1]);
  const sourceRace = await Promise.all(
    [0, 1].map(() => outcome(propose(op, at(grants, 0), at(pairs, next)[0], at(pairs, next++)[1]))),
  );
  assert.deepEqual(sourceRace.sort(), ["admitted", "source-limit"]);
  assert.equal(await openCount(op), 20);
  for (let gi = 1; gi <= 9; gi += 1)
    for (let i = 0; i < (gi === 9 ? 19 : 20); i += 1)
      await propose(op, at(grants, gi), at(pairs, next)[0], at(pairs, next++)[1]);
  assert.equal(await openCount(op), 199);
  const gatewayRace = await Promise.all(
    [at(grants, 9), at(grants, 10)].map((grant, i) =>
      outcome(propose(i ? other : op, grant, at(pairs, next + i)[0], at(pairs, next + i)[1])),
    ),
  );
  assert.deepEqual(gatewayRace.sort(), ["admitted", "open-limit"]);
  assert.equal(await openCount(op), 200);

  // F-536: nothing the plugin did wrote to a bot's settings.
  assert.deepEqual(await settings(op), before);
  console.log("clawtrate-bots gateway check: ok");
} finally {
  for (const s of sessions) await s.close().catch(() => {});
  for (const inst of [a, b, bare])
    await stop(inst)
      .then(() => reset(inst))
      .catch(() => {});
}
