// Gateway client and recording servers shared by the provider-account probes.
// Research code for docs/research/provider-accounts-and-t3-code.md.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkout } from "./instance-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

/**
 * Starts recording-model.mjs servers logging to one temporary file, waits until each listens, and
 * stops them by PID on exit. The probes read every request back while they run, so stopping also
 * removes the log's folder.
 */
export async function startRecorders(specs) {
  for (const { port } of specs) if (await portOpen(port)) throw new Error(`port ${port} is already in use; refusing to start a recording server there`);
  const logDir = mkdtempSync(path.join(tmpdir(), "clawtrate-recorders-"));
  const log = path.join(logDir, "requests.jsonl");
  const children = specs.map(({ port, label }) => {
    const child = spawn(process.execPath, [path.join(here, "recording-model.mjs"), "--port", String(port), "--label", label, "--log", log], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stderrText = () => stderr;
    return child;
  });
  const stop = () => {
    for (const child of children) if (child.pid && child.exitCode === null) process.kill(child.pid, "SIGTERM");
    rmSync(logDir, { recursive: true, force: true });
  };
  process.on("exit", stop);
  for (const [i, { port }] of specs.entries()) {
    for (let tries = 0; !(await portOpen(port)); tries += 1) {
      if (children[i].exitCode !== null || tries > 50) {
        stop();
        throw new Error(`recording server on ${port} did not start: ${children[i].stderrText()}`);
      }
      await sleep(100);
    }
  }
  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const control = async (port, failKeys) => {
    const r = await fetch(`http://127.0.0.1:${port}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ failKeys }) });
    if (!r.ok) throw new Error(`control ${port}: ${r.status}`);
  };
  return { stop, requests, control };
}

/** Pairs a fresh device with the instance (approving it with the tool) and returns a request helper. */
export async function connectGateway(inst, scopes = ["operator.read", "operator.write", "operator.admin"]) {
  const require = createRequire(path.join(checkout, "packages/core/package.json"));
  const { GatewayClient } = await import(pathToFileURL(require.resolve("@openclaw/gateway-client")).href);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const deviceIdentity = {
    deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  const tokens = {};
  const events = [];
  const waiters = new Set();
  const connectOnce = () =>
    new Promise((resolve, reject) => {
      const client = new GatewayClient({
        url: inst.connection.url,
        token: inst.connection.token,
        clientName: "gateway-client",
        mode: "ui",
        clientDisplayName: "Clawtrate probe accounts",
        clientVersion: "0.0.1",
        platform: process.platform,
        role: "operator",
        scopes,
        caps: ["tool-events"],
        minProtocol: 4,
        maxProtocol: 4,
        deviceIdentity,
        hostDeps: {
          signDevicePayload: (pem, payload) => crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(pem)).toString("base64url"),
          publicKeyRawBase64UrlFromPem: (pem) => crypto.createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
          loadDeviceAuthToken: ({ deviceId, role }) => tokens[`${deviceId}:${role}`],
          storeDeviceAuthToken: (rec) => (tokens[`${rec.deviceId}:${rec.role}`] = rec),
          clearDeviceAuthToken: ({ deviceId, role }) => delete tokens[`${deviceId}:${role}`],
        },
        onEvent: (e) => {
          const rec = { t: Date.now(), event: e.event, payload: e.payload };
          events.push(rec);
          for (const w of waiters) w(rec);
        },
        onHelloOk: (hello) => resolve({ client, hello }),
        onConnectError: (err) => {
          reject(err);
          client.stopAndWait().catch(() => {});
        },
      });
      client.start();
    });
  let connected;
  for (let attempt = 0; attempt < 5 && !connected; attempt += 1) {
    try {
      connected = await connectOnce();
    } catch (err) {
      const text = `${err?.message ?? err} ${JSON.stringify(err?.details ?? err?.data ?? {})}`;
      if (!/pair/i.test(text)) throw err;
      spawnSync("pnpm", ["dev-gateway", "approve", "--instance", inst.name], { cwd: checkout, stdio: "ignore" });
      await sleep(1000);
    }
  }
  if (!connected) throw new Error("pairing was not approved");
  const { client, hello } = connected;
  if (hello?.server?.version !== "2026.10.6") {
    await client.stopAndWait().catch(() => {});
    throw new Error(`gateway reports ${hello?.server?.version}, not 2026.10.6`);
  }
  const call = (method, params = {}, timeoutMs = 60_000) => client.request(method, params, { timeoutMs });
  const waitFor = (pred, timeoutMs = 120_000) =>
    new Promise((res, rej) => {
      const hit = events.find(pred);
      if (hit) return res(hit);
      const t = setTimeout(() => (waiters.delete(w), rej(new Error(`timed out after ${timeoutMs} ms`))), timeoutMs);
      const w = (rec) => {
        if (pred(rec)) {
          clearTimeout(t);
          waiters.delete(w);
          res(rec);
        }
      };
      waiters.add(w);
    });
  const patchConfig = async (patch) => {
    const { hash } = await call("config.get", {});
    return call("config.patch", { raw: JSON.stringify(patch), baseHash: hash });
  };
  return { client, hello, events, call, waitFor, patchConfig, stop: () => client.stopAndWait().catch(() => {}) };
}

/**
 * Sends one message and waits for the run's terminal `chat` event. Returns every
 * event the client received that carries the run id or the session key, from the
 * send until two seconds after the terminal event.
 */
export async function sendAndCapture(gw, sessionKey, message, timeoutMs = 180_000) {
  const startIndex = gw.events.length;
  const r = await gw.call("chat.send", { sessionKey, message, idempotencyKey: crypto.randomUUID() });
  const done = await gw.waitFor((e) => e.event === "chat" && e.payload?.runId === r.runId && ["final", "aborted", "error"].includes(e.payload?.state), timeoutMs);
  await sleep(2000);
  const related = gw.events.slice(startIndex).filter((e) => e.payload?.runId === r.runId || e.payload?.sessionKey === sessionKey);
  return { runId: r.runId, terminal: done.payload, events: related };
}

/** A compact, ordered view of a run's events: stream, phase and the fields that name a provider, model, account or failure. */
export function summarizeEvents(events) {
  return events.map(({ event, payload }) => {
    const data = payload?.data ?? {};
    const out = { event, stream: payload?.stream, state: payload?.state, phase: data.phase };
    for (const [k, v] of Object.entries({ ...payload, ...data })) {
      if (/provider|model|profile|account|auth|fallback|failover|error|retry|notice|receipt|reroute|reason|status|kind|text/i.test(k) && v !== undefined) out[k] = typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v;
    }
    delete out.message;
    return out;
  });
}
