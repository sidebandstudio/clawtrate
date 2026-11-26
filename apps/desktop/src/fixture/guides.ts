// "Bots know how Clawtrate works": the bots' guides as the gateway's files hold them (core guides.ts).
//
//   (none)         the switch on, as by default, and every bot has the section
//   guides=off     the switch off, and no bot has it
//   guides=offleft the switch off, and Otto's section couldn't be taken out; Marlow's was changed
//                  outside Clawtrate
//   guides=mixed   the switch on: Juniper current, Marlow older with long instructions, Otto
//                  changed outside Clawtrate, Pip removed outside Clawtrate, Quartermaster's
//                  instructions too long to add it by itself
//   guides=odd     the switch on: Otto's markers out of shape, Marlow's section moved from the
//                  top, Pip's file not plain UTF-8, Quartermaster's file unreadable
//   guides=new     the switch on: Pip's AGENTS.md doesn't exist yet, and the gateway refused
//                  Clawtrate's write of Otto's; the rest have it
//   guides=unreadable  this device's record can't be read: Otto's file still has a changed
//                  section, the rest have it
//   guides=voice   every bot has it, and the voice plugin adds its own guide
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
  const param = save ? given!.slice(0, -`+save${save}`.length) || null : given;
  const start: Record<string, Record<string, GuideState | null>> = {
    off: {},
    offleft: { otto: "current", marlow: "changed" },
    mixed: {
      main: "current",
      marlow: "older",
      otto: "changed",
      pip: "removed",
      quartermaster: "none",
    },
    odd: { main: "current", marlow: "changed", otto: "changed", pip: "none", quartermaster: null },
    new: {
      main: "current",
      marlow: "current",
      otto: "none",
      pip: "none",
      quartermaster: "current",
    },
    unreadable: {
      main: "current",
      marlow: "current",
      otto: "changed",
      pip: "current",
      quartermaster: "current",
    },
  };
  const states = new Map<string, GuideState | null>(
    BOTS.map((bot) => [
      bot,
      param !== null && param in start
        ? bot in start[param]!
          ? (start[param]![bot] ?? null)
          : "none"
        : "current",
    ]),
  );
  let record: GuidesRecord =
    param === "off" || param === "offleft"
      ? { on: false, bots: [] }
      : { on: true, bots: param === "mixed" ? ["main", "marlow", "otto", "pip"] : BOTS };
  const voicePlugin = param === "voice";
  const unreadable = param === "unreadable";
  const missing = new Set(param === "new" ? ["pip"] : []);
  const refused = new Map(
    param === "new" ? [["otto", "Workspace document exceeds its write bound"]] : [],
  );
  const notUtf8 = (bot: string) => param === "odd" && bot === "pip";
  const long = (bot: string) => param === "mixed" && (bot === "quartermaster" || bot === "marlow");
  const folders = (): GuideFolder[] =>
    BOTS.map((bot) => ({
      bots: [bot],
      state: states.get(bot)!,
      replaceable: states.get(bot) === "changed" && param !== "odd",
      moved: states.get(bot) === "changed" && param === "odd" && bot === "marlow",
      long: long(bot),
      utf8: !notUtf8(bot),
      missing: states.get(bot) === "none" && missing.has(bot),
      refused: states.get(bot) === "none" ? (refused.get(bot) ?? null) : null,
      changedText:
        states.get(bot) === "changed"
          ? GUIDES_SECTION.replace("Lead with the answer", "Lead with a short joke")
          : null,
      error: states.get(bot) === null ? "The gateway did not answer." : null,
    }));
  const answer = (errors: string[] = []): BotGuidesAnswer => ({
    folders: folders(),
    record: unreadable ? null : record,
    unreadable,
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
    if (!canAdmin()) throw new Error("Changing the bots' instructions needs admin access.");
    if (unreadable) return answer(["Couldn't read this on this device, so nothing was changed."]);
    // Off is saved first, whatever the files do after.
    if (change.action === "switch" && !change.on) record = { on: false, bots: [] };
    if (save === "fail")
      return answer([
        "otto: AGENTS.md kept changing while Clawtrate wrote it, so it was left as it is.",
      ]);
    // The files changed between the read and the press: nothing to write, nothing to report.
    if (save === "race") return answer();
    const ours = (bot: string) => ["current", "older"].includes(states.get(bot) ?? "");
    if (change.action === "switch" && !change.on) {
      for (const bot of BOTS) if (ours(bot) && !notUtf8(bot)) states.set(bot, "none");
    } else if (change.action === "switch") {
      for (const bot of BOTS)
        if (
          !notUtf8(bot) &&
          !long(bot) &&
          !missing.has(bot) &&
          ["none", "older"].includes(states.get(bot) ?? "")
        )
          states.set(bot, "current");
      refused.clear();
      record = { on: true, bots: BOTS.filter((bot) => states.get(bot) !== "none") };
    } else if (change.action === "remove") {
      for (const bot of change.bots) if (ours(bot) && !notUtf8(bot)) states.set(bot, "none");
    } else if (change.action === "add") {
      for (const bot of change.bots) {
        if (!notUtf8(bot) && ["none", "removed", "older"].includes(states.get(bot) ?? ""))
          states.set(bot, "current");
        missing.delete(bot);
        refused.delete(bot);
      }
      record = { on: true, bots: [...new Set([...record.bots, ...change.bots])] };
    } else if (change.action === "replace") {
      if (states.get(change.bot) === "changed" && param !== "odd")
        states.set(change.bot, "current");
    }
    return answer();
  };
}
