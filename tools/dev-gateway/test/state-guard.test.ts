// State preparation and the spawn boundary. Every test uses a fresh temporary
// HOME; no real profile is ever read, and no real gateway is started.
import type { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { status } from "../src/cli.ts";
import { assertDevStateDir, devStateDir, OpenclawRunner, SpawnRefusedError } from "../src/env.ts";
import {
  ForeignStateError,
  MARKER_FILE,
  newRunId,
  ownership,
  prepareFreshState,
  readMarker,
  recordGateway,
  spawnRefusal,
} from "../src/state-guard.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "clawtrate-home-"));
}

function plant(root: string, path: string, contents: string | Buffer = "PLANTED=1\n"): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), contents);
}

/** Every entry under a folder with its type, mode and content hash, without following links. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out[key] = `link ${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        out[key] = `dir ${stat.mode}`;
        walk(path, key);
      } else {
        const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
        out[key] = `file ${stat.mode} ${hash}`;
      }
    }
  };
  walk(root, "");
  return out;
}

/** A runner on temporary paths whose spawns are counted, never executed. */
function countingRunner(
  stateDir: string,
  home: string,
  alive = (_pid: number | undefined) => true,
) {
  const calls: string[][] = [];
  const fakeSpawn = ((_bin: string, args: string[]) => {
    calls.push(args);
    throw new Error("a test must never reach a real spawn");
  }) as unknown as typeof spawn;
  const fakeSpawnSync = ((_bin: string, args: string[]) => {
    calls.push(args);
    throw new Error("a test must never reach a real spawn");
  }) as unknown as typeof spawnSync;
  const runner = new OpenclawRunner({
    stateDir,
    runFile: join(home, "run", "state.json"),
    spawnImpl: fakeSpawn,
    spawnSyncImpl: fakeSpawnSync,
    isAlive: alive,
  });
  return { runner, calls };
}

function writeRunRecord(home: string, record: object): void {
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(join(home, "run", "state.json"), JSON.stringify(record));
}

describe("preparing fresh state", () => {
  it("resolves to .openclaw-dev under the given home and nowhere else", () => {
    const home = tempHome();
    expect(devStateDir(home)).toBe(join(home, ".openclaw-dev"));
    expect(() => assertDevStateDir(devStateDir(home), home)).not.toThrow();
    expect(() => assertDevStateDir(join(home, ".openclaw"), home)).toThrow(
      /only in ~\/\.openclaw-dev/,
    );
  });

  it("starting over an owned folder leaves a new folder without anything planted in it", () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    prepareFreshState(stateDir, newRunId());
    // Credentials can live in SQLite stores, deep files and behind links.
    plant(stateDir, "agents/main/agent/openclaw-agent.sqlite", Buffer.from("SQLite format 3\0key"));
    plant(stateDir, "state/openclaw.sqlite", Buffer.from("SQLite format 3\0key"));
    plant(stateDir, "a/b/c/d/e/f/g/h/i/j/.env", "OPENAI_API_KEY=planted\n");
    const outside = join(home, "elsewhere");
    plant(outside, "auth-profiles.json", '{"profiles":{"x":{"key":"planted"}}}');
    symlinkSync(outside, join(stateDir, "linked-agents"));
    const outsideBefore = snapshot(outside);

    const runId = newRunId();
    prepareFreshState(stateDir, runId);

    expect(readdirSync(stateDir)).toEqual([MARKER_FILE]);
    expect(readMarker(stateDir)?.runId).toBe(runId);
    expect(lstatSync(stateDir).mode & 0o777).toBe(0o700);
    // The link was removed, not followed: what it pointed at is untouched.
    expect(snapshot(outside)).toEqual(outsideBefore);
  });

  it("refuses a foreign folder and leaves it byte for byte untouched", () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    plant(stateDir, "openclaw.json", "{}");
    plant(stateDir, "agents/main/agent/openclaw-agent.sqlite", Buffer.from("SQLite format 3\0"));
    plant(stateDir, ".env", "TOKEN=someone-elses\n");
    const before = snapshot(stateDir);
    expect(ownership(stateDir)).toBe("foreign");
    expect(() => prepareFreshState(stateDir, newRunId())).toThrow(ForeignStateError);
    expect(snapshot(stateDir)).toEqual(before);
  });

  it("treats a marker that is a link, or not the tool's, as foreign", () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    const real = join(home, "real-marker");
    writeFileSync(real, JSON.stringify({ createdBy: "clawtrate tools/dev-gateway", runId: "x" }));
    mkdirSync(stateDir);
    symlinkSync(real, join(stateDir, MARKER_FILE));
    expect(ownership(stateDir)).toBe("foreign");
    expect(() => prepareFreshState(stateDir, newRunId())).toThrow(ForeignStateError);

    const other = devStateDir(tempHome());
    plant(other, MARKER_FILE, '{"createdBy":"someone else","runId":"x"}');
    expect(ownership(other)).toBe("foreign");
  });

  it("refuses a state path that is a symlink, even to a folder the tool made", () => {
    const home = tempHome();
    const target = join(home, "target");
    prepareFreshState(target, newRunId());
    plant(target, "keep.txt", "keep");
    const before = snapshot(target);
    const stateDir = devStateDir(home);
    symlinkSync(target, stateDir);
    expect(ownership(stateDir)).toBe("foreign");
    expect(() => prepareFreshState(stateDir, newRunId())).toThrow(ForeignStateError);
    expect(lstatSync(stateDir).isSymbolicLink()).toBe(true);
    expect(snapshot(target)).toEqual(before);
  });

  it("still owns a folder whose marker predates run ids, but never runs on it", () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    plant(stateDir, MARKER_FILE, '{"createdBy":"clawtrate tools/dev-gateway","createdAt":"x"}');
    expect(ownership(stateDir)).toBe("owned");
    expect(spawnRefusal({ stateDir, run: null, freshRunId: "", isAlive: () => true })).toMatch(
      /does not belong/,
    );
    prepareFreshState(stateDir, "run-2");
    expect(readMarker(stateDir)?.runId).toBe("run-2");
  });

  it("creates the folder with only a marker when none exists", () => {
    const stateDir = devStateDir(tempHome());
    expect(ownership(stateDir)).toBe("absent");
    prepareFreshState(stateDir, "run-1");
    expect(ownership(stateDir)).toBe("owned");
    expect(readdirSync(stateDir)).toEqual([MARKER_FILE]);
  });
});

