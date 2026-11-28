# Development gateway: provider accounts

The [development gateway guide](../../docs/development/dev-gateway.md) explains the development gateway itself: instances, the scripted model, the scenarios and their directives, the closed config contract and its guard, and how a named instance loads a plugin from this checkout's `plugins/`. This file covers what was added for provider accounts per bot ([`docs/design/bots.md`](../../docs/design/bots.md)): scripted accounts on an instance, a record of which account each request came from, failures scripted per account, scripted sign-ins through the gateway's own sign-in methods, the lock subcommand, and the account checks in `pnpm scenarios`.

The tool runs its own pinned OpenClaw, never the one on `PATH` ([Which OpenClaw it runs](../../docs/development/dev-gateway.md#which-openclaw-it-runs)); `pnpm dev-gateway setup` installs it.

Nothing here is a real provider, a real account or a real key. Every provider below is the instance's own scripted model on `127.0.0.1`, and every credential is a made-up development string.

## Starting an instance with accounts

```bash
pnpm dev-gateway start --instance acct --with-accounts --with-plugin clawtrate-dev-signin
pnpm dev-gateway reset --instance acct     # when you are done
```

`--with-accounts` is for named instances only; the default instance refuses it. `--with-plugin clawtrate-dev-signin` adds the scripted sign-ins and needs `--with-accounts`. Add `--no-seed` to skip the sample conversations.

### What the instance contains

Two scripted providers besides `scripted`, both served by the instance's scripted model, with no key in their config entry:

| Provider | Models           | Model references           |
| -------- | ---------------- | -------------------------- |
| `acme`   | `dev-1`, `dev-2` | `acme/dev-1`, `acme/dev-2` |
| `globex` | `dev-1`          | `globex/dev-1`             |

And four accounts, saved before the gateway first starts, each by the gateway's own command line (`openclaw models auth paste-api-key` or `paste-token`, the credential on stdin):

| Account (profile id) | Label  | Kind (`type`) | Kept in          | Seen by   |
| -------------------- | ------ | ------------- | ---------------- | --------- |
| `acme:work`          | Work   | `api_key`     | the shared store | every bot |
| `acme:home`          | Home   | `api_key`     | the shared store | every bot |
| `globex:team`        | Team   | `token`       | the shared store | every bot |
| `acme:studio`        | Studio | `api_key`     | Otto's own store | Otto only |

Labels are `auth.profiles.<id>.displayName` in the config; `models.authStatus` returns them to admin connections only. `paste-token` rewrites its profile entry without a label, so the tool writes the labels back after saving. The seeded bots stay on `scripted/dev-1`; make a bot on an account with `agents.create {name, workspace, model: "acme/dev-1@acme:home"}` and give it `fallbacks: []` with `config.patch`, as New bot does.

**Credentials.** An account's credential names it: `clawtrate-dev-key.acme.work` is `acme:work`'s API key, `clawtrate-dev-token.globex.team` is `globex:team`'s token, and an OAuth sign-in's access credential is `clawtrate-dev-oauth.acme.<name>.<serial>`. That is how the scripted model knows which account a request came from, with no table to keep.

**The gateway's log** goes to `logs/gateway.jsonl` inside the instance (`logging.file`), so `logs.tail` serves this instance's failover decisions and nothing else.

### Account kinds

| Kind the design distinguishes                                                                | Made here | How                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API key                                                                                      | yes       | the start (`paste-api-key`), or the scripted API-key sign-in                                                                                                                               |
| Static token                                                                                 | yes       | the start (`paste-token`): `globex:team`                                                                                                                                                   |
| Subscription sign-in (`oauth`)                                                               | yes       | the scripted device-code and browser sign-ins below; a refreshable `oauth` profile with an expiry an hour ahead and an `@acme.example` email                                               |
| Added on the gateway                                                                         | yes       | every account the start saves: Clawtrate did not start their sign-in                                                                                                                       |
| Kept by one bot                                                                              | yes       | `acme:studio`, and any sign-in started for a bot other than `main`                                                                                                                         |
| A key bound to the provider entry (`models.authSetApiKey` on a configured provider)          | no        | it writes `models.providers.<p>.apiKey`, which the closed contract refuses: a bound key changes every bot's order (`profileOrderLocked: "provider-config"`), which the design never writes |
| Sign-in on the gateway's own machine (a `localhost:8080` callback)                           | no        | it needs a listener the gateway binds on its host and a browser that reaches it; the scripted sign-ins stay on the scripted model                                                          |
| The gateway's own browser callback (`ctx.oauth.authorize`)                                   | no        | offered only to a connection with a qualifying browser origin; the paste-back path is what a Clawtrate connection gets                                                                     |
| A provider's real OAuth (refresh against a real issuer, account-dependent catalogues, usage) | no        | needs a real provider                                                                                                                                                                      |

## Which account served

The scripted model records every chat completion it receives:

```bash
curl -s http://127.0.0.1:<scripted model port>/scripted/requests          # every request
curl -s "http://127.0.0.1:<port>/scripted/requests?since=<seq>"          # after a known one
```

```json
{
  "requests": [
    {
      "seq": 3,
      "at": 1794921969869,
      "account": "acme:home",
      "credential": "api_key",
      "model": "dev-1",
      "session": "agent:acct-second:main",
      "status": 200
    }
  ]
}
```

`account` is the account whose credential arrived, or `null`; `credential` is its kind (`api_key`, `token`, `oauth`), `other` for a credential no account has (the `scripted` provider's placeholder key) or `none`; `session` is the gateway session the request was for; `status` is the status the scripted model answered the request with: the account's scripted failure, a failure the conversation itself scripted (`#model-error`), or 200. A request with no credential at all is answered 401, as a real provider answers one. The port is in `pnpm dev-gateway status --instance <name>` (`scripted model`). The record is in memory and starts empty with every start.

## Failures per account

```bash
P=http://127.0.0.1:<scripted model port>
curl -s -X POST $P/scripted/accounts/fail  -H 'content-type: application/json' -d '{"account":"acme:work","status":429}'
curl -s -X POST $P/scripted/accounts/fail  -H 'content-type: application/json' -d '{"account":"acme:work","status":401,"times":1}'
curl -s -X POST $P/scripted/accounts/clear -H 'content-type: application/json' -d '{"account":"acme:work"}'
curl -s -X POST $P/scripted/accounts/clear -H 'content-type: application/json' -d '{}'      # every account
curl -s $P/scripted/accounts/failures
```

`status` is 401 (`authentication_error`, "Invalid API key (scripted)"), 402 (`insufficient_quota`, "You exceeded your current quota (scripted insufficient credits)") or 429 (`rate_limit_exceeded`, with `Retry-After: 1`). With `times`, that many requests from the account get the status and it heals by itself; without it, the account fails until cleared. The other accounts keep answering. With these messages the gateway reports `failoverReason` `auth`, `billing` and `rate_limit`. Add `"message"` to give a failure a message of its own (one line, at most 200 characters).

**Read the reason from the gateway, not from the status.** The gateway decides a failure's reason from its status and its message together. A 402 with no message, or with one it does not recognise ("The request was not accepted (scripted)"), is `billing`; a 402 whose message reads as a quota that resets, a temporary limit or a rate limit ("You exceeded your current quota (scripted)") is `rate_limit`. The account checks assert both.

Mind the gateway's cooldowns: after a failure it rests an account (30 seconds for the first auth or rate-limit failure, 10 minutes for the first billing failure, longer on repeats), during which it skips it for every bot that shares it. A rate-limited account is retried ten times with growing pauses before the run gives up, about two and a half minutes. The account checks sign in accounts of their own for each failure for that reason.

## Holding a task's replies

A check can hold the replies in one task, to act while the gateway waits on the model:

```bash
curl -s -X POST $P/scripted/hold -d '{"session":"agent:otto:<task>","action":"hold"}'
curl -s "$P/scripted/hold?session=agent:otto:<task>"   # {session, held, reached, waiting}
curl -s -X POST $P/scripted/hold -d '{"session":"agent:otto:<task>","action":"next"}'
curl -s -X POST $P/scripted/hold -d '{"session":"agent:otto:<task>","action":"release"}'
```

While the task is held, each reply streamed in it sends all its steps and then waits before its end. The gateway has the message's text and calls by then, but writes the message's row and runs its calls only at the end. `reached` counts the replies that got there since `hold`, and `waiting` those still waiting. `next` lets the oldest waiting reply end (409 when none waits), and `release` lets every one end and stops holding. A reply that waits five minutes fails and ends the task's hold, so a check that died frees the task and its later replies aren't held. A body that isn't an object with a `session` is answered 400. `e2e/turns.engine.spec.ts` uses it for #872: a steer sent while the answer waits joins at its end, and the model's next reply then waits with the answer's row written while the run still draws it.

## Scripted sign-ins

`plugins/clawtrate-dev-signin` gives the gateway three sign-in methods for `acme`. A client lists them in `models.authStatus` `providerCapabilities[].loginOptions[]`, starts one with `models.authLogin {sessionId, authChoice, agentId}` (admin), follows it with `wizard.next` and cancels it with `wizard.cancel`, exactly as it would a real provider's:

| `authChoice`                            | `loginOptions[].kind` | What the steps ask                                                                                                                                      | What is saved                      |
| --------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `clawtrate-dev-signin/acme-device-code` | `device-code`         | a `progress` step with `externalUrl` (the scripted page) and `deviceCode {code, expiresInMinutes: 15, message}`; the gateway polls                      | an `oauth` profile `acme:<name>`   |
| `clawtrate-dev-signin/acme-browser`     | `oauth`               | a `text` step, `sensitive: true`, placeholder "Code or address", with `externalUrl`; answer it with the code or the whole address the browser landed on | an `oauth` profile `acme:<name>`   |
| `clawtrate-dev-signin/acme-api-key`     | `secret`              | a `text` step, `sensitive: true`, for the key; answer it with `clawtrate-dev-key.acme.<name>`                                                           | an `api_key` profile `acme:<name>` |

Every successful sign-in then shows one client note ("Provider notes", `executor: "client"`), which the client acknowledges with `wizard.next {answer: {stepId, value: true}}` before the sign-in finishes with `{done: true, status: "done"}`.

**Playing the person.** Open the step's `externalUrl` in a browser: the scripted page has an account name field and Approve, Refuse and "Let it expire". Or answer from a test:

```bash
curl -s -X POST $P/scripted/signin/answer -H 'content-type: application/json' \
  -d '{"userCode":"4349-BE73","outcome":"approve","account":"travel"}'     # device: the step's code
curl -s -X POST $P/scripted/signin/answer -H 'content-type: application/json' \
  -d '{"state":"<state from the externalUrl>","outcome":"approve","account":"travel"}'   # browser
curl -s -X POST $P/scripted/signin/key-outcome -H 'content-type: application/json' \
  -d '{"key":"clawtrate-dev-key.acme.spare","outcome":"refuse"}'          # before typing that key
curl -s $P/scripted/signin/sessions                                        # every sign-in and its state
```

A browser answer returns `{code, redirectUrl}` (or only `redirectUrl` with `error=access_denied` for a refusal): paste either into the text step. Without an `account`, names are `signin1`, `signin2` and so on.

**Outcomes**, as `wizard.next` reports them once the sign-in ends:

| Outcome   | Device code                                                                                                                                                 | Browser                                    | API key                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| Approved  | `{done: true, status: "done"}`                                                                                                                              | the same                                   | the same                                               |
| Refused   | `status: "error"`, `error: "Acme (scripted) refused the sign-in: The person refused the sign-in."`                                                          | `… refused the sign-in: access_denied`     | `… refused the sign-in: The provider refused the key.` |
| Expired   | `status: "error"`, `error: "Acme (scripted) sign-in expired: The code expired before the sign-in finished."` (also once 15 minutes pass unanswered)         | the same, when the pasted code has expired | `… sign-in expired: The key has expired.`              |
| Cancelled | `wizard.cancel` answers `{status: "cancelled", error: "cancelled"}`; the next `wizard.next` answers `{done: true, status: "cancelled", error: "cancelled"}` | the same                                   | the same                                               |

Refused, expired and cancelled sign-ins save nothing. A second `models.authLogin` while one runs is refused: "OpenClaw setup is already in progress; try again when it finishes." The gateway's own 25-minute limit and "ends with its connection" apply as for any sign-in.

**Where it lands.** A sign-in for `main` (which has no `agentDir` configured) goes to the shared store and every bot sees it; a sign-in for any other bot stays in that bot's own store.

**Whether it leaves an order.** A successful sign-in moves its account to the front of the bot's stored order for the provider when the bot has one. When the bot has none, the sign-in creates one only if the config lists accounts of that provider: the provider's `auth.order`, or else its entries in `auth.profiles`. The new order is the new account followed by that configured list. With no existing order and nothing configured, the sign-in creates none. A created order can hold a single account, even on a bot's first sign-in: when the account signed in is the only one the config lists. On an instance with accounts the config lists `acme:work`, `acme:home` and `acme:studio`, so a bot's first `acme` sign-in leaves it the order `[<new account>, acme:work, acme:home, acme:studio]`, `acme:studio` included although only Otto keeps it.

An order a sign-in left and an order the lock command set (below) are reported the same way, as `profileOrder` with `profileOrderStored: true`, and restrict a bot the same way; nothing in `models.authStatus` says which made it. The account checks keep them apart by what they did, not by what they read.

**The plugin is trusted code for development instances only.** It runs inside the gateway like any `--with-plugin` plugin; read it before loading it. It contacts only `signinUrl`, which the tool sets to `/scripted/signin` on the instance's own scripted model. It checks the address of every request as `127.0.0.1` when the request is made, and never follows a redirect: a redirect ends the sign-in as a failure ("the scripted sign-in answered with a redirect, which this plugin never follows"), so a key or code it sends can reach no other address. It works only inside a named development instance this tool started: the gateway's state folder is `~/.openclaw-clawtrate-dev-<name>` with the profile `clawtrate-dev-<name>`, the tool's marker in it names that instance and this very gateway process, and the plugin's code lies inside that folder. On any other gateway it registers nothing and logs "clawtrate-dev-signin registers no sign-ins here: <why>"; each sign-in method and the refresh check the same evidence again before they run. Its contract addition is one setting of the kind `scripted-model-url` (below), and its manifest declares sign-ins for `acme` only. It sets `setup.requiresRuntime: false`: without it, the gateway took `acme` for a provider with a key-less direct route and, when a locked bot's only account failed, sent one more request to the provider with no credential at all.

## The lock

```bash
pnpm dev-gateway lock   --instance <name> --agent <bot> --provider acme acme:home
pnpm dev-gateway unlock --instance <name> --agent <bot> --provider acme
```

`lock` sets the bot's stored one-account order for the provider, the "Locked" of the design's section 10, by running the gateway's own command line on the instance: `openclaw models auth order set --provider <p> --agent <bot> <profileId>`; `unlock` runs `… order clear`. Both then read the order back with `… order get --json` and print it. They do what the gateway's owner does on the instance's OpenClaw version: before 2026.10.10 they run beside the running gateway; from 2026.10.10, whose command line refuses these commands while the gateway runs ("This command is offline-only"), they stop the instance's gateway alone, run them, and start it again on the same state and port, which takes as long as a start. Its clients reconnect by themselves. They act only on a named instance this checkout started whose gateway is running, never the default instance. Before running anything they read the instance's current config and resolve every account store the command could read or write (every configured `agentDir`, the bot's own store and the shared one), and refuse unless each is inside the instance's state folder, through real folders only, with no store file a link. They also refuse a bot, provider or account that is not a plain id (an account must belong to the provider). Clawtrate the application never runs this; the tool does, so that checks can. `models.authStatus {agentId}` then reports `profileOrder: ["acme:home"]` and `profileOrderStored: true`.

## The account checks

`pnpm scenarios` starts its instance with `--with-accounts --with-plugin clawtrate-dev-signin`, runs the scenario checks, then the account checks (`src/account-checks.ts`) with two clients of their own: an admin client (`operator.admin`, `operator.read`, `operator.write`) and a read-only one (`operator.read`), which reads `logs.tail` and accounts as the design does. Each asserts from the gateway's answers and the scripted model's record. The numbers are rows of the design's section 20.

| Check                                                 | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Rows         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| the accounts an instance starts with                  | each bot's view: main and Pip see `acme:work` and `acme:home` (`inherited`), Otto also `acme:studio` (`saved`); labels to admin only; `globex:team` is a `token`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 5, 9, 33     |
| a bot created on the second of two accounts           | `agents.create {model: "acme/dev-1@acme:home"}` keeps the suffix, the stored model is `{primary, fallbacks: []}`, and its first run reaches the scripted model once, with `acme:home`'s credential                                                                                                                                                                                                                                                                                                                                                                                                                  | 2, 3         |
| no account and no fallbacks ("Gateway chooses")       | stored as `{primary: "acme/dev-1", fallbacks: []}` with no order; three runs each served by a shared `acme` account (observed: `acme:work` every time)                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 4, 36        |
| a run on another model                                | a bot pinned to one account with a one-account order for another: a run on its own model goes to the pinned account; a run whose session asks for `acme/dev-2` goes to the ordered account, never the pinned one                                                                                                                                                                                                                                                                                                                                                                                                    | 2, 13        |
| where a sign-in lands                                 | a device sign-in for `main` is seen by every bot as `inherited`; one for Otto only by Otto, as `saved`; each leaves its bot an order of the new account then the configured `acme` accounts, and no other bot an order; without `refresh` a bot that keeps no account of its own lists the shared account as `saved`                                                                                                                                                                                                                                                                                                | 5, 6, 12, 33 |
| sign-in with a link and a code                        | approved, refused, expired and cancelled, with the step's code, minutes and loopback link; only the approved one saved an account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 6            |
| sign-in in the browser                                | approved by pasting the code and by pasting the whole address, refused, expired, cancelled; the paste step is `sensitive`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 6            |
| sign-in with an API key                               | saved, refused, expired, cancelled; a second sign-in while one runs is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 6            |
| a bound bot whose account fails                       | bound, not locked, its account answers 401 once: the same run asks that account, then another `acme` account, and ends `final`; `logs.tail` holds a `rotate_profile` record for the run naming the failed account's hash, and none naming the one that served                                                                                                                                                                                                                                                                                                                                                       | 11, 16       |
| a locked bot, 401 / 402 / 429 (three checks)          | locked with `pnpm dev-gateway lock`, `profileOrder` `[account]` and `profileOrderStored: true`; the account fails until cleared; the run ends in `error` with `failoverReason` `auth`, `billing` or `rate_limit`; no request carries another account's credential                                                                                                                                                                                                                                                                                                                                                   | 12, 18       |
| a locked bot moved to another account of its provider | after the model changes to the new account with the old one-account order still stored, a run goes to the new account; when the new one fails once, the same run goes on to the old one                                                                                                                                                                                                                                                                                                                                                                                                                             | 15           |
| the suffix removed, the order kept                    | the bot's model loses its account; runs still go to the ordered account alone, and when it fails the run fails without asking any other                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 36           |
| an order cleared over the connection                  | locked with `pnpm dev-gateway lock`, then `models.authOrderSet {provider, agentId}` with no account ids, as Clawtrate's Unlock sends it: answered `{provider, profileIds: null}`, the order read back as none kept, the gateway's process the same (no restart); the bot's next run, its account failing once, goes on to another account; the same for a bot with no fixed account whose one-account order stays; refused below admin and for a bot the gateway doesn't have, the order unchanged; with `auth.order` configured, taken, the configured order left; a second clear with none kept answered the same | 14, 36       |
| when a sign-in leaves an order                        | a bot's first sign-in leaves `[new, acme:work, acme:home, acme:studio]` and a second moves its account to the front; with only `acme:work` configured, a first sign-in of `acme:work` leaves the one-account order `[acme:work]` while `acme:home` stays available; with nothing configured, a sign-in saves its account and leaves no order; the configured accounts are restored                                                                                                                                                                                                                                  | 12           |
| the gateway's reason for a 402 (two checks)           | a locked bot's account answers 402 with a message the gateway does not recognise: the run's `errorDetail.failoverReason` is `billing`; with "You exceeded your current quota (scripted)" it is `rate_limit`; only the account was asked                                                                                                                                                                                                                                                                                                                                                                             | 18           |

The check prints what it observed (`note`) and every place the gateway differs from section 20 (`differs from the design`).

## What the gateway did

Observed with the checks on OpenClaw 2026.10.6, embedded runtime:

- **The rotation record** in `logs.tail` (each line is the gateway's JSON log line; the record is found by `event`):

  ```json
  {
    "event": "embedded_run_failover_decision",
    "decision": "rotate_profile",
    "stage": "assistant",
    "runId": "<the run's id>",
    "provider": "acme",
    "model": "dev-1",
    "sourceProvider": "acme",
    "sourceModel": "dev-1",
    "profileId": "sha256:<12 hex digits of SHA-256 of the failed account's id>",
    "failoverReason": "auth",
    "profileFailureReason": "auth",
    "providerRuntimeFailureKind": "auth_invalid_token",
    "rawErrorHash": "sha256:<12 hex digits>",
    "rawErrorPreview": "401 Invalid API key (scripted)",
    "attemptCount": 1,
    "retryCount": 0,
    "profileRotationCount": 0,
    "fallbackConfigured": false,
    "aborted": false,
    "timedOut": false,
    "tags": ["error_handling", "failover", "assistant", "rotate_profile"]
  }
  ```

  A locked bot's failed run leaves `decision: "surface_error"` with the locked account's hash instead.

- **`models.authStatus {agentId}`**, per provider: `provider`, `authProvider`, `displayName`, `status`, `profiles`, and `profileOrder` and `profileOrderStored` when the bot has a stored order (`profileOrderLocked` never appeared: nothing binds a key to a provider here). Per account, to an admin connection:
  - shared: `{"profileId":"acme:work","type":"api_key","status":"static","source":"inherited","displayName":"Work","logoutSupported":true}`
  - kept by Otto, in Otto's view: `{"profileId":"acme:studio","type":"api_key","status":"static","source":"saved","displayName":"Studio","logoutSupported":true}`
  - signed in: `type: "oauth"`, `status: "ok"`, an `expiry`
  - a read-only connection gets the same without `displayName`.
- **Read with `refresh: true`.** Without it, `models.authStatus` answers from a cached snapshot, and after a sign-in a bot that keeps no account of its own (`main`, Marlow, any bot made with `agents.create`) lists every shared account as `saved`. With `refresh: true` (allowed at `operator.read`) the shared accounts read `inherited` for every bot, `main` included, and only an account in the bot's own store reads `saved`.
- **A sign-in can leave an order.** A successful sign-in moves its account to the front of an order the bot has, or creates one from the configured `auth.order` or `auth.profiles` of the provider when that list is not empty, and creates none when there is no order and nothing configured (see [Whether it leaves an order](#scripted-sign-ins)). A created order can be a single account on a bot's first sign-in. `main`'s order did not reach other bots.
- **`agents.create`** writes an explicit `agentDir` (`<state>/agents/<id>/agent`) into the new bot's entry.
- **A locked run that fails** makes one request to its account (ten for 429) and ends in `error`; a bound run that rotates shows no event naming either account, only the log record.
