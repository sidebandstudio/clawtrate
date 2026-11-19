# Group chats: what the gateway allows

What a "group chat with several bots" can be on an OpenClaw gateway, checked against OpenClaw 2026.10.6 and a development instance. It settles the dependency cells of `docs/parity.md` rows F-029, F-077 to F-080, F-179 and F-288 to F-290 and is the evidence behind `docs/design/group-chats.md`.

How to read the citations, as in `gateway-capabilities.md` and `setup-flow.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, the one the `openclaw` wrapper script runs. Bundled chunk names carry a build hash (`chat-send-handler-D_7lP5Io.mjs`) that changes with every release; search by the `//#region <source path>` marker at the top of each chunk. Line numbers are of the 2026.10.6 chunks.
- `schema` is `protocol.schema.json` in `@openclaw/gateway-protocol@2026.10.6`.
- **Live** means it was run on the development instance below and the result is quoted. **Source** means it was read in shipped code or bundled docs only, and could not be run here; each says why.

Where things were run: a named development instance, `pnpm dev-gateway start --instance d9grp`, with its four seeded bots and the scripted model, and the probe in `group-chats/group-probe.ts`, which pairs its own devices through the tool's `openOperator` (its pairing approved by id through the tool's guarded runner) and removes them when it ends. Each experiment is `node docs/research/group-chats/group-probe.ts <experiment> --instance d9grp`. On this gateway Juniper's agent id is `main`; the others are `otto`, `marlow` and `pip`. Ids, keys and run ids below are from those runs; the owner's display name and the state folder's path are left out.

## Facts other designs rely on

- **An approval request reaches, and can be resolved by, only the device bound to it, which is the device that sent the message that started the run:** a second device of the same person, holding `operator.approvals` and subscribed to the task with approvals, received no request, listed none in `exec.approval.list` and was refused "unknown or expired approval id" when it answered by id, while a read-only device saw only the run's `waiting-approval` phase; an admin connection may see and resolve it, which was read in the source (`canAccessOperatorApproval`) and not run (section 9).
- **An ordinary question is not bound that way:** every connection holding `operator.questions` received `question.requested`, listed it in `question.list` and could answer or dismiss it, wherever its run began; a read-only connection received nothing and was refused the list (section 9).
- **A `chat.send` to a task that was deleted starts a new, empty task under the same key without saying so:** `sessions.describe` answered `{session: null}`, the send answered `{status: "started"}` with no error, and the key then described a new task. A check before the send catches only a task already gone; a send that also carries the task's confirmed `sessionId` and `expectedLeafEntryId: null`, without `queueMode: "steer"`, is refused instead ("active branch changed; review and retry") and makes no task, while the same send with `queueMode: "steer"`, or with `sessionId` alone, still makes one (section 3).
- **Stop reaches only the runs this device may stop:** `chat.abort` on a task whose run another device started answered "unauthorized", and a task-wide abort ended this device's run while another device's input, accepted into the same task behind it, ran on to `final` (section 6).

## Summary

