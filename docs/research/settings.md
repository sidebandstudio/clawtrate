# Settings, several gateways, updates and two task tools: what the gateway, Electron and the app allow

What Settings can truthfully show and do: several gateways (adding, switching, removing), updates on macOS, Windows, Linux and iOS, Appearance, Language, spelling, hardware acceleration and security keys, and two task tools: Compact, and a report of free disk. Checked against OpenClaw 2026.10.6, Electron 45.3.2 (the version in `apps/desktop/package.json`), electron-builder 26.18.1 and this repository's code. It is the evidence behind `docs/design/settings.md`.

How to read the citations, as in `gateway-capabilities.md` and `setup-flow.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, the one the `openclaw` wrapper script runs. Chunk names carry a build hash that changes with every release; search by the `//#region <source path>` marker instead. Line numbers are of the 2026.10.6 chunks.
- `<electron-docs>/…` is a file under `docs/` of the Electron repository at the tag `v45.3.2`. The same text is in the JSDoc of `electron.d.ts` in the installed `electron@45.3.2`, where cited as `electron.d.ts`.
- `<app-builder-lib>/…` is the installed `app-builder-lib@26.18.1`, which electron-builder 26.18.1 runs.
- **Live** means it was run on a development instance of my own, and the result is quoted. **Read-only-from-source** means it was read in shipped code only. **Read-only-from-documentation** means it was read in the documentation of the exact version only; nothing of the operating system was changed or tried to confirm it (this note never locks a screen, starts a screen saver, changes a system setting, or installs or launches a packaged app).

Where things were run:

- **Development instance `d7set`**, started by this checkout with `pnpm dev-gateway start --instance d7set`, so `openclaw --profile clawtrate-dev-d7set`, with `autoApproveLocal: false` as every instance has. The probes are in `settings/probe.ts` and use this project's own client (`packages/core`) where the desktop app would, with a client folder of their own. Each device was approved by the gateway's own `devices approve <requestId>`, run through the development tool's guarded runner. Every value the probe prints passes through its redaction: tokens, this machine's names and addresses, the home folder, mounted volumes and the owner's display name.

## Summary

| # | Question | Answer | Section |
|---|---|---|---|
| 1 | How is a gateway identified, and how are its credentials kept apart? | By `gateway.identity.get` (`operator.read`) after a connection authenticates; each route keeps its own device token, keyed today by the gateway's URL, the device id and the role (`packages/core/src/client.ts`, `tokenKey`). A second gateway is another identity; a second route to one gateway is the same identity over another route (issue #13). **Read-only-from-source**, with the identity **live**. | 1 |
| 2 | What does removing a gateway remove on this device, and what stays on the gateway? | On this device: the saved connection, its device-token records, its drafts and its rail arrangement; four per-viewer keys are not scoped by gateway today and have to be first. The device key stays, shared by every gateway. On the gateway: its bots, tasks and settings, and this device's paired record. **Read-only-from-source.** | 2 |
| 3 | Can this client remove its own paired record on the gateway? | Only with `operator.admin`. `device.pair.remove` and `device.token.revoke` need `operator.pairing`, which this client never requests; both were refused "missing scope: operator.pairing" at the read and at the interactive tier. With admin, `device.pair.remove {deviceId: <its own>}` removed the record and the gateway closed the connection. Otherwise the gateway's owner runs `openclaw devices remove <deviceId>` on the gateway's computer. **Live.** | 3 |
| 4 | Is there an update feed, and what would an update need? | No: packaging sets `publish: null`, so no `app-update.yml` and no `latest*.yml` is written, and no updater is in the app. macOS needs a signed build (Squirrel.Mac) and a feed; Windows' NSIS installer cannot be updated by Electron's own `autoUpdater` (Squirrel.Windows and MSIX only), so it needs electron-builder's updater with a publish configuration. With Electron's own `autoUpdater`, a downloaded update also installs at the next start. **Read-only-from-source and documentation.** | 4 |
| 5 | Can the app know "locked", "screen saver on" and "idle for ten minutes"? | Locked: yes on macOS and Windows (`lock-screen`, `unlock-screen`, `getSystemIdleState` `locked`). Idle time: yes on both (`getSystemIdleTime`). Screen saver: nothing in Electron 45.3.2 reports it, on any system. **Read-only-from-documentation.** | 5 |
| 6 | What does "no run is active" mean with several gateways? | One gateway is connected at a time; the app can see runs only there. A run belongs to its gateway and keeps going when the client quits. What a restart can lose is this client's own unsent messages. **Read-only-from-source.** | 6 |
| 7 | What makes an update "required"? | The connect handshake: a client whose protocol the gateway does not speak gets `PROTOCOL_MISMATCH` with `expectedProtocol`, for too old and too new alike; the client tells them apart by comparing. Nothing else in the handshake asks for a newer client. **Live.** | 7 |
| 8 | What does `/compact` through `chat.send` do? | With nothing to compact: "⚙️ Compaction skipped: nothing compactable in this session yet". A failed summary: "⚙️ Compaction failed: …", history unchanged, no `compaction` row. During an active run it waits up to 60 s, then ends the run: "⚠️ Your in-flight request was aborted by compaction — please resend it." The reply is a history row from `model: "gateway-injected"` carrying the send's idempotency key. A success could not be reproduced with today's scripted model; its row is from the capability map's live run. **Live**, success **read-only-from-source**. | 8 |
| 9 | What does `node.hostStats` give, and is there a clean-up a client can ask for? | A node's stats every 60 s, its disk optional and for the node's home volume, at `operator.read`. The gateway's own machine is `system.info` (`operator.read`, live): its disks, and the state folder's. The only clean-ups (`sessions.cleanup`, `worktrees.gc`) are admin maintenance of OpenClaw's own records and report no space freed, so the report deletes nothing. **Live** and **read-only-from-source.** | 9 |
| 10 | Language, spelling, hardware acceleration, security keys | No translation exists: the interface is English only. Spelling: macOS's own checker on macOS; on Windows Hunspell dictionaries downloaded from a CDN by default, which the app's request filter may cancel (not tried). Hardware acceleration can be turned off only before the app is ready, so a restart. Security keys for a bot's browser have no gateway support. | 10 |

