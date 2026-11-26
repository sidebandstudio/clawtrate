// The scenario-check job in ci.yml runs on a pull request only when the pull request changes a
// file the check uses: one of the changes job's SCENARIOS_PATHS (#693). This checks that list
// against `pnpm scenarios`: every file it reaches through imports, every plugin it loads and the
// OpenClaw pins of the code it runs. The import walk stops at packages/: the e2e job tests the
// app's own code on every change.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reached, ROOT, tracked } from "./ci-gate.ts";

const yaml = createRequire(join(ROOT, "apps/desktop/package.json"))("js-yaml") as {
  load(text: string): unknown;
};

type Job = {
  needs?: string | string[];
  if?: string;
  steps: { run?: string; env?: Record<string, string> }[];
};
const workflow = yaml.load(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};
const gate = workflow.jobs.changes!.steps.find((step) => step.env?.SCENARIOS_PATHS)!;
const SCENARIOS_PATHS = gate.env!.SCENARIOS_PATHS!.split("\n").filter(Boolean);
const covered = new Set(tracked(...SCENARIOS_PATHS.map((path) => `:(glob)${path}`)));

const ENTRY = "e2e/scenario-check.ts";
const SCRIPT = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.scenarios;

describe("the scenario check's gate", () => {
  it("runs the check when the changes job says so, and counts it in one check", () => {
    const job = workflow.jobs["scenario-check"]!;
    expect(job.if).toBe("needs.changes.outputs.scenarios == 'true'");
    expect(job.steps.map((step) => step.run).filter(Boolean)).toContain("pnpm scenarios");
    expect(SCRIPT).toBe(`node ${ENTRY}`);
    const aggregate = workflow.jobs.scenarios!;
    expect(aggregate.needs).toEqual(["changes", "scenario-check"]);
    expect(aggregate.if).toBe("always()");
  });

  it("lists every file the check reaches outside packages/", () => {
    const missing = [...reached([ENTRY])].filter((file) => !covered.has(file));
    expect(missing, "files pnpm scenarios uses that SCENARIOS_PATHS leaves out").toEqual([]);
  });

  it("lists every plugin the check loads", () => {
    const plugins = [
      ...readFileSync(join(ROOT, ENTRY), "utf8").matchAll(/"--with-plugin",\s*"([\w-]+)"/g),
    ].map((match) => match[1]!);
    expect(plugins.length).toBeGreaterThan(0);
    for (const plugin of plugins) {
      const files = tracked(`plugins/${plugin}`);
      expect(files.length, `plugins/${plugin} exists`).toBeGreaterThan(0);
      expect(
        files.filter((file) => !covered.has(file)),
        plugin,
      ).toEqual([]);
    }
  });

  it("lists the OpenClaw pins of the code the check runs", () => {
    for (const file of ["tools/dev-gateway/package.json", "packages/core/package.json"]) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).toContain('"@openclaw/gateway-client"');
      expect(covered.has(file), file).toBe(true);
    }
  });

  it("lists no path that matches nothing", () => {
    for (const path of SCENARIOS_PATHS)
      expect(tracked(`:(glob)${path}`).length, `${path} matches a file`).toBeGreaterThan(0);
  });
});
