// The one sanctioned opening in the development config contract: the
// project's own OpenClaw plugins, loaded by name on a named instance.
//
//   pnpm dev-gateway start --instance <name> --with-plugin <plugin> [--with-plugin …]
//
// A plugin loaded this way is trusted code. It runs inside the gateway with
// the user's full access to files, processes and the network. The guard
// constrains the gateway's configuration and the tools bots are given, not
// what plugin code does. Load only plugins from this repository that you have
// read.
//
// Where it comes from. A name is accepted only if the plugin's real path is a
// direct child, with exactly that name, of the real path of the checkout's own
// `plugins/` folder; neither folder may be a link, and nothing inside the
// plugin may be anything but files and folders. The folder is read whole into
// memory when it is checked. That snapshot, not the source folder, is written
// into the instance's own state folder, its digest is recorded, and the
// gateway loads the copy and nothing else. A change to the source folder after
// the check cannot change what runs.
//
// What it may set. Beside its manifest (`openclaw.plugin.json`) a plugin has a
// contract addition (`clawtrate-dev-contract.json`), a closed description of
// the exact config keys it sets and the exact tools it turns on:
//
//   { "plugin": "<the manifest's id>",
//     "settings": { "<key>": { "kind": "<kind>", "value": … }, … },
//     "tools": [ { "name": "<tool>", "kind": "plugin-tool" }, … ] }
//
// The setting kinds are SETTING_KINDS and nothing else: there is no kind for
// free text, a command, an argument list, a credential or a model provider.
// Any other key or kind is refused. A `scripted-model-url` is a path on the
// instance's own scripted model, which is how a plugin reaches the scripted
// side (the scripted sign-ins) without knowing the ports a start chooses.
//
// Sign-ins. A plugin's manifest may declare providers and sign-in methods
// (`providers`, `providerAuthChoices`, `setup.providers`) only for the
// scripted account providers (accounts.ts), never a real provider's id, and
// the instance must then be started with `--with-accounts`. The manifest is
// checked; what the plugin's code does is trusted, as above.
//
// Browsers of their own. One plugin of an instance may also declare
// `botBrowsers`: which seeded bots get a managed browser of their own, and
// two timings, each from a closed set (BOT_BROWSER_CHOICES):
//
//   "botBrowsers": { "bots": ["marlow", "pip"], "drainTimeoutMs": 2000, "renewTimeoutMs": 6000 }
//
// The tool then writes the whole browser setup itself (see `browserConfig`
// in cli.ts): the browser tool for those bots only, one profile per bot on
// ports of the instance's own block, headless, and every connection the
// browser makes mapped to the instance's scripted pages on loopback.
//
// Conversation hooks. OpenClaw registers a plugin's prompt and conversation
// hooks (`before_prompt_build` and the like) only when its entry sets
// `hooks.allowConversationAccess: true`. A plugin that needs them says so,
// and that is the only hook policy an addition may set:
//
//   "hooks": { "allowConversationAccess": true }

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MANIFEST_FILE = "openclaw.plugin.json";
export const ADDITION_FILE = "clawtrate-dev-contract.json";
/** The folder in an instance's state folder its plugins are copied to and loaded from. */
export const PLUGIN_COPY_DIR = "clawtrate-plugins";
/** The folder in an instance's state folder an `instance-path` setting lies under. */
export const PLUGIN_DATA_DIR = "clawtrate-plugin-data";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY = /^[a-z][A-Za-z0-9]{0,63}$/;
const TOOL = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const MAX_FILES = 500;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * The kinds a setting may have. `flag` is true or false; `count` a whole
 * number; `loopback-url` an http or ws URL whose host is a loopback address,
 * written exactly as it parses; `instance-path` a relative path of plain
 * names, given to the plugin resolved inside the instance's state folder;
 * `scripted-model-url` an absolute path of plain names, given to the plugin
 * as that path on the instance's own scripted model (`http://127.0.0.1:<its
 * port><path>`).
 */
export const SETTING_KINDS = [
  "flag",
  "count",
  "loopback-url",
  "instance-path",
  "scripted-model-url",
] as const;
export type SettingKind = (typeof SETTING_KINDS)[number];
export type Setting = { kind: SettingKind; value: boolean | number | string };

export type PluginFile = { path: string; mode: number; bytes: Buffer };

/** The closed sets a `botBrowsers` declaration chooses from. */
export const BOT_BROWSER_CHOICES = {
  /** At most this many bots; each gets one port of the instance's block. */
  maxBots: 4,
  drainTimeoutMs: [2000, 5000, 15000],
  renewTimeoutMs: [6000, 10000, 20000],
} as const;

export type BotBrowsers = { bots: string[]; drainTimeoutMs: number; renewTimeoutMs: number };

/**
 * Why a `botBrowsers` declaration is not one this guard accepts, one line
 * per problem: exactly `bots`, `drainTimeoutMs` and `renewTimeoutMs`; bots
 * from the seeded bots, each once, at most `maxBots`; timings from their sets.
 */
export function botBrowsersProblems(value: unknown, seedBots: readonly string[]): string[] {
  if (!isPlainObject(value)) return ["botBrowsers must be an object"];
  const problems: string[] = [];
  if (Object.keys(value).sort().join() !== "bots,drainTimeoutMs,renewTimeoutMs") {
    problems.push("botBrowsers must be exactly { bots, drainTimeoutMs, renewTimeoutMs }");
  }
  const { bots } = value;
  if (
    !Array.isArray(bots) ||
    bots.length === 0 ||
    bots.length > BOT_BROWSER_CHOICES.maxBots ||
    new Set(bots).size !== bots.length ||
    !bots.every((bot) => typeof bot === "string" && seedBots.includes(bot))
  ) {
    problems.push(
      `botBrowsers.bots must be 1 to ${BOT_BROWSER_CHOICES.maxBots} different seeded bots (${seedBots.join(", ")})`,
    );
  }
  for (const key of ["drainTimeoutMs", "renewTimeoutMs"] as const) {
    const choices: readonly number[] = BOT_BROWSER_CHOICES[key];
    if (!choices.includes(value[key] as number)) {
      problems.push(`botBrowsers.${key} must be one of ${choices.join(", ")}`);
    }
  }
  return problems;
}

export type DevPlugin = {
  /** The folder name under plugins/. */
  name: string;
  /** The plugin id from its manifest; also its plugins.entries key. */
  id: string;
  /** The folder as checked, file by file. */
  files: PluginFile[];
  /** The digest of exactly those files (digestFiles). */
  digest: string;
  settings: Record<string, Setting>;
  tools: string[];
  /** The bots it gives a browser of their own, or null. */
  botBrowsers: BotBrowsers | null;
  /** Whether its entry lets its conversation hooks register. */
  conversationHooks: boolean;
  /** The scripted account providers its manifest declares sign-ins for. */
  providers: string[];
};

export type PluginRule = {
  /** Every tool the gateway itself provides; a plugin may not turn one on. */
  gatewayTools: readonly string[];
  /** Plugin ids the development config uses itself. */
  reserved: readonly string[];
  /** The seeded bots, the only ones a `botBrowsers` declaration may name. */
  seedBots: readonly string[];
  /** The only providers a plugin's manifest may declare: the scripted account providers. */
  scriptedProviders: readonly string[];
};

/**
 * The providers a manifest declares, and why it may not, one line per
 * problem: only scripted account providers, in `providers`,
 * `providerAuthChoices[].provider` and `setup.providers[].id`.
 */
export function manifestProviderProblems(
  manifest: Record<string, unknown>,
  scriptedProviders: readonly string[],
): { providers: string[]; problems: string[] } {
  const named: unknown[] = [];
  const problems: string[] = [];
  const list = (value: unknown, where: string): unknown[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      problems.push(`${where} must be a list`);
      return [];
    }
    return value;
  };
  named.push(...list(manifest.providers, "providers"));
  for (const choice of list(manifest.providerAuthChoices, "providerAuthChoices")) {
    named.push(isPlainObject(choice) ? choice.provider : choice);
  }
  if (manifest.setup !== undefined) {
    const setup = isPlainObject(manifest.setup) ? manifest.setup : {};
    for (const entry of list(setup.providers, "setup.providers")) {
      named.push(isPlainObject(entry) ? entry.id : entry);
    }
  }
  for (const key of ["providerAuthAliases", "modelCatalog", "providerEndpoints"]) {
    if (manifest[key] !== undefined) problems.push(`the manifest may not set ${key}`);
  }
  for (const provider of named) {
    if (typeof provider !== "string" || !scriptedProviders.includes(provider)) {
      problems.push(
        `provider ${JSON.stringify(provider)} is not a scripted account provider (${scriptedProviders.join(", ")})`,
      );
    }
  }
  return {
    providers: [...new Set(named.filter((p): p is string => typeof p === "string"))],
    problems,
  };
}

/** A checkout's own plugins folder. */
export const pluginsRoot = (checkout: string) => join(checkout, "plugins");

/** Where an instance loads a plugin from: its own copy. */
export const pluginCopy = (stateDir: string, name: string) => join(stateDir, PLUGIN_COPY_DIR, name);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const LOOPBACK_HOST = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

/** Why a setting is not a value of its declared kind, or null. */
function settingProblem(key: string, setting: unknown): string | null {
  if (!KEY.test(key)) return `setting ${JSON.stringify(key)} is not a plain key`;
  if (!isPlainObject(setting) || Object.keys(setting).sort().join() !== "kind,value") {
    return `setting ${key} must be exactly { kind, value }`;
  }
  const { kind, value } = setting;
  switch (kind) {
    case "flag":
      return typeof value === "boolean" ? null : `setting ${key} (flag) must be true or false`;
    case "count":
      return Number.isSafeInteger(value) && (value as number) >= 0
        ? null
        : `setting ${key} (count) must be a whole number`;
    case "loopback-url": {
      if (typeof value !== "string") return `setting ${key} (loopback-url) must be a URL`;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return `setting ${key} (loopback-url) is not a URL: ${value}`;
      }
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
        return `setting ${key} (loopback-url) has protocol ${url.protocol}`;
      }
      if (!LOOPBACK_HOST.test(url.hostname)) {
        return `setting ${key} (loopback-url) reaches beyond loopback: ${url.hostname}`;
      }
      if (url.username || url.password) return `setting ${key} (loopback-url) carries credentials`;
      // Written as it parses, so what the plugin reads is what was checked.
      if (url.href !== value || value.includes("$")) {
        return `setting ${key} (loopback-url) must be written as it parses: ${url.href}`;
      }
      return null;
    }
    case "instance-path": {
      if (typeof value !== "string") return `setting ${key} (instance-path) must be a path`;
      const segments = value.split("/");
      if (segments.length > 8 || !segments.every((segment) => PATH_SEGMENT.test(segment))) {
        return `setting ${key} (instance-path) must be plain names inside the instance, not ${JSON.stringify(value)}`;
      }
      return null;
    }
    case "scripted-model-url": {
      if (typeof value !== "string" || !value.startsWith("/")) {
        return `setting ${key} (scripted-model-url) must be a path starting with /`;
      }
      const segments = value.slice(1).split("/");
      if (segments.length > 8 || !segments.every((segment) => PATH_SEGMENT.test(segment))) {
        return `setting ${key} (scripted-model-url) must be plain names, not ${JSON.stringify(value)}`;
      }
      return null;
    }
    default:
      return `setting ${key} has kind ${JSON.stringify(kind)}, which does not exist (kinds: ${SETTING_KINDS.join(", ")})`;
  }
}

/**
 * Why an addition is not a closed description this guard accepts, one line
 * per problem: only `plugin`, `settings` and `tools`; every setting a plain
 * key with a value of a known kind; every tool a plain name of kind
 * `plugin-tool` that the gateway does not provide itself.
 */
export function additionProblems(
  addition: unknown,
  options: PluginRule & { manifestId: string },
): string[] {
  if (!isPlainObject(addition)) return ["the addition must be an object"];
  const problems: string[] = [];
  for (const key of Object.keys(addition)) {
    if (!["plugin", "settings", "tools", "botBrowsers", "hooks"].includes(key)) {
      problems.push(`the addition may not set ${key}`);
    }
  }
  if (addition.plugin !== options.manifestId) {
    problems.push(
      `the addition names plugin ${JSON.stringify(addition.plugin)}, not the manifest's ${JSON.stringify(options.manifestId)}`,
    );
  }
  if (options.reserved.includes(String(addition.plugin))) {
    problems.push(`plugin id ${String(addition.plugin)} is the development config's own entry`);
  }
  const settings = addition.settings ?? {};
  if (!isPlainObject(settings)) {
    problems.push("the addition's settings must be an object");
  } else {
    for (const [key, setting] of Object.entries(settings)) {
      const problem = settingProblem(key, setting);
      if (problem) problems.push(problem);
    }
  }
  const tools = addition.tools ?? [];
  if (!Array.isArray(tools)) {
    problems.push("the addition's tools must be a list");
  } else {
    for (const tool of tools) {
      if (!isPlainObject(tool) || Object.keys(tool).sort().join() !== "kind,name") {
        problems.push(`tool ${JSON.stringify(tool)} must be exactly { name, kind }`);
      } else if (tool.kind !== "plugin-tool") {
        problems.push(
          `tool ${JSON.stringify(tool.name)} has kind ${JSON.stringify(tool.kind)}; the only kind is plugin-tool`,
        );
      } else if (typeof tool.name !== "string" || !TOOL.test(tool.name)) {
        problems.push(`tool ${JSON.stringify(tool.name)} is not a plain tool name`);
      } else if (options.gatewayTools.includes(tool.name)) {
        problems.push(`tool ${tool.name} is the gateway's own, not one the plugin provides`);
      }
    }
  }
  if (addition.botBrowsers !== undefined) {
    problems.push(...botBrowsersProblems(addition.botBrowsers, options.seedBots));
  }
  if (
    addition.hooks !== undefined &&
    !(
      isPlainObject(addition.hooks) &&
      Object.keys(addition.hooks).join() === "allowConversationAccess" &&
      addition.hooks.allowConversationAccess === true
    )
  ) {
    problems.push('hooks must be exactly { "allowConversationAccess": true }');
  }
  return problems;
}

