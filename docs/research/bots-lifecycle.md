# The rest of a bot's life: what the gateway allows

What Clawtrate can do with a bot after it exists: keep a primary bot, change its picture, name, label and instructions, notice a change to its instructions made in a conversation, copy it, export and import it, and delete it. Checked against OpenClaw 2026.10.6. It is the evidence behind `docs/design/bots-lifecycle.md` and the rows that design rewords in `docs/parity.md`.

How to read the citations, as in `gateway-capabilities.md` and `setup-flow.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, the one the `openclaw` wrapper script runs. Chunk names carry a build hash that changes with every release; search by the `//#region <source path>` marker at the top of each chunk instead. Line numbers are of the 2026.10.6 chunks.
- `schema` is `protocol.schema.json` in `@openclaw/gateway-protocol@2026.10.6`.
- **Live** means it was run on a development instance, and the result is quoted. **Source** means it was read in shipped code or bundled docs only, and is marked read-only-from-source where a design state rests on it.

Where things were run: one named development instance of this checkout, `pnpm dev-gateway start --instance d6life` (started twice, the second time for sections 10 and 11), with its scripted model and its four seeded bots (Juniper, whose id is `main`, Marlow, Otto and Pip), reset afterwards. The probes are in `bots-lifecycle/probe.ts`. They connect through the development tool's own paired operator (`openOperator` in `tools/dev-gateway/src/cli.ts`), make their own scratch bots named "Probe …", and put back what they change. Two commands need the gateway's experimental package commands, which the tool's runner does not switch on; the probe runs those with that instance's own profile, state folder and environment, after the runner's guard has accepted the instance. Paths below are relative to the instance's state folder (`<state>`) or the home folder (`~`). No real provider, account or network was used.

## Summary

| #   | Question                                                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Section |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Where can a primary bot be kept, and who sees it?                | In `users.prefs`, which is per user profile: a second paired device of the same person read the value back and got `users.prefs.changed`. **Live.** A connection with no durable profile gets `no_durable_identity` (**source**, and live in `gateway-capabilities.md`). The gateway's own default bot (`agents.list` `defaultId`) is set by `agents.defaults.systemAgent`, which also decides where unrouted channel messages go; changing it moved `defaultId` at once. **Live.** So Clawtrate never writes it. | 1       |
| 2   | Does a gateway always have a bot?                                | Yes. With no configured bot the gateway lists an implicit `main` agent, and it refuses to delete its only bot. **Source.**                                                                                                                                                                                                                                                                                                                                                                                       | 1       |
| 3   | Name and label                                                   | `agents.update {name}` (admin) renames; `agents.list` reads it back; a label is `agents.entries.<id>.identity.theme`, written with `config.patch` (admin) and kept through a rename. Other connections get `config.changed`. **Live.**                                                                                                                                                                                                                                                                           | 2       |
| 4   | The picture                                                      | `agents.update {avatar}` takes a `data:` URL. It accepted a 2.2 MB image and a `data:text/plain` value, and `agents.list` then returned no picture for either: only the read-back says whether a picture took. 20 KB and 1.5 MB images came back whole. **Live.** The gateway's limit is 2 MiB (`AVATAR_MAX_BYTES`); Clawtrate's own state keeps a picture of at most 32,768 characters. **Source.**                                                                                                         | 3       |
| 5   | Can the app know there is an image tool, and generate with it?  | Know: yes. `tools.effective {sessionKey}` (read) returns `image_generate` either among the bot's offered tools or as `excluded` with the gateway's reason; on the development gateway it is `excluded`, "Denied by tools.deny". **Live.** Generate: not established. The tool is asynchronous in a conversation and returns a task id; what `tools.invoke` (write) returns for it was not observed, because no image provider may be configured here. **Source**, unverified.                              | 4       |
| 6   | Instructions, separate from memory                               | `agents.files.get`/`set` cover exactly AGENTS.md, SOUL.md, IDENTITY.md, USER.md, BOOTSTRAP.md and MEMORY.md; anything else is refused. `set` with a stale `expectedHash` is refused with the current hash; a read-only connection can read and not write. **Live.** Instructions are AGENTS.md and SOUL.md; memory is MEMORY.md, USER.md and `memory/`. **Source.**                                                                                                                                             | 5       |
| 7   | What is a role change "from chat" on this gateway?              | A run's file tool writing to the bot's AGENTS.md or SOUL.md. The tool events carry the tool's name and its path. **Live** (with a write to another file: no scenario writes AGENTS.md). Nothing announces a change to these files: a write by another client produced no event on a second connection. **Live.**                                                                                                                                                                                                  | 6       |
| 8   | Duplicate                                                         | No method. A copy is `agents.create` (a new id from the name; a taken id is refused), then `agents.files.set` with the new bot's hash, then `config.patch` for its settings; each read back. **Live.** Not atomic. Memory, tasks, routines, channel routes, other workspace files and the bot's own sign-ins are not carried by these calls.                                                                                                                                                                    | 7       |
| 9   | Export and import                                                | The gateway knows one format, the experimental Claw package, made and read only by its command line. It exports only a bot installed from a package (`createdVia: "claw"` in `agents.list`); a bot made with `agents.create` cannot be put in one (`agentDir` is not representable), and the seeded bots could not either. A package is added with a dry run that prints the plan and a digest, then an apply with that digest; connected clients get `config.changed` and the bot is listed. **Live.** Clawtrate's own file, with Duplicate's reads and writes, carries what Duplicate does (section 10).        | 8       |
| 10  | What `agents.delete` removes, and what it can leave half done    | It removes the bot's settings, channel routes, routines and saved command approvals, and drops its tasks from every list, with or without files. With `deleteFiles` it moves the workspace, the bot's own folder and the transcripts to the gateway user's Trash, except a folder another bot still uses. Omitting `deleteFiles` means `true`. A folder it cannot move comes back in `failed[]` inside an `ok` answer; calling it again finishes the same delete. **Live.**                                   | 9       |
| 11  | When does `agents.delete` refuse?                                 | For the bot that holds the gateway's shared sign-ins (`main` here), the only bot, and the owner of inherited sign-ins: before anything changes. **Live** for the first, **source** for the others.                                                                                                                                                                                                                                                                                                           | 9       |
| 12 | Does a bot written to a Clawtrate file and read back into a new bot come out the same? | Yes, by the gateway's reads: AGENTS.md and SOUL.md (equal hashes), label, a picture that decodes, model and effort. A file of an unknown version, an unknown field, a field of the wrong type, a model naming an account, a picture that doesn't decode and a file over 5 MiB are refused before anything is used. Tool settings are not in the file: they can carry the gateway's own paths. **Live**; tool settings **source**. | 10 |
| 13  | What does the gateway do with an instruction file at and over its size limit? | It takes 2,097,152 bytes of UTF-8. One byte more, in ASCII or in three-byte characters, is refused with `UNAVAILABLE` "Workspace document exceeds its write bound", and the file is left as it was. **Live.** | 11 |

