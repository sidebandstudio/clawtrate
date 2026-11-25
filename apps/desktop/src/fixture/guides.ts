// "How bots work in Clawtrate": the bots' guides as the gateway's files hold them (core guides.ts).
//
//   (none)         no bot has the section, and this device answered before (the rail card stays hidden)
//   guides=offer   no bot has it, and this device has no answer: the rail card is offered
//   guides=added   every bot has this version
//   guides=mixed   Juniper current, Marlow older, Otto changed outside Clawtrate, Pip removed
//                  outside Clawtrate, Quartermaster not added
//   guides=voice   none added, and the voice plugin adds its own guide
//   guides=fail    the read fails
//
// A change applies to the fixture's files as the client applies it to a gateway's, and answers
// with what they hold afterwards.

import {
  GUIDES_SECTION,
  type BotGuidesAnswer,
  type BridgeCommand,
  type GatewayStamp,
  type GuideFolder,
  type GuidesRecord,
  type GuideState,
} from "@clawtrate/core";

const BOTS = ["main", "marlow", "otto", "pip", "quartermaster"];

export const guidesParam = (params: URLSearchParams) => params.get("guides");

export function guidesCommands(
  param: string | null,
  canAdmin: () => boolean,
  stampNow: () => GatewayStamp,
) {
  const mixed: Record<string, GuideState> = {
    main: "current",
    marlow: "older",
    otto: "changed",
    pip: "removed",
    quartermaster: "none",
  };
  const states = new Map<string, GuideState>(
    BOTS.map((bot) => [
      bot,
      param === "added" ? "current" : param === "mixed" ? mixed[bot]! : "none",
    ]),
  );
  let record: GuidesRecord | null =
    param === "offer" || param === "voice"
      ? null
      : param === "added"
        ? { bots: BOTS, newBots: true }
        : param === "mixed"
          ? { bots: ["main", "marlow", "otto", "pip"], newBots: true }
          : { bots: [], newBots: false };
  let voicePlugin = param === "voice";
  const folders = (): GuideFolder[] =>
    BOTS.map((bot) => ({
      bots: [bot],
      state: states.get(bot)!,
      changedText:
        states.get(bot) === "changed"
          ? GUIDES_SECTION.replace("Lead with the answer", "Lead with a short joke")
          : null,
      error: null,
    }));
  const answer = (errors: string[] = []): BotGuidesAnswer => ({
    folders: folders(),
    record,
    voicePlugin,
    errors,
    stamp: stampNow(),
  });
  return async (
    command: Extract<BridgeCommand, { type: "readBotGuides" | "changeBotGuides" }>,
  ): Promise<BotGuidesAnswer> => {
    if (param === "fail") throw new Error("The gateway did not answer.");
    if (command.type === "readBotGuides") return answer();
    const { change } = command;
    if (change.action === "decline") {
      record ??= { bots: [], newBots: false };
      return answer();
    }
    if (!canAdmin()) throw new Error("Changing the bots' instructions needs admin access.");
    if (change.action === "add") {
      voicePlugin = false;
      for (const bot of change.bots)
        if (states.get(bot) === "none" || states.get(bot) === "removed") states.set(bot, "current");
      record = {
        bots: [...new Set([...(record?.bots ?? []), ...change.bots])],
        newBots: change.newBots,
      };
    } else if (change.action === "replace") {
      if (states.get(change.bot) === "changed") states.set(change.bot, "current");
    } else if (change.action === "remove") {
      for (const bot of BOTS)
        if (states.get(bot) === "current" || states.get(bot) === "older") states.set(bot, "none");
      record = { bots: [], newBots: false };
    }
    return answer();
  };
}
