// "Bots know how Clawtrate works" (`BotGuides.tsx`): a change's answer is shown only on the
// gateway it was read from. When the connection moved while the change ran, the pane reads the
// gateway now on screen again instead of keeping an answer it would never show. Each bot's row:
// its words and its one action, and no row for a bot simply as Clawtrate keeps it.
import type { BotGuidesAnswer, GuideFolder } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { afterChange, forConnection, guideRow } from "../src/BotGuides.tsx";

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

describe("a bot's row", () => {
  const folder = (over: Partial<GuideFolder>): GuideFolder => ({
    bots: ["pip"],
    state: "current",
    replaceable: false,
    moved: false,
    long: false,
    utf8: true,
    changedText: null,
    error: null,
    ...over,
  });
  const row = (over: Partial<GuideFolder>, on = true, admin = true) =>
    guideRow(folder(over), "Pip", on, admin);

  it("is there only where the file isn't simply as Clawtrate keeps it", () => {
    expect(row({ state: "current" })).toBeNull();
    // Off: a bot without it, or one never known to have it, is simply off.
    expect(row({ state: "none" }, false)).toBeNull();
    expect(row({ state: "removed" }, false)).toBeNull();
    expect(row({ state: "current" }, false)).toEqual({
      words: "Still has Clawtrate's section.",
      action: "remove",
    });
  });

  it("offers one action, and none that writes without admin access or to a file that isn't UTF-8", () => {
    expect(row({ state: "removed" })).toEqual({
      words: "Removed outside Clawtrate, so Clawtrate doesn't add it again by itself.",
      action: "add",
    });
    expect(row({ state: "none", long: true })).toEqual({
      words:
        "Its instructions are long: with this section, the gateway may leave part of them out of Pip's prompt, so Clawtrate doesn't add it by itself.",
      action: "add",
    });
    expect(row({ state: "older", long: true })?.action).toBe("update");
    expect(row({ state: "changed", replaceable: true })?.action).toBe("replace");
    expect(row({ state: "changed", moved: true })?.action).toBe("show");
    expect(row({ state: "changed" })?.action).toBe("show");
    // Off wins: a changed section is shown, never replaced.
    expect(row({ state: "changed", replaceable: true }, false)?.action).toBe("show");
    for (const state of ["removed", "none", "older"] as const)
      expect(row({ state }, true, false)?.action ?? null, state).toBeNull();
    expect(row({ state: "changed", replaceable: true }, true, false)?.action).toBe("show");
    for (const state of ["none", "older"] as const)
      expect(row({ state, utf8: false })).toEqual({
        words:
          "Pip's AGENTS.md isn't plain UTF-8 text, so Clawtrate can't change it. Save it as UTF-8 and Clawtrate can add, update or remove its section again.",
        action: null,
      });
    expect(row({ state: "current", utf8: false }, false)?.action).toBeNull();
    expect(row({ state: null, error: "missing scope: operator.read" })).toEqual({
      words: "Couldn't read its instructions file. missing scope: operator.read",
      action: null,
    });
  });
});
