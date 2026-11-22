# Steering and Stop: what the gateway records

What an OpenClaw gateway does with a message sent while a run is going, and what Stop reaches, checked against OpenClaw 2026.10.6. It is the evidence behind the gateway cells of `docs/parity.md` rows F-096, F-097, F-100, F-101, F-106, F-296 and F-468, and behind issue #159.

How to read the citations, as in `gateway-capabilities.md` and `search.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package. Bundled chunk names carry a build hash that changes with every release; search by the `//#region <source path>` marker named with each citation. Line numbers are of the 2026.10.6 chunks.
- **Live** means it was run, and the output is quoted. **Source** means it was read in shipped code only.

Where it was run: one development instance, started by this checkout with `pnpm dev-gateway start --instance steerprobe`, with the standard seed and the scripted model. The probe is `steer-stop/steer-stop-probe.ts`. Each experiment pairs a new device with `operator.read`, `operator.write` and `operator.approvals` and the `approvals` capability, so that an exec approval waits for an answer instead of being denied as headless; it creates a new task of Otto's and removes the device when it ends. In the quoted output each run id is replaced by the name of the message that started it (`RUN`, `STEER`, …), and times are milliseconds from the experiment's start. The instance was reset when the work ended.

## Summary

| # | Question | Answer | Section |
|---|---|---|---|
| 1 | Does the acknowledgement say where a steer went? | No. `chat.send` answers `{runId, status: "started"}` before the steer is placed, in every case. Its `runId` is the send's own idempotency key, never the run it was sent into. **Live and source.** | 1 |
| 2 | Can a client learn that a steer joined the running turn? | Yes. A steer the turn takes in is acknowledged by one `chat` `final` with no message under the steer's own id, while the turn goes on; `agent.wait` then answers `ok` for that id, and history places the steer's user row (keyed `<id>:user`) inside the turn's rows, before its next reply. A steer the gateway holds instead keeps its id listed in `chat.history` `pendingInputs` (`state: "queued"`) and gets no `final`. **Live and source.** | 2 |
| 3 | When does a steer join, and in what order? | At the next runtime boundary: after the running tool returns, before the next model call. Several steers sent during one tool call all joined at that boundary. During a streamed reply they joined one boundary at a time, and one still waiting when the turn finished can run as a turn of its own instead, and is then stored after a later steer that joined. A steer sent while the run waits on an approval is held until the wait ends. **Live, and the gateway's own documentation.** | 3 |
| 4 | What happens to a held steer when the run is stopped by its id? | It is not stopped. `chat.abort {sessionKey, runId}` ends that run only (`runIds: [RUN]`), and the gateway then runs the held steer as a turn of its own, under the steer's id, with its own reply. **Live and source.** | 4 |
| 5 | Can a client withdraw an accepted message? | A held steer, yes: `chat.abort {sessionKey, runId: <the steer's id>}` answers `{aborted: true, runIds: [<id>]}`, sends `chat` `aborted` and a lifecycle `end` with `aborted: true` under that id, and the message never runs; `pendingInputs` lists it `cancelled`. `discardPendingInput: true` withdrew nothing for a held steer (`aborted: false`). A steer that already joined cannot be withdrawn (`aborted: false`). A withdrawn id cannot be sent again: a `chat.send` with the same idempotency key answers the stored abort (`status: "timeout"`, `summary: "aborted"`) and delivers nothing. **Live and source.** | 5 |
| 6 | Can one Stop reach the turn and the accepted messages together? | `chat.abort {sessionKey}` with no run id cancels the requester's queued and held turns first, then its active runs, and lists every one in `runIds`; nothing ran afterwards. But without a run id it does not stop the run's helper runs (controlled sub-agents), which `chat.abort` with the run's id does. So Clawtrate withdraws each held steer by its own id, then stops the run by its id. **Live and source.** | 6 |
| 7 | What do `followup` messages do on a Stop by run id? | They run: a `queueMode: "followup"` send is held as a queued turn (`pendingInputs` item with `queued: true`), and a Stop with the run's id leaves it to run afterwards. Clawtrate does not use the gateway's queue; its own queue is the client's. **Live.** | 7 |
| 8 | What does Stop not reach? | The recipient run of a `sessions_send` whose result carries no run id (a queued send): no record ties it to the stopped run. A steer whose send was not answered: its id is known, but whether the gateway took it is not. **Source and the capability map.** | 8 |

