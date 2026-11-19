# Clawtrate memory plugin

`clawtrate-memory` is a plugin for an OpenClaw gateway. It lets Clawtrate list, read and safely change a bot's Markdown notes and shared memory. Clawtrate is an independent open-source project.

> **Status: development gateways only.** Issue #41 requires a recorded security review before installation on a gateway with real data.

## What it adds

| Method                    | Scope            | Parameters                                                                                         |
| ------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `clawtrate-memory.list`   | `operator.read`  | `{agentId}` for notes, `{sharedRoot}` for files in a shared folder, or `{}` for the shared folders |
| `clawtrate-memory.read`   | `operator.read`  | `{agentId, path}` or `{sharedRoot, path}`                                                          |
| `clawtrate-memory.write`  | `operator.admin` | A read's parameters plus `content` and `expectedHash`                                              |
| `clawtrate-memory.delete` | `operator.admin` | A read's parameters plus `expectedHash`                                                            |
| `clawtrate-memory.copy`   | `operator.admin` | `{item: {sharedRoot, path}, agents, expectedHashes}`                                               |
| `clawtrate-memory.uncopy` | `operator.admin` | The same parameters as copy                                                                        |

A note path starts with `memory/` and ends in `.md`. A shared note's path is relative to the folder selected by `sharedRoot`, the ID returned by the folder list. The list also gives each folder's path and the bots with search configured for it. The gateway's `agents.list` filters bot access for the caller. Shared folders require access to the whole bot roster.

File lists give up to 256 entries with their storage hashes, sizes in bytes and modification times in milliseconds. The plugin examines at most 2,048 entries in filesystem order and sorts the results. A `truncated` list can include different entries depending on filesystem order. The plugin accepts paths up to 512 characters and 16 components. File content is UTF-8 and limited to 256 KiB. Reads return that content with the storage metadata. Notes and shared files have `loadedIntoNewTasks: false` and `searchable: "unconfirmed"`. Use the gateway's memory search to check which files it has returned excerpts from. The built-in search backend returned excerpts without a revision in the development check.

Pass the SHA-256 from the read as `expectedHash`, or `null` to create a missing note. A stale hash produces an error with `details.currentHash`. Edits publish a same-directory temporary file by atomic rename. Reads and edits reject symlinks and hard links. Copy and uncopy alone can change a bot's `MEMORY.md`. Use the gateway's file writer for direct edits to that file or to `USER.md`.

Copy and uncopy accept up to 32 distinct bots and a map of their expected `MEMORY.md` hashes. Fetch those hashes with `agents.files.get`. Each operation returns a `sourceId` and an ordered `results` array. Each result names the bot and gives the new hash after success, the reason for refusal, or `unknown: true` when publication is uncertain. Copy refuses to exceed the bot's per-file bootstrapping budget. Each successful copy carries a start and end marker with that source ID. The shared item exposes the same `sourceId` when listed or read. If the write's reply is lost, check the markers in `MEMORY.md` before retrying. An earlier bot's successful copy stays saved when a later bot refuses. Uncopy removes the uniquely marked block, even if the shared file no longer exists, while its folder remains configured.

The workspace lock serializes plugin writes. An outside writer can still change a file between its last check and publication. Mutations require the gateway to run with `FS_SAFE_NATIVE_MODE=require` and a filesystem supported by OpenClaw's native helper. Reads remain available without native mode. If a note mutation returns `details.unknown`, read the note again before retrying.

After a plugin write, the gateway records the saver and content hash on a best-effort basis. A failed saver registration logs a warning. The write still succeeds. Reads omit `savedBy` because the pinned filesystem SDK returns no publication identity for the write. Successful `write` and `edit` tool receipts are observed as metadata, with no revision attached, since the gateway exposes the tool's path argument and no file hash. The store keeps up to 512 saver records across restarts. The event `plugin.clawtrate-memory.changed` carries an empty object when a plugin RPC changed or may have changed a file. Tool receipts only update the saver store.

## What it needs

- OpenClaw 2026.10.6, the version tested here.
- Local bot workspaces. OpenClaw provisions a missing workspace when the bot first runs. Workspaces declared to a device bridge are refused.
- For shared memory, existing directories below the gateway's state directory, configured in `memory.search.extraPaths` or a bot's search settings. The folder must be a real directory with no linked path beneath state and must be separate from bot workspaces. A configured path pattern limits which Markdown files the plugin accepts.

## Installing and checking it

Run this from the checkout with the pinned OpenClaw on `PATH`. The development gateway loads the plugin from its own copy. The check uses the scripted model, configures a throwaway shared folder and opens paired operators at different scope tiers.

Reserve `memplugin` for this check. The start command stops an existing tool-owned instance with that name and replaces all its state. Reset deletes the new state. Run these commands only if you can discard that instance.

```bash
FS_SAFE_NATIVE_MODE=require pnpm dev-gateway start --instance memplugin --with-plugin clawtrate-memory --no-seed
node plugins/clawtrate-memory/test/gateway-check.ts
pnpm dev-gateway reset --instance memplugin
```

The unit tests use the pinned gateway's filesystem SDK. Set `OPENCLAW_PACKAGE_DIR` to its installed package directory when the global package is a different version.

```bash
pnpm exec vitest run plugins/clawtrate-memory/test/memory.test.ts
```
