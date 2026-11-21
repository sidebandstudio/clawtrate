// The device-node research probe sends a development instance's token. It may
// connect only to a gateway this checkout started and that is running now; a
// connection record left by a stopped gateway, whose loopback port another
// process holds, must stop it before any credential is sent.
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readProbeAllowlist } from "../docs/research/device-node/probe-allowlist.ts";
import { CHECKOUT_DIR } from "../tools/dev-gateway/src/env.ts";
import {
  NAMED_PORT_BLOCK,
  NAMED_PORT_RANGE,
  runDirFor,
} from "../tools/dev-gateway/src/instance.ts";
import { portFree } from "../tools/dev-gateway/src/registry.ts";
import {
  deadProcess,
  seedInstance,
  stopChildren,
  type Proc,
} from "../tools/dev-gateway/test/fixtures.ts";

afterAll(() => stopChildren());

const TOKEN = "synthetic-probe-token-0123456789";

/** A named instance's marker, run file and connection file, all agreeing, with the given gateway process. */
function record(name: string, port: number, gateway: Proc, checkout: string) {
  const home = mkdtempSync(join(tmpdir(), "clawtrate-probe-home-"));
  const runRoot = join(checkout, "tools/dev-gateway/.run");
  const { runId } = seedInstance(home, name, {
    gateway,
    checkout,
    runRoot,
    marker: { gatewayPort: port, providerPort: port + 10 },
  });
  const runDir = runDirFor(name, runRoot);
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      runId,
      instance: name,
      checkout,
      gatewayPort: port,
      providerPort: port + 10,
      startedAt: "",
    }),
  );
  const connectionFile = join(runDir, "connection.json");
  writeFileSync(
    connectionFile,
    JSON.stringify({ url: `ws://127.0.0.1:${port}`, token: TOKEN, instance: name, runId }),
  );
  return { home, runDir };
}

async function freePort(): Promise<number> {
  let port = NAMED_PORT_RANGE.first + 20 * NAMED_PORT_BLOCK;
  while (!(await portFree(port))) port += NAMED_PORT_BLOCK;
  return port;
}

describe("the device-node probe proves its endpoint before it sends a credential", () => {
  it("a stale record with its loopback port reused: the probe stops before connecting, and the listener receives nothing", async () => {
    const name = `probe-stale-${process.pid}`;
    const port = await freePort();
    // Another process now holds the port the stopped gateway used.
    const received: string[] = [];
    let connections = 0;
    const listener = createServer((socket) => {
      connections += 1;
      socket.on("data", (data) => received.push(String(data)));
    });
    await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
    // The record sits where the probe reads it: this checkout's run folder for the instance.
    const stale = record(name, port, deadProcess(), CHECKOUT_DIR);
    try {
      const run = spawnSync(
        process.execPath,
        ["docs/research/device-node/node-probe.ts", "drop", "--instance", name],
        {
          cwd: CHECKOUT_DIR,
          env: { ...process.env, HOME: stale.home },
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      const output = `${run.stdout}${run.stderr}`;
      expect(run.status).not.toBe(0);
      expect(output).toContain("Error: the gateway recorded for the instance is not running");
      expect(output).not.toContain(TOKEN);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(connections).toBe(0);
      expect(received.join("")).not.toContain(TOKEN);
    } finally {
      listener.close();
      rmSync(stale.runDir, { recursive: true, force: true });
      rmSync(stale.home, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("the device-node probe's allowlist read", () => {
  const hash = "stored-revision";
  const snapshot = (allow: unknown) => ({
    valid: true,
    hash,
    config: { gateway: { nodes: { commands: { allow } } } },
  });

  it("rejects the empty fallback config from an invalid snapshot", () => {
    expect(() => readProbeAllowlist({ valid: false, hash, config: {} })).toThrow(
      "did not confirm a valid configuration",
    );
  });

  it("requires a configuration object and a usable revision", () => {
    expect(() => readProbeAllowlist({ valid: true, config: {} })).toThrow(
      "did not return a configuration hash",
    );
    expect(() => readProbeAllowlist({ valid: true, hash: " ", config: {} })).toThrow(
      "did not return a configuration hash",
    );
    expect(() => readProbeAllowlist({ valid: true, hash })).toThrow(
      "did not return a configuration object",
    );
  });

  it("accepts absent and empty allowlists from valid snapshots", () => {
    expect(readProbeAllowlist({ valid: true, hash, config: {} })).toEqual({ hash, allow: [] });
    expect(readProbeAllowlist(snapshot([]))).toEqual({ hash, allow: [] });
  });

  it("preserves populated lists and rejects malformed ones", () => {
    const allow = ["clawtrate.probe.echo", "other.command"];
    expect(readProbeAllowlist(snapshot(allow))).toEqual({ hash, allow });
    expect(() => readProbeAllowlist(snapshot(["clawtrate.probe.echo", 1]))).toThrow(
      "invalid node command allowlist",
    );
    expect(() =>
      readProbeAllowlist({ valid: true, hash, config: { gateway: { nodes: false } } }),
    ).toThrow("invalid gateway node configuration");
  });
});
