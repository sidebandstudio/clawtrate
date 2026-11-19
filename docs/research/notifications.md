# Desktop notifications: what the gateway, Electron and the app allow

What a desktop notification from Clawtrate can truthfully say, when it can fire, where its settings can be kept, and what clicking it can open. Checked against OpenClaw 2026.10.6, Electron 45.3.2 (the version in `apps/desktop/package.json`), electron-builder 26.18.1 and this repository's code. It is the evidence behind `docs/design/notifications.md` and the rows F-202 to F-204, F-207 and F-367 to F-369.

How to read the citations, as in `gateway-capabilities.md`, `setup-flow.md` and `settings.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, the one the `openclaw` wrapper script runs. Chunk names carry a build hash that changes with every release; search by the `//#region <source path>` marker instead. Line numbers are of the 2026.10.6 chunks.
- `<electron-docs>/…` is a file under `docs/` of the Electron repository at the tag `v45.3.2`. The same text is in the JSDoc of `electron.d.ts` in the installed `electron@45.3.2`, cited as `electron.d.ts`.
- `<app-builder-lib>/…` is the installed `app-builder-lib@26.18.1`, which electron-builder 26.18.1 runs.
- Each fact is marked **tried** (run on a development instance of my own, the result quoted), **read from source** (shipped code only) or **read from documentation** (the documentation of the exact version only). Nothing in this note posted a system notification, changed a notification or focus setting, or launched a packaged app: what the operating system does is read from documentation and marked so.

Where things were run:

- **Development instance `d10notif`**, started by this checkout with `pnpm dev-gateway start --instance d10notif`, so `openclaw --profile clawtrate-dev-d10notif`, with the scripted model and `autoApproveLocal: false`. The probes are in `notifications/probe.ts` and use this project's own client (`packages/core`), as the desktop app does, with a client folder of their own for each device. Each device was approved with the gateway's own `devices approve <requestId>`, run through the development tool's guarded runner.
- **Four devices** of the gateway's one owner profile: **A** and **B** at Clawtrate's interactive tier (`operator.read`, `operator.write`, `operator.approvals`, `operator.questions`), **R** read-only (`operator.read`), and **X** with admin added, used only to delete a task. A started every run unless said otherwise. Every value the probe prints passes through its redaction: tokens, display names, this machine's names and addresses, and the home folder.

## Summary

