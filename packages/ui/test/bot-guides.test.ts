// "How bots work in Clawtrate" (`BotGuides.tsx`): a change's answer is shown only on the
// gateway it was read from. When the connection moved while the change ran, the pane reads the
// gateway now on screen again instead of keeping an answer it would never show.
import type { BotGuidesAnswer } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { afterChange, forConnection, newBotsControl } from "../src/BotGuides.tsx";

const read = (gatewayId: string | null, target: number): BotGuidesAnswer => ({
  folders: [],
  record: null,
  voicePlugin: false,
  errors: [],
  stamp: { gatewayId, target },
});

describe("a guides change's answer", () => {
  it("is shown when it is the connected gateway's", () => {
    const answer = read("gw-a", 1);
    expect(afterChange(answer, { gatewayId: "gw-a", target: 1 })).toEqual({ show: answer });
  });

  it("is not kept once the connection moved: the gateway now on screen is read again", () => {
    // Another gateway, the same gateway on a new target, and a read no gateway was confirmed for.
    for (const [answer, connection] of [
      [read("gw-a", 1), { gatewayId: "gw-b", target: 2 }],
      [read("gw-a", 1), { gatewayId: "gw-a", target: 2 }],
      [read(null, 1), { gatewayId: "gw-a", target: 1 }],
    ] as const) {
      expect(forConnection(answer.stamp, connection)).toBe(false);
      expect(afterChange(answer, connection)).toEqual({ readAgain: true });
    }
  });
});

describe("New bots too", () => {
  const base = { savesAtOnce: true, addable: false, turnedOffHere: false };
  it("is the whole control with admin access", () => {
    expect(newBotsControl({ ...base, admin: true, saved: false })).toEqual({
      canChange: true,
      note: null,
    });
    expect(
      newBotsControl({ ...base, admin: true, savesAtOnce: false, addable: false, saved: true }),
    ).toBeNull();
  });

  it("can always be turned off without admin access, and not turned on", () => {
    expect(newBotsControl({ ...base, admin: false, saved: true })).toEqual({
      canChange: true,
      note: "Turning it on again needs admin access.",
    });
    // Turned off from this view: it stays, unchangeable, saying why.
    expect(newBotsControl({ ...base, admin: false, saved: false, turnedOffHere: true })).toEqual({
      canChange: false,
      note: "Turning it on needs admin access.",
    });
    // Off, and not turned off here: nothing to take back, so nothing is shown.
    expect(newBotsControl({ ...base, admin: false, saved: false })).toBeNull();
    expect(newBotsControl({ ...base, admin: false, savesAtOnce: false, saved: true })).toBeNull();
  });
});
