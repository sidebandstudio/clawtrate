# @clawtrate/core

The gateway client and the live conversation engine. A host process (Electron main, or the web preview host) owns one `ClawtrateClient`, which holds the gateway connection, the device key and every task's runs. The interface never talks to the gateway: it reads state snapshots and sends commands through a bridge. This guide is for building the interface on top of it. The reasons behind each behaviour are in `docs/decisions.md`.

## The bridge

The interface holds a `ClawtrateBridge` (`src/bridge.ts`):

- `getState()` and `subscribe(listener)`: the latest `ClawtrateState` and every later one. Hosts coalesce store updates to one snapshot per 16 ms (`batchSnapshots`).
- `send(command)`: run a `BridgeCommand` and ignore its answer.
- `invoke(command)`: run it and resolve with its answer, typed by `BridgeResultFor<C>`.
- `attach(file)`: hand a file's bytes to the host for a later message; resolves with an `AttachmentInfo` (`src/attachments.ts`) whose `id` the message names.

The desktop renderer gets one over IPC (`apps/desktop/src/renderer/bridge-desktop.ts`), and a browser gets one over the web host's socket (`createRemoteBridge` in `src/remote-bridge.ts`, used by `apps/desktop/src/renderer/bridge-web.ts`). Each window or tab is its own viewer (`createBridgeSession`). Hosts validate every command (`parseBridgeCommand`) before it reaches the client. A command that acts on a task is refused unless this viewer has that task open.

## What the interface calls

| To                                   | Command                                                                | Answer                                                  |
| ------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Open or close a task                 | `openSession` / `closeSession` with `key`                              | none                                                    |
| Create a task with its first message | `createTask` with `botId`, `text`, `label`                             | `{ key }`, already open for this viewer                 |
| Retry or forget a task creation      | `retryCreation` / `dismissCreation` with `creationId`                  | `{ key }` / none                                        |
| Send                                 | `sendMessage` with `key`, `text`, `mode: "auto"`, `attachmentIds`      | `{ messageId }`                                         |
| Steer                                | `sendMessage` with `mode: "auto"` while a run is running or waiting    | `{ messageId }`                                         |
| Queue after this turn                | `sendMessage` with `mode: "queue"`                                     | `{ messageId }`                                         |
| Send a queued message now, as steer  | `sendQueuedNow` with `key`, `messageId`                                | none                                                    |
| Cancel a queued message              | `cancelQueued` with `key`, `messageId`                                 | none                                                    |
| Take a held or queued message back   | `takeBackMessage` with `key`, `messageId`                              | `{ text, attachments }`, files held again under new ids |
| Send a held message again as new     | `sendAgain` with `key`, `messageId` (its files go with it)             | `{ messageId }`                                         |
| Retry or delete a message            | `retryMessage` / `deleteMessage` with `key`, `messageId`               | none                                                    |
| Stop                                 | `stopRun` with `key`, `runId`                                          | none                                                    |
| Answer or dismiss a question         | `answerQuestion` with `answers` / `dismissQuestion`                    | none                                                    |
| Resolve an approval                  | `resolveApproval` with `decision`, `expiresInDays`, `shownDigest`      | none                                                    |
| Read an approval's whole text        | `readApprovalText` with `key`, `approvalId`                            | `{ text, digest }`                                      |
| Read back a decision that failed     | `checkApproval` with `key`, `approvalId`                               | none; the card's state changes                          |
| Read a step's whole raw call/result  | `readStepRaw` with `key`, `stepId`                                     | `StepRead`, or null for an unknown step                 |
| Read a history item whole            | `readHistoryItem` with `key`, `itemId`                                 | `TranscriptItem`, or null                               |
| Request more access                  | `requestAccess`                                                        | none; progress in `connection.upgrade`                  |
| Connect, disconnect, retry           | `connect` (`url`, `token`), `connectDevGateway`, `disconnect`, `retry` | none                                                    |

