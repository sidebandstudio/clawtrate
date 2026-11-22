// The records' contract on development gateways, each check named for its
// parity row (docs/design/main-bot-onboarding.md, section 17). It starts and
// resets three instances of its own, under names it chooses for this run: one
// with the plugin, a second with the plugin, and one without.
//
//   node plugins/clawtrate-bots/test/gateway-check.ts

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
const run = randomBytes(3).toString("hex");
const a = openInstance(`bots-${run}-a`);
const b = openInstance(`bots-${run}-b`);
const bare = openInstance(`bots-${run}-bare`);
/** A named check: its title starts with the parity row it covers. */
async function check(title: string, body: () => Promise<void>) {
  await body();
  console.log(`ok ${title}`);
}
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

  await check("The plugin missing: the gateway has no such method", async () => {
    const none = await admin(bare, "Bots check, no plugin");
    await assert.rejects(call(none, "status"), /unknown method|not found/i);
  });

  const op = await admin(a, "Bots check admin");
  const other = await admin(a, "Bots check other device");
  // Bots with creation records, enough for 201 distinct bot and field pairs
  // (supersession keeps one open proposal per pair).
  for (let i = 0; i < 26; i += 1)
    await op.request("agents.create", {
      name: `extra${i}`,
      workspace: `${a.stateDir}/workspaces/extra${i}`,
    });
  const before = await settings(op);
  const bots = before.bots
    .filter((bot) => Number.isSafeInteger(bot.createdAt))
    .map((bot) => String(bot.id));
  const bot = at(bots, 0);
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

  let grantId = "";
  // Both orders of a revocation and a call are pinned in the unit tests; here they race for real.
  await check(
    "F-537: a grant used, revoked mid-call, refused after, withdrawn on every device, an old generation refused",
    async () => {
      const g = await grantFor(op);
      grantId = g.id;
      const first = await propose(op, g, bot, "label");
      const marker = other.lastSeq;
      const [during] = await Promise.all([
        outcome(propose(op, g, bot, "model")),
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
        await outcome(
          call(other, "proposals.accept", { id: first.proposalId, digest: first.digest }),
        ),
        "settled",
      );
      assert.equal(
        await outcome(propose(op, { id: g.id, generation: 2 }, bot, "label")),
        "grant-revoked",
      );
      const again = await call<{ generation: number }>(op, "relay.grants.set", {
        id: g.id,
        expectedGeneration: 2,
        scope: "suggest",
        bots: [bot],
      });
      assert.equal(again.generation, 3);
      assert.equal(
        await outcome(propose(op, g, bot, "label")),
        "grant-generation",
        "a reconnect with an old generation",
      );
    },
  );

  await check(
    "A gateway switch mid-proposal: two instances are isolated, so a request and a grant stay with their gateway",
    async () => {
      const switched = await propose(op, { id: grantId, generation: 3 }, bot, "effort");
      const opB = await admin(b, "Bots check, second gateway");
      assert.notEqual((await call<Json>(opB, "status")).gateway, status.gateway);
      assert.equal(
        await outcome(call(opB, "proposals.get", { id: switched.proposalId })),
        "unknown",
      );
      assert.equal(
        await outcome(propose(opB, { id: grantId, generation: 3 }, bot, "label")),
        "grant-missing",
      );
      assert.equal(
        (await call<Json>(op, "proposals.get", { id: switched.proposalId })).state,
        "open",
      );
      await call(op, "proposals.decline", { id: switched.proposalId, digest: switched.digest });
      assert.equal(await openCount(op), 0);
    },
  );

  await check(
    "F-536: two proposals racing for the last slot of one source (20), then of the gateway (200): one admitted, one refused, the count at the limit",
    async () => {
      const grants = await Promise.all(Array.from({ length: 11 }, () => grantFor(op)));
      let next = 0;
      for (let i = 0; i < 19; i += 1)
        await propose(op, at(grants, 0), at(pairs, next)[0], at(pairs, next++)[1]);
      const sourceRace = await Promise.all(
        [0, 1].map(() =>
          outcome(propose(op, at(grants, 0), at(pairs, next)[0], at(pairs, next++)[1])),
        ),
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
    },
  );

  await check("F-536: the gateway received no writes to bot settings", async () => {
    assert.deepEqual(await settings(op), before);
  });
  console.log("clawtrate-bots gateway check: ok");
} finally {
  for (const s of sessions) await s.close().catch(() => {});
  for (const inst of [a, b, bare])
    await stop(inst)
      .then(() => reset(inst))
      .catch(() => {});
}
