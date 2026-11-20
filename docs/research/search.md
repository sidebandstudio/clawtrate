# Search: what the gateway finds, and what it costs

What Clawtrate's search palette can ask an OpenClaw gateway, checked against OpenClaw 2026.10.6. It settles the dependency cells of `docs/parity.md` rows F-033, F-240 and F-268 and is the evidence behind `docs/design/search.md`.

How to read the citations, as in `gateway-capabilities.md` and `setup-flow.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package. Bundled chunk names carry a build hash that changes with every release; search by the `//#region <source path>` marker named with each citation. Line numbers are of the 2026.10.6 chunks.
- **Live** means it was run, and the result is quoted. **Source** means it was read in shipped code only.

Where things were run: one development instance, named and started by this checkout with `pnpm dev-gateway start --instance d12search` (gateway on `ws://127.0.0.1:19380`), with the standard seed: four bots (Juniper, whose id is `main`, Otto, Marlow and Pip), eleven scripted conversations and seven finished examples. The probe is `search/search-probe.ts`. Each experiment opens a new paired device through the tool's own operator client, at the tier it names, and removes the device when it ends. Tasks were added with `chat.send` from a read and write connection, so the person's messages carry known words and the scripted model answers them. The instance was stopped and reset when the work ended.

## Summary

| # | Question | Answer | Section |
|---|---|---|---|
| 1 | What text does `sessions.search` match? | The text of user and assistant messages: not reasoning, not tool calls, not tool results, not a task's title, not an attachment's bytes. Text the gateway itself puts into a message can match, and that includes a reference to an attachment that carries its file name. **Live and source; the attachment reference source only.** | 1 |
| 2 | How does a query match? | The query is cut at white space and every piece must appear (AND). A piece with punctuation in it is a phrase: its words must appear together and in order ("transcode_cache" finds "transcode-cache", "cache_transcode" does not). Words match whole words; in the `scope` form the last word may also be the start of a word ("Zephyr" finds "Zephyrine"), in the `sessionKeys` form it may not. Never inside a word ("ephyrine" finds nothing). Case and accents do not count ("CAFÉ", "cafe" and "café" are the same). Quotes, `*` and `OR` are not operators. A piece that does not produce a token, such as a lone exclamation mark, matches no messages. **Live and source; the phrase rule for punctuation source only.** | 2 |
| 3 | In what order? | By the full-text index's relevance score, then newest first. Not newest first. The score is computed in each bot's own database, so scores of two bots are not comparable. **Source, and live.** | 3 |
| 4 | What does one result carry, and can the conversation find it? | `{sessionKey, sessionId, messageId, role, timestamp, snippet, score}`. `messageId` is the history row's `__openclaw.id`. A match older than the latest 200 rows is not in the page the app loads; `chat.history {sessionKey, messageId}` returns a page starting at it. **Live.** | 4 |
| 5 | `limit` | 1 to 25, integers. 0, -1, 26, 100 and 2.5 are refused by the schema. Without it, 10. **Live.** | 5 |
| 6 | `scope` and `sessionKeys` | `scope: {}` searches every bot's tasks that are not archived. `scope.agentId` narrows to one bot. `archived: "all"` adds archived tasks; `archived: true` searches only them. `scope.search` filters tasks by their own fields (a title) before the words are matched. `sessionKeys` must all belong to one bot. A query with neither form returns an empty list without an error. The `scope` form selects tasks through the gateway's own visibility filter for the calling connection, so its coverage is the tasks this connection can see. **Live; the visibility filter source only.** | 6 |
| 7 | Does a narrower search find what the 25 limit left out? | Yes. Across all bots, 25 results came from two bots of four although all four had 32 matching messages; a search per bot found 25 more for each of the other two. Inside one bot, its task keys found 5 matches the bot's own search left out. **Live.** | 7 |
| 8 | What does a search cost the gateway? | It queries a SQLite full-text index per bot; it does not read transcript files per call. On about 400 tasks a search took 10 to 20 ms (median), the first one after a start 2 s. The gateway's log names the method, its time and size, not the words. **Live and source.** | 8 |
| 9 | Archived, deleted, a bot deleted | An archived task leaves the default search and comes back with `archived` or by its key. A deleted task, and every task of a deleted bot, leave every search. Their history then reads as zero rows, without an error. **Live.** | 9 |
| 10 | Files | `sessions.files.list {sessionKey, search}` searches the names under the task's root, which for an ordinary task is the bot's whole workspace: one call per bot, a substring of the path, case ignored, at most 500 matches and 5,000 entries visited. Folders whose path matches are returned as entries too, with their `kind`. A folder the gateway cannot read is skipped without `truncated`. A task key that does not exist returns an empty list with no `root`. `agents.workspace.list` lists one folder per call and does not search. **Live and source.** | 10 |
| 11 | Routines | `cron.list {query}` matches a lowercase substring of a routine's id, name, description, bot id and display name, not its message. Disabled routines appear only with `includeDisabled` or `enabled: "all"`. Pages of up to 200 with `total`, `hasMore`, `nextOffset` and `snapshotRevision`. **Live and source; `nextOffset` and `snapshotRevision` source only.** | 11 |
| 12 | A read-only connection | Every source answered at `operator.read`: `agents.list`, `cron.list`, both forms of `sessions.search`, `sessions.files.list`, `agents.workspace.list` and `chat.history`. A connection with no scope was refused each with "missing scope: operator.read". **Live.** | 12 |