/** Read a folder whole, refusing links and anything but files and folders. */
function readFolder(dir: string, refuse: (why: string) => never): PluginFile[] {
  const files: PluginFile[] = [];
  let bytes = 0;
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel)).sort()) {
      const path = rel ? `${rel}/${entry}` : entry;
      const stat = lstatSync(join(dir, path));
      if (stat.isSymbolicLink()) refuse(`${path} is a link`);
      if (stat.isDirectory()) {
        walk(path);
      } else if (stat.isFile()) {
        const content = readFileSync(join(dir, path));
        bytes += content.length;
        files.push({ path, mode: stat.mode & 0o755, bytes: content });
      } else {
        refuse(`${path} is not a file or a folder`);
      }
      if (files.length > MAX_FILES || bytes > MAX_BYTES) refuse("the folder is too large");
    }
  };
  walk("");
  return files;
}

/** A digest of a plugin's files: their paths, modes and contents. */
export function digestFiles(files: readonly PluginFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`${file.path}\0${file.mode}\0${file.bytes.length}\0`);
    hash.update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** A real folder: present, not a link, and its real path is exactly `path`. */
function realFolder(path: string, refuse: (why: string) => never): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return refuse(`there is no folder ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse(`${path} is not a real folder`);
  if (realpathSync.native(path) !== path) refuse(`${path} is not a real folder by that name`);
}

/** Check the plugin `name` in the real folder `root` and take it into memory. */
function checkPlugin(name: string, root: string, rule: PluginRule): DevPlugin {
  const refuse = (why: string): never => {
    throw new Error(`plugin ${JSON.stringify(name)} is refused: ${why}`);
  };
  if (!NAME.test(name)) refuse("a plugin name is lowercase letters, digits and inner hyphens");
  realFolder(root, refuse);
  // Exactly that name among the folder's entries, as stored.
  if (!readdirSync(root).includes(name)) refuse(`there is no folder ${name} in ${root}`);
  const dir = join(root, name);
  realFolder(dir, refuse);
  const files = readFolder(dir, refuse);
  const json = (path: string): unknown => {
    const file = files.find((f) => f.path === path);
    if (!file) return refuse(`${path} is missing`);
    try {
      return JSON.parse(file.bytes.toString("utf8")) as unknown;
    } catch {
      return refuse(`${path} is not JSON`);
    }
  };
  const manifest = json(MANIFEST_FILE);
  const id =
    isPlainObject(manifest) && typeof manifest.id === "string"
      ? manifest.id
      : refuse(`${MANIFEST_FILE} has no id`);
  // The code it names to run is inside the folder.
  if (files.some((file) => file.path === "package.json")) {
    const pkg = json("package.json");
    const entries =
      isPlainObject(pkg) && isPlainObject(pkg.openclaw) ? pkg.openclaw.extensions : [];
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const path = typeof entry === "string" ? entry.replace(/^\.\//, "") : "";
      if (!files.some((file) => file.path === path)) {
        refuse(`package.json names ${JSON.stringify(entry)}, which is not a file in the plugin`);
      }
    }
  }
  const declared = manifestProviderProblems(
    manifest as Record<string, unknown>,
    rule.scriptedProviders,
  );
  if (declared.problems.length > 0) {
    refuse(
      `its manifest declares providers this guard does not accept:\n  - ${declared.problems.join("\n  - ")}`,
    );
  }
  const addition = json(ADDITION_FILE);
  const problems = additionProblems(addition, { manifestId: id, ...rule });
  if (problems.length > 0) {
    refuse(`its contract addition is not one this guard accepts:\n  - ${problems.join("\n  - ")}`);
  }
  const checked = addition as {
    settings?: Record<string, Setting>;
    tools?: { name: string }[];
    botBrowsers?: BotBrowsers;
    hooks?: { allowConversationAccess: true };
  };
  return {
    name,
    id,
    files,
    digest: digestFiles(files),
    settings: checked.settings ?? {},
    tools: (checked.tools ?? []).map((tool) => tool.name),
    botBrowsers: checked.botBrowsers ?? null,
    conversationHooks: checked.hooks?.allowConversationAccess === true,
    providers: declared.providers,
  };
}

/**
 * Check one plugin of a checkout by name and take it into memory, or throw
 * saying why it is refused. Nothing is read from the checkout after this.
 */
export function loadDevPlugin(name: string, checkout: string, rule: PluginRule): DevPlugin {
  let realCheckout: string;
  try {
    realCheckout = realpathSync.native(checkout);
  } catch {
    throw new Error(`plugin ${JSON.stringify(name)} is refused: there is no checkout ${checkout}`);
  }
  return checkPlugin(name, pluginsRoot(realCheckout), rule);
}

/**
 * Write the checked snapshot into the instance's state folder, then check
 * the copy is exactly what was checked. Returns the folder the gateway loads.
 */
export function copyPlugin(plugin: DevPlugin, stateDir: string, rule: PluginRule): string {
  const target = pluginCopy(stateDir, plugin.name);
  for (const file of plugin.files) {
    const path = join(target, file.path);
    const rel = relative(target, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`refusing to write ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    // wx: never through anything already there.
    writeFileSync(path, file.bytes, { mode: file.mode, flag: "wx" });
  }
  mkdirSync(pluginData(stateDir, plugin.name), { recursive: true });
  checkedCopy(plugin.name, plugin.digest, stateDir, rule);
  return target;
}

