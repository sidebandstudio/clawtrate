// A process is identified by the system's own ps, run by its fixed path with a
// fixed environment, so a PATH or a locale of the caller's can't change which
// program answers or how it writes the start time. On Windows only commands
// that read state identify a live process, with the running Windows' own
// PowerShell, which reads the creation time from the kernel; every decision
// learns only whether the kernel has the PID.
import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const launch = vi.hoisted(() =>
  vi.fn(() => ({ error: undefined, status: 0, stdout: "S Mon Nov 16 21:27:01 2026\n" })),
);
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawnSync: launch,
}));
// Which system tools are present, and where the kernel's link to the running Windows leads, so
// each system's choice and each Windows layout can be checked on any system. Nothing found
// unless a test says so.
const present = vi.hoisted(() => vi.fn((_path: string) => false));
const resolve = vi.hoisted(() =>
  vi.fn((path: string): string => {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  }),
);
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof Fs>();
  const realpathSync = Object.assign(
    (...args: Parameters<typeof fs.realpathSync>) => fs.realpathSync(...args),
    { native: resolve },
  );
  return { ...fs, existsSync: present, realpathSync };
});

const {
  StateInUseError,
  activityRefusal,
  newRunId,
  ownIdentity,
  prepareFreshState,
  processIdentity,
  processVerdict,
  readMarker,
  readOnlyIdentity,
  systemIdentity,
  windowsIdentity,
} = await import("../src/state-guard.ts");