| # | Question | Answer | Section |
|---|---|---|---|
| 1 | Who receives an approval request? | Only the device whose message started the run. B, at the same tier, received no `exec.approval.requested`, listed nothing in `exec.approval.list`, and its `exec.approval.resolve` was refused "unknown or expired approval id"; A's was accepted. With A disconnected the approval stayed pending and still invisible to B; A, reconnected, listed it again. **Tried.** | 1 |
| 2 | What do the other devices learn while an approval waits? | The run's lifecycle phase `waiting-approval`, then `approval-resolved`, on every connection, read-only included (`agent` events, `operator.read`). No id, no command, nothing to answer with. **Tried.** | 1 |
| 3 | Who receives a question? | Every connection holding `operator.questions`: A and B both received `question.requested` and listed it, and B's `question.resolve` was accepted, after which A's was refused "already cancelled". The read-only device received no question event and no lifecycle phase for it: only the `ask_user` tool's start and result (`session.tool`). A question raised in another bot's task (Marlow, working on a message from Pip) reached A and B under Marlow's own task key. **Tried.** | 2 |
| 4 | Which event says a run ended, and what can be said about it? | On every connection, read-only included, whether or not it started the run: `agent` lifecycle `end` with `stopReason`, then `chat` `final` carrying the reply's text; a failure is lifecycle `error` and `chat` `error`; a stop is `chat` `aborted` and lifecycle `end` with `stopReason: "rpc"`, `status: "cancelled"`. **Tried.** | 3 |
| 5 | Where can per-bot switches, task overrides and quiet hours be kept? | `users.prefs` on the gateway, per user profile: a value set by A was read back by B and R, both got `users.prefs.changed` with the key; R's write was refused (`operator.write`); a stale `expectedEntries` answered `conflict`; a value over 4,096 bytes was refused `value-too-large`, one of 4,094 bytes was kept; `null` removes a key. 32 entries per write and 128 keys per profile (source). Without a durable profile the answer is `no_durable_identity` (source). **Tried.** | 4 |
| 6 | What does the gateway's own Web Push already do? | Categories (approval requested on, agent finished, question, mention and failed routine off by default), a detail level `private` by default that names no bot, quiet hours `{enabled, startMinute, endMinute, timeZone}` that may span midnight, and a bot filter, kept in `users.prefs` under `notifications.web.v1`. During quiet hours its push is dropped, not delivered later. **Read from source.** | 5 |
| 7 | Can the app tell whether notifications are allowed, or whether a system quiet mode is on? | No, on either system. Electron 45.3.2 has no permission reading for its main-process `Notification` and points to userland modules; nothing in `app`, `systemPreferences` or `powerMonitor` reports Focus, Do Not Disturb or Focus Assist. What the app can observe is `failed` (macOS and Windows) when the system refuses one. **Read from documentation.** | 6 |
| 8 | What does a click return, and can a notification carry buttons? | `click` with no detail; `action` with an index for buttons. Buttons on macOS need a signed app with the alert style set in `Info.plist`; on Windows they work; on Linux only with a capable notification server. **Read from documentation.** | 6 |
| 9 | What happens while the app is not running, and after a restart? | The app shows its own notifications, so none appears while it is not running. A notification left in Notification Center or Action Center can be clicked later: on Windows `Notification.handleActivation` reports such a click (cold start included) with only the raw activation arguments; on macOS `Notification.getHistory()` lists delivered notifications again, only in a signed app. **Read from documentation.** | 6 |
| 10 | What does a click need to open the app at a target? | A live `Notification` object (its `click`) and the app's own record of what that notification was for. macOS: a code-signed app, or notifications fail. Windows: an AppUserModelID and a Start-menu shortcut with it, which the installer makes; Electron also names a ToastActivatorCLSID, which electron-builder's NSIS installer does not set. **Read from documentation and source.** | 6, 7 |
| 11 | What can be hidden from a lock screen? | Nothing per notification: Electron 45.3.2 has no option for lock-screen or preview visibility, and no reading of the system's preview setting. What the notification says is the only control the app has. **Read from documentation.** | 6 |
| 12 | What does the app already have? | The gateway connection lives in Electron's main process; macOS keeps the app running with no window, other systems quit when the last window closes. The dock or taskbar badge counts unread tasks, computed in the renderer. The single-instance lock focuses the window on a second launch. No protocol handler, no main-process notification, and the session refuses every web permission except clipboard writes, `notifications` included. **Read from source.** | 7 |
| 13 | Opening a task that is gone | `sessions.delete` (admin) removed the task from `sessions.list` and sent `sessions.changed` with reason `delete`; `chat.history` on the deleted key still answered ok, with no messages and a `sessionInfo`, exactly like a new task. Only the task list says a task is gone. **Tried.** | 8 |
| 14 | The budget notification on `m59-usage-budgets` | A web `Notification` from the renderer, once per budget and period, kept in the renderer's local storage; the desktop session refuses the `notifications` permission, so on the desktop it is most likely never shown. **Read from source**; not run. | 9 |

## 1. Approvals: who receives them, and what everyone else sees

### What the gateway does

`exec.approval.requested` and the other approval events need `operator.approvals` (`EVENT_SCOPE_GUARDS`, `<openclaw>/dist/server-start-D6vaUNGz.mjs` lines 4269-4339, region `src/gateway/server-broadcast-scopes.ts`). Holding the scope is not enough: the exec approval is offered to the surface that started the run, which `docs/design/controls.md` section 20 (row 30) already showed for plugin approvals. `agent` events need only read access and go to every operator connection that does not claim session-scoped events (`hasEventScope` and the recipient loop, same file, lines 4370-4532); Clawtrate claims only `tool-events` (`docs/decisions.md`, "Capabilities").

