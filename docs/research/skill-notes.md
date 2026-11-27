# The gateway's skill notes: what reaches a client

Observed first on a development gateway running OpenClaw 2026.10.6 (2026.11.10 [below](#on-openclaw-20261110)), started with `pnpm dev-gateway start --instance <name> --with-skill-review --no-seed`. A `#learn` turn (ten model calls) was sent to Juniper (`main`) in a task with no channel, by the gateway's owner through `chat.send`, and watched by a paired operator with `operator.read` and `operator.write`. Read with the gateway's own source (`experience-review-*.mjs`, `transcript-*.mjs`, `session-transcript-*.mjs`, `agent-end-side-effects-*.mjs`).

## How the note is made

- After a turn ends, the gateway counts the task's model calls since its last review. At ten or more it queues a background review of the task (`createSkillExperienceReviewScheduler`). 2026.10.6 also queues one right after a turn that used a learned skill (`agent-end-side-effects-*.mjs`, `usedWorkshopSkill`). 2026.11.10 doesn't: it counts only the model calls, across turns, and starts the count over when the turn itself changed a learned skill (`extensions/skill-workshop`, `experience-review-scheduler.ts`; its `docs/tools/self-learning.md`, "When a review runs"). The review waits for 30 seconds with nothing running, then runs in an internal session of its own (`agent:<bot>:internal-session-effects:skill-workshop-review_<id>`), on the task's model, with `skill_workshop` and some read-only tools.
- A review is queued only when the turn was offered `skill_workshop` (`skillWorkshopAvailable`), and `skills.workshop.autonomous.mode` is `auto`, which is its default. A development gateway denies `skill_workshop` unless started with `--with-skill-review`.
- When the review saved or changed a skill, the gateway writes one note into the reviewed task (`postWorkshopChangeNotice`): `💾 Learned: created `<skill>` (<reason>). Say "undo" to revert this skill change.` It also queues a system event for the task's next turn that names the exact `skill_workshop` call that undoes it.
- On a task with no channel the note is appended to the transcript as an assistant row. On a channel task it is sent to the channel as a message and mirrored into the transcript. Both carry the idempotency key `skill-workshop-notice:<review run id>`; only the first path was seen live.
- 2026.11.10 posts the note to the task as a session notice under the same key for every task (`experience-review-*.mjs`, `postWorkshopChangeNotice`). It sends it to the task's channel only when `plugins.entries.skill-workshop.config.autonomous.channelNotices` is on, which is off by default, and never to Slack. Its own web client shows the notice as a "Learned" row with an Undo button. On a task with no channel the assistant row above still came (F-560's end-to-end check on 2026.11.10, a turn an admin connection sent). A channel task on 2026.11.10 was not run.

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

## On OpenClaw 2026.11.10

Observed on a development gateway of 2026.11.10 started with `--with-skill-review --with-message-tool --no-seed`, after a `#learn` turn sent by a paired operator with `operator.admin`, `operator.read` and `operator.write` (the only sender that version reviews on a one-profile gateway; below). The note's text is the same as on 2026.10.6, and so are its three fields, its key and its missing run. The row also carries a mark 2026.10.6 doesn't write:

```json
{
  "role": "assistant",
  "content": [{ "type": "text", "text": "💾 Learned: created `trail-check` (check the trail before a hike). Say \"undo\" to revert this skill change." }],
  "api": "openclaw-transcript",
  "provider": "openclaw",
  "model": "delivery-mirror",
  "stopReason": "stop",
  "timestamp": 1795763600317,
  "openclawDeliveryMirror": {
    "kind": "plugin-notice",
    "pluginId": "skill-workshop",
    "type": "skills-changed",
    "data": {
      "agentId": "main",
      "runId": "skill-workshop-review:<uuid>",
      "skills": [{ "name": "trail-check", "action": "created", "summary": "check the trail before a hike" }]
    }
  },
  "idempotencyKey": "skill-workshop-notice:skill-workshop-review:<uuid>",
  "__openclaw": { "id": "<row id>", "idempotencyKey": "skill-workshop-notice:skill-workshop-review:<uuid>", "recordTimestampMs": 1795763600350, "transcriptPosition": { "source": "<source>", "rawSeq": 36 }, "seq": 21 }
}
```

- **Where it is.** It was the task's last row, after the run's reply, with nothing between. It names no run: `data.runId` is the review's own run, not the reviewed one. The review waits until nothing runs in the task, so the note follows the task's last run.
- **Who writes the mark.** The skill workshop posts the note through the plugin runtime's `postSessionNotice` (`experience-review-*.mjs`, `session-notice-*.mjs`), which writes the row with `appendAssistantMessageToSessionTranscript` and `deliveryMirror: {kind: "plugin-notice", pluginId, type, data}`. `pluginId` comes from the runtime scope of the plugin that calls it (`postPluginSessionNotice`, `loader-runtime-load-*.mjs`), not from the caller's arguments. On a channel task the same notice is also sent to the channel. The gateway's own web interface draws a row with this mark as a "skill learned" notice with an Undo button (`control-ui` assets, `chat-skill-learned-notice-*.js`).
- **The bot's copy.** The `#send-keyed` row on the same instance had the note's three fields, its key shape, the bot's run in `__openclaw.runId`, and no `openclawDeliveryMirror`.
- **The list.** In `sessions.list`, the note became `lastMessagePreview` (the text without its code marks, as on 2026.10.6) and moved `updatedAt`; `lastActivityAt` stayed the end of the turn. A task marked read (`sessions.patch {unread: false}`) by a writing connection before the note was still `unread: false` after it.
- **Events.** A `session.message` for the task carried the row; `skills.changed` events came with it.

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

On 2026.10.6 the only difference is the run, and it does not mark the note. On 2026.11.10 the note also has the skill workshop's mark and the bot's copy hasn't ([above](#on-openclaw-20261110)). A send to a channel is mirrored into the task the channel's peer maps to (`mirrorDeliveredPayloads`), with the bot's key and no run, and the note in a channel's task is mirrored by the same code, also with no run (read from the source, not produced here: a development gateway has no channel). So a bot can write a row with every field the note has.

## Which turns are reviewed

Observed on development gateways of each version started with `--with-skill-review --no-seed`. One `#learn` turn (ten model calls) was sent to Juniper (`main`) in a new task per sender, and `chat.history` was read every five seconds for two minutes for a row keyed `skill-workshop-notice:…`:

| The turn was sent by                                                    | 2026.10.6        | 2026.11.10       |
| ----------------------------------------------------------------------- | ---------------- | ---------------- |
| a paired operator with `operator.read` and `operator.write`             | note, after 70 s | none             |
| a paired operator with Clawtrate's interactive tier (read, write, approvals, questions) | note, after 40 s | none |
| a paired operator with `operator.admin`, `operator.read`, `operator.write` | note, after 45 s | note, after 40 s |
| the CLI (`openclaw gateway call chat.send`)                             | note, after 35 s | none             |

On 2026.11.10 the scripted model saw 23 tools in the admin's turn and 22 in the others: the same list without `skill_workshop`. `skill_library` was in both. No review request reached the model after the turns with no note.

Why, from each version's source:

- **The review's gate is the same on both:** a turn is counted only when it was offered `skill_workshop`. 2026.10.6 reads `skillWorkshopAvailable`, set from the turn's effective tools (`agent-end-side-effects-*.mjs`, `isEligibleContext`; `builtin-openclaw-*.mjs`). 2026.11.10 reads the turn's `toolNames`, its effective tools (`extensions/skill-workshop`, `experience-review-scheduler.ts`, `isEligibleContext`); its documentation lists "turns where tool policy hides `skill_workshop`" among the turns that don't count (`docs/tools/self-learning.md`).
- **2026.10.6** has one tool for both stores, `skill_workshop` (`openclaw-tools-*.mjs`, `createConfiguredSkillWorkshopTool`). For an admin on a gateway with one profile it writes the bot's learned skills, or the person's own library with `target`. For any other sender with a profile it writes only that person's library. Every sender above was offered it, so every turn was counted.
- **2026.11.10** splits them. A turn's skill authoring goes to the person's own library (`defaultTarget: "personal"`) when the sender has a user profile and either lacks `operator.admin` or the gateway has more than one user profile; an admin on a gateway with one profile authors the bot's skills (`"workspace"`) (`projectSkillLibraryPresentation`, `src/gateway/skill-library-authoring.ts`). For a personal turn the gateway removes the tools of every plugin with its own skills folder, `skill-workshop` among them, and offers `skill_library` (`applySkillLibraryGrant`). With `skill_workshop` gone the turn isn't counted, so no review runs.
- The more-than-one-profile case was read, not run: a development gateway has one profile.

Read from the source, no 2026.11.10 setting changes this for a sender without `operator.admin`: the choice reads only the sender's profile, its admin scope and the number of profiles.

## Undo

Observed on development gateways of each version, after a `#learn` turn an admin connection sent.

- **2026.10.6.** Saying "undo" in the task is the gateway's own way back: the queued system event tells the bot which call reverts the change. The gateway has no method that undoes a review as one: `skills.workshop.archive` and `skills.workshop.restore` need `operator.admin` and act on one skill each (`core-method-policy-*.mjs`).
- **2026.11.10.** The gateway undoes a review itself. `skills.workshop.undo {agentId, runId: "skill-workshop-review:<id>"}`, from an admin connection, answered `{status: "undone", changes: [{skillName: "trail-check-2", action: "archive", runId: "skill-workshop-undo:<id>", …}]}`; the same call from a connection with read, write, approvals and questions was refused: "missing scope: operator.admin". The method is registered with `ADMIN` (`extensions/skill-workshop`), and on a second call for the same review it answers with a status other than `undone` (`revertReview`: nothing left to revert). The gateway's own command `/learn undo <id>`, sent with `chat.send`, did the same from the admin connection, answering in the task "↩️ Undid the skill change: archived `trail-check`." as a `gateway-injected` row; from the connection without admin it answered "You are not authorized to use this owner-only command. Ask the operator to grant this Gateway client operator.admin access." Saying "undo" to the bot needs `skill_workshop`, which that version doesn't offer a sender without admin (above).
- The changes, with the run that made each, are listed by `skills.workshop.changes` (`operator.read` on both versions): a client could check from it that a review saved what its note says.
