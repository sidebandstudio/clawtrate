# clawtrate-voice

Asks the bots on a gateway to talk to their person plainly and kindly, with no em dashes, and tells them where they live. The voice guide is [`voice.md`](voice.md). The task guide, [`where.md`](where.md), says what Clawtrate's words mean (a task is a separate conversation with the bot, never a to-do item), that a bot asked to put something in a task starts one with the gateway's `sessions_spawn`, and that it asks first when it only thinks a task would help. Each guide has its own setting. While a setting is on, the plugin adds its guide to the end of an agent's system prompt. A run gets it when its runner invokes the permitted prompt hook and sends the prompt that results; a resumed CLI session that sends its prompt only at its start, and the other runs below, don't ("Where the guide doesn't reach"). Each is on until a person turns it off in Clawtrate's Settings, Conversation, "Bot voice" and "Task guide". Why it works this way is in [the research note](../../docs/research/bot-voice.md).

## Turning it on for a gateway

It is built and checked against OpenClaw 2026.10.6, the version `docs/decisions.md` pins.

These steps are for the gateway's owner. Clawtrate never writes the gateway's config, at install or any other time: letting a hook run is a grant that only the owner gives, because a conversation hook can receive conversation data. (The development gateway in this repository sets it for its own throwaway instances, from the plugin's `clawtrate-dev-contract.json`.)

1. Name the profile the gateway runs with, and clear any path a shell carries over. `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` win over `--profile`, so with either set, a write can land in another gateway's config.

   ```bash
   profile="clawtrate"   # the profile your gateway runs with
   unset OPENCLAW_CONFIG_PATH OPENCLAW_STATE_DIR
   openclaw --profile "$profile" config file
   ```

   Stop and check that the path it prints is the config of the gateway you mean. If it isn't, don't go on. Run every command below in the same shell, with the same `--profile "$profile"`.

2. Install the plugin into that profile from a checkout of Clawtrate. `plugins install` writes the profile's config and enables the plugin, so run it only after the check in step 1.

   ```bash
   checkout="/path/to/clawtrate"   # your checkout of Clawtrate
   openclaw --profile "$profile" plugins install --link "$checkout/plugins/clawtrate-voice"
   ```

3. Let its hook run. OpenClaw registers `before_prompt_build` for a plugin it didn't bundle only when both settings under `plugins.entries.clawtrate-voice.hooks` permit it. It checks `allowPromptInjection` first: absent is fine, `false` blocks the hook, and the only other sign of that is a warning in the gateway's log. Then `allowConversationAccess`, which must be `true`.

   First check the path again, on its own:

   ```bash
   openclaw --profile "$profile" config file
   ```

   Stop and check that it is still the config of the gateway you mean. Only then grant the hook:

   ```bash
   openclaw --profile "$profile" config set plugins.entries.clawtrate-voice.hooks.allowConversationAccess true
   ```

   Then read back what the hook has:

   ```bash
   openclaw --profile "$profile" config get plugins.entries.clawtrate-voice.hooks
   ```

   It should show `allowConversationAccess: true` and no `allowPromptInjection: false`. That is this part of the config:

   ```json
   {
     "plugins": {
       "entries": { "clawtrate-voice": { "hooks": { "allowConversationAccess": true } } }
     }
   }
   ```

   The plugin reads nothing from the conversation. It only returns the guide.

4. Restart the gateway. The guide is added from the next system prompt the gateway builds for each bot.

Until both settings permit it, the plugin's methods still answer. `get` reports each setting under `hook.settings`, and `hook.state` names the first that blocks it (`prompt-injection-off` or `needs-conversation-access`). Settings names both, says which blocks it, and links here.

## Updating it

The task guide came with version 0.2.0. A gateway that loads the plugin from a checkout (`plugins install --link`) gets a newer version's files when that checkout has them, but keeps running the copy it loaded until the plugin is loaded again. Clawtrate does that by itself: after it connects with admin access, if the plugin the gateway runs has no task guide, it asks the gateway once to load it again (`plugins.reload`). That writes nothing to the gateway's config and keeps the hook's setting, and the bots get the guide from their next prompt. Settings then shows "Task guide".

If the files are still the older version, or Clawtrate's connection doesn't have admin access, Settings says the plugin is older and the bots aren't told what a task is. Update the checkout the plugin was installed from, and Clawtrate loads it the next time it connects with admin access. A plugin installed as a copy, without `--link`, is updated by installing it again from a newer checkout.

## Where the guide doesn't reach

The gateway runs the prompt hook in its embedded and CLI runners only, so the guide doesn't reach (findings 9 and 10 of the research note):

- a bot on a CLI backend with `systemPromptWhen: "never"`, or with no option to pass a system prompt;
- a resumed session on a CLI backend that sends the system prompt only at a session's start (`"first"`, the default), until that session starts anew;
- raw model runs (`modelRun` or `promptMode: "none"`), settled-tool finalization, side questions and control operations;
- a session bound to an outside agent harness (ACP).

## Gateway methods

| Method                | Scope | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawtrate-voice.get` | read  | `{ plugin, version, on, changed, hook: { state, settings, lastRanAt }, guide, where: { on, changed, guide } }`. `where` is the task guide's setting and text (from 0.2.0). `changed` is `null` while nobody has changed it. `hook.state` is `allowed`, `needs-conversation-access` or `prompt-injection-off`, from the config the plugin was loaded with: the first setting that blocks it. `hook.settings` is `{ allowPromptInjection, allowConversationAccess }`, whether each permits the hook. `lastRanAt` is when the hook last ran in this process |
| `clawtrate-voice.set` | write | `{ on }`: true or false, for the voice guide, or `{ section: "where", on }` for the task guide. Answers as `get` does. Refused unless it comes from a person's own connection, so a bot's turn can't change it                                                                                                                                                                                                                                                                                                                                           |

After a change the plugin sends `plugin.clawtrate-voice.changed` at `operator.read`, with an empty payload, so every other connection reads the setting again. Each setting is one row in the gateway's database (`on`, when, and a SHA-256 of the device that changed it).

## Tests

```sh
pnpm exec vitest run plugins/clawtrate-voice
pnpm e2e e2e/bot-voice.spec.ts   # F-527, on the run's development gateway
```
