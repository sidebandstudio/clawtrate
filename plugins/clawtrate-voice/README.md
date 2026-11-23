# Clawtrate voice plugin

`clawtrate-voice` is a plugin for an OpenClaw gateway. It adds a short voice guide to every bot's system prompt, so each bot writes to its person plainly and warmly and never uses an em dash. A person turns it off and on for every bot at once in Clawtrate's Settings, under Conversation. Clawtrate is an independent open-source project.

It changes what each bot is told, not how Clawtrate shows a reply. Bots that already exist get the guide on their next turn, and so does every new bot.

## What it adds

| What                  | Scope            | Details                                                                              |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `before_prompt_build` |                  | Returns `{appendSystemContext: GUIDE}` while the setting is on, and nothing when off |
| `clawtrate-voice.get` | `operator.read`  | `{}` → `{plain, reachesBots, guide}`                                                 |
| `clawtrate-voice.set` | `operator.admin` | `{plain: true}` or `{plain: false}` → the same answer as `get`, read after the save  |

The guide is `GUIDE` in [`index.js`](index.js). The setting is one row in the gateway's own plugin state (`api.runtime.state.openKeyedStore`, retained), so it survives a restart. With no row the setting is on. `set` answers only a person's own operator connection, not a bot calling the gateway.

`reachesBots` is false when the gateway's config keeps the hook from running. Then no bot gets the guide, whatever `plain` says, and Clawtrate says so.

## What it needs

- OpenClaw 2026.10.6, the version tested here. The gateway puts the guide at the end of the system prompt, after its own parts, under the line "OpenClaw plugin-injected system context."
- `plugins.entries.clawtrate-voice.hooks.allowConversationAccess: true` in the gateway's config. OpenClaw registers `before_prompt_build` for a plugin that is not bundled only with this grant, and skips it otherwise with a warning in the gateway's log. `hooks.allowPromptInjection: false` blocks it too.

## On a Clawtrate development gateway

The plugin's `clawtrate-dev-contract.json` grants its hooks conversation access, so the development gateway writes the grant into its entry:

```bash
pnpm dev-gateway start --instance voice --with-plugin clawtrate-voice
```

Ask any bot "What did plugins add to your system prompt?" and the scripted model quotes the guide, or says nothing was added. `pnpm e2e` loads the plugin on its seeded instance, and `e2e/voice.spec.ts` (F-523) turns the setting off and on in Settings and asks every seeded bot after each change.

The unit tests run with `pnpm test` (`plugins/clawtrate-voice/test`).