/**
 * The plugin as the instance's copy holds it, refused unless the copy is a
 * real folder whose digest is the recorded one.
 */
export function checkedCopy(
  name: string,
  digest: string,
  stateDir: string,
  rule: PluginRule,
): DevPlugin {
  const plugin = checkPlugin(name, join(realpathSync.native(stateDir), PLUGIN_COPY_DIR), rule);
  if (plugin.digest !== digest) {
    throw new Error(
      `plugin ${JSON.stringify(name)} is refused: its copy in the instance is ${plugin.digest}, not the ${digest} that was checked`,
    );
  }
  return plugin;
}

/** The folder a plugin's instance-path settings lie under. */
export const pluginData = (stateDir: string, name: string) => join(stateDir, PLUGIN_DATA_DIR, name);

/**
 * A plugin's config entry on an instance: each setting's value, a path
 * resolved inside it, a scripted-model path on the instance's scripted model.
 */
export function pluginEntry(
  plugin: DevPlugin,
  stateDir: string,
  providerPort: number,
): {
  enabled: true;
  config: Record<string, unknown>;
  hooks?: { allowConversationAccess: true };
} {
  const base = pluginData(stateDir, plugin.name);
  const config: Record<string, unknown> = {};
  for (const [key, { kind, value }] of Object.entries(plugin.settings)) {
    if (kind === "scripted-model-url") {
      if (!Number.isInteger(providerPort) || providerPort < 1 || providerPort > 65535) {
        throw new Error(`plugin ${plugin.name}: no scripted model port for ${key}`);
      }
      config[key] = `http://127.0.0.1:${providerPort}${String(value)}`;
      continue;
    }
    if (kind !== "instance-path") {
      config[key] = value;
      continue;
    }
    const path = resolve(base, String(value));
    const rel = relative(base, path);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`plugin ${plugin.name}: ${key} leaves the instance`);
    }
    config[key] = path;
  }
  return {
    enabled: true,
    config,
    ...(plugin.conversationHooks ? { hooks: { allowConversationAccess: true as const } } : {}),
  };
}

/** Plugins are for named instances only; the default instance never loads any. */
export function pluginSelectionProblem(instance: string | null, names: string[]): string | null {
  if (names.length === 0) return null;
  if (instance === null) return "the default instance never loads plugins; use --instance <name>";
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return `plugin ${name} is named twice`;
    seen.add(name);
  }
  return null;
}

/** The line printed every time a plugin is loaded. */
export function trustedCodeNotice(plugin: { name: string; digest: string }): string {
  return `Loading plugin ${plugin.name} (${plugin.digest}) as trusted code: it runs inside the gateway with your full access to files, processes and the network. The guard constrains the gateway's configuration and the tools bots are given, not what plugin code does. Load only plugins from this repository that you have read.`;
}
