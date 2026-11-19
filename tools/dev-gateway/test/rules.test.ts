// The rules plugin on a development instance: its contract addition passes
// the guard, it adds exactly its own entry and load path to the config, no
// tool and no setting, it keeps every bot's denies, and the default instance
// never loads it.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { devConfig, DENIED_TOOLS, loadPlugins, PLUGIN_RULE, sandboxProblems } from "../src/cli.ts";
import { loadDevPlugin, pluginCopy } from "../src/dev-plugins.ts";
import { CHECKOUT_DIR } from "../src/env.ts";
import { RULES_CHECKS } from "../src/rules-checks.ts";
import { SCENARIOS } from "../src/scenarios.ts";

const PORTS = { gatewayPort: 19400, providerPort: 19410 };
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-rules-")));
  temps.push(dir);
  return dir;
};
const plugin = () => loadDevPlugin("clawtrate-tool-rules", CHECKOUT_DIR, PLUGIN_RULE);

describe("the rules plugin on a development instance", () => {
  it("passes the guard, with no setting, no tool and no browsers", () => {
    expect(plugin()).toMatchObject({
      name: "clawtrate-tool-rules",
      id: "clawtrate-tool-rules",
      settings: {},
      tools: [],
      botBrowsers: null,
      providers: [],
    });
  });

  it("adds only its entry and its load path, inside the closed contract", () => {
    const state = temp();
    const loaded = plugin();
    const config = devConfig("tok", PORTS, state, [loaded]);
    const bare = devConfig("tok", PORTS, state);
    expect(
      config.plugins.entries["clawtrate-tool-rules" as keyof typeof config.plugins.entries],
    ).toEqual({
      enabled: true,
      config: {},
    });
    expect(config.plugins.load).toEqual({ paths: [pluginCopy(state, "clawtrate-tool-rules")] });
    expect(config.tools).toEqual(bare.tools);
    expect(config.agents).toEqual(bare.agents);
    expect(config.tools.deny).toEqual(expect.arrayContaining([...DENIED_TOOLS]));
    expect(config.tools.deny).toEqual(expect.arrayContaining(["gateway", "plugins"]));
    expect(sandboxProblems(config, PORTS, state, [loaded])).toEqual([]);
    // Turned off, as a check does for a while, the config is outside the contract.
    const off = structuredClone(config) as unknown as {
      plugins: { entries: Record<string, { enabled: boolean }> };
    };
    off.plugins.entries["clawtrate-tool-rules"]!.enabled = false;
    expect(sandboxProblems(off, PORTS, state, [loaded])).toEqual([
      "plugins.entries.clawtrate-tool-rules.enabled must be true, found false",
    ]);
  });

  it("is never loaded on the default instance", () => {
    expect(() =>
      loadPlugins({ checkout: CHECKOUT_DIR, name: null }, ["clawtrate-tool-rules"]),
    ).toThrow(/default instance never loads plugins/);
    expect(
      loadPlugins({ checkout: CHECKOUT_DIR, name: "rules" }, ["clawtrate-tool-rules"]),
    ).toHaveLength(1);
  });

  it("loads beside the computer plugin", () => {
    const state = temp();
    const both = loadPlugins({ checkout: CHECKOUT_DIR, name: "both" }, [
      "clawtrate-computer",
      "clawtrate-tool-rules",
    ]);
    const config = devConfig("tok", PORTS, state, both, {}, "/opt/chromium-for-tests/chrome");
    expect(
      sandboxProblems(config, PORTS, state, both, {}, "/opt/chromium-for-tests/chrome"),
    ).toEqual([]);
  });
});

describe("the rules checks", () => {
  it("send only directives the scripted model has", () => {
    const directives = new Set(SCENARIOS.map((s) => `#${s.name}`));
    for (const check of RULES_CHECKS) {
      for (const directive of check.covers) expect(directives, check.name).toContain(directive);
    }
    expect(RULES_CHECKS.flatMap((check) => check.covers)).toContain("#message-read");
  });
});
