// Probe helpers for the development gateway. Scratch-style research code.
// Run from a folder where @openclaw/gateway-client@2026.10.6 is installed.
//
//   OPENCLAW_DEV_RUN_DIR=<launcher RUN_DIR> \
//   OPENCLAW_DEV_STATE=<launcher state folder> node <scenario>.mjs
//
// connect() pairs a device identity on loopback (auto-approved there) with the
// scopes and caps asked for, records every event, and offers send() that waits
// for a run's terminal chat event.
//
// It refuses any target that is not the launcher's probe gateway:
//   - the endpoint is fixed to ws://127.0.0.1:19101 (an override must match);
//   - the token is read from the launcher's run folder, which must also hold
//     its gateway.pid and fake.pid;
//   - the state folder must carry the launcher's marker file;
//   - after connecting, the gateway must report version 2026.10.6 and every
//     model listed for every configured agent must be the scripted fake.
// A failed check closes the connection before the scenario can call anything.

import { GatewayClient } from "@openclaw/gateway-client";
import crypto from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const PROBE_URL = "ws://127.0.0.1:19101";
const EXPECTED_VERSION = "2026.10.6";
const FAKE_PROVIDER = "fake";
const fail = (why) => {
  throw new Error(`probe-lib refuses this target: ${why}`);
};
if (process.env.OPENCLAW_DEV_URL && process.env.OPENCLAW_DEV_URL !== PROBE_URL) fail(`only ${PROBE_URL} is allowed`);
const RUN_DIR = process.env.OPENCLAW_DEV_RUN_DIR;
const STATE = process.env.OPENCLAW_DEV_STATE;
if (!RUN_DIR || !STATE) fail("set OPENCLAW_DEV_RUN_DIR and OPENCLAW_DEV_STATE to the launcher's folders");
for (const f of ["token", "gateway.pid", "fake.pid"]) if (!existsSync(path.join(RUN_DIR, f))) fail(`launcher run folder has no ${f}`);
const marker = path.join(STATE, ".clawtrate-dev-gateway");
if (!existsSync(marker) || lstatSync(STATE).isSymbolicLink()) fail("state folder has no launcher marker");
const URL_ = PROBE_URL;
const TOKEN = readFileSync(path.join(RUN_DIR, "token"), "utf8").trim();

/** Closes the client and rejects unless the gateway is the scripted probe. */
async function verifyProbeTarget(client, hello) {
  const version = hello?.server?.version;
  if (version !== EXPECTED_VERSION) throw new Error(`gateway version ${version}, expected ${EXPECTED_VERSION}`);
  const { agents = [] } = await client.request("agents.list", {}, { timeoutMs: 30_000 });
  if (agents.length === 0) throw new Error("no agents listed");
  for (const agent of agents) {
    const { models = [] } = await client.request("models.list", { agentId: agent.id }, { timeoutMs: 30_000 });
    const foreign = models.filter((m) => m.provider !== FAKE_PROVIDER).map((m) => `${m.provider}/${m.id}`);
    if (models.length === 0 || foreign.length > 0) throw new Error(`agent ${agent.id} has non-fake models: ${foreign.join(", ") || "none listed"}`);
  }
}

