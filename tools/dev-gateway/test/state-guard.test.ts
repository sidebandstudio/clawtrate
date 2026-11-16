// Every test uses a fresh temporary home; no real profile is ever read.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertDevStateDir, devStateDir } from "../src/env.ts";
import {
  assertStateDirOwned,
  createStateDir,
  MARKER_FILE,
  stateDirProblems,
} from "../src/state-guard.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "clawtrate-home-"));
}

function plant(stateDir: string, path: string, contents = "PLANTED=1\n"): void {
  mkdirSync(join(stateDir, path, ".."), { recursive: true });
  writeFileSync(join(stateDir, path), contents);
}

describe("development gateway state folder", () => {
  it("resolves to .openclaw-dev under the given home and nowhere else", () => {
    const home = tempHome();
    expect(devStateDir(home)).toBe(join(home, ".openclaw-dev"));
    expect(() => assertDevStateDir(devStateDir(home), home)).not.toThrow();
    expect(() => assertDevStateDir(join(home, ".openclaw"), home)).toThrow(
      /only in ~\/\.openclaw-dev/,
    );
  });

  it("accepts an absent folder and one this tool created", () => {
    const stateDir = devStateDir(tempHome());
    expect(stateDirProblems(stateDir)).toEqual([]);
    createStateDir(stateDir);
    expect(JSON.parse(readFileSync(join(stateDir, MARKER_FILE), "utf8"))).toMatchObject({
      createdBy: "clawtrate tools/dev-gateway",
    });
    plant(stateDir, "agents/otto/agent/openclaw-agent.sqlite", "");
    expect(stateDirProblems(stateDir)).toEqual([]);
    expect(() => assertStateDirOwned(stateDir)).not.toThrow();
  });

  it("refuses a folder it did not create", () => {
    const stateDir = devStateDir(tempHome());
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "openclaw.json"), "{}");
    expect(stateDirProblems(stateDir)).toEqual([
      `${stateDir} was not created by the dev-gateway tool`,
    ]);
    expect(() => assertStateDirOwned(stateDir)).toThrow(/pnpm dev-gateway reset/);
  });

  it("refuses a planted .env, at the root or deeper", () => {
    const stateDir = devStateDir(tempHome());
    createStateDir(stateDir);
    plant(stateDir, ".env", "OPENAI_API_KEY=planted\n");
    plant(stateDir, "workspaces/pip/.env");
    expect(stateDirProblems(stateDir)).toEqual([
      ".env could load settings or credentials",
      "workspaces/pip/.env could load settings or credentials",
    ]);
  });

  it("refuses auth stores the tool did not create", () => {
    const stateDir = devStateDir(tempHome());
    createStateDir(stateDir);
    plant(stateDir, "agents/main/agent/auth-profiles.json", '{"profiles":{"x":{}}}');
    plant(stateDir, "credentials/oauth.json", "{}");
    plant(stateDir, "auth.json", "{}");
    expect(stateDirProblems(stateDir)).toEqual([
      "agents/main/agent/auth-profiles.json could load settings or credentials",
      "auth.json could load settings or credentials",
      "credentials/oauth.json could load settings or credentials",
    ]);
  });

  it("refuses to create over an existing folder", () => {
    const stateDir = devStateDir(tempHome());
    mkdirSync(stateDir);
    expect(() => createStateDir(stateDir)).toThrow(/already exists/);
  });
});
