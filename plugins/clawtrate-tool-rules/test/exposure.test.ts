// What lets a bot change the rules, read from the gateway's config: the
// check is conservative, so a bot counts as able unless the config surely
// keeps the tool from it.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exposureWarnings, exposures, surelyDenied } from "../lib/exposure.js";

const SAFE = {
  tools: { deny: ["gateway", "plugins"], exec: { mode: "deny" }, fs: { workspaceOnly: true } },
};
const withAgent = (base: Record<string, unknown>, agent: Record<string, unknown> = {}) => ({
  ...base,
  agents: { entries: { otto: agent } },
});

describe("exposures", () => {
  it("finds nothing for a bot denied the gateway tools, commands and files outside its workspace", () => {
    expect(exposures(withAgent(SAFE))).toEqual([]);
  });

  it("finds a bot that may manage the gateway or its plugins", () => {
    const config = withAgent({ ...SAFE, tools: { ...SAFE.tools, deny: ["gateway"] } });
    expect(exposures(config)).toEqual([{ agentId: "otto", reasons: ["manages-gateway"] }]);
  });

  it("finds a bot whose own command policy runs commands on the gateway's machine", () => {
    expect(exposures(withAgent(SAFE, { tools: { exec: { mode: "ask" } } }))).toEqual([
      { agentId: "otto", reasons: ["commands-on-gateway-host"] },
    ]);
    // Elsewhere, or sandboxed, or denied: not found.
    for (const agent of [
      { tools: { exec: { mode: "ask", host: "node" } } },
      { tools: { exec: { mode: "ask" } }, sandbox: { mode: "all" } },
      { tools: { exec: { mode: "ask" }, deny: ["group:runtime"] } },
    ]) {
      expect(exposures(withAgent(SAFE, agent))).toEqual([]);
    }
  });

  it("finds a bot whose file tools are not kept to its workspace", () => {
    const config = withAgent({ ...SAFE, tools: { ...SAFE.tools, fs: {} } });
    expect(exposures(config)).toEqual([{ agentId: "otto", reasons: ["files-outside-workspace"] }]);
  });

  it("finds every reason for a bot with no policy at all", () => {
    expect(exposures(withAgent({}))).toEqual([
      {
        agentId: "otto",
        reasons: ["manages-gateway", "commands-on-gateway-host", "files-outside-workspace"],
      },
    ]);
  });
});

describe("surelyDenied", () => {
  it("counts a deny by name, alias, group, pattern or *, and an allow list that leaves the tool out", () => {
    const agent = {};
    for (const deny of [["gateway"], ["group:openclaw"], ["gate*"], ["*"]]) {
      expect(surelyDenied({ tools: { deny } }, agent, "gateway"), deny.join()).toBe(true);
    }
    expect(surelyDenied({ tools: { deny: ["bash"] } }, agent, "exec")).toBe(true);
    expect(surelyDenied({ tools: { allow: ["read", "write"] } }, agent, "gateway")).toBe(true);
    expect(surelyDenied({}, agent, "gateway")).toBe(false);
    // A group it does not know may hold the tool.
    expect(surelyDenied({ tools: { allow: ["group:mystery"] } }, agent, "gateway")).toBe(false);
  });
});

describe("read as the gateway reads it", () => {
  it("warns about commands on the gateway's host even under sandbox mode", () => {
    const sandboxed = {
      tools: { exec: { mode: "ask", host: "gateway" } },
      sandbox: { mode: "all" },
    };
    expect(exposures(withAgent(SAFE, sandboxed))).toEqual([
      { agentId: "otto", reasons: ["commands-on-gateway-host"] },
    ]);
    const viaDefaults = {
      ...SAFE,
      tools: { ...SAFE.tools, exec: { mode: "ask", host: "gateway" } },
      agents: { defaults: { sandbox: { mode: "all" } }, entries: { otto: {} } },
    };
    expect(exposures(viaDefaults)).toEqual([
      { agentId: "otto", reasons: ["commands-on-gateway-host"] },
    ]);
  });

  it("reads an empty allow list as no restriction", () => {
    expect(surelyDenied({ tools: { allow: [] } }, {}, "gateway")).toBe(false);
    expect(surelyDenied({}, { tools: { allow: [] } }, "exec")).toBe(false);
    const config = withAgent({ ...SAFE, tools: { ...SAFE.tools, deny: [], allow: [] } });
    expect(exposures(config)).toEqual([{ agentId: "otto", reasons: ["manages-gateway"] }]);
  });

  it("reads write in an allow list as allowing apply_patch too", () => {
    expect(surelyDenied({ tools: { allow: ["read", "write"] } }, {}, "apply_patch")).toBe(false);
  });
});

describe("the gateway's implicit default bot", () => {
  it("is warned about when the config names no bots, and not when it names an empty roster", () => {
    expect(exposures({})).toEqual([
      {
        agentId: "main",
        reasons: ["manages-gateway", "commands-on-gateway-host", "files-outside-workspace"],
      },
    ]);
    expect(exposures({ agents: { entries: {} } })).toEqual([]);
  });
});

