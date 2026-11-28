// `dev-gateway list` is the one command that identifies live processes on
// Windows, and it only reads: markers in, lines out. Every decision to start,
// signal or delete learns only whether the kernel has a PID. These run the real
// command on a made-up home, with the modules loaded as each system loads them,
// and a made-up machine: its system tools, where Windows lives and its processes.
import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import type * as Guard from "../src/state-guard.ts";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { stateDirFor } from "../src/instance.ts";

const machine = vi.hoisted(() => ({
  SYSTEM_ROOT: "\\\\?\\GLOBALROOT\\SystemRoot",
  TOOLS: [
    "/bin/ps",
    "/usr/bin/ps",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ],
  tools: new Set<string>(),
  root: null as string | null,
  /** What each system's tool prints for a PID; a PID missing here makes the tool fail. */
  windows: new Map<number, string>(),
  posix: new Map<number, string>(),
  gone: new Set<number>(),
}));

const launch = vi.hoisted(() =>
  vi.fn((program: string, argv: string[]) => {
    const windows = program.endsWith("powershell.exe");
    const pid = windows
      ? Number(/OpenProcess\(0x1000, \$false, (\d+)\)/.exec(argv[4] ?? "")?.[1])
      : Number(argv[5]);
    const stdout = (windows ? machine.windows : machine.posix).get(pid);
    return { error: undefined, status: stdout === undefined ? 1 : 0, stdout: stdout ?? "" };
  }),
);
const started = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawnSync: launch,
  spawn: started,
}));

const present = vi.hoisted(() => vi.fn());
const resolve = vi.hoisted(() => vi.fn());
/** Every way through `node:fs` to change a file, so a command that only reads can be held to it. */
const WRITES = vi.hoisted(
  () =>
    [
      "appendFileSync",
      "chmodSync",
      "copyFileSync",
      "cpSync",
      "linkSync",
      "mkdirSync",
      "mkdtempSync",
      "openSync",
      "renameSync",
      "rmSync",
      "rmdirSync",
      "symlinkSync",
      "truncateSync",
      "unlinkSync",
      "utimesSync",
      "writeFileSync",
      "writeSync",
    ] as const,
);
const writes = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof Fs>();
  present.mockImplementation((path: string) =>
    machine.TOOLS.includes(path) ? machine.tools.has(path) : fs.existsSync(path),
  );
  resolve.mockImplementation((path: string) => {
    if (path !== machine.SYSTEM_ROOT) return fs.realpathSync.native(path);
    if (machine.root === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return machine.root;
  });
  const realpathSync = Object.assign(
    (...args: Parameters<typeof fs.realpathSync>) => fs.realpathSync(...args),
    { native: resolve },
  );
  const changes = Object.fromEntries(
    WRITES.map((name) => {
      const spy = writes.get(name) ?? vi.fn(fs[name] as (...args: unknown[]) => unknown);
      writes.set(name, spy);
      return [name, spy];
    }),
  );
  return { ...fs, ...changes, existsSync: present, realpathSync };
});

/**
 * The modules with the process lookups `platform` gets: the guard chooses them as it loads, and
 * the registry and the command use that guard. Only the guard loads while `platform` is faked.
 */
async function load(platform: NodeJS.Platform) {
  vi.resetModules();
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...real, value: platform });
  let guard: typeof Guard;
  try {
    guard = await import("../src/state-guard.ts");
  } finally {
    Object.defineProperty(process, "platform", real);
  }
  return {
    guard,
    registry: await import("../src/registry.ts"),
    cli: await import("../src/cli.ts"),
  };
}

const WINDOWS = await load("win32");
const OTHERS = { linux: await load("linux"), darwin: await load("darwin") };

const POWERSHELL = machine.TOOLS[2]!;
/** 2026-11-16T21:27:01.1234567Z as Windows keeps it: 100 ns intervals since 1601. */
const CREATED = 134393380211234567n;
const LIVE = "2026-11-16T21:27:01.1234567Z";
const START = 4242;

const homes: string[] = [];
let kernel: MockInstance<typeof process.kill>;

