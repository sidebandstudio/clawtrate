// clawtrate-voice: a short voice guide added to every bot's system prompt, so
// each bot writes to its person plainly and with no em dashes. A person turns
// it off and on from Clawtrate's Settings. README.md beside this file says
// what it adds and what it needs.
//
//   before_prompt_build   appends GUIDE to the system prompt while the setting is on
//   gateway methods       clawtrate-voice.get (operator.read); .set (operator.admin)
//   state                 one retained row in the gateway's plugin state

export const PLUGIN_ID = "clawtrate-voice";
const KEY = "voice";

export const GUIDE = [
  "How to write to your person:",
  "- Talk plainly and warmly, the way a helpful friend would. Use everyday words and short sentences.",
  "- Skip stiff assistant phrases, filler and hype.",
  "- Never use an em dash (\u2014). Where you would, use a comma, a period or parentheses instead.",
].join("\n");

class Refusal extends Error {}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** A person's own operator connection, not a bot calling the gateway (as in clawtrate-bots). */
const isDirectOperator = (opts) =>
  opts.acceptsSerializedJson === true &&
  opts.client?.connect?.role === "operator" &&
  !opts.client?.internal?.syntheticClient;

/**
 * Whether the gateway lets this plugin's prompt hook run: a plugin that is not
 * bundled needs `hooks.allowConversationAccess: true`, and
 * `hooks.allowPromptInjection: false` blocks it.
 */
export function hookAllowed(config) {
  const hooks = config?.plugins?.entries?.[PLUGIN_ID]?.hooks;
  return hooks?.allowConversationAccess === true && hooks?.allowPromptInjection !== false;
}

export function createVoice(api, options = {}) {
  const store =
    options.store ??
    api.runtime.state.openKeyedStore({ namespace: "settings", retention: "retained" });

  // On until a person turns it off.
  const plain = async () => (await store.lookup(KEY))?.plain !== false;

  api.on("before_prompt_build", async () =>
    (await plain()) ? { appendSystemContext: GUIDE } : undefined,
  );

  const answer = async (opts) => ({
    plain: await plain(),
    reachesBots: hookAllowed(opts.context?.getRuntimeConfig?.() ?? api.config),
    guide: GUIDE,
  });

  const methods = {
    get: ["operator.read", (opts) => answer(opts)],
    set: [
      "operator.admin",
      async (opts) => {
        if (!isDirectOperator(opts))
          throw new Refusal("Only a person's own Clawtrate connection can change this.");
        const params = isObject(opts.params) ? opts.params : {};
        if (Object.keys(params).join() !== "plain" || typeof params.plain !== "boolean")
          throw new Refusal("Send exactly { plain: true } or { plain: false }.");
        await store.register(KEY, { plain: params.plain });
        return answer(opts);
      },
    ],
  };

  for (const [name, [scope, handler]] of Object.entries(methods)) {
    api.registerGatewayMethod(
      `${PLUGIN_ID}.${name}`,
      async (opts) => {
        try {
          opts.respond(true, await handler(opts));
        } catch (error) {
          if (!(error instanceof Refusal)) throw error;
          opts.respond(false, undefined, { code: "INVALID_REQUEST", message: error.message });
        }
      },
      { scope },
    );
  }
}

export default {
  id: PLUGIN_ID,
  name: "Clawtrate voice",
  description:
    "Tells every bot to write to its person plainly, with no em dashes, unless a person turns it off. Not made by or affiliated with OpenClaw.",
  register(api) {
    createVoice(api);
  },
};
