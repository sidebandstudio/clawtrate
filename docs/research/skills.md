# Skills: what the gateway does with a library, a task's revisions, a bot's list and the learned workshop

What Clawtrate can do with skills on an OpenClaw 2026.10.6 gateway, checked on a development instance with this project's own client. It is the evidence behind `docs/design/skills.md` and the rows F-198, F-199 and F-361 to F-363 of `docs/parity.md`.

How to read the citations, as in `gateway-capabilities.md` and `setup-flow.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, the one the `openclaw` wrapper script runs. Chunk names carry a build hash; search by the `//#region <source path>` marker at the top of each chunk. Line numbers are of the 2026.10.6 chunks.
- **Live** means it was run, and the result is quoted. **Source** means it was read in shipped code or bundled docs only, with the reason it was not run.

Where things were run:

- **One named development instance**, `d13skills`, started by this checkout with `pnpm dev-gateway start --instance d13skills`, and reset afterwards. Its bots are the seeded Juniper (`main`), Otto, Marlow and Pip, on the scripted model.
- **Four devices of this project's own client** (`ClawtrateClient` from `packages/core`, paired the way the desktop app pairs, approved with the gateway's own `devices approve <requestId>`): **A** and **B** at Clawtrate's interactive tier (`operator.read`, `operator.write`, `operator.approvals`, `operator.questions`), **R** read-only (`operator.read`), **X** with `operator.admin` as well. The probe is `skills/probe.ts`; each experiment's name is given with its results.
- **Three directives added to the scripted model for these runs** (`skills/scripted-model.patch`, applied to the checkout only while the runs were made; section 12): `#learn` makes the bot call `skill_workshop` in its personal-library form (`{action: "create", name, proposal_content}`), `#learn-workshop` in its learned-workshop form (`{action: "create", name, content}`), and `#skills` makes the bot answer with the names in the `<available_skills>` block of the system prompt the gateway sent for that turn, with the first 12 characters of the revision a library skill's location names. `#skills` is how this note proves what a bot is given; nothing is inferred from `skills.status`, which section 6 shows does not reflect a bot's list.

Identifiers in the quotes are shortened to 12 characters; the probe redacts the gateway computer's account name wherever the gateway put it.

## Summary

| # | Question | Answer | Section |
|---|---|---|---|
| 1 | Whose library is it? | The library belongs to a **durable gateway profile**. An operator connection with no signed-in user is given the gateway's owner profile, `gateway-owner`, when no `gateway.roles` are configured, or when it authenticated with the shared token or password. **Live** for the first case: on the development gateway every device was the owner profile. With roles configured, a device-token connection gets no owner profile, and every library write is refused "Sign in with a durable Gateway profile…" **Source.** Whether a connection has a profile is read per connection, from the list's `profileId`. | 1 |
| 2 | Tiers | `list` and `read` at `operator.read`; `save`, `mutate` and `activate` at `operator.write`; `skills.workshop.list`, `read` and `changes` at `operator.read`; `archive` and `restore` at `operator.admin`. A lower tier gets `FORBIDDEN` "missing scope: …". **Live** on all three tiers. | 2 |
| 3 | Saving, and two devices saving the same skill | Every save names the revision it edits. A loser gets `SKILL_LIBRARY_CONFLICT` "Skill changed. Read the current revision and review your edit before saving again." with `currentRevision`; nothing of either text is lost, and every revision stays readable by id. A revision is a hash of the content. Refusals: a taken name, an invalid name, an empty body, no description, over 1,048,576 characters, and a recognised literal key (which comes back only as a general `UNAVAILABLE`). A save that writes only name, description and body drops the skill's other frontmatter; that changed `userInvocable` from false to true. **Live** (`library`, `round2`). | 3 |
| 4 | `mutate` | `enable`, `disable`, `share`, `unshare`, `remove` and `rollback` work on the person's own skill at the interactive tier; `transfer` needs admin, and a team-owned skill can't be taken back. `remove` hides the skill from the library and from new tasks; a task that holds it keeps its revision. **Live.** No event tells another client about any library change. **Live.** | 4 |
| 5 | A task's revisions | A task a person starts pins the library's enabled skills, at most 64, each at its current revision, when it is created; a spawned task, a synthetic one or one with no profile pins none (source). A saved edit changes nothing in it until `activate {action: "refresh"}`, which takes effect on the next turn, not the running one. `skills.library.list {sessionKey}` is where a client reads what a task holds. A removed skill in a task blocks `refresh` for the whole task until it is detached. **Live**, each with a turn. | 5 |
| 6 | A bot's skill filter | `agents.entries.<id>.skills` through `config.patch` (admin): a filter: with no key the bot inherits `agents.defaults.skills` (no default means no filter), `[]` gives none, an unknown name matches nothing, and a library skill is matched by its command name (`s_<slug>_<id>`), not by its slug. An inherited `[]` emptied a task's turn while its pins held the skill. Learned workshop skills bypass the filter; other gates still apply. A task's own `toolOverrides.skills` can change the result (source). Shortening a list needs `replacePaths`. The write does not restart the gateway; a run in progress finishes; the next turn of every task follows the new list. A stale `baseHash` is refused. Every tier reads the list with `config.get`. **Live**, each with a turn. | 6 |
| 7 | The learned workshop | A learned skill is a folder in the bot's state; the gateway's change feed records who made each change (`actor: "agent"`, `"review"` or `"user"`), when, and in which task and run. Archive and restore keep versions. **Live.** | 7 |
| 8 | Saving a process from chat, and the "/" menu | The bot's `skill_workshop` call is an ordinary tool call in the agent stream and a `toolCall` block in the history. No approval was asked. Its form is chosen per run: a run with personal authoring (an attributed person's message on a connection with a profile) saves to that person's library; one without it gets the learned-workshop form; an admin on a single-profile gateway gets both, and a call without `target: "personal"` goes to the workshop. In these runs the interactive device's saved to the library and the admin device's to the workshop. A gateway that does not offer the tool answers "Tool skill_workshop not found". **Live.** | 8 |
| 9 | What a skill brings besides text | Support files (scripts kept executable), requirements in its frontmatter (programs, environment values), all stored under the gateway's state folder. A skill whose requirements aren't met is pinned to a task but not given to the bot. A literal key is refused by the library; keys for installed skills live in the gateway's configuration file, which the gateway stores unencrypted. **Live** and **Source**. | 9 |
| 10 | Sharing on this gateway | `share` sets `shared: true`; `list {scope: "team"}` then lists it; `unshare` reverses it. The connection needs a durable profile and must own the skill (or be an admin outside personal authoring). Two opposite writes on one revision were both accepted (`round2`). Whether another eligible profile sees it, and keeps an existing pin after it is withdrawn, could not be run: every connection on a development gateway is the same owner profile. **Live**, except that, which is source. | 10 |
| 11 | Outside catalogs | `skills.library.import` installs from ClawHub, an outside host. Not called. | 11 |

