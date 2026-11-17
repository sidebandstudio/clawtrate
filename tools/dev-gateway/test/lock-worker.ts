// A separate process for the lock tests. Modes:
//   hold <lock>                          take the lock, print "held", keep it until killed
//   contend <lock> <log> <id> <ms>       take the lock, log entry and exit around a hold of <ms>
//   allocate <home> <name>               choose ports for <name> and record them in its folder,
//                                        under the port lock, then print them as JSON
//   replace <home> <name>                take <name>'s lifecycle lock and print "locked"; after a
//                                        pause replace its folder with a new run whose start
//                                        process is this one, release the lock and stay alive
//                                        until killed
import { appendFileSync } from "node:fs";
import { stateDirFor } from "../src/instance.ts";
import { instanceLockPath, portLockPath, withLock } from "../src/lock.ts";
import { choosePorts } from "../src/registry.ts";
import { newRunId, prepareFreshState, processIdentity } from "../src/state-guard.ts";

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
      startIdentity: processIdentity(process.pid)!,
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
      startIdentity: processIdentity(process.pid)!,
    });
  });
  forever();
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