## 1. What `sessions.search` matches

### Source

Each transcript event that is a message of role `user` or `assistant` is indexed with the text of its content: a string, or the blocks of type `text`, `input_text` and `output_text` joined by a new line (`readMessageText` and `extractTranscriptIndexEntry`, `<openclaw>/dist/session-transcript-projection-rebuild-C74XfH4u.mjs` lines 10-37, region `src/config/sessions/session-transcript-projection-append.ts`). Thinking blocks, tool-call blocks and messages of role `toolResult` have no indexed text. The task's title is a field of the session's row, not of its transcript, and is not indexed. An attachment's bytes are not indexed either, but when the gateway saves an attachment it appends `[media attached: <ref>]` to the message's text (`<openclaw>/dist/chat-attachments-Bmvu3oSJ.mjs` lines 249-265), and the ref is built from the saved media's id, which carries the original file name (`saveMediaBuffer`, `<openclaw>/dist/store-DN4C9BL7.mjs` lines 344-368). So a word of an attachment's name can match. This was read in source and not run here.

### Live

`search-probe.ts words` made three tasks and a title, then searched every bot (`{query, scope: {}, limit: 25}`):

```
agent:main:probe-cafe: 2 history rows
  user "Plan the café tasting for Zephyrine on Thursday."
  assistant thinking:"This request is not in the script, so I will acknowledge it." | text:"This is the scripted development model. It has no reply written for: …"
agent:otto:probe-tool: 4 history rows
  user "#read"
  assistant thinking:"I will read my instructions." | toolCall:"read"
  toolResult text:"# Otto\n\nYou are Otto, the operator for a small home server.\n\n- Check b…"
  assistant text:"I read my instructions file."
agent:marlow:probe-think: 2 history rows
  user "#think"
  assistant thinking:"The user wants to see reasoning first. I will reason briefly, then ans…" | text:"I thought it over first. …"
```

`sessions.patch {key: "agent:main:probe-cafe", label: "Quokka itinerary"}` set the first task's title. Then:

| Query | Where the word is | Results |
|---|---|---|
| `Zephyrine` | the person's message, echoed in the reply | 2: the user message and the reply |
| `scripted` | the reply only | 1, the reply |
| `operator` | the tool result only | 0 |
| `acknowledge` | reasoning only | 0 |
| `reason briefly` | reasoning only | 0 |
| `Quokka`, `itinerary` | the title only | 0 |
| `furnace` | the seeded title "Heat pump vs. gas furnace", and its replies | 2, both replies; the title itself did not match |

## 2. How a query matches

### Source

