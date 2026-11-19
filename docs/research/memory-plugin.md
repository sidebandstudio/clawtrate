# Memory workspace and lifecycle probe

Research for issue #40. It tests the two assumptions behind the proposed memory
plugin: workspace resolution from a user plugin, and what happens after a memory
file changes.

## How to read this

Every result below is **[live]**: observed with an admin client of the official
gateway client against a named, unseeded development instance on OpenClaw
2026.10.6, using only the scripted model. The plugin was loaded from this
checkout with:

```bash
pnpm dev-gateway start --instance memprobe --with-plugin clawtrate-memory-probe --no-seed
```

`<state dir>` replaces the instance's absolute state-folder path. `<workspace>`
is the resolved workspace of the bot in the same example. There were two starts:
one enabled memory search through `config.patch`, and one had
`memory.search.enabled: true` before the gateway started so that hot enabling
was not the cause of a result.

The three facts stay separate:

- **Stored**: a gateway read returned the new file text.
- **Loaded**: the scripted model's record of the next request contained the
  text. The development provider's `SCRIPTED_PROVIDER_DUMP` option recorded the
  request body.
- **Searchable**: `memory.search {version: 2}` returned the text.

A result that the runs did not establish is marked **[not established]**.
Nothing below infers a result from OpenClaw's documentation.

## Answers

1. **Workspace resolution works from the user plugin, for the default bot and a
   second bot.** Both calls returned that bot's configured workspace. **[live]**
2. **The development gateway's memory search is not set up by default.** Its
   stock `enabled: false, provider: "none"` made both status and search fail.
   Changing only `enabled` to `true` made the local full-text backend ready.
   **[live]**
3. **`MEMORY.md` and `USER.md` were stored through `agents.files.set` and loaded
   into a new private task.** Notes under `memory/`, including a nested note,
   were stored through the probe but their text was not in that task's request.
   **[live]**
4. **A first search with no index built the index, but later file changes were
   not picked up automatically in these runs.** Status kept the old file count,
   searches did not return new files, and an edited file kept its old excerpt.
   An explicit `openclaw memory index --force --agent main` updated the index;
   root files and direct and nested notes then returned their current text.
   **[live]**
5. **The running watcher's paths and delay are [not established].** No status
   response reported `details.legacy.custom.watcher`, and no background pickup
   was observed. The forced-index results establish which files that command
   indexed, not which paths a running watcher handles.

## Workspace resolution

The probe calls exactly
`api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId)` in its
`clawtrate-memory-probe.workspace` method. Replies, trimmed only to remove the
host-specific prefix: **[live]**

```json
{"agentId":"main","workspace":"<state dir>/workspace"}
{"agentId":"otto","workspace":"<state dir>/workspaces/otto"}
```

These match the paths returned independently by `agents.files.get` for each
bot. The gateway loaded the plugin from its own
`clawtrate-plugins/clawtrate-memory-probe` copy through `--with-plugin`; it was
not a bundled OpenClaw plugin. **[live]**

## Backend setup

Before any configuration change, `config.get` returned: **[live]**

```json
{"memory":{"search":{"enabled":false,"provider":"none"}}}
```

For both `main` and `otto`, `memory.status` and `memory.search {version: 2}`
then failed with: **[live]**

```text
UNAVAILABLE: Memory provider unavailable
```

A `config.patch` with
`{"memory":{"search":{"enabled":true,"provider":"none"}}}` succeeded with
`requiresRestart: false`. Status then included: **[live]**

```json
{
  "providerId": "memory-core",
  "status": "ready",
  "details": {
    "legacy": {
      "backend": "builtin",
      "provider": "none",
      "fts": {"enabled": true, "available": true},
      "vector": {"enabled": false}
    }
  }
}
```

The probe did not test any remote embedding provider or credential.

## Stored and loaded

`agents.files.set` created `MEMORY.md` with `quinoa-tesseract-401` and `USER.md`
with `user-velvet-402`. Each reply had `ok: true`, the updated file content, and
a new SHA-256 `hash`. **[live]**

The probe wrote the other two files with plain `node:fs` in the resolved
workspace. A read immediately after each write established storage independently
of indexing: **[live]**

```json
{"path":"memory/watch-a.md","content":"watchaya-405: a note at the top of memory.\n"}
{"path":"memory/nested/watch-b.md","content":"nested-ember-404: a nested note.\n"}
```

A new private session was then created and sent `#text`. The recorded chat
request contained both root files, under their workspace headings: **[live]**

```text
## <workspace>/USER.md
User marker user-velvet-402.
## <workspace>/MEMORY.md
Root marker quinoa-tesseract-401.
```

The same request contained neither `watchaya-405` nor `nested-ember-404`.
`MEMORY.md` and `USER.md` were therefore loaded into this new task; the two notes
were not. **[live]** This run did not test group tasks, routines, helpers, an
already-open task, or files over the loading budgets: those conditions are
**[not established]** here.

## Searchable, and when

### The first search built an index

With search enabled but `files: 0`, a direct note was written. Polling status
for 20.4 seconds kept `files: 0`. The first `memory.search {version: 2}` then
returned: **[live]**

```json
{
  "reference": {"providerId":"memory-core","id":"memory/watch-a.md"},
  "excerpt":"watchaya-405: a note at the top of memory.\n"
}
```

The following status reported one memory file. This does not demonstrate a
20-second watcher delay: the status calls immediately before the search still
showed no indexed file, and this was the initial index build. **[live]**

### Later changes stayed stale

After that valid index existed, later `MEMORY.md`, `USER.md`, and note writes
returned no hits for their new markers, in both response versions 1 and 2.
**[live]**

The second start ruled out hot enabling as the cause. Its first search indexed
`memory/boot-a.md`. A new note, `memory/boot-c.md`, was stored but still absent
57 seconds later: **[live]**

```json
{
  "stored":"turn-cedar-410: after a model turn.\n",
  "files":1,
  "memoryFiles":1,
  "dirty":false,
  "watcher":null,
  "searchHits":[]
}
```

Replacing the already-indexed `memory/boot-a.md` gave the same split. Storage
returned `edited-onyx-411: replacement text for an indexed note.` After 2.5
seconds, searching its old marker still returned the old excerpt from that same
path, while searching `edited-onyx-411` returned `hits: []`. **[live]**

Thus a stored write did not imply a searchable revision in these runs, and
`coverage: "complete"` on an empty search response did not show that the index
was current. **[live]**

### What made the changes searchable

Running the gateway's own command against this same named instance worked:
**[live]**

```text
openclaw --profile clawtrate-dev-memprobe memory index --force --agent main
Memory index updated (main): 6 files indexed.
```

Searches then returned the replacement text and the new note. In the first
start, the same forced-index command returned `Memory index updated (main): 5
files indexed.` and subsequent version-2 searches found all of these paths:
**[live]**

```text
MEMORY.md
USER.md
memory/watch-a.md
memory/nested/watch-b.md
```

So the forced index covered both root files and direct and nested Markdown
notes. Whether the plugin can request a refresh through an owner-supported API,
rather than arranging this CLI operation, was not tested and is **[not
established]**.

### Watcher paths and delay

**[not established].** Across status reads before and after the first search,
and before and after a model turn, `details.legacy.custom.watcher` was absent.
There was no observed background update at 1.5 seconds, 20.4 seconds, or 57
seconds. These runs therefore neither confirm a running watcher's paths nor
assign it a delay. The successful forced-index paths above must not be rewritten
as watcher evidence.
