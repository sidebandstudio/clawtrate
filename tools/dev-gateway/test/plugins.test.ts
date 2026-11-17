import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DENIED_TOOLS,
  devConfig,
  loadPlugins,
  RESERVED_PLUGIN_IDS,
  sandboxProblems,
} from "../src/cli.ts";
import {
  ADDITION_FILE,
  additionProblems,
  loadDevPlugin,
  pluginSelectionProblem,
} from "../src/dev-plugins.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/plugins");
const rule = { denied: DENIED_TOOLS, reserved: RESERVED_PLUGIN_IDS };
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout-like folder with a plugins/ folder holding a copy of the fixture. */
function checkoutWithFixture(): { checkout: string; root: string } {
  const checkout = mkdtempSync(join(tmpdir(), "clawtrate-plugins-"));
  temps.push(checkout);
  const root = join(checkout, "plugins");
  mkdirSync(root);
  cpSync(join(FIXTURES, "hello-tool"), join(root, "hello-tool"), { recursive: true });
  return { checkout, root };
}

describe("the plugin opening", () => {
  it("loads a checkout's own plugin and adds exactly its addition to the contract", () => {
    const plugin = loadDevPlugin("hello-tool", FIXTURES, rule);
    expect(plugin).toMatchObject({
      name: "hello-tool",
      id: "clawtrate-hello",
      tools: ["hello_tool"],
    });
    const config = devConfig("t", undefined, undefined, [plugin]);
    expect(config.plugins.load).toEqual({ paths: [plugin.dir] });
    expect((config.plugins.entries as Record<string, unknown>)["clawtrate-hello"]).toEqual(
      plugin.entry,
    );
    expect(config.tools.allow).toContain("hello_tool");
    expect(sandboxProblems(config, undefined, undefined, [plugin])).toEqual([]);
  });

  it("checks a plugin's part of the config as strictly as the rest", () => {
    const plugin = loadDevPlugin("hello-tool", FIXTURES, rule);
    const config = devConfig("t", undefined, undefined, [plugin]);
    // Without the plugin named, its load path, entry and tool are all refused.
    expect(sandboxProblems(config)).toEqual(
      expect.arrayContaining([
        "plugins.load is not allowed",
        "plugins.entries.clawtrate-hello is not allowed",
        expect.stringMatching(/^tools\.allow must be exactly/),
      ]),
    );
    const extra = structuredClone(config) as unknown as {
      plugins: { entries: Record<string, { config: Record<string, unknown> }> };
    };
    extra.plugins.entries["clawtrate-hello"]!.config.echoUrl = "https://example.com/echo";
    extra.plugins.entries["clawtrate-hello"]!.config.more = true;
    expect(sandboxProblems(extra, undefined, undefined, [plugin])).toEqual([
      "plugins.entries.clawtrate-hello.config.more is not allowed",
      'plugins.entries.clawtrate-hello.config.echoUrl must be "http://127.0.0.1:9/echo", found "https://example.com/echo"',
    ]);
  });

  it("accepts only a real folder directly under the checkout's plugins/", () => {
    const { checkout, root } = checkoutWithFixture();
    const inst = { checkout, name: "pluginsprobe" };
    expect(loadPlugins(inst, ["hello-tool"])).toHaveLength(1);
    for (const name of ["../hello-tool", "hello-tool/..", "Hello", "", "missing"]) {
      expect(() => loadPlugins(inst, [name])).toThrow(/^plugin .* is refused/);
    }
    symlinkSync(join(root, "hello-tool"), join(root, "linked"));
    expect(() => loadPlugins(inst, ["linked"])).toThrow(/is not a real folder/);
    mkdirSync(join(root, "no-addition"));
    cpSync(
      join(root, "hello-tool", "openclaw.plugin.json"),
      join(root, "no-addition", "openclaw.plugin.json"),
    );
    expect(() => loadPlugins(inst, ["no-addition"])).toThrow(
      /clawtrate-dev-contract\.json is missing/,
    );
    expect(() => loadPlugins({ checkout: FIXTURES, name: "x" }, ["hello-tool"])).toThrow(
      /no .*plugins folder|there is no/,
    );
  });

  it("never loads a plugin on the default instance, and refuses a name given twice", () => {
    expect(pluginSelectionProblem(null, ["hello-tool"])).toMatch(
      /default instance never loads plugins/,
    );
    expect(pluginSelectionProblem("x", ["hello-tool", "hello-tool"])).toMatch(/named twice/);
    expect(pluginSelectionProblem(null, [])).toBeNull();
    const { checkout } = checkoutWithFixture();
    expect(() => loadPlugins({ checkout, name: null }, ["hello-tool"])).toThrow(/default instance/);
  });

  it("refuses an addition that would open what the development gateway keeps closed", () => {
    const { root } = checkoutWithFixture();
    const base = {
      plugin: "clawtrate-hello",
      entry: { enabled: true, config: {} },
      tools: [] as string[],
    };
    const check = (addition: unknown) =>
      additionProblems(addition, {
        pluginDir: join(root, "hello-tool"),
        manifestId: "clawtrate-hello",
        ...rule,
      });
    expect(check(base)).toEqual([]);
    const cases: [unknown, RegExp][] = [
      [{ ...base, entry: { config: { apiKey: "x" } } }, /would turn on credentials/],
      [{ ...base, entry: { config: { auth: { mode: "none" } } } }, /would turn on credentials/],
      [{ ...base, entry: { config: { model: "openai/gpt-5" } } }, /would turn on a model provider/],
      [
        { ...base, entry: { config: { providers: { hosted: {} } } } },
        /would turn on a model provider/,
      ],
      [{ ...base, entry: { config: { exec: { mode: "full" } } } }, /would turn on shell commands/],
      [
        { ...base, entry: { config: { shellEnv: { enabled: true } } } },
        /would turn on shell commands/,
      ],
      [{ ...base, entry: { config: { url: "https://example.com" } } }, /reaches beyond loopback/],
      [{ ...base, entry: { config: { url: "ws://192.0.2.1:9" } } }, /reaches beyond loopback/],
      [{ ...base, entry: { config: { dir: "~/.openclaw/agents" } } }, /names the default profile/],
      [{ ...base, entry: { config: { file: "/etc/hosts" } } }, /outside the plugin's own folder/],
      [
        { ...base, entry: { config: { key: "OPENAI_API_KEY" } } },
        /credentials from the environment/,
      ],
      [{ ...base, entry: { config: { profile: "default" } } }, /would turn on another profile/],
      [{ ...base, tools: ["exec"] }, /tool exec is denied/],
      [{ ...base, tools: ["browser"] }, /tool browser is denied/],
      [{ ...base, tools: ["coder__*"] }, /not a plain tool name/],
      [{ ...base, entry: { enabled: false } }, /enabled must be true/],
      [{ ...base, entry: { hooks: {} } }, /may set only enabled and config/],
      [{ ...base, models: {} }, /the addition may not set models/],
      [{ ...base, plugin: "someone-else" }, /not the manifest's/],
    ];
    for (const [addition, problem] of cases) {
      expect(check(addition)).toEqual(expect.arrayContaining([expect.stringMatching(problem)]));
    }
    // The same rule refuses such a plugin at load time.
    writeFileSync(
      join(root, "hello-tool", ADDITION_FILE),
      JSON.stringify({ ...base, entry: { config: { url: "https://example.com" } } }),
    );
    expect(() => loadDevPlugin("hello-tool", root, rule)).toThrow(/breaks the rule for plugins/);
  });

  it("keeps the development config's own plugin entries for itself", () => {
    const { root } = checkoutWithFixture();
    expect(
      additionProblems(
        { plugin: "ollama", entry: {}, tools: [] },
        { pluginDir: join(root, "hello-tool"), manifestId: "ollama", ...rule },
      ),
    ).toEqual(["plugin id ollama is the development config's own entry"]);
  });
});
