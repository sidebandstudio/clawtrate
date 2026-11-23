// `pnpm mobile:check` stopped by a signal before it starts the driver: nothing is
// spawned, and only its own device and instance are removed. Every subprocess,
// file and socket is a mock; no Simulator, gateway or process is touched.
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => {
  const device = "41D5162E-6110-4853-98C5-0B53076DE619";
  const name = `Clawtrate checks ${"11".repeat(24)}`;
  const simulator = { interruptCreate: false, duplicate: false };
  const runtimes = JSON.stringify({
    runtimes: [
      {
        identifier: "SimRuntime.iOS.test",
        version: "27",
        isAvailable: true,
        supportedDeviceTypes: [{ name: "iPhone 17", identifier: "test-phone" }],
      },
    ],
  });
  return {
    device,
    name,
    simulator,
    execFileSync: vi.fn((_command: string, args: string[]) => {
      if (args[0] === "-o") return "Thu Nov 19 08:20:00 2026";
      if (args[1] === "list" && args[2] === "runtimes") return runtimes;
      if (args[1] === "list" && args[2] === "devices") {
        const own = { udid: device, name, state: "Booted" };
        const other = { ...own, udid: "2091D612-BBED-47BC-B81C-241416358691" };
        return JSON.stringify({
          devices: {
            runtime: [own, { ...other, name: simulator.duplicate ? name : "Another device" }],
          },
        });
      }
      if (args[1] === "create") {
        if (simulator.interruptCreate) throw new Error("Interrupted while creating the device");
        return device;
      }
      return "";
    }),
    spawn: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 0, stderr: "" })),
    writeFileSync: vi.fn((_path: string, _data: string) => {}),
    rmSync: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFileSync: io.execFileSync,
  spawnSync: io.spawnSync,
  spawn: io.spawn,
}));
vi.mock("node:fs", () => ({
  existsSync: () => true,
  readdirSync: () => [],
  readFileSync: () => {
    throw new Error("No earlier run");
  },
  writeFileSync: io.writeFileSync,
  renameSync: () => {},
  rmSync: io.rmSync,
}));
vi.mock("node:crypto", () => ({ randomBytes: () => Buffer.alloc(24, 0x11) }));
// The loopback port for the driver's settings: the signal comes while it closes.
vi.mock("node:net", () => ({
  createServer: () => ({
    listen: (_port: number, host: string, done: () => void) => {
      expect(host).toBe("127.0.0.1");
      done();
    },
    address: () => ({ port: 47000 }),
    close: (done: () => void) => {
      process.emit("SIGINT", "SIGINT");
      done();
    },
  }),
}));
vi.mock("../../desktop/src/host/runtime.ts", () => ({
  readDevConnection: () => ({ url: "ws://127.0.0.1:47001", token: "check-signal-token" }),
}));
vi.mock("../scripts/build.ts", () => ({
  APP_PATH: "/check-signal/Clawtrate.app",
  BUILD_DIR: "/check-signal/build",
  BUNDLE_ID: "dev.clawtrate.mobile",
}));
vi.mock("../scripts/xcode.ts", () => ({ findDeveloperDir: () => "/check-signal/Xcode" }));

import { main } from "../scripts/check.ts";

describe("the Simulator check stopped early", () => {
  const run = "11".repeat(24);
  const gatewayCommand = (action: "start" | "reset") => [
    process.execPath,
    [
      join(import.meta.dirname, "../../../tools/dev-gateway/src/cli.ts"),
      action,
      "--instance",
      `ios-${run.slice(0, 12)}`,
      "--run-id",
      run,
    ],
  ];
  const calls = () => io.spawnSync.mock.calls.map((call) => (call as unknown[]).slice(0, 2));
  let before: Record<"SIGINT" | "SIGTERM", ReturnType<typeof process.listeners>>;
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    io.simulator.interruptCreate = false;
    io.simulator.duplicate = false;
    vi.stubEnv("JAVA_HOME", "/check-signal/java");
    before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    exitCode = process.exitCode;
  });

  afterEach(() => {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      for (const listener of process.listeners(signal))
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
  });

  it("starts no driver after a SIGINT that comes while it finds its loopback port, and removes only its own device and instance", async () => {
    io.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", 0));
      return child;
    });
    expect(await main()).toBe(130);
    expect(io.spawn).not.toHaveBeenCalled();
    const boot = io.execFileSync.mock.calls.findIndex(([, args]) => args[1] === "boot");
    expect(boot).toBeGreaterThanOrEqual(0);
    expect(io.spawnSync.mock.invocationCallOrder[0]).toBeGreaterThan(
      io.execFileSync.mock.invocationCallOrder[boot]!,
    );
    expect(calls()).toEqual([
      gatewayCommand("start"),
      ["xcrun", ["simctl", "shutdown", io.device]],
      ["xcrun", ["simctl", "delete", io.device]],
      gatewayCommand("reset"),
    ]);
  });

  it("recovers the named device when creation was interrupted before recording its identifier", async () => {
    io.simulator.interruptCreate = true;
    await expect(main()).rejects.toThrow("Interrupted while creating the device");
    const create = io.execFileSync.mock.calls.findIndex(([, args]) => args[1] === "create");
    expect(create).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(io.writeFileSync.mock.calls[0]![1])).toMatchObject({
      run,
      device: null,
      deviceName: io.name,
    });
    expect(io.writeFileSync.mock.invocationCallOrder[0]).toBeLessThan(
      io.execFileSync.mock.invocationCallOrder[create]!,
    );
    expect(calls()).toEqual([
      ["xcrun", ["simctl", "shutdown", io.device]],
      ["xcrun", ["simctl", "delete", io.device]],
      gatewayCommand("reset"),
    ]);
    expect(io.rmSync).toHaveBeenCalledOnce();
  });

  it("keeps the run record and leaves both devices alone if the name is ambiguous", async () => {
    io.simulator.interruptCreate = true;
    io.simulator.duplicate = true;
    await expect(main()).rejects.toThrow("Interrupted while creating the device");
    expect(calls()).toEqual([gatewayCommand("reset")]);
    expect(io.rmSync).not.toHaveBeenCalled();
  });
});
