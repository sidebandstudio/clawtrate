import { expect, it, vi } from "vitest";
import { stopOwnedChildren } from "../e2e-packaged/windows-gateway.ts";
import { SCENARIO_EXAMPLES } from "../tools/dev-gateway/src/seed-data.ts";

it("does not stop a PID reused after the ownership preflight", () => {
  const stop = vi.fn();
  const identify = vi
    .fn()
    .mockReturnValueOnce({ state: "alive", identity: "100" })
    .mockReturnValue({ state: "alive", identity: "101" });
  stopOwnedChildren([{ pid: 42, identity: "100", stop }], identify);
  expect(stop).not.toHaveBeenCalled();
});

it("stops nothing when ownership of another recorded child is unknown", () => {
  const stop = vi.fn();
  const children = [42, 43].map((pid) => ({ pid, identity: "100", stop }));
  expect(() =>
    stopOwnedChildren(children, (pid) =>
      pid === 42
        ? { state: "alive", identity: "100" }
        : { state: "unknown", reason: "access denied" },
    ),
  ).toThrow("unknown ownership");
  expect(stop).not.toHaveBeenCalled();
});

it("stops the original child when both lookups still match", () => {
  const stop = vi.fn();
  stopOwnedChildren([{ pid: 42, identity: "100", stop }], () => ({
    state: "alive",
    identity: "100",
  }));
  expect(stop).toHaveBeenCalledOnce();
});

it("checks the same missing file in Windows and POSIX fixture errors", () => {
  const pattern = SCENARIO_EXAMPLES.find((example) => example.slug === "failed-step")!.results![0]!
    .content![0] as RegExp;
  const error = (path: string) =>
    JSON.stringify({ status: "error", tool: "read", error: `File not found: ${path}.` }, null, 2);
  expect(error("/fixture/workspace/missing/old-notes.md")).toMatch(pattern);
  expect(error("C:\\fixture\\workspace\\missing\\old-notes.md")).toMatch(pattern);
  expect(error("/fixture/workspace/old-notes.md")).not.toMatch(pattern);
});