## 1. Whose library it is: the durable profile

The library's handlers take the caller's profile from the connection (`libraryAuthority`, `<openclaw>/dist/skills-library-f1x0CvB1.mjs` lines 203-219: `profileId: client?.authenticatedUserProfile?.profileId`). Every write requires one (`requireSkillLibraryProfile`, `<openclaw>/dist/store-Da3EVVBC.mjs`, region `src/skills/library/store.ts`):

> Sign in with a durable Gateway profile to use a personal skill library. Shared-token administrators can use workspace skills.

At connect, an operator with no signed-in user is given the gateway's owner profile when no roles are configured (`shouldUseGatewayOwnerProfile`, `<openclaw>/dist/gateway-owner-profile-6q0DpnDA.mjs` line 47: `role === "operator" && !authenticatedUserId && (!rolesConfigured || authMethod === "token" || authMethod === "password")`; `resolveGatewayConnectProfileAdmission`, `<openclaw>/dist/message-handler-CRCo2VX0.mjs` lines 2922-2948). The owner profile's display name is the gateway computer's account name (`readHostAccountName`, same first file, lines 19-38: `id -F` on macOS, the passwd entry's name on Linux). Library entries carry it as `ownerLabel`.

**Live** (`tiers`, `library`). Every device, read-only included, listed with a profile; the bot's saved entry names it:

```
read device         skills.library.list: {"profileId":"<profile>","defaultTarget":"personal","multipleProfiles":false,"canManageWorkspace":false}
interactive device  skills.library.list: {"profileId":"<profile>","defaultTarget":"personal","multipleProfiles":false,"canManageWorkspace":false}
admin device        skills.library.list: {"profileId":"<profile>","defaultTarget":"workspace","multipleProfiles":false,"canManageWorkspace":true}
bot's entry         "ownerLabel":"<redacted>","ownerProfileId":"gateway-owner","authorProfileId":"gateway-owner"
```

What this means for the design:

- On the development gateway every device was the owner profile, and device B saw and could edit A's skills (section 3). Whether that holds elsewhere depends on how each connection authenticated, so the design reads a connection's profile from the list and claims nothing about a person's other devices.
- `ownerLabel` is the gateway computer's account name, or "Team". It is content from the gateway.
- With `gateway.roles` configured, a device-token connection gets no owner profile, and saving answers `IDENTITY_REQUIRED` with the message above; a token or password connection still gets it. **Source**: a development instance's configuration is fixed by the tool, and roles were not added.
- What the list returns depends on the reader: removed entries never; another profile's unshared entries only to an admin (`selectSkillLibraryEntries`, region `src/skills/library/store.ts`). Visibility and the right to edit (`canEdit`) are separate.

## 2. The methods and their tiers