## 1. The acknowledgement

### Source

The send's run id is its idempotency key: `const clientRunId = p.idempotencyKey` (`<openclaw>/dist/chat-send-handler-D_7lP5Io.mjs` line 4271, region `src/gateway/server-methods/chat-send-handler.ts`). The handler resolves a steer's target only when the request says `queueMode: "steer"` (line 4995), and answers before the steer is placed, with the same payload whatever happens to it next: `{runId: clientRunId, status: "started", messageSeq?, interruptedActiveRun?}` (lines 6134-6147). Placing the steer happens after the answer, in `startChatDispatch`.

### Live

The answers to a steer that joined (`joined`) and to one the gateway held (`held`) have the same shape:

```
  1092 ms chat.send STEER {"queueMode":"steer"} -> {"runId":"STEER","status":"started"}
  2050 ms chat.send STEER {"queueMode":"steer"} -> {"runId":"STEER","status":"started"}
```

## 2. How a client learns that a steer joined

### Source

`finalizeAcceptedChatSendMessageInjection` (`<openclaw>/dist/chat-send-handler-D_7lP5Io.mjs` lines 875-986, region `src/gateway/server-methods/chat-send-message-injection.ts`) runs only when the runtime accepted the steer into the active turn (it returns `false` for a rejected one, which then falls back to a follow-up dispatch, lines 743-760). It waits for the transcript commit, records `{runId: clientRunId, status: "ok"}` for the send's id and broadcasts a `chat` `final` for that id with no message (`broadcastChatFinal`, lines 978-983). An indeterminate receipt broadcasts a `chat` `error` instead. No lifecycle event is sent under the steer's id. The gateway's own description agrees: "Steering accepted into the active turn still completes the input's `runId` after its transcript receipt, without completing the active turn" (`<openclaw>/docs/concepts/queue-steering.md`).

A pending input lives in `session_pending_inputs` until it is appended to the transcript, when its row is deleted (`<openclaw>/dist/session-accessor.sqlite-pending-inputs-CqCnrsh5.mjs` line 298); `chat.history` lists the rows as `pendingInputs.items` `{id, runId, state, acceptedAt, message, queued?}`, `state` one of `queued`, `interrupted` or `cancelled` (lines 199-207), at most 20 and no more than the request's `limit` (`<openclaw>/dist/chat-history-handler-ict2I1of.mjs` line 559, region `src/gateway/server-methods/chat-pending-inputs.ts`). `queued: true` marks an item the gateway holds as a queued turn (line 588). `chat.history {inputRunIds}` adds `inputReceipts` (lines 701-722): `pending`, `pending` with `cancelled`, or `consumed` with the event that consumed it, the last only for inputs folded into a `collect` batch.

### Live

`joined`: Otto runs a slow tool (`#slow-tool 8`); a steer goes in while it runs.

```
  [just after the steer's ack] pendingInputs=["STEER:queued"] inputReceipts=["STEER:pending"]
  [after the steer's own end] pendingInputs=[] inputReceipts=[]
  agent.wait RUN -> status=timeout
  agent.wait STEER -> status=ok ended
  history rows:
      1 user run=- key=RUN:user "Back up the photos. #slow-tool 8"
      2 assistant run=RUN key=- thinking toolCall
      3 toolResult run=RUN key=- "structuredContent:\n{\n  \"seconds\": 8,\n  \"status\": \"done\"\n}"
      4 user run=- key=STEER:user "Only the photos from this year."
      5 assistant run=RUN key=- thinking "This is the scripted development model. "
  events:
      1039 ms tool start coder__slow_task run=RUN
      9045 ms tool result coder__slow_task run=RUN
      9111 ms lifecycle model run=RUN
      9123 ms chat final run=STEER message=none
      9224 ms lifecycle finishing run=RUN
      9253 ms lifecycle end run=RUN
      9253 ms chat final run=RUN message=[{"type":"text","text":"This is the scripted devel…
```

