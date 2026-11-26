// F-002: a true first run, from no pairing to a working conversation, counting every time the
// gateway is asked to approve this device (docs/decisions.md, "One pairing, with everything",
// 2026-11-25). The host is the desktop app's runtime with secure storage, as the packaged Mac
// app has it, but its box is the test's own (it never touches the Keychain). Nothing here drives
// the interface: the screens are the visual checks'.
//
// - Another computer: a protected address, `wss://gateway.clawtrate.test:<port>`, a TLS proxy of
//   the test's own in front of this run's shared instance. Every development instance keeps local
//   auto-approval off, so its pairing waits as one on another computer does. The first pairing
//   asks for the six, the owner approves once, and nothing asks again.
// - This computer: a typed `ws://127.0.0.1:<port>` on an instance of this file's own, started
//   with `--default-local-pairing` (OpenClaw's own default policy). Loopback isn't a protected
//   route until local connect's send gate, so the pairing asks for read, which the gateway
//   approves with no step, and the first send asks once more for sending and answering.
//
// The instance is this file's own: started in its beforeAll and reset in its afterAll, so only
// the shard that runs this file starts it, and recorded in a run record of its own first.
import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type { ClawtrateClient } from "../packages/core/src/client.ts";
import type { SecretBox } from "../packages/core/src/node/index.ts";
import { FULL_SCOPES, READ_SCOPES } from "../packages/core/src/scopes.ts";
import { startHostRuntime } from "../apps/desktop/src/host/runtime.ts";
import { instancePorts, openInstance, readDevConnection } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { newRunId, ownIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import { devGateway, FORBIDDEN_PORTS, listInstances, resetInstance } from "./global-setup.ts";
import { protectedGateway } from "./protected-gateway.ts";
// The test's own name for the proxy resolves to loopback in this worker alone.
import "./protected-gateway-preload.ts";
import { cleanUp, saveRecord, TEMP_PREFIX, type RunRecord } from "./run-record.ts";

const RECORDS = join(import.meta.dirname, "../tools/dev-gateway/.run/e2e");
const record: RunRecord = {
  run: randomBytes(4).toString("hex"),
  runner: { pid: process.pid, identity: "" },
  instances: [],
  host: null,
  dirs: [],
};
/** This file's own instance, with OpenClaw's default local pairing policy. */
const LOCAL = `e2e-${record.run}-firstrun`;
/** This run's shared instance: local auto-approval off, as on another computer. */
const SHARED = process.env.CLAWTRATE_DEV_INSTANCE!;

/** The test's own secure-storage box: never the system's. */
const flip = (bytes: Uint8Array) => Uint8Array.from(bytes, (byte) => byte ^ 0x5a);
const box: SecretBox = {
  available: async () => true,
  encrypt: async (text) => flip(new TextEncoder().encode(text)),
  decrypt: async (data) => new TextDecoder().decode(flip(data)),
};

type Device = { deviceId: string; requestId?: string; scopes?: string[] };

/** The instance's pending requests for one device, from the gateway's own list. */
async function pendingFor(instance: string, deviceId: string): Promise<Device[]> {
  const result = await openInstance(instance).runner.run(["devices", "list", "--json"]);
  if (result.status !== 0) throw new Error(`devices list exited ${result.status}`);
  const listed = parseJsonOutput<{ pending?: Device[] }>(result.stdout);
  return (listed.pending ?? []).filter((row) => row.deviceId === deviceId);
}

/**
 * A first run on a fresh host with secure storage: connect, approve every request the gateway
 * holds for this device as its owner would, open a new task of Otto's and send one message, until
 * the reply is in. Returns what each approval was asked for, in order.
 */
async function firstRun(
  instance: string,
  url: string,
  token: string,
): Promise<{ approvals: string[][]; client: ClawtrateClient; deviceId: string; done: () => void }> {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  record.dirs.push(dataDir);
  saveRecord(RECORDS, record);
  const runtime = await startHostRuntime({
    kind: "desktop",
    displayName: "Clawtrate first run check",
    dataDir,
    secretBox: box,
    devGateway: null,
    resume: false,
  });
  const { client } = runtime;
  let deviceId = "";
  const approvals: string[][] = [];
  try {
    await client.connect({ url, token });
    await expect.poll(() => (deviceId = client.state.connection.deviceId ?? "")).not.toBe("");
    const approved = new Set<string>();
    const approveWaiting = async () => {
      for (const request of await pendingFor(instance, deviceId)) {
        if (!request.requestId || approved.has(request.requestId)) continue;
        approved.add(request.requestId);
        approvals.push([...(request.scopes ?? [])].sort());
        const out = await openInstance(instance).runner.run([
          "devices",
          "approve",
          request.requestId,
        ]);
        if (out.status !== 0) throw new Error(`could not approve ${request.requestId}`);
      }
    };
    await expect
      .poll(async () => (await approveWaiting(), client.state.connection.status), {
        timeout: 60_000,
      })
      .toBe("connected");
    const key = `agent:otto:e2e-first-run-${randomBytes(3).toString("hex")}`;
    client.openSession(key);
    await expect
      .poll(() => client.state.transcripts[key]?.status, { timeout: 30_000 })
      .toBe("ready");
    client.sendMessage(key, "Hello from a first run.");
    await expect
      .poll(
        async () => {
          await approveWaiting();
          return client.state.transcripts[key]?.runs.at(-1)?.state;
        },
        { timeout: 60_000 },
      )
      .toBe("completed");
    expect(client.state.transcripts[key]!.items.some((item) => item.role === "assistant")).toBe(
      true,
    );
    // Nothing is left waiting for the owner once the conversation works.
    expect(await pendingFor(instance, deviceId)).toEqual([]);
  } catch (error) {
    // A first run that failed leaves nothing running and nothing on the gateway: its client is
    // stopped, its pending request refused and its device removed, then the failure stands.
    client.stop();
    if (deviceId) {
      const runner = openInstance(instance).runner;
      for (const request of await pendingFor(instance, deviceId).catch(() => []))
        if (request.requestId) await runner.run(["devices", "reject", request.requestId]);
      await runner.run(["devices", "remove", deviceId]);
    }
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
  return {
    approvals,
    client,
    deviceId,
    done: () => {
      client.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test.beforeAll(async () => {
  test.setTimeout(480_000);
  record.runner.identity = ownIdentity();
  const runId = newRunId();
  record.instances.push({ name: LOCAL, runId });
  saveRecord(RECORDS, record);
  expect(LOCAL).not.toBe(SHARED);
  // Seeded for Otto and the scripted model, with OpenClaw's default local pairing.
  process.stdout.write(devGateway(LOCAL, "start", "--run-id", runId, "--default-local-pairing"));
  const mine = listInstances().find((row) => row.name === LOCAL);
  if (!mine?.gatewayRunning) throw new Error(`instance ${LOCAL} is not running`);
  for (const port of [mine.gatewayPort, mine.providerPort]) {
    if (port === null || FORBIDDEN_PORTS.includes(port)) {
      throw new Error(`instance ${LOCAL} is on port ${port}, which e2e never uses`);
    }
  }
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  const problems = cleanUp(RECORDS, record, resetInstance);
  expect(problems).toEqual([]);
});

test("F-002: another computer at a secure address: one approval, for all six, and nothing asks again", async () => {
  test.setTimeout(240_000);
  const { token } = readDevConnection(openInstance(SHARED).connectionFile)!;
  const proxy = await protectedGateway(instancePorts(openInstance(SHARED)).gatewayPort);
  // This worker trusts the proxy's throwaway certificate, as the host given `env` does.
  setDefaultCACertificates([
    ...getCACertificates("default"),
    readFileSync(proxy.env.NODE_EXTRA_CA_CERTS, "utf8"),
  ]);
  let run: Awaited<ReturnType<typeof firstRun>> | null = null;
  try {
    run = await firstRun(SHARED, proxy.url, token);
    expect(run.approvals).toEqual([[...FULL_SCOPES].sort()]);
    expect(run.client.state.connection).toMatchObject({ fullPairing: true, canAdmin: true });
    // Admin and devices are held already: neither asks the gateway again.
    await run.client.requestAccess("admin").catch(() => {});
    await run.client.requestAccess("pairing").catch(() => {});
    expect(await pendingFor(SHARED, run.deviceId)).toEqual([]);
  } finally {
    run?.done();
    if (run) await openInstance(SHARED).runner.run(["devices", "remove", run.deviceId]);
    setDefaultCACertificates(getCACertificates("default"));
    await proxy.close();
  }
});

test("F-002: this computer at a typed loopback address: read is approved with no step, and the first send asks once", async () => {
  test.setTimeout(240_000);
  const connection = readDevConnection(openInstance(LOCAL).connectionFile)!;
  expect(connection.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
  const run = await firstRun(LOCAL, connection.url, connection.token);
  try {
    // The pairing itself took no approval; sending and answering took one.
    expect(run.approvals).toEqual([
      ["operator.approvals", "operator.questions", "operator.read", "operator.write"],
    ]);
    expect(run.client.state.connection.fullPairing).toBe(false);
    expect(run.client.state.connection.requestedScopes).not.toEqual([...READ_SCOPES]);
  } finally {
    run.done();
  }
});