From the method table (`<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 935-1127 and 3286-3304) and **live** on each device (`tiers`):

| Method | Tier | Read-only device | Interactive device | Admin device |
|---|---|---|---|---|
| `skills.library.list {scope?, sessionKey?}` | read | the list; `canEdit: false` on every entry | the list | the list; `defaultTarget: "workspace"` |
| `skills.library.read {skillId, revision?, sessionKey?}` | read | the entry, content and files | the same | the same |
| `skills.library.save` | write | `FORBIDDEN` "missing scope: operator.write" | saved | saved |
| `skills.library.mutate` | write | refused, as above | changed | changed |
| `skills.library.activate` | write | refused, as above | `{sessionActivation: "next-turn"}` | the same |
| `skills.workshop.list`, `read`, `changes` | read | answered | answered | answered |
| `skills.workshop.archive`, `restore` | admin | `FORBIDDEN` "missing scope: operator.admin" | refused, as on the read-only device | answered |
| `config.get` | read | the whole redacted config, with `agents.entries.<id>.skills` and `hash` | the same | the same |
| `config.patch` | admin | not tried (the method table's tier) | not tried | patched |

`skills.library.import` and `skills.library.upload` are write methods too; import fetches from ClawHub (section 11), upload takes a zip in chunks. Neither is used by the design.

## 3. Saving

`skills.library.save {skillId?, expectedRevision, slug, content, files?, retainFiles?}` (`<openclaw>/dist/skill-library-Bgib5R_8.mjs`, the protocol schema; `saveSkillLibrary` and `publishSkillLibraryInDatabase`, `<openclaw>/dist/skills-library-f1x0CvB1.mjs` lines 56-115 and `<openclaw>/dist/store.worker-DxsjIdzg.mjs` lines 17-63). `content` is the whole `SKILL.md`: frontmatter with `name` and `description`, then the instructions.

The answer is a receipt: `{state, target, entry, sessionActivation: "new-sessions", nextAction}`, where `entry` is `{skillId, slug, name, ownerLabel, description, ownerProfileId, authorProfileId, shared, enabled, removed, revision, createdAt, updatedAt, canEdit}`. `name` is the command name the bot sees, `s_` and the first nine characters of the slug and 20 of the id (`managedSkillCommandName`, region `src/skills/library/command-name.ts`).

### Two devices saving the same skill (live, `library`)

```
1. A saves a new skill:                       state published, revision 691de4d57d7f
2. B reads it:                                revision 691de4d57d7f, "2. Pack water."
3. A saves an edit on revision 1:             state published, revision 778300013f16
4. B saves its own edit, also on revision 1:  {"code":"INVALID_REQUEST","message":"Skill changed. Read the current revision and review your edit before saving again.","details":{"code":"SKILL_LIBRARY_CONFLICT","currentRevision":"778300013f16…"}}
   what B reads now:                          revision 778300013f16, "2. Pack water and a map.", revisions [778300013f16, 691de4d57d7f]
5. B saves again on the current revision:     state published, revision 12a27e7c037e
   A's revision is still readable by id:      ok, "2. Pack water and a map."
6. the same text saved again:                 state unchanged, revision 12a27e7c037e
```

- The loser's text is not saved and not lost: it is still in the loser's editor, and the winner's is on the gateway. The answer names the winner's revision, which `read` returns.
- A revision is a hash of the skill's content: two skills with the same text had the same revision (`691de4d57d7f` came back for three different skills in this run), and a rollback returns to the earlier hash. So a save based on content that someone else has since changed and changed back is not a conflict; it loses nothing either.
- `mutate` checks the revision the same way (`extra`: a `disable` and a `share` naming the earlier revision both got `SKILL_LIBRARY_CONFLICT`), but `enable`, `disable`, `share` and `unshare` do not change the revision, so two devices switching the same skill do not conflict with each other.

### What is refused (live, `library`)

| Save | Answer |
|---|---|
| A new skill with a name already in the library | `SKILL_LIBRARY_NAME_CONFLICT` "A skill named "…" already exists in this library. Choose a different slug; existing skills were preserved." |
| A name with capitals or spaces, or 64 characters | "invalid skills.library.save params: at /slug: must match pattern "^[a-z0-9][a-z0-9-]{0,62}$"" |
| An empty body (`content: ""`) | "at /content: must not have fewer than 1 characters" |
| No description, no frontmatter, or a description over 1,024 characters | `SKILL_LIBRARY_INVALID_BUNDLE` "SKILL.md requires name and description (at most 1,024 characters)." |
| `content` over 1,048,576 characters | "at /content: must not have more than 1048576 characters" (exactly 1,048,576 was saved). The bundle is also limited to 1,048,576 bytes a file (`SKILL_LIBRARY_MAX_FILE_BYTES`, `<openclaw>/dist/bundle-D_720Viz.mjs`), so text with characters of more than one byte reaches that limit sooner. **Source**, for bytes |
| A recognised literal key in the instructions | `UNAVAILABLE` "Unable to complete the skill library operation. Review the bundle or retry the request." The scan's own message ("Skill contains a recognized literal credential…", `<openclaw>/dist/skill-bundle-scan-DoKCHlpX.mjs` line 22) is a plain error, which the handler does not pass on (`libraryHandler`, `skills-library-f1x0CvB1.mjs` lines 319-333) |
| A new skill with an `expectedRevision` | `SKILL_LIBRARY_CONFLICT` "A new skill requires expectedRevision: null." |

What is **accepted** and the design must handle itself: a frontmatter `name` different from the slug (the slug wins as the skill's name), and frontmatter with no instructions under it. Clawtrate writes the frontmatter from its own fields, so the first cannot happen from its editor; it requires instructions as its own rule.

### Support files (live, `library`)

A save can carry `files: [{path, content, encoding?, executable?}]`. Read back, each file comes base64-encoded with its `executable` flag. On disk, under the gateway's state folder:

```
skill-library/78ef4ba9…/revisions/b8d630fbb45a…/SKILL.md            mode 400
skill-library/78ef4ba9…/revisions/b8d630fbb45a…/references/times.md mode 400
skill-library/78ef4ba9…/revisions/b8d630fbb45a…/scripts/timer.sh    mode 500
```

An edit that sends neither `files` nor `retainFiles` drops every support file (`files now: []`); `retainFiles: ["scripts/timer.sh"]` kept exactly that one. So an editor that changes only the instructions must send every existing file's path in `retainFiles`.

## 4. `mutate`, verb by verb

`skills.library.mutate {skillId, expectedRevision, action, revision?}` (`mutateSkillLibraryInDatabase`, `<openclaw>/dist/store.worker-DxsjIdzg.mjs` lines 64-101). **Live** (`library`, `transfer`), on device A's own skill, with device B listing:

| Verb | Answer | Afterwards |
|---|---|---|
| `disable` | `enabled: false`; "Disabled for new-session defaults. Existing sessions retain their selected revision; explicit attachment remains available." | New tasks no longer pin it |
| `enable` | `enabled: true` | New tasks pin it again |
| `share` | `shared: true`; "Enabled for new team sessions…" | B: listed under `mine`, `team` and `all` |
| `unshare` | `shared: false` | B: listed under `mine` and `all`, absent from `team` |
| `transfer` (interactive) | `SKILL_LIBRARY_FORBIDDEN` "Transfer to team ownership requires a Gateway administrator." | Unchanged |
| `transfer` (admin) | `target: "team"`, `ownerProfileId: null`, `ownerLabel: "Team"`, `shared: true` | `unshare` then answers "Team-owned skills cannot become personal through unshare."; the interactive device's `disable` answers "Only the skill's owner or a Gateway administrator can change it." |
| `rollback {revision}` | the entry's revision is the named earlier one | — |
| `remove` | `state: "removed"`; "Existing sessions retain their pinned revision. Create a new skill to add it to future sessions." | Absent from every scope; `read` by id still answers, with `removed: true`; any further `mutate` answers "Removed skills cannot be edited or selected again; pinned revisions remain available to their sessions."; a new skill may take its name |

No `mutate` and no `save` sent any event to another device: in the whole `library` run, A and B each received only `presence`. A client sees another's change only by reading again, or as a conflict when it writes.

## 5. A task's revisions

A task's pins are `skillLibrarySelections` in the session's entry, each `{skillId, revision, name, ownerProfileId}` (`<openclaw>/dist/skill-library-Bgib5R_8.mjs`, `SkillLibrarySelectionSchema`). `activate {sessionKey, action, skillId?, revision?}` changes them (`activateLibrarySelection`, `skills-library-f1x0CvB1.mjs` lines 220-293; `change`, region `src/skills/library/read.kernel.ts`). **Live** (`task`, `running`), with Juniper; "given" is what `#skills` reported for the turn:

```
1. a new task, before any message: selections [pack-list 8a3e2999a308, …4 other enabled skills]
   the bot was given:              s_pack_list_2e1b02d19eaf4776becd (revision 8a3e2999a308)
2. a saved edit, revision 198b1684ab91; the task's selections: pack-list 8a3e2999a308
   the bot was given:              (revision 8a3e2999a308)
   a task created after the edit:  pack-list 198b1684ab91
3. activate refresh:               {"sessionActivation":"next-turn","selections":[… 198b1684ab91 …]}
   the next turn was given:        (revision 198b1684ab91)
4. detach:                         4 selections left; the next turn was given nothing of it
5. attach revision 1 explicitly:   pinned 8a3e2999a308
   read with the task's key and its pinned revision: ok, canEdit false
   read with the task's key and another revision:    "Session reads require an exact selected skillId and revision."
6. remove the skill: state removed; the task's selections still hold 8a3e2999a308
   the next turn:                  final, given (revision 8a3e2999a308)
   refresh after the remove:       "Removed skill cannot be selected. Existing pinned selections remain available."
   attach after the remove:        the same
   a new task after the remove:    no longer pins it
```

During a run (`running`): a task held revision `cf0ffa20cf8c`; an edit made `5bf184e32830`; `#slow-tool 6 #skills` was sent, and `refresh` was called while its slow tool ran:

```
refresh during the run:                             {"sessionActivation":"next-turn", … 5bf184e32830 …}
the running turn, after its slow tool, was given:   (revision cf0ffa20cf8c)
the next turn was given:                            (revision 5bf184e32830)
```

What this establishes:

- A task keeps what it pinned; a saved edit, a disable or a remove does not change it. `refresh` moves every pin of the task to its skill's current revision, and the bot is given it from the next turn. The running turn keeps what it started with.
- A task pins at creation (step 1 was read before any message); at most 64 skills, personal first (`seed`, region `src/skills/library/read.kernel.ts`), and only for a creation by a person with a profile that is neither synthetic nor spawned (`prepareSkillLibrarySessionCreation`, `<openclaw>/dist/skill-library-authoring-jJOx1dv3.mjs` lines 50-63). **Source**, for the conditions. A disabled skill saved again stays disabled, and a new task did not pin it; an explicit attach did (`round2`, live).
- A different revision is not always newer: `rollback` moves the entry's current revision back to an earlier one (section 4).
- `refresh` takes every pin of the task at once, so one removed skill makes it fail for all; the removed one has to be detached first. Detaching a removed skill is final: it can't be attached again.
- **Where a client reads it.** `skills.library.list {sessionKey}` returns `session.selections`, each with `slug`, `revision`, `description` and `ownerLabel`, and `attachable`, the library entries the task does not hold. Neither `sessions.describe` nor `sessions.list` carries the pins (`task`: "carries the selections? false"). So the screen names a task's revision from this read alone.

## 6. A bot's list: `agents.entries.<id>.skills`

The list is a filter over every skill the bot would otherwise be given. With no key of its own, the bot inherits `agents.defaults.skills`, and with neither there is no filter (`resolveEffectiveAgentSkillFilter`, `<openclaw>/dist/agent-filter-CQpUx-We.mjs` lines 22-27). A task's own overrides (`toolOverrides.skills` in its entry) are applied after that (`isSessionSkillEnabled`, same file lines 35-40). **Source**, for overrides: Clawtrate reads none of them. The filter is applied in `filterSkillEntries` (`<openclaw>/dist/workspace-skill-loader-IbB19fZM.mjs` lines 169-188). A learned workshop skill bypasses the filter (`isSkillEntrySelected`, `<openclaw>/dist/config-tNff2NSf.mjs` line 53: `resolveSkillSource(entry.skill) === "openclaw-workshop" || …`); it is still subject to `shouldIncludeSkill` (a disabled config entry, a missing secret owner, the bundled allowlist and the runtime's eligibility, same file lines 55-77). The bundled reference says the list is "a visibility and loading filter … not a shell-time authorization boundary" (`<openclaw>/docs/tools/skills-config.md` lines 346-362).