const identities = new Map();
function identity(name) {
  if (identities.has(name)) return identities.get(name);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const id = {
    deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  identities.set(name, id);
  return id;
}

export function connect({ name = "probe", scopes = ["operator.read", "operator.write"], caps = ["tool-events"], backend = false } = {}) {
  const events = [];
  const tokens = {};
  const waiters = new Set();
  return new Promise((resolve, reject) => {
    const common = {
      url: URL_,
      token: TOKEN,
      clientVersion: "0.0.1",
      platform: process.platform,
      role: "operator",
      scopes,
      caps,
      minProtocol: 4,
      maxProtocol: 4,
      onEvent: (e) => {
        const rec = { t: Date.now(), event: e.event, payload: e.payload };
        events.push(rec);
        // Waiters get the same timestamped record as the buffered search.
        for (const w of waiters) w(rec);
      },
      onConnectError: reject,
    };
    const opts = backend
      ? { ...common, clientName: "gateway-client", mode: "backend" }
      : {
          ...common,
          clientName: "gateway-client",
          mode: "ui",
          clientDisplayName: `probe ${name}`,
          deviceIdentity: identity(name),
          hostDeps: {
            signDevicePayload: (pem, payload) => crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(pem)).toString("base64url"),
            publicKeyRawBase64UrlFromPem: (pem) => crypto.createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
            loadDeviceAuthToken: ({ deviceId, role }) => tokens[`${deviceId}:${role}`],
            storeDeviceAuthToken: (rec) => (tokens[`${rec.deviceId}:${rec.role}`] = rec),
            clearDeviceAuthToken: ({ deviceId, role }) => delete tokens[`${deviceId}:${role}`],
          },
        };
    const client = new GatewayClient({
      ...opts,
      onHelloOk: async (hello) => {
        if (!scopes.includes("operator.read") && !scopes.includes("operator.admin")) {
          await client.stopAndWait();
          return reject(new Error("probe-lib needs operator.read to verify the target"));
        }
        try {
          await verifyProbeTarget(client, hello);
        } catch (err) {
          await client.stopAndWait().catch(() => {});
          return reject(new Error(`probe-lib refuses this target: ${err.message}`));
        }
        const call = (method, params = {}, timeoutMs = 60_000) => client.request(method, params, { timeoutMs });
        const waitFor = (pred, timeoutMs = 60_000) =>
          new Promise((res, rej) => {
            const hit = events.find((e) => pred(e));
            if (hit) return res(hit);
            const t = setTimeout(() => (waiters.delete(w), rej(new Error(`waitFor timeout after ${timeoutMs} ms`))), timeoutMs);
            const w = (rec) => {
              if (pred(rec)) {
                clearTimeout(t);
                waiters.delete(w);
                res(rec);
              }
            };
            waiters.add(w);
          });
        const terminal = (runId, timeoutMs) =>
          waitFor((e) => e.event === "chat" && e.payload?.runId === runId && ["final", "aborted", "error"].includes(e.payload?.state), timeoutMs).then((e) => e.payload);
        const send = async (sessionKey, message, extra = {}, timeoutMs = 90_000) => {
          const r = await call("chat.send", { sessionKey, message, idempotencyKey: crypto.randomUUID(), ...extra });
          return { ...r, done: terminal(r.runId, timeoutMs) };
        };
        resolve({ client, hello, call, events, waitFor, terminal, send, close: () => client.stopAndWait() });
      },
    });
    client.start();
  });
}

/** Compact one event for logs: drop the large session row snapshots. */
export function brief(e, max = 400) {
  const p = e.payload && typeof e.payload === "object" ? { ...e.payload } : e.payload;
  if (p && typeof p === "object") {
    delete p.session;
    for (const k of ["createdActor", "owner", "participants", "expandedParticipants", "activitySummary"]) delete p[k];
  }
  return `${e.event} ${JSON.stringify(p).slice(0, max)}`;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs fn with agents.entries.<agentId>.tools.exec replaced by `execBlock`,
 * then restores the exact original block in finally and checks it, even when
 * the replacement write itself failed. The
 * restore clears the block first (null), then writes the original back, so no
 * key from `execBlock` survives a merge patch. Throws if the restored block
 * differs from the original. `adm` must hold operator.admin.
 */
export async function withAgentExecPolicy(adm, agentId, execBlock, fn) {
  const read = async () => {
    const c = await adm.call("config.get", {});
    return { hash: c.hash, exec: c.config?.agents?.entries?.[agentId]?.tools?.exec };
  };
  const patch = async (value) => {
    const { hash } = await read();
    await adm.call("config.patch", { raw: JSON.stringify({ agents: { entries: { [agentId]: { tools: { exec: value } } } } }), baseHash: hash });
  };
  // Reading the original changes nothing. Every write, including the first,
  // happens inside try, so a failed or ambiguous write is still followed by
  // the restore and its check (fail closed).
  const original = (await read()).exec;
  try {
    await patch(null);
    await patch(execBlock);
    return await fn();
  } finally {
    await patch(null);
    if (original !== undefined) await patch(original);
    const restored = (await read()).exec;
    if (JSON.stringify(restored) !== JSON.stringify(original)) {
      throw new Error(`exec policy of ${agentId} not restored: ${JSON.stringify(restored)} != ${JSON.stringify(original)}`);
    }
  }
}
