// Named instances. Every test runs under a fresh temporary HOME and run folder;
// no real profile is read and no OpenClaw process is started. The only
// processes started are `sleep` stand-ins for gateways, stopped by PID.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { list, openInstance, reset, sandboxProblems, devConfig, start, stop } from "../src/cli.ts";
import { guardArgs, OpenclawRunner, openclawEnv, providerEnv } from "../src/env.ts";
import {
  INSTANCE_ENV,
  instanceFromStateDirName,
  isNamedInstancePort,
  NAMED_PORT_RANGE,
  profileArgs,
  profileFor,
  selectInstance,
  stateDirFor,
  validateInstanceName,
} from "../src/instance.ts";
import {
  candidateBlocks,
  choosePorts,
  listInstances,
  portLockPath,
  pruneInstances,
  withPortLock,
} from "../src/registry.ts";
import {
  inUseRefusal,
  MARKER_FILE,
  newRunId,
  prepareFreshState,
  readMarker,
  recordGateway,
  spawnRefusal,
  StateInUseError,
  type MarkerOrigin,
} from "../src/state-guard.ts";

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

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
        out[key] = `dir ${stat.mode} ${stat.mtimeMs}`;
        walk(path, key);
      } else {
        const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
        out[key] = `file ${stat.mode} ${stat.mtimeMs} ${hash}`;
      }
    }
  };
  walk(root, "");
  return out;
}

/** Stand-ins for gateways another checkout started. Stopped by PID after the tests. */
const children: ChildProcess[] = [];
function liveProcess(): number {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  children.push(child);
  return child.pid!;
}
function deadPid(): number {
  const result = spawnSync("true");
  return result.pid!;
}
afterAll(() => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
});

/** A runner whose spawns are recorded and never executed. */
function recordingRunner(home: string, name: string | null, runRoot: string) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const record = (_bin: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }) =>
    calls.push({ args, env: options.env, cwd: options.cwd });
  const fakeSpawnSync = ((bin: string, args: string[], options: never) => {
    record(bin, args, options);
    return { status: 0, stdout: "", stderr: "" };
  }) as unknown as typeof spawnSync;
  const fakeSpawn = ((bin: string, args: string[], options: never) => {
    record(bin, args, options);
    throw new Error("a test must never reach a real spawn");
  }) as unknown as typeof spawn;
  const inst = openInstance(name, { home, runRoot });
  const runner = new OpenclawRunner({
    instance: name,
    stateDir: inst.stateDir,
    runFile: inst.runFile,
    spawnImpl: fakeSpawn,
    spawnSyncImpl: fakeSpawnSync,
  });
  return { inst: { ...inst, runner }, runner, calls };
}

/** An instance folder as a start would leave it, with its processes recorded. */
function seedInstance(
  home: string,
  name: string | null,
  options: { gatewayPid?: number; providerPid?: number; origin?: MarkerOrigin } = {},
) {
  const stateDir = stateDirFor(name, home);
  const runId = newRunId();
  const ports = name === null ? {} : { gatewayPort: 19240, providerPort: 19250 };
  prepareFreshState(stateDir, runId, new Date(), {
    instance: name,
    ...ports,
    checkout: "/elsewhere/other-checkout",
    ...options.origin,
  });
  writeFileSync(join(stateDir, "openclaw.json"), '{"gateway":{}}\n');
  mkdirSync(join(stateDir, "agents/main/agent"), { recursive: true });
  writeFileSync(join(stateDir, "agents/main/agent/openclaw-agent.sqlite"), "SQLite format 3\0");
  if (options.gatewayPid) {
    recordGateway(stateDir, runId, {
      gatewayPid: options.gatewayPid,
      providerPid: options.providerPid ?? deadPid(),
    });
  }
  return { stateDir, runId };
}

