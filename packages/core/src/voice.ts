// Bot voice: whether Clawtrate's voice guide is added to the bots' system
// prompts, as plugins/clawtrate-voice reads it back (`clawtrate-voice.get`,
// operator.read; `.set`, operator.write). The client never rewrites what a
// bot wrote; the plugin changes what the bot is told.

import { asRecord } from "./mapping.ts";
import type { GatewayStamp } from "./types.ts";

/** Whether the gateway let the plugin's prompt hook register (plugins/clawtrate-voice/index.js). */
export type VoiceHook = "allowed" | "needs-conversation-access" | "prompt-injection-off";
const isHook = (value: unknown): value is VoiceHook =>
  value === "allowed" || value === "needs-conversation-access" || value === "prompt-injection-off";
/** Both must permit the hook: `allowPromptInjection` unless false, `allowConversationAccess` when true. */
export type VoiceHookSettings = { allowPromptInjection: boolean; allowConversationAccess: boolean };
const hookSettings = (value: unknown): VoiceHookSettings | null => {
  const settings = asRecord(value);
  return typeof settings?.allowPromptInjection === "boolean" &&
    typeof settings.allowConversationAccess === "boolean"
    ? {
        allowPromptInjection: settings.allowPromptInjection,
        allowConversationAccess: settings.allowConversationAccess,
      }
    : null;
};
/** The longest guide the client shows. */
const GUIDE_MAX = 8192;

export const VOICE_GET = "clawtrate-voice.get";
/** The plugin's id on the gateway, as `plugins.reload` names it. */
export const VOICE_PLUGIN = "clawtrate-voice";
/** The first version with the where-you-live guide; an older one reports no `where`. */
export const WHERE_SINCE = "0.2.0";
/** The plugin's event after a change, empty: readers read again (plugins/clawtrate-voice). */
export const VOICE_CHANGED_EVENT = "plugin.clawtrate-voice.changed";

export type BotVoice =
  /** The gateway has no voice plugin: its hello doesn't list the plugin's methods, or it doesn't know them. */
  | { status: "missing" }
  /**
   * The gateway refused the read for a scope this connection doesn't hold. `advertised` says
   * whether the hello lists the plugin's methods (a plugin of another version, asking for
   * more), or null when the gateway sent no list, so the plugin may as well be absent.
   */
  | { status: "refused"; advertised: true | null; message: string }
  | {
      status: "read";
      on: boolean;
      /** When a person last changed it, or null while it is on by default. */
      changedAt: number | null;
      hook: VoiceHook;
      /**
       * Whether each of the two settings under `plugins.entries.clawtrate-voice.hooks` permits
       * the hook, or null from a plugin that doesn't report them.
       */
      hookSettings: VoiceHookSettings | null;
      /** When the hook last ran in the gateway's process, or null since it started. */
      lastRanAt: number | null;
      /** The guide the plugin adds to the bots' system prompts while it is on. */
      guide: string;
      /** The plugin's version, as it reports it, or null when it doesn't. */
      version: string | null;
      /**
       * The where-you-live guide, with its own setting, or null from a plugin older than
       * `WHERE_SINCE`, whose bots aren't told what a task is.
       */
      where: { on: boolean; changedAt: number | null; guide: string } | null;
    };

/**
 * An answer as the client gives it, stamped with where it was read (`GatewayStamp`): the
 * gateway's identity, null when that isn't known, and the host's target then.
 */
export type BotVoiceAnswer = BotVoice & { stamp: GatewayStamp };

type Request = (method: string, params: unknown) => Promise<unknown>;

const time = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);

/** The plugin's answer, or an error when it is not one. */
export function parseVoice(value: unknown): BotVoice & { status: "read" } {
  const voice = asRecord(value);
  const hook = asRecord(voice?.hook);
  const where = asRecord(voice?.where);
  if (
    voice?.plugin !== "clawtrate-voice" ||
    typeof voice.on !== "boolean" ||
    typeof voice.guide !== "string" ||
    voice.guide.length > GUIDE_MAX ||
    !isHook(hook?.state) ||
    (voice.where !== undefined &&
      (typeof where?.on !== "boolean" ||
        typeof where.guide !== "string" ||
        where.guide.length > GUIDE_MAX))
  )
    throw new Error("The gateway's voice plugin gave an answer Clawtrate can't read.");
  return {
    status: "read",
    on: voice.on,
    changedAt: time(asRecord(voice.changed)?.at),
    hook: hook!.state as VoiceHook,
    hookSettings: hookSettings(hook!.settings),
    lastRanAt: time(hook!.lastRanAt),
    guide: voice.guide,
    version: typeof voice.version === "string" && voice.version.length <= 64 ? voice.version : null,
    where: where
      ? {
          on: where.on as boolean,
          changedAt: time(asRecord(where.changed)?.at),
          guide: where.guide as string,
        }
      : null,
  };
}

const unknownMethod = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).startsWith("unknown method");
const missingScope = (error: unknown) =>
  asRecord(asRecord(error)?.details)?.code === "MISSING_SCOPE";

/**
 * Read the setting. `advertised` is whether the hello's `features.methods` lists
 * `clawtrate-voice.get`, or null when the gateway sent no list. A gateway without the plugin answers "unknown method" to an admin and "missing scope:
 * operator.admin" to anyone else (OpenClaw 2026.10.6), so a refusal alone can't say the plugin
 * is absent: the hello's list decides that, and asks for nothing more.
 */
export async function readVoice(request: Request, advertised: boolean | null): Promise<BotVoice> {
  if (advertised === false) return { status: "missing" };
  try {
    return parseVoice(await request(VOICE_GET, {}));
  } catch (error) {
    if (unknownMethod(error)) return { status: "missing" };
    if (missingScope(error))
      return {
        status: "refused",
        advertised: advertised === null ? null : true,
        message: error instanceof Error ? error.message : String(error),
      };
    throw error;
  }
}

/** Which guide a change is for: the voice guide, or the where-you-live guide. */
export type VoiceSection = "voice" | "where";

/** Turn a guide on or off; answers with the setting as the gateway stored it. */
export async function setVoice(
  request: Request,
  on: boolean,
  section: VoiceSection = "voice",
): Promise<BotVoice> {
  return parseVoice(
    await request("clawtrate-voice.set", section === "voice" ? { on } : { section, on }),
  );
}

/**
 * Bring an older voice plugin's where-you-live guide to the bots without a Terminal step
 * (admin): when the plugin the gateway has loaded reports no `where`, ask the gateway to load
 * it again from its files (`plugins.reload`, which writes no config and keeps the hook's
 * grant). A plugin linked to a checkout that has the newer files then has the guide at once;
 * one whose files are still older stays as it was, and Settings says so. Answers whether a
 * reload was asked for and what the gateway said.
 */
export async function updateVoicePlugin(
  request: Request,
  voice: BotVoice,
): Promise<"current" | "reloaded" | { failed: string }> {
  if (voice.status !== "read" || voice.where !== null) return "current";
  try {
    await request("plugins.reload", { plugins: [{ pluginId: VOICE_PLUGIN }] });
    return "reloaded";
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}
