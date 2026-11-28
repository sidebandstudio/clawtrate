import { execFileSync } from "node:child_process";
import type * as ChildProcesses from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { taskbarOverlayDescription, type OverlayRead } from "../e2e-packaged/windows.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
});

it("bounds each taskbar overlay read with a timeout", () => {
  vi.mocked(execFileSync).mockReturnValueOnce("found:3 unread\r\n");
  const reads: OverlayRead[] = [];
  expect(taskbarOverlayDescription("app.id", reads)).toBe("3 unread");
  expect(vi.mocked(execFileSync).mock.calls[0]![2]).toMatchObject({
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
  expect(reads).toEqual([{ at: expect.any(String), ms: expect.any(Number), value: "3 unread" }]);
});

it("counts a timed-out read as not yet, and records it", () => {
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
  });
  const reads: OverlayRead[] = [];
  expect(taskbarOverlayDescription("app.id", reads)).toBeUndefined();
  expect(reads).toEqual([{ at: expect.any(String), ms: expect.any(Number), error: "timed out" }]);
});

it("reports no button as null only when the finished search says so", () => {
  vi.mocked(execFileSync).mockReturnValueOnce("absent\r\n");
  const reads: OverlayRead[] = [];
  expect(taskbarOverlayDescription("app.id", reads)).toBeNull();
  expect(reads).toEqual([{ at: expect.any(String), ms: expect.any(Number), value: null }]);
  // Errors end the script before its answer, which comes after the whole search.
  const script = vi.mocked(execFileSync).mock.calls[0]![1]![3]!;
  expect(script.trimStart().startsWith("$ErrorActionPreference = 'Stop'")).toBe(true);
  expect(script.trimEnd().endsWith("if ($null -ne $found) { $found } else { 'absent' }")).toBe(
    true,
  );
});

it("counts empty or unexpected output as no answer, never as no button, and keeps none of it", () => {
  const reads: OverlayRead[] = [];
  for (const out of ["", "\r\n", "Add-Type : C:\\Users\\someone", "found", "absent:"]) {
    vi.mocked(execFileSync).mockReturnValueOnce(out);
    expect(taskbarOverlayDescription("app.id", reads), JSON.stringify(out)).toBeUndefined();
  }
  expect(reads.map((read) => ("error" in read ? read.error : read))).toEqual([
    "no output",
    "no output",
    "unexpected output",
    "unexpected output",
    "unexpected output",
  ]);
  expect(JSON.stringify(reads)).not.toMatch(/Add-Type|Users/);
});

// A real Windows PowerShell, with Add-Type replaced by a stand-in that fails as
// a .NET call does: the read's own script then never loads UI Automation. Only
// the script's error preference ends it there; without that, it goes on to
// answer absent. The marker is joined when the call runs, so an error that
// merely quotes the stand-in's line doesn't carry it.
it.runIf(process.platform === "win32")(
  "ends the read's script with an error, not the absent answer, when a step of it fails",
  async () => {
    vi.mocked(execFileSync).mockReturnValueOnce("absent");
    taskbarOverlayDescription("app.id", []);
    const script = vi.mocked(execFileSync).mock.calls[0]![1]![3]!;
    const { spawnSync } = await vi.importActual<typeof ChildProcesses>("node:child_process");
    const run = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `function Add-Type { [void][Enum]::Parse([DayOfWeek], 'synthetic-uia-' + 'load-failed') }\n${script}`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(run.status).toBe(1);
    expect(run.stderr.includes("synthetic-uia-load-failed")).toBe(true);
    expect(run.stdout.includes("absent")).toBe(false);
  },
  40_000,
);

it("records a failed read by its exit status or error code, never its script or PowerShell's complaint", () => {
  const failures = [
    // As execFileSync throws them: the message names the command line, script included.
    Object.assign(new Error("Command failed: powershell.exe -Command Add-Type ... $env:X"), {
      status: 1,
      signal: null,
      stderr: "Add-Type : Cannot add type. C:\\Users\\someone\\secret",
    }),
    Object.assign(new Error("spawnSync powershell.exe ENOENT"), { code: "ENOENT" }),
    Object.assign(new Error("killed"), { status: null, signal: "SIGKILL" }),
    Object.assign(new Error("odd"), { code: "not a code: C:\\Users\\someone" }),
  ];
  const reads: OverlayRead[] = [];
  for (const failure of failures) {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw failure;
    });
    expect(taskbarOverlayDescription("app.id", reads)).toBeUndefined();
  }
  expect(reads.map((read) => ("error" in read ? read.error : read))).toEqual([
    "failed with exit 1",
    "failed with ENOENT",
    "failed with SIGKILL",
    "failed",
  ]);
  expect(JSON.stringify(reads)).not.toMatch(/Add-Type|powershell|Users|\$env/i);
});