**Live** (`perbot`, `extra`, `workshop`), each followed by `#skills` in a new task of Juniper's:

| Juniper's `skills` | The new task was given |
|---|---|
| missing (and no `agents.defaults.skills`) | every eligible skill: the 23 bundled skills eligible on this machine and the library skills the task had pinned |
| missing, with `agents.defaults.skills: []` (`round2`) | nothing, though the task's pins held a library skill; with the default removed, the same task's next turn was given it |
| `[]` | nothing: "I was given no skills for this turn." |
| `["no-such-skill"]` | nothing |
| `["s_lake_loop_8f69adb7b6544617ae27"]`, the library skill's command name | that skill alone |
| `["lake-loop-73e254"]`, its slug | nothing |
| `[]`, with a learned workshop skill `trail-checklist` | `trail-checklist` |

The write itself:

- Shortening or emptying a list is refused unless the path is named: "config.patch would remove entries from array path(s): agents.entries.main.skills. Pass replacePaths with the exact path(s) when this is intentional, or use config.apply for full-config replacement." With `replacePaths: ["agents.entries.main.skills"]` each change went through, and `null` removed the key.
- The answer was `{ok, path, hash, config, changedPaths: ["agents.entries.main.skills"], sentinel}` with `sentinel.payload.stats.requiresRestart: false`. No device's connection dropped. Every device, the read-only one included, received `config.changed {path, hash, ts}`.
- A run in progress (`#slow 8`) when the list changed ended `final`.
- An existing task (`extra`): its turn before the change was given the library skill; after `skills: []` its next turn was given nothing, while its pins still held the skill. So the bot's list applies to every task from its next turn, and a task's pins say what it holds, not what it is given.
- A patch on a stale `baseHash` (`stalecfg`): "config changed since last load; re-run config.get and retry", and the list kept the other write's value.
- `config.get` answered on the read-only and interactive devices too, with Juniper's list and the hash. A connection without admin can show the list; it can't change it.
- `skills.status {agentId, sessionKey}` reported `blockedByAllowlist: false` for the library skill under `[]` and for a bundled one too. It is not a reading of the bot's list; the design does not use it for that.