describe("instance names", () => {
  it("accepts short lowercase names with inner hyphens", () => {
    for (const name of ["a", "alpha", "e2e-1a2b3c4d", "x-y-z", "a".repeat(24), "0"]) {
      expect(validateInstanceName(name)).toBe(name);
    }
  });

  it("rejects anything else before a path is built", () => {
    for (const name of [
      "",
      "Alpha",
      "ALPHA",
      "-a",
      "a-",
      "a_b",
      "a.b",
      "a b",
      " a",
      "a\n",
      "a/b",
      "../a",
      "..",
      ".",
      "~",
      "a".repeat(25),
      "é",
    ]) {
      expect(() => validateInstanceName(name), JSON.stringify(name)).toThrow(
        /refusing instance name/,
      );
      expect(() => profileFor(name)).toThrow(/refusing instance name/);
      expect(() => stateDirFor(name, "/home/x")).toThrow(/refusing instance name/);
    }
    expect(() => validateInstanceName(undefined)).toThrow(/not a string/);
  });

  it("never resolves to the default profile, the --dev profile or an unprefixed one", () => {
    // Names that try to reach the default or --dev profile.
    for (const name of ["default", "Default", "DEFAULT", "dev", "DEV", "Dev"]) {
      expect(() => validateInstanceName(name)).toThrow(/refusing instance name/);
    }
    const home = "/home/x";
    for (const name of ["alpha", "e2e-0", "openclaw", "clawtrate-dev", "default-1", "dev-1"]) {
      expect(profileFor(name)).toBe(`clawtrate-dev-${name}`);
      expect(profileArgs(name)).toEqual(["--profile", `clawtrate-dev-${name}`]);
      const dir = stateDirFor(name, home);
      expect(dir).toBe(join(home, `.openclaw-clawtrate-dev-${name}`));
      expect(dir).not.toBe(join(home, ".openclaw"));
      expect(dir).not.toBe(join(home, ".openclaw-dev"));
    }
    expect(profileArgs(null)).toEqual(["--dev"]);
    expect(stateDirFor(null, home)).toBe(join(home, ".openclaw-dev"));
  });

  it("is selected by --instance or the environment, never both disagreeing", () => {
    expect(selectInstance(undefined, {})).toBeNull();
    expect(selectInstance(undefined, { [INSTANCE_ENV]: "" })).toBeNull();
    expect(selectInstance("alpha", {})).toBe("alpha");
    expect(selectInstance(undefined, { [INSTANCE_ENV]: "beta" })).toBe("beta");
    expect(selectInstance("alpha", { [INSTANCE_ENV]: "alpha" })).toBe("alpha");
    expect(() => selectInstance("alpha", { [INSTANCE_ENV]: "beta" })).toThrow(/disagree/);
    expect(() => selectInstance(undefined, { [INSTANCE_ENV]: "default" })).toThrow(/refusing/);
  });

  it("maps state folder names back only for the tool's own instances", () => {
    expect(instanceFromStateDirName(".openclaw-dev")).toBeNull();
    expect(instanceFromStateDirName(".openclaw-clawtrate-dev-alpha")).toBe("alpha");
    for (const entry of [".openclaw", ".openclaw-roster-probe", ".openclaw-clawtrate-dev-Bad"]) {
      expect(instanceFromStateDirName(entry)).toBeUndefined();
    }
  });

  it("the CLI refuses a bad name and creates nothing", () => {
    const home = tempDir("clawtrate-home-");
    const cli = join(import.meta.dirname, "../src/cli.ts");
    for (const args of [
      ["start", "--instance", "../../.openclaw"],
      ["reset", "--instance", "default"],
      ["status", "--instance", "DEV"],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        env: { PATH: process.env.PATH, HOME: home },
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/refusing instance name/);
    }
    const viaEnv = spawnSync(process.execPath, [cli, "stop"], {
      env: { PATH: process.env.PATH, HOME: home, [INSTANCE_ENV]: "a/b" },
      encoding: "utf8",
    });
    expect(viaEnv.status).toBe(1);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("per-instance folders, markers and the spawn boundary", () => {
  it("gives each instance its own state folder, run folder and marker", () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const alpha = openInstance("alpha", { home, runRoot });
    const dflt = openInstance(null, { home, runRoot });
    expect(alpha.stateDir).toBe(join(home, ".openclaw-clawtrate-dev-alpha"));
    expect(alpha.runFile).toBe(join(runRoot, "instances/alpha/state.json"));
    expect(alpha.connectionFile).toBe(join(runRoot, "instances/alpha/connection.json"));
    expect(dflt.stateDir).toBe(join(home, ".openclaw-dev"));
    expect(dflt.runFile).toBe(join(runRoot, "state.json"));

    seedInstance(home, "alpha");
    const marker = readMarker(alpha.stateDir)!;
    expect(marker.instance).toBe("alpha");
    expect(marker.gatewayPort).toBe(19240);
    expect(existsSync(dflt.stateDir)).toBe(false);
  });

  it("runs OpenClaw with the instance's profile, folder and recorded port only", () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const { stateDir, runId } = seedInstance(home, "alpha");
    const { runner, calls } = recordingRunner(home, "alpha", runRoot);
    runner.freshRunId = runId;
    runner.runSync(["config", "validate"]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.args).toEqual(["--profile", "clawtrate-dev-alpha", "config", "validate"]);
    expect(call!.cwd).toBe(stateDir);
    expect(call!.env.OPENCLAW_PROFILE).toBe("clawtrate-dev-alpha");
    expect(call!.env.OPENCLAW_STATE_DIR).toBe(stateDir);
    expect(call!.env.OPENCLAW_CONFIG_PATH).toBe(join(stateDir, "openclaw.json"));
    expect(call!.env.OPENCLAW_GATEWAY_PORT).toBe("19240");
  });

  it("never lets a caller pick the profile", () => {
    expect(guardArgs(["agents", "list"], "alpha")).toEqual([
      "--profile",
      "clawtrate-dev-alpha",
      "agents",
      "list",
    ]);
    expect(guardArgs(["agents", "list"])).toEqual(["--dev", "agents", "list"]);
    for (const bad of ["--dev", "--profile", "--profile=default"]) {
      expect(() => guardArgs(["agents", bad], "alpha")).toThrow(/never selects another/);
    }
  });

  it("keeps the environment allowlist for named instances", () => {
    const shell = { PATH: "/usr/bin", OPENAI_API_KEY: "secret", OPENCLAW_PROFILE: "default" };
    const env = openclawEnv(shell, { name: "alpha", stateDir: "/h/.x", gatewayPort: 19240 });
    expect(Object.keys(env).sort()).toEqual(
      [
        "PATH",
        "HOME",
        "OPENCLAW_PROFILE",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_GATEWAY_PORT",
        "NO_COLOR",
      ].sort(),
    );
    expect(env.OPENCLAW_PROFILE).toBe("clawtrate-dev-alpha");
    expect(providerEnv(shell, 19250)).toEqual({
      PATH: "/usr/bin",
      SCRIPTED_PROVIDER_PORT: "19250",
    });
  });

  it("checks the generated config against the instance's own ports", () => {
    const ports = { gatewayPort: 19240, providerPort: 19250 };
    const config = devConfig("t", ports);
    expect(sandboxProblems(config, ports)).toEqual([]);
    expect(config.models.providers.scripted.baseUrl).toBe("http://127.0.0.1:19250/v1");
    expect(sandboxProblems(devConfig("t"), ports)).toEqual([
      "gateway.port must be this instance's 19240",
      "the scripted provider must be this instance's port 19250",
    ]);
  });

  it("refuses a folder whose marker names another instance or a port outside the range", () => {
    const home = tempDir("clawtrate-home-");
    // Beta's marker copied into alpha's folder.
    const { stateDir: beta } = seedInstance(home, "beta");
    const alphaDir = stateDirFor("alpha", home);
    mkdirSync(alphaDir);
    writeFileSync(join(alphaDir, MARKER_FILE), readFileSync(join(beta, MARKER_FILE)));
    const check = (stateDir: string, instance: string) =>
      spawnRefusal({ stateDir, run: null, freshRunId: null, isAlive: () => true, instance });
    expect(check(alphaDir, "alpha")).toMatch(/belongs to another instance/);

    // A forged marker pointing a named instance at the default profile's port.
    const { stateDir: gamma, runId } = seedInstance(home, "gamma", {
      origin: { gatewayPort: 18789 },
    });
    expect(
      spawnRefusal({
        stateDir: gamma,
        run: null,
        freshRunId: runId,
        isAlive: () => true,
        instance: "gamma",
      }),
    ).toMatch(/does not record valid ports/);
    expect(isNamedInstancePort(18789)).toBe(false);
    expect(isNamedInstancePort(19001)).toBe(false);
  });
});

describe("a gateway another checkout started", () => {
  for (const name of [null, "alpha"] as const) {
    const which = name === null ? "the default instance" : "a named instance";

    it(`start and reset refuse ${which} and leave it byte for byte untouched`, async () => {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      const gatewayPid = liveProcess();
      const { stateDir } = seedInstance(home, name, { gatewayPid });
      const before = snapshot(home);
      const { inst, calls } = recordingRunner(home, name, runRoot);

      await expect(start(inst)).rejects.toBeInstanceOf(StateInUseError);
      await expect(start(inst)).rejects.toThrow(
        new RegExp(
          `${name === null ? "the default instance" : 'instance "alpha"'} \\(${stateDir}\\) is in use: ` +
            `its gateway \\(pid ${gatewayPid}\\) is running and was started by another checkout`,
        ),
      );
      await expect(reset(inst)).rejects.toBeInstanceOf(StateInUseError);

      expect(snapshot(home)).toEqual(before);
      expect(calls).toEqual([]);
      expect(readdirSync(runRoot)).toEqual([]);
      expect(children.find((c) => c.pid === gatewayPid)!.exitCode).toBeNull();
    });

    it(`start refuses ${which} even when this checkout's run file is stale`, async () => {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      const gatewayPid = liveProcess();
      seedInstance(home, name, { gatewayPid });
      const { inst } = recordingRunner(home, name, runRoot);
      // An older run of this checkout, whose processes are gone.
      mkdirSync(inst.runDir, { recursive: true });
      const stale = { runId: newRunId(), gatewayPid: deadPid(), startedAt: "" };
      writeFileSync(inst.runFile, JSON.stringify(stale));
      const before = snapshot(home);
      await expect(start(inst)).rejects.toBeInstanceOf(StateInUseError);
      expect(snapshot(home)).toEqual(before);
      expect(JSON.parse(readFileSync(inst.runFile, "utf8"))).toEqual(stale);
    });
  }

  it("does not count this checkout's own gateway as another checkout's", () => {
    const home = tempDir("clawtrate-home-");
    const gatewayPid = liveProcess();
    const { stateDir, runId } = seedInstance(home, "alpha", { gatewayPid });
    const ours = { runId, gatewayPid, startedAt: "" };
    expect(inUseRefusal(stateDir, ours, () => true)).toBeNull();
    expect(inUseRefusal(stateDir, null, () => true)).toMatch(/in use/);
    expect(inUseRefusal(stateDir, { ...ours, runId: newRunId() }, () => true)).toMatch(/in use/);
    // Once that gateway is gone the folder may be started over.
    expect(inUseRefusal(stateDir, null, () => false)).toBeNull();
  });

  it("refuses while another process is still preparing the folder", () => {
    const home = tempDir("clawtrate-home-");
    const startPid = liveProcess();
    const { stateDir } = seedInstance(home, "alpha", { origin: { startPid } });
    expect(inUseRefusal(stateDir, null, (pid) => pid === startPid)).toMatch(
      new RegExp(`a start in another process \\(pid ${startPid}\\)`),
    );
  });

  it("prepareFreshState itself refuses a live foreign gateway", () => {
    const home = tempDir("clawtrate-home-");
    const { stateDir } = seedInstance(home, "alpha", { gatewayPid: liveProcess() });
    const before = snapshot(stateDir);
    expect(() => prepareFreshState(stateDir, newRunId())).toThrow(StateInUseError);
    expect(snapshot(stateDir)).toEqual(before);
  });
});

describe("instances side by side", () => {
  it("stop and reset of one instance leave the other's folder and processes alone", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const alphaPid = liveProcess();
    const betaPid = liveProcess();
    const alpha = seedInstance(home, "alpha", { gatewayPid: alphaPid });
    const beta = seedInstance(home, "beta", {
      gatewayPid: betaPid,
      origin: { gatewayPort: 19260, providerPort: 19270 },
    });
    const alphaInst = recordingRunner(home, "alpha", runRoot).inst;
    const betaInst = recordingRunner(home, "beta", runRoot).inst;
    for (const [inst, seeded, pid] of [
      [alphaInst, alpha, alphaPid],
      [betaInst, beta, betaPid],
    ] as const) {
      mkdirSync(inst.runDir, { recursive: true });
      writeFileSync(
        inst.runFile,
        JSON.stringify({ runId: seeded.runId, gatewayPid: pid, startedAt: "" }),
      );
    }
    const betaBefore = snapshot(beta.stateDir);
    const betaRunBefore = snapshot(betaInst.runDir);

    await stop(alphaInst);
    expect(children.find((c) => c.pid === alphaPid)!.signalCode).not.toBeNull();
    await reset(alphaInst);
    expect(existsSync(alpha.stateDir)).toBe(false);
    expect(existsSync(alphaInst.runDir)).toBe(false);

    expect(children.find((c) => c.pid === betaPid)!.exitCode).toBeNull();
    expect(children.find((c) => c.pid === betaPid)!.signalCode).toBeNull();
    expect(snapshot(beta.stateDir)).toEqual(betaBefore);
    expect(snapshot(betaInst.runDir)).toEqual(betaRunBefore);
  });

  it("chooses ports that no other instance has recorded and that are free", async () => {
    const home = tempDir("clawtrate-home-");
    const free = async () => true;
    const first = await choosePorts("alpha", home, free);
    expect(first.gatewayPort).toBe(candidateBlocks("alpha")[0]);
    expect(first.providerPort).toBe(first.gatewayPort + 10);
    seedInstance(home, "alpha", { origin: first });
    // The same block is now recorded, so even the same name gets another one.
    const second = await choosePorts("alpha", home, free);
    expect(second.gatewayPort).not.toBe(first.gatewayPort);
    // A block with any port in use is skipped.
    const busy = new Set([second.gatewayPort + 2]);
    const third = await choosePorts("alpha", home, async (port) => !busy.has(port));
    expect([first.gatewayPort, second.gatewayPort]).not.toContain(third.gatewayPort);
    for (const ports of [first, second, third]) {
      expect(isNamedInstancePort(ports.gatewayPort)).toBe(true);
      expect(isNamedInstancePort(ports.providerPort)).toBe(true);
      expect(ports.gatewayPort).toBeGreaterThanOrEqual(NAMED_PORT_RANGE.first);
    }
    await expect(choosePorts("alpha", home, async () => false)).rejects.toThrow(/no free port/);
  });

  it("lets one start at a time choose ports, and takes over a dead holder's lock", async () => {
    const home = tempDir("clawtrate-home-");
    const events: string[] = [];
    const hold = (id: string) =>
      withPortLock(home, async () => {
        events.push(`in ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push(`out ${id}`);
      });
    await Promise.all([hold("a"), hold("b"), hold("c")]);
    expect(events).toHaveLength(6);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i + 1]).toBe(events[i]!.replace("in ", "out "));
    }
    expect(existsSync(portLockPath(home))).toBe(false);

    mkdirSync(portLockPath(home));
    writeFileSync(join(portLockPath(home), "pid"), String(deadPid()));
    await expect(withPortLock(home, async () => "taken", { timeoutMs: 2000 })).resolves.toBe(
      "taken",
    );
  });
});

describe("listing and removing stopped instances", () => {
  it("lists only the tool's folders and removes only named instances nothing runs on", () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const livePid = liveProcess();
    const startPid = liveProcess();
    seedInstance(home, null, { gatewayPid: deadPid() });
    const stale = seedInstance(home, "stale", { gatewayPid: deadPid() });
    const failed = seedInstance(home, "failed", { origin: { startPid: deadPid() } });
    const live = seedInstance(home, "live", { gatewayPid: livePid });
    const starting = seedInstance(home, "starting", { origin: { startPid } });
    // Not the tool's: the default profile, another tool's profile, an unmarked folder.
    for (const dir of [".openclaw", ".openclaw-roster-probe", ".openclaw-clawtrate-dev-unmarked"]) {
      mkdirSync(join(home, dir));
      writeFileSync(join(home, dir, "openclaw.json"), "{}");
    }
    mkdirSync(join(runRoot, "instances/stale"), { recursive: true });
    writeFileSync(join(runRoot, "instances/stale/state.json"), "{}");
    mkdirSync(join(runRoot, "instances/live"), { recursive: true });
    writeFileSync(
      join(runRoot, "instances/live/state.json"),
      JSON.stringify({ runId: live.runId }),
    );

    const lines: string[] = [];
    const rows = list({ home, runRoot, json: true, log: (line) => lines.push(line) });
    expect(rows.map((row) => row.name)).toEqual([null, "failed", "live", "stale", "starting"]);
    expect(JSON.parse(lines.join("\n"))).toEqual(rows);
    const liveRow = rows.find((row) => row.name === "live")!;
    expect(liveRow).toMatchObject({
      stateDir: live.stateDir,
      gatewayPort: 19240,
      providerPort: 19250,
      gatewayPid: livePid,
      gatewayRunning: true,
      thisCheckout: true,
    });
    expect(rows.find((row) => row.name === null)).toMatchObject({
      gatewayPort: 19001,
      providerPort: 19091,
      gatewayRunning: false,
    });

    const keep = [
      ".openclaw",
      ".openclaw-roster-probe",
      ".openclaw-clawtrate-dev-unmarked",
      ".openclaw-dev",
      ".openclaw-clawtrate-dev-live",
      ".openclaw-clawtrate-dev-starting",
    ];
    const before = Object.fromEntries(keep.map((dir) => [dir, snapshot(join(home, dir))]));
    const removed = pruneInstances(home, {
      runDirFor: (name) => join(runRoot, "instances", name),
    });
    expect(removed.sort()).toEqual(["failed", "stale"]);
    expect(existsSync(stale.stateDir)).toBe(false);
    expect(existsSync(failed.stateDir)).toBe(false);
    expect(existsSync(join(runRoot, "instances/stale"))).toBe(false);
    expect(existsSync(join(runRoot, "instances/live"))).toBe(true);
    expect(existsSync(starting.stateDir)).toBe(true);
    for (const dir of keep) expect(snapshot(join(home, dir)), dir).toEqual(before[dir]);
    expect(listInstances(home).map((entry) => entry.name)).toEqual([null, "live", "starting"]);
  });
});
