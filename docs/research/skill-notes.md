# The gateway's skill notes: what reaches a client

Observed on a development gateway running OpenClaw 2026.10.6, started with `pnpm dev-gateway start --instance <name> --with-skill-review --no-seed`. A `#learn` turn (ten model calls) was sent to Juniper (`main`) in a task with no channel, by the gateway's owner through `chat.send`, and watched by a paired operator with `operator.read` and `operator.write`. Read with the gateway's own source (`experience-review-*.mjs`, `transcript-*.mjs`, `session-transcript-*.mjs`, `agent-end-side-effects-*.mjs`).

## How the note is made

- After a turn ends, the gateway counts the task's model calls since its last review. At ten or more, or right after a turn that used a learned skill, it queues a background review of the task (`createSkillExperienceReviewScheduler`). The review waits for 30 seconds with nothing running, then runs in an internal session of its own (`agent:<bot>:internal-session-effects:skill-workshop-review_<id>`), on the task's model, with `skill_workshop` and some read-only tools.
- A review is queued only when the turn was offered `skill_workshop` (`skillWorkshopAvailable`), and `skills.workshop.autonomous.mode` is `auto`, which is its default. A development gateway denies `skill_workshop` unless started with `--with-skill-review`.
- When the review saved or changed a skill, the gateway writes one note into the reviewed task (`postWorkshopChangeNotice`): `💾 Learned: created `<skill>` (<reason>). Say "undo" to revert this skill change.` It also queues a system event for the task's next turn that names the exact `skill_workshop` call that undoes it.
- On a task with no channel the note is appended to the transcript as an assistant row. On a channel task it is sent to the channel as a message and mirrored into the transcript. Both carry the idempotency key `skill-workshop-notice:<review run id>`; only the first path was seen live.

## What a client receives

**`chat.history`** returns the note as the task's last row. Its key is on the row and under `__openclaw`, and the row names no run:

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "💾 Learned: created `trail-check` (check the trail before a hike). Say \"undo\" to revert this skill change."
    }
  ],
  "api": "openclaw-transcript",
  "provider": "openclaw",
  "model": "delivery-mirror",
  "stopReason": "stop",
  "timestamp": 1795493219893,
  "idempotencyKey": "skill-workshop-notice:skill-workshop-review:b777902a-4a73-4e07-bdec-672335179c03",
  "__openclaw": {
    "id": "31296f29-ff41-45c5-8056-0a076b5f271e",
    "idempotencyKey": "skill-workshop-notice:skill-workshop-review:b777902a-4a73-4e07-bdec-672335179c03",
    "recordTimestampMs": 1795493220012,
    "seq": 21
  }
}
```

`model: "delivery-mirror"` and `provider: "openclaw"` are not a mark of their own: a message a bot sends with its message tool has the same two (see [Pictures a bot hands over](../decisions.md#pictures-a-bot-hands-over)).

**Live**, about 30 seconds after the turn's `chat` `final`, the subscribed operator received one `session.message` event for the task, its `message` the same row with the same `idempotencyKey` on it and under `__openclaw`. No `chat` event and no `sessions.changed` event came with it. Thirty seconds later a `skills.changed` event (`{"reason": "workshop"}`) arrived.

**`sessions.list`**, read after the note:

| Field                | Before the note           | After the note                                                       |
| -------------------- | ------------------------- | -------------------------------------------------------------------- |
| `lastMessagePreview` | the bot's reply           | `💾 Learned: created trail-check (check the trail before a hike). …` |
| `updatedAt`          | the end of the turn       | the note's time                                                      |
| `lastActivityAt`     | the end of the turn       | unchanged                                                            |
| `unread`             | `true` until marked read  | unchanged: `false` stayed `false` when the task was read first       |

The row itself carries nothing that says its preview is the note. Its `updatedAt` is stamped after the note is written: 1795493220017 for a note whose `recordTimestampMs` was 1795493220012 and `timestamp` 1795493219893.

The preview is built from the transcript's last message with text (`findLastMessageText`, `session-transcript-title-reader`): `projectSessionDisplayMessage(message, {flattenMarkdown: true})`, which takes the assistant's text, trims it, flattens its Markdown to one line (`flattenMarkdownToPlainText`: fenced code dropped, inline code marks, link syntax, emphasis, strikethrough and line markers removed, runs of space made one) and cuts it to 240 characters as the first 237 and "...", never inside a surrogate pair. For the note above that is its text without the code marks.

## Rows that look alike

Read from the source, not produced live:

- **The review's run id** is `skill-workshop-review:` followed by `randomUUID()`, a lowercase UUID, so the note's whole key is `skill-workshop-notice:skill-workshop-review:<uuid>`.
- **Rows the gateway writes into a transcript itself** (`appendAssistantMessageToSessionTranscript`) have `api: "openclaw-transcript"`, `provider: "openclaw"` and `model: "delivery-mirror"`. The note takes this path whether it is written directly or mirrored after a channel send. So does a message a bot sends with its message tool, under the key the bot gives it (below).
- **A reply cut off by `chat.abort`** is kept (`persistAbortedPartial`) under the key `<the chat.send key>:assistant`, a key the caller chose, with `api: "openai-responses"`, `provider: "openclaw"`, `model: "gateway-injected"` and an `openclawAbort` record.

## A bot's message with the note's key

Observed on the same kind of instance, also started with `--with-message-tool`. The `#send-keyed` directive makes the bot call its message tool with `{action: "send", message: "The Saturday hike moved to Sunday at 9.", idempotencyKey: "skill-workshop-notice:skill-workshop-review:5e1f0c2a-7b3d-4e8f-9a6b-1c2d3e4f5a6b"}`. The tool's schema does not declare `idempotencyKey`, but the tool takes the bot's own key when it gives one and makes one up only when it gives none. With no channel, the send is the bot's reply in its own task, and `chat.history` returns this row for it, next to the note a `#learn` turn's review wrote in another task:

| Field                                | The bot's message                                       | The gateway's note                                      |
| ------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------- |
| `role`                               | `assistant`                                             | `assistant`                                             |
| `content`                            | one text block, the bot's words                         | one text block, "💾 Learned: …"                         |
| `api`, `provider`, `model`           | `openclaw-transcript`, `openclaw`, `delivery-mirror`    | `openclaw-transcript`, `openclaw`, `delivery-mirror`    |
| `usage`, `stopReason`                | all zero, `stop`                                        | all zero, `stop`                                        |
| `idempotencyKey`, on the row         | `skill-workshop-notice:skill-workshop-review:<the bot's uuid>` | `skill-workshop-notice:skill-workshop-review:<a uuid>` |
| `__openclaw.idempotencyKey`          | the same                                                | the same                                                |
| `__openclaw.runId`                   | the bot's turn                                          | none                                                    |
| `__openclaw` `id`, `seq`, `recordTimestampMs`, `transcriptPosition` | present                  | present                                                 |

The only difference is the run. It does not mark the note. A send to a channel is mirrored into the task the channel's peer maps to (`mirrorDeliveredPayloads`), with the bot's key and no run, and the note in a channel's task is mirrored by the same code, also with no run (read from the source, not produced here: a development gateway has no channel). So a bot can write a row with every field the note has.

## Undo

Saying "undo" in the task is the gateway's own way back: the queued system event tells the bot which call reverts the change. A client can also call `skills.workshop.restore`, which needs `operator.admin`.
