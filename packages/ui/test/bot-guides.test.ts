// "Bots know how Clawtrate works" (`BotGuides.tsx`, #795): always on, with no switch. Settings
// says nothing while Clawtrate keeps every bot's section, and one quiet line, in its exact words,
// for the bots whose file it can't keep. An answer is shown only on the gateway it was read from.
import type { BotGuidesAnswer, GuideFolder } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { forConnection, guidesLines } from "../src/BotGuides.tsx";

const folder = (bot: string, over: Partial<GuideFolder> = {}): GuideFolder => ({
  bots: [bot],
  state: "current",
  long: false,
  utf8: true,
  missing: false,
  error: null,
  ...over,
});
const label = (ids: string[]) => ids.map((id) => id[0]!.toUpperCase() + id.slice(1)).join(" and ");

describe("the guides' lines", () => {
  it("say nothing while every file is current, or waits for the gateway to make it", () => {
    expect(guidesLines([folder("pip"), folder("otto")], label, true)).toEqual([]);
    // The gateway makes a missing file on the bot's next run; Clawtrate adds the section after.
    expect(guidesLines([folder("pip", { state: "behind", missing: true })], label, true)).toEqual(
      [],
    );
    // No switch, no link, no Read it: there is nothing else to say.
    expect(guidesLines([], label, false)).toEqual([]);
  });

  it("say once, naming the bots, that without admin access Clawtrate can't keep it", () => {
    expect(
      guidesLines(
        [
          folder("pip", { state: "behind" }),
          folder("otto", { state: "unclear" }),
          folder("juniper"),
        ],
        label,
        false,
      ),
    ).toEqual([
      "Clawtrate can't keep its section in Pip and Otto's instructions current: this device doesn't have admin access to the gateway.",
    ]);
    // Every bot current: nothing to say, admin or not.
    expect(guidesLines([folder("pip")], label, false)).toEqual([]);
  });

  it("say, one line for each reason, why Clawtrate leaves a file", () => {
    expect(
      guidesLines(
        [
          folder("marlow", { state: "unclear" }),
          folder("pip", { state: "behind", utf8: false }),
          folder("quartermaster", { state: "behind", long: true }),
          folder("otto", { state: "behind", long: true }),
          folder("juniper", { state: "behind" }),
          folder("main"),
        ],
        label,
        true,
      ),
    ).toEqual([
      "Clawtrate can't tell where its section is in Marlow's instructions, so it leaves them as they are.",
      "Pip's instructions aren't plain UTF-8 text, so Clawtrate leaves them as they are.",
      "Quartermaster and Otto's instructions are too long for Clawtrate's section: the gateway would leave part of them out.",
      "Clawtrate couldn't update Juniper's instructions yet. It tries again the next time it connects.",
    ]);
  });

  it("say when a file couldn't be read, with the gateway's words", () => {
    expect(
      guidesLines(
        [folder("pip", { state: null, error: "The gateway did not answer." })],
        label,
        true,
      ),
    ).toEqual(["Couldn't read Pip's instructions. The gateway did not answer."]);
  });
});

describe("a guides answer", () => {
  const read = (gatewayId: string | null, target: number): BotGuidesAnswer => ({
    folders: [],
    stamp: { gatewayId, target },
  });

  it("is shown only when it is the connected gateway's", () => {
    expect(forConnection(read("gw-a", 1).stamp, { gatewayId: "gw-a", target: 1 })).toBe(true);
    // Another gateway, the same gateway on a new target, and a read no gateway was confirmed for.
    for (const [answer, connection] of [
      [read("gw-a", 1), { gatewayId: "gw-b", target: 2 }],
      [read("gw-a", 1), { gatewayId: "gw-a", target: 2 }],
      [read(null, 1), { gatewayId: "gw-a", target: 1 }],
    ] as const)
      expect(forConnection(answer.stamp, connection)).toBe(false);
  });
});