## 1. A gateway's identity, and its credentials kept apart

- **What identifies a gateway** is `gateway.identity.get` (`operator.read`), the gateway process's own `{deviceId, publicKey}`, stable across addresses and restarts (`setup-flow.md` §5; handler `<openclaw>/dist/system-C_-PvNDr.mjs` lines 350-356, region `src/gateway/server-methods/system.ts`). It supplies no proof of possession. **Live** on `d7set`: two devices paired over the same address read the same `gatewayId` `2a47552309d7…`.
- **What keeps credentials apart.** The core keeps a device token under `deviceToken:<encoded URL>:<deviceId>:<role>` (`packages/core/src/client.ts`, `tokenKey`), and a credential never crosses gateways (`docs/decisions.md`, "Connecting to the gateway"). When routes come (`docs/design/setup.md` §15), "one gateway URL" becomes "one route", and routes reporting the same identity are shown as one gateway without moving a token.
- **A second gateway and a second route.** A second gateway reports another identity. A second route to a saved gateway reports the same one; adding, ordering and failing over between routes is issue #13 (`setup.md` §15) and not part of this design.
- **What the app keeps today is one gateway.** The saved connection is one storage key, `connection` (`client.ts`, `SETTINGS_KEY`), holding `{url, token, suspended}`; "Use another gateway" in Settings is the `disconnect` command, which closes the connection and deletes that key, keeping the device key and every device token ("The device key and any device token remain", `client.ts`, `disconnect`). So a list of gateways is new state for the host, one entry per gateway with its routes, and the token records stay as they are.
- **One connection at a time.** The core holds one connection (`ClawtrateClient`, one `protocol` and one `settings`), and "Switching gateways drops it: a message is never sent to another gateway than the one it was written for" (`docs/decisions.md`, "Closing a task keeps the user's words"). The design keeps that: switching closes one connection and opens another.

## 2. What removing a gateway removes on this device, and what stays

Read in this repository's code, item by item. **Read-only-from-source.**