### Tried

`probe.ts two --bot otto --directive "#approve"`, A, B and R connected at once, A creating the task and sending:

```
A events since the send: {"sessions.changed":7,"session.message":2,"chat":3,"agent":11,"exec.approval.requested":1}
  A: {"event":"exec.approval.requested","requestSession":"agent:otto:dashboard:a84b53e7-…","id":"6af68f8a-6fb"}
  A: {"event":"agent",…,"stream":"lifecycle","phase":"waiting-approval"}
B events since the send: {"sessions.changed":7,"session.message":2,"chat":3,"agent":10,"session.tool":1}
  B: {"event":"agent",…,"stream":"lifecycle","phase":"waiting-approval"}
R (read-only) events since the send: {"sessions.changed":7,"session.message":2,"chat":3,"agent":10,"session.tool":1}
  R (read-only): {"event":"agent",…,"stream":"lifecycle","phase":"waiting-approval"}
A lists: {"exec.approval.list":{"forThisTask":1}, …}
B lists: {"exec.approval.list":{"forThisTask":0}, …}
R (read-only) lists: {"exec.approval.list":{"code":"FORBIDDEN","message":"missing scope: operator.approvals"}, …}
B exec.approval.resolve allow-once 6af68f8a: {"ok":false,"error":{"code":"INVALID_REQUEST","message":"unknown or expired approval id"}}
A exec.approval.resolve allow-once 6af68f8a: {"ok":true,"result":{"ok":true}}
— after the answers —
  B: {"event":"agent",…,"stream":"lifecycle","phase":"approval-resolved"}
  R (read-only): {"event":"agent",…,"stream":"lifecycle","phase":"approval-resolved"}
```

**When the sending device goes away.** The same run with `--leave`: A's client stopped three seconds after the send.

```
  B: {"event":"agent",…,"stream":"lifecycle","phase":"waiting-approval"}
B lists: {"exec.approval.list":{"forThisTask":0}, …}
B sessions.list row status: {"status":"running","hasActiveRun":true,"unread":true}
A again lists: {"exec.approval.list":{"forThisTask":1}, …}
```

The approval did not move to B; it waited for A, which listed it again after reconnecting.

**The task row says nothing of the wait.** Throughout, the `sessions.changed` rows for the task read `status: "running"`, `agentStatus: null`, `activitySummary: {"state":"unavailable"}` on all three devices; the only sign of the wait is the lifecycle phase. The core already reads it that way (`packages/core/src/waiting.ts`: "a run waits for an approval from its lifecycle's `waiting-approval` until `approval-resolved`, the approval's own `*.approval.resolved`, or the run's end").

### For the design

- The device that sent the message receives the request with its kind, bot, task and id: its notification can name the kind ("Otto wants to run a command") and open the card.
- Any other device, interactive or read-only, learns only that the run waits for an approval. Its notification can say that and nothing more, and it cannot offer an answer: the gateway refuses one from it. An admin connection also receives the card (`controls.md`, row 30); Clawtrate asks for admin only on an explicit request, so the design does not count on it.

## 2. Questions

### Tried

`probe.ts two --bot main --directive "#ask"` (the seeded Juniper is the bot `main`):