There is no separate steer command. `mode: "auto"` starts a new run when the task has no active run, steers into the active run when it is running or waiting, and queues when it is stopping. `mode: "queue"` queues behind the active run whenever a run is active; with none it starts a run. While a question from the run is pending, every message is held, not sent, whichever mode it was sent with, until the last pending question is answered, dismissed or expires. A question counts as pending when the run waits on it, also when the task holds only its id: a run this client followed while nobody had its task open (a bot's recipient) keeps the question it waits on by id, carries it into the task when the task is opened, and settles it on `question.resolved` or when `question.list` no longer lists it. A question that settled is not asked again by a repeated request. Held messages are then released in order as a message sent at that moment would go: a steer into the running run unless it was queued, queued while the run stops, and queued, one run each, once the run has ended by itself.

A question answer maps each question id to its answers. Each answer is either text as typed or `{ option: index }`, where `index` is the option's `QuestionOption.index`. At most 3 questions and 8 answers each are accepted.

An approval offers only the decisions in its `allowedDecisions`; deny is always among them. `expiresInDays` (1 to 3650) goes only with `allow-always`. When `decisionCut` is set, only deny is accepted until this viewer has called `readApprovalText` and passes the returned `digest` as `shownDigest`. Echoing the card's own `decisionDigest` does not count. A decision that failed sets `decisionError`: `refused` only when the gateway's answer establishes the decision was not applied (the list, with its sources, is `REFUSED_DECISION_ANSWERS` in `src/approval-refusals.ts`), `unknown` for every other answer or none after it was sent. While it is `unknown`, no allow is accepted, and no Deny either if a Deny's outcome is among the unknown (`unknownDeny`), until `checkApproval` (run once by itself, and again after a reconnect) reads the request back: still pending clears it, settled shows how it ended. `stillOpen` says a read-back found a refused request still pending. Every decision and every read-back takes the next number in `attempt`. A decision's response settles only its own attempt, so one refused or unanswered decision never releases another still on its way (`inFlight`). A read-back's pending answer counts only when no newer attempt began after it was sent, and clears only an unknown outcome established before it was sent (`unknownAt`); otherwise it is dropped and, unless a newer read-back is on its way (`readingAt`), another is sent. At most one decision is on its way, except that a Deny may follow an allow: while `submitting`, `submittingDecision` names the latest. `decisionRefusal(card, decision)` says why a decision may not be sent now. These attempts belong to the approval, not to the task showing it: while a decision or read-back is on its way or an outcome is unknown, the client keeps them apart from any task (at most 256 approvals; past that a decision on another is refused), across a task's release and a reconnect. A task that shows the approval anew while something is outstanding marks its outcome unknown until a read-back sent after that answers; no list loaded on opening clears it.

A step's text on the snapshot (`argsText`, `output`, `result`) is a `StepText`: up to 2,000 characters of `text` plus the whole length in `totalChars`. The exact gateway payload is `Step.raw`, a `StepRaw`, carried inline only when its JSON form is at most 2,048 characters; otherwise it is null, and `readStepRaw` reads it. `readStepRaw` answers one of: `{ status: "available", raw }`, only when it has established that what it fetched is the step shown (for reasoning, a text beginning with the step's own; for a tool, its call id); `{ status: "cut-by-gateway", raw, receivedChars, reason }`, when the gateway's history holds the step only cut to its display length (`raw` is what it sent: the beginning of the text with the gateway's own marker after it; `receivedChars` is the length of the longest text the rebuilt step exposes, not of `raw`; show it as cut, never as whole); `{ status: "too-large-for-gateway", reason }`, when the gateway replaced the step's message with its placeholder for a message above 131,072 bytes (it will not return the text, so do not offer to try again); `{ status: "not-established", reason }`, when history holds something else at the step's place; or `{ status: "not-available-yet", reason }`, when history did not return the step: it may not hold it yet, or its page was too large to include it, so trying again later may help. Show the `reason`. `Step.truncated` says the gateway cut a step's text, reasoning included. A `TranscriptItem` whose `cut` names fields is read whole with `readHistoryItem`. `truncated: true` on an item means the gateway cut one of its rows: the item kept in state is read at the gateway's default display length (8,000 characters), so it says so whenever that cut it; the item `readHistoryItem` returns is read at the longest length the gateway gives (500,000) and says so only if it is still cut, or if a row above the gateway's 131,072-byte limit came back as its placeholder text. The gateway's cut is not a clean prefix: a cut text ends with the gateway's own marker, and a placeholder replaces the text altogether. None of these whole reads is kept in state.

