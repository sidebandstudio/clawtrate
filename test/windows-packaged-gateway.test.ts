import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { currentRun } from "../e2e/setup-sandbox.ts";
import {
  privatePaths,
  removeDrainedRoot,
  stopGatewayGates,
  stopOwnedChildren,
} from "../e2e-packaged/windows-gateway.ts";
import { choosePorts } from "../tools/dev-gateway/src/registry.ts";
import { newRunId, prepareFreshState, readMarker } from "../tools/dev-gateway/src/state-guard.ts";
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

const name = "e2e-fedcba98";
async function runFiles(root: string) {
  const paths = privatePaths(root, name);
  mkdirSync(paths.home);
  const ports = await choosePorts(name, paths.home);
  const runId = newRunId();
  const origin = {
    checkout: root,
    instance: name,
    ...ports,
    startPid: process.pid,
    startIdentity: "100",
  };
  prepareFreshState(paths.stateDir, runId, origin, () => ({ state: "alive", identity: "100" }));
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(
    paths.runFile,
    JSON.stringify({ ...origin, runId, startedAt: new Date().toISOString() }),
  );
  return { ...paths, ...ports, runId };
}

it("keeps same-name records private and preserves state while either port is occupied", async () => {
  const roots = [0, 1].map(() => mkdtempSync(join(tmpdir(), "clawtrate-pairing-")));
  try {
    const first = await runFiles(roots[0]!);
    const second = await runFiles(roots[1]!);
    expect(first.runDir).not.toBe(second.runDir);
    for (const port of [first.gatewayPort, first.providerPort]) {
      const listener = createServer();
      try {
        listener.listen(port, "localhost");
        await once(listener, "listening");
        await expect(removeDrainedRoot(first.checkout, name, first.runId)).rejects.toThrow(
          `port ${port}`,
        );
        expect(existsSync(first.stateDir)).toBe(true);
        expect(currentRun(name, first.checkout)).toBe(first.runId);
      } finally {
        listener.close();
        await once(listener, "close");
      }
    }
    await removeDrainedRoot(first.checkout, name, first.runId);
    expect(existsSync(first.checkout)).toBe(false);
    expect(currentRun(name, second.checkout)).toBe(second.runId);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

it("waits for an aborted gateway gate before stopping its recorded provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawtrate-pairing-"));
  const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  const gate = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(70), 300)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  try {
    const files = await runFiles(root);
    const marker = {
      ...readMarker(files.stateDir)!,
      providerPid: provider.pid!,
      providerIdentity: "100",
      gatewayPending: true as const,
    };
    await stopGatewayGates(
      marker,
      [
        { child: provider, aborted: false },
        { child: gate, aborted: true },
      ],
      () => {
        expect(gate.exitCode).toBe(70);
        return { state: "alive", identity: "100" };
      },
    );
    expect(provider.exitCode !== null || provider.signalCode !== null).toBe(true);
  } finally {
    provider.kill();
    gate.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
