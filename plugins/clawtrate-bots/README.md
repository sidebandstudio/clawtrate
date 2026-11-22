# clawtrate-bots

Bots and external agents propose changes to bots, and a person decides. The design is `docs/design/main-bot-onboarding.md`, sections 5 to 10.

This is the first part: **the records**. It keeps proposals and agent grants, and decides admission, decline and revocation. It writes nothing to any bot. On OpenClaw 2026.10.6 no stored request can be applied (section 17), so accept always refuses. The bots' tools, the journal and Undo come in later parts.

## Gateway methods

| Method                  | Scope | What                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawtrate-bots.status` | read  | Version, the gateway's identity as the plugin knows it, capabilities, the open count and the limits. Apply and Describe are reported unavailable                                                                                                                                                                                                        |
| `.proposals.list`       | read  | A page of summaries from the ledger (`limit` up to 200, `cursor`), newest first, with no payload                                                                                                                                                                                                                                                        |
| `.proposals.get`        | read  | One request with its payload. A version whose digest doesn't match reads as "Clawtrate couldn't read this request."                                                                                                                                                                                                                                     |
| `.proposals.decline`    | write | `{ id, digest }`: claims an open proposal and settles it `declined`, with the deciding device hashed                                                                                                                                                                                                                                                    |
| `.proposals.accept`     | admin | `{ id, digest }`: runs the claim's checks, then refuses with `apply-unavailable`                                                                                                                                                                                                                                                                        |
| `.relay.grants.get`     | read  | A grant's generation, state and details                                                                                                                                                                                                                                                                                                                 |
| `.relay.grants.set`     | admin | Writes a grant's version (`scope`, `bots`, `includeInstructions`, `includeFuture`, `expiresAt`) and publishes it: a new grant at generation 1, or, with `id` and the `expectedGeneration` it read, a new version at the next generation, which withdraws the grant's open suggestions. A stale update is refused. `{ id, revoke: true }` removes access |
| `.relay.propose`        | admin | `{ grant, generation, bot, fields, reason? }`: records an agent's suggestion for a bot the grant covers. It only proposes, and records its source                                                                                                                                                                                                       |

Every method but the reads needs a person's own connection: a direct operator request over the gateway's socket. An in-process call, such as a turn with no operator (research finding R6), is refused with `operator-required`, even when it reuses a client.

`relay.propose` trusts the authenticated admin connection that sends it to say which grant and generation it acts for. Another admin could send the same pair, and neither value proves which helper sent the request. So the app's relay must take the pair from the helper it authenticated, and keep its own gateway connection out of the helper's reach.

The event `plugin.clawtrate-bots.changed` is empty, at `operator.read`, after every ledger change. The only gateway method the plugin calls is `agents.list`.

## Records

Two keyed stores in the gateway's database (`lib/records.js`): the ledger in a retained namespace, so a decision can always be stored, and the versions in a bounded one (512 rows, `overflowPolicy: "reject-new"`), which refuses new records with `records-full` when full.

- **Versions** are immutable and written once: a proposal's details, or a grant's.
- **The ledger** is one row. It is the only record that decides anything (`lib/ledger.js`), and it changes only through `compareAndApply`. Admission enforces 200 open proposals, 20 per source, and one open proposal per bot and field (a newer one supersedes). Revoking a grant moves its generation on and withdraws its open suggestions in the same update. A claim checks the digest and the grant's generation.
- **Persist first, then publish.** Readers use only versions the ledger refers to.
- **The sweep** runs at start and hourly. Proposals expire after 24 hours; settled ones, and grants revoked, leave the ledger after 30 days. Then it reclaims versions nothing has referred to for an hour, continuously: unpublished ones, grant versions an update replaced, and those of settled requests whose ledger entries have left. The hour starts when the sweep first sees the row unreferenced, measured on the process's monotonic clock and recorded in the ledger; publishing a version clears its age, and a restart starts a fresh observation unless the deletion was already marked. It marks the one version it deletes in the ledger first, so a publisher can't publish it, deletes it, then clears the mark; a deletion left marked is finished first, by any process. It reads versions 16 at a time, so a page is at most 16 MiB of JSON at the store's 1 MiB per value.
- **How full the versions store gets.** A settled request keeps its body for the 30 days of history, so the 512 rows hold the open requests (up to 200), the requests settled in the last 30 days, each grant's current version, revoked grants still in their 30-day retention, and orphans awaiting cleanup. With few grants and few orphans, about 300 settled requests in 30 days fill it with 200 open, or about 500 with few open. A full store refuses new records with `records-full` ("Try again after the gateway clears older records.") and accepts them again as cleanup reclaims rows; a store full of live grants with long deadlines can stay full for longer than 30 days. Dropping a settled request's body sooner, or a larger bound, are possible later changes if real use needs them.

## Tests

```sh
pnpm exec vitest run plugins/clawtrate-bots
node plugins/clawtrate-bots/test/gateway-check.ts   # starts and resets its own development instances
```