beforeEach(() => {
  for (const mock of [launch, started, present, resolve, ...writes.values()]) mock.mockClear();
  kernel = vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (machine.gone.has(Number(pid))) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  machine.tools.clear();
  machine.root = null;
  machine.windows.clear();
  machine.posix.clear();
  machine.gone.clear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A made-up home, which `homedir()` returns on every system. */
function madeUpHome(): string {
  const home = mkdtempSync(join(tmpdir(), "clawtrate-windows-list-"));
  homes.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  return home;
}

/** An instance folder as a start leaves it, with its gateway as `gateway` records it. */
function instance(home: string, name: string | null, gateway: Record<string, unknown>) {
  const { guard } = WINDOWS;
  const stateDir = stateDirFor(name, home);
  const ports = name === null ? {} : { gatewayPort: 19200, providerPort: 19210 };
  const origin = { instance: name, checkout: home, startPid: START, startIdentity: LIVE, ...ports };
  guard.prepareFreshState(stateDir, guard.newRunId(), origin, () => {
    throw new Error("a new folder asks about no process");
  });
  const marker = { ...guard.readMarker(stateDir), ...gateway };
  writeFileSync(join(stateDir, guard.MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
  return stateDir;
}

/** Every file under `dir` with its size, time and contents, to show nothing changed. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .sort()
    .map((entry) => {
      const path = join(dir, entry);
      const stat = statSync(path);
      return `${entry} ${stat.size} ${stat.mtimeMs} ${stat.isFile() ? readFileSync(path, "utf8") : ""}`;
    });
}

/** Windows as it runs here: in C:\Windows, with its PowerShell, but no ps. */
function windowsMachine() {
  machine.root = "C:\\Windows";
  machine.tools.add(POWERSHELL);
}

/** The instances of a Windows machine: running, recorded in a way that can't compare, gone. */
function windowsHome(): string {
  windowsMachine();
  const home = madeUpHome();
  for (const pid of [START, 4343, 4444, 4747]) machine.windows.set(pid, String(CREATED));
  // 4545 is another process now: it was created 100 ns later than the one recorded.
  machine.windows.set(4545, String(CREATED + 1n));
  machine.gone.add(4646);
  instance(home, null, { gatewayPid: 4343, gatewayIdentity: LIVE });
  instance(home, "alpha", { gatewayPid: 4444, gatewayIdentity: "2026-11-16T21:27:01Z" });
  instance(home, "bravo", { gatewayPid: 4545, gatewayIdentity: LIVE });
  instance(home, "charlie", { gatewayPid: 4646, gatewayIdentity: LIVE });
  instance(home, "delta", {});
  instance(home, "echo", { gatewayPid: 4747, gatewayIdentity: "2026-02-30T21:27:01.1234567Z" });
  // Not the tool's: no marker, so not an instance.
  mkdirSync(join(home, ".openclaw-clawtrate-dev-foxtrot"));
  return home;
}

async function listed(cli: typeof WINDOWS.cli, ...args: string[]) {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
  await cli.main(["list", ...args], {});
  return lines;
}

const programs = () => launch.mock.calls.map(([program]) => program);
const askedAbout = () => present.mock.calls.map(([path]) => path as string);
const changed = () => [...writes].filter(([, spy]) => spy.mock.calls.length > 0).map(([n]) => n);

it("list on Windows reads each gateway with the running Windows' own lookup and changes nothing", async () => {
  const home = windowsHome();
  const before = snapshot(home);
  for (const spy of writes.values()) spy.mockClear();
  const [json, ...more] = await listed(WINDOWS.cli, "--json");
  expect(more).toEqual([]);
  const rows = JSON.parse(json!) as Array<{ name: string | null; gatewayState: string }>;
  expect(
    Object.fromEntries(rows.map((row) => [row.name ?? "(default)", row.gatewayState])),
  ).toEqual({
    "(default)": "alive",
    alpha: "unknown",
    bravo: "dead",
    charlie: "dead",
    delta: "none",
    echo: "unknown",
  });
  // Windows' own PowerShell for each PID the kernel still has, and nothing else.
  expect(programs()).toEqual([POWERSHELL, POWERSHELL, POWERSHELL, POWERSHELL]);
  expect(resolve.mock.calls.filter(([path]) => path === machine.SYSTEM_ROOT)).toHaveLength(4);
  expect(askedAbout().filter((path) => path.endsWith("/ps"))).toEqual([]);
  expect(kernel.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  expect(started).not.toHaveBeenCalled();
  expect(changed()).toEqual([]);
  expect(snapshot(home)).toEqual(before);
});

it("list on Windows prints a running gateway as running and one it can't compare as unknown", async () => {
  const home = windowsHome();
  const before = snapshot(home);
  const lines = await listed(WINDOWS.cli);
  expect(lines).toContain("  gateway   running, pid 4343");
  expect(lines).toContain("  gateway   unknown (pid 4444)");
  expect(lines).toContain("  gateway   unknown (pid 4747)");
  expect(lines.filter((line) => line === "  gateway   stopped")).toHaveLength(3);
  expect(snapshot(home)).toEqual(before);
});

it("list on Windows with no instances says so and looks up nothing", async () => {
  windowsMachine();
  const home = madeUpHome();
  mkdirSync(join(home, ".openclaw-clawtrate-dev-foxtrot"));
  expect(await listed(WINDOWS.cli)).toEqual(["No development gateway instances on this machine."]);
  expect(await listed(WINDOWS.cli, "--json")).toEqual(["[]"]);
  expect(launch).not.toHaveBeenCalled();
});

it("list on Windows without its PowerShell, or with Windows unresolved, shows unknown and runs no ps", async () => {
  const home = windowsHome();
  for (const broken of [() => machine.tools.clear(), () => (machine.root = null)]) {
    windowsMachine();
    broken();
    launch.mockClear();
    const rows = JSON.parse((await listed(WINDOWS.cli, "--json"))[0]!) as Array<{
      gatewayState: string;
    }>;
    expect(rows.map((row) => row.gatewayState)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "dead",
      "none",
      "unknown",
    ]);
    expect(launch).not.toHaveBeenCalled();
  }
  expect(askedAbout().filter((path) => path.endsWith("/ps"))).toEqual([]);
  expect(readdirSync(home).length).toBe(7);
});

it("on Windows, every other way in sees no live process and runs nothing", async () => {
  const home = windowsHome();
  const { guard, registry, cli } = WINDOWS;
  const stateDir = stateDirFor(null, home);
  const marker = guard.readMarker(stateDir)!;
  const before = snapshot(home);
  expect(guard.processIdentity(4343).state).toBe("unknown");
  expect(guard.processIdentity(4646)).toEqual({ state: "exited", how: "absent" });
  expect(() => guard.ownIdentity(undefined, 0)).toThrow("could not determine");
  const opened = cli.openInstance(null, { home, runRoot: join(home, "run") });
  expect(opened.identify).toBe(guard.processIdentity);
  expect(opened.identify(4343).state).toBe("unknown");
  const states = registry.listInstances(home).map((entry) => entry.gatewayState);
  expect(states).not.toContain("alive");
  const rows = cli.list({ home, json: true, log: () => {} });
  expect(rows.map((row) => row.gatewayState)).not.toContain("alive");
  expect(guard.activityRefusal(stateDir, null)).toContain("could not determine");
  expect(guard.inUseRefusal(stateDir, null, null, home)).toContain("could not determine");
  const origin = { instance: null, checkout: home, startPid: START, startIdentity: LIVE };
  expect(() => guard.prepareFreshState(stateDir, guard.newRunId(), origin)).toThrow(
    guard.StateInUseError,
  );
  expect(() => guard.recordProcess(stateDir, marker.runId, "gateway", 4343)).toThrow(
    "could not be recorded",
  );
  expect(snapshot(home)).toEqual(before);
  expect(launch).not.toHaveBeenCalled();
  expect(resolve.mock.calls.filter(([path]) => path === machine.SYSTEM_ROOT)).toEqual([]);
  expect(askedAbout().filter((path) => machine.TOOLS.includes(path))).toEqual([]);
  expect(kernel.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each(["linux", "darwin"] as const)(
  "on %s, list and every decision use ps as before",
  async (platform) => {
    const { guard, cli } = OTHERS[platform];
    expect(guard.readOnlyIdentity).toBe(guard.processIdentity);
    machine.tools.add("/bin/ps");
    windowsMachine();
    const home = madeUpHome();
    machine.posix.set(4343, "S Mon Nov 16 21:27:01 2026\n");
    instance(home, null, { gatewayPid: 4343, gatewayIdentity: "2026-11-16T21:27:01Z" });
    const rows = JSON.parse((await listed(cli, "--json"))[0]!) as Array<{ gatewayState: string }>;
    expect(rows.map((row) => row.gatewayState)).toEqual(["alive"]);
    expect(guard.processIdentity(4343)).toEqual({
      state: "alive",
      identity: "2026-11-16T21:27:01Z",
    });
    expect(new Set(programs())).toEqual(new Set(["/bin/ps"]));
    expect(resolve.mock.calls.filter(([path]) => path === machine.SYSTEM_ROOT)).toEqual([]);
  },
);
