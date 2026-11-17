// Where a bot's account store is, and whether a command may touch it.
//
// OpenClaw 2026.10.6 resolves a bot's account store from the config it reads
// at that moment: `agents.entries.<bot>.agentDir` when configured, otherwise
// `<state>/agents/<bot>/agent`; and every store is read together with the
// shared one, `<state>/agents/main/agent` (`resolveEffectiveAgentDir` and
// `resolveSharedMainAuthAgentDir`). The `lock` and `unlock` subcommands run the
// gateway's own `models auth order` on such a store, so before they run
// anything they check, from the instance's current config, that every store
// the config can name lies inside the instance's own state folder, through
// no link.

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** The files of an account store, inside its folder. */
const STORE_FILES = [
  "openclaw-agent.sqlite",
  "openclaw-agent.sqlite-wal",
  "openclaw-agent.sqlite-shm",
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Why a store folder is not inside the state folder through real folders
 * only, or null. Parts that do not exist yet are fine: OpenClaw creates them
 * inside the last real folder.
 */
function storeFolderProblem(stateDir: string, dir: string, what: string): string | null {
  if (!isAbsolute(dir) || resolve(dir) !== dir) {
    return `${what} is ${JSON.stringify(dir)}, not an absolute, plain path`;
  }
  const rel = relative(stateDir, dir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return `${what} ${dir} is outside the instance's state folder ${stateDir}`;
  }
  let current = stateDir;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    const stat = lstatOrNull(current);
    if (stat === null) return null;
    if (stat.isSymbolicLink()) return `${what} passes through a link, ${current}`;
    if (!stat.isDirectory()) return `${what} passes through ${current}, which is not a folder`;
  }
  for (const file of STORE_FILES) {
    const stat = lstatOrNull(join(dir, file));
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
      return `${what} has ${join(dir, file)}, which is not a plain file`;
    }
  }
  return null;
}

/**
 * Every reason the account stores a command for `bot` would touch, as the
 * instance's current config names them, are not inside `stateDir` through no
 * link. Every configured `agentDir` is checked, the bot's own store and the
 * shared one. An empty list means the command may run.
 */
export function accountStoreProblems(stateDir: string, config: unknown, bot: string): string[] {
  const state = lstatOrNull(stateDir);
  if (!state || state.isSymbolicLink() || !state.isDirectory()) {
    return [`the state folder ${stateDir} is not a real folder`];
  }
  if (realpathSync.native(stateDir) !== stateDir) {
    return [`the state folder ${stateDir} is not a real folder by that name`];
  }
  if (!isPlainObject(config)) return ["the config is not an object"];
  const problems: string[] = [];
  const agents = config.agents ?? {};
  if (!isPlainObject(agents)) return ["agents is not an object"];
  const defaults = agents.defaults ?? {};
  if (!isPlainObject(defaults) || defaults.agentDir !== undefined) {
    problems.push("agents.defaults may not name an agentDir");
  }
  const entries = agents.entries ?? {};
  if (!isPlainObject(entries)) return [...problems, "agents.entries is not an object"];
  let botDir = join(stateDir, "agents", bot, "agent");
  for (const [id, entry] of Object.entries(entries)) {
    if (!isPlainObject(entry)) {
      problems.push(`agents.entries.${id} is not an object`);
      continue;
    }
    if (entry.agentDir === undefined) continue;
    if (typeof entry.agentDir !== "string") {
      problems.push(`agents.entries.${id}.agentDir is not a path`);
      continue;
    }
    const problem = storeFolderProblem(stateDir, entry.agentDir, `agents.entries.${id}.agentDir`);
    if (problem) problems.push(problem);
    // OpenClaw matches a bot's entry by its normalised id.
    if (id.trim().toLowerCase() === bot) botDir = entry.agentDir;
  }
  for (const [what, dir] of [
    [`${bot}'s account store`, botDir],
    ["the shared account store", join(stateDir, "agents", "main", "agent")],
  ] as const) {
    const problem = storeFolderProblem(stateDir, dir, what);
    if (problem && !problems.includes(problem)) problems.push(problem);
  }
  return problems;
}