describe("the OpenClaw spawn boundary", () => {
  it("status with absent state spawns nothing", async () => {
    const home = tempHome();
    const { runner, calls } = countingRunner(devStateDir(home), home);
    const lines: string[] = [];
    await status(runner, (line) => lines.push(line));
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toMatch(
      /healthy {5}no \(not checked: There is no development gateway state/,
    );
  });

  it("status with foreign state spawns nothing", async () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    plant(stateDir, "openclaw.json", "{}");
    writeRunRecord(home, { runId: "r", gatewayPid: process.pid, startedAt: "" });
    const { runner, calls } = countingRunner(stateDir, home);
    const lines: string[] = [];
    await status(runner, (line) => lines.push(line));
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/not checked: .*was not created by the dev-gateway tool/);
  });

  it("refuses a later command when the recorded gateway is not running", async () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    const runId = newRunId();
    prepareFreshState(stateDir, runId);
    recordGateway(stateDir, runId, { gatewayPid: 424242, providerPid: 424243 });
    writeRunRecord(home, { runId, gatewayPid: 424242, providerPid: 424243, startedAt: "" });
    const { runner, calls } = countingRunner(stateDir, home, () => false);
    expect(runner.refusal()).toMatch(/pid 424242\) is not running/);
    await expect(runner.run(["devices", "list"])).rejects.toBeInstanceOf(SpawnRefusedError);
    expect(() => runner.runSync(["config", "validate"])).toThrow(SpawnRefusedError);
    expect(() => runner.spawnDetached(["gateway", "run"], {})).toThrow(SpawnRefusedError);
    expect(calls).toEqual([]);

    // After `stop` the run file is gone; the marker still names the stopped gateway.
    const { runner: afterStop } = countingRunner(stateDir, tempHome(), () => false);
    expect(afterStop.refusal()).toMatch(/pid 424242\) is not running/);
  });

  it("refuses state that a different start recorded", () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    const runId = newRunId();
    prepareFreshState(stateDir, runId);
    recordGateway(stateDir, runId, { gatewayPid: process.pid, providerPid: process.pid });
    writeRunRecord(home, { runId: newRunId(), gatewayPid: process.pid, startedAt: "" });
    const { runner } = countingRunner(stateDir, home);
    expect(runner.refusal()).toMatch(/does not belong to the gateway this tool last started/);
  });

  it("allows OpenClaw during the start that created the state, then only while its gateway runs", () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    const runId = newRunId();
    prepareFreshState(stateDir, runId);
    const isAlive = (pid: number | undefined) => pid === 1234;
    const check = (freshRunId: string | null, run: object | null) =>
      spawnRefusal({ stateDir, run: run as never, freshRunId, isAlive });

    expect(check(runId, null)).toBeNull(); // configuring and starting
    expect(check(null, null)).toMatch(/does not belong/); // no gateway recorded yet
    expect(check(newRunId(), null)).toMatch(/does not belong/); // another start's id

    recordGateway(stateDir, runId, { gatewayPid: 1234, providerPid: 1235 });
    expect(check(null, { runId, gatewayPid: 1234, startedAt: "" })).toBeNull();
    expect(check(null, { runId, gatewayPid: 9999, startedAt: "" })).toMatch(/does not belong/);
  });

  it("refuses to record a gateway on state another start created", () => {
    const stateDir = devStateDir(tempHome());
    prepareFreshState(stateDir, "first");
    expect(() => recordGateway(stateDir, "second", { gatewayPid: 1, providerPid: 2 })).toThrow(
      /no longer the state this start created/,
    );
    expect(existsSync(join(stateDir, MARKER_FILE))).toBe(true);
  });
});