What a skill's eligibility does, separately from the list: the library skill `weather-…` names a program and an environment value it needs (section 9). New tasks pinned it, `skills.status` listed it with `eligible: false`, and `#skills` never listed it. A pinned skill whose requirements are not met on the gateway is not given to the bot.

## 7. The learned workshop

A learned skill is a folder `<state>/agents/<id>/agent/workshop-skills/<name>/` with its `SKILL.md`; archived versions are under `.archive/<name>/` there (`<openclaw>/dist/library-ByFEjAOZ.mjs`, region `src/skills/workshop/library.ts`; `<openclaw>/docs/tools/skills-config.md`, "Symlinked skill roots"). Each change is recorded by the gateway: `{id, agentId, skillName, action, actor, summary, versionId?, sessionKey?, runId?, createdAtMs}` (`mutateSkill`, lines 199-245).

**Live** (`workshop`), after the bot created `trail-checklist` (section 8):

```
list (every tier):    {"mode":"auto","root":"~/…/agents/main/agent/workshop-skills","skills":[{"name":"trail-checklist","description":"Use when planning a weekend walk, …","files":["SKILL.md"],"sizeBytes":255,"updatedAtMs":…}],"archived":[]}
read (every tier):    {"name":"trail-checklist","filePath":"SKILL.md","content":"---\nname: trail-checklist\n…","files":["SKILL.md"]}
changes (every tier): [{"skillName":"trail-checklist","action":"create","actor":"agent","summary":"created: Use when planning a weekend walk, …","createdAtMs":…,"sessionKey":"agent:main:dashboard:…","runId":"93e49eed…"}]
archive (interactive): FORBIDDEN "missing scope: operator.admin"
archive (admin):      {"change":{"action":"archive","actor":"user","summary":"archived: Not needed this season.","versionId":"20261119T145906550Z-archive"}}
  list after:         skills [], archived [{"name":"trail-checklist","live":false,"versions":[{"id":"20261119T145906550Z-archive","action":"archive"}]}]
  read it:            "Skill "trail-checklist" is archived. Restore it first with action=restore name=trail-checklist."
  archive it again:   the same message
restore (admin):      {"change":{"action":"restore","actor":"user","summary":"restored from archive"}}
  list after:         skills [trail-checklist], archived [{"name":"trail-checklist","live":true, versions …}]
```

