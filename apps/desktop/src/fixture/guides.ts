// "How bots work in Clawtrate": the bots' guides as the gateway's files hold them (core guides.ts).
//
//   (none)         no bot has the section, and this device answered before (the rail card stays hidden)
//   guides=offer   no bot has it, and this device has no answer: the rail card is offered
//   guides=added   every bot has this version
//   guides=mixed   Juniper current, Marlow older, Otto changed outside Clawtrate, Pip removed
//                  outside Clawtrate, Quartermaster not added
//   guides=moved   as mixed, but Otto's intact section isn't at the top of its file
//   guides=odd     as another device sees it: Marlow older, which this device didn't add;
//                  Otto's markers out of shape; Quartermaster's instructions long
//   guides=voice   Juniper added, the rest not, and the voice plugin adds its own guide
//   guides=voicenone  none added, no answer yet, and the voice plugin adds its own guide
//   guides=utf8    Otto has the section in a file that isn't plain UTF-8; Marlow's file isn't
//                  either, with no section
//   guides=fail    the read fails
//   guidesave=fail a change writes nothing: every file kept changing while it was written
//   guidesave=race a change writes nothing and reports nothing: the files changed meanwhile
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

export const guidesParam = (params: URLSearchParams) =>
  params.get("guidesave") === "fail" || params.get("guidesave") === "race"
    ? `${params.get("guides") ?? ""}+save${params.get("guidesave")}`
    : params.get("guides");

export function guidesCommands(
  given: string | null,
  canAdmin: () => boolean,
  stampNow: () => GatewayStamp,
) {
  const save = /\+save(fail|race)$/.exec(given ?? "")?.[1] ?? null;
  const saveFails = save === "fail";
  const param = save ? given!.slice(0, -`+save${save}`.length) || null : given;
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
        : param === "mixed" || param === "odd" || param === "moved"
          ? mixed[bot]!
          : (param === "voice" && bot === "main") || (param === "utf8" && bot === "otto")
            ? "current"
            : "none",
    ]),
  );
  // Another device's view: Pip's section isn't on this device's record, so it reads not added.
  if (param === "odd") states.set("pip", "none");
  let record: GuidesRecord | null =
    param === "offer" || param === "voice" || param === "voicenone"
      ? null
      : param === "added"
        ? { bots: BOTS, newBots: true }
        : param === "mixed" || param === "moved"
          ? { bots: ["main", "marlow", "otto", "pip"], newBots: true }
          : param === "odd"
            ? { bots: ["main"], newBots: false }
            : { bots: [], newBots: false };
  const voicePlugin = param === "voice" || param === "voicenone";
  const notUtf8 = (bot: string) => param === "utf8" && (bot === "otto" || bot === "marlow");
  const folders = (): GuideFolder[] =>
    BOTS.map((bot) => ({
      bots: [bot],
      state: states.get(bot)!,
      replaceable: states.get(bot) === "changed" && param !== "odd" && param !== "moved",
      moved: states.get(bot) === "changed" && param === "moved",
      long: param === "odd" && bot === "quartermaster",
      utf8: !notUtf8(bot),
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
    // "New bots too" is this device's alone: nothing in the files changes. Taking it back needs
    // no admin access; saying yes does.
    if (change.action === "newBots" && !change.on) {
      record = { bots: record?.bots ?? [], newBots: false };
      return answer();
    }
    if (!canAdmin()) throw new Error("Changing the bots' instructions needs admin access.");
    if (change.action === "newBots") {
      record = { bots: record?.bots ?? [], newBots: true };
      return answer();
    }
    if (saveFails)
      return answer([
        "otto: AGENTS.md kept changing while Clawtrate wrote it, so it was left as it is.",
      ]);
    // The files changed between the read and the press: nothing to write, nothing to report.
    if (save === "race") return answer();
    if (change.action === "add") {
      for (const bot of change.bots)
        if (!notUtf8(bot) && ["none", "removed", "older"].includes(states.get(bot)!))
          states.set(bot, "current");
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
