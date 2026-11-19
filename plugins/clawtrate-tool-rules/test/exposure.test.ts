// What lets a bot change the rules, read from the gateway's config: the
// check is conservative, so a bot counts as able unless the config surely
// keeps the tool from it.

import { describe, expect, it } from "vitest";
import { exposures, surelyDenied } from "../lib/exposure.js";

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
