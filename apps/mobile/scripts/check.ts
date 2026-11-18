// `pnpm mobile:check`: the iOS app's checks in the Simulator, from one command,
// with nobody at the screen. It creates a Simulator device of its own and boots
// it without the Simulator window, installs the build `pnpm mobile:build` made,
// starts a named development gateway instance of its own, and runs the checks
// in `simulator/` (Vitest driving Maestro flows). Afterwards it shuts down and
// deletes its device and resets its instance, also when a check fails or the
// run is interrupted. A run killed outright leaves its record in
// `build/check-run.json`, and the next run removes what that record names.
//
// Set CLAWTRATE_IOS_SHOTS=<folder> to also save each screen in light and dark.

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readDevConnection } from "../../desktop/src/host/runtime.ts";
import { APP_PATH, BUILD_DIR, BUNDLE_ID } from "./build.ts";
import { findDeveloperDir } from "./xcode.ts";

const REPO = join(import.meta.dirname, "../../..");
const RECORD = join(BUILD_DIR, "check-run.json");
const DEVICE_PREFIX = "Clawtrate checks ";
/** iPhone sizes the checks prefer, in order. */
const DEVICE_TYPES = ["iPhone 17", "iPhone 16", "iPhone 17 Pro", "iPhone 18 Pro"];

type Record = { pid: number; device: string | null; instance: string | null };

/** The newest file or folder under ~/.local/share matching a name, for a tool installed there. */
function local(pattern: RegExp, inner: string): string | null {
  const dir = join(homedir(), ".local/share");
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .reverse()[0];
  return found && existsSync(join(dir, found, inner)) ? join(dir, found, inner) : null;
}

function tools(env: NodeJS.ProcessEnv) {
  const maestro = env.MAESTRO ?? local(/^maestro-[\d.]+$/, "bin/maestro") ?? "maestro";
  const javaHome = env.JAVA_HOME ?? local(/^temurin-jre-[\d.]+$/, "Contents/Home");
  if (!javaHome)
    throw new Error(
      "Maestro needs Java 17 or later: set JAVA_HOME (CONTRIBUTING.md, Checking the iOS app).",
    );
  return { maestro, javaHome };
}