So the gateway's record that a steer joined is the bare `final` under its own id while the run it was sent into is still going, and, once history has it, its user row followed by rows of that run. A history row of the user carries the idempotency key `<id>:user`, never a run id; the rows after it carry the run's id. `agent.wait {runId, timeoutMs: 0}` answered `timeout` for the run in two of three reads taken just after it ended, so a zero wait does not establish that a run completed.

## 3. When a steer joins, and the order stored

The gateway's documentation (`<openclaw>/docs/concepts/queue-steering.md`, "Runtime boundary"): a running tool call is never interrupted; waiting steering is checked after the tool batch settles, before the next model call, and the drained messages are appended after the tool results; "Messages that the runtime declines remain queued in their original order".

`order`: three steers sent one after another, each once the one before was answered, during one tool call:

```
  [after the three acks] pendingInputs=["STEER1:queued","STEER2:queued","STEER3:queued"]
      4 user run=- key=STEER1:user "Steer number 1."
      5 user run=- key=STEER2:user "Steer number 2."
      6 user run=- key=STEER3:user "Steer number 3."
      7 assistant run=RUN key=- thinking "This is the scripted development model. "
      9117 ms chat final run=STEER1 message=none
      9155 ms chat final run=STEER2 message=none
      9188 ms chat final run=STEER3 message=none
      9300 ms lifecycle end run=RUN
```

All three joined at the same boundary, were stored in the order sent, and one continuation of the run answered them.

`streaming`: the same three steers while the run streams a reply (`#slow 10`):

```
      3 user run=- key=STEER1:user "Steer number 1."
      4 user run=- key=STEER2:user "Steer number 2."
      5 user run=- key=STEER3:user "Steer number 3."
      6 assistant run=RUN key=- thinking "This is the scripted development model. "
     16952 ms chat final run=STEER1 message=none
     17199 ms lifecycle model run=RUN
     17359 ms chat final run=STEER2 message=none
     17430 ms lifecycle finishing run=RUN
     17462 ms chat final run=STEER3 message=none
     17536 ms lifecycle end run=RUN
```

Here the run took them in one boundary at a time, the last while it was finishing. Whether a steer still waiting when the turn finishes joins it is a race. The end-to-end check `F-106: under Steer…` sends four messages through the app during `#slow 15`, each once the one before was answered. In one run the first steer joined and the second was answered by a turn of its own after the run, as the gateway's documentation describes ("Once an OpenClaw turn has finished or handed off, new prompts wait for the next turn"). In another, history stored the three steers as first, third, second: the second waited past the turn's end and was stored when its own turn ran, after the third, which had joined. So a client can promise neither that every steer joins the running turn nor that history keeps the order sent. It can say which steer joined, from the bare `final` under each one's id, and show the order history records.

A run waiting on an exec approval is inside its tool call (`lifecycle waiting-approval`), so a steer sent then is held until the approval is answered or the run ends.

## 4. A held steer and a Stop by the run's id

### Source

With a run id, `chat.abort` aborts that run and the sub-agents it controls (`abortControlledSubagents`, `<openclaw>/dist/chat-abort-handler-ta8mBb_q.mjs` lines 526-545, region `src/gateway/server-methods/chat-abort-handler.ts`) and answers with that run alone. It does not touch other inputs of the session.

### Live

`held`: `#approve` waits on its approval; a steer is sent; Stop is the run's id.

