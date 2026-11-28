// Our tests and tools never reach a machine-wide OpenClaw or its default state (#597). On a
// computer that runs its own gateway, the global package and `~/.openclaw` are the person's own.
// This scans the code that runs on a developer's machine or in CI for the ways to reach them.
// Each deliberate use is allowed below, with the reason it is safe.
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/** Shell and workflow files, where `~` means the home folder. */
const SHELL = /\.(?:sh|ya?ml)$/;

/** The ways code can reach a machine-wide OpenClaw or its state, and the files each applies to. */
export const PATTERNS: Record<string, { regex: RegExp; only?: RegExp }> = {
  "the global npm folder": {
    regex: /\bnpm\b["'\],\s[]*(?:root|prefix)\b["'\],\s]*(?:-g|--global)\b/,
  },
  "a PATH lookup of openclaw": { regex: /\b(?:which|command -v|type -p)\s+openclaw\b/ },
  // A command line's first word, after a workflow's `run:` or a shell's `;`, `&&`, `|`, `$(`.
  "openclaw run in a shell": {
    regex:
      /(?:^[ \t]*(?:-[ \t]*)?(?:run:[ \t]*)?|[;&|`(!][ \t]*|\$\([ \t]*|\b(?:then|do|if|exec|time|sudo|env)[ \t]+)openclaw(?=[ \t]|$)/m,
    only: SHELL,
  },
  "openclaw from PATH": {
    regex:
      /(?:\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(|\?\?|\bbin\s*[:=])\s*["'`]openclaw["'`]/,
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

/** Each place in a file's whole text that matches a pattern, with the line it starts on. A
 * pattern can span lines, as a call split over several does. */
export function scan(file: string, text: string): { pattern: string; line: number }[] {
  const found: { pattern: string; line: number }[] = [];
  for (const [pattern, { regex, only }] of Object.entries(PATTERNS)) {
    if (only && !only.test(file)) continue;
    for (const match of text.matchAll(new RegExp(regex.source, `${regex.flags}g`)))
      found.push({ pattern, line: text.slice(0, match.index).split("\n").length });
  }
  return found;
}

/** The patterns a file's text matches. */
export function matches(file: string, text: string): string[] {
  return [...new Set(scan(file, text).map((found) => found.pattern))];
}

/** Deliberate uses, by file and pattern, each with why it cannot reach a person's install. */
const ALLOWED: { file: string; pattern: string; reason: string }[] = [
  {
    file: "e2e-packaged/first-run/check.ts",
    pattern: "a PATH lookup of openclaw",
    reason:
      "checks absence before launching the app, after refusing to run outside a disposable GitHub-hosted Mac",
  },
  {
    file: ".github/workflows/setup-install.yml",
    pattern: "the default state folder",
    reason: "only checks absence on a disposable GitHub-hosted Mac before the install test",
  },
  {
    file: ".github/workflows/ci.yml",
    pattern: "the global npm folder",
    reason:
      "a GitHub-hosted runner is thrown away after the job, so its global copy is the pinned one",
  },
  {
    file: ".github/workflows/ios.yml",
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
    file: ".github/workflows/openclaw-latest.yml",
    pattern: "the global npm folder",
    reason:
      "a GitHub-hosted runner is thrown away after the job, so its global copy is the one the run installed",
  },
  {
    file: ".github/workflows/ci.yml",
    pattern: "openclaw run in a shell",
    reason:
      "`openclaw --version` on a GitHub-hosted runner, whose only OpenClaw is the pinned one it installed",
  },
  {
    file: ".github/workflows/openclaw-latest.yml",
    pattern: "openclaw run in a shell",
    reason:
      "`openclaw --version` on a GitHub-hosted runner, whose only OpenClaw is the one the run installed",
  },
  {
    file: ".github/workflows/openclaw-update.yml",
    pattern: "openclaw run in a shell",
    reason:
      "runs on a GitHub-hosted runner it updates OpenClaw on, always with a clawtrate-dev-<name> profile",
  },
  {
    file: "apps/desktop/test/ssh/harness.ts",
    pattern: "the default state folder",
    reason:
      "a stand-in openclaw run in the test sshd's session, whose HOME assertSessionHome proves is the test's own",
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
const CODE = /\.(?:[cm]?[jt]sx?|sh|ya?ml)$/;

/** A path with forward slashes, as the allow-list writes them, whatever the system's separator. */
export const posix = (path: string, separator = sep) => path.split(separator).join("/");
const SELF = posix(relative(ROOT, import.meta.filename));

/** The code files under `dir`. Links are not followed, so nothing outside the checkout is read. */
function files(root: string, dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [];
    // A package's own code (`packages/*/src`) is the app's; a tool's (`tools/*/src`) is scanned.
    if (SKIP.has(name) && !(name === "src" && !posix(relative(root, dir)).startsWith("packages")))
      return [];
    if (stat.isDirectory()) return files(root, path);
    return stat.isFile() && CODE.test(name) ? [path] : [];
  });
}

/** Every match in the scanned folders under `root`, with its file and line. */
export function findings(root = ROOT): { file: string; pattern: string; line: number }[] {
  const found: { file: string; pattern: string; line: number }[] = [];
  for (const dir of SCANNED)
    for (const path of files(root, join(root, dir))) {
      const file = posix(relative(root, path));
      if (file === SELF) continue;
      for (const match of scan(file, readFileSync(path, "utf8"))) found.push({ file, ...match });
    }
  return found;
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout of the test's own, with these files in it. */
function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "clawtrate-scan-"));
  temps.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
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
    // OpenClaw run straight from a shell, wherever a command can start.
    for (const line of [
      "openclaw status",
      "  openclaw gateway run --port 1",
      "      - run: openclaw --version",
      "set -e; openclaw status",
      "test -n x && openclaw status",
      "version=$(openclaw --version)",
      "if openclaw status; then :; fi",
    ])
      expect(flags(line, "run.sh"), line).toEqual(["openclaw run in a shell"]);
    expect(flags("openclaw status", "ci.yml")).toEqual(["openclaw run in a shell"]);
    // Only a shell runs a command line; in TypeScript these are words in a string.
    expect(flags(`it("openclaw status", () => {})`)).toEqual([]);
    expect(flags(`spawnSync("openclaw", ["status"])`)).toEqual(["openclaw from PATH"]);
    expect(flags(`const bin = process.env.OPENCLAW_BIN ?? "openclaw";`)).toEqual([
      "openclaw from PATH",
    ]);
    expect(flags(`new OpenclawRunner({ bin: "openclaw", stateDir })`)).toEqual([
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
      `bin: "/test/openclaw",`,
      "npm install --global openclaw@2026.10.6",
      'echo "the openclaw program"',
      '"$OPENCLAW_BIN" status',
      "pnpm dev-gateway start --instance alpha",
    ])
      for (const file of ["a.ts", "run.sh", "ci.yml"]) expect(flags(safe, file), safe).toEqual([]);
  });

  it("matches across lines, and names the line where a match starts", () => {
    const text = 'const dir = join(\n  execFileSync(\n    "npm",\n    ["root", "-g"],\n  ),\n);\n';
    expect(scan("a.ts", text)).toEqual([{ pattern: "the global npm folder", line: 3 }]);
  });

  it("scans every kind of code file it is given, in the folders that run, and follows no link", () => {
    const outside = checkout({ "secret.ts": 'spawnSync("openclaw", ["status"]);\n' });
    const root = checkout({
      "apps/desktop/test/probe.test.tsx": '\nspawnSync("openclaw", ["status"]);\n',
      "apps/desktop/test/probe.test.jsx": 'execFile("openclaw");\n',
      "tools/check/src/run.sh": "#!/bin/sh\nopenclaw status\n",
      "tools/check/src/notes.md": "openclaw status\n",
      "packages/core/src/look.ts": 'spawnSync("openclaw");\n',
      "apps/desktop/src/look.ts": 'spawnSync("openclaw");\n',
    });
    // A junction on Windows, which needs no symlink rights; a directory link elsewhere.
    symlinkSync(
      outside,
      join(root, "tools/linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(findings(root).sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: "apps/desktop/test/probe.test.jsx", pattern: "openclaw from PATH", line: 1 },
      { file: "apps/desktop/test/probe.test.tsx", pattern: "openclaw from PATH", line: 2 },
      { file: "tools/check/src/run.sh", pattern: "openclaw run in a shell", line: 2 },
    ]);
  });

  it("names files with forward slashes, as the allow-list does, on any system", () => {
    expect(posix("apps\\desktop\\test\\ssh\\harness.ts", "\\")).toBe(
      "apps/desktop/test/ssh/harness.ts",
    );
    expect(posix("apps/desktop/test/ssh/harness.ts", "/")).toBe("apps/desktop/test/ssh/harness.ts");
  });
});