describe("policy entries named like inherited properties", () => {
  it("are read as unknown names, and the scan goes on", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const config = withAgent({
        ...SAFE,
        tools: { ...SAFE.tools, deny: [...SAFE.tools.deny, name] },
      });
      expect(exposures(config), name).toEqual([]);
      expect(surelyDenied({ tools: { allow: [name] } }, {}, "gateway"), name).toBe(true);
    }
  });
});

describe("a sandboxed bot and elevated exec", () => {
  const sandboxed = { tools: { exec: { mode: "ask" } }, sandbox: { mode: "all" } };
  const config = (
    tools: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    agent = sandboxed,
  ) => ({
    ...SAFE,
    tools: { ...SAFE.tools, ...tools },
    ...extra,
    agents: { entries: { otto: agent } },
  });
  const warned = (c: Record<string, unknown>) =>
    exposures(c).some((e) => e.reasons.includes("commands-on-gateway-host"));

  it("is warned about while a sender can turn elevated on", () => {
    expect(warned(config({ elevated: { allowFrom: { discord: ["user-1"] } } }))).toBe(true);
    expect(warned(config({ elevated: { enabled: true, allowFrom: { telegram: ["*"] } } }))).toBe(
      true,
    );
    // No allowlist, but a channel that could supply one.
    expect(warned(config({}, { channels: { telegram: { enabled: true } } }))).toBe(true);
  });

  it("is not warned about once the gateway or the bot closes elevated", () => {
    expect(warned(config({ elevated: { enabled: false, allowFrom: { discord: ["u"] } } }))).toBe(
      false,
    );
    const closedForBot = {
      ...sandboxed,
      tools: { ...sandboxed.tools, elevated: { enabled: false } },
    };
    expect(warned(config({ elevated: { allowFrom: { discord: ["u"] } } }, {}, closedForBot))).toBe(
      false,
    );
    // Nobody can qualify: no allowlist and no channel.
    expect(warned(config({}))).toBe(false);
    expect(warned(config({ elevated: { allowFrom: { discord: [] } } }))).toBe(false);
  });
});

describe("a workspace that holds the rules store", () => {
  const temps: string[] = [];
  afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const temp = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-exposure-")));
    temps.push(dir);
    return dir;
  };

  it("is warned about even with workspaceOnly, and a separate one is not", () => {
    const state = temp();
    const storeDir = join(state, "clawtrate-tool-rules");
    mkdirSync(storeDir);
    const separate = join(state, "workspaces", "otto");
    mkdirSync(separate, { recursive: true });
    const reasonsFor = (workspace: string) =>
      exposures(withAgent(SAFE), { storeDir, workspaceOf: () => [workspace] })[0]?.reasons ?? [];
    // The state folder itself as the workspace, and one named through a link to it.
    expect(reasonsFor(state)).toEqual(["store-in-workspace"]);
    const link = join(temp(), "ws");
    symlinkSync(state, link);
    expect(reasonsFor(link)).toEqual(["store-in-workspace"]);
    expect(reasonsFor(separate)).toEqual([]);
    // With the write tools denied it is not.
    const denied = { ...SAFE, tools: { ...SAFE.tools, deny: [...SAFE.tools.deny, "group:fs"] } };
    expect(exposures(withAgent(denied), { storeDir, workspaceOf: () => [state] })).toEqual([]);
  });
});

describe("a store not created yet under a linked folder", () => {
  const temps: string[] = [];
  afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const temp = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-exposure-")));
    temps.push(dir);
    return dir;
  };

  it("is placed where its nearest existing folder resolves, so a workspace holding it is warned about", () => {
    const state = temp();
    const alias = join(temp(), "state-link");
    symlinkSync(state, alias);
    // Named through the link, and not created yet: the plugin creates it on its first save.
    const storeDir = join(alias, "clawtrate-tool-rules");
    const reasonsFor = (workspace: string) =>
      exposures(withAgent(SAFE), { storeDir, workspaceOf: () => [workspace] })[0]?.reasons ?? [];
    expect(reasonsFor(state)).toEqual(["store-in-workspace"]);
    expect(reasonsFor(temp())).toEqual([]);
  });
});

describe("the remedy for a workspace that holds the store", () => {
  it("says to choose a workspace that does not contain the store, or to deny the file tools", () => {
    const [line] = exposureWarnings(withAgent(SAFE), {
      storeDir: "/srv/gateway/clawtrate-tool-rules",
      workspaceOf: () => ["/srv"],
    });
    expect(line).toMatch(
      /Choose a workspace that does not contain the rules store, or deny it write, edit and apply_patch\.$/,
    );
    expect(line).not.toMatch(/outside the gateway's state folder/);
  });
});

describe("the remedy for commands on the gateway's host", () => {
  it("keeps denying the tools apart, and says a sandbox needs the bot's elevated exec off and no gateway-host override", () => {
    const [line] = exposureWarnings(withAgent(SAFE, { tools: { exec: { mode: "ask" } } }));
    expect(line).toMatch(/Deny it exec and process\./);
    expect(line).toContain(
      "Or use a sandbox for its commands, clear any gateway-host override in its sessions, and disable elevated exec for the bot",
    );
    expect(line).toContain("agents.entries.<bot>.tools.elevated.enabled false");
  });
});