| # | Question | Answer | Section |
|---|---|---|---|
| 1 | Is there a session with several bots? | No. A task belongs to one bot: its key is `agent:<id>:…` and a send naming another bot is refused. `session.members` adds people, not bots; `sessions.groups` are sidebar folders; `session.discussion` is one task's thread on a provider, absent here. **Live.** The gateway's own multi-bot feature, channel "broadcast groups", runs several bots on one inbound channel message, needs admin configuration and a channel, and its docs say the Control UI has no team thread either. **Source.** | 1 |
| 2 | What is a group, then? | One task per bot, made with `sessions.create`, and one message to all is one `chat.send` per task. Each send answers on its own (`{runId, status:"started"}`), and each run ends on its own; the three ends of one message came in a different order from the sends. **Live.** | 2 |
| 3 | What orders the merged view? | The gateway's own clock: every history row has a `timestamp`, set by the one gateway all the tasks are on. A reply's saved time is not when its run ended: a six-second streamed reply was stamped before a short one that ended eight seconds earlier, so the saved order can differ from the order replies finished. Assistant rows carry no `agentId`; the task they come from names the bot. **Live.** | 2 |
| 4 | Can the copies of one message be told apart from other messages after a reload or on another device? | Yes. A run's id is the `idempotencyKey` the client sends, and the user row in history keeps `idempotencyKey: "<that key>:user"`. A client that puts one group-send id into each copy's key can join them. **Live.** | 2 |
| 5 | One of three refused, busy or failed | Refused: an archived member task answers "Session … is archived. Restore it before starting new work." while the others start. Busy: a send to a task whose run is active is accepted; it joined the run when the row carried `steerTargetRunId`, and when another device's run was active it waited in the task's `pendingInputs` and ran after. `started` acknowledges admission, not delivery. A deleted bot: "Unknown agent id". **Live.** A send to a task that no longer exists is not refused: it makes a new task under that key. **Live.** | 3 |
| 6 | Does a bot see what the others said? | No. Each task is its own conversation, and the scripted model received only its own task's turns. `replyToId` gives a bot the message replied to only when that message is in its own task; a message id from another task resolves to nothing. **Live.** A bot's own messaging tool, `sessions_send`, goes where the bot points it: in the run here, Marlow's message went to Pip's main task, not to Pip's task in the group. **Live.** | 4 |
| 7 | `@<bot>` and `@everyone` | `chat.send`'s `mentions` name human profiles, and are refused for this client: "Human mentions require a signed-in Control UI chat." The same text without `mentions` is stored exactly as typed. So a mention is the app's own routing, and the text each bot receives is what the person typed. **Live.** | 5 |
| 8 | Stop with several runs | One `chat.abort` per task, each confirmed with the runs it ended. An abort on a run another device started answered "unauthorized"; an input accepted behind the stopped run ran on. **Live.** | 6 |
| 9 | Where a group's name, members and order can be kept | `users.prefs`: read with `operator.read`, written with `operator.write`, one JSON value of at most 4,096 bytes per key, at most 128 keys per person, compare-and-set, `null` deletes. A second device of the same person read the record and received `users.prefs.changed`; a read-only device read it and was refused a write. **Live.** | 7 |
| 10 | What a deleted bot or a removed task leaves | A deleted bot's tasks go with it: history empty, `sessions.describe` null, a send refused. An archived task keeps its history and refuses sends until restored. Deleting a task needs it archived first, at write; it is then gone. **Live.** | 8 |
| 11 | Approvals in a group | An approval names the asking bot (`agentId`) and its task (`sessionKey`). It reached the device whose message started the run; a second device with the same scopes, subscribed to the same task with approvals, received nothing, listed nothing and was refused when it answered by id. A read-only device saw the run's `waiting-approval` phase. Always allow on Otto's command saved an entry under Otto alone. An ordinary question, by contrast, reached and could be answered by every connection with `operator.questions`. **Live.** | 9 |
| 12 | Can a send be kept from making a new task? | Yes, when it carries the confirmed `sessionId` and `expectedLeafEntryId: null` and no `queueMode: "steer"`: refused with "active branch changed; review and retry", no task made. Accepted as usual on a task with history and on a running task. **Live.** | 3 |

## 1. There is no session with several bots

**Live** (`nomulti`):

```
sessions.create key: "agent:main:dashboard:216797fc-060d-4463-b016-ea3fafc3c3d1"
chat.send to Juniper's task naming agentId otto: {"ok":false,"error":"agent \"otto\" does not match session key agent \"main\"","code":"INVALID_REQUEST"}
session.members.add with identityId agent:otto: {"ok":false,"error":"unknown identity","code":"INVALID_REQUEST"}
session.members.list: {"ok":true,"result":{…,"owner":{"type":"human","id":"gateway-owner",…},"members":[],"identities":[{"type":"human","id":"gateway-owner",…}],…}}
sessions.groups.list: {"ok":true,"result":{"groups":[],"sectionOrder":[]}}
session.discussion.info: {"ok":true,"result":{"state":"none"}}
```