```
A events since the send: {…,"question.requested":1}
  A: {"event":"question.requested","sessionKey":"agent:main:dashboard:0f955361-…","id":"ask_ebb5ae55","recordStatus":"pending"}
B events since the send: {…,"session.tool":1,"question.requested":1}
  B: {"event":"question.requested","sessionKey":"agent:main:dashboard:0f955361-…","id":"ask_ebb5ae55","recordStatus":"pending"}
R (read-only) events since the send: {"sessions.changed":7,"session.message":2,"chat":3,"agent":9,"session.tool":1}
A lists: {…,"question.list":{"pendingForThisTask":1}}
B lists: {…,"question.list":{"pendingForThisTask":1}}
B question.resolve cancel ask_ebb5ae55: {"ok":true,"result":{"status":"cancelled"}}
A question.resolve cancel ask_ebb5ae55: {"ok":false,"error":{"code":"INVALID_REQUEST","message":"question 'ask_ebb5ae55…' is already cancelled"}}
```

R saw `session.tool` with the tool `ask_user`, phase `start`, then `result`, and no lifecycle phase between them. When A answered instead, both A and B received `question.resolved`.

**In another bot's task.** `probe.ts two --bot pip --directive "#message-ask"`: Pip messaged Marlow, and Marlow asked its user a question. A and B both received `question.requested` with `sessionKey: "agent:marlow:main"`, Marlow's own task, not Pip's.

### For the design

Questions are not routed to the sender: every interactive device can show the card and answer. A read-only device has no question event to notify from; the tool's name is not a wait the core tracks (`waiting.ts`: "the lifecycle has no question phase, so questions are kept by id"), and the design does not infer one from it.

## 3. A run's end

### Tried

On B and R, which did not start any of these runs (lifecycle `model` phases and `chat` status frames left out):

| Directive | B and R received |
|---|---|
| `#approve`, after A's allow-once | lifecycle `finishing` and `end` with `stopReason: "stop"`; `chat` `final` with the text "The command ran once you approved it, and its output is show…" |
| `#ask`, after the dismissal | lifecycle `end`, `stopReason: "stop"`; `chat` `final`, "No answer came back, so I will go with my best judgment." |
| `#model-error` | lifecycle `start`, `finishing`, `fallback_step`, `error`; `chat` `error` |
| `#slow 20`, stopped by A with `chat.abort` after 4 s | `chat` `aborted`; lifecycle `end` with `stopReason: "rpc"`, `status: "cancelled"` |

A task's row moves to `status: "done"`, `hasActiveRun: false` with reason `agent.input.settled` after a completed run.

### What the gateway's own push counts as finished