```
  [steer sent while the approval waits] pendingInputs=["STEER:queued"] inputReceipts=["STEER:pending"]
  3569 ms chat.abort {"runId":"RUN"} -> {"ok":true,"aborted":true,"runIds":["RUN"]}
  agent.wait RUN -> status=error stopReason=rpc ended
  agent.wait STEER -> status=ok ended
  history rows:
      1 user run=- key=RUN:user "#approve"
      2 assistant run=RUN key=- thinking toolCall
      3 user run=- key=STEER:user "Only the notes folder."
      4 assistant run=STEER key=- thinking "This is the scripted development model. "
  events:
      1010 ms lifecycle waiting-approval run=RUN
      3568 ms chat aborted run=RUN message=none stopReason=rpc
      3569 ms lifecycle end run=RUN aborted status=cancelled
      3838 ms lifecycle start run=STEER
      3985 ms chat final run=STEER message=[{"type":"text","text":"This is the scripted devel…
```

The held steer started as a turn of its own 270 ms after the Stop, under its own id, and was answered. This is the case the issue describes: the acknowledgement named a turn of its own, which ran after the run it was meant for was stopped.

## 5. Withdrawing an accepted message

### Source

Without an active run of that id, `chat.abort {sessionKey, runId}` looks the id up among sends the gateway has accepted but not run (`readPreRegisteredAgentDedupePayloadForSession` and `writePreRegisteredChatAbort`, `<openclaw>/dist/chat-abort-handler-ta8mBb_q.mjs` lines 322-356) and among its queued turns (lines 390-428), and answers `runIds: [<id>]` when it cancelled one. `discardPendingInput` requires a run id (line 130) and withdraws only an input the gateway holds as a queued turn (lines 236-251); for anything else it answers `aborted: false`. The gateway's documentation: "An authorized Gateway client can withdraw a message still waiting in the OpenClaw runtime's steering queue or the followup queue, before delivery starts, with `chat.abort({ sessionKey, runId })` … Once delivery starts, cancellation cannot guarantee withdrawal" (`<openclaw>/docs/concepts/queue-steering.md`, "Canceling a pending steer").

### Live

`withdraw`: three steers while `#approve` waits. The second is withdrawn by its id, the third with `discardPendingInput`, then the run is stopped by its id, then the second is sent again with its own key.

```
  3645 ms chat.abort {"runId":"CANCELLED"} -> {"ok":true,"aborted":true,"runIds":["CANCELLED"]}
  3651 ms chat.abort {"runId":"DISCARDED","discardPendingInput":true} -> {"ok":true,"aborted":false,"runIds":[]}
  3672 ms chat.abort {"runId":"RUN"} -> {"ok":true,"aborted":true,"runIds":["RUN"]}
  [idle] pendingInputs=["CANCELLED:cancelled"] inputReceipts=["CANCELLED:pending:cancelled"]
  5265 ms chat.send {"idempotencyKey":"CANCELLED","queueMode":"steer"} -> {"runId":"CANCELLED","status":"timeout","summary":"aborted","stopReason":"rpc","endedAt":…}
  agent.wait CANCELLED -> status=error stopReason=rpc ended
  history rows:
      1 user run=- key=RUN:user "#approve"
      2 assistant run=RUN key=- thinking toolCall
      3 user run=- key=KEPT:user "Only the notes folder."
      4 assistant run=KEPT key=- thinking "This is the scripted development model. "
      5 user run=- key=DISCARDED:user "And sort by size."
      6 assistant run=09facdec key=- thinking "This is the scripted development model. "
  events:
      3644 ms chat aborted run=CANCELLED message=none stopReason=rpc
      3645 ms lifecycle end run=CANCELLED aborted status=cancelled
      3670 ms chat aborted run=RUN message=none stopReason=rpc
      3937 ms lifecycle start run=KEPT
```

The withdrawn steer never ran, and history holds nothing of it; the two that were not withdrawn each ran as a turn of its own after the Stop. A withdrawn steer's end comes as `chat` `aborted` and a lifecycle `end` with `aborted: true` and no lifecycle `start` before them. In `joined`, `chat.abort` with the id of a steer that had already joined answered `{"aborted":false,"runIds":[]}` and left the run going.