function simctl(env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The newest iOS runtime with one of the preferred iPhones, or what CLAWTRATE_IOS_RUNTIME and _DEVICE_TYPE name. */
function chooseDevice(env: NodeJS.ProcessEnv): { runtime: string; type: string; label: string } {
  const runtimes = (
    JSON.parse(simctl(env, "list", "runtimes", "-j")) as {
      runtimes: Array<{
        identifier: string;
        version: string;
        isAvailable: boolean;
        supportedDeviceTypes: Array<{ name: string; identifier: string }>;
      }>;
    }
  ).runtimes
    .filter((r) => r.isAvailable && r.identifier.includes("SimRuntime.iOS"))
    .filter((r) => !env.CLAWTRATE_IOS_RUNTIME || r.identifier === env.CLAWTRATE_IOS_RUNTIME)
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const wanted = env.CLAWTRATE_IOS_DEVICE_TYPE ? [env.CLAWTRATE_IOS_DEVICE_TYPE] : DEVICE_TYPES;
  for (const runtime of runtimes) {
    for (const name of wanted) {
      const type = runtime.supportedDeviceTypes.find(
        (t) => t.name === name || t.identifier === name,
      );
      if (type)
        return {
          runtime: runtime.identifier,
          type: type.identifier,
          label: `${type.name}, iOS ${runtime.version}`,
        };
    }
  }
  throw new Error(`No installed iOS Simulator runtime supports ${wanted.join(" or ")}.`);
}

/** Whether a process runs: signal 0 reaches it, or it exists under another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRecord(): Record | null {
  try {
    return JSON.parse(readFileSync(RECORD, "utf8")) as Record;
  } catch {
    return null;
  }
}

function writeRecord(record: Record) {
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
}

function devGateway(...args: string[]): number {
  return (
    spawnSync(process.execPath, [join(REPO, "tools/dev-gateway/src/cli.ts"), ...args], {
      cwd: REPO,
      stdio: "inherit",
    }).status ?? 1
  );
}

/** Remove what a record names: its device, only if it is still one of these checks' own, and its instance. */
function clean(record: Record, env: NodeJS.ProcessEnv) {
  if (record.device) {
    const devices = JSON.parse(simctl(env, "list", "devices", "-j")) as {
      devices: { [runtime: string]: Array<{ udid: string; name: string; state: string }> };
    };
    const mine = Object.values(devices.devices)
      .flat()
      .find((d) => d.udid === record.device);
    if (mine && mine.name.startsWith(DEVICE_PREFIX)) {
      if (mine.state !== "Shutdown")
        spawnSync("xcrun", ["simctl", "shutdown", mine.udid], { env, stdio: "ignore" });
      spawnSync("xcrun", ["simctl", "delete", mine.udid], { env, stdio: "ignore" });
      console.log(`Removed the Simulator device ${mine.name}.`);
    }
  }
  if (record.instance) {
    if (devGateway("reset", "--instance", record.instance) !== 0)
      throw new Error(
        `Could not reset the development gateway instance ${record.instance}; reset it by hand.`,
      );
  }
  rmSync(RECORD, { force: true });
}

async function main(): Promise<number> {
  if (!existsSync(APP_PATH))
    throw new Error(`There is no build at ${APP_PATH}. Run pnpm mobile:build first.`);
  const developerDir = findDeveloperDir();
  const env: NodeJS.ProcessEnv = { ...process.env, DEVELOPER_DIR: developerDir };
  const { maestro, javaHome } = tools(env);

  const previous = readRecord();
  if (previous && previous.pid !== process.pid && alive(previous.pid))
    throw new Error(`Another pnpm mobile:check (PID ${previous.pid}) is running in this checkout.`);
  if (previous) {
    console.log("Cleaning up after an earlier run that did not finish…");
    clean(previous, env);
  }

  const run = randomBytes(3).toString("hex");
  const record: Record = { pid: process.pid, device: null, instance: `ios-${run}` };
  let child: ChildProcess | null = null;
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: stopping the checks and cleaning up…`);
    if (child?.pid) child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Recorded before it exists, so a killed run's instance is reset by the next.
  writeRecord(record);
  try {
    const choice = chooseDevice(env);
    const name = `${DEVICE_PREFIX}${run}`;
    record.device = simctl(env, "create", name, choice.type, choice.runtime).trim();
    writeRecord(record);
    console.log(`Device: ${name} (${choice.label}), ${record.device}`);
    simctl(env, "boot", record.device);
    simctl(env, "bootstatus", record.device, "-b");
    simctl(env, "ui", record.device, "appearance", "light");
    simctl(env, "install", record.device, APP_PATH);

    console.log(
      `Starting the development gateway instance ${record.instance} (it seeds its bots; a few minutes)…`,
    );
    if (devGateway("start", "--instance", record.instance!) !== 0)
      throw new Error("The development gateway did not start.");
    const gateway = readDevConnection(REPO, { instance: record.instance });
    if (!gateway) throw new Error(`The instance ${record.instance} is not running.`);
    if (stopping) return 130;

    child = spawn(
      join(REPO, "node_modules/.bin/vitest"),
      ["run", "--root", join(import.meta.dirname, "../simulator")],
      {
        cwd: REPO,
        stdio: "inherit",
        env: {
          ...env,
          JAVA_HOME: javaHome,
          MAESTRO_CLI_NO_ANALYTICS: "1",
          MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
          CLAWTRATE_IOS_MAESTRO: maestro,
          CLAWTRATE_IOS_DEVICE: record.device,
          CLAWTRATE_IOS_BUNDLE: BUNDLE_ID,
          CLAWTRATE_IOS_INSTANCE: record.instance!,
          CLAWTRATE_IOS_GATEWAY: gateway.url,
          CLAWTRATE_IOS_TOKEN: gateway.token,
        },
      },
    );
    const code = await new Promise<number>((resolve) =>
      child!.on("exit", (status) => resolve(status ?? 1)),
    );
    return stopping ? 130 : code;
  } finally {
    clean(record, env);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