Writes need access the device may not hold. The first send, stop, answer, resolution or creation on a read-only device asks the gateway's owner for `operator.write`, `operator.approvals` and `operator.questions` in one request; `requestAccess` asks without acting. While the request is pending, a message shows `awaiting-access` and the other actions wait. When the gateway refuses or the connection stops, they fail with an error the interface can show.

## The state

`ClawtrateState` (`src/types.ts`):

- `connection: ConnectionState`. `status` is `idle`, `connecting`, `pairing`, `connected`, `reconnecting` or `error`. `canWrite`, `canAnswer` and `canApprove` follow the scopes the gateway granted (`scopes`); a dropped connection clears them until the next hello. `upgrade: ScopeUpgradeState` tracks an access request and carries the request id and the approve command to show. `pairing` carries the same for pairing. `connectedAt` is the latest hello. Anything loaded before it is not yet known to be in sync.
- `discovery: DiscoveryState`, the bot and task lists. `partial` means the gateway listed more tasks than were read.
- `bots: Bot[]` and `tasksByBot: Record<botId, Task[]>`.
- `transcripts: Record<key, Transcript>`: one per task the client follows. On the web host a viewer's snapshot carries only the tasks that viewer has open (`viewerState` in `apps/desktop/src/web-host/server.ts`). The Electron window receives the client's whole state.
- `unroutedApprovals: ApprovalCard[]`: pending approvals no followed task can show yet. `unroutedApprovalsOmitted` counts the ones not kept.
- `creations: TaskCreation[]`: task creations asked for and not yet settled.
- `retention`: the estimated size of the state against its arithmetic bound. `near` is true past 80% of the bound.

`Transcript` is `TaskActivity` (`src/runs.ts`) plus the task's history:

- `status` (`loading`, `ready`, `error`), `items: TranscriptItem[]` (the last 200 history rows), `hasMore`, `loadedAt` (the latest successful history load), `interSession` and `linkedRuns` (`src/cards.ts`).
- `live`: the active run's text, derived from `runs`, for a view that draws one streaming bubble.
- `runs: Run[]`. Each run has `state`, `steps: Step[]`, `pendingCards`, `closedCards`, the streaming `text`, `error`, `ending` and `attemptErrors`.

Key a step's view state (expansion, selection, a link) by `Step.id`. A tool step's id is `tool:<toolCallId>`, the gateway's own. A reasoning step's id is derived from its place in its run, never its text: the nearest tool call before it, or the run's start, and how many reasoning blocks came since (`reasoningStepId`; the run's `reasoningAnchor` and `nextReasoning` say where the next one is numbered from). A reconciliation with history can change those places: history may hold a block the live stream never showed on its own, show one card's text as several blocks, or reveal a tool call the live stream missed, and then an id may vanish, appear, or name a different block than before. **The rule:** view state keyed by a reasoning step id (an open card, a selected raw view) is valid only while that run's `reasoningRevision` is unchanged. Remember the revision with the state; when the run's `reasoningRevision` changes, clear that run's reasoning view state. It never changes for tool steps. Clear it too whenever the task is reopened or a different history window replaces this one.

