import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { stopElectron } from "./stop-electron.ts";

// Stand-ins for the Windows requests, so nothing here runs taskkill.
const windows = vi.hoisted(() => ({ askToClose: vi.fn(), forceEnd: vi.fn() }));
vi.mock("../../../../e2e-packaged/windows.ts", () => windows);

/** A child's handle as stopElectron sees it, with no process behind it. */
class FakeApp extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal?: NodeJS.Signals) => true);
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}
const child = (app: FakeApp) => app as unknown as ChildProcess;

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const unhandled: unknown[] = [];
const record = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // The 25-second deadline on the same fake clock as the 15-second force.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(new DOMException("timed out", "TimeoutError")), ms);
    return deadline.signal;
  });
  windows.askToClose.mockReset().mockReturnValue(null);
  windows.forceEnd.mockReset();
  unhandled.length = 0;
  process.on("unhandledRejection", record);
});

afterEach(() => {
  process.off("unhandledRejection", record);
  Object.defineProperty(process, "platform", platform);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Lets a rejection nobody awaits reach the process's unhandledRejection listeners. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function on(os: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...platform, value: os });
}

/** A stop's outcome so far, read without waiting on it: "pending", "exited" or its error. */
function outcome(stopping: Promise<void>) {
  const seen: { now: unknown } = { now: "pending" };
  stopping.then(
    () => (seen.now = "exited"),
    (error: unknown) => (seen.now = error),
  );
  return seen;
}

describe("on Windows", () => {
  beforeEach(() => on("win32"));

  it("asks the app to close and ends once it exits, forcing nothing", async () => {
    const app = new FakeApp();
    const stopped = stopElectron(child(app));
    expect(windows.askToClose).toHaveBeenCalledWith(4242);
    vi.advanceTimersByTime(1_000);
    app.exit(0);
    await expect(stopped).resolves.toBeUndefined();
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(app.kill).not.toHaveBeenCalled();
    expect(windows.forceEnd).not.toHaveBeenCalled();
    expect([app.listenerCount("exit"), app.listenerCount("error")]).toEqual([0, 0]);
    expect(unhandled).toEqual([]);
  });

  it("ends a refused app through its own handle, never by PID", async () => {
    windows.askToClose.mockReturnValue("ERROR: The process could not be terminated.");
    const app = new FakeApp();
    const stopped = stopElectron(child(app));
    expect(app.kill.mock.calls).toEqual([["SIGKILL"]]);
    expect(windows.forceEnd).not.toHaveBeenCalled();
    app.exit(1);
    await expect(stopped).resolves.toBeUndefined();
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(app.kill).toHaveBeenCalledTimes(1);
    expect(windows.forceEnd).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it("ends an app still open after 15 seconds through its own handle, never by PID", async () => {
    const app = new FakeApp();
    const stopped = stopElectron(child(app));
    vi.advanceTimersByTime(14_999);
    expect(app.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(app.kill.mock.calls).toEqual([["SIGKILL"]]);
    expect(windows.forceEnd).not.toHaveBeenCalled();
    app.exit(1);
    await expect(stopped).resolves.toBeUndefined();
    expect([app.listenerCount("exit"), app.listenerCount("error")]).toEqual([0, 0]);
  });

  it("reports an app that outlives the forced end at 25 seconds", async () => {
    const app = new FakeApp();
    const stopped = expect(stopElectron(child(app))).rejects.toThrow(
      "Electron PID 4242 did not exit after forced shutdown",
    );
    vi.advanceTimersByTime(25_000);
    await stopped;
    expect(app.kill.mock.calls).toEqual([["SIGKILL"]]);
    expect(windows.forceEnd).not.toHaveBeenCalled();
    expect([app.listenerCount("exit"), app.listenerCount("error")]).toEqual([0, 0]);
  });

  it("rejects with a refused app's kill error and leaves no wait or timer behind", async () => {
    windows.askToClose.mockReturnValue("ERROR: The process could not be terminated.");
    const fault = new Error("kill EPERM");
    const app = new FakeApp();
    app.kill.mockImplementation(() => {
      throw fault;
    });
    await expect(stopElectron(child(app))).rejects.toBe(fault);
    expect([app.listenerCount("exit"), app.listenerCount("error")]).toEqual([0, 0]);
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(app.kill).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it("rejects with the 15-second kill's error instead of throwing it from the timer", async () => {
    const fault = new Error("kill EPERM");
    const app = new FakeApp();
    app.kill.mockImplementation(() => {
      throw fault;
    });
    const stopped = expect(stopElectron(child(app))).rejects.toBe(fault);
    expect(() => vi.advanceTimersByTime(15_000)).not.toThrow();
    await stopped;
    expect([app.listenerCount("exit"), app.listenerCount("error")]).toEqual([0, 0]);
    vi.advanceTimersByTime(15_000);
    await settle();
    expect(app.kill).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it("rejects with the ask's own error when asking to close throws, leaving no wait behind", async () => {
    const fault = new Error("taskkill did not start");
    windows.askToClose.mockImplementation(() => {
      throw fault;
    });
    const app = new FakeApp();
    await expect(stopElectron(child(app))).rejects.toBe(fault);
    expect([app.listenerCount("exit"), app.listenerCount("error")]).toEqual([0, 0]);
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(app.kill).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  // A relaunch still waiting on its stop when the test's timeout runs the disposer on the same app.
  it.each([
    ["stays open", () => {}],
    ["then exits", (app: FakeApp) => app.exit(1)],
  ])(
    "gives both overlapping stops the error a refused second ask's kill reports, when the app %s",
    async (_, after) => {
      const fault = new Error("kill EPERM");
      const app = new FakeApp();
      const first = outcome(stopElectron(child(app)));
      windows.askToClose.mockReturnValue("ERROR: The process could not be terminated.");
      // Emitted during the kill, as a real child does; the first stop's listener keeps it from throwing.
      app.kill.mockImplementation(() => app.emit("error", fault));
      const second = outcome(stopElectron(child(app)));
      after(app);
      await settle();
      expect(first.now).toBe(fault);
      expect(second.now).toBe(fault);
      expect(app.kill.mock.calls).toEqual([["SIGKILL"]]);
      expect([app.listenerCount("exit"), app.listenerCount("error")]).toEqual([0, 0]);
      // The two deadlines alone, which AbortSignal.timeout never clears either.
      expect(vi.getTimerCount()).toBe(2);
      expect(unhandled).toEqual([]);
    },
  );

  it("keeps the first overlapping stop waiting when a refused second ask's kill throws", async () => {
    const fault = new Error("kill EPERM");
    const app = new FakeApp();
    const first = outcome(stopElectron(child(app)));
    windows.askToClose.mockReturnValue("ERROR: The process could not be terminated.");
    app.kill.mockImplementation(() => {
      throw fault;
    });
    const second = outcome(stopElectron(child(app)));
    await settle();
    expect(second.now).toBe(fault);
    expect(first.now).toBe("pending");
    expect([app.listenerCount("exit"), app.listenerCount("error")]).toEqual([1, 1]);
    app.exit(0);
    await settle();
    expect(first.now).toBe("exited");
    expect([app.listenerCount("exit"), app.listenerCount("error")]).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(2);
    expect(unhandled).toEqual([]);
  });

  it("rejects with an error the kill reports as an event", async () => {
    const fault = new Error("kill EPERM");
    const app = new FakeApp();
    app.kill.mockImplementation(() => app.emit("error", fault));
    const stopped = expect(stopElectron(child(app))).rejects.toBe(fault);
    vi.advanceTimersByTime(15_000);
    await stopped;
    expect([app.listenerCount("exit"), app.listenerCount("error")]).toEqual([0, 0]);
  });
});

describe("on macOS", () => {
  beforeEach(() => on("darwin"));

  it("sends SIGTERM and ends once the app exits", async () => {
    const app = new FakeApp();
    const stopped = stopElectron(child(app));
    expect(app.kill.mock.calls).toEqual([["SIGTERM"]]);
    app.exit(null, "SIGTERM");
    await expect(stopped).resolves.toBeUndefined();
    vi.advanceTimersByTime(30_000);
    expect(app.kill).toHaveBeenCalledTimes(1);
    expect(windows.askToClose).not.toHaveBeenCalled();
  });

  it("sends SIGKILL to an app still open after 15 seconds", async () => {
    const app = new FakeApp();
    const stopped = stopElectron(child(app));
    vi.advanceTimersByTime(15_000);
    expect(app.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    app.exit(null, "SIGKILL");
    await expect(stopped).resolves.toBeUndefined();
    expect(windows.forceEnd).not.toHaveBeenCalled();
  });
});

describe.each(["win32", "darwin"] as const)("on %s, a child with nothing left to stop", (os) => {
  beforeEach(() => on(os));

  it.each([
    ["never started", (app: FakeApp) => (app.pid = undefined)],
    ["already exited", (app: FakeApp) => (app.exitCode = 0)],
    ["already ended by a signal", (app: FakeApp) => (app.signalCode = "SIGTERM")],
  ])("is left alone when it %s", async (_, state) => {
    const app = new FakeApp();
    state(app);
    await expect(stopElectron(child(app))).resolves.toBeUndefined();
    vi.advanceTimersByTime(30_000);
    expect(app.kill).not.toHaveBeenCalled();
    expect(windows.askToClose).not.toHaveBeenCalled();
    expect(windows.forceEnd).not.toHaveBeenCalled();
    expect(app.listenerCount("exit")).toBe(0);
  });
});
