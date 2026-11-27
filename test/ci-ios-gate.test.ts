// The iOS workflow runs on a pull request only when the pull request changes one of its
// pull_request paths. This checks those paths against the Simulator checks: every file the
// workflow's steps run, the app the build bundles, the checks in the Simulator folder, and every
// file those reach through imports or start by path (the development gateway and the scripts it
// starts). The walk stops at packages/: the workflow checks shared code once a day on main.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { reached, ROOT, tracked } from "./ci-gate.ts";

const yaml = createRequire(join(ROOT, "apps/desktop/package.json"))("js-yaml") as {
  load(text: string): unknown;
};

type Step = { uses?: string; run?: string };
const workflow = yaml.load(readFileSync(join(ROOT, ".github/workflows/ios.yml"), "utf8")) as {
  on: { pull_request: { paths: string[] }; schedule?: unknown[] };
  jobs: { simulator: { steps: Step[] } };
};
const PATHS = workflow.on.pull_request.paths;
const covered = new Set(tracked(...PATHS.map((path) => `:(glob)${path}`)));
const SCRIPTS = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<
  string,
  string
>;

/** The repository files a step's command runs: `node <file>`, or a root script that does. */
function runs(command: string): string[] {
  const files = [...command.matchAll(/\bnode (\S+\.ts)\b/g)].map((match) => match[1]!);
  for (const [, name] of command.matchAll(/\bpnpm (\S+)/g)) {
    const script = SCRIPTS[name!];
    if (script) files.push(...[...script.matchAll(/\bnode (\S+\.ts)\b/g)].map((m) => m[1]!));
  }
  return files;
}

const stepFiles = workflow.jobs.simulator.steps.flatMap((step) => runs(step.run ?? ""));
/** `pnpm mobile:check` runs Vitest in the Simulator folder, so every file there runs. */
const SIMULATOR = "apps/mobile/simulator";
/** `pnpm mobile:build` bundles the app from its package's entry. */
const APP_ENTRY = `apps/mobile/${JSON.parse(readFileSync(join(ROOT, "apps/mobile/package.json"), "utf8")).main}`;

/**
 * Files a reached file starts by path rather than imports: `new URL("./x.ts", import.meta.url)`,
 * or a string that is a tracked TypeScript file's path from the repository root (as in
 * `join(REPO, "tools/dev-gateway/src/cli.ts")`).
 */
function startedBy(file: string): string[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const found = [...text.matchAll(/new URL\(\s*"(\.{1,2}\/[^"]+\.m?ts)",\s*import\.meta\.url/g)]
    .map((match) => relative(ROOT, resolve(dirname(join(ROOT, file)), match[1]!)))
    .map((path) => path.split("\\").join("/"));
  for (const [, path] of text.matchAll(/"((?:apps|tools|e2e|plugins|scripts)\/[^"\s]+\.m?ts)"/g))
    found.push(path!);
  return found.filter((path) => tracked(path).length > 0);
}

/** Every file the checks reach outside packages/, following imports and files started by path. */
function reachedByChecks(): Set<string> {
  let entries = [...stepFiles, APP_ENTRY, ...tracked(SIMULATOR)];
  for (;;) {
    const files = reached(entries);
    const more = [...files].filter((file) => /\.m?ts$/.test(file)).flatMap(startedBy);
    const next = [...new Set([...entries, ...more])];
    if (next.length === entries.length) return files;
    entries = next;
  }
}

describe("the iOS workflow's gate", () => {
  it("runs on a pull request for its paths, and once a day on main", () => {
    expect(PATHS).toContain(".github/workflows/ios.yml");
    expect(PATHS).toContain("apps/mobile/**");
    expect(workflow.on.schedule?.length).toBeGreaterThan(0);
  });

  it("finds what the Simulator job runs", () => {
    expect(stepFiles).toContain("apps/mobile/scripts/build.ts");
    expect(stepFiles).toContain("apps/mobile/scripts/check.ts");
    expect(readFileSync(join(ROOT, "apps/mobile/scripts/check.ts"), "utf8")).toContain(
      '"../simulator"',
    );
    for (const file of stepFiles) expect(tracked(file), `${file} exists`).toEqual([file]);
    expect(tracked(APP_ENTRY)).toEqual([APP_ENTRY]);
  });

  it("follows the development gateway and the scripts it starts", () => {
    const files = reachedByChecks();
    for (const file of [
      "tools/dev-gateway/src/cli.ts",
      "tools/dev-gateway/src/seed-data.ts",
      "tools/dev-gateway/src/provider-main.ts",
      "tools/dev-gateway/src/coding-agent-mcp.ts",
    ])
      expect(files.has(file), file).toBe(true);
  });

  it("lists every file the checks reach outside apps/mobile/ and packages/", () => {
    const missing = [...reachedByChecks()].filter((file) => !covered.has(file));
    expect(missing, "files the Simulator checks use that ios.yml's paths leave out").toEqual([]);
  });

  it("lists the package of the development gateway, which pins its OpenClaw client", () => {
    expect(covered.has("tools/dev-gateway/package.json")).toBe(true);
  });

  it("lists no path that matches nothing", () => {
    for (const path of PATHS)
      expect(tracked(`:(glob)${path}`).length, `${path} matches a file`).toBeGreaterThan(0);
  });
});
