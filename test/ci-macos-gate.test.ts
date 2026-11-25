// The macos job in ci.yml runs on a pull request only when the pull request changes a file the
// job uses: one of the changes job's MACOS_PATHS (#392). This checks that list against the job's
// steps. Each step says here what it uses, and every file it reaches through imports from there
// must be in the list. A step added to the job fails this test until it is named here.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { MACOS_SPECS } from "../playwright.visual.config.ts";

const ROOT = join(import.meta.dirname, "..");
const yaml = createRequire(join(ROOT, "apps/desktop/package.json"))("js-yaml") as {
  load(text: string): unknown;
};

type Step = { uses?: string; run?: string; env?: Record<string, string> };
type Job = { if?: string; steps: Step[] };
const workflow = yaml.load(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};
const macos = workflow.jobs.macos!;
const gate = workflow.jobs.changes!.steps.find((step) => step.env?.MACOS_PATHS)!;
const MACOS_PATHS = gate.env!.MACOS_PATHS!.split("\n").filter(Boolean);

/** The built app, from the entries electron-vite builds for main and preload. */
const APP = [
  "apps/desktop/package.json",
  "apps/desktop/electron.vite.config.ts",
  "apps/desktop/src/main/index.ts",
  "apps/desktop/src/setup/settings-parse.ts",
  "apps/desktop/src/preload/index.ts",
];

/**
 * What each step uses besides the test files its command names. A path may be a folder. The
 * screenshot step's pictures draw the whole interface; a change to it redraws their Linux twins,
 * which the changes job also counts, so the interface's own files are not listed for it.
 */
const STEPS: { step: string; uses: string[] }[] = [
  { step: "actions/checkout", uses: [] },
  { step: "pnpm/action-setup", uses: ["package.json"] },
  { step: "actions/setup-node", uses: ["pnpm-lock.yaml"] },
  {
    step: "pnpm install --frozen-lockfile",
    uses: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/desktop/package.json"],
  },
  {
    step: "vitest run apps/desktop/test/update/mac-inspection.test.ts",
    uses: ["vitest.config.ts", "apps/desktop/packaging/mac"],
  },
  { step: "sudo -n chown root", uses: [] },
  {
    step: "vitest run apps/desktop/test/settings-reader.test.ts",
    uses: ["vitest.config.ts", "apps/desktop/packaging/mac"],
  },
  { step: "require('electron')", uses: ["apps/desktop/package.json"] },
  {
    step: "vitest run apps/desktop/test/update/asar-trees.test.ts",
    uses: ["vitest.config.ts", "apps/desktop/test/update/asar-trees.electron.ts"],
  },
  { step: "npm install --global openclaw@", uses: [] },
  { step: "sudo -n -u nobody", uses: [] },
  {
    step: "CLAWTRATE_LOCAL_GATEWAY=1 pnpm exec vitest run",
    uses: ["vitest.config.ts", "apps/desktop/packaging/mac"],
  },
  { step: "playwright install chromium", uses: ["pnpm-lock.yaml"] },
  {
    step: "pnpm visual",
    uses: ["playwright.visual.config.ts", ...MACOS_SPECS, "visual/baselines/darwin"],
  },
  { step: "actions/upload-artifact", uses: [] },
  {
    step: "pnpm test:desktop-updates",
    uses: ["playwright.updates.config.ts", "e2e-updates", ...APP],
  },
  {
    step: "pnpm package:mac",
    uses: [
      ...APP,
      "apps/desktop/packaging",
      "apps/desktop/resources",
      "assets/brand/logo.png",
      "assets/brand/generated.json",
    ],
  },
];

function tracked(...pathspecs: string[]): string[] {
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
 * The files `entries` reach through relative imports. The walk stops at packages/: shared code
 * holds no macOS code, and the Linux and Windows jobs test it on every change.
 */
function reached(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    const path = relative(ROOT, file);
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

describe("the macos job's gate", () => {
  it("runs the job when the changes job says so", () => {
    expect(macos.if).toBe("needs.changes.outputs.macos == 'true'");
  });

  it("names what each of the job's steps uses", () => {
    for (const step of macos.steps) {
      const text = step.uses ?? step.run ?? "";
      const named = STEPS.filter((entry) => text.includes(entry.step));
      expect(named.length, `the macos step "${text.split("\n")[0]}" is named here once`).toBe(1);
    }
    for (const entry of STEPS) {
      const steps = macos.steps.filter((step) =>
        (step.uses ?? step.run ?? "").includes(entry.step),
      );
      expect(steps.length, `"${entry.step}" names one step of the macos job`).toBe(1);
    }
  });

  it("lists every file the job's steps use", () => {
    const covered = new Set(tracked(...MACOS_PATHS.map((path) => `:(glob)${path}`)));
    const missing = new Set<string>();
    for (const entry of STEPS) {
      const step = macos.steps.find((each) => (each.uses ?? each.run ?? "").includes(entry.step))!;
      const tests = (step.run ?? "").match(/\S+\.test\.ts/g) ?? [];
      const files = entry.uses.flatMap((path) => {
        const found = tracked(path);
        expect(found.length, `${path}, which "${entry.step}" uses, exists`).toBeGreaterThan(0);
        return found;
      });
      for (const file of reached([...tests, ...files]))
        if (!covered.has(file)) missing.add(`${file} (${entry.step})`);
    }
    expect([...missing], "files the macos job uses that MACOS_PATHS leaves out").toEqual([]);
  });

  it("lists no path that matches nothing", () => {
    for (const path of MACOS_PATHS)
      expect(tracked(`:(glob)${path}`).length, `${path} matches a file`).toBeGreaterThan(0);
  });
});
