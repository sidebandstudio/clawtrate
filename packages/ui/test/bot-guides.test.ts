// "How bots work in Clawtrate" (`BotGuides.tsx`): a change's answer is shown only on the
// gateway it was read from. When the connection moved while the change ran, the pane reads the
// gateway now on screen again instead of keeping an answer it would never show.
import type { BotGuidesAnswer } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { afterChange, forConnection } from "../src/BotGuides.tsx";

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
