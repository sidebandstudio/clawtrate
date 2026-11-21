import { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { debuggingPort } from "../e2e-packaged/desktop-driver.ts";

vi.mock("node:fs", () => ({ existsSync: () => true, readFileSync: vi.fn() }));

beforeEach(() => {
  vi.mocked(readFileSync).mockReset();
});

it.each(["EBUSY", "ENOENT"])(
  "retries a %s read of Chromium's debugging port file",
  async (code) => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(code), { code });
    });
    vi.mocked(readFileSync).mockReturnValueOnce("42000\n/devtools/browser/fixture");
    await expect(debuggingPort("profile", new ChildProcess())).resolves.toBe(42000);
  },
);

it("propagates other debugging port read errors immediately", async () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  vi.mocked(readFileSync).mockImplementationOnce(() => {
    throw denied;
  });
  await expect(debuggingPort("profile", new ChildProcess())).rejects.toBe(denied);
});

it("waits while Chromium's debugging port file is empty or partly written", async () => {
  vi.mocked(readFileSync)
    .mockReturnValueOnce("")
    .mockReturnValueOnce("420")
    .mockReturnValueOnce("42000\n/devtools/browser/fixture");
  await expect(debuggingPort("profile", new ChildProcess())).resolves.toBe(42000);
  expect(readFileSync).toHaveBeenCalledTimes(3);
});