What "learned" means, as the gateway records it: an entry in this bot's change feed. `actor` is `"agent"` for the bot's own tool call, `"review"` for a call made by the gateway's background review (`<openclaw>/dist/openclaw-tools-DV-z1IAc.mjs` line 13971, source), and `"user"` for an operator's archive or restore; `sessionKey` and `runId` name the task and run of the bot's call; `createdAtMs` is when. The screen says "Saved by Juniper in <task>, <time>" from exactly these, and nothing about why or how well.

`mode: "auto"` is the gateway's default: "a background review runs after substantial work, and learned skills unused for 30 days are archived. Review changes are announced in the conversation" (`<openclaw>/docs/tools/skills-config.md` lines 364-372). No review ran on the instance; such a change would carry the review's actor. **Source.**

There is no operator method that edits a learned skill's text; only the bot's `skill_workshop` does (map section 21). The design reads learned skills and archives or restores them, and edits none.

## 8. Saving a process from chat

`skill_workshop` has two forms, chosen for each run (`createConfiguredSkillWorkshopTool`, `<openclaw>/dist/openclaw-tools-DV-z1IAc.mjs` lines 14126-14139; `prepareGatewaySkillAuthoring`, `<openclaw>/dist/skill-library-authoring-jJOx1dv3.mjs`, region `src/gateway/skill-library-authoring.ts`): the personal-library form when the run has personal authoring, which a person's attributed message on a connection with a durable profile grants; the learned-workshop form when it has none; and, when the library's default target is `workspace` (an admin on a single-profile gateway), both, the workshop chosen by leaving out `target: "personal"`. The connection's tier alone does not decide where a call saved; its result does (`target` in a library receipt, the "Created …" text and `details.change` of the workshop's).

The development configuration neither allows nor offers `skill_workshop`. For this note the admin device patched the instance's `tools.allow` to add it and `tools.deny` to drop it (with `replacePaths`), then sent `#learn` and `#learn-workshop` from the interactive and the admin device, each in a new task of Juniper's. **Live** (`workshop`):

| Device | `#learn` (`proposal_content`) | `#learn-workshop` (`content`) |
|---|---|---|
| Interactive | saved to the library: `state: "published"`, `target: "personal"`, slug `trail-checklist` | refused: "Validation failed for tool "skill_workshop": content: schema is false; root: must not have additional properties" |
| Admin | refused by the workshop form: `{"status":"error","tool":"skill_workshop","error":"content required"}` | learned: "Created "trail-checklist" (created: Use when planning a weekend walk, …). Undo with action=archive name=trail-checklist." |
| Either, before the patch | "Tool skill_workshop not found" | the same |

