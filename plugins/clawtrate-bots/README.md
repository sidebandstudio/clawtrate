# clawtrate-bots

Bots and external agents propose changes to bots, and a person decides. The design is `docs/design/main-bot-onboarding.md`, sections 5 to 10.

This is the first part: **the records**. It keeps proposals and agent grants, and decides admission, decline and revocation. It writes nothing to any bot. On OpenClaw 2026.10.6 no stored request can be applied (section 17), so accept always refuses. The bots' tools, the journal and Undo come in later parts.

## Gateway methods

| Method                    | Scope | What                                                                                                                                                                                                                                   |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawtrate-bots.status`   | read  | Version, the gateway's identity as the plugin knows it, capabilities, the open count and the limits. Apply and Describe are reported unavailable                                                                                       |
| `.proposals.list`, `.get` | read  | Proposals the ledger refers to, each with its payload. A version whose digest doesn't match reads as "Clawtrate couldn't read this request."                                                                                           |
| `.proposals.decline`      | write | `{ id, digest }`: claims an open proposal and settles it `declined`, with the deciding device hashed                                                                                                                                   |
| `.proposals.accept`       | admin | `{ id, digest }`: runs the claim's checks, then refuses with `apply-unavailable`                                                                                                                                                       |
| `.relay.grants.get`       | read  | A grant's generation, state and details                                                                                                                                                                                                |
| `.relay.grants.set`       | admin | Writes a new grant's version (`scope`, `bots`, `includeInstructions`, `includeFuture`, `expiresAt`), then publishes it at generation 1. A grant is never changed: a narrower one is a new grant. `{ id, revoke: true }` removes access |
| `.relay.propose`          | admin | `{ grant, generation, bot, fields, reason? }`: records an agent's suggestion for a bot the grant covers. It only proposes, and records its source                                                                                      |

Every method but the reads needs a person's own connection: a direct operator request over the gateway's socket. An in-process call, such as a turn with no operator (research finding R6), is refused with `operator-required`, even when it reuses a client.

`relay.propose` trusts the authenticated admin connection that sends it to say which grant and generation it acts for. Another admin could send the same pair, and neither value proves which helper sent the request. So the app's relay must take the pair from the helper it authenticated, and keep its own gateway connection out of the helper's reach.

The event `plugin.clawtrate-bots.changed` is empty, at `operator.read`, after every ledger change. The only gateway method the plugin calls is `agents.list`.

## Records

One retained keyed store in the gateway's database (`lib/records.js`):

- **Versions** are immutable and written once: a proposal's details, or a grant's.
- **The ledger** is one row. It is the only record that decides anything (`lib/ledger.js`), and it changes only through `compareAndApply`. Admission enforces 200 open proposals, 20 per source, and one open proposal per bot and field (a newer one supersedes). Revoking a grant moves its generation on and withdraws its open suggestions in the same update. A claim checks the digest and the grant's generation.
- **Persist first, then publish.** Readers use only versions the ledger refers to.
- **The sweep** runs at start and hourly: proposals expire after 24 hours, and settled ones, and grants revoked, leave the ledger after 30 days. Nothing deletes a version yet; reclaiming unpublished ones comes with the journal's cleanup.

## Tests

```sh
pnpm exec vitest run plugins/clawtrate-bots
node plugins/clawtrate-bots/test/gateway-check.ts   # starts and resets its own development instances
```
