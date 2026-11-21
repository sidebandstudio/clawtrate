import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { choosePorts } from "../../../tools/dev-gateway/src/registry.ts";
import { MARKER_FILE } from "../../../tools/dev-gateway/src/state-guard.ts";
import {
  identityOf,
  liveProcess,
  seedInstance,
  stopChildren,
  testInstance,
  writeRun,
} from "../../../tools/dev-gateway/test/fixtures.ts";
import { probeEndpoint, probeTarget } from "./probe-endpoint.ts";

test("F-185 the probe refuses a reused listener before connecting, including on reconnect", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "device-probe-"));
  t.after(() => {
    stopChildren();
    rmSync(directory, { recursive: true, force: true });
  });
  const name = "probe-proof";
  const runRoot = join(directory, "runs");
  const ports = await choosePorts(name, directory);
  let attempts = 0;
  const server = createServer((socket) => {
    attempts++;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(ports.gatewayPort, "127.0.0.1", resolve),
  );
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const inst = testInstance(directory, runRoot, name);
  const { runId, marker } = seedInstance(directory, name, {
    runRoot,
    marker: ports,
    gateway: { pid: process.pid, identity: identityOf(process.pid) },
  });
  writeRun(inst.runFile, {
    runId,
    instance: name,
    checkout: inst.checkout,
    ...ports,
    startedAt: "",
  });
  const url = "ws://127.0.0.1:" + ports.gatewayPort;
  writeRun(inst.connectionFile, { runId, instance: name, url, token: "sample" });
  const endpoint = probeEndpoint(inst);
  assert.equal(endpoint.url, url);
  endpoint.recheck();

  const other = liveProcess();
  writeRun(join(inst.stateDir, MARKER_FILE), {
    ...marker,
    gatewayPid: other.pid,
    gatewayIdentity: other.identity,
  });
  assert.throws(endpoint.recheck, /owns the listener/);
  assert.throws(() => probeEndpoint(inst), /owns the listener/);
  assert.equal(attempts, 0);
});

test("F-185 a proxy reconnect ends when the experiment releases its listener", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  let checked = 0;
  const target = probeTarget(
    {
      url: "ws://127.0.0.1:19200",
      token: "sample",
      recheck: () => {
        checked++;
      },
    },
    server,
  );
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(target.url, `ws://127.0.0.1:${address.port}`);
    target.beforeConnect();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.throws(target.beforeConnect, /no longer listening/);
  assert.equal(checked, 2);
});
