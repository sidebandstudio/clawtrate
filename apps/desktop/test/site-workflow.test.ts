// The Site workflow runs the feed assembler on a fresh runner with Node and
// no installed packages, and runs again when any file it loads changes. Both
// hold only while every file the assembler loads is listed in the workflow's
// push paths and none of them loads a package at run time.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const ASSEMBLER = "apps/desktop/packaging/site-feed.ts";
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/site.yml"), "utf8");
const yaml = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };

interface Workflow {
  on: Record<string, { branches?: string[]; tags?: string[]; "branches-ignore"?: string[] } | null>;
  jobs: Record<string, { if?: string; needs?: string; environment?: { name?: string } }>;
}

/**
 * Whether the workflow can deploy from a ref other than main: a trigger that
 * runs on a tag or another branch, or a job that is not limited to main.
 * The github-pages environment allows main only; the workflow keeps to it.
 */
function deploysOffMain(text: string): string[] {
  const flow = yaml.load(text) as Workflow;
  const problems: string[] = [];
  for (const [event, config] of Object.entries(flow.on)) {
    if (event === "workflow_dispatch") continue;
    if (event !== "push") problems.push(`runs on ${event}`);
    else if (config?.tags || config?.["branches-ignore"] || config?.branches?.join() !== "main")
      problems.push("runs on a push to another ref than main");
  }
  for (const [name, job] of Object.entries(flow.jobs))
    if (job.if !== "github.ref == 'refs/heads/main'")
      problems.push(`job ${name} is not limited to main`);
  return problems;
}

/** The specifiers a file loads when it runs: `import type` and `export type` load nothing. */
function runtimeImports(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(
    /^\s*(import|export)\s+(type\s+)?(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["'];?/gm,
  )) {
    if (!match[2]) found.push(match[3]!);
  }
  return found;
}

/** Every file the assembler loads, itself included, and every package any of them loads. */
function loaded(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [join(ROOT, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
      else if (!specifier.startsWith("node:"))
        packages.add(`${relative(ROOT, file)}: ${specifier}`);
    }
  }
  return { files: [...files].map((file) => relative(ROOT, file)).sort(), packages: [...packages] };
}

/** The workflow's `push` paths. */
function pushPaths(): string[] {
  const block = /\n {2}push:\n[\s\S]*?\n {4}paths:\n((?: {6}(?:- |# ).+\n)+)/.exec(WORKFLOW);
  if (!block) throw new Error("site.yml has no push paths");
  return [...block[1]!.matchAll(/- "([^"]+)"/g)].map((match) => match[1]!);
}

const covered = (file: string, path: string) =>
  path.endsWith("/**") ? file.startsWith(path.slice(0, -2)) : file === path;

describe("the Site workflow and the feed assembler", () => {
  it("runs the assembler with Node alone", () => {
    expect(WORKFLOW).toContain(`run: node ${ASSEMBLER} site _site`);
    expect(WORKFLOW).not.toMatch(/pnpm install|npm (ci|install)/);
  });

  it("loads no package at run time, so a runner with nothing installed can run it", () => {
    const { files, packages } = loaded(ASSEMBLER);
    expect(files).toContain("apps/desktop/packaging/feed.ts");
    expect(packages).toEqual([]);
  });

  it("deploys again when any file the assembler loads changes", () => {
    const paths = pushPaths();
    const missing = loaded(ASSEMBLER).files.filter(
      (file) => !paths.some((path) => covered(file, path)),
    );
    expect(missing).toEqual([]);
  });

  it("deploys only from main, the one ref the github-pages environment allows", () => {
    expect(deploysOffMain(WORKFLOW)).toEqual([]);
    expect((yaml.load(WORKFLOW) as Workflow).jobs.deploy!.environment?.name).toBe("github-pages");
  });

  it.each([
    [
      "a release trigger",
      (text: string) =>
        text.replace(
          "  workflow_dispatch:",
          "  release:\n    types: [published]\n  workflow_dispatch:",
        ),
    ],
    [
      "a tag push",
      (text: string) =>
        text.replace("    branches: [main]", '    branches: [main]\n    tags: ["v*"]'),
    ],
    [
      "another branch",
      (text: string) => text.replace("    branches: [main]", "    branches: [main, site]"),
    ],
    [
      "a deploy job open to any ref",
      (text: string) =>
        text.replace(/(name: Deploy to GitHub Pages\n {4}needs: build\n) {4}if: .*\n/, "$1"),
    ],
  ])("refuses %s", (_name, change) => {
    const changed = change(WORKFLOW);
    expect(changed).not.toBe(WORKFLOW);
    expect(deploysOffMain(changed)).not.toEqual([]);
  });
});
