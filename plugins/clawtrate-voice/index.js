// clawtrate-voice: asks the bots on the gateway to talk to their person in a
// plain, friendly voice and never use an em dash, and tells them where they
// live: what Clawtrate's words mean and how to move work into a task. The two
// guides are voice.md and where.md beside this file, each with its own setting;
// while a setting is on, the plugin adds its guide to an agent's system prompt
// when a runner invokes the prompt hook, and a run gets it when that prompt is
// sent. Each is on until a person turns it off. Where the gateway doesn't run the hook, or a CLI backend
// doesn't send the system prompt, the guides don't reach the bot
// (docs/research/bot-voice.md, findings 9 and 10).
//
//   before_prompt_build  returns the guides that are on as `appendSystemContext`. OpenClaw
//                        registers it only when the gateway's config sets
//                        plugins.entries.clawtrate-voice.hooks.allowConversationAccess
//                        to true. It reads nothing from the conversation.
//   gateway methods      clawtrate-voice.get (operator.read); .set (operator.write)
//   events               plugin.clawtrate-voice.changed (operator.read), empty, after a
//                        change: other devices read again
//   records              one row per guide in the gateway's database: { on, changedAt, changedBy }
//
// Why this hook and this scope: docs/research/bot-voice.md.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PLUGIN_ID = "clawtrate-voice";
/** The plugin's version, as `get` reports it; package.json says the same. */
export const PLUGIN_VERSION = "0.2.0";
const guide = (file) => readFileSync(new URL(file, import.meta.url), "utf8").trim();
/** The voice guide, added to the bots' system prompts while its setting is on. */
export const GUIDE = guide("./voice.md");
/** The "where you live" guide: Clawtrate's words, and moving work into a task. */
export const WHERE_GUIDE = guide("./where.md");
const NAMESPACE = "voice";
/** Each guide's row in the store: the voice guide's keeps the name it had before there were two. */
const SETTINGS = { voice: "setting", where: "where" };
const GUIDES = { voice: GUIDE, where: WHERE_GUIDE };
/**
 * The host can load this module more than once (one copy for the hook,
 * another for the gateway methods), so when the hook last ran lives in one
 * process-wide slot.
 */
const STATE_KEY = Symbol.for("clawtrate-voice.state.v1");

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Each of the two settings the prompt hook needs, under
 * `plugins.entries.clawtrate-voice.hooks` in the config the plugin was loaded
 * with: whether it permits the hook. OpenClaw decides it this way for a plugin
 * it did not bundle: `allowPromptInjection` permits it unless it is false, and
 * `allowConversationAccess` only when it is true.
 */
export function hookSettings(config) {
  const hooks = config?.plugins?.entries?.[PLUGIN_ID]?.hooks;
  return {
    allowPromptInjection: hooks?.allowPromptInjection !== false,
    allowConversationAccess: hooks?.allowConversationAccess === true,
  };
}

/** The first setting that blocks the hook, in the order OpenClaw checks them, or allowed. */
export function hookState(config) {
  const settings = hookSettings(config);
  if (!settings.allowPromptInjection) return "prompt-injection-off";
  if (!settings.allowConversationAccess) return "needs-conversation-access";
  return "allowed";
}

/**
 * A change needs a person's own connection: a direct operator request over
 * the gateway's socket, not an in-process call from a bot's turn
 * (docs/research/bot-self-management.md, finding 6).
 */
export const isDirectOperator = (opts) =>
  opts.acceptsSerializedJson === true &&
  opts.client?.connect?.role === "operator" &&
  !opts.client?.internal?.syntheticClient;

/** The setting as `get` and `set` report it. No row means nobody changed it: on. */
export function settingView(row) {
  const stored = isPlainObject(row) && typeof row.on === "boolean";
  return {
    on: stored ? row.on : true,
    changed: stored ? { at: Number.isSafeInteger(row.changedAt) ? row.changedAt : null } : null,
  };
}

/** Register the plugin on `api`. Returns a handle for tests. */
export function createVoice(api, options = {}) {
  const now = options.now ?? Date.now;
  const slots = options.slots ?? globalThis;
  const shared = (slots[STATE_KEY] ??= { lastRanAt: null, emit: null });
  const store =
    options.store ??
    api.runtime.state.openKeyedStore({ namespace: NAMESPACE, retention: "retained" });
  const read = async (section = "voice") => settingView(await store.lookup(SETTINGS[section]));

  // Each prompt the hook is asked for: the guides that are on, nothing while both are off. A
  // failed read throws, and the gateway logs it and leaves the prompt as it was.
  async function onPromptBuild() {
    const [voice, where] = await Promise.all([read("voice"), read("where")]);
    shared.lastRanAt = now();
    const text = [voice.on && GUIDE, where.on && WHERE_GUIDE].filter(Boolean).join("\n\n");
    return text ? { appendSystemContext: text } : undefined;
  }
  api.on?.("before_prompt_build", onPromptBuild);

  const view = async () => ({
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    ...(await read()),
    hook: {
      state: hookState(api.config),
      settings: hookSettings(api.config),
      lastRanAt: shared.lastRanAt,
    },
    guide: GUIDE,
    where: { ...(await read("where")), guide: WHERE_GUIDE },
  });

  const refuse = (opts, reason, message) =>
    opts.respond(false, undefined, { code: "INVALID_REQUEST", message, details: { reason } });

  api.registerGatewayMethod?.(
    `${PLUGIN_ID}.get`,
    async (opts) => opts.respond(true, await view()),
    { scope: "operator.read" },
  );

  api.registerGatewayMethod?.(
    `${PLUGIN_ID}.set`,
    async (opts) => {
      if (!isDirectOperator(opts))
        return refuse(opts, "operator-required", "Only a person's own connection can change this.");
      const params = isPlainObject(opts.params) ? opts.params : {};
      const on = params.on;
      if (typeof on !== "boolean") return refuse(opts, "invalid", "on must be true or false.");
      // Which guide: the voice guide unless `section` names the other.
      const section = params.section === undefined ? "voice" : params.section;
      if (!Object.hasOwn(GUIDES, section))
        return refuse(opts, "invalid", 'section must be "voice" or "where".');
      const device = opts.client?.connect?.device?.id;
      await store.register(SETTINGS[section], {
        on,
        changedAt: now(),
        changedBy:
          typeof device === "string" && device
            ? `sha256:${createHash("sha256").update(device).digest("hex")}`
            : null,
      });
      // The write is committed: other devices are told now, whatever the read-back does.
      // Empty, so nothing about who changed it goes out.
      shared.emit?.("changed", {}, { scope: "operator.read" });
      opts.respond(true, await view());
    },
    { scope: "operator.write" },
  );

  // The gateway's event channel, for the change event.
  api.registerService?.({
    id: `${PLUGIN_ID}-events`,
    start(ctx) {
      const events = ctx?.gatewayEvents;
      shared.emit = events ? (name, payload, opts) => events.emit(name, payload, opts) : null;
    },
    stop() {
      shared.emit = null;
    },
  });

  return { onPromptBuild, view, shared };
}

export default {
  id: PLUGIN_ID,
  name: "Clawtrate voice",
  description:
    "Asks the bots to talk in a plain, friendly voice with no em dashes, and tells them what Clawtrate's words mean and how to move work into a task, in the system prompt of each run whose runner invokes its hook, until a person turns each off. Not made by or affiliated with OpenClaw.",
  register(api) {
    createVoice(api);
  },
};
