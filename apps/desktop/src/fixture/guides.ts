// "How bots work in Clawtrate": the bots' guides as the gateway's files hold them (core guides.ts).
//
//   (none)         no bot has the section, and this device answered before (the rail card stays hidden)
//   guides=offer   no bot has it, and this device has no answer: the rail card is offered
//   guides=added   every bot has this version
//   guides=mixed   Juniper current, Marlow older, Otto changed outside Clawtrate, Pip removed
//                  outside Clawtrate, Quartermaster not added
//   guides=odd     as another device sees it: Marlow older, which this device didn't add;
//                  Otto's markers out of shape; Quartermaster's instructions long
//   guides=voice   Juniper added, the rest not, and the voice plugin adds its own guide
//   guides=fail    the read fails
//   guidesave=fail a change writes nothing: every file kept changing while it was written
//
// A change applies to the fixture's files as the client applies it to a gateway's, and answers
// with what they hold afterwards.

import {
  GUIDES_LONG_CHARS,
  GUIDES_SECTION,
  type BotGuidesAnswer,
  type BridgeCommand,
  type GatewayStamp,
  type GuideFolder,
  type GuidesRecord,
  type GuideState,
} from "@clawtrate/core";

const BOTS = ["main", "marlow", "otto", "pip", "quartermaster"];

export const guidesParam = (params: URLSearchParams) =>
  params.get("guidesave") === "fail"
    ? `${params.get("guides") ?? ""}+savefail`
    : params.get("guides");

export function guidesCommands(
  given: string | null,
  canAdmin: () => boolean,
  stampNow: () => GatewayStamp,
) {
  const saveFails = given?.endsWith("+savefail") === true;
  const param = saveFails ? given!.slice(0, -"+savefail".length) || null : given;
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
      param === "added"
        ? "current"
        : param === "mixed" || param === "odd"
          ? mixed[bot]!
          : param === "voice" && bot === "main"
            ? "current"
            : "none",
    ]),
  );
  // Another device's view: Pip's section isn't on this device's record, so it reads not added.
  if (param === "odd") states.set("pip", "none");
  let record: GuidesRecord | null =
    param === "offer" || param === "voice"
      ? null
      : param === "added"
        ? { bots: BOTS, newBots: true }
        : param === "mixed"
          ? { bots: ["main", "marlow", "otto", "pip"], newBots: true }
          : param === "odd"
            ? { bots: ["main"], newBots: false }
            : { bots: [], newBots: false };
  const voicePlugin = param === "voice";
  const folders = (): GuideFolder[] =>
    BOTS.map((bot) => ({
      bots: [bot],
      state: states.get(bot)!,
      replaceable: states.get(bot) === "changed" && param !== "odd",
      length: param === "odd" && bot === "quartermaster" ? GUIDES_LONG_CHARS - 1_000 : 1_200,
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
    if (saveFails)
      return answer([
        "otto: AGENTS.md kept changing while Clawtrate wrote it, so it was left as it is.",
      ]);
    if (change.action === "add") {
      for (const bot of change.bots)
        if (["none", "removed", "older"].includes(states.get(bot)!)) states.set(bot, "current");
      record = {
        bots: [...new Set([...(record?.bots ?? []), ...change.bots])],
        newBots: change.newBots,
      };
    } else if (change.action === "replace") {
      if (states.get(change.bot) === "changed" && param !== "odd")
        states.set(change.bot, "current");
    } else if (change.action === "remove") {
      for (const bot of BOTS)
        if (states.get(bot) === "current" || states.get(bot) === "older") states.set(bot, "none");
      record = { bots: [], newBots: false };
    }
    return answer();
  };
}