How it looked, for the interactive device's `#learn`:

- **Events**: the run's `agent` stream had `tool` `start` `{name: "skill_workshop", args: {action: "create", name: "trail-checklist", proposal_content: "---\nname: trail-checklist\n…"}}` and `result` `{isError: false, result: {content: [{type: "text", text: "{\n  \"state\": \"published\", … }"}]}}`; the rest of the run's events were `sessions.changed`, `session.message`, `chat` and `presence`. No `*.approval.*` event in any of the four runs.
- **History** (`chat.history`): the user's `#learn`; an assistant row with a `thinking` block and a `toolCall` block `{name: "skill_workshop", args}`; a `toolResult` row with the receipt's JSON; the reply.
- **Afterwards**: `skills.library.list {scope: "mine"}` had `trail-checklist`, owned and authored by `gateway-owner`. For the admin device's `#learn-workshop`, `skills.workshop.list` had it and `skills.workshop.changes` the `create` entry above.

The gateway's own words for this tool, which the bot is given: "Personal create/update publishes a revision only when the user requests the change … Publication affects new sessions; activate explicitly for the next turn in this session. Sharing or transfer requires explicit user intent and current permissions." (`openclaw-tools-DV-z1IAc.mjs`, region `src/agents/tools/skill-workshop-tool-library.ts`.) A saved skill is not attached to the task it was saved in; a new task pins it.

Approval: the default tool policy has no ask for `skill_workshop`, and none was raised. A person who wants one can set a rule for it with Clawtrate's rules plugin (`docs/design/controls.md`); this note did not run that.

The composer. `commands.list {agentId: "main"}` listed the learned `trail-checklist` as a skill command (`source: "skill"`, name `trail_checklist`) and no library skill; library skills are materialised with `disableCommandDispatch: true` (`<openclaw>/dist/selection-BoiJyabE.mjs` line 382). **Live.** The composer's "/" menu as `docs/decisions.md` decides it reads `skills.status` instead. Without a task's key, `skills.status {agentId}` had no library rows; with a new task's key it listed the task's library skill `s_lake_loop_…` with `userInvocable: true` and `eligible: true`. A skill whose frontmatter has `user-invocable: false` was listed with `userInvocable: false` in a task that pinned it, and with `true` in a task that pinned a revision saved without that line (`round2`). So a held library skill is offered in "/" only when `skills.status` marks it both. Typed in that task, `/s_lake_loop_… the north side` reached the model as "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:\n- s_lake_loop_…\n\nUser request:\n/s_lake_loop_… the north side" (the scripted model quoted it back). **Live**, on a second start of the instance.

## 9. What a skill brings besides text

- **Support files.** Up to 255 files of up to 1 MiB each, 8 MiB in all (`SKILL_LIBRARY_MAX_*`, `skill-library-Bgib5R_8.mjs` lines 5-8), stored with the revision and a script's executable bit (section 3). A bot that runs a skill's script runs it with its own tools and their rules; the library does not run anything itself.
- **Requirements.** A skill's frontmatter can name programs and environment values it needs (`metadata.openclaw.requires {bins, env}`, `primaryEnv`; read by `resolveSkillManifestMetadata`, `selection-BoiJyabE.mjs` lines 360-381). **Live**: the `weather-…` skill naming `curl` and `WEATHER_API_KEY` was saved, pinned, shown as `eligible: false` by `skills.status`, and not given to the bot (section 6). `skills.status` does not say which requirement is missing for a library skill on this gateway; the design names what the skill's own text says it needs and that the gateway judged it not met.
- **Keys.** The library refuses a recognised literal key in a skill (section 3) and the workshop refuses one with "never store real secrets in skills" (`assertSafeContent`, `library-ByFEjAOZ.mjs` lines 126-133). An installed skill's key or environment values are set in the gateway's configuration file, `skills.entries.<key>.apiKey` and `.env` (`<openclaw>/docs/tools/skills-config.md` lines 14-41), which `config.patch` writes as plain JSON; a library skill has no such entry. The design gives no field for a key.
- **Where they live.** Library revisions under `<state>/skill-library/<skillId>/revisions/<revision>/`, with their rows in the gateway's state database; learned skills under each bot's `workshop-skills` folder (section 7).

## 10. Sharing on this gateway

