// "Bots know how Clawtrate works": the bots' guides as the gateway's files hold them (core
// guides.ts). Always on: there is nothing to change, only what the files hold to read.
//
//   (none)         every bot has the section as Clawtrate keeps it
//   guides=odd     Juniper current; Marlow's markers out of shape; Pip's file not plain UTF-8;
//                  Quartermaster's instructions too long for the section; Otto's not updated yet
//   guides=unread  every bot has it, but Otto's file can't be read
//   guides=new     Pip's AGENTS.md doesn't exist yet; the rest have it
//   guides=fail    the read fails

import type { BotGuidesAnswer, GatewayStamp, GuideFolder, GuideState } from "@clawtrate/core";

const BOTS = ["main", "clawtrate-main-bot", "marlow", "otto", "pip", "quartermaster"];

export const guidesParam = (params: URLSearchParams) => params.get("guides");

export function guidesCommands(given: string | null, stampNow: () => GatewayStamp) {
  const odd: Record<string, GuideState> = { marlow: "unclear", otto: "behind", pip: "behind" };
  const folder = (bot: string): GuideFolder => {
    const base = {
      bots: [bot],
      state: "current" as GuideState | null,
      long: false,
      utf8: true,
      missing: false,
      error: null as string | null,
    };
    if (given === "odd" && bot === "quartermaster") return { ...base, state: "behind", long: true };
    if (given === "odd" && bot in odd) return { ...base, state: odd[bot]!, utf8: bot !== "pip" };
    if (given === "unread" && bot === "otto")
      return { ...base, state: null, error: "The gateway did not answer." };
    if (given === "new" && bot === "pip") return { ...base, state: "behind", missing: true };
    return base;
  };
  return async (): Promise<BotGuidesAnswer> => {
    if (given === "fail") throw new Error("The gateway did not answer.");
    return { folders: BOTS.map(folder), stamp: stampNow() };
  };
}