The table is FTS5 with `tokenize = 'unicode61 remove_diacritics 2'` (`session_transcript_fts`, in the agent database schema, `<openclaw>/dist/openclaw-agent-schema-V6rru8Sr.mjs`, region of the agent schema SQL). That tokenizer splits on anything that is not a letter or a digit, folds case and removes diacritics. The query is built by `toFtsQuery` (`<openclaw>/dist/session-transcript-search-N7u0uydo.mjs` line 45, region `src/config/sessions/session-transcript-search.ts`): the query is split on white space, each piece is quoted, inner quotes doubled, and the pieces are joined with `AND`; with `match: "prefix"` the last piece gets `*`. Each piece is then one FTS5 phrase: the tokenizer splits it at its punctuation, and the words it yields must appear next to each other and in that order. So "transcode_cache" finds "transcode-cache" and "transcode cache", and "cache_transcode" finds neither; a query with no punctuation is a list of single words. The `scope` form passes `match: "prefix"` (`<openclaw>/dist/sessions-read-CLHMalI8.mjs` line 505, region `src/gateway/server-methods/sessions-search-projected.ts`); the `sessionKeys` form passes none. The query is trimmed, must not be empty and is at most 4,096 characters.

### Live

All on `scope: {}` unless named:

| Query | Results | So |
|---|---|---|
| `Zephyrine`, `zephyrine`, `ZEPHYRINE` | 2 each | case does not count |
| `cafe`, `café`, `CAFÉ` | 2 each | accents do not count |
| `Zephyr` | 2 | the last word may be the start of a word |
| `ephyrine` | 0 | never inside a word |
| `Thursday Zephyrine`, `Zephyrine Thursday` | 2 each | every word, in any order |
| `Zeph Thurs` | 0 | only the last word may be a start |
| `Zephyrine OR Plutonium` | 0 | `OR` is a word to find, not an operator |
| `"tasting for"` | 2 | quotes do not make a phrase |
| `tast*` | 2 | `*` is a separator; "tast" is the last word |
| `Zephyr` with `sessionKeys: ["agent:main:probe-cafe"]` | 0 | no start-of-word match in this form |
| `Zephyrine`, `cafe` with the same key | 2 each | whole words match in this form |
| `   ` | refused: "query must not be empty" | |

## 3. Order

### Source

Each bot's database orders by `rank asc, timestamp desc, message_id asc`, where `rank` is `bm25()` (`session-transcript-search-N7u0uydo.mjs` line 211); the result's `score` is `-rank`. An `order: "recent"` exists in the kernel but no request parameter reaches it. The handler then merges the bots' pages and sorts them by `score` descending, then `timestamp` descending (`sessions-read-CLHMalI8.mjs` lines 486-492 for `scope`, line 713 for `sessionKeys`). `bm25` scores depend on the statistics of the index they are computed in, and each bot has its own database (`openclaw-agent.sqlite` under the bot's folder; section 9 shows deleting a bot moves it). Scores of two bots are therefore not on one scale.

### Live

For `Saturday` across all bots the order was a short user message from Marlow, then three user messages of Pip's, then two of Pip's replies: shorter messages score higher, whatever their age. Section 7 shows the merge keeping 25 results from two bots only.

## 4. What one result carries

### Live

`search-probe.ts shape`:

```
results: [{"sessionKey":"agent:main:probe-cafe","sessionId":"304c2b55-…","messageId":"f3bd5cbe-19ae-4b53-9faa-eae215ebe7db","role":"user","timestamp":1795099171737,"snippet":"Plan the café tasting for Zephyrine on Thursday.","score":2.586374492159353},
          {"sessionKey":"agent:main:probe-cafe", …,"messageId":"b7b3cea2-…","role":"assistant", …,"snippet":"This is the scripted development model. It has no reply written for:\n\n> Plan the café tasting for Zephyrine on Thursday.\n\nSend `#help` for the scenarios it can play.","score":1.9498372731011633}]