`resolveEventWebPushNotification` (`<openclaw>/dist/server-start-D6vaUNGz.mjs` lines 2612-2657, region `src/gateway/event-web-push.ts`) sends "OpenClaw agent finished" for a `chat` event with `state: "final"`, unless it is `yielded` or a transcript-only message (the gateway's own "nothing to say"). **Read from source.**

### For the design

"Finished" is a `chat` `final` that carries reply text; its first words are on every device. A failure is a definitive lifecycle `error` (the core's own rule, `docs/decisions.md`, "Run endings") with `chat` `error`; nothing in the event is fit to show as the reason. A stop is `stopReason: "rpc"` with `status: "cancelled"`, which someone chose. Runs the gateway starts itself (heartbeats, routines) end the same way; which of those notify is `docs/design/automation.md`'s.

## 4. Where the settings can be kept: `users.prefs`

### What the gateway does

`users.prefs.get {keys?}` (`operator.read`) and `users.prefs.set {entries, expectedEntries?}` (`operator.write`) keep JSON per user profile (`<openclaw>/dist/users-XXBiT3kC.mjs` lines 338-405; scopes `<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 2429-2437). Bounds, from `<openclaw>/dist/user-preferences-9JKSYgKc.mjs` lines 11-50 and `<openclaw>/dist/user-preferences.store-BbmywMbP.mjs` lines 109-125: a key is 1 to 256 characters; a value is at most 4,096 bytes of JSON; one write has at most 32 entries; a profile keeps at most 128 keys; `null` deletes; `expectedEntries` makes the write a compare-and-set that answers `conflict`. A connection with no authenticated profile gets `{status: "no_durable_identity"}`. A successful write sends `users.prefs.changed {profileId, keys}`. **Read from source.**

### Tried

`probe.ts prefs`, with A writing a value shaped like the design's (a bot switch, a task override, quiet hours with an IANA time zone):

```
A users.prefs.get: {"ok":true,"result":{"status":"ok","entries":{}}}
A users.prefs.set: {"ok":true,"result":{"status":"ok"}}
B users.prefs.changed: [["clawtrate.notifications.probe"]]
B users.prefs.get: {"ok":true,"result":{"status":"ok","entries":{"clawtrate.notifications.probe":{"version":1,"bots":{"otto":false},"tasks":{"agent:otto:example":"on"},"quiet":{"enabled":true,"startMinute":1320,"endMinute":420,"timeZone":"Europe/Lisbon"}}}}}
R (read-only) users.prefs.changed: [["clawtrate.notifications.probe"]]
R (read-only) users.prefs.get: {… the same value …}
R users.prefs.set: {"ok":false,"error":{"code":"FORBIDDEN","message":"missing scope: operator.write"}}
A set with a stale expectedEntries: {"ok":true,"result":{"status":"conflict"}}
A set with the current expectedEntries: {"ok":true,"result":{"status":"ok"}}
A set a value over 4096 bytes: {"ok":false,"error":{"code":"INVALID_REQUEST","message":"invalid users.prefs.set entry for clawtrate.notifications.probe: value-too-large"}}
A set a value of 4094 bytes: {"ok":true,"result":{"status":"ok"}}
A removes it (null): {"ok":true,"result":{"status":"ok"}}
A users.prefs.get after: {"ok":true,"result":{"status":"ok","entries":{}}}
```

All four devices belong to the instance's one profile, `gateway-owner`, so a second person was not observed; that preferences are per profile is from the source above. `no_durable_identity` was not reproduced here: every paired device of the development gateway has the owner's profile.

### For the design

Per-bot switches, task overrides and quiet hours can be one person's settings on the gateway, the same on every device of theirs, readable on a read-only connection and changeable from the interactive tier. A task override costs about 70 bytes (a 57-character task key and its value), so one 4,096-byte value holds a few dozen; the design keeps them in their own key and bounds their number. When the gateway answers `no_durable_identity`, the settings can only be this device's, and the screen has to say so.

## 5. The gateway's own Web Push, as precedent

`<openclaw>/dist/push-web-store.records-AJFEBd3j.mjs` lines 11-138 (region `src/infra/push-web-preferences.ts`), **read from source**:

- Kept in `users.prefs` under `notifications.web.v1`, with per-device overrides.
- Categories `approvalRequested` (on by default), `agentFinished`, `agentQuestion`, `humanMentioned`, `scheduledTaskFailed` (off).
- `detailLevel`: `private` (the default: "An agent completed its response.", no bot named), `identified` (the bot's name), `detailed`.
- Quiet hours `{enabled, startMinute, endMinute, timeZone}`: minutes 0 to 1439, an IANA zone checked with `Intl.DateTimeFormat`; equal start and end means never quiet; a start after the end spans midnight (`isWebPushQuietHours`).
- `agentIds`: an empty list means every bot.
- In `createEventWebPushDelivery` (`server-start-D6vaUNGz.mjs` lines 2658-2740) a push that falls in quiet hours is skipped (`continue`): it is dropped, not held. A question's push goes only to subscriptions holding `operator.questions`.

Clawtrate's desktop settings use the same quiet-hours shape, so a later phone design can read one value; the desktop design does not write `notifications.web.v1`, which belongs to the gateway's browser push.

## 6. What Electron lets the app know and do

All **read from documentation**: `<electron-docs>/api/notification.md`, `<electron-docs>/api/structures/notification-action.md`, `<electron-docs>/tutorial/notifications.md`, `<electron-docs>/api/app.md`, `<electron-docs>/api/system-preferences.md`, `<electron-docs>/api/power-monitor.md`, and `electron.d.ts` (`class Notification`, `NotificationConstructorOptions`, `ActivationArguments`).

| Question | macOS | Windows |
|---|---|---|
| Can a notification be shown at all? | `Notification.isSupported()`. It uses `UNNotification`, which "requires an application to be code-signed in order for notifications to appear. Unsigned binaries will emit a `failed` event". | `Notification.isSupported()`. "Your Electron app needs to have a Start Menu shortcut with an AppUserModelID and a corresponding ToastActivatorCLSID." |
| Can the app tell that notifications are allowed? | No. The tutorial's "Query notification state" points to a userland module (`macos-notification-state`). | No. It points to `windows-notification-state`. |
| Can it tell that a system quiet mode is on? | No: nothing in `Notification`, `app`, `systemPreferences` or `powerMonitor` reports Focus or Do Not Disturb. | No: nothing reports Focus Assist or Do Not Disturb. |
| What can it observe? | `show`; `click`; `close` (with a reason, "not guaranteed to be emitted in all cases"); `failed` with an error string, "while creating and showing the native notification". | The same; `close` also on timeout. |
| What does a click return? | `click`, an `Event` and nothing else. | The same; `Notification.handleActivation(callback)` reports every activation, also after a cold start or for a notification left in Action Center, with `type` (`click`, `action`, `reply`) and `arguments`, "the raw activation arguments string from Windows". |
| Buttons | Only the first is primary, the rest on hover; they need a signed app with `NSUserNotificationAlertStyle` set to `alert`. | Buttons work; a `selection` menu too. |
| Shown while the app is not running | Not possible: the app shows its notifications. A delivered one can stay in Notification Center; `Notification.getHistory()` lists them after a restart, only in a signed app, and a notification made with `new Notification()` leaves Notification Center when its object is garbage-collected. `Notification.remove(id)`, `removeAll()`. | Not possible. One left in Action Center can be clicked later and reported through `handleActivation`. `close()` "will try remove it from the Action Center". |
| What identifies a notification | `id` (the request identifier), `groupId` (thread). Text is cut beyond 256 bytes. | `id` (the toast's Tag), `groupId` and `groupTitle`. |
| Lock screen and previews | No option. | No option. |

Linux, which the issue mentions: notifications go through `libnotify`; buttons appear only when the notification server has the `actions` capability. Electron's `BrowserWindow` reports focus (`isFocused()`, `focus`, `blur`) on every system.

`powerMonitor` reports `resume` after sleep, and `lock-screen`/`unlock-screen` on macOS and Windows (`settings.md` §5); nothing in it concerns notifications.

## 7. What the app already has

**Read from source**, `apps/desktop/src/main/index.ts` unless named:

- **The connection lives in the main process** (`startHostRuntime`), so the main process sees every event while the app runs, with or without a window.
- **Closing the window.** `window-all-closed` quits except on macOS, where the app keeps running with no window, as macOS apps do. So on macOS notifications can continue after the window is closed; on Windows closing the window ends them.
- **The badge.** `badge.ts`: the renderer counts unread tasks (`packages/ui/src/unread.ts`, `Shell.tsx`) and sends the count; macOS and Linux set the dock count, Windows an overlay dot. With no window there is no renderer, so the count stays as last sent.
- **A second launch** focuses the running window (`requestSingleInstanceLock`, `second-instance`). No protocol client is registered (`setAsDefaultProtocolClient` is not called), and links into the app are `docs/design/links.md`'s.
- **Permissions.** `lockDownSession` grants only `clipboard-sanitized-write`, in both the request and the check handler; `notifications` is among the permissions those handlers decide (`electron.d.ts`, `setPermissionCheckHandler`). A renderer's web `Notification` is therefore refused.
- **Windows identity.** A packaged app sets its AppUserModelID to the bundle id (`identity.ts`). electron-builder's NSIS installer gives the Start-menu shortcut that id (`WinShell::SetLnkAUMI`, `<app-builder-lib>/templates/nsis/include/installer.nsh` lines 200-240); nothing there sets a ToastActivatorCLSID.
- **macOS signing.** By default the app is signed ad hoc (`docs/decisions.md`, "Unsigned by default"). Whether an ad hoc signature satisfies `UNNotification` is not stated by the documentation and was not tried.
- **Waiting across tasks.** `packages/core/src/waiting.ts` already keeps, for every task, whether it waits on an approval or a question and whether its last run was stopped, from the events above.

## 8. A task that is gone

`probe.ts deleted` on X (admin):

```
created: agent:otto:dashboard:28658b39-…
sessions.delete: {"ok":true,"result":{"ok":true,"key":"agent:otto:dashboard:28658b39-…","deleted":true,…}}
listed after delete: no
chat.history after delete: {"ok":true,"messages":0,"sessionInfo":true}
sessions.changed reasons naming the task: ["create","delete"]
sessions.list once more: not listed
```

On A, at the interactive tier, `sessions.delete` was refused "missing scope: operator.admin". Reading a deleted task's history succeeds and looks like a new, empty task, and another unit found that a send to a deleted task starts a new one silently. So whether a task exists comes from the task list and `sessions.changed`, and opening one never sends.

## 9. The budget notification on `m59-usage-budgets`

Read with `git show origin/m59-usage-budgets:<path>` and `git diff origin/main...origin/m59-usage-budgets`, never checked out. **Read from source**; not run:

- `packages/ui/src/usage/ConversationUsage.tsx`, `useBudgetNotifications`: in the renderer, when a budget's count first passes 80 percent in its period, a web `new Notification(title, {body, tag})`: "Otto used 82% of its budget" with "Otto has used 82% of its weekly budget: 1.64M of 2M tokens.", or at 100 percent "Otto reached its warning budget" with "This is shown only: nothing was stopped.". Once per budget and period, marked in the renderer's local storage (`clawtrate.budget-notified`). It runs only when `Notification.permission === "granted"`.
- `packages/ui/src/usage/Budget.tsx` asks `Notification.requestPermission()` when a budget is saved, for the web preview.
- Its end-to-end test runs in a browser page with a recorded `Notification` stand-in. Nothing in the branch changes the desktop main process, whose session refuses `notifications` (section 7), so in the desktop app the permission reads as not granted and the warning shows only as the line in the task.
- It has no click target, ignores quiet hours, and is the only notification in the code.

## 10. What could not be proven here

| What | Why | What the design does about it |
|---|---|---|
| That a notification appears, and what a click does, on macOS and Windows | No notification may be posted on this machine, and no packaged app launched | Every system behaviour is from Electron's documentation and marked so; the app reports what it can observe (`failed`) and claims nothing else |
| Whether the default ad hoc signature is enough for macOS notifications | Not stated by the documentation; not tried | The Notifications section says when the system refused one; it never says notifications are working |
| Whether a Windows toast from the NSIS install activates without a ToastActivatorCLSID | Not tried on Windows | Named for builders as a check to make first |
| A second person's preferences | The development gateway has one profile | Settings are described as "yours", kept with your profile |
| `no_durable_identity` | Every development device has the owner's profile | Designed from source: the settings are this device's and the screen says so |
| The system's lock-screen behaviour | System settings may not be read or changed here | The default text carries no message or command; more is the person's choice |

## Files

| File | What it is |
|---|---|
| `notifications/probe.ts` | The probes: `pair` and `upgrade` for each device; `two` (a run started by A with every device logging what it receives, the lists on each, an answer from B then A; `--leave` disconnects A while the run waits; `--stop` stops it); `prefs` (`users.prefs` across three devices, its conflict and size bounds); `deleted` (a task deleted, then read and listed). Acts only on a named instance; runs `openclaw` only through the development tool's guarded runner; redacts every token and name it prints. |
