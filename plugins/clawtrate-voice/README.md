# clawtrate-voice

Asks the bots on a gateway to talk to their person plainly and kindly, with no em dashes. The guide is [`voice.md`](voice.md). While the setting is on, the plugin adds it to the end of an agent's system prompt. A run gets it when its runner invokes the permitted prompt hook and sends the prompt that results; a resumed CLI session that sends its prompt only at its start, and the other runs below, don't ("Where the guide doesn't reach"). It is on until a person turns it off in Clawtrate's Settings, Conversation, "Bot voice". Why it works this way is in [the research note](../../docs/research/bot-voice.md).

## Turning it on for a gateway

It is built and checked against OpenClaw 2026.10.6, the version `docs/decisions.md` pins, and 2026.11.10.

The desktop app carries it, packed from its release's own commit (`apps/desktop/packaging/carried-plugins.ts`), and installs it on a gateway on the same computer through the gateway's own methods: staged off, checked against the copy the app carries, given its one grant, and only then turned on (`packages/core/src/plugin-install.ts`, `docs/design/plugins-install.md`). Nobody runs a command or edits a config for it.

Its one grant is `plugins.entries.clawtrate-voice.hooks.allowConversationAccess: true`, which OpenClaw requires before it registers `before_prompt_build` for a plugin it didn't bundle. Clawtrate writes it when it installs the plugin, and removes it when the plugin is taken off. The plugin reads nothing from the conversation. It only returns the guide. A config with `allowPromptInjection: false` for this plugin still blocks the hook, and the only other sign of that is a warning in the gateway's log.

On a development gateway, `pnpm dev-gateway start --instance <name> --with-plugin clawtrate-voice` loads it from the checkout with its grant, and `--install-plugin clawtrate-voice` installs it the way the app does (`docs/development/dev-gateway.md`).

Until both settings permit it, the plugin's methods still answer. `get` reports each setting under `hook.settings`, and `hook.state` names the first that blocks it (`prompt-injection-off` or `needs-conversation-access`). Settings names both and says which blocks it.

## Where the guide doesn't reach

The gateway runs the prompt hook in its embedded and CLI runners only, so the guide doesn't reach (findings 9 and 10 of the research note):

- a bot on a CLI backend with `systemPromptWhen: "never"`, or with no option to pass a system prompt;
- a resumed session on a CLI backend that sends the system prompt only at a session's start (`"first"`, the default), until that session starts anew;
- raw model runs (`modelRun` or `promptMode: "none"`), settled-tool finalization, side questions and control operations;
- a session bound to an outside agent harness (ACP).

## Gateway methods

| Method                | Scope | What                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawtrate-voice.get` | read  | `{ plugin, version, on, changed, hook: { state, settings, lastRanAt }, guide }`. `changed` is `null` while nobody has changed it. `hook.state` is `allowed`, `needs-conversation-access` or `prompt-injection-off`, from the config the plugin was loaded with: the first setting that blocks it. `hook.settings` is `{ allowPromptInjection, allowConversationAccess }`, whether each permits the hook. `lastRanAt` is when the hook last ran in this process |
| `clawtrate-voice.set` | write | `{ on }`: true or false. Answers as `get` does. Refused unless it comes from a person's own connection, so a bot's turn can't change it                                                                                                                                                                                                                                                                                                                        |

After a change the plugin sends `plugin.clawtrate-voice.changed` at `operator.read`, with an empty payload, so every other connection reads the setting again. The setting is one row in the gateway's database (`on`, when, and a SHA-256 of the device that changed it).

## Tests

```sh
pnpm exec vitest run plugins/clawtrate-voice
pnpm e2e e2e/bot-voice.spec.ts   # F-527, on the run's development gateway
```