const SYSTEM_ROOT = "\\\\?\\GLOBALROOT\\SystemRoot";
const powerShellIn = (root: string) => `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const POWERSHELL = powerShellIn("C:\\Windows");
/** 2026-11-16T21:27:01.1234567Z as Windows keeps it: 100 ns intervals since 1601. */
const CREATED = 134393380211234567n;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  launch.mockReset();
  present.mockReset();
  resolve.mockReset();
});

type Launch = [string, string[], { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean }];
const launched = (call = 0) => launch.mock.calls[call] as unknown as Launch;

function onlyPresent(...paths: string[]) {
  present.mockImplementation((path) => paths.includes(path));
}

/** The running Windows is in `root`, as the kernel's link says, with its PowerShell there. */
function windowsIn(root: string, ...alsoPresent: string[]) {
  resolve.mockImplementation((path) => {
    if (path === SYSTEM_ROOT) return root;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  });
  onlyPresent(powerShellIn(root), ...alsoPresent);
}

function printed(stdout: string) {
  launch.mockReturnValue({ error: undefined, status: 0, stdout });
}

/** The kernel's answers to signal 0, in turn: an error code, or none when the PID exists. */
function kernel(...answers: Array<string | null>) {
  return vi.spyOn(process, "kill").mockImplementation(() => {
    const code = answers.length > 1 ? answers.shift() : answers[0];
    if (!code) return true;
    throw Object.assign(new Error(code), { code });
  });
}

it("S5: setup identifies processes by absolute system ps with a fixed environment", () => {
  onlyPresent("/bin/ps", "/usr/bin/ps");
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.stubEnv("PATH", "/tmp/elsewhere");
  vi.stubEnv("LANG", "de_DE.UTF-8");
  try {
    expect(systemIdentity("linux")(4343)).toEqual({
      state: "alive",
      identity: "2026-11-16T21:27:01Z",
    });
  } finally {
    vi.unstubAllEnvs();
  }
  expect(launch).toHaveBeenCalledTimes(1);
  const [program, argv, options] = launched();
  expect(["/bin/ps", "/usr/bin/ps"]).toContain(program);
  expect(argv).toEqual(["-o", "stat=", "-o", "lstart=", "-p", "4343"]);
  expect(Object.hasOwn(options.env, "PATH")).toBe(false);
  expect(Object.hasOwn(options.env, "LANG")).toBe(false);
  expect(options.env.LC_ALL).toBe("C");
});

it("F-492: a start identity is the same in any time zone, and one recorded in a local zone is unknown", () => {
  onlyPresent("/bin/ps", "/usr/bin/ps");
  vi.spyOn(process, "kill").mockReturnValue(true);
  const seen: Array<string | undefined> = [];
  for (const zone of ["America/New_York", "Asia/Tokyo", undefined]) {
    if (zone) vi.stubEnv("TZ", zone);
    launch.mockClear();
    expect(systemIdentity("darwin")(4343)).toEqual({
      state: "alive",
      identity: "2026-11-16T21:27:01Z",
    });
    seen.push(launched()[2].env.TZ);
    vi.unstubAllEnvs();
  }
  // ps always reads in UTC, whatever zone the caller has.
  expect(seen).toEqual(["UTC", "UTC", "UTC"]);
  const identify = () => ({ state: "alive" as const, identity: "2026-11-16T21:27:01Z" });
  expect(processVerdict(4343, "2026-11-16T21:27:01Z", identify).state).toBe("alive");
  // A marker or run record of an earlier version, in its writer's local time: neither a match
  // nor a mismatch, so nothing is started over, signalled or deleted on its word.
  expect(processVerdict(4343, "Mon Nov 16 21:27:01 2026", identify).state).toBe("unknown");
  expect(processVerdict(4343, "Mon Nov 16 16:27:01 2026", identify).state).toBe("unknown");
});

it.each(["absent", "zombie"] as const)(
  "an older run can be cleaned up when its recorded PID is %s",
  (how) => {
    expect(
      processVerdict(4343, "Mon Nov 16 21:27:01 2026", () => ({ state: "exited", how })),
    ).toEqual({ state: "dead" });
  },
);

it("each system uses its own lookup: ps on macOS and Linux, none on Windows but for reading", () => {
  windowsIn("C:\\Windows", "/bin/ps", "/usr/bin/ps");
  vi.spyOn(process, "kill").mockReturnValue(true);
  for (const platform of ["win32", "darwin", "linux"] as const) systemIdentity(platform)(4343);
  expect(launch.mock.calls.map((_, call) => launched(call)[0])).toEqual(["/bin/ps", "/bin/ps"]);
  // This system's lookups are the ones for the system it runs on.
  const windows = process.platform === "win32";
  launch.mockClear();
  processIdentity(4343);
  expect(launch.mock.calls.map((_, call) => launched(call)[0])).toEqual(windows ? [] : ["/bin/ps"]);
  readOnlyIdentity(4343);
  expect(launch.mock.calls.map((_, call) => launched(call)[0])).toEqual(
    windows ? [POWERSHELL] : ["/bin/ps", "/bin/ps"],
  );
});

it("on Windows, a decision learns only the kernel's proof of absence, and nothing is run", () => {
  windowsIn("C:\\Windows", "/bin/ps", "/usr/bin/ps");
  printed(String(CREATED));
  const decide = systemIdentity("win32");
  // Alive, someone else's, or not checkable: unknown, never an identity to act on.
  for (const exists of [null, "EPERM", "EINVAL"]) {
    kernel(exists);
    expect(decide(4343).state).toBe("unknown");
  }
  kernel("ESRCH");
  expect(decide(4343)).toEqual({ state: "exited", how: "absent" });
  const signals = kernel(null);
  expect(decide(0).state).toBe("unknown");
  expect(signals.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  // So this process can't record itself, and a start can't begin on Windows.
  expect(() => ownIdentity(decide, 0)).toThrow("could not determine this process's start time");
  expect(launch).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  expect(present).not.toHaveBeenCalled();
});

it("on Windows, a process is its creation time, read by Windows' own PowerShell with a fixed environment", () => {
  windowsIn("C:\\Windows");
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.stubEnv("PATH", "C:\\elsewhere");
  vi.stubEnv("SystemRoot", "C:\\elsewhere");
  vi.stubEnv("PSModulePath", "C:\\Program Files\\PowerShell\\7\\Modules");
  printed(`${CREATED}\r\n`);
  const windows = windowsIdentity();
  for (const zone of ["America/New_York", "Asia/Tokyo"]) {
    vi.stubEnv("TZ", zone);
    expect(windows(4343)).toEqual({ state: "alive", identity: "2026-11-16T21:27:01.1234567Z" });
  }
  const [program, argv, options] = launched();
  expect(program).toBe(POWERSHELL);
  expect(argv.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  const script = argv[4]!;
  // This PID alone, opened only to read its times; nothing else of the system is called.
  expect(script).toContain("OpenProcess(0x1000, $false, 4343)");
  expect([...script.matchAll(/DefinePInvokeMethod\('(\w+)'/g)].map(([, name]) => name)).toEqual([
    "OpenProcess",
    "GetProcessTimes",
    "CloseHandle",
  ]);
  expect(options.env).toEqual({ SystemRoot: "C:\\Windows" });
  expect(options.windowsHide).toBe(true);
  expect(options.timeout).toBeGreaterThan(0);
});

it("on Windows, the PowerShell run is the running Windows', wherever the kernel's link says it is", () => {
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.stubEnv("SystemRoot", "C:\\Windows");
  vi.stubEnv("windir", "C:\\Windows");
  printed(String(CREATED));
  // Running from another drive while another Windows is installed in C:\Windows: that one is never run.
  windowsIn("D:\\Win", POWERSHELL);
  expect(windowsIdentity()(4343).state).toBe("alive");
  expect(resolve.mock.calls).toEqual([[SYSTEM_ROOT]]);
  const [program, , options] = launched();
  expect(program).toBe(powerShellIn("D:\\Win"));
  expect(options.env).toEqual({ SystemRoot: "D:\\Win" });
});

it.each([
  ["the kernel's link can't be resolved", "ENOENT"],
  ["the kernel's link may not be resolved", "EACCES"],
  ["the resolved folder has no PowerShell", null],
])("on Windows, no answer and nothing run when %s, even with another Windows in C:", (_, code) => {
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.stubEnv("SystemRoot", "C:\\Windows");
  onlyPresent(POWERSHELL);
  resolve.mockImplementation((path) => {
    if (code === null && path === SYSTEM_ROOT) return "D:\\Win";
    throw Object.assign(new Error(`${code}: ${path}`), { code });
  });
  expect(windowsIdentity()(4343).state).toBe("unknown");
  expect(launch).not.toHaveBeenCalled();
});

it("on Windows, a PID reused even within the same second is another process", () => {
  windowsIn("C:\\Windows");
  vi.spyOn(process, "kill").mockReturnValue(true);
  const windows = windowsIdentity();
  printed(String(CREATED));
  const recorded = windows(4343);
  expect(recorded.state).toBe("alive");
  const identity = (recorded as { identity: string }).identity;
  expect(processVerdict(4343, identity, windows).state).toBe("alive");
  // Created 100 ns later: the recorded process is gone and its PID belongs to another.
  printed(String(CREATED + 1n));
  expect(processVerdict(4343, identity, windows).state).toBe("dead");
});

it.each([
  ["it may not be opened", { error: undefined, status: 2, stdout: "" }],
  ["PowerShell fails", { error: undefined, status: 1, stdout: "" }],
  ["PowerShell prints nothing", { error: undefined, status: 0, stdout: "" }],
  [
    "PowerShell prints something else",
    { error: undefined, status: 0, stdout: "Access is denied." },
  ],
  [
    "PowerShell prints two times",
    { error: undefined, status: 0, stdout: `${CREATED}\r\n${CREATED}` },
  ],
  ["PowerShell prints a time before 1970", { error: undefined, status: 0, stdout: "1" }],
  ["PowerShell prints a negative time", { error: undefined, status: 0, stdout: "-5" }],
  [
    "PowerShell can't be started",
    {
      error: Object.assign(new Error(`spawnSync ${POWERSHELL} EINVAL`), { code: "EINVAL" }),
      status: null,
      stdout: null,
    },
  ],
  [
    "PowerShell times out",
    {
      error: Object.assign(new Error(`spawnSync ${POWERSHELL} ETIMEDOUT`), { code: "ETIMEDOUT" }),
      status: null,
      signal: "SIGTERM",
      stdout: "",
    },
  ],
])("on Windows, a process that exists stays unknown when %s", (_, result) => {
  windowsIn("C:\\Windows");
  launch.mockReturnValue(result as never);
  for (const exists of [null, "EPERM"]) {
    kernel(exists);
    expect(windowsIdentity()(4343).state).toBe("unknown");
  }
});

it("on Windows, a kernel check that gives no answer gives no answer, and nothing is run", () => {
  windowsIn("C:\\Windows");
  kernel("EINVAL");
  expect(windowsIdentity()(4343).state).toBe("unknown");
  expect(launch).not.toHaveBeenCalled();
});

it("on Windows, only the kernel establishes that a process is gone", () => {
  windowsIn("C:\\Windows");
  kernel("ESRCH");
  expect(windowsIdentity()(4343)).toEqual({ state: "exited", how: "absent" });
  expect(launch).not.toHaveBeenCalled();
  // It exited between the two looks: PowerShell can't open it, and the kernel no longer has it.
  kernel(null, "ESRCH");
  launch.mockReturnValue({ error: undefined, status: 2, stdout: "" });
  expect(windowsIdentity()(4343)).toEqual({ state: "exited", how: "absent" });
});

const LIVE = "2026-11-16T21:27:01.1234567Z";
const live = () => ({ state: "alive" as const, identity: LIVE });

it.each([
  ["whole seconds, as ps writes them", "2026-11-16T21:27:01Z"],
  ["six digits", "2026-11-16T21:27:01.123456Z"],
  ["eight digits", "2026-11-16T21:27:01.12345670Z"],
  ["no zone", "2026-11-16T21:27:01.1234567"],
  ["an offset", "2026-11-16T21:27:01.1234567+00:00"],
  ["lower case", "2026-11-16t21:27:01.1234567z"],
  ["a space before it", ` ${LIVE}`],
  ["February 30", "2026-02-30T21:27:01.1234567Z"],
  ["February 29 of a common year", "2027-02-29T00:00:00.0000000Z"],
  ["month 13", "2026-13-16T21:27:01.1234567Z"],
  ["hour 24", "2026-11-16T24:00:00.0000000Z"],
  ["minute 60", "2026-11-16T21:60:01.1234567Z"],
  ["second 60", "2026-11-16T21:27:60.1234567Z"],
  ["a time before 1970", "1969-12-31T23:59:59.9999999Z"],
  ["a local time of an older version", "Mon Nov 16 21:27:01 2026"],
  ["no time at all", "4343"],
])("on Windows, a live process recorded with %s is unknown, never dead", (_, recorded) => {
  expect(processVerdict(4343, recorded, live).state).toBe("unknown");
  // Its recorded process may still be gone, but only when the kernel says so.
  expect(processVerdict(4343, recorded, () => ({ state: "exited", how: "absent" }))).toEqual({
    state: "dead",
  });
});

it("on Windows, a recorded creation time is still compared: the same is alive, another is dead", () => {
  expect(processVerdict(4343, LIVE, live).state).toBe("alive");
  expect(processVerdict(4343, "2026-11-16T21:27:01.1234568Z", live).state).toBe("dead");
  expect(processVerdict(4343, "2028-02-29T00:00:00.0000000Z", live).state).toBe("dead");
  // A live time of the same shape that is no creation time compares with nothing.
  const impossible = () => ({ state: "alive" as const, identity: "2026-02-30T21:27:01.1234567Z" });
  expect(processVerdict(4343, LIVE, impossible).state).toBe("unknown");
});

it("on macOS and Linux, start times compare as before", () => {
  const ps = () => ({ state: "alive" as const, identity: "2026-11-16T21:27:01Z" });
  expect(processVerdict(4343, "2026-11-16T21:27:01Z", ps).state).toBe("alive");
  expect(processVerdict(4343, "2026-11-16T21:27:02Z", ps).state).toBe("dead");
  expect(processVerdict(4343, LIVE, ps).state).toBe("dead");
});

it("on Windows, a folder whose live process has a questionable record is kept until the kernel says it is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-process-identity-"));
  try {
    const state = join(dir, "state");
    const first = newRunId();
    const origin = {
      instance: null,
      checkout: dir,
      startPid: 4343,
      startIdentity: "2026-11-16T21:27:01Z",
    };
    prepareFreshState(state, first, origin, live);
    writeFileSync(join(state, "kept"), "kept\n");
    // The recorded start is alive in Windows' words, and its record has whole seconds.
    windowsIn("C:\\Windows");
    kernel(null);
    printed(String(CREATED));
    const windows = windowsIdentity();
    expect(activityRefusal(state, null, windows)).toContain("not a Windows creation time");
    expect(() => prepareFreshState(state, newRunId(), origin, windows)).toThrow(StateInUseError);
    expect(readMarker(state)?.runId).toBe(first);
    expect(readFileSync(join(state, "kept"), "utf8")).toBe("kept\n");
    // Once the kernel has no such process, the folder is the tool's to start over.
    kernel("ESRCH");
    const next = newRunId();
    prepareFreshState(state, next, origin, windows);
    expect(readMarker(state)?.runId).toBe(next);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("on Windows, a decision keeps a folder whose recorded process lives, even with a matching record", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-process-identity-"));
  try {
    const state = join(dir, "state");
    const first = newRunId();
    const origin = { instance: null, checkout: dir, startPid: 4343, startIdentity: LIVE };
    prepareFreshState(state, first, origin, live);
    windowsIn("C:\\Windows");
    kernel(null);
    printed(String(CREATED));
    const decide = systemIdentity("win32");
    expect(() => prepareFreshState(state, newRunId(), origin, decide)).toThrow(StateInUseError);
    expect(readMarker(state)?.runId).toBe(first);
    expect(launch).not.toHaveBeenCalled();
    kernel("ESRCH");
    const next = newRunId();
    prepareFreshState(state, next, origin, decide);
    expect(readMarker(state)?.runId).toBe(next);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
