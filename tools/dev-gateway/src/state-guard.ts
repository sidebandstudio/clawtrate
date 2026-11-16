// Ownership of the development gateway's state folder. OpenClaw loads a
// profile's own `.env` and auth stores at startup, after our environment
// allowlist has been applied, so the folder must be one this tool created and
// must not hold anything that could carry credentials.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Written when this tool creates the state folder. */
export const MARKER_FILE = ".clawtrate-dev-gateway";

/** Files OpenClaw reads credentials or settings from. This tool creates none of them. */
export const FOREIGN_FILES = [
  ".env",
  "auth-profiles.json",
  "auth.json",
  "auth-state.json",
  "oauth.json",
  "credentials.json",
] as const;

const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Create the state folder with its ownership marker. Refuses an existing folder. */
export function createStateDir(stateDir: string, now = new Date()): void {
  if (existsSync(stateDir)) throw new Error(`${stateDir} already exists`);
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(
    join(stateDir, MARKER_FILE),
    `${JSON.stringify({ createdBy: "clawtrate tools/dev-gateway", createdAt: now.toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function findFiles(dir: string, names: ReadonlySet<string>, depth: number, found: string[]): void {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findFiles(join(dir, entry.name), names, depth - 1, found);
    } else if (names.has(entry.name)) {
      found.push(join(dir, entry.name));
    }
  }
}

/** What is wrong with the state folder, or [] when it is absent or ours and clean. */
export function stateDirProblems(stateDir: string): string[] {
  if (!existsSync(stateDir)) return [];
  const problems: string[] = [];
  if (!existsSync(join(stateDir, MARKER_FILE))) {
    problems.push(`${stateDir} was not created by the dev-gateway tool`);
  }
  const found: string[] = [];
  findFiles(stateDir, new Set(FOREIGN_FILES), 8, found);
  for (const file of found.sort()) {
    problems.push(`${relative(stateDir, file)} could load settings or credentials`);
  }
  return problems;
}

export function assertStateDirOwned(stateDir: string): void {
  const problems = stateDirProblems(stateDir);
  if (problems.length > 0) {
    throw new Error(
      `refusing to use the development gateway state:\n  - ${problems.join("\n  - ")}\n` +
        "Run `pnpm dev-gateway reset` to delete it and start clean.",
    );
  }
}
