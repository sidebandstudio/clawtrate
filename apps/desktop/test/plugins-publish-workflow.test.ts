// The plugins publish workflow holds no npm token and gives GitHub's OIDC token
// to one job only, which runs from the `npm` environment, on main.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const TEXT = readFileSync(resolve(ROOT, ".github/workflows/plugins-publish.yml"), "utf8");
const yaml = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  needs?: string;
  "runs-on"?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const flow = yaml.load(TEXT) as Workflow;
const jobs = Object.entries(flow.jobs);
const steps = jobs.flatMap(([, job]) => job.steps);
const atLeast = (version: string, minimum: string) => {
  const [a, b] = [version, minimum].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (a![i] !== b![i]) return a![i]! > b![i]!;
  return true;
};

describe("the plugins publish workflow", () => {
  it("starts only by hand, and every job runs only on main", () => {
    expect(Object.keys(flow.on)).toEqual(["workflow_dispatch"]);
    for (const [, job] of jobs) expect(job.if).toContain("github.ref == 'refs/heads/main'");
  });

  it("reads the repository and nothing more, except the one job that publishes", () => {
    expect(flow.permissions).toEqual({ contents: "read" });
    const withToken = jobs.filter(([, job]) => job.permissions?.["id-token"] === "write");
    expect(withToken.map(([name]) => name)).toEqual(["publish"]);
    expect(flow.jobs.publish!.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(flow.jobs.publish!.environment).toBe("npm");
    expect(flow.jobs.publish!.if).toContain("inputs.mode == 'publish'");
    for (const [name, job] of jobs) if (name !== "publish") expect(job.permissions).toBeUndefined();
  });

  it("uses no secret and no npm token", () => {
    expect(TEXT).not.toMatch(/\bsecrets\b\s*[.[]|toJSON\(secrets\)/);
    expect(TEXT).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|registry-url/);
  });

  it("runs on GitHub's standard Linux runner", () => {
    for (const [, job] of jobs) expect(job["runs-on"]).toBe("ubuntu-latest");
  });

  it("pins every action by its full commit", () => {
    const uses = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
  });

  it("pins a Node and npm that trusted publishing accepts", () => {
    const nodes = steps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(nodes.length).toBe(2);
    for (const step of nodes) {
      const version = String(step.with?.["node-version"]);
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(atLeast(version, "22.14.0")).toBe(true);
      expect(step.with?.["package-manager-cache"]).toBe(false);
    }
    const checks = steps.filter((step) => step.name === "Check npm's version");
    expect(checks.length).toBe(2);
    for (const step of checks) {
      const pinned = /!= (\d+\.\d+\.\d+) \]/.exec(step.run ?? "")?.[1];
      expect(pinned && atLeast(pinned, "11.5.1")).toBe(true);
    }
  });

  it("checks the commit is on main before packing it", () => {
    const pack = flow.jobs.pack!.steps;
    const check = pack.findIndex((step) => step.id === "commit");
    expect(pack[check]!.run).toContain('git merge-base --is-ancestor "$COMMIT" origin/main');
    expect(pack[check]!.run).toContain("^[0-9a-f]{40}$");
    expect(check).toBeLessThan(pack.findIndex((step) => step.id === "pack"));
    expect(flow.jobs.publish!.steps[0]!.with?.ref).toBe("${{ needs.pack.outputs.commit }}");
  });

  it("publishes only through the script, which reads the registry back", () => {
    const runs = steps.flatMap((step) => (step.run ? [step.run] : []));
    expect(runs.filter((run) => /npm (?:publish|pack)\b/.test(run))).toEqual([]);
    const publish = flow.jobs.publish!.steps.find((step) => step.id === "publish");
    expect(publish?.run).toContain("node apps/desktop/packaging/plugin-npm.ts publish");
  });
});
