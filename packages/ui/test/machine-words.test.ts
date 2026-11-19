// The words of "Where a bot runs" and Settings, Machines (controls.md sections
// 14 and 15): the row's value as the stored setting by itself, a machine's
// state as last seen, and an approvals file's levels as stored.
import { describe, expect, it } from "vitest";
import type { BotPlacement, CommandPlace, NodeFacts } from "@clawtrate/core";
import { hostWords, levelsWords, nodeState, runsOnValue } from "../src/machines/words.ts";

const node: NodeFacts = {
  id: "node-media-box",
  name: "media-box",
  connected: false,
  // Local times, so the words are the same in any time zone.
  lastSeenAt: new Date(2026, 10, 16, 17, 12).getTime(),
  lastSeenReason: "connect",
  approved: true,
  approvalsCommands: true,
  listsRun: false,
  paired: true,
};

const place = (over: Partial<CommandPlace>): CommandPlace => ({
  ownHost: null,
  ownNode: null,
  defaultHost: null,
  defaultNode: null,
  host: null,
  hostSupported: null,
  inherited: false,
  nodeSelector: null,
  nodeInherited: false,
  node: null,
  ...over,
});

describe("the machines' words", () => {
  it("F-046 F-272: the row names the stored command machine and the bots with the same setting", () => {
    const placement = {
      commands: place({ host: "node", hostSupported: true, node, nodeSelector: node.id }),
      sameSetting: { machine: ["pip"], workspace: ["pip", "marlow"] },
    } as unknown as BotPlacement;
    expect(runsOnValue(placement, (id) => id[0]!.toUpperCase() + id.slice(1))).toBe(
      "Command setting: media-box · Same setting as Pip and Marlow",
    );
    const unset = {
      commands: place({}),
      sameSetting: { machine: [], workspace: [] },
    } as unknown as BotPlacement;
    expect(runsOnValue(unset, (id) => id)).toBe("Command setting: not set");
  });

  it("F-046: a stored value is shown as stored: an unknown host marked, a node the list lacks by its id, auto as auto", () => {
    expect(hostWords(place({ host: "cluster", hostSupported: false }))).toBe(
      "“cluster” (not supported here)",
    );
    expect(hostWords(place({ host: "node", hostSupported: true, nodeSelector: "garage-pi" }))).toBe(
      "garage-pi",
    );
    expect(hostWords(place({ host: "auto", hostSupported: true }))).toBe("auto");
    expect(hostWords(place({ host: "sandbox", hostSupported: true }))).toBe("sandbox");
    expect(hostWords(place({ host: "gateway", hostSupported: true }))).toBe(
      "the gateway's machine",
    );
  });

  it("F-157: a machine not connected says when it was last seen, with the gateway's reason", () => {
    expect(nodeState(node, new Date(2026, 10, 16, 17, 40).getTime())).toMatch(
      /^Not connected · Last seen Today 5:12\sPM \(connect\)$/,
    );
    expect(nodeState({ ...node, connected: true }, 0)).toBe("Connected");
  });

  it("F-156: a file's levels are a choice by name only when exactly that pair, and otherwise the pair as stored", () => {
    expect(levelsWords({ security: "allowlist", ask: "always" })).toBe("Ask every time");
    expect(levelsWords({ security: "full", ask: "always" })).toBe("security full, ask always");
    expect(levelsWords({ security: "deny", ask: "always" })).toBe("security deny, ask always");
    expect(levelsWords({ security: null, ask: "always" })).toBe("security not set, ask always");
    expect(levelsWords({ security: null, ask: null })).toBe("No levels set");
  });
});
