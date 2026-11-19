// The words of "Where a bot runs" and Settings, Machines (controls.md sections
// 14 and 15): the row's value, a machine's state as last seen, and the
// effective result as the gateway combines a bot's policy with each file.
import { describe, expect, it } from "vitest";
import type { ApprovalsFile, BotPlacement, ExecPolicy, NodeFacts } from "@clawtrate/core";
import { effectiveWords, nodeState, runsOnValue } from "../src/machines/words.ts";

const node: NodeFacts = {
  id: "node-media-box",
  name: "media-box",
  connected: false,
  lastSeenAt: new Date("2026-11-16T17:12:00-05:00").getTime(),
  lastSeenReason: "connect",
  approved: true,
  approvalsCommands: true,
  runsCommands: true,
};

const file = (over: Partial<ApprovalsFile> = {}): ApprovalsFile => ({
  hash: "h",
  exists: true,
  defaults: { security: "allowlist", ask: "on-miss" },
  resolved: null,
  entries: [],
  entriesOmitted: 0,
  ...over,
});

const review: ExecPolicy = {
  mode: "auto",
  security: "allowlist",
  ask: "on-miss",
  autoReview: true,
  own: true,
  legacy: false,
  none: false,
};

describe("the machines' words", () => {
  it("F-046 F-272: the row names the command machine and the bots sharing it or the folder", () => {
    const placement = {
      commands: { host: "node", node, nodeSelector: node.id, sandbox: false },
      sharedWith: { machine: ["pip"], workspace: ["pip", "marlow"], browser: ["juniper"] },
    } as unknown as BotPlacement;
    expect(runsOnValue(placement, (id) => id[0]!.toUpperCase() + id.slice(1))).toBe(
      "Commands on media-box · Shared with Pip and Marlow",
    );
    const home = {
      commands: { host: "auto", node: null, nodeSelector: null, sandbox: false },
      sharedWith: { machine: [], workspace: [], browser: [] },
    } as unknown as BotPlacement;
    expect(runsOnValue(home, (id) => id)).toBe("Commands on the gateway's machine");
  });

  it("F-157: a machine not connected says when it was last seen, with the gateway's reason", () => {
    expect(nodeState(node, new Date("2026-11-16T17:40:00-05:00").getTime())).toMatch(
      /^Not connected · Last seen Today 5:12\sPM \(connect\)$/,
    );
    expect(nodeState({ ...node, connected: true }, 0)).toBe("Connected");
  });

  it("F-156: the effective result says which file asks more, and that the reviewer is then skipped", () => {
    expect(effectiveWords("Otto", "otto", review, [{ name: "media-box", file: file() }])).toBe(
      "Review first: commands on the allowlist run, and the reviewer decides the rest, from Otto's policy (Review first); this file asks no more.",
    );
    const always = file({
      entries: [{ botId: "otto", levels: { security: null, ask: "always" }, allowlist: 0 }],
    });
    expect(effectiveWords("Otto", "otto", review, [{ name: "media-box", file: always }])).toBe(
      "Every command asks: its entry in media-box's file asks more than Otto's policy (Review first), so the gateway skips Otto's reviewer.",
    );
    const never = file({ defaults: { security: "deny", ask: null } });
    expect(
      effectiveWords("Otto", "otto", review, [
        { name: "the gateway's machine", file: file({ defaults: { security: null, ask: null } }) },
        { name: "media-box", file: never },
      ]),
    ).toBe(
      "Never: every command is refused: media-box's file is stricter than Otto's policy (Review first).",
    );
  });
});