## 1. The primary bot

### What the gateway does

`agents.list` returns `defaultId`, `ownership` and `selectionRequired`, and puts the default bot first (`<openclaw>/dist/agent-list-NuNAO01y.mjs` lines 24-41, `resolveGatewayAgentSelectionState`). The default is, in order: one entry marked `default: true` while ownership is not explicit, or the sole bot (`<openclaw>/dist/agent-roster-CIplRONg.mjs` lines 85-93); in an explicit roster, `agents.defaults.systemAgent.agentId` (`<openclaw>/dist/agent-scope-config-CtLA1__T.mjs` lines 287-298); otherwise the first configured entry. The capability map says no method or config field sets it; that is not quite so: `systemAgent` does. But `systemAgent` is the gateway's owner for "ambient system work", and it catches channel messages no binding claims (`<openclaw>/docs/concepts/multi-agent.md` line 320). Changing it to make a bot "primary" in Clawtrate would change where other people's unrouted messages go.

With no configured bot, the gateway resolves an implicit `main` agent (`tryResolveSoleAgentId`, same `agent-roster` chunk), so `agents.list` always lists at least one bot, and `agents.delete` refuses the only one (`<openclaw>/dist/agents-DAPW-UCQ.mjs` line 802). **Source.**

`users.prefs.get` (`operator.read`) and `users.prefs.set` (`operator.write`) store JSON per user profile, with `users.prefs.changed {profileId, keys}` (`<openclaw>/dist/users-XXBiT3kC.mjs` lines 338-405; scopes in `<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 2429-2437). A connection whose client has no authenticated profile gets `{status: "no_durable_identity"}` (same lines).

### Live

`probe.ts primary`, two paired devices of the gateway's owner:

```
device one, users.prefs.get: {"status":"ok","entries":{}}
device one, users.prefs.set {clawtrate.primary: {bot: pip}}: {"status":"ok"}
device two sees events: ["users.prefs.changed"] and reads: {"status":"ok","entries":{"clawtrate.primary":{"bot":"pip"}}}
users.self on device one: {"id":"gateway-owner", …}
put back: users.prefs.set {clawtrate.primary: null}: {"status":"ok"}
agents.list defaultId: main ownership: explicit order: ["main","marlow","otto","pip"]
config agents keys: ["ownership","defaults","entries"] ownership: explicit systemAgent: {"agentId":"main"}
config.patch agents.defaults.systemAgent.agentId = pip: ok
agents.list defaultId now: pip ownership: explicit order: ["pip","main","marlow","otto"]
put back: config.patch systemAgent {"agentId":"main"} : ok
agents.list defaultId after: main
```

Both paired devices belong to the same profile, `gateway-owner`, so a second person was not observed; that preferences are per profile is from the source above. `listAgentsForGateway` also returns `createdVia` and `createdAt` for bots the gateway recorded (section 8).

### For the design

The primary bot is a Clawtrate preference, `clawtrate.primary` in `users.prefs`: the same person's devices agree, other people keep their own, and nothing on the gateway changes. Until the person chooses, the star is on `defaultId`, as the built rail already draws it. On `no_durable_identity` the choice is kept on the device, as F-266 does for the manual order. Choosing needs the interactive tier, not admin.

## 2. Name and label

### What the gateway does

`agents.update {agentId, name?, avatar?, emoji?, model?, workspace?, agentRuntime?}` (`operator.admin`) changes the configured entry and rewrites the workspace's IDENTITY.md (`<openclaw>/dist/agents-DAPW-UCQ.mjs` lines 670-783). The name passes through `sanitizeAgentIdentityLine`, so the saved name can differ from the typed one; the answer is only `{ok, agentId}`. There is no `theme` parameter: the label the built rail shows is `identity.theme` (`packages/core/src/mapping.ts`, F-019), which only `config.patch` writes. There is no owner check: any admin connection can rename (F-038's cell).

### Live

`probe.ts edit`, on a scratch bot, with a second read-only device watching:

```
agents.create {"name":"Probe Edit"}: {"ok":true,"agentId":"probe-edit",…,"workspace":"<state>/workspace-probe-edit"}
agents.update name: {"ok":true,"agentId":"probe-edit"}
  read back: {"id":"probe-edit","name":"Probe Edited","identity":{"name":"Probe Edited"},…}  second device saw: ["config.changed","chat.metadata.changed","config.changed"]
label: config.patch identity.theme: ok
  read back identity: {"name":"Probe Edited","theme":"Errands"} second device saw: ["config.changed"]
  agents.update name again: {"ok":true,"agentId":"probe-edit"}
  label survives a rename: Errands
read-only device: agents.files.get: true agents.files.set: {"message":"missing scope: operator.admin","code":"FORBIDDEN",…} agents.update: {"message":"missing scope: operator.admin",…}
```

### For the design

Rename and label are each one write, then `agents.list`; the screen shows what the list returns. Other devices follow `config.changed`. Below admin both are text.

## 3. The picture

### What the gateway does

`agents.update {avatar}` stores the string in `identity.avatar`. `agents.list` projects it as `avatarUrl` only when it is an `http(s)` URL or a renderable image `data:` URL of at most `AVATAR_MAX_DATA_URL_CHARS` (2 MiB of bytes, base64; `<openclaw>/dist/avatar-limits-2506OuP3.mjs` lines 1-20; `<openclaw>/dist/identity-avatar-file-B7GwXSk3.mjs` lines 143-155). Nothing in `agents.update` checks either before saving.

### Live

```
avatar of 20000 bytes (26690 characters): {"ok":true} read back avatarUrl characters: 26690
avatar of 1500000 bytes (2000022 characters): {"ok":true} read back avatarUrl characters: 2000022
avatar of 2200000 bytes (2933358 characters): {"ok":true} read back avatarUrl characters: 0
avatar that is not an image, data:text/plain: {"ok":true}
  read back: {"avatar":"data:text/plain;base64,aGVsbG8","avatarUrl":""}
```

### For the design

A picture is saved only when `agents.list` returns it: an `ok` from `agents.update` is not enough. Clawtrate's own state keeps a picture of at most 32,768 characters (`packages/core/src/state-bounds.ts`, `MAX_AVATAR_CHARS`; `MAX_CREATE_AVATAR_CHARS` in `accounts-engine.ts`), so an uploaded photo is cropped and saved small (the design uses 128 × 128); the 25 MB limit of F-270 applies to the file chosen, before cropping. The gateway keeps the picture, not the shape and colour a character was drawn from, so an editor cannot say which were chosen.

## 4. An image tool

### What the gateway does

`image_generate` is a core tool in the `coding` profile; it "only appears when at least one image-generation provider is available", and in a conversation it runs in the background, returns a task id, and a later reply carries the image (`<openclaw>/docs/tools/image-generation.md` lines 11-35 and 72). `tools.invoke {name, args, agentId?, sessionKey?}` (`operator.write`) calls a tool directly and answers `{ok, toolName, output, source}` or an error (`<openclaw>/dist/tools-invoke-BCp0zDH3.mjs` lines 10-55). What it returns for `image_generate` outside a conversation, and whether the picture's bytes reach the client, was not established. **Unverified**: no image provider can be configured on a development gateway.

### Live

`probe.ts image`, for Juniper's task `agent:main:coding-handoff`:

```
tools.catalog for main (Juniper) lists image_generate: true
  its catalog entry: {"id":"image_generate","label":"image_generate","description":"Image generation","source":"core","defaultProfiles":["coding"]}
tools.effective: {"keys":["agentId","profile","groups","toolAccess","notices"],…}
  … {"id":"image_generate","status":"excluded","reasons":[{"kind":"deny","label":"Denied by tools.deny","source":"tools.deny"}]} …
```

`tools.catalog` lists every core tool and says nothing about this gateway's providers. `tools.effective` needs an existing task's key (`unknown session key` otherwise) and separates the tools offered (`groups`) from those excluded, with the gateway's reason (`toolAccess.tools`).

### For the design

The Generate tab can say truthfully whether the tool is offered, and why not, from `tools.effective` for the bot's latest task; with no task, it says it cannot tell yet. When the tool is offered, generating from the picture editor stays undesigned until a probe with a real image provider shows what `tools.invoke` returns.

## 5. Instructions and memory

### What the gateway does

`agents.files.list`, `agents.files.get` (`operator.read`) and `agents.files.set` (`operator.admin`) accept only the bootstrap files: AGENTS.md, SOUL.md, IDENTITY.md, USER.md, BOOTSTRAP.md and MEMORY.md (`<openclaw>/dist/workspace-bootstrap-policy-BQw7Lpx1.mjs` lines 9-34; `<openclaw>/dist/agents-DAPW-UCQ.mjs` lines 261-275). `get` returns `{size, updatedAtMs, hash, content}`; `set` takes `expectedHash` or `expectedMissing`, writes at most 2 MiB, and on a stale hash answers `agent_file_conflict` with the current hash (lines 363-369, 468-572). The bundled docs give the files' roles: AGENTS.md "operating instructions … loaded at the start of every session", SOUL.md "persona, tone, and boundaries", USER.md about the user, MEMORY.md curated memory, `memory/YYYY-MM-DD.md` daily notes; a file over `bootstrapMaxChars` (20,000) is cut when loaded (`<openclaw>/docs/concepts/agent-workspace.md` lines 66-106).

### Live

```
agents.files.list: [{"name":"AGENTS.md","size":6450},{"name":"SOUL.md","size":1533},{"name":"USER.md","size":1137},{"name":"BOOTSTRAP.md","size":7479},{"name":"MEMORY.md","missing":true}]
agents.files.get AGENTS.md: {"size":6450,"hash":"490fc2b32865","firstLine":"# AGENTS.md - Your Workspace"}
agents.files.set with the hash read: {"ok":true,"hash":"33c8d0f1d38a"}
  second device saw: []
agents.files.set again with the old hash: {"message":"agent file \"AGENTS.md\" changed since it was read","code":"INVALID_REQUEST","details":{"type":"agent_file_conflict","name":"AGENTS.md","currentHash":"33c8d0f1…"}}
agents.files.get notes/x.md (not a bootstrap file): {"message":"unsupported file \"notes/x.md\"","code":"INVALID_REQUEST"}
```

### For the design

Instructions are AGENTS.md and SOUL.md, saved with the hash read and read back; memory is `controls.md` §12's. A save that crosses another change keeps the person's text and shows the gateway's. Because a file write announces nothing, an open editor learns of another change only when it saves.

## 6. A role change from the conversation

### What the gateway does

Nothing on this gateway is a "role" apart from the files of section 5: a bot changes how it behaves when a run writes its AGENTS.md or SOUL.md with a file tool (`write`, `edit`, `apply_patch`). `config.changed` covers configuration only, and `agents.files.set` sends nothing (section 5, live). A change made by a shell command, or on the gateway's machine, leaves no tool event naming the file.

### Live

`probe.ts chat`: a scratch bot runs the scripted `#write` scenario; a connection with the `tool-events` capability records the run:

```
events of the run: ["presence","chat.metadata.changed","chat","agent"]
  agent event: {"stream":"item","phase":"start","name":"write",…}
  agent event: {"stream":"tool","phase":"start","name":"write","args":{"path":"notes/scratch.md","content":"# Scratch\n\n- Check the trail map.\n"}}
  agent event: {"stream":"tool","phase":"result","name":"write","keys":["phase","name","toolCallId","meta","isError","commandBearing","result"]}
AGENTS.md unchanged by the run: true
```

No scenario writes AGENTS.md, and adding one is not this design's work; that the same events name AGENTS.md when that is the path is inferred from this one.

### For the design

The event line comes from a `write`, `edit` or `apply_patch` tool result without `isError` whose path is the bot's AGENTS.md or SOUL.md. Its diff is from the last copy Clawtrate read, to the file as `agents.files.get` returns it after the run, labelled with that copy's time, because nothing says what the file held just before. Keep writes nothing; Undo is `agents.files.set` with Clawtrate's copy and the file's current hash, then a read. Without an earlier copy, the line says so and offers no Undo.

## 7. Duplicate

### What the gateway does

No duplicate method exists. `agents.create {name, workspace?, model?, emoji?, avatar?}` (admin) derives the id from the name and gives the bot its own workspace and agent folder, seeded with the gateway's starting files (`<openclaw>/dist/agents-DAPW-UCQ.mjs` lines 632-669). The model may carry an account (`<provider>/<model>@<profile>`, `bots.md` §20 row 2); whether that account is usable by another bot follows where it is stored (`bots.md` §20 row 33).

### Live

`probe.ts copy`:

```
agents.create {"name":"Pip"}: {"message":"agent \"pip\" already exists","code":"INVALID_REQUEST"}
agents.create {"name":"Probe Pip copy"}: {"ok":true,"agentId":"probe-pip-copy",…,"workspace":"<state>/workspace-probe-pip-copy"}
its workspace's bootstrap files: ["AGENTS.md:6450","SOUL.md:1533","USER.md:1137","BOOTSTRAP.md:7479","MEMORY.md:missing"]
instructions copied from pip with the new bot's hash: true
pip's config entry keys: ["workspace","identity","tools"] the copy's: ["name","workspace","agentDir","identity"]
config.patch the copy with ["tools"] : ok
read back equal: true
pip's routines, cron.list {agentId: pip, includeDisabled}: {"jobs":[],"total":0,…}
```

### For the design

A copy is a new bot made from what can be read: picture and label, model with its account and effort, AGENTS.md and SOUL.md, tool settings and skills, each written and read back, in that order, with a partial result named step by step. It does not carry memory, About you, tasks, other workspace files, channel routes, the bot's own sign-ins, saved approvals, or routines (copying a routine would run it twice). Nothing links the copy to the original afterwards.

## 8. Export and import

### What the gateway does

The gateway has one portable format, the Claw package: `openclaw claws export <agent> --out <path>` and `openclaw claws add <source>`, experimental, behind `OPENCLAW_EXPERIMENTAL_CLAWS=1`, on its command line only (`<openclaw>/docs/cli/claws.md` lines 339-393, 420-465, 587-615). The gateway's methods have no claws export or add; `claws.monitors`, `claws.packages.remove` and `claws.removalJournal` are the only `claws.*` methods (`<openclaw>/dist/core-method-policy-DkntKRY_.mjs`). Export works on an installed Claw; `claws migrate` enrolls an existing bot when its settings can be represented. A package excludes credentials, sessions, transcripts, databases and other local state (`claws.md` lines 448-451, 611-614).

### Live

```
claws export of a bot not installed from a package (pip): exit 1 {"error":{"code":"claw_not_found","message":"No installed Claw agent matches \"pip\"."}}
claws migrate probe-pack --dry-run: exit 1 {"error":{"code":"agent_setting_unsupported","message":"Agent settings cannot be represented by Claw v1: agentDir. …"}}
claws migrate pip --dry-run: exit 1 {"error":{"code":"agent_default_setting_unsupported","message":"Inherited agent settings cannot be represented by Claw v1: agents.defaults.thinkingDefault. …"}}
```

`probe-pack` was made with `agents.create`, as Clawtrate makes bots, which writes `agentDir` into its entry (section 7). Then a package of the command line's own making:

```
claws create: exit 0  files: [ 'CLAW.md', 'package.json' ]
claws add --dry-run: exit 0 {"agent":{"requestedId":"sample","finalId":"probe-imported","workspace":"<state>/workspace-probe-imported",…},"actions":["agent","workspace","workspaceFile"],"blockers":[],"planIntegrity":"<string>"}
claws add --yes: exit 0 {"status":"complete"}
connection saw: [ 'presence', 'health', 'chat.metadata.changed', 'config.changed' ] agents.list: [ 'main', 'marlow', 'otto', 'pip', 'probe-imported' ]
claws export probe-imported: exit 0   exported files: [ 'CLAW.md', 'package.json' ]
```

`agents.list` then reported `createdVia: "claw"` for such a bot, `"operator"` for one made by `agents.create`, and nothing for the seeded bots. The connection that watched the add was closed by the gateway (1006) during the reload that followed; a new connection worked.

### For the design

The gateway's package cannot hold a bot Clawtrate makes, and it has its own format, plan and failure modes. So the app does not offer it: a bot moves as a Clawtrate file (section 10), the reading and writing halves of a copy (section 7), and the screen says that the gateway does not know that format. This section is where the package's commands are recorded, for a gateway's owner who wants them: `OPENCLAW_EXPERIMENTAL_CLAWS=1 openclaw claws export <id> --out <folder>` for a bot with `createdVia: "claw"`; `claws migrate <id> --dry-run` to see whether the gateway would enroll one; and `claws add <folder> --dry-run`, then `--yes --plan-integrity <digest>`, to add one.

## 9. Delete

### What the gateway does

`agents.delete {agentId, deleteFiles?}` (admin; `<openclaw>/dist/agents-DAPW-UCQ.mjs` lines 784-1063) first refuses, changing nothing, when the bot holds the gateway's shared sign-ins (line 793), is the only bot (802), or owns inherited sign-ins (806). Then, under a journal: it removes the bot's routines and saved command approvals and its configured entry with its bindings (line 874), drops its task entries from the store (927), and, when `deleteFiles` is true, moves its workspace, its agent folder (sign-ins kept for it alone, its database) and its transcripts to the gateway user's `~/.Trash`, skipping any path a surviving bot owns (`isPathOwnedBySurvivingAgent`, `<openclaw>/dist/agent-delete-databases-BEBUK4uA.mjs` lines 115-121). `deleteFiles` defaults to `true` (line 810). The answer is `{ok, agentId, removedBindings, removed[{path, method: trash|missing}], failed[{path, reason}], purgeFailed?}` (schema `AgentsDeleteResult`). A preview can read `sessions.list {agentId}`, `cron.list {agentId, includeDisabled}`, `agents.workspace.list {agentId}`, `agents.files.list` and `config.get` (all `operator.read`).

### Live

`probe.ts delete`. Alpha and Beta share one workspace folder; Alpha has a routine and a task:

```
what a preview can read for Alpha: {"workspace":{"entries":6,…},"sessions":["agent:probe-alpha:main"],"routines":["Probe nightly"]}
agents.delete Alpha {deleteFiles: true}: {"ok":true,"removedBindings":0,"removed":[…/agents/probe-alpha/agent/openclaw-agent.sqlite (trash), …, "<state>/agents/probe-alpha/agent" (trash), "<state>/agents/probe-alpha/sessions" (trash)],"failed":[]}
  after: listed false workspace on disk true
  what a preview reads now for Alpha: {"workspace":"agent \"probe-alpha\" not found","sessions":[],"routines":[]}
  Beta still reads its instructions: true
agents.delete Beta {} (deleteFiles left out): {"ok":true,…,"removed":[…,"<state>/agents/probe-beta/sessions" (trash),"<state>/workspace-probe-alpha" (trash)],"failed":[]}
  after: workspace on disk false
agents.delete Gamma {deleteFiles: false}: {"ok":true,"removedBindings":0,"removed":[],"failed":[]}
  after: listed false workspace on disk true sessions folder on disk true tasks listed []
agents.delete Delta {deleteFiles: true} with its workspace's parent read-only: {"ok":true,…,"failed":[{"path":"<state>/probe-parent/delta","reason":"EACCES: permission denied, rename '<state>/probe-parent/delta' -> '~/.Trash/.fs-safe-trash-…/delta'"}]}
  after: listed false workspace on disk true
agents.delete Delta again, parent writable: {"ok":true,…,"removed":[{"path":"<state>/probe-parent/delta","method":"trash"}],"failed":[]}
agents.delete Delta a third time: {"message":"agent \"probe-delta\" not found","code":"INVALID_REQUEST"}
```

And the shared sign-ins' bot:

```
agents.delete main {deleteFiles:false}: refused: Agent "main" owns the legacy shared auth store and cannot be deleted. Run openclaw doctor --fix to migrate shared auth, then retry. INVALID_REQUEST
```

A delete with files moved the probe's folders into the Trash of the user the gateway runs as (`~/.Trash` on macOS, `movePathToTrash` in `@openclaw/fs-safe`), which is where they stay. A person should know this: **a deleted bot's folders, its workspace and memory among them, can be restored from the Trash on the gateway's machine until that Trash is emptied**, and until then they still take their space there. The probe's folders were left in that Trash; nothing in it was touched.

### What a review found that this section had not

An independent run of the same calls showed more than the paragraphs above (round 1 review):

- The gateway compares a workspace with every other bot's in both directions (`workspacePathsOverlap`, `<openclaw>/dist/agent-delete-safety-*.mjs`, region `src/agents/agent-delete-safety.ts`) and against other bots' registered folders and database files (`isPathOwnedBySurvivingAgent`, `agent-delete-databases-*.mjs`). A parent workspace was kept when a nested one survived, with different `agents.list` paths. **Source**, and **live** in that run.
- A retry uses the choice the journal first recorded (`lockedJournal?.deleteFiles ?? requestedDeleteFiles`, `agents-DAPW-UCQ.mjs` line 827): a retry sent with `deleteFiles:false` after a ticked delete still moved the workspace. **Live** in that run.
- When the session-store purge fails, no folder is moved (line 935, `if (deleteFiles && !purgeFailed)`). **Source.**
- With the box unticked, the bot's task rows were gone and one deletion archive of its transcript was kept. **Live** in that run.
- After the delete, `agents.workspace.list` and `agents.files.get` answer "agent … not found", so a client cannot read a folder's state afterwards: it has only the answer's `removed` and `failed`, which do not list every path kept.
- `agents.workspace.list` returns one folder's entries a page at a time (`totalEntries` for that folder), so it does not count a workspace's files.

### For the design

The confirmation says the folders can be restored from that Trash until it is emptied. It names, from reads made when it opens and made again just before it sends, what goes at once (settings and routes, the tasks from every list, each routine, saved approvals) and what goes only with the folder option (the workspace with its memory, the bot's own folder, the transcripts), with numbers only for lists read to their end. It says a folder stays because another bot uses it only for an exact match of `agents.list` paths, and otherwise that the gateway checks that while it deletes. Clawtrate always sends `deleteFiles` explicitly. Afterwards it reads `agents.list`, `config.get`, `cron.list` and `sessions.list` again and reports each folder path from the answer alone: moved, already gone, couldn't be moved, or, for a path the answer doesn't name, not confirmed. A refusal is quoted and followed by the same reads. A lost answer offers "Check again" and "Retry the same delete", and promises neither outcome.

## 10. A Clawtrate bot file, written and read back

### What was asked

Whether Duplicate's reads, written to a file, and Duplicate's writes, read from one, give a new bot equal to the first in everything the file carries (`docs/design/bots-lifecycle.md` §9): the name, label and picture, the model by name and effort, and AGENTS.md and SOUL.md. Tool settings and skills are not in the file: a bot's `agents.entries.<id>.tools` admits execution settings such as `pathPrepend` and `safeBinTrustedDirs` (`<openclaw>/dist/zod-schema.agent-runtime-*.mjs`, region `src/config/zod-schema.agent-runtime.ts`), so they describe the gateway they were made on and would carry its paths into another one. **Source.**

### Live

`probe.ts file`, run again for round 1 with that smaller payload. A scratch source bot gets a known value for every field, with a real 2 × 2 PNG as its picture. The file is written from what the gateway returns for it (`agents.list`, `config.get`, `agents.files.get`; a file the source lacks is left out, never written as empty), read back and checked (the probe's `parseBotFile`: size, format and version, unknown fields at any level, types and limits, an account in the model, the picture decoded), the model is looked up in `models.list`, and a new bot is made with `agents.create {name, model, avatar}`, one `agents.files.set` per file with the new bot's hash, and one `config.patch` for the label, the effort and the model with an empty fallback list. Then both bots are read again the same way:

```
the source picture decodes: true characters: 130
agents.create {"name":"Probe Source","avatar":"data:image/png;base64,… (130 characters)"}: {"ok":true,"agentId":"probe-source","name":"Probe Source","workspace":"<state>/workspace-probe-source"}
source settings written: ok
file written: {"bytes":525,"keys":["name","label","picture","model","effort","instructions"],"files":["AGENTS.md","SOUL.md"],"model":"scripted/dev-1","effort":"high","label":"Planning","pictureChars":130}
the file's model is offered here: true
a name already taken, agents.create {name: "Probe Source"}: refused
agents.create {"name":"Probe Imported","model":"scripted/dev-1","avatar":"data:image/png;base64,… (130 characters)"}: {"ok":true,"agentId":"probe-imported","name":"Probe Imported","workspace":"<state>/workspace-probe-imported","model":"scripted/dev-1"}
agents.files.set AGENTS.md: true
agents.files.set SOUL.md: true
settings written (label, effort, model with an empty fallback list): ok
by the reads, the new bot's fields equal the source's: {"AGENTS.md":["753a804de42c","753a804de42c",true],"SOUL.md":["51ed00f66ab4","51ed00f66ab4",true],"label":["Planning","Planning"],"picture":[130,130,true,true],"model":["scripted/dev-1","scripted/dev-1"],"effort":["high","high"]}
format version 2: refused, format version 2 is not one this version reads
a label that is a number: refused, label is not text of at most 256 characters
a tools field: refused, it has a field the format doesn't define: bot.tools
a model that names an account: refused, model names an account: scripted/dev-1@work
a picture that is a PNG signature and filler: refused, picture is not an image that decodes
a file over 5 MiB: refused, the file is 5242881 bytes; at most 5242880
```

The first run, before round 1, also carried tool settings and skills and passed the same comparison; that payload is no longer the design's. The development gateway offers one model, so a file naming a model it does not offer was not run; the review leaves such a model out (`agents.create` without `model`) and says so.

### For the design

A Clawtrate file is as strong as Duplicate and no stronger: separate writes, each read back on its own row, no atomic creation. The limits it checks before using anything are the host's save limit for the whole file (5 MiB, `MAX_SAVE_BYTES`), the engine's name cap for text fields (256), what Clawtrate keeps of a picture (32,768 characters, after cropping and encoding; section 3), and the gateway's bound for each instruction file (section 11). Equal strings prove nothing about a picture, so the picture is decoded as well.

## 11. An instruction file at its size bound

### What the gateway does

`agents.files.set` refuses content over 2,097,152 bytes, by `Buffer.byteLength` of the UTF-8 text, before it writes (`<openclaw>/dist/agents-DAPW-UCQ.mjs` line 478). The check throws instead of answering with an error shape, so it reaches the client as `UNAVAILABLE`.

### Live

`probe.ts limits`, on a scratch bot:

```
agents.files.set 2,097,152 bytes of ASCII (the bound): ok file now: {"size":2097152,"changed":true}
agents.files.set 2,097,153 bytes of ASCII (one over): {"message":"Error: Workspace document exceeds its write bound","code":"UNAVAILABLE"} file now: {"size":2097152,"changed":false}
agents.files.set 699,051 euro signs: 699,051 characters, 2,097,153 bytes: {"message":"Error: Workspace document exceeds its write bound","code":"UNAVAILABLE"} file now: {"size":2097152,"changed":false}
```

### For the design

The bound is in bytes, not characters, and a refused write leaves the file as it was. Clawtrate checks the byte length itself before sending, in the Instructions page and in an import, so this refusal is never the way a person learns of the limit. `UNAVAILABLE` here is not an unknown outcome: the read after it shows the file unchanged. A file this size is also far past what the gateway loads into a task (20,000 characters, section 5).