other fields: ["results","sessions"]
sessions rows: [{"key":"agent:main:probe-cafe","label":"Quokka itinerary","displayName":"Quokka itinerary","updatedAt":1795099175070}]
the same with sessionKeys -> other fields: ["results"]
history rows' __openclaw: [{"role":"user","id":"f3bd5cbe-19ae-4b53-9faa-eae215ebe7db","seq":1},{"role":"assistant","id":"b7b3cea2-…","seq":2}]
```

- `messageId` is the history row's `__openclaw.id`, so the conversation can find the matched message among the rows it loaded.
- The snippet is up to 48 tokens around the match, joined with " … " where cut, at most 500 characters, with no marks around the matched words (`snippet(…, 0, '', '', ' … ', 48)`, `session-transcript-search-N7u0uydo.mjs` line 224). It is the message's own text, markdown included.
- The `scope` form also returns `sessions`, the matched tasks' rows, with their titles; the `sessionKeys` form does not.
- The response may also carry `indexing: true` (the index is catching up; section 7 shows it live), `truncated: true` (more matched than were returned) and `archivedTranscriptsExcluded` (a count of the selected tasks whose transcripts are in the gateway's cold archive and were not searched; never seen live here).

**A match older than the page the app loads.** `search-probe.ts long` made one task with "aardwolf" in its first message, then 120 more turns:

```
search {"query":"aardwolf","scope":{"agentId":"pip"},"limit":25} -> 2 results (32 ms) indexing=true
chat.history limit 200: 200 rows, … hasMore=true
the matched message is in that page: false
chat.history ["sessionKey","messageId","limit"]: 20 rows, the match at index 0, fields [… "newerCursor" …]
chat.message.get: {"ok":true,"role":"user"}
```

The app reads the latest 200 history rows when it opens a task and loads no earlier page (`docs/decisions.md`, "Transcripts"), so such a match is not among the rows it shows. `chat.history` with `messageId` returns a page that starts at the message, with a `newerCursor` (`<openclaw>/dist/chat-history-handler-ict2I1of.mjs` lines 621-632, region `src/gateway/server-methods/chat-history-handler.ts`: `offset` and `messageId` exclude each other, `cursor` excludes both).

## 5. `limit`

### Live

```
limit 0     -> REFUSED: invalid sessions.search params: at /limit: must be >= 1
limit -1    -> REFUSED: … must be >= 1
limit 1     -> 1 results truncated=true
limit 25    -> 6 results
limit 26    -> REFUSED: … must be <= 25
limit 100   -> REFUSED: … must be <= 25
limit 2.5   -> REFUSED: … must be integer
no limit    -> 6 results
```

Without `limit`, 10 (`sessions-read-CLHMalI8.mjs` lines 481 and 712). The kernel clamps to 1-25 as well (`SEARCH_LIMIT_MAX = 25`, `session-transcript-search-N7u0uydo.mjs` line 21).

## 6. `scope` and `sessionKeys`

### Source

The schema (`<openclaw>/dist/src-BSx5Woe0.mjs` lines 1784-1833, region `packages/gateway-protocol/src/schema/sessions-search.ts`) admits `{query, sessionKeys: [1-200], agentId?, limit?}` or `{query, scope: {…}, limit?}`, and refuses `scope` with a top-level `agentId` or `sessionKeys`. `scope` takes a subset of `sessions.list`'s filters: `activeMinutes`, `activeOnly`, `requireLastInteraction`, `sortBy`, `includeGlobal`, `includeUnknown`, `excludeSubagents`, `excludeCron`, `excludeSystem`, `excludeDock`, `configuredAgentsOnly`, `label`, `projectId`, `workspaceDir`, `group`, `pinned`, `boardFace`, `hasBoard`, `creatorId`, `ownerId`, `involvingMe`, `profileRelation`, `involvingProfileId`, `spawnedBy`, `agentId`, `search` and `archived` (`true`, `false` or `"all"`). It selects tasks as the session list does, through the same projected list and its filter for the calling connection (`prepareProjectedSessionList`, `sessions-read-CLHMalI8.mjs` lines 455-474, and `<openclaw>/dist/session-utils-list-BEVv4eAk.mjs` from line 636), and searches their transcripts. Its coverage is therefore the tasks this connection can see, which on a single-person gateway is every task; the rules for shared and restricted sessions were not exercised here. The `sessionKeys` form resolves each key's bot and refuses keys of two bots (`sessions-read-CLHMalI8.mjs` line 577).

### Live

| Request | Result |
|---|---|
| `scope: {}` | 6 results from Marlow and Pip |
| `scope: {agentId: "pip"}` | 5, Pip's only |
| `scope: {agentId: "nobody"}` | 0, no error |
| `scope: {archived: "all"}` | 6 (nothing was archived yet) |
| `scope: {archived: true}` | 0 (nothing was archived yet) |
| `scope: {activeMinutes: 1}` | 0 |
| `scope: {search: "Saturday"}` | 2: only the task titled "Saturday errands route" |
| `scope: {search: "route"}` | the same 2 |
| `scope: {label: "Which route on Saturday"}` | 0: that task's messages do not contain "Saturday" |
| `scope: {excludeCron: true, excludeSubagents: true}` | 6 |
| `{query}` alone | **0 results, no error** |
| `{query, agentId: "pip"}` | refused: "agentId requires sessionKeys" |
| `sessionKeys` of Pip and Marlow | refused: "sessions.search supports one agent per call" |
| `scope` with `sessionKeys` | refused: "invalid sessions.search params: must not be valid" |
| `sessionKeys: ["agent:pip:no-such-task"]` | 0, no error |

`gateway-capabilities.md` §19 records `query` alone failing on a multi-agent gateway; here it returned an empty list. Either way it does not search every bot, and an empty answer from it is not evidence of no match.

## 7. Does a narrower search find more?

### Live

`search-probe.ts many` added 64 tasks, 16 per bot, each with one message "Count the lanternfish in tank <bot>-<n>.", which the scripted reply echoes: 32 matching messages per bot.

```
wide {"query":"lanternfish","scope":{},"limit":25} -> 25 results (102 ms) truncated=true indexing=true
wide returned 25 tasks of 64; bots: {"main":16,"pip":9}
per bot main   -> 25 results truncated=true   new beyond wide: 0
per bot otto   -> 25 results truncated=true   new beyond wide: 25
per bot marlow -> 25 results truncated=true indexing=true   new beyond wide: 25
per bot pip    -> 25 results truncated=true indexing=true   new beyond wide: 7
```

`search-probe.ts narrow`, later, inside one bot:

```
one bot {"query":"lanternfish","scope":{"agentId":"pip"},"limit":25} -> 25 results truncated=true
its 16 task keys, 8 at a time (first 8) -> 14 results
its 16 task keys, 8 at a time (last 8)  -> 16 results
matches the bot search did not return: 5
```

(Two of the 16 tasks had been archived and deleted by then, section 9.) So `truncated` is a true signal, and narrowing finds matches a wider search left out, both across bots and inside one bot. Nothing pages: a narrower search returns that set's own best 25, and there is no way to ask for the 26th match of the same set.

## 8. What a search costs the gateway

### Source

A search queries `session_transcript_fts` in each selected bot's SQLite database through the session history worker (`searchSessionTranscripts`, `session-transcript-search-N7u0uydo.mjs`), with a `LIMIT` of `limit + 1`. It reads no transcript file per call. Before it, the `scope` form makes sure the gateway's projection of session rows is materialized (`projection.ensureMaterialized()`, `sessions-read-CLHMalI8.mjs` line 495); a session whose index needs rebuilding is left out and reported with `indexing`, and a rebuild is started in the background.

### Live

`search-probe.ts many` (85 tasks) and `bulk 80` (about 400 tasks), 20 searches each:

```
85 tasks:   scope {} lanternfish: median 18 ms, max 62 ms
            scope {} prefix 'l':  median 14 ms, max 23 ms
            scope agent pip:      median 7 ms,  max 12 ms
            keys 16:              median 8 ms,  max 13 ms
            agents.list:          median 5 ms,  max 32 ms
