// Settings, Conversation, "Bot voice": what the gateway's voice plugin answers.
//
//   voice=on        on, by default; nobody changed it (the default)
//   voice=off       a person turned it off
//   voice=blocked   on, but the gateway hasn't let the plugin's hook register
//                   (allowConversationAccess isn't true)
//   voice=bothoff   blocked by both settings (allowPromptInjection false as well)
//   voice=missing   the gateway has no voice plugin
//   voice=refused   the hello lists the plugin, and the gateway asks for admin to read it
//   voice=unclear   the gateway asks for admin to read it, and sent no list of methods
//   voice=fail      the read fails
//   voicesave=fail  a change is refused
//   voicesave=lost  a change is stored, and its answer is lost
//   voicesave=slow  a change is stored, and its answer waits for `window.voiceSaveRelease`;
//                   `window.voiceSavesAnswered` counts the answers that have reached the page
//   voicesave=slowlost  as slow, and the answer that comes is lost
//
// `window.voiceFails` makes every read fail from then on, and `window.voiceReadsHeld` keeps
// reads waiting until it is false again.
//
// Each gateway keeps its own setting, starting from the one these name, and keeps it across
// reconnects. Every answer names the gateway connected when it is given; a change made for
// another gateway is refused, as the client refuses it.

import {
  sameStamp,
  type BotVoice,
  type BotVoiceAnswer,
  type BridgeCommand,
  type GatewayStamp,
} from "@clawtrate/core";
import guide from "../../../../plugins/clawtrate-voice/voice.md?raw";

export type VoiceParams = { voice: string | null; save: string | null };
export const voiceParams = (params: URLSearchParams): VoiceParams => ({
  voice: params.get("voice"),
  save: params.get("voicesave"),
});

export function voiceCommands(
  params: VoiceParams,
  canWrite: () => boolean,
  stampNow: () => GatewayStamp,
  now: number,
) {
  const seeded: BotVoice = {
    status: "read",
    on: params.voice !== "off",
    changedAt: params.voice === "off" ? now - 3 * 60 * 60_000 : null,
    hook:
      params.voice === "blocked"
        ? "needs-conversation-access"
        : params.voice === "bothoff"
          ? "prompt-injection-off"
          : "allowed",
    hookSettings: {
      allowPromptInjection: params.voice !== "bothoff",
      allowConversationAccess: params.voice !== "blocked" && params.voice !== "bothoff",
    },
    lastRanAt: params.voice === "blocked" || params.voice === "bothoff" ? null : now - 5 * 60_000,
    guide: guide.trim(),
  };
  const seed: BotVoice =
    params.voice === "missing"
      ? { status: "missing" }
      : params.voice === "refused" || params.voice === "unclear"
        ? {
            status: "refused",
            advertised: params.voice === "refused" ? true : null,
            message: "missing scope: operator.admin",
          }
        : seeded;
  // The setting each gateway holds, by its identity.
  const voices = new Map<string | null, BotVoice>();
  const held = (gatewayId: string | null) => voices.get(gatewayId) ?? seed;
  const store = (gatewayId: string | null, on: boolean) => {
    const voice = held(gatewayId);
    if (voice.status === "read") voices.set(gatewayId, { ...voice, on, changedAt: Date.now() });
  };
  // `window.voiceServerSet(on)`: another device changes the setting on the connected gateway.
  (globalThis as { voiceServerSet?: (on: boolean) => void }).voiceServerSet = (on) =>
    store(stampNow().gatewayId, on);
  return async (
    command: Extract<BridgeCommand, { type: "readBotVoice" | "setBotVoice" }>,
  ): Promise<BotVoiceAnswer> => {
    const window = globalThis as {
      voiceFails?: boolean;
      voiceReadsHeld?: boolean;
      voiceSaveRelease?: boolean;
      voiceSavesAnswered?: number;
    };
    const until = (ready: () => boolean) =>
      new Promise<void>((resolve) => {
        const wait = setInterval(() => {
          if (!ready()) return;
          clearInterval(wait);
          resolve();
        }, 20);
      });
    if (command.type === "readBotVoice" && window.voiceReadsHeld === true)
      await until(() => window.voiceReadsHeld !== true);
    // `window.voiceFails`: a check makes the gateway stop answering reads after it opened.
    const failing = window.voiceFails === true;
    if (params.voice === "fail" || (failing && command.type === "readBotVoice"))
      throw new Error("The gateway did not answer.");
    if (command.type === "readBotVoice") {
      const stamp = stampNow();
      return { ...held(stamp.gatewayId), stamp };
    }
    if (!canWrite()) throw new Error("Changing how the bots talk needs write access.");
    if (!sameStamp(command.stamp, stampNow()))
      throw new Error("This change was made for another gateway, so nothing was sent.");
    if (params.save === "fail") throw new Error("missing scope: operator.write");
    store(command.stamp.gatewayId, command.on);
    const answer = { ...held(command.stamp.gatewayId), stamp: command.stamp };
    if (params.save === "slow" || params.save === "slowlost") {
      await until(() => window.voiceSaveRelease === true);
      // Counted a task later, once the page's own handlers for this answer have run.
      setTimeout(() => {
        window.voiceSavesAnswered = (window.voiceSavesAnswered ?? 0) + 1;
      }, 0);
    }
    if (params.save === "lost" || params.save === "slowlost")
      throw new Error("The gateway did not answer in time.");
    return answer;
  };
}
