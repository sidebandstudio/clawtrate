// Our tests and tools never reach a machine-wide OpenClaw or its default state (#597). On a
// computer that runs its own gateway, the global package and `~/.openclaw` are the person's own.
// This scans the code that runs on a developer's machine or in CI for the ways to reach them.
// Each deliberate use is allowed below, with the reason it is safe.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/** Shell and workflow files, where `~` means the home folder. */
const SHELL = /\.(?:sh|ya?ml)$/;

/** The ways code can reach a machine-wide OpenClaw or its state, and the files each applies to. */
export const PATTERNS: Record<string, { regex: RegExp; only?: RegExp }> = {
  "the global npm folder": {
    regex: /\bnpm\b["'\],\s[]*(?:root|prefix)\b["'\],\s]*(?:-g|--global)\b/,
  },
  "a PATH lookup of openclaw": { regex: /\b(?:which|command -v|type -p)\s+openclaw\b/ },
  "openclaw from PATH": {
    regex:
      /(?:\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(|\?\?)\s*["'`]openclaw["'`]/,
  },
  "a system install of openclaw": {
    regex: /(?:\/opt\/homebrew|\/usr\/local)\/(?:bin\/openclaw\b|lib\/node_modules\/openclaw\b)/,
  },
  "the default state folder": {
    regex: /homedir\(\)[^;\n]*["'`]\.openclaw["'`/]|\$\{?HOME\}?\/\.openclaw(?![-\w])/,
  },
  "the default state folder, in a shell": {
    regex: /(?:^|[\s"'=:(])~\/\.openclaw(?![-\w])/,
    only: SHELL,
  },
  "a fallback for OPENCLAW_PACKAGE_DIR": {
    regex: /OPENCLAW_PACKAGE_DIR\s*(?:\?\?|\|\|)(?!\s*(?:""|''|``))/,
  },
};

/** The patterns a line of a file matches. */
export function matches(file: string, text: string): string[] {
  return Object.entries(PATTERNS)
    .filter(([, { regex, only }]) => (!only || only.test(file)) && regex.test(text))
    .map(([name]) => name);
}

/** Deliberate uses, by file and pattern, each with why it cannot reach a person's install. */
const ALLOWED: { file: string; pattern: string; reason: string }[] = [
  {
    file: ".github/workflows/ci.yml",
    pattern: "the global npm folder",
    reason:
      "a GitHub-hosted runner is thrown away after the job, so its global copy is the pinned one",
  },
  {
    file: ".github/workflows/openclaw-update.yml",
    pattern: "the global npm folder",
    reason:
      "a GitHub-hosted runner is thrown away after the job, so its global copy is the pinned one",
  },
  {
    file: "apps/desktop/test/ssh/harness.ts",
    pattern: "the default state folder",
    reason:
      "a stand-in openclaw run in the test sshd's session, whose HOME assertSessionHome proves is the test's own",
  },
  {
    file: "tools/dev-gateway/src/env.ts",
    pattern: "openclaw from PATH",
    reason:
      "the development gateway runs OpenClaw only with --dev or --profile clawtrate-dev-<name> (guardArgs), never the default profile or its state",
  },
  {
    file: "tools/openclaw-update-check/src/check.ts",
    pattern: "openclaw from PATH",
    reason:
      "refusalToRun stops it off a GitHub-hosted runner and with any profile but clawtrate-dev-<name>",
  },
  {
    file: "tools/openclaw-update-check/src/engine.ts",
    pattern: "openclaw from PATH",
    reason:
      "refusalToRun stops it off a GitHub-hosted runner and with any profile but clawtrate-dev-<name>",
  },
  {
    file: "apps/desktop/test/fixtures/local-gateway.ts",
    pattern: "a system install of openclaw",
    reason: "it names the Homebrew copy only to refuse it as OPENCLAW_BIN",
  },
  {
    file: "apps/desktop/test/setup-stand-in.test.ts",
    pattern: "a system install of openclaw",
    reason: "a path a stand-in reports; nothing runs or reads it",
  },
  {
    file: "e2e/setup.spec.ts",
    pattern: "a system install of openclaw",
    reason: "a path written into the sandbox the app looks in; nothing runs or reads it",
  },
];

/** Where code runs on a developer's machine or in CI. The app's own code is not scanned: it looks
 * for the person's OpenClaw on purpose, and its tests run it in a sandbox. */
const SCANNED = [
  "apps/desktop/test",
  "apps/desktop/scripts",
  "apps/mobile/test",
  "apps/mobile/scripts",
  "apps/mobile/simulator",
  "packages",
  "tools",
  "e2e",
  "e2e-packaged",
  "e2e-updates",
  "visual",
  "test",
  "plugins",
  "scripts",
  ".github/workflows",
];
const SKIP = new Set(["node_modules", "dist", "build", ".run", "baselines", "src"]);
const CODE = /\.(?:[cm]?[jt]s|sh|ya?ml)$/;
const SELF = relative(ROOT, import.meta.filename);

function files(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    // A package's own code (`packages/*/src`) is the app's; a tool's (`tools/*/src`) is scanned.
    if (SKIP.has(name) && !(name === "src" && !relative(ROOT, dir).startsWith("packages")))
      return [];
    if (statSync(path).isDirectory()) return files(path);
    return CODE.test(name) ? [path] : [];
  });
}

/** Every line that matches a pattern, as "file: pattern". */
export function findings(root = ROOT): { file: string; pattern: string; line: number }[] {
  const found: { file: string; pattern: string; line: number }[] = [];
  for (const dir of SCANNED)
    for (const path of files(join(root, dir))) {
      const file = relative(root, path);
      if (file === SELF) continue;
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((text, index) => {
          for (const pattern of matches(file, text)) found.push({ file, pattern, line: index + 1 });
        });
    }
  return found;
}

describe("no test or tool reaches a machine-wide OpenClaw (#597)", () => {
  it("finds no fallback to one but the uses allowed, each for its reason", () => {
    const allowed = (f: { file: string; pattern: string }) =>
      ALLOWED.some((a) => a.file === f.file && a.pattern === f.pattern);
    const found = findings();
    expect(
      found.filter((f) => !allowed(f)).map((f) => `${f.file}:${f.line}: ${f.pattern}`),
    ).toEqual([]);
    // An allowed use that is gone is taken off the list.
    expect(
      ALLOWED.filter((a) => !found.some((f) => f.file === a.file && f.pattern === a.pattern)).map(
        (a) => `${a.file}: ${a.pattern}`,
      ),
    ).toEqual([]);
  });

  it("knows the fallbacks it looks for, and lets a development profile through", () => {
    const flags = (text: string, file = "a.ts") => matches(file, text);
    expect(
      flags(`join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "openclaw")`),
    ).toEqual(["the global npm folder"]);
    expect(flags("dir=$(npm root --global)/openclaw")).toEqual(["the global npm folder"]);
    expect(flags("bin=$(which openclaw)")).toEqual(["a PATH lookup of openclaw"]);
    expect(flags(`spawnSync("openclaw", ["status"])`)).toEqual(["openclaw from PATH"]);
    expect(flags(`const bin = process.env.OPENCLAW_BIN ?? "openclaw";`)).toEqual([
      "openclaw from PATH",
    ]);
    expect(flags("/opt/homebrew/bin/openclaw gateway status")).toEqual([
      "a system install of openclaw",
    ]);
    expect(flags(`readFileSync(join(homedir(), ".openclaw", "openclaw.json"))`)).toEqual([
      "the default state folder",
    ]);
    expect(flags('cat "$HOME/.openclaw/openclaw.json"')).toEqual(["the default state folder"]);
    expect(flags("cat ~/.openclaw/openclaw.json", "run.sh")).toEqual([
      "the default state folder, in a shell",
    ]);
    // In a TypeScript string, `~` is a letter: nothing expands it.
    expect(flags(`it("no program and no ~/.openclaw", () => {})`)).toEqual([]);
    expect(flags("const dir = process.env.OPENCLAW_PACKAGE_DIR ?? globalDir();")).toEqual([
      "a fallback for OPENCLAW_PACKAGE_DIR",
    ]);
    for (const safe of [
      `const dir = process.env.OPENCLAW_PACKAGE_DIR ?? "";`,
      `join(homedir(), ".openclaw-dev")`,
      `join(homedir(), ".openclaw-clawtrate-dev-alpha")`,
      "ls ~/.openclaw-dev",
      'rm -rf "$HOME/.openclaw-clawtrate-dev-alpha"',
      `["--profile", "clawtrate-dev-alpha", "devices", "list"]`,
      "npm install --global openclaw@2026.10.6",
    ])
      expect(flags(safe), safe).toEqual([]);
  });
});