| Item | Where it is | Per gateway today? |
|---|---|---|
| The saved connection (address, a bootstrap token until pairing, "suspended") | Host storage, key `connection`, in `<data>/state.json` (`packages/core/src/node/index.ts`) | One for the only gateway |
| Device tokens, one per role | Host storage, `deviceToken:<url>:<deviceId>:<role>` | Yes, by URL |
| The device key | `<data>/device-key.pem` | No: one key for this device, used with every gateway |
| Drafts | `localStorage` `clawtrate.draft.<gateway address>\|<task>` (`packages/ui/src/Composer.tsx`) | Yes, by address |
| The rail's arrangement (pins, hidden bots, order) | `localStorage` `clawtrate.roster:gateway:<id>`, or `roster:address:<url>` (`packages/ui/src/roster.ts`, `docs/decisions.md`) | Yes |
| The open bot, the open task per bot, what this viewer read, the unfolded bots | `localStorage` `clawtrate.bot`, `clawtrate.tasks`, `clawtrate.seen`, `clawtrate.unfolded` (`packages/ui/src/selection.ts`) | **No.** They hold the gateway's ids without naming it, so they have to be keyed by gateway before a removal can remove them, and before a switch can keep each gateway's |
| Theme, your messages' fill, motion, folded, the Work pane open | `localStorage` `clawtrate.theme`, `bubbles`, `motion`, `folded`, `panel` | Not about a gateway; they stay |
| Bots, tasks, transcripts | In memory only; nothing is cached on disk | Gone with the connection |
| On an SSH route: the pinned key, its SSH settings, the forward | `setup.md` §8 and §19 | By route |

What stays on the gateway: its bots, tasks, accounts and settings, the person's preferences there (`users.prefs`, such as the T3 Code switch, `bots.md` §15), and this device's paired record (section 3).

On the web preview host the host's records are shared by every browser that uses the host (`docs/decisions.md`, "Viewers"); `localStorage` is each browser's own.

## 3. Removing this device's record on the gateway