~400 tasks: scope {} heron (every new task matches): median 11 ms, max 127 ms
            scope {} 'h' prefix:  median 10 ms, max 14 ms
            scope {} no match:    median 11 ms, max 36 ms
            scope agent pip:      median 10 ms, max 23 ms
```

The first search after the gateway started took 2,008 ms, and the first after a bot was deleted 2,101 ms (materializing). The instance's `gateway.log` recorded each call as `⇄ res ✓ sessions.search 63ms bytes=6283 conn=… id=…`; a search of the log for the queried words found none. That is this development instance's log configuration; other log levels were not tried.

## 9. Archived, deleted, a bot deleted

### Live

`search-probe.ts gone2`. Archiving needs the task's `sessionId` (`sessions.patch` without `expectedSessionId` was refused: "expectedSessionId required for session lifecycle patch"); deleting from a read and write connection needs `archivedOnly: true` and an archived task.

```
archive agent:pip:probe-many-06: 1795099856190
  in sessions.list default false, archived:true true
  scope {}: includes the archived task: false
  scope archived all: includes the archived task: true
  scope archived true: 2 results, includes the archived task: true
  keys: 2 results, includes the archived task: true
delete agent:pip:probe-many-07: {"ok":true,"key":"agent:pip:probe-many-07","deleted":true, …}
  in sessions.list default false, archived:true false
  scope archived all: includes the deleted task: false
  keys: 0 results
  chat.history of the deleted task: 0 rows
