// The plain voice setting: whether every bot on the gateway is told to write
// plainly, with no em dashes (plugins/clawtrate-voice). Read and changed only
// through the plugin, and shown as the plugin answers.

import { asRecord } from "./mapping.ts";

export const VOICE_GET_METHOD = "clawtrate-voice.get";
const VOICE_SET_METHOD = "clawtrate-voice.set";

/**
 * `plugin: false` when the gateway's hello does not list the plugin's
 * methods. `reachesBots` is false when the gateway's config keeps the plugin's
 * prompt hook from running, so the guide reaches no bot whatever `plain` says.
 */
export type VoiceSetting =
  { plugin: false } | { plugin: true; plain: boolean; reachesBots: boolean };

type Request = (method: string, params: unknown) => Promise<unknown>;

function setting(value: unknown): VoiceSetting {
  const answer = asRecord(value);
  if (typeof answer?.plain !== "boolean" || typeof answer.reachesBots !== "boolean")
    throw new Error("The gateway did not say whether the plain voice is on.");
  return { plugin: true, plain: answer.plain, reachesBots: answer.reachesBots };
}

/** `loaded`: the gateway's hello listed VOICE_GET_METHOD. */
export async function readVoice(request: Request, loaded: boolean): Promise<VoiceSetting> {
  if (!loaded) return { plugin: false };
  return setting(await request(VOICE_GET_METHOD, {}));
}

/** The setting as the plugin reads it back after saving it. */
export async function setVoice(request: Request, plain: boolean): Promise<VoiceSetting> {
  return setting(await request(VOICE_SET_METHOD, { plain }));
}