## 6. One Stop for the turn and the accepted messages

### Source

Without a run id, `chat.abort` plans the whole session (`prepareChatSessionAbort`, `<openclaw>/dist/chat-abort-runtime-DN2xZ73h.mjs` lines 591-790, region `src/gateway/server-methods/chat-abort-runtime.ts`): it cancels the requester's queued turns first (lines 706-715), then its active runs (lines 716-729), then sends it accepted but has not run, and records each in `runIds`. The gateway's documentation gives the reason for the order: "That order prevents queue drain from promoting work into a half-stopped session" (`<openclaw>/docs/concepts/queue.md`, "Queued-turn cancellation"). The method handler passes no `cascadeDescendants`, so this path does not stop the run's sub-agents (lines 796-830); the path with a run id does (section 4).

### Live

`stopall`: two steers while `#approve` waits, then `chat.abort` with no run id.

```
  3608 ms chat.abort {} -> {"ok":true,"aborted":true,"runIds":["RUN","STEER1","STEER2"]}
  [after chat.abort with no run id] pendingInputs=["STEER1:cancelled","STEER2:cancelled"] inputReceipts=["STEER1:pending:cancelled","STEER2:pending:cancelled"] status=killed
  agent.wait STEER1 -> status=error stopReason=rpc ended
  agent.wait STEER2 -> status=error stopReason=rpc ended
  history rows:
      1 user run=- key=RUN:user "#approve"
      2 assistant run=RUN key=- thinking toolCall
```

So there is a way to ask for both at once, but it would lose the helper runs that a Stop by run id stops (F-098). What Clawtrate's Stop can promise, from the gateway's answers:

- **The running turn**: stopped when `chat.abort` with its id answers `aborted: true`, and confirmed by its `chat` `aborted` (`stopReason: "rpc"`); `agent.wait` then answers `error` with `stopReason: "rpc"`.
- **A steer the gateway still holds**: withdrawn when `chat.abort` with the steer's own id answers `aborted: true` with that id; it never runs. Withdrawn first, then the run is stopped, in the gateway's own order, so the gateway cannot start it in between (in `held` it started 270 ms after the run's Stop).
- **A steer that joined**: part of the stopped turn; nothing more to stop.
- **A steer whose withdrawal was refused or not answered, or whose send was not answered**: not established. The gateway may still run it.

## 7. `followup` and the gateway's queue

`followup`: a `queueMode: "followup"` send while `#approve` waits, then a Stop with the run's id.

```
  [followup sent while the approval waits] pendingInputs=["FOLLOWUP:queued:queued"] inputReceipts=["FOLLOWUP:pending:queued"]
  3526 ms chat.abort {"runId":"RUN"} -> {"ok":true,"aborted":true,"runIds":["RUN"]}
  agent.wait FOLLOWUP -> status=ok stopReason=stop ended
      3 user run=- key=FOLLOWUP:user "Then list the notes folder."
      4 assistant run=4537b8e1 key=- thinking "This is the scripted development model. "
```

A queued turn is marked `queued: true` and ran after the Stop. Clawtrate holds "Queue after this turn" itself and sends it only once the run is over (`docs/decisions.md`, "Queue and hold"), so it never leaves a message in the gateway's queue.

## 8. What Stop cannot reach

- The recipient run of a `sessions_send` whose result has `status: "queued"` and no `runId`: the gateway gives no id that ties the recipient's later run to the stopped one (`gateway-capabilities.md`, bot-to-bot states). F-296 stays partial for that case.
- A steer whose `chat.send` got no answer: its id is known, but not whether the gateway took it, so a withdrawal answered `aborted: false` would not say whether it joined or was never there.
- Work a held steer would have caused is never started; work a joined steer caused is part of the stopped turn, and completed actions are not undone.