```

`search-probe.ts gone`, a bot deleted from an admin connection on this instance (`agents.delete {agentId: "otto"}` returned `ok` and moved Otto's database to the trash):

```
agents now: ["main","marlow","pip"]
scope {} lanternfish   -> 25 results, none of Otto's
scope otto             -> 0 results
keys otto              -> 0 results
opening agent:otto:probe-many-15: 0 rows
```

So a result held from before a deletion leads to a task whose history reads as zero rows, with no error. An empty history is not evidence that a task exists. The task list the app keeps (`sessions.subscribe`, followed by `sessions.changed`) is.

## 10. Files

### Source

`sessions.files.list {sessionKey, path?, search?}` with a non-empty `search` walks the task's root from its top, depth first, and keeps every entry whose relative path, lowercased, contains the search, lowercased (`searchBrowserEntries`, `<openclaw>/dist/workspace-files-CaH9GWMT.mjs` lines 190-221, region `src/gateway/server-methods/workspace-files.ts`). It stops at 500 matches or 5,000 entries visited and then sets `truncated` (`MAX_SEARCH_ENTRIES`, `MAX_SEARCH_VISITED_ENTRIES`, lines 52-53). It does not descend into `.git`, `.hg`, `.next`, `.turbo`, `.yarn`, `coverage`, `dist` or `node_modules` (line 61), though such a folder's own name can match. A folder whose path matches is itself an entry, with `kind: "directory"`. A folder the gateway cannot read is skipped: `listWorkspacePath` returns nothing for it (`<openclaw>/dist/workspace-fs-DkIerTfz.mjs` lines 54-89), the walk goes on, and `truncated` is not set, so a reply without `truncated` does not mean every folder was walked. The result is `{root, files, browser: {path: "", search, entries, truncated?}}`. A task's root is its `spawnedWorkspaceDir`, else its `spawnedCwd`, else the bot's configured workspace (`work-pane.md` §20 has the sources); a task in a repository the gateway keeps is listed from the repository instead (`sessions-files-CeQfMksk.mjs`, the `list` branch). `agents.workspace.list {agentId, path?, offset?, limit?}` lists one folder and has no search.

### Live

`search-probe.ts files`, read-only connection:

```
sessions.files.list {"sessionKey":"agent:otto:probe-tool","search":"agents"}     (36 ms) -> root=yes files=1 browser.search="agents" entries=1 ["AGENTS.md"]
sessions.files.list {"sessionKey":"agent:otto:probe-tool","search":"AGENTS.MD"}  (9 ms)  -> entries=1 ["AGENTS.md"]
sessions.files.list {"sessionKey":"agent:pip:weekend-trip","search":"trail"}     (90 ms) -> root=yes files=1 entries=5 ["projects/trail-guide/.git","projects/trail-guide","projects/trail-guide/README.md","projects/trail-guide/routes.md","pictures/trail-map.png"]
sessions.files.list {"sessionKey":"agent:pip:weekend-trip","search":"md"}        (5 ms)  -> entries=8 ["AGENTS.md","BOOTSTRAP.md","IDENTITY.md","lists/mountain-weekend.md", …]
sessions.files.list {"sessionKey":"agent:pip:main","search":"trail"}             (1 ms)  -> root=no files=0 entries=0 []
sessions.files.list {"sessionKey":"agent:pip:no-such-task","search":"trail"}     (1 ms)  -> root=no files=0 entries=0 []
agents.workspace.list {"agentId":"pip"}                    (6 ms) -> total=8 ["directory:lists","directory:pictures","directory:projects","file:AGENTS.md", …]
agents.workspace.list {"agentId":"pip","path":"pictures"}  (8 ms) -> total=1 ["file:pictures/trail-map.png"]
agents.workspace.list {"agentId":"nobody"}                 (1 ms) -> agent "nobody" not found
```

Pip's task "Two days in the mountains" never touched `pictures/trail-map.png`, and the search found it: the search covers the bot's whole workspace, not the task's files. `agent:pip:main` is not a task on this instance; like a key that does not exist, it returned an empty list without `root` and without an error. So a search over files costs one call per bot, through one of its tasks whose root is the bot's workspace, and a result without `root` means "not searched", never "no files".

## 11. Routines

### Source

`cron.list` (`<openclaw>/dist/src-BSx5Woe0.mjs` line 4220, region `packages/gateway-protocol/src/schema/cron.ts`: `CronListParamsSchema`) takes `query`, `includeDisabled`, `enabled`, `agentId`, `limit` (1-200), `offset`, sorting and filters. The filter (`<openclaw>/dist/service-Ct8asiQx.mjs` lines 5153-5180, region `src/cron/service/ops-read.ts`) lowercases the query and keeps a routine when the lowercased join of its `id`, `name`, `description`, `agentId` and `displayName` contains it. Disabled routines are left out unless `includeDisabled` or `enabled: "all"`. Each reply carries `total`, `offset`, `hasMore`, `nextOffset` (`null` on the last page) and `snapshotRevision`, a revision of the list it was cut from (`<openclaw>/dist/service-Ct8asiQx.mjs` lines 5182-5216, `<openclaw>/dist/cron-DuUhgXqx.mjs` lines 1178-1196), so a client paging through it can tell when the list changed between pages even when its `total` did not.

### Live

`search-probe.ts routines` added one disabled routine through the instance's own CLI (`cron add --name "Weekday tide digest" --agent pip --cron "0 7 * * 1-5" --message "Summarise the tide table." --session isolated --disabled`); the scheduler is off on a development gateway, so nothing ran.

```
cron.list {}                                    -> 1 jobs ["heartbeat-main"] total=1 hasMore=false
cron.list {"query":"tide"}                      -> 0 jobs
cron.list {"includeDisabled":true}              -> 2 jobs ["heartbeat-main","Weekday tide digest"] total=2
cron.list {"includeDisabled":true,"query":"tide"} -> 1 jobs ["Weekday tide digest"]
cron.list {"enabled":"all","query":"TIDE"}      -> 1 jobs
cron.list {"enabled":"all","query":"ide dig"}   -> 1 jobs   (a substring across words)
cron.list {"enabled":"all","query":"pip"}       -> 1 jobs   (the bot's id)
cron.list {"enabled":"all","query":"tide table"} -> 0 jobs  (the routine's message is not searched)
cron.list {"enabled":"all","query":"Summarise"} -> 0 jobs
cron.list {"enabled":"all","limit":1}           -> 1 jobs ["heartbeat-main"] total=2 hasMore=true
```

`heartbeat-main` is the gateway's own heartbeat routine, listed like any other.

## 12. Tiers

### Live

`search-probe.ts readonly`:

```
Read-only connection (operator.read)
  agents.list {}: ok (4 ms)
  cron.list {}: ok (18 ms)
  cron.list {"query":"digest"}: ok (4 ms)
  sessions.search {"query":"Saturday","scope":{},"limit":25}: ok (19 ms)
  sessions.search {"query":"Saturday","sessionKeys":["agent:pip:main"],"limit":25}: ok (6 ms)
  sessions.files.list {"sessionKey":"agent:pip:weekend-trip","search":"trail"}: ok
  agents.workspace.list {"agentId":"pip"}: ok (1 ms)
  chat.history {"sessionKey":"agent:pip:main","limit":1}: ok (22 ms)
No scope at all
  agents.list: REFUSED: missing scope: operator.read
  cron.list: REFUSED: missing scope: operator.read
  sessions.search: REFUSED: missing scope: operator.read
  sessions.files.list: REFUSED: missing scope: operator.read
  agents.workspace.list: REFUSED: missing scope: operator.read
  chat.history: REFUSED: missing scope: operator.read
```

The `sessions.files.list` line above was run again with an existing task after the first run named `agent:pip:main`; both answered at `operator.read`. Clawtrate never connects with less than `operator.read` (`docs/decisions.md`, "Scopes, in tiers"), so the second half only shows that read is the floor.

## 13. What was not established

- How `archivedTranscriptsExcluded` arises on a real gateway: the development gateway never moved a transcript to cold storage, so the count never appeared.
- Whether a browser lets a page take Cmd/Ctrl+K before its own shortcut (the web preview). The prototype check presses the keys inside the page, which says nothing about the browser's own handling.
- Cost on a gateway with tens of thousands of tasks or very long transcripts; the largest instance here had about 400 tasks and one task of 242 rows.
