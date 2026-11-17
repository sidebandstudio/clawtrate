// A separate process for the lock tests. Modes:
//   hold <lock>                          take the lock, print "held", keep it until killed
//   contend <lock> <log> <id> <ms>       take the lock, log entry and exit around a hold of <ms>
//   allocate <home> <name>               choose ports for <name> and record them in its folder,
//                                        under the port lock, then print them as JSON
//   replace <home> <name>                take <name>'s lifecycle lock and print "locked"; after a
//                                        pause replace its folder with a new run whose start
//                                        process is this one, release the lock and stay alive
//                                        until killed
//   gate-crash <file>                    gated-spawn `touch <file>`, print its pid, then die by
//                                        SIGKILL before recording or releasing it
//   gate-release                         gated-spawn a detached `sleep 30`, release it, print its
//                                        pid and return: nothing may keep this process alive
//   start-crash <home> <runRoot> <name> <role>
//                                        run the real `start` with OpenClaw and the scripted model
//                                        replaced by gated `sleep` stand-ins; the moment <role>
//                                        (provider or gateway) is spawned, print its pid and die
//                                        by SIGKILL. A provider spawned before that is printed as
//                                        `provider <pid>` and left running.
import { spawn, type SpawnOptions } from "node:child_process";
import { appendFileSync, writeSync } from "node:fs";
import { openInstance } from "../src/cli.ts";
import { GATE_SCRIPT, gatedSpawn, OpenclawRunner } from "../src/env.ts";
import { stateDirFor } from "../src/instance.ts";
import { instanceLockPath, portLockPath, withLock } from "../src/lock.ts";
import { choosePorts } from "../src/registry.ts";
import { newRunId, prepareFreshState, processIdentity, readMarker } from "../src/state-guard.ts";

const [mode, ...args] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const forever = () => setInterval(() => {}, 1 << 30);

if (mode === "hold") {
  await withLock(args[0]!, async () => {
    console.log("held");
    forever();
    await new Promise(() => {});
  });
} else if (mode === "contend") {
  const [lock, log, id, ms] = args as [string, string, string, string];
  await withLock(lock, async () => {
    appendFileSync(log, `in ${id} ${Date.now()}\n`);
    await sleep(Number(ms));
    appendFileSync(log, `out ${id} ${Date.now()}\n`);
  });
} else if (mode === "allocate") {
  const [home, name] = args as [string, string];
  const ports = await withLock(portLockPath(home), async () => {
    const chosen = await choosePorts(name, home, async () => true);
    // Give a concurrent contender every chance to choose before this records.
    await sleep(300);
    prepareFreshState(stateDirFor(name, home), newRunId(), {
      instance: name,
      ...chosen,
      checkout: "/test/worker",
      startPid: process.pid,
      startIdentity: (processIdentity(process.pid) as { identity: string }).identity,
    });
    return chosen;
  });
  console.log(JSON.stringify(ports));
} else if (mode === "replace") {
  const [home, name] = args as [string, string];
  await withLock(instanceLockPath(home, name), async () => {
    console.log("locked");
    await sleep(500);
    const stateDir = stateDirFor(name, home);
    // The old run is stopped; a new start takes the folder over.
    prepareFreshState(stateDir, newRunId(), {
      instance: name,
      gatewayPort: 19240,
      providerPort: 19250,
      checkout: "/test/worker",
      startPid: process.pid,
      startIdentity: (processIdentity(process.pid) as { identity: string }).identity,
    });
  });
  forever();
} else if (mode === "gate-crash") {
  const gated = gatedSpawn(spawn, "touch", [args[0]!], { detached: true });
  writeSync(1, `pid ${gated.child.pid}\n`);
  process.kill(process.pid, "SIGKILL");
} else if (mode === "gate-release") {
  const gated = gatedSpawn(spawn, "sleep", ["30"], { detached: true, stdio: "ignore" });
  gated.child.unref();
  gated.release();
  writeSync(1, `pid ${gated.child.pid}\n`);
} else if (mode === "start-crash") {
  const [home, runRoot, name, role] = args as [string, string, string, "provider" | "gateway"];
  const fakeSync = (() => ({ status: 0, stdout: "", stderr: "" })) as never;
  // Only the gate itself is real; what it would run is always a `sleep` stand-in.
  const standIn = (options: SpawnOptions) =>
    spawn("/bin/sh", ["-c", GATE_SCRIPT, "sleep", "120"], { ...options, env: { PATH: "/bin" } });
  const crashing = (_command: string, _args: string[], options: SpawnOptions) => {
    const child = standIn(options);
    writeSync(1, `pid ${child.pid}\n`);
    process.kill(process.pid, "SIGKILL");
    return child;
  };
  const surviving = (_command: string, _args: string[], options: SpawnOptions) => {
    const child = standIn(options);
    writeSync(1, `provider ${child.pid}\n`);
    return child;
  };
  const base = openInstance(name, { home, runRoot, checkout: "/test/worker" });
  let providerPort = 0;
  const inst = openInstance(name, {
    home,
    runRoot,
    checkout: "/test/worker",
    // The provider stand-in "listens" so that the start goes on to the gateway.
    listening: async (port) => role === "gateway" && port === providerPort,
    runner: new OpenclawRunner({
      instance: name,
      stateDir: base.stateDir,
      runFile: base.runFile,
      checkout: "/test/worker",
      spawnSyncImpl: fakeSync,
      spawnImpl: crashing as never,
    }),
    spawn: ((command: string, spawnArgs: string[], options: SpawnOptions) => {
      providerPort = readMarker(base.stateDir)?.providerPort ?? 0;
      return (role === "provider" ? crashing : surviving)(command, spawnArgs, options);
    }) as never,
  });
  const { start } = await import("../src/cli.ts");
  await start(inst, { seed: false });
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
