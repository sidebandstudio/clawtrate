import { execFileSync } from "node:child_process";
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

it("reports no button as null", () => {
  vi.mocked(execFileSync).mockReturnValueOnce("");
  expect(taskbarOverlayDescription("app.id", [])).toBeNull();
});