- **"The person's durable profile and entry authority."** Profile: section 1. Entry authority: `canEdit`, which is `actor.write && (namespace !== "personal" && actor.admin || owner !== null && actor.profileId === owner)` (`selectSkillLibraryEntries`, region `src/skills/library/store.ts`). For Clawtrate's interactive connection: its own skills only. For an admin connection: every skill, through the operator methods; through the bot's personal authoring (`namespace: "personal"`), only its own, with "Personal authoring can change only your own skills. Use the administrator UI or CLI for team management."
- **This app's connection has it** on a gateway without roles (section 1). Its refusals: "Your current Gateway role cannot change skills." (a profile without write), "Only the skill's owner or a Gateway administrator can change it." (another's skill), and `IDENTITY_REQUIRED` (no profile). **Live** for the second, **source** for the others.
- **What share does, live**: `shared: true`, listed under `scope: "team"`; `unshare` reverses it (section 4). The gateway checks the content revision on Share and Stop sharing. Two devices can still change the sharing flag on the same revision: a `share` from A and an `unshare` from B on the same revision were both accepted, and the team list no longer had it (`round2`). The client describes what its next read shows. New tasks of a profile pin shared skills of others (`seed`: `ownerProfileId === profileId || ownerProfileId === null || shared`). **Source**, for the reason below.
- **What could not be exercised**: another eligible profile seeing it, and keeping an existing pin after it is withdrawn. Both are in the source: a shared entry is listed to other profiles and seeded into their new tasks while enabled, and a task can still read its exact pin after the entry is withdrawn, while `refresh` then refuses (`<openclaw>/dist/state/openclaw-state-read.worker.js` lines 113675-113741). A development gateway has one profile, and every device is it. `multipleProfiles` is true only when two unmerged profiles other than the owner exist (same file, lines 109905-109907); a second profile needs a signed-in identity (an email or Tailscale identity through a trusted proxy, or GitHub), which a development instance does not have. So "Shared" means `shared: true` on the gateway and the team list lists it; the design does not say who has seen it.
- There is no link to a skill. Nothing here leaves the gateway.

## 11. Skills from outside this gateway

`skills.library.import {slug, source: {kind: "clawhub", slug, version?}}` installs a skill from ClawHub into the library (`importSkillLibrary`, `skills-library-f1x0CvB1.mjs` lines 133-153), and `skills.search` and `skills.detail` read ClawHub. Each makes the gateway contact an outside host. None was called; the development gateway sends every such request to its scripted model, which refuses it. The design has no screen that calls them.

## 12. The scripted directives this note used

The runs above used three directives added to the scripted model for this note: `#learn` and `#learn-workshop` (the bot calls `skill_workshop` in each of its two forms) and `#skills` (the bot answers with the names in its system prompt's `<available_skills>` block, with each library skill's revision). They are not in `tools/dev-gateway`: the design's own check is the prototype's and does not need them. They are kept as `skills/scripted-model.patch` beside the probe, which applies to `main` with `git apply` (`tools/dev-gateway/src/scenarios.ts` and `scripts.ts`). On an instance that does not offer `skill_workshop`, which is every instance the tool starts, `#learn` and `#learn-workshop` end with "Tool skill_workshop not found". It is reproduction material for this note. Where a build step needs a directive, `docs/design/skills.md` §16 says so, and that step lands it with its own tests. The checks drafted for this note did not assert each run's calls and end, as the scenario harness requires, and were not kept.

## 13. A second set of runs

`round2`, on the same instance started again, with devices A and B (interactive) and X (admin), and the scripted directives applied while it ran (section 12):

```
1. saved with user-invocable and metadata:        state published, revision 06c93007cc2b
   skills.status in a new task:                   {"eligible":true,"userInvocable":false}
2. a save of name, description and body only:     {"state":"published","keepsUserInvocable":false,"keepsMetadata":false,"files":["references/times.md"]}
   skills.status in a task created after it:      {"eligible":true,"userInvocable":true} | the first task: {"eligible":true,"userInvocable":false}
3. a save that keeps the frontmatter as read:     {"state":"published","keepsUserInvocable":true,"keepsMetadata":true}
4. saved while disabled:                          {"enabled":false,"nextAction":"Disabled for new-session defaults. …","newTaskPins":[]}
   attached explicitly:                           ["cc5f777bb5ca"]
5. share from A and unshare from B on one revision: {"share":true,"unshare":false,"inTeamListAfter":false}
6. a save on the removed skill:                   {"code":"INVALID_REQUEST","message":"Removed skills cannot be edited or selected again; …","details":{"code":"SKILL_LIBRARY_NOT_FOUND"}}
7. Juniper's key: missing | defaults.skills: missing
   with defaults.skills [] and no key:            pins hold it: true | the turn was given: I was given no skills for this turn.
   defaults removed:                              the same task's next turn: ["- s_lake_path_04d9fdd827d145d2a351 (revision 453e96a6c0f7)"]
```

What was not run, and what the source says instead:

- **A lost answer.** The client can lose a save's answer after the gateway committed it, and another save can land before the client reads again. Then the read shows the later revision while the first stays in the skill's history (`readSkillLibraryMetadataInDatabase` lists every revision). A read therefore cannot tell which write produced what it shows, and the design says only what the read found.
- **A second profile**, as in section 10.

