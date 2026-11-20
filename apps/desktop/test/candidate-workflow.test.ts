import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("runs release assembly only by hand with read access and retains only workflow artifacts", () => {
  const raw = readFileSync(
    new URL("../../../.github/workflows/release-candidate.yml", import.meta.url),
    "utf8",
  );
  const yaml = createRequire(import.meta.url)("js-yaml");
  const workflow = yaml.load(raw);
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(raw).not.toMatch(
    /secrets\s*[.[]|github\.token|gh\s+release|git\s+(push|tag)|upload-release|action-gh-release|--publish\b|\bcurl\b/i,
  );
  expect(Object.keys(workflow.jobs)).toEqual(["select", "build", "assemble"]);
  const actions = new Set();
  for (const job of Object.values(workflow.jobs) as {
    permissions?: unknown;
    uses?: unknown;
    steps: { uses?: string; with?: Record<string, unknown> }[];
  }[]) {
    expect(job.permissions).toBeUndefined();
    expect(job.uses).toBeUndefined();
    for (const step of job.steps) {
      if (step.uses) actions.add(step.uses);
      if (step.uses === "actions/upload-artifact@v7") expect(step.with?.["retention-days"]).toBe(3);
      if (step.uses === "actions/checkout@v7")
        expect(step.with?.["persist-credentials"]).toBe(false);
    }
  }
  expect(actions).toEqual(
    new Set([
      "actions/checkout@v7",
      "pnpm/action-setup@v6",
      "actions/setup-node@v7",
      "actions/upload-artifact@v7",
      "actions/download-artifact@v8",
    ]),
  );
  expect(raw).toContain("packaging/candidate-version.ts");
  expect(raw).toContain("packaging/candidate-build.ts");
  expect(raw).toContain("packaging/release-plan.ts assemble");
});
