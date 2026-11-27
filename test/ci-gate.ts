// What ci.yml's path gates are checked against: tracked files, and the files code reaches
// through its relative imports. Shared by test/ci-macos-gate.test.ts and
// test/ci-scenarios-gate.test.ts.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

export const ROOT = join(import.meta.dirname, "..");

export function tracked(...pathspecs: string[]): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], { cwd: ROOT });
  return out.toString("utf8").split("\0").filter(Boolean);
}

/** A relative import's file: the specifier as written, or with a TypeScript extension. */
function resolveImport(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.m?js$/, "");
  return [base, `${stem}.ts`, `${stem}.tsx`, join(base, "index.ts")].find(
    (file) => existsSync(file) && statSync(file).isFile(),
  );
}

/**
 * The files `entries` reach through relative imports. The walk stops at packages/: each gate
 * says why its job need not run for a change to shared code.
 */
export function reached(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    // Git's paths use forward slashes on every system.
    const path = relative(ROOT, file).split(sep).join("/");
    if (seen.has(path) || path.startsWith("packages/")) return;
    seen.add(path);
    if (!/\.(ts|tsx|mts)$/.test(file)) return;
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of importedFiles) {
      if (!fileName.startsWith(".")) continue;
      const target = resolveImport(file, fileName);
      if (target) visit(target);
    }
  };
  for (const entry of entries) visit(join(ROOT, entry));
  return seen;
}