- `outbox: OutgoingMessage[]`, the user's messages until history holds them.
- `mcpTools`: the gateway's current map from a tool-server tool's effective name to its server and tool, read with `tools.effective` (`operator.read`) when the task's history loads and again on `plugins.changed`; at most 128. It is evidence of a call's tool before its result only: the gateway rebuilds it from its current catalog, which need not be what a running attempt captured, and a result's own `details.mcpServer` and `details.mcpTool` overrule it. One read of a task is in flight at a time: one asked for meanwhile is made once it answers, so a map from before a change cannot replace the one after it.
- `questions: QuestionCard[]` and `approvals: ApprovalCard[]` (`src/approvals.ts`), with `approvalAccess` and `approvalSources` saying whether the approval lists could be read at all. Each card keeps, as received, the records the gateway sent that settled it (`settledBy`: the `*.resolved` event, the reply to this client's request, or a read-back), one per source, and what this client sent to settle it (`sent`: method and parameters; the last 4 decisions for an approval, the answer or dismissal for a question). Each record is cut to 2,048 JSON characters; nothing is filled in where none arrived.
- `caughtUp`: set when the task was reloaded after an event gap or a reconnect.

`selectMessageCards` (`src/cards.ts`) derives the "Messaged <bot>" and MCP cards from a task's runs. It is a pure view and changes nothing in state.

Every bounded object may carry `cut?: string[]`, the paths of fields cut to their bound. It is a diagnostic list, not a safety fact; for approvals, that fact is `decisionCut`.

## What each state establishes

Runs (`RunState`):

- `queued`: held by this client until the active run ends. It has not been sent.
- `running`: the gateway's events say the run is under way.
- `waiting`: the run holds a card in `pendingCards`, because its lifecycle reported `waiting-approval` or it asked a question. An approval record alone does not make a run `waiting`.
- `stopping`: Stop was pressed and `chat.abort` is on its way or unanswered. The run becomes `stopped` when the abort took, or `completed` with `finishedBeforeStop` when it finished first. A failed stop puts the run back and sets `stopError`.
- `completed`, `stopped`, `failed`, `cancelled`: the gateway's terminal event, or history, said so.
- `reportedStartAt` is when the gateway says the run started (its lifecycle start, or the history snapshot); null until it says. `startedAt` may be this client's own send time.
- `bound` is false until the gateway has named the run; until then `id` is this client's key. `outcomeKnown: false` means the run is known to have ended but nothing established how; its terminal state is a stand-in.

Outgoing messages (`OutgoingStatus`): `sending`, then `sent` once the gateway accepted it. The message leaves the outbox when history holds it. `checking` means no answer came, so whether the gateway took the message is unknown and history is being read. `unknown` means no answer came and the history read since holds no row with its key: whether the gateway took it is still not known, and it is never shown as accepted; retry (same key) and delete apply, and a later history row with its key settles it. `unconfirmed` means it was accepted (the gateway answered), its run ended, and no history row ties to it. `handled` means the gateway treated it as a command and started no run. `failed` and `cancelled` are what they say. `held` and `queued` have not been sent. `not-sent` is every message whose frame had not left when a Stop was confirmed: held, queued, or released and still waiting in the task's delivery chain. Nothing starts by itself after a stop, so it stays unsent until `retryMessage` sends it (a run starts with it, same key) or `deleteMessage` removes it. Whether a message has left is recorded in one place, `leftAt`: the time its `chat.send` frame was handed to the connection, null while the message waits in this client. Entering the delivery chain clears it, the send sets it, and the stop rule reads only it, never the status; a message whose frame left is not parked and settles as the gateway answers it. The outbox lives in the host's memory: a renderer reload keeps it, since the host holds the state, but a host restart loses it, every unsent status included. A retry reuses the message id as the idempotency key, so the gateway delivers it at most once. A message that came from the queue keeps `mode: "queue"` through every attempt until it starts or is removed: a refused start is `failed` with `queue` (the shelf's "Couldn't start"), and `retryMessage` on it starts it at once when no run is active, or queues it again behind the active run (held while a question is pending), so a second refusal reads the same as the first.

Questions: `pending`, `answered`, `dismissed`, `expired`, `cancelled` (the run was stopped), or `closed` (no longer pending on the gateway, and this client did not see how it ended).

Approvals: `pending`, `allowed`, `denied`, `expired`, `cancelled`, `closed`. `inferred` means the terminal status is this client's inference (expiry passed, or a reload no longer listed it); the gateway's own outcome replaces it. `outcomeUnknown` means the gateway said the approval is settled but not how. `runEnded` means the approval is still pending after its run ended, and allowing it may still act.

Task creations: `creating`, `checking` (no answer; asked again with the same key), `failed` (refused; retry or dismiss), `unknown` (nothing establishes whether the task exists; a retry may create a second task), `created`.

Message cards: a tool start is the model's request, not a delivery, so a card is `started` until a result says more. `sentAt` is always null, because the gateway reports no delivery time. A late reply from another bot appears in `interSession` and is never attached to a card.

## Limits

- A viewer holds at most `MAX_VIEWER_OPEN_TASKS` (4) tasks open, and fewer when the host sets `maxOpenTasks`. It may have at most `MAX_VIEWER_PENDING_COMMANDS` (16) commands in flight.
- The client follows at most `MAX_TRACKED_TASKS` (8) tasks: open in some viewer, kept for unsent work after the last viewer closed them, or being created. The host may set fewer (`limits.trackedTasks`).
- Message text: at most `MAX_MESSAGE_CHARS` (32,000), never cut, refused if longer. One task's outbox holds at most 16 messages in any status. A new message past that is refused; nothing is dropped.
- Files: at most 20 per message; at most 64 files and 32 MiB waiting on the host, each kept for 15 minutes; images up to 6 MiB (less if the gateway says so), other files up to 20 MiB; the whole send within the gateway's frame limit. Oversized sends throw `SendTooLargeError` before anything is sent. Taking a message back (`takeBackMessage`) is all or nothing: its files are checked as one batch, bytes and count together, against what is left of those bounds before anything is cancelled or released. When they do not fit, the message stays exactly as it was, held or queued with its words and files, and the command is refused with `TAKE_BACK_NO_ROOM`, which says why in plain words. A restore never takes the waiting files past 64.
- The web bridge refuses a command frame over 64 KiB (`MAX_BRIDGE_FRAME_BYTES`). A command's answer on the web host must fit one result frame of `MAX_RESULT_CHARS` (262,144) JSON characters. An approval text too long for it is not given, so that approval stays deny-only for that viewer.
- Per task: 32 runs, 128 steps shared by its runs (older finished steps go first; `omittedSteps` counts them), 4 pending questions (`questionsOmitted`), 16 pending approvals (more wait in `unroutedApprovals`), the last 200 history rows. Earlier history pages are not loaded.
- Question cards show at most 8 options per question (`optionsOmitted` counts the rest) and 3 questions.
- At most 4 whole reads (`readStepRaw` from history, `readHistoryItem`, `readApprovalText`) run at once; a fifth is refused with an error to show.
- A host subscribes to the client's store (`client.store.subscribe`) at most `MAX_STORE_LISTENERS` (32) times at once; one more throws.
- A run this client started fails after 50 minutes (`DEFAULT_TURN_LIMIT_MS`). A request unanswered for 60 seconds fails locally.
- Not promised: a reasoning step's id once its run's `reasoningRevision` changed, or after its task is closed and reopened or read from a different history window; that a step's whole text can be read before history holds it; that history itself is uncut (`Step.truncated` and `TranscriptItem.truncated` mark what the gateway cut); delivery of a message whose status is `checking`, `unknown` or `unconfirmed`; any order or link between a late reply and the send it answers.

## Changes interface builders must adapt to

Since the guide first described the engine, these changes are not additive. Code written against the earlier surface has to change.

- `StepRead`, the answer of `readStepRaw`, has three more members: `cut-by-gateway`, `not-established` and `too-large-for-gateway`. An exhaustive `switch` on `status` must handle them. Only `available` carries the step's whole raw payload.
- `Run.reasoningAnchor` is a new required field, and `Run.nextReasoning` now counts the reasoning blocks since that anchor and starts again at 0 after each tool call; it used to grow for the whole run. Code that builds `Run` values must set both.
- `Run.reasoningRevision` is a new required field. View state keyed by a reasoning step id is valid only while it is unchanged (see "Key a step's view state" above).
- Reasoning step ids have a new form, `reasoning:<runId>:<anchor>:<n>`. They were always opaque; do not parse them.
- Removed exports: `EngineContext.ids` (the client-wide reasoning id allocator); `CLIENT_FOREIGN`, `VIEWER_FOREIGN` and `ATTACHMENT_FOREIGN`, replaced by `CLIENT_NOT_WALKED`, `VIEWER_NOT_WALKED` and `ATTACHMENT_NOT_WALKED`, records that give a reason for each property; `GATEWAY_HISTORY_RESPONSE_BYTES`. `HistoryMerge.fromHistory` is now a `Set<string>` of step ids, not a `Map` from step id to source id.
- New refusals a caller must handle: `client.store.subscribe` throws past `MAX_STORE_LISTENERS` (32) listeners, and `readApprovalText` now shares the gate of four concurrent whole reads with `readStepRaw` and `readHistoryItem`, so a fifth whole read of any kind is refused with an error to show.
- New in this round: the `not-established` and `too-large-for-gateway` results of `readStepRaw`, and `Run.reasoningRevision` with its rule.