The method policy: `device.pair.remove` and `device.token.revoke` need `operator.pairing` (`<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 1422 and 1440, region `src/gateway/methods/core-descriptors.ts`). Inside, a caller that authenticated with a device token may act on its own device only, unless it holds `operator.admin` (`deniesCrossDeviceManagement`, `<openclaw>/dist/device-management-security-Dx--n3Fk.mjs`; handler `device.pair.remove`, `<openclaw>/dist/devices-mOg4_HQd.mjs` line 445). The bundled CLI page says the same: "A caller authenticated with a paired device token can remove only its **own** device entry. Removing another device requires `operator.admin`." (`<openclaw>/docs/cli/devices.md` lines 122-131). This client never requests `operator.pairing` (`docs/decisions.md`, "Scopes, in tiers").

### Live

`probe.ts call`, one device, at each tier:

```
as: ["operator.read"]
device.pair.remove: {"ok":false,"error":{"code":"FORBIDDEN","message":"missing scope: operator.pairing","details":{"code":"MISSING_SCOPE","missingScope":"operator.pairing","requiredScopes":["operator.pairing"]}}}
device.token.revoke: {"ok":false,"error":{"code":"FORBIDDEN","message":"missing scope: operator.pairing", …}}

as: ["operator.read","operator.write","operator.approvals","operator.questions"]
device.pair.remove: {"ok":false,"error":{"code":"FORBIDDEN","message":"missing scope: operator.pairing", …}}

as: ["operator.read","operator.write","operator.approvals","operator.questions","operator.admin"]
device.pair.remove: {"ok":true,"result":{"deviceId":"bf8352e0173f343b…"}}
after: {"status":"error","error":{"code":"AUTH_DEVICE_TOKEN_MISMATCH","message":"unauthorized: device token mismatch (rotate/reissue device token)"}}
gateway devices: {"pending":[],"paired":[]}
```

So: read and interactive were refused for missing device access. Forget only offers this operation with already-held admin. Local removal does not ask the gateway to remove its record; its owner can remove it on the gateway's computer with `openclaw devices remove <deviceId>` (for the selected profile). With admin, `device.pair.remove` with the device's own id removes it, the result names the removed id, and the gateway ends the connection at once, so nothing can be read back over it afterwards: the result is the gateway's confirmation.

## 4. Updates: no feed today, and what an update would need

**This repository today.** `apps/desktop/packaging/config.ts` sets `publish: null` ("Releasing is the owner's: nothing is uploaded and no update feed is written") and `dmg.writeUpdateInfo: false`; `build.ts` passes `publish: "never"`. With no publish configuration electron-builder writes no `app-update.yml` into the app (`getAppUpdatePublishConfiguration` returns null when `publishConfigs` is null, `<app-builder-lib>/out/publish/PublishManager.js` lines 87-90 and 192-196) and no `latest*.yml`. No updater is imported in `apps/desktop/src/main`, and neither `electron-updater` nor any other updater is a dependency (`apps/desktop/package.json`). Without signing variables the macOS app is signed ad hoc and the Windows installer unsigned (`docs/development/packaging.md`). **Read-only-from-source.**

**macOS.** Electron's `autoUpdater` is built on Squirrel.Mac: "Your application must be signed for automatic updates on macOS. This is a requirement of `Squirrel.Mac`." It downloads a ZIP from a feed set with `setFeedURL` (`<electron-docs>/api/auto-updater.md`, "Platform Notices"). The packaging already makes a `.zip` for each architecture. Missing: a Developer ID signature (the owner's, `CSC_LINK` or `CSC_NAME`), a published feed, and an updater in the main process. **Read-only-from-documentation.**

**Windows.** Electron's `autoUpdater` uses "the MSIX updater" for an MSIX package and "Squirrel.Windows" for "apps installed via traditional installers (created with electron-winstaller or Electron Forge's Squirrel.Windows maker)" (same file). This repository builds an NSIS installer, which neither is, so Electron's own updater cannot update it. electron-builder's updater (`electron-updater`) updates NSIS installs from a `latest.yml` and the `app-update.yml` packaging writes when a publish provider is configured; when the build is signed, electron-builder records the publisher (`publisherName`, same `PublishManager.js` lines 205-211) for the updater to check. The installer already keeps a copy of itself for an updater (`%LOCALAPPDATA%\@clawtratedesktop-updater\installer.exe`, `docs/decisions.md`, "Packaging"), and `differentialPackage: false` means full downloads. Missing: the updater dependency, a publish provider, a published feed. **Read-only-from-source**, except Electron's sentence, **read-only-from-documentation**.

**With Electron's own `autoUpdater`, a downloaded update installs at the next start, whatever the rule.** "It is not strictly necessary to call this function to apply an update, as a successfully downloaded update will always be applied the next time the application starts." (`quitAndInstall`, `electron.d.ts` and `<electron-docs>/api/auto-updater.md`.) So a rule about when to install governs only when Clawtrate restarts itself; a person who quits and reopens installs it. **Read-only-from-documentation.**

**Linux.** "There is no built-in support for auto-updater on Linux, so it is recommended to use the distribution's package manager" (same file). This repository builds no Linux package (`build.ts` takes `mac` or `win` only), so a Linux copy today is one run from source. **Read-only-from-source.**

**A development build** (`app.isPackaged` false) never loads an update and is not packaged at all.

**iOS.** The iOS app is not on `main` (`AGENTS.md`). Updates there come through the App Store or TestFlight, which the app does not drive. Nothing of iOS was read or run for this note.

## 5. What Electron can observe for "install while away"

From `<electron-docs>/api/power-monitor.md` and `electron.d.ts` for 45.3.2. **Read-only-from-documentation.**

| Condition | macOS | Windows | Linux |
|---|---|---|---|
| The screen is locked | Yes: events `lock-screen` ("Emitted when the system is about to lock the screen") and `unlock-screen`, _macOS_ _Windows_; and `getSystemIdleState(threshold)` returns `locked` ("available on supported systems only") | Yes, the same events | Not documented |
| The screen saver is on | **No.** Nothing in `powerMonitor`, `app` or anywhere in Electron 45.3.2's documentation reports a screen saver | **No** | **No** |
| Idle for at least ten minutes | Yes: `getSystemIdleTime()`, "Idle time in seconds", on every system; or `getSystemIdleState(600)` returning `idle` | Yes | Yes |

So the rule the app can keep is: locked **and** idle for at least 600 s **and** no run active (section 6). A screen saver that runs without locking is not seen, and is not in the rule.

## 6. "No run is active" with several gateways

- The app connects to one gateway at a time (section 1), so it sees runs only on that one: the core's run state, which the status line uses (`docs/design/conversation.md` §5).
- A run belongs to its gateway. It keeps going when the client goes away: the development gateway's `#stream` scenario is "a run still going when a client quits and opens again" (`docs/development/dev-gateway.md`, Scenarios), and reopening finds it (`docs/decisions.md`, "Reconnecting"). So a restart of Clawtrate does not stop any gateway's run, connected or not.
- What a restart can lose is this client's own: messages accepted by the composer and not yet sent or confirmed, which live in memory only (only the connection and the tokens are in host storage, section 2). Drafts survive (`localStorage`).
- So "no run is active" would mean: on every connected gateway, no task has a run in progress, and Clawtrate holds no message waiting to send or waiting for the gateway's confirmation. Nothing establishes that positively today: the status line describes the selected task (`packages/ui/src/Conversation.tsx`), the client keeps only the newest task rows and its discovery can be partial (`packages/core/src/client.ts`), and a reconnect, a switch or a missed event gives no "idle" answer. Other saved gateways are not connected and nothing of theirs can be lost.

## 7. What the gateway says to a client whose protocol it does not speak

`<openclaw>/dist/message-handler-CRCo2VX0.mjs` lines 646-667 (region `src/gateway/server/ws-connection/connect-admission.ts`): an operator client is accepted when `maxProtocol >= 4 && minProtocol <= 4`; otherwise the gateway answers `INVALID_REQUEST` "protocol mismatch" with `details {code: "PROTOCOL_MISMATCH", clientMinProtocol, clientMaxProtocol, expectedProtocol: 4, minimumProbeProtocol: 3}` and closes with 1002. The pinned protocol package says `PROTOCOL_VERSION = 4` and `MIN_CLIENT_PROTOCOL_VERSION = 4` (`@openclaw/gateway-protocol@2026.10.6`, `dist/version.mjs`). The core already reads `expectedProtocol` into `ConnectionState.error.protocol` (`packages/core/src/connect-errors.ts`).

### Live

`probe.ts old-protocol`, a new device with the shared token, through the pinned `GatewayClient`:

```
connect offering protocol 3 only: {"outcome":"refused","message":"protocol mismatch: Control UI v3, Gateway v4, connection check min v3","code":"INVALID_REQUEST","details":{"code":"PROTOCOL_MISMATCH","clientMinProtocol":3,"clientMaxProtocol":3,"expectedProtocol":4,"minimumProbeProtocol":3}}
connect offering protocol 5 only: {"outcome":"refused", … "details":{"code":"PROTOCOL_MISMATCH","clientMinProtocol":5,"clientMaxProtocol":5,"expectedProtocol":4,"minimumProbeProtocol":3}}
```

Too old and too new get the same answer. The client tells them apart: `expectedProtocol` above its own means this client is too old ("Update required"); below means the gateway is (OpenClaw needs updating on the gateway's computer). Nothing in the handshake names a release date or a minimum client version, so "required" means only this.

## 8. `/compact` through `chat.send`

`chat.send` needs `operator.write` (`core-method-policy-DkntKRY_.mjs` line 1749); `sessions.compact` needs `operator.admin` (line 1320). The words come from `<openclaw>/dist/commands-handlers.runtime-DgTwDNGB.mjs` lines 1180-1182 (region `src/auto-reply/reply/commands-compact.ts`): "Compaction skipped", "Compaction failed", "Compacted (<before> → <after>)", "Server-side compaction (…)" or "Compaction finished (resulting context unknown)", then "• <context>". The bundled page says "The full conversation history stays on disk. Compaction only changes what the model sees on the next turn" and "Recent messages are kept intact" (`<openclaw>/docs/concepts/compaction.md` lines 13-21), and "If a turn is active, `/compact` gives it up to 60 seconds to finish before cancelling it" (lines 96-98).

### Live

`probe.ts compact`, `compact-steer` and `compact-default` on a new task with Juniper, at the interactive tier (admin only to change `compaction.mode` on this instance and back):

```
1. /compact in a new task, nothing in it: {"ok":true,"result":{"runId":"efcb0fcc-…","status":"started"}}
   history: [{"role":"user","text":"/compact"},{"role":"assistant","text":"⚙️ Compaction skipped: nothing compactable in this session yet • Context ?/128k"}]
3. /compact after three turns (compaction.mode "safeguard", the default):
   … {"role":"user","text":"/compact"},{"role":"assistant","text":"⚙️ Compaction failed: Compaction safeguard could not summarize the session: Summarization failed for 15 messages: …"}
   (every earlier row still there; no compaction row)
4. #slow-tool 20, then /compact (followup) 3 s in: the run ended at its own pace, then the notice "⚙️ Compaction failed: …"
   #slow-tool 15, then /compact (steer) 3 s in: the same
   #slow 110, then /compact (steer) 3 s in: notice after 64 s:
   {"role":"user","text":"#slow 110"},{"role":"user","text":"/compact"},
   {"role":"assistant","model":"gateway-injected","text":"⚙️ Compaction failed: … • Context 120/128k (0%) ⚠️ Your in-flight request was aborted by compaction — please resend it."}
   (the 110-second run left no reply)
compaction.mode "default": "⚙️ Compaction failed: Summarization failed: model returned no summary text • Context 120/128k (0%)"; compaction rows: []
compaction.mode after: safeguard
```

- `chat.send` always answers `{runId, status:"started"}`; the outcome is the notice.
- The notice is a history row `{role:"assistant", provider:"openclaw", model:"gateway-injected", idempotencyKey: <the send's runId>}`, and the `/compact` itself a user row with `idempotencyKey: "<runId>:user"`. No `openclawStatusNotice` flag is kept in history; the flag is on the live `chat` final only (`gateway-capabilities.md`, compaction). So the client recognises its own Compact by the idempotency key it sent.
- A success could not be produced: today's scripted model returns no summary text in either mode. The capability map's live run, with an earlier stand-in model, saw "⚙️ Compacted (120 → 33)" and a history row `{role:"system", __openclaw:{kind:"compaction", tokensBefore, tokensAfter, id, itemId}}` (`gateway-capabilities.md`, compaction; `research/dev-gateway/scenarios/compaction-success.mjs`). That row is the only proof of a compaction the design uses. **Read-only** for this note.
- The gateway's notice says nothing of which turns were summarized: "recent messages are kept intact", so not every turn before the row left the model's context.

## 9. Free disk: `node.hostStats`, `system.info`, and clean-up

- **A node.** `node.hostStats {nodeId, hostStats:{cpuCount, loadAverage?, memoryTotalBytes, memoryFreeBytes, diskTotalBytes?, diskAvailableBytes?, updatedAtMs}}` every 60 s and on `node.list`, at `operator.read` (`gateway-capabilities.md` §13 and its "Computer signals" table, live there with a headless node). The disk is the volume of the node's home folder: `tryReadDiskSpace(os.homedir())` (`<openclaw>/dist/startup-state-readiness-B7uq1p70.mjs` lines 184-205, region `src/node-host/host-stats.ts`); total and available come together or not at all (schema refinement, `<openclaw>/dist/nodes-D0d4NX0U.mjs` lines 67-68). **Live** `node.list` on `d7set`: `{"nodes":[]}`: this instance has no node, so no node figures were read here.
- **The gateway's own machine.** `system.info` (`operator.read`, `core-method-policy-DkntKRY_.mjs` line 1980; `collectSystemInfo`, `<openclaw>/dist/system-C_-PvNDr.mjs` lines 265-346) returns `disks: [{path, totalBytes, availableBytes}]` for the machine's mounted volumes and `diskTotalBytes`, `diskAvailableBytes` and `diskPath` for the volume of the gateway's state folder, read at most every 30 s. **Live**, read-only device: `{"diskPath":"~/.openclaw-clawtrate-dev-d7set","diskTotalBytes":994662584320,"diskAvailableBytes":19517849600}` and `disks` paths `["/", "<a mounted volume>"]`. It also returns the machine's name, host name, network address and processor, which a client must not log or show casually.
- **Which volume holds a bot's work.** `agents.list` (`operator.read`) gives each bot's `workspace` path. **Live**, read-only device: `main Juniper ~/.openclaw-clawtrate-dev-d7set/workspace`, `otto Otto ~/.openclaw-clawtrate-dev-d7set/workspaces/otto`. The list of volumes can be cut short when its collection times out (`readSystemDisks`, `<openclaw>/dist/system-C_-PvNDr.mjs` lines 205-235) with no completeness flag, and a `disks` row can be synthesized from the state folder's path (same file, lines 335-344), so a returned prefix that contains the workspace doesn't establish its volume. This response cannot confirm the volume containing the workspace; the report names the state folder's volume (`diskPath`).
- **Where a bot's commands run** is the Work pane's question, answered only as far as the gateway establishes it (`docs/design/work-pane.md` §16, `docs/design/controls.md` §14).
- **Clean-up a client can ask for.** The method policy has `sessions.cleanup` (line 1302) and `worktrees.gc` (line 844), both `operator.admin`. `sessions.cleanup` prunes OpenClaw's session store entries and reports entry counts, not space (`<openclaw>/dist/sessions-read-CLHMalI8.mjs` line 284); `worktrees.gc` queues maintenance of OpenClaw's managed worktrees (`<openclaw>/dist/worktrees-BDDatzIv.mjs` line 176). Neither deletes the largest files on a machine, and neither reports bytes freed. **Read-only-from-source.** So the report deletes nothing. A bot that deletes files does it with its own tools, under its command rules: whether it asks first depends on those rules, not on Clawtrate (F-159's dependency cell; `docs/design/controls.md` §3).

## 10. Language, spelling, hardware acceleration, security keys

- **Language.** The interface has no translation: its words are English literals in `packages/ui/src`, the pages say `<html lang="en">` (`apps/desktop/src/renderer/index.html`), there are no message catalogues and no locale handling, and the core sends `locale: "en-US"` to the gateway (`client.ts`, `buildConnectParams`). **Read-only-from-source.** Electron would give the system's preferred languages (`app.getPreferredSystemLanguages()`, `<electron-docs>/api/app.md`), but with one language there is nothing to choose.
- **Spelling.** "On Windows and Linux this is powered by Hunspell dictionaries, and on macOS it makes use of the native spellchecker APIs"; "For Electron 9 and higher the spellchecker is enabled by default"; "On macOS … there is no way to set the language … the native spellchecker will automatically detect the language"; on Windows and Linux "By default the spellchecker will enable the language matching the current OS locale", and "the hunspell dictionary files are downloaded from a Google CDN by default" (`<electron-docs>/tutorial/spellchecker.md`). `session.setSpellCheckerEnabled(enable)`, `isSpellCheckerEnabled()`, `setSpellCheckerLanguages` ("a no-op on macOS"), `setSpellCheckerDictionaryDownloadURL`, and the events `spellcheck-dictionary-initialized`, `-download-begin`, `-download-success` and `-download-failure` (`<electron-docs>/api/session.md`). Suggestions reach a menu only through the `context-menu` event's `dictionarySuggestions` and `misspelledWord`; Electron draws no menu by itself. **Read-only-from-documentation.** The app today sets no spellchecker option and handles no `context-menu` (`apps/desktop/src/main/index.ts`), and its request filter cancels every request that is not the app's own content or an `https` image (`lockDownSession`). Whether that filter also cancels the dictionary download on Windows was not tried.
- **Hardware acceleration.** `app.disableHardwareAcceleration()` "can only be called before app is ready"; `app.isHardwareAccelerationEnabled()` reads it back; `app.relaunch()` "Relaunches the app when the current instance exits" (`<electron-docs>/api/app.md`). So turning it off needs a restart, and the setting must be read from the app's own file before `app.whenReady()`. **Read-only-from-documentation.**
- **Security keys** for a bot's browser (F-395): a bot's browser runs on the gateway's machine or a node (`work-pane.md` §15), and no method in the capability map passes a key from the client to it (F-395's dependency cell: "none"). None of the 519 methods in 2026.10.6's method policy names a security key, WebAuthn, FIDO or a passkey (`core-method-policy-DkntKRY_.mjs`, searched). The browser's only WebAuthn code is a guard that warns when a passkey request would hold a headless browser (region `extensions/browser/src/browser/pw-session-webauthn.ts`), on the machine the browser runs on. **Read-only-from-source.**

## Resetting

`pnpm dev-gateway reset --instance d7set` after the probes, which stops the instance and deletes its state folder; the probe's client folders were in a scratch folder and were deleted.
