import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { devConfig, loadPlugins, PLUGIN_RULE, sandboxProblems } from "../src/cli.ts";
import {
  ADDITION_FILE,
  additionProblems,
  checkedCopy,
  copyPlugin,
  loadDevPlugin,
  pluginCopy,
  pluginEntry,
  pluginSelectionProblem,
  SETTING_KINDS,
  trustedCodeNotice,
} from "../src/dev-plugins.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-plugins-")));
  temps.push(dir);
  return dir;
}

/** A checkout-like folder with a plugins/ folder holding a copy of the fixture. */
function checkoutWithFixture(): { checkout: string; root: string } {
  const checkout = temp();
  const root = join(checkout, "plugins");
  mkdirSync(root);
  cpSync(join(FIXTURES, "plugins", "hello-tool"), join(root, "hello-tool"), { recursive: true });
  return { checkout, root };
}

/** An instance-like state folder. */
const stateFolder = () => temp();

describe("the plugin opening", () => {
  it("loads a checkout's own plugin from the instance's copy, with exactly its addition", () => {
    const plugin = loadDevPlugin("hello-tool", FIXTURES, PLUGIN_RULE);
    expect(plugin).toMatchObject({
      name: "hello-tool",
      id: "clawtrate-hello",
      tools: ["hello_tool"],
    });
    expect(plugin.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const state = stateFolder();
    const copy = copyPlugin(plugin, state, PLUGIN_RULE);
    expect(copy).toBe(pluginCopy(state, "hello-tool"));
    const config = devConfig("t", undefined, state, [plugin]);
    expect(config.plugins.load).toEqual({ paths: [copy] });
    expect((config.plugins.entries as Record<string, unknown>)["clawtrate-hello"]).toEqual({
      enabled: true,
      config: {
        loud: false,
        repeat: 2,
        echoUrl: "http://127.0.0.1:9/echo",
        cacheDir: join(state, "clawtrate-plugin-data", "hello-tool", "cache"),
      },
    });
    expect(config.tools.allow).toContain("hello_tool");
    expect(sandboxProblems(config, undefined, state, [plugin])).toEqual([]);
  });

  it("checks a plugin's part of the config as strictly as the rest", () => {
    const plugin = loadDevPlugin("hello-tool", FIXTURES, PLUGIN_RULE);
    const state = stateFolder();
    const config = devConfig("t", undefined, state, [plugin]);
    // Without the plugin named, its load path, entry and tool are all refused.
    expect(sandboxProblems(config, undefined, state)).toEqual(
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
    expect(sandboxProblems(extra, undefined, state, [plugin])).toEqual([
      "plugins.entries.clawtrate-hello.config.more is not allowed",
      'plugins.entries.clawtrate-hello.config.echoUrl must be "http://127.0.0.1:9/echo", found "https://example.com/echo"',
    ]);
  });

  it("accepts only a real folder that is a direct child of the checkout's real plugins/", () => {
    const { checkout, root } = checkoutWithFixture();
    const inst = { checkout, name: "pluginsprobe" };
    expect(loadPlugins(inst, ["hello-tool"])).toHaveLength(1);
    for (const name of ["../hello-tool", "hello-tool/..", "Hello-tool", "", ".", "missing"]) {
      expect(() => loadPlugins(inst, [name])).toThrow(/^plugin .* is refused/);
    }
    // A link as the plugin's folder.
    symlinkSync(join(root, "hello-tool"), join(root, "linked"));
    expect(() => loadPlugins(inst, ["linked"])).toThrow(/is not a real folder/);
    // A link anywhere inside it.
    const inner = join(checkout, "plugins", "inner-link");
    cpSync(join(root, "hello-tool"), inner, { recursive: true });
    symlinkSync("/", join(inner, "root"));
    expect(() => loadPlugins(inst, ["inner-link"])).toThrow(/root is a link/);
    // Code named outside the folder.
    const outside = join(checkout, "plugins", "outside-entry");
    cpSync(join(root, "hello-tool"), outside, { recursive: true });
    writeFileSync(
      join(outside, "package.json"),
      JSON.stringify({ openclaw: { extensions: ["../hello-tool/index.js"] } }),
    );
    expect(() => loadPlugins(inst, ["outside-entry"])).toThrow(/is not a file in the plugin/);
    // No addition.
    mkdirSync(join(root, "no-addition"));
    cpSync(
      join(root, "hello-tool", "openclaw.plugin.json"),
      join(root, "no-addition", "openclaw.plugin.json"),
    );
    expect(() => loadPlugins(inst, ["no-addition"])).toThrow(
      /clawtrate-dev-contract\.json is missing/,
    );
    expect(() => loadPlugins({ checkout: temp(), name: "x" }, ["hello-tool"])).toThrow(
      /there is no folder .*plugins/,
    );
  });

  it("refuses a plugins/ folder that is a link to somewhere else", () => {
    // The reviewer's linked parent: checkout/plugins links to a folder outside.
    const elsewhere = temp();
    cpSync(join(FIXTURES, "plugins", "hello-tool"), join(elsewhere, "hello-tool"), {
      recursive: true,
    });
    const checkout = temp();
    symlinkSync(elsewhere, join(checkout, "plugins"));
    expect(() => loadPlugins({ checkout, name: "x" }, ["hello-tool"])).toThrow(
      /plugins is not a real folder/,
    );
  });

  it("refuses a folder whose stored name differs only in case", () => {
    const checkout = temp();
    mkdirSync(join(checkout, "plugins"));
    cpSync(join(FIXTURES, "plugins", "hello-tool"), join(checkout, "plugins", "Hello-tool"), {
      recursive: true,
    });
    expect(() => loadPlugins({ checkout, name: "x" }, ["hello-tool"])).toThrow(/is refused/);
  });

  it("runs what was checked even if the folder is swapped for a link before load", () => {
    // The reviewer's swap: after the check, the checked folder is moved away
    // and a link to other code takes its place.
    const { checkout, root } = checkoutWithFixture();
    const [plugin] = loadPlugins({ checkout, name: "x" }, ["hello-tool"]);
    const checkedCode = readFileSync(join(root, "hello-tool", "index.js"), "utf8");
    const replacement = join(temp(), "swap-replacement");
    cpSync(join(root, "hello-tool"), replacement, { recursive: true });
    writeFileSync(
      join(replacement, "index.js"),
      "export default { register() { /* swapped */ } };",
    );
    renameSync(join(root, "hello-tool"), join(root, "hello-tool-checked"));
    symlinkSync(replacement, join(root, "hello-tool"));

    const state = stateFolder();
    const copy = copyPlugin(plugin!, state, PLUGIN_RULE);
    expect(readFileSync(join(copy, "index.js"), "utf8")).toBe(checkedCode);
    expect(devConfig("t", undefined, state, [plugin!]).plugins.load).toEqual({ paths: [copy] });
    // Starting again from the swapped checkout is refused outright.
    expect(() => loadPlugins({ checkout, name: "x" }, ["hello-tool"])).toThrow(
      /is not a real folder/,
    );
  });

  it("refuses the instance's copy once it differs from the digest recorded at start", () => {
    const plugin = loadDevPlugin("hello-tool", FIXTURES, PLUGIN_RULE);
    const state = stateFolder();
    const copy = copyPlugin(plugin, state, PLUGIN_RULE);
    expect(checkedCopy("hello-tool", plugin.digest, state, PLUGIN_RULE).digest).toBe(plugin.digest);
    writeFileSync(join(copy, "index.js"), "export default { register() {} };");
    expect(() => checkedCopy("hello-tool", plugin.digest, state, PLUGIN_RULE)).toThrow(
      /its copy in the instance is sha256:.*, not the sha256:/,
    );
    // Nothing is written through what is already there.
    expect(() => copyPlugin(plugin, state, PLUGIN_RULE)).toThrow(/EEXIST/);
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

  describe("the closed addition", () => {
    const base = { plugin: "clawtrate-hello", settings: {}, tools: [] as unknown[] };
    const check = (addition: unknown) =>
      additionProblems(addition, { manifestId: "clawtrate-hello", ...PLUGIN_RULE });
    const plugin = () => loadDevPlugin("hello-tool", FIXTURES, PLUGIN_RULE);
    const refused = (addition: unknown, problem: RegExp) =>
      expect(check(addition), JSON.stringify(addition)).toEqual(
        expect.arrayContaining([expect.stringMatching(problem)]),
      );

    it("accepts only the declared kinds", () => {
      expect(check(base)).toEqual([]);
      expect(SETTING_KINDS).toEqual([
        "flag",
        "count",
        "loopback-url",
        "instance-path",
        "scripted-model-url",
      ]);
      expect(
        check({
          ...base,
          settings: {
            on: { kind: "flag", value: true },
            n: { kind: "count", value: 0 },
            v4: { kind: "loopback-url", value: "http://127.0.0.1:19500/x" },
            v6: { kind: "loopback-url", value: "ws://[::1]:19500/" },
            dir: { kind: "instance-path", value: "cache/db.sqlite" },
            signin: { kind: "scripted-model-url", value: "/scripted/signin" },
          },
          tools: [{ name: "hello_tool", kind: "plugin-tool" }],
        }),
      ).toEqual([]);
    });

    it("gives a scripted-model-url only as a plain path on the instance's own scripted model", () => {
      for (const value of [
        "scripted/signin",
        "/../signin",
        "//example.com/x",
        "/a b",
        "/",
        "http://127.0.0.1:19500/x",
        "/x?y=1",
      ]) {
        refused(
          { ...base, settings: { at: { kind: "scripted-model-url", value } } },
          /setting at \(scripted-model-url\)/,
        );
      }
      const addition = {
        ...base,
        settings: { at: { kind: "scripted-model-url", value: "/scripted/signin" } },
      };
      expect(check(addition)).toEqual([]);
      const entry = pluginEntry({ ...plugin(), ...addition } as never, stateFolder(), 19230);
      expect(entry.config.at).toBe("http://127.0.0.1:19230/scripted/signin");
    });

    it("refuses each of the reviewer's alternate forms, written raw or under any kind", () => {
      const forms: Record<string, unknown>[] = [
        { url: "http:example.com" },
        { path: "../../outside" },
        { path: "../../.openclaw-other/agents" },
        { host: "example.com", port: 443, tls: true },
        { source: "${OPENAI_API_KEY}" },
        { run: "printf review" },
        { model_provider: "openai" },
      ];
      for (const form of forms) {
        // Raw, as a plain config object.
        refused({ ...base, settings: form }, /must be exactly \{ kind, value \}|not a plain key/);
        refused({ ...base, entry: { enabled: true, config: form } }, /may not set entry/);
        // Each string value under every kind, and the whole form as a value.
        for (const [key, value] of Object.entries(form)) {
          if (typeof value !== "string") continue;
          for (const kind of SETTING_KINDS) {
            const addition = { ...base, settings: { [key.replace("_", "")]: { kind, value } } };
            if (kind === "instance-path" && check(addition).length === 0) {
              // A plain name ("example.com", "openai") is only ever a file in the instance.
              const state = stateFolder();
              const setting = key.replace("_", "");
              const entry = pluginEntry({ ...plugin(), ...addition } as never, state, 19210);
              expect(entry.config[setting]).toBe(
                join(state, "clawtrate-plugin-data", "hello-tool", value),
              );
              continue;
            }
            refused(addition, new RegExp(`setting ${key.replace("_", "")} \\(${kind}\\)`));
          }
        }
        for (const kind of SETTING_KINDS) {
          refused({ ...base, settings: { form: { kind, value: form } } }, /setting form \(/);
        }
      }
      // The host form never reaches past loopback through the one kind with a host.
      refused(
        {
          ...base,
          settings: { host: { kind: "loopback-url", value: "https://example.com:443/" } },
        },
        /reaches beyond loopback: example\.com/,
      );
    });

    it("has no kind for a command, an argument list, a credential or a model provider", () => {
      for (const kind of [
        "command",
        "argv",
        "args",
        "shell",
        "credential",
        "secret",
        "model",
        "provider",
        "text",
        "string",
        "url",
        "path",
      ]) {
        refused({ ...base, settings: { x: { kind, value: "x" } } }, /which does not exist/);
      }
    });

    it("refuses unknown keys, loose values and URLs that are not loopback as written", () => {
      const cases: [unknown, RegExp][] = [
        [{ ...base, models: {} }, /the addition may not set models/],
        [{ ...base, plugin: "someone-else" }, /not the manifest's/],
        [
          { ...base, settings: { x: { kind: "flag", value: true, extra: 1 } } },
          /exactly \{ kind, value \}/,
        ],
        [{ ...base, settings: { "a.b": { kind: "flag", value: true } } }, /not a plain key/],
        [{ ...base, settings: { x: { kind: "count", value: -1 } } }, /\(count\)/],
        [{ ...base, settings: { x: { kind: "count", value: 1.5 } } }, /\(count\)/],
        [
          { ...base, settings: { x: { kind: "loopback-url", value: "http://localhost:9/" } } },
          /beyond loopback: localhost/,
        ],
        [
          { ...base, settings: { x: { kind: "loopback-url", value: "http://2130706433/" } } },
          /written as it parses/,
        ],
        [
          {
            ...base,
            settings: { x: { kind: "loopback-url", value: "http://127.0.0.1:9/${HOME}" } },
          },
          /written as it parses/,
        ],
        [
          { ...base, settings: { x: { kind: "loopback-url", value: "http://u:p@127.0.0.1/" } } },
          /carries credentials/,
        ],
        [
          { ...base, settings: { x: { kind: "loopback-url", value: "file:///etc/hosts" } } },
          /has protocol file:/,
        ],
        [
          { ...base, settings: { x: { kind: "loopback-url", value: "http://0.0.0.0:9/" } } },
          /beyond loopback/,
        ],
        [
          { ...base, settings: { x: { kind: "instance-path", value: "/etc/hosts" } } },
          /plain names inside/,
        ],
        [
          { ...base, settings: { x: { kind: "instance-path", value: "~/.openclaw" } } },
          /plain names inside/,
        ],
        [
          { ...base, settings: { x: { kind: "instance-path", value: "a/../../b" } } },
          /plain names inside/,
        ],
        [
          { ...base, settings: { x: { kind: "instance-path", value: ".hidden" } } },
          /plain names inside/,
        ],
        [{ ...base, settings: { x: { kind: "instance-path", value: "" } } }, /plain names inside/],
        [{ ...base, tools: ["hello_tool"] }, /must be exactly \{ name, kind \}/],
        [
          { ...base, tools: [{ name: "hello_tool", kind: "gateway-tool" }] },
          /only kind is plugin-tool/,
        ],
        [{ ...base, tools: [{ name: "coder__*", kind: "plugin-tool" }] }, /not a plain tool name/],
        [
          { ...base, tools: [{ name: "coder__run", kind: "plugin-tool" }] },
          /not a plain tool name/,
        ],
      ];
      for (const [addition, problem] of cases) refused(addition, problem);
      // No tool the gateway provides itself: allowed, denied or not offered.
      for (const name of ["exec", "process", "terminal", "browser", "secrets", "read", "gateway"]) {
        refused({ ...base, tools: [{ name, kind: "plugin-tool" }] }, /is the gateway's own/);
      }
    });

    it("refuses such a plugin at load time", () => {
      const { checkout, root } = checkoutWithFixture();
      writeFileSync(
        join(root, "hello-tool", ADDITION_FILE),
        JSON.stringify({ ...base, settings: { run: { kind: "command", value: "printf review" } } }),
      );
      expect(() => loadDevPlugin("hello-tool", checkout, PLUGIN_RULE)).toThrow(
        /is not one this guard accepts/,
      );
    });

    it("grants a plugin's hooks conversation access only as exactly declared, and writes it into its entry", () => {
      const hooks = { allowConversationAccess: true };
      expect(check({ ...base, hooks })).toEqual([]);
      for (const bad of [
        true,
        { allowConversationAccess: false },
        { allowPromptInjection: true },
        { ...hooks, allowPromptInjection: true },
      ]) {
        refused({ ...base, hooks: bad }, /hooks must be exactly/);
      }
      const { checkout, root } = checkoutWithFixture();
      const additionPath = join(root, "hello-tool", ADDITION_FILE);
      const addition = JSON.parse(readFileSync(additionPath, "utf8"));
      writeFileSync(additionPath, JSON.stringify({ ...addition, hooks }));
      const granted = loadDevPlugin("hello-tool", checkout, PLUGIN_RULE);
      expect(granted.conversationHooks).toBe(true);
      expect(pluginEntry(granted, stateFolder(), 9).hooks).toEqual(hooks);
      expect(pluginEntry(plugin(), stateFolder(), 9)).not.toHaveProperty("hooks");
    });

    it("keeps the development config's own plugin entries for itself", () => {
      expect(
        additionProblems({ plugin: "ollama" }, { manifestId: "ollama", ...PLUGIN_RULE }),
      ).toEqual(["plugin id ollama is the development config's own entry"]);
    });
  });

  it("says plainly, every time, that a plugin is trusted code", () => {
    const notice = trustedCodeNotice({ name: "hello-tool", digest: "sha256:0" });
    expect(notice).toContain("as trusted code");
    expect(notice).toContain("full access to files, processes and the network");
    expect(notice).toContain("not what plugin code does");
    expect(notice).toContain("Load only plugins from this repository that you have read.");
  });
});
