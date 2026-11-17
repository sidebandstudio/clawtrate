// Probe helpers for the development gateway. Scratch-style research code.
// Run from a folder where @openclaw/gateway-client@2026.10.6 is installed.
//
//   OPENCLAW_DEV_TOKEN=<token> node <scenario>.mjs
//
// connect() pairs a device identity on loopback (auto-approved there) with the
// scopes and caps asked for, records every event, and offers send() that waits
// for a run's terminal chat event.

import { GatewayClient } from "@openclaw/gateway-client";
import crypto from "node:crypto";

const URL_ = process.env.OPENCLAW_DEV_URL ?? "ws://127.0.0.1:19101";
const TOKEN = process.env.OPENCLAW_DEV_TOKEN;
if (!TOKEN) throw new Error("set OPENCLAW_DEV_TOKEN");

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
        events.push({ t: Date.now(), event: e.event, payload: e.payload });
        for (const w of waiters) w(e);
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
      onHelloOk: (hello) => {
        const call = (method, params = {}, timeoutMs = 60_000) => client.request(method, params, { timeoutMs });
        const waitFor = (pred, timeoutMs = 60_000) =>
          new Promise((res, rej) => {
            const hit = events.find((e) => pred(e));
            if (hit) return res(hit);
            const t = setTimeout(() => (waiters.delete(w), rej(new Error("waitFor timeout"))), timeoutMs);
            const w = (e) => {
              if (pred({ event: e.event, payload: e.payload })) {
                clearTimeout(t);
                waiters.delete(w);
                res({ event: e.event, payload: e.payload });
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