The nearest things, and why none is a group chat:

- **Members of a task** (`session.members.*`, `operator.write`) are people who may see or use a task: the known identities are the caller, the task's creators and human profiles (`<openclaw>/dist/sessions-sharing-DX8n-lby.mjs` lines 32-58). Adding one does not change which bot runs the task.
- **Session groups** (`sessions.groups.list|put|rename|update|delete`, the schema's `methods`) are the sidebar's named folders: one catalog for the whole gateway, and a task joins one by its `category` (`<openclaw>/dist/session-groups-Bzdk3-Qi.mjs`, `//#region src/gateway/session-groups.ts`). They hold no conversation, a task can be in one folder only, and every person on the gateway sees the same folders. **Source and live** (the empty list above).
- **A discussion** (`session.discussion.info|open`) opens a thread about one task through a provider a plugin registers (`<openclaw>/dist/session-discussion-B0rTVszj.mjs`); with no provider it answers `{state:"none"}`, as here.
- **Broadcast groups** (`<openclaw>/docs/channels/broadcast-groups.md`, experimental) are the gateway's own way to run several bots on one message. They are keyed by a channel's conversation (`"telegram:-100123"`), set in the gateway's configuration (admin), and run each bot in its own session; follow-up rounds pass "an attributed, size-bounded digest of sibling finals" with an instruction to answer only when adding something new. The page's own limits say: "**Control UI:** a dedicated team-thread session is not yet available. Each participant keeps its own session." A client's `chat.send` is not a channel message, so a broadcast entry does not apply to it. **Source**: running one needs a real messaging channel, which a development instance does not have.
- **A bot's messaging tool** (`sessions_send`) sends one message from one bot's run to another bot's task (section 4). It is a message between two tasks, not a shared one.
- **A helper** (`sessions_spawn`) is a run its parent bot starts; it reports to that parent only (`gateway-capabilities.md`, "Approvals raised outside the user's own run").

## 2. A group is one task per bot, merged

**Live** (`fanout`): three tasks made with `sessions.create`, then the same text sent to each at once, as three `chat.send` calls, each with its own `idempotencyKey`:

```
three chat.send answers: [
 {"key":"agent:main:dashboard:81b93652-…","ok":true,"ms":196,"result":{"runId":"grp-f9762d4a-…","status":"started","messageSeq":1}},
 {"key":"agent:otto:dashboard:80d5d159-…","ok":true,"ms":291,"result":{"runId":"grp-9a4a1448-…","status":"started","messageSeq":1}},
 {"key":"agent:marlow:dashboard:6b48e212-…","ok":true,"ms":192,"result":{"runId":"grp-a9a35fc6-…","status":"started","messageSeq":1}}]
ends, in the order they reached the device:
 {"at":…583689,"sessionKey":"agent:marlow:…","state":"final"}
 {"at":…584136,"sessionKey":"agent:otto:…","state":"final"}
 {"at":…584649,"sessionKey":"agent:main:…","state":"final"}
history agent:main:…: [{"role":"user","timestamp":…578839,…},{"role":"assistant","timestamp":…584375,…}]
history agent:otto:…: [{"role":"user","timestamp":…578843,…},{"role":"assistant","timestamp":…583931,…}]
history agent:marlow:…: [{"role":"user","timestamp":…578844,…},{"role":"assistant","timestamp":…582685,…}]
```

- **Sent means each send answered.** Each `chat.send` returned its own run id. A message "to everyone" is as many sends as there are targets, and each can be accepted or refused on its own (section 3).
- **One clock, not the order of finishing.** All the tasks are on one gateway, and every row's `timestamp` is that gateway's. The three copies of the message were recorded 5 ms apart. A reply's saved time is not the time its run ended (`order`: Otto streamed for six seconds, Juniper answered at once):

  ```
  ends, in the order they arrived: [{"at":…909255,"key":"main"},{"at":…917402,"key":"otto"}]
  Juniper assistant rows: [{"timestamp":…909142,"agentId":null}]
  Otto assistant rows: [{"timestamp":…908758,"agentId":null}]
  ```

  Juniper finished eight seconds before Otto, yet Otto's saved reply sorts first. So the order saved messages take on a reload can differ from the order a person saw them finish. Assistant rows carry no `agentId`: the task a row comes from names its bot.
- **The replies end in any order.** Marlow's run ended first here although its send went last.
- **The copies can be joined.** The run id is the `idempotencyKey` sent (`grp-f9762d4a-…` above), and the user row keeps it: in the `reply` run, `"idempotencyKey":"4c25e9d6-38e2-4803-aa66-d61d6e67b580:user"` for run `4c25e9d6-38e2-4803-aa66-d61d6e67b580`. The schema allows any non-empty string (`ChatSendParams.idempotencyKey`, `minLength: 1`). A client that builds each copy's key from one group-send id and the bot can show one message once, after a reload and on another device of the person, from history alone.

## 3. What happens to one of the sends

**An archived member task refuses** (`refused`; archiving needs the task's current `sessionId` as `expectedSessionId`, "expectedSessionId required for session lifecycle patch" otherwise):

```
archive Marlow's task: {"ok":true,…,"entry":{…,"archivedAt":…,"archiveReason":"manual",…}}
three chat.send answers: [
 {"key":"agent:main:…","ok":true,"result":{"runId":"grp-cce383ce-…","status":"started","messageSeq":1}},
 {"key":"agent:otto:…","ok":true,"result":{"runId":"grp-3a41d400-…","status":"started","messageSeq":1}},
 {"key":"agent:marlow:…","ok":false,"error":"Session \"agent:marlow:dashboard:c6b8f1e2-…\" is archived. Restore it before starting new work."}]
ends: Juniper final, Otto final
```

The refusal is `session-work-start-DeX62NX0.mjs` line 232. A message with no text is refused before anything ("message or attachment required").

**A busy member takes the message into its running turn** (`busy`): Otto was given `#slow 8`, then the same three sends went out 1.5 s later.

```
three chat.send answers while Otto runs: Juniper {"status":"started","messageSeq":1}, Otto {"runId":"grp-6aa7634c-…","status":"started"} (no messageSeq), Marlow {"status":"started","messageSeq":1}
history Otto: user "#slow 8" · assistant (slow reply) · user "#text" with __openclaw.steerTargetRunId · assistant (plain reply)
```

Otto's session reports `effectiveQueueMode: "steer"`. The send answered "started" like the others; what tells the cases apart is the row's `steerTargetRunId` and the run's own events, which is what `conversation.md` section 6 already uses for the "Steer" caption.

**An input behind another device's run waits in the task** (`queuedstop`): device A started `#slow 6`, then device B sent `#text` to the same task.

```
A's run, then B's input into the same task: {"first":{"status":"started","messageSeq":1},"later":{"runId":"b5b571e0-…","status":"started"}}
pendingInputs while A's run is active: {"total":1,"items":[["acceptedAt","id","message","runId","state"]]}
A stops the task: {"ok":true,"aborted":true,"runIds":["f787d227-…"]}   (A's run only)
ends: A's run aborted, B's run final
steerTargetRunId on user rows: [null]
```

So `started` is an admission, not a delivery: the input may join the running turn (`steerTargetRunId` on its row), wait in `chat.history`'s `pendingInputs` (which names its `runId`), or start a run of its own; the row, `pendingInputs` and the run's own events say which. A member with a pending question, or a run being stopped, was not tried in a group: those copies follow `conversation.md` section 15 in that member's task, where the client holds or queues the message itself and nothing reaches the gateway until it is released.

**A task that no longer exists is made again by a send** (`refused`):

```
describe a task key that does not exist: {"ok":true,"result":{"session":null}}
a send to that key: {"ok":true,"result":{"runId":"c541cb97-…","status":"started"}}
describe it after the send: {"key":"agent:otto:dashboard:7eb06132-…","createdVia":"operator"}
```

So a client must check that a member's task still exists before it sends to it; sending blindly to a deleted member task starts a new, empty one. The check catches only a task already gone when it runs: a task deleted between the check and the send is made again by the send.

**The gateway's own guard** (`guard`): `chat.send` takes `sessionId` and `expectedLeafEntryId`. When `queueMode` is not `"steer"` and `expectedLeafEntryId` is given, the handler refuses the send unless `sessionId` matches the task now at that key (`assertExpectedLeafActive`, `<openclaw>/dist/chat-send-handler-D_7lP5Io.mjs` lines 3488-3501, applied at lines 3933, 4044 and 4997; with `sessionId` given, line 3499 lets an ancestor of the active entry pass, and live a task with history accepted `null`). `sessionId` alone only fails a send whose task still exists under another identity (line 4998); it does not stop a send to a deleted task.

```
guarded send to a task with history (sessionId, expectedLeafEntryId null): {"ok":true,"result":{"status":"started"}}
deleted between check and send, then an unguarded send: started; the key now holds a new session id
sessionId alone, after deletion: started; the key now holds a new session id
sessionId and expectedLeafEntryId null, after deletion: {"ok":false,"error":"active branch changed; review and retry","details":{"reason":"active-leaf-changed"}}
session at the key after the refused send: null
the same with queueMode steer, after deletion: started; the key now holds a new session id
guarded send while the task runs: started; both runs ended final
```

So a send guarded with the task's confirmed `sessionId` and `expectedLeafEntryId: null`, with no `queueMode` (the task's own default then applies), is refused when the task has gone, on an empty task, a task with history or a running one. A send with `queueMode: "steer"` cannot be guarded this way and remakes a deleted task.

**A deleted bot refuses** (`delbot`): `chat.send` answered "Unknown agent id \"probe-wren\"" (section 8).

**Making the tasks** (`create`): a label is unique per bot, not across bots.

```
create Juniper's task (label "Weekend plans …"): ok
create Otto's task with the same label: ok
create a second Juniper task with the same label: {"ok":false,"error":"label already in use: Weekend plans …"}
create a task for an agent that does not exist: {"ok":false,"error":"Unknown agent id \"nobody\""}
```

A group made of several `sessions.create` calls can therefore end with some tasks made and one refused. The tasks made are ordinary tasks of their bots.

## 4. What a bot sees

- **Its own task only.** Each run's model request held that task's turns and nothing from the others. The scripted model's log for a `fanout` run, one line per bot (the owner's name and the host left out):

  ```
  completion messages=su tools=16 steps=text last=user:"[Thu 2026-11-19 07:11 EST] Conversation info: ⟦openclaw:ctx⟧\n```json\n{\"sender\":{\"id\":\"gateway-owner\",\"name\":\"<owner>\"}}\n```\n\n#text\n\nRuntime: name=Marlow | agent=…
  completion messages=su … name=Otto …
  completion messages=su … name=Juniper …
  ```

  `messages=su` is one system prompt and one user turn: the person's text, which the gateway wraps with the time, the sender and the bot's own runtime line. Nothing from the other two tasks is in it.
- **Replying** (`reply`): `chat.send {replyToId}` names a message the reply answers (`<openclaw>/dist/chat-send-handler-D_7lP5Io.mjs`, `//#region src/gateway/server-methods/chat-send-reply-context.ts`, lines 646-707). The gateway looks it up **in the same task** and, when found, gives the bot its text and sender, up to 2,000 characters.

  ```
  reply to Juniper's message in Juniper's task: ok; the model received "Reply target of current user message: … {"message_id":"cb655858-…","sender_…"
  the same replyToId sent to Otto's task: ok; the model received only {"message_id":"cb655858-…"}
  history Juniper: the user row carries replyToId, replyToMessage and replyToPreview
  history Otto: the user row carries replyToId and replyToMessage, and no preview
  ```

  So a reply reaches the bot that wrote the message, with that message as context. A reply id from another bot's task gives the receiving bot nothing to read.
- **The bot's own messaging tool** (`relay`): Marlow, given `#message` in a new task, called `sessions_send {"agentId":"pip", …}`, and the result named `"sessionKey":"agent:pip:main"` with Pip's reply. Pip's task made for the probe received nothing. The tool sends where the bot points it, under the messaging policy of `docs/design/controls.md` section 11; a bot does not know a group's other tasks unless told their keys.
- **What passing replies along would cost.** A client could send each bot's reply to the other members as a message in the person's name. Every reply would then be a new turn for every other bot (n−1 runs per reply), and each of those replies would again be a turn for the others unless a fixed bound stopped it. The gateway's own broadcast groups bound this with `maxRounds` (1 to 4) and `maxTurns` (1 to 32), a digest capped at 4,000 characters per bot and 16,000 in all, and a `NO_REPLY` instruction, and say that "a Gateway restart loses the active round and budget state" (`broadcast-groups.md`, "Bounded follow-up rounds"). For a client the bound would live only in the client, the messages would be in the person's name without the person writing them, and a second device or a restart would not know the round. This was not built or run here; the design does not pass replies along (`group-chats.md`, section 2).

## 5. `@<bot>` and `@everyone`

**Live** (`mentions`):

```
chat.send with a mention of the bot's name: {"ok":false,"error":"Human mentions require a signed-in Control UI chat. Remove the selected mentions to use this mode.","code":"INVALID_REQUEST"}
chat.send of the same text without mentions: {"ok":true,"result":{"runId":"cd3071dd-…","status":"started","messageSeq":1}}
history: [{"role":"user",…,"text":"@Juniper #text"}, {"role":"assistant",…}]
```

`mentions` is `{profileId, start, end}[]`, at most 10, each span starting with `@` (schema `ChatSendParams.mentions`; `chat-send-handler-D_7lP5Io.mjs` lines 5356-5403). The handler refuses them unless the client is OpenClaw's own browser interface with a signed-in profile (line 5457), and checks the named profiles as people who may be told (`mentionInbox.validateRecipients`, line 5561). Nothing in them selects a bot. A bot's name in the text is plain text, stored as typed.

## 6. Stopping several runs

**Live** (`stop`): three runs of `#slow 10`, then `chat.abort {sessionKey}` on each.

```
chat.abort on each: [{"ok":true,"aborted":true,"runIds":["grp-99f84710-…"]}, {"ok":true,"aborted":true,"runIds":["grp-e4be340c-…"]}, {"ok":true,"aborted":true,"runIds":["grp-44ee190b-…"]}]
ends: Juniper aborted, Otto aborted, Marlow aborted
chat.abort on a task with no run: {"ok":true,"aborted":true,"runIds":[]}
```

Each abort answers for its own task and names the runs it ended; an abort on a task with nothing running answers with an empty list.

**Whose runs a device may stop** (`stopdevices`, `queuedstop`): device A started Juniper's run and device B started Otto's.

```
A stops Otto's task (B's run): {"ok":false,"error":"unauthorized","code":"INVALID_REQUEST"}
B stops Juniper's task (A's run): {"ok":false,"error":"unauthorized","code":"INVALID_REQUEST"}
A stops Juniper's task (its own run): {"ok":true,"aborted":true,"runIds":["796afb9f-…"]}
ends: Juniper aborted, Otto final
same device, a later input, then A stops only the first run by id: runIds [the first run]; the later input's run ended final
```

A run records the device and connection that started it, and a non-admin requester may abort it only when one of them matches, or when the run records neither (`canRequesterAbortChatRun`, `<openclaw>/dist/chat-abort-runtime-DN2xZ73h.mjs` lines 61-70); a task-wide abort that finds only runs it may not stop answers "unauthorized" (lines 677-689; `chat-abort-handler-ta8mBb_q.mjs` lines 182-205). An admin requester passes (line 67, source). A stop that times out was not produced here.

## 7. Where the group's record can live

**Live** (`prefs`), with two interactive devices `a` and `b` and a read-only device `r`, a record under one key, `clawtrate.group.<id>`, holding the name, the members (bot and task key) in order, and the time it was made:

```
a: users.prefs.get before: {"status":"ok","entries":{}}
a: set, must be absent: {"status":"ok"}
a: the same set again, must be absent: {"status":"conflict"}
b: get: {"status":"ok","entries":{"clawtrate.group.21087b0b":{"v":1,"name":"Weekend plans","members":[{"agentId":"main",…},{"agentId":"otto",…},{"agentId":"marlow",…}],…}}}
b: users.prefs.changed received: [{"profileId":"gateway-owner","keys":["clawtrate.group.21087b0b"]}]
r (read only): get: the same record; users.prefs.changed received the same event
r (read only): set: {"ok":false,"error":"missing scope: operator.write","code":"FORBIDDEN"}
b: rename with compare-and-set on the old record: {"status":"ok"}
a: rename with the now stale record: {"status":"conflict"}
a: get: name "Saturday"
a: a value over 4,096 bytes: {"ok":false,"error":"invalid users.prefs.set entry for clawtrate.group.21087b0b-big: value-too-large"}
a: past the key limit: {"ok":false,"error":"users.prefs.set exceeds the 128-key profile limit (current count: 97)","details":{"code":"USER_PREFS_LIMIT_EXCEEDED","limit":128,"currentCount":97}}
a: delete the group (null): {"status":"ok"}
b: get after delete: {"status":"ok","entries":{}}
a: users.self and b: users.self: {"profile":{"id":"gateway-owner","displayName":"<the owner's name>",…}}
```

- Both devices were the same person (`gateway-owner`) and saw one record. `users.prefs.get` and `users.self` are `operator.read`, `users.prefs.set` is `operator.write` on 2026.10.6 (`<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 679-682 and 2429-2438; `gateway-capabilities.md` notes that 2026.11 lowers the write to read).
- A record of six members with task keys of about 60 characters each is under 1,000 bytes, well within 4,096.
- The 128 keys are shared with every other preference this person keeps on the gateway, Clawtrate's and others'.
- `{status:"no_durable_identity"}` is what a connection made with the shared token alone gets (`gateway-capabilities.md`, "users.prefs"); the paired devices here all had a profile.
- The record is the person's: another person on the same gateway would not see it.

## 8. What a deleted bot, an archived task and a deleted task leave

**Live** (`archive`, then `delbot` with an admin device):

```
archive: ok · history of the archived task (count): 2 · listed without archived: false · listed with archived:true: true
send to it while archived: "Session \"agent:main:dashboard:38fc16fe-…\" is archived. Restore it before starting new work."
restore: ok
delete without archivedOnly (write): {"ok":false,"error":"missing scope: operator.admin"}
archive again: ok · delete archivedOnly (write): {"ok":true,"deleted":true,…}
history after delete: {"messages":[],"totalMessages":0,…} · describe after delete: {"session":null}

agents.create "Probe Wren": ok · its task made · agents.delete: {"ok":true,"removed":[… agent store, sessions, workspace: "trash" …]}
history of its task after: {"messages":[],…} · send to its task after: "Unknown agent id \"probe-wren\"" · sessions.describe after: {"session":null}
```

`sessions.delete` at write needs `archivedOnly: true` (`gateway-capabilities.md`, section 4). A deleted bot's store, tasks and workspace are moved to the trash by the gateway; a client sees them as gone.

## 9. Approvals in a group

**Live** (`approval`): devices `a` and `b` held read, write, approvals and questions and subscribed to the two tasks with `includeApprovals: true` (both subscriptions answered `subscribed:true` with an empty `approvalReplay`); `r` held read only. `a` sent `#approve` to Juniper's and Otto's tasks.

```
a: exec.approval.requested: {"agentId":"otto","sessionKey":"agent:otto:dashboard:1f3e6e6c-…","command":"ls","allowedDecisions":["allow-once","allow-always","deny"],…}
b: approval events: []
r: approval events: [] · r: lifecycle waiting-approval seen: true
b: exec.approval.list: []
b resolves allow-once: {"ok":false,"error":"unknown or expired approval id","details":{"reason":"APPROVAL_NOT_FOUND",…}}
a resolves allow-always: {"ok":true}
ends: Juniper final, Otto final
exec.approvals.get (admin): agents with an allowlist: {"otto":["/bin/ls", …]}
```

- **Who sees it.** An approval record carries the reviewer devices it is bound to; a client that is not admin may see and answer it only when its device is one of them (`canAccessOperatorApproval`, `<openclaw>/dist/operator-approval-authorization-C9wV2RU-.mjs`; `matchesOperatorApprovalReviewerBinding`, `<openclaw>/dist/operator-approval-reviewer-binding-Bwb8-kfM.mjs` lines 5-10). Here that was the device whose message started the run. An admin connection passes the check (source). `controls.md` row 30 found the same for the rules plugin's cards.
- **What it names.** `agentId` and `sessionKey` say which bot asks and in which task, so a group can name both.
- **What Always allow saves.** The entry went into Otto's own allowlist in the approvals file, under `agents.otto`; Juniper's and the others' were untouched. What it covers is the gateway's to decide, as `conversation.md` section 12 says.
- Juniper's `#approve` was refused by policy (the development gateway denies every bot's shell but Otto's), so one message to two bots gave one card.

**Questions are seen differently** (`cards`): device A sent `#approve` to Otto's task and `#ask` to Juniper's; B held the same scopes; `r` held read only.

```
question: {"id":"ask_3f4b…","runId":"f9adc2f3-…","sessionKey":"agent:main:dashboard:4d2c…"}
approval: {"id":"356b89db-…","runId":"a36bfcc7-…","sessionKey":"agent:otto:dashboard:9ebe…"}
events seen: {"a":{"question":1,"approval":1},"b":{"question":1,"approval":0},"r":{"question":0,"approval":0}}
b: question.list: [{"id":"ask_3f4b…","agentId":"main","sessionKey":…,"runId":…,"status":"pending",…}]
b: exec.approval.list: []
r: question.list: {"error":"missing scope: operator.questions"}
b dismisses A's question: {"status":"cancelled"}
b answers A's approval: "unknown or expired approval id"
a denies its approval: {"ok":true}
```

A connection holding `operator.questions` has broad access to questions; own-run access applies only without that scope (`usesOwnRunQuestionAccess`, `<openclaw>/dist/question-access-BY5GPhIx.mjs` lines 4-9). An approval's access is the reviewer binding above. Both requests carry the run's `runId`, `sessionKey` and `agentId`, so a card can be keyed by member task, run and request.

## 10. What could not be proven here

- **Broadcast groups in a client.** Read from the docs only; a development instance has no channel. Nothing here depends on them.
- **An approval when the device that started the run is gone.** Whether the request then routes to another device, waits, or is refused as having no route was not tried.
- **A pending question or a stopping run in one member while a group message goes out.** Not run in a group; those copies follow `conversation.md` section 15 inside that member's task, as a message typed there would.
- **A stop request that times out** was not produced; a refused one was (section 6).
- **An admin connection stopping another device's run, or answering its approval.** Read in the source only.
- **Two people on one gateway.** Every device here was the owner's profile. A second person's preferences are their own (the store is per profile), so they would not see the owner's groups; not run.

## Files

- `group-chats/group-probe.ts`: the probe. It refuses to run without `--instance`, acts only through the development tool's own operator connection and guarded runner, prints no token, and removes the devices it paired.
