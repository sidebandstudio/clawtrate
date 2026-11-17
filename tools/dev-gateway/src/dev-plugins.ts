// The one sanctioned opening in the development config contract: the
// project's own OpenClaw plugins, loaded by name on a named instance.
//
//   pnpm dev-gateway start --instance <name> --with-plugin <plugin> [--with-plugin …]
//
// A name is accepted only if it is a real folder (not a link) directly under
// the `plugins/` folder of the checkout that starts the instance, with an
// OpenClaw manifest (`openclaw.plugin.json`) and a contract addition beside it
// (`clawtrate-dev-contract.json`). The addition says exactly what the plugin
// turns on:
//
//   { "plugin": "<the manifest's id>",
//     "entry": { "enabled": true, "config": { … } },   // plugins.entries.<id>
//     "tools": ["<tool>", …] }                         // added to tools.allow
//
// The base contract (contract.ts) then includes the plugin's load path, its
// entry and its tools, and the guard compares the config with it as strictly
// as without plugins. Before that, `additionProblems` enforces a rule over
// every addition: it can never turn on a real model provider, the default
// profile, credentials from any profile, shell commands without asking, or
// network access beyond loopback.

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MANIFEST_FILE = "openclaw.plugin.json";
export const ADDITION_FILE = "clawtrate-dev-contract.json";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL = /^[a-z][a-z0-9_]*$/;

export type DevPlugin = {
  /** The folder name under plugins/. */
  name: string;
  /** Its real path. */
  dir: string;
  /** The plugin id from its manifest; also its plugins.entries key. */
  id: string;
  entry: Record<string, unknown>;
  tools: string[];
};

/** The folder a checkout's own plugins live in. */
export const pluginsRoot = (checkout: string) => join(checkout, "plugins");

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Keys an addition may never set anywhere, by what they would turn on. */
const FORBIDDEN_KEYS: [RegExp, string][] = [
  [/(api[-_]?key|token|secret|password|passwd|credential|cookie|oauth|auth)/i, "credentials"],
  [
    /^(exec|security|ask|elevated|shell|shellenv|command|commands|argv|safebins)$/i,
    "shell commands",
  ],
  [/^(model|models|provider|providers|fallbacks|primary)$/i, "a model provider"],
  [/^(profile|statedir|configpath|home)$/i, "another profile"],
];

const LOOPBACK_URL = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

/**
 * Why an addition breaks the rule for plugins, one line per problem. It may
 * set only its own plugin entry (`enabled` and `config`) and name tools; no
 * key or value in it may turn on a real model provider, the default profile,
 * credentials from any profile, shell commands without asking, or network
 * access beyond loopback, and no tool it names may be a denied one.
 */
export function additionProblems(
  addition: unknown,
  options: {
    pluginDir: string;
    manifestId: string;
    denied: readonly string[];
    reserved: readonly string[];
  },
): string[] {
  if (!isPlainObject(addition)) return ["the addition must be an object"];
  const problems: string[] = [];
  for (const key of Object.keys(addition)) {
    if (!["plugin", "entry", "tools"].includes(key))
      problems.push(`the addition may not set ${key}`);
  }
  if (addition.plugin !== options.manifestId) {
    problems.push(
      `the addition names plugin ${JSON.stringify(addition.plugin)}, not the manifest's ${JSON.stringify(options.manifestId)}`,
    );
  }
  if (options.reserved.includes(String(addition.plugin))) {
    problems.push(`plugin id ${String(addition.plugin)} is the development config's own entry`);
  }
  const entry = addition.entry;
  if (!isPlainObject(entry)) {
    problems.push("the addition's entry must be an object");
  } else {
    for (const key of Object.keys(entry)) {
      if (key !== "enabled" && key !== "config")
        problems.push(`the entry may set only enabled and config, not ${key}`);
    }
    if (entry.enabled !== undefined && entry.enabled !== true)
      problems.push("the entry's enabled must be true");
    problems.push(...valueProblems(entry, "entry", options.pluginDir));
  }
  const tools = addition.tools;
  if (!Array.isArray(tools)) {
    problems.push("the addition's tools must be a list");
  } else {
    for (const tool of tools) {
      if (typeof tool !== "string" || !TOOL.test(tool)) {
        problems.push(`tool ${JSON.stringify(tool)} is not a plain tool name (no wildcards)`);
      } else if (options.denied.includes(tool) || ["exec", "process", "terminal"].includes(tool)) {
        problems.push(`tool ${tool} is denied on a development gateway`);
      }
    }
  }
  return problems;
}

function valueProblems(value: unknown, path: string, pluginDir: string): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, i) => valueProblems(item, `${path}[${i}]`, pluginDir));
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, item]) => {
      const forbidden = FORBIDDEN_KEYS.find(([pattern]) => pattern.test(key));
      const here = `${path}.${key}`;
      return [
        ...(forbidden ? [`${here} would turn on ${forbidden[1]}`] : []),
        ...valueProblems(item, here, pluginDir),
      ];
    });
  }
  if (typeof value !== "string") return [];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !LOOPBACK_URL.test(value)) {
    return [`${path} reaches beyond loopback: ${value}`];
  }
  if (/(^|[\\/~])\.openclaw($|[\\/])/.test(value)) return [`${path} names the default profile`];
  if (/^OPENCLAW_|^[A-Z][A-Z0-9_]*_(KEY|TOKEN|SECRET)$/.test(value))
    return [`${path} names credentials from the environment`];
  if (value.startsWith("~") || isAbsolute(value)) {
    const rel = relative(pluginDir, resolve(value));
    if (value.startsWith("~") || rel.startsWith("..") || isAbsolute(rel)) {
      return [`${path} is a path outside the plugin's own folder: ${value}`];
    }
  }
  return [];
}

/**
 * Load one plugin of the checkout by name, or throw saying why it is refused.
 * `root` is the checkout's plugins folder.
 */
export function loadDevPlugin(
  name: string,
  root: string,
  options: { denied: readonly string[]; reserved: readonly string[] },
): DevPlugin {
  const refuse = (why: string): never => {
    throw new Error(`plugin ${JSON.stringify(name)} is refused: ${why}`);
  };
  if (!NAME.test(name)) refuse("a plugin name is lowercase letters, digits and inner hyphens");
  const realRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      return refuse(`there is no ${root} folder in this checkout`);
    }
  })();
  const dir = join(root, name);
  const stat = (() => {
    try {
      return lstatSync(dir);
    } catch {
      return refuse(`there is no folder ${name} in ${root}`);
    }
  })();
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse(`${dir} is not a real folder`);
  const realDir = realpathSync(dir);
  if (dirname(realDir) !== realRoot) refuse(`${dir} is not directly under ${root}`);
  const readJson = (file: string): unknown => {
    const path = join(realDir, file);
    try {
      if (!lstatSync(path).isFile()) refuse(`${file} is not a regular file`);
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("plugin ")) throw error;
      return refuse(`${file} is missing or not JSON`);
    }
  };
  const manifest = readJson(MANIFEST_FILE);
  const id =
    isPlainObject(manifest) && typeof manifest.id === "string"
      ? manifest.id
      : refuse(`${MANIFEST_FILE} has no id`);
  const addition = readJson(ADDITION_FILE);
  const problems = additionProblems(addition, { pluginDir: realDir, manifestId: id, ...options });
  if (problems.length > 0)
    refuse(`its contract addition breaks the rule for plugins:\n  - ${problems.join("\n  - ")}`);
  const checked = addition as { entry: Record<string, unknown>; tools: string[] };
  return { name, dir: realDir, id, entry: checked.entry, tools: [...checked.tools] };
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
