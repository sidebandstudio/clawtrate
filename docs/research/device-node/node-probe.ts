// Probes behind docs/research/device-node.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name> --no-seed   (or --default-local-pairing for `local`)
//   node docs/research/device-node/node-probe.ts <experiment> --instance <name>
//
// It acts only on a named development instance this checkout started, reads
// that instance's address and token from verified run files, checks the IPv4
// listener with lsof before each connection, and runs
// `openclaw` only through the tool's guarded runner (so always with
// `--profile clawtrate-dev-<name>`). It never prints a token.
//
// The stand-in node. It connects with `role: "node"` as a macOS device and
// declares only the invented commands below. It answers each with fixed text
// or a fixed refusal, or not at all. It runs no program, reads no file, and
// asks the operating system for nothing: it is a socket that answers frames.
// The instance's bots cannot reach it: every bot's `nodes` tool is denied in
// the development config. Only this script's own operator connections call it.
//
// Experiments:
//   drop      the node declares the invented commands with no allowlist: what
//             the pending request lists, what is paired, what an invoke gets
//   tiers     with the commands allowlisted (config.patch from admin): who can
//             list, approve and reject the request: another device at pairing,
//             at pairing+write, the node's own device at pairing, then at
//             pairing+write, and admin
//   invoke    answers, a refusal, no answer, a late answer, a read-only caller,
//             an undeclared command, an offline node, the reported permissions
//   revoke    removing the allowlist entry and the pairing while a call waits,
//             and who may remove the node
//   same      one device as operator and node, in both orders
//   perm      a permission reported as granted later, and withdrawn
//   share     what the share sheet and the Shortcuts actions would call
//   events    which tiers hear about another device's node requests
//   roleCredential  the node role's own credential: a node-only setup code from
//             admin, used by a device paired as an operator; reuse; revocation
//   local     on an instance started with --default-local-pairing: is a node
//             with commands paired silently on loopback, and through a proxy
//             that adds X-Forwarded-For

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openInstance, recordedStartOptions } from "../../../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../../../tools/dev-gateway/src/env.ts";

import { probeEndpoint, probeTarget } from "./probe-endpoint.ts";

const requireFromTool = createRequire(new URL("../../../tools/dev-gateway/package.json", import.meta.url));
const { GatewayClient } = (await import(
  pathToFileURL(requireFromTool.resolve("@openclaw/gateway-client")).href
)) as typeof import("@openclaw/gateway-client");

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { instance: { type: "string" } },
  allowPositionals: true,
});
const experiment = positionals[0];
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
const connection = probeEndpoint(inst);
const { url } = connection;
const gatewayPort = Number(new URL(url).port);

/** The only commands the stand-in node ever declares. None is a command the gateway or a bot knows. */
const PROBE_COMMANDS = [
  "clawtrate.probe.echo",
  "clawtrate.probe.refuse",
  "clawtrate.probe.silent",
  "clawtrate.probe.late",
  "clawtrate.probe.slow",
];
const ECHO_TEXT = "Fixed answer from the stand-in node.";
const REFUSAL = { code: "NOT_ALLOWED_ON_DEVICE", message: "The person has not allowed this on the stand-in node." };

const secrets: string[] = [connection.token];
const redact = (text: string) => {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  return out.replace(/("(?:token|deviceToken|bootstrapToken)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const say = (...parts: unknown[]) =>
  console.log(redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (id: unknown) => (typeof id === "string" ? id.slice(0, 12) : id);

type Identity = { deviceId: string; publicKeyPem: string; privateKeyPem: string };
function identity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    deviceId: createHash("sha256").update(raw).digest("hex"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function runOpenclaw(args: string[]) {
  connection.recheck();
  const result = inst.runner.runSync(args);
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

type Frame = { event: string; payload: unknown };
type Conn = {
  label: string;
  id: Identity;
  client: InstanceType<typeof GatewayClient>;
  events: Frame[];
  hello: { role?: string; scopes?: string[] } | null;
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  close: () => Promise<void>;
};

type ConnectOptions = {
  label: string;
  id: Identity;
  role: "operator" | "node";
  scopes?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  proxy?: Server;
  /** Send the shared token. Off: the device token alone, as Clawtrate connects once paired. */
  shared?: boolean;
  /** A setup code's bootstrap token, sent in place of the shared token. */
  bootstrap?: string;
  onEvent?: (conn: Conn, frame: Frame) => void;
};

/**
 * One connection attempt. Resolves with the connection on hello, or with the
 * refusal's code, message and request id. Tokens are kept in memory per
 * device and role, so a second attempt with the same identity reuses them.
 */
const tokenStore = new Map<string, { token: string; scopes: string[] }>();
function connectOnce(options: ConnectOptions): Promise<{ conn: Conn } | { refused: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let settled = false;
    const events: Frame[] = [];
    let conn: Conn | null = null;
    const finish = (value: { conn: Conn } | { refused: Record<string, unknown> }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const target = probeTarget(connection, options.proxy);
    const node = options.role === "node";
    const client = new GatewayClient({
      url: target.url,
      ...(options.bootstrap ? { bootstrapToken: options.bootstrap } : options.shared === false ? {} : { token: connection.token }),
      clientName: node ? "node-host" : "gateway-client",
      mode: node ? "node" : "ui",
      clientDisplayName: `Clawtrate research ${options.label}`,
      clientVersion: "0.0.0-research",
      platform: node ? "macos" : process.platform,
      ...(node ? { deviceFamily: "Mac", commands: options.commands ?? [], permissions: options.permissions ?? {} } : {}),
      role: options.role,
      scopes: options.scopes ?? [],
      caps: node ? [] : ["tool-events"],
      minProtocol: 4,
      maxProtocol: 4,
      deviceIdentity: options.id,
      hostDeps: {
        beforeConnect: target.beforeConnect,
        signDevicePayload: (pem: string, payload: string) =>
          sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
        publicKeyRawBase64UrlFromPem: (pem: string) =>
          createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
        loadDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) =>
          tokenStore.get(`${deviceId}:${role}`) ?? null,
        storeDeviceAuthToken: (rec: { deviceId: string; role: string; token: string; scopes: string[] }) => {
          secrets.push(rec.token);
          tokenStore.set(`${rec.deviceId}:${rec.role}`, { token: rec.token, scopes: rec.scopes });
        },
        clearDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) =>
          tokenStore.delete(`${deviceId}:${role}`),
      },
      onEvent: (frame: { event: string; payload?: unknown }) => {
        const f = { event: frame.event, payload: frame.payload };
        events.push(f);
        if (conn && options.onEvent) options.onEvent(conn, f);
      },
      onConnectError: (error: Error & { details?: Record<string, unknown>; code?: string }) => {
        // One attempt only: a refused client must not keep retrying in the background.
        finish({ refused: { message: error.message, code: error.code, details: error.details } });
        void client.stopAndWait().catch(() => {});
      },
      onReconnectPaused: () => {
        void client.stopAndWait().catch(() => {});
        finish({ refused: { message: "reconnect paused" } });
      },
      onHelloOk: (hello: { auth?: { role?: string; scopes?: string[]; deviceToken?: string } }) => {
        if (hello.auth?.deviceToken) secrets.push(hello.auth.deviceToken);
        conn = {
          label: options.label,
          id: options.id,
          client,
          events,
          hello: { role: hello.auth?.role, scopes: hello.auth?.scopes },
          request: (method, params, timeoutMs) =>
            client.request(method, params ?? {}, timeoutMs ? { timeoutMs } : undefined) as Promise<unknown>,
          close: () => client.stopAndWait().catch(() => {}),
        };
        finish({ conn });
      },
    } as never);
    client.start();
    const timer = setTimeout(() => {
      void client.stopAndWait().catch(() => {});
      finish({ refused: { message: "no answer in 15 s" } });
    }, 15_000);
  });
}

/**
 * Device pairing for an operator: approve exactly this device's request on the
 * gateway's computer, then connect again with the device token alone, which is
 * how Clawtrate connects once paired (the gateway treats a shared-token caller
 * as no particular device).
 */
async function operator(label: string, scopes: string[], id: Identity = identity()): Promise<Conn> {
  const full = scopes.map((s) => `operator.${s}`);
  if (tokenStore.has(`${id.deviceId}:operator`)) {
    const paired = await connectOnce({ label, id, role: "operator", scopes: full, shared: false });
    if ("conn" in paired) return paired.conn;
  }
  let first = await connectOnce({ label, id, role: "operator", scopes: full });
  if ("conn" in first) {
    await first.conn.close();
    first = await connectOnce({ label, id, role: "operator", scopes: full, shared: false });
    if ("conn" in first) return first.conn;
    throw new Error(`${label}: ${JSON.stringify(first.refused)}`);
  }
  const requestId = (first.refused.details as Record<string, unknown> | undefined)?.requestId;
  if (typeof requestId !== "string") throw new Error(`${label}: ${JSON.stringify(first.refused)}`);
  const approved = runOpenclaw(["devices", "approve", requestId]);
  if (approved.status !== 0) throw new Error(`${label}: devices approve exit ${approved.status}`);
  first = await connectOnce({ label, id, role: "operator", scopes: full });
  if ("conn" in first) await first.conn.close();
  first = await connectOnce({ label, id, role: "operator", scopes: full, shared: false });
  if (!("conn" in first)) throw new Error(`${label}: ${JSON.stringify(first.refused)}`);
  return first.conn;
}

/** The stand-in node's whole behaviour: fixed answers to invented commands, nothing else. */
function answer(conn: Conn, frame: Frame) {
  if (frame.event !== "node.invoke.request") return;
  const req = frame.payload as { id: string; nodeId: string; command: string; paramsJSON?: string; timeoutMs?: number };
  say(`  [node ${conn.label}] got node.invoke.request`, {
    id: short(req.id),
    command: req.command,
    paramsJSON: req.paramsJSON,
    timeoutMs: req.timeoutMs,
  });
  const reply = (body: Record<string, unknown>) =>
    conn
      .request("node.invoke.result", { id: req.id, nodeId: req.nodeId, ...body })
      .then((r) => say(`  [node ${conn.label}] node.invoke.result for ${req.command} answered:`, r))
      .catch((e: unknown) => say(`  [node ${conn.label}] node.invoke.result refused:`, String(e)));
  if (req.command === "clawtrate.probe.echo") void reply({ ok: true, payload: { text: ECHO_TEXT } });
  else if (req.command === "clawtrate.probe.refuse") void reply({ ok: false, error: REFUSAL });
  else if (req.command === "clawtrate.probe.slow")
    setTimeout(() => void reply({ ok: true, payload: { text: "Slow answer, inside the time limit." } }), 3000);
  else if (req.command === "clawtrate.probe.late")
    setTimeout(() => void reply({ ok: true, payload: { text: "Late answer." } }), (req.timeoutMs ?? 2000) + 1500);
  // clawtrate.probe.silent: no answer at all. Anything else: never declared, never answered.
}

async function node(label: string, id: Identity, extra: Partial<ConnectOptions> = {}) {
  return connectOnce({ label, id, role: "node", commands: PROBE_COMMANDS, onEvent: answer, ...extra });
}

async function tryCall(conn: Conn, method: string, params: unknown, timeoutMs?: number) {
  const started = Date.now();
  try {
    const result = await conn.request(method, params, timeoutMs);
    return { ok: true, ms: Date.now() - started, result };
  } catch (error) {
    const e = error as Error & { code?: string; details?: unknown; gatewayCode?: string };
    return { ok: false, ms: Date.now() - started, error: e.message, code: e.code ?? e.gatewayCode, details: e.details };
  }
}

function pendingSummary(list: unknown) {
  const l = list as { pending?: Record<string, unknown>[]; paired?: Record<string, unknown>[] };
  return {
    pending: (l.pending ?? []).map((p) => ({
      requestId: short(p.requestId),
      nodeId: short(p.nodeId),
      displayName: p.displayName,
      platform: p.platform,
      deviceFamily: p.deviceFamily,
      commands: p.commands,
      permissions: p.permissions,
      requiredApproveScopes: p.requiredApproveScopes,
      remoteIp: p.remoteIp,
      silent: p.silent,
      keys: Object.keys(p),
    })),
    paired: (l.paired ?? []).map((p) => ({ nodeId: short(p.nodeId), displayName: p.displayName, commands: p.commands })),
  };
}

async function configAllow(admin: Conn, allow: string[] | null) {
  const got = (await admin.request("config.get", {})) as { hash?: string };
  const patch = { gateway: { nodes: { commands: { allow } } } };
  // Removing entries from an array needs replacePaths, the gateway's guard against an accidental removal.
  return tryCall(admin, "config.patch", {
    raw: JSON.stringify(patch),
    baseHash: got.hash,
    replacePaths: ["gateway.nodes.commands.allow"],
  });
}

async function waitForPending(admin: Conn, nodeId: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const list = (await admin.request("node.pair.list", {})) as { pending?: { nodeId: string; requestId: string }[] };
    const hit = (list.pending ?? []).find((p) => p.nodeId === nodeId);
    if (hit) return hit.requestId;
    await sleep(300);
  }
  return null;
}

function devicePending(list: unknown) {
  const l = list as { pending?: Record<string, unknown>[] };
  return (l.pending ?? []).map((p) => ({
    requestId: short(p.requestId),
    deviceId: short(p.deviceId),
    displayName: p.displayName,
    role: p.role,
    roles: p.roles,
    scopes: p.scopes,
    platform: p.platform,
    clientId: p.clientId,
    remoteIp: p.remoteIp,
    silent: p.silent,
    keys: Object.keys(p),
  }));
}

const requestIdOf = (r: { refused: Record<string, unknown> }) =>
  (r.refused.details as Record<string, unknown> | undefined)?.requestId as string | undefined;

async function drop() {
  const admin = await operator("admin", ["admin", "pairing", "read", "write"]);
  say("admin hello:", admin.hello);
  const id = identity();
  say("node declares", PROBE_COMMANDS, "with no allowlist entry");
  const first = await node("N-drop", id);
  say("node connect:", "conn" in first ? { hello: first.conn.hello } : first.refused);
  if ("conn" in first) await first.conn.close();
  say("admin device.pair.list pending:", devicePending(await admin.request("device.pair.list", {})));
  say("admin node.pair.list:", pendingSummary(await admin.request("node.pair.list", {})));
  const deviceRequest = "refused" in first ? requestIdOf(first) : undefined;
  if (deviceRequest) say("admin device.pair.approve:", await tryCall(admin, "device.pair.approve", { requestId: deviceRequest }).then((r) => ({ ok: r.ok, error: r.error })));
  const again = await node("N-drop", id);
  say("node connect after the device approval:", "conn" in again ? { hello: again.conn.hello } : again.refused);
  await sleep(500);
  say("admin node.pair.list:", pendingSummary(await admin.request("node.pair.list", {})));
  const surface = await waitForPending(admin, id.deviceId, 2000);
  if (surface) say("admin node.pair.approve:", await tryCall(admin, "node.pair.approve", { requestId: surface }).then((r) => ({ ok: r.ok, error: r.error })));
  say("node.describe:", await tryCall(admin, "node.describe", { nodeId: id.deviceId }));
  say("invoke clawtrate.probe.echo:", await tryCall(admin, "node.invoke", call(id.deviceId, "clawtrate.probe.echo")));
  if ("conn" in again) await again.conn.close();
  await admin.close();
}

async function tiers() {
  const admin = await operator("admin", ["admin", "pairing", "read", "write"]);
  say("allowlist the invented commands:", await configAllow(admin, PROBE_COMMANDS).then((r) => ({ ok: r.ok, error: r.error })));
  await sleep(1500);
  const cfg = (await admin.request("config.get", {})) as { config?: { gateway?: { nodes?: unknown } } };
  say("config.get gateway.nodes (admin):", cfg.config?.gateway?.nodes);
  const reader = await operator("reader", ["read"]);
  const readCfg = await tryCall(reader, "config.get", {});
  say("config.get at read:", readCfg.ok ? { nodes: (readCfg.result as { config?: { gateway?: { nodes?: unknown } } }).config?.gateway?.nodes } : readCfg);
  const watcher = await operator("watcher-pairing", ["pairing"]);
  const otherP = await operator("other-pairing", ["pairing"]);
  const otherPW = await operator("other-pairing-write", ["pairing", "write"]);

  // Stage 1: the device pairing a node's first connect asks for (role node).
  const ids = [identity(), identity(), identity()];
  const deviceReq: string[] = [];
  for (const [i, id] of ids.entries()) {
    const r = await node(`N${i}`, id);
    say(`N${i} first connect:`, "conn" in r ? { hello: r.conn.hello } : { code: (r.refused.details as Record<string, unknown>)?.code });
    deviceReq.push("refused" in r ? (requestIdOf(r) ?? "") : "");
  }
  say("another device at pairing, device.pair.list:", devicePending(await otherP.request("device.pair.list", {})).map((p) => p.deviceId));
  say("another device at pairing, device.pair.approve N0:", await tryCall(otherP, "device.pair.approve", { requestId: deviceReq[0] }));
  // N1's own device, already paired as an operator with pairing and write.
  const selfOp = await operator("N1-as-operator", ["pairing", "write"], ids[1]);
  say("N1's device as an operator, hello:", selfOp.hello);
  const n1again = await node("N1", ids[1]);
  const selfReq = "refused" in n1again ? requestIdOf(n1again) : undefined;
  say("N1 connects as a node on the same device:", "conn" in n1again ? { hello: n1again.conn.hello } : { code: (n1again.refused.details as Record<string, unknown>)?.code, same: selfReq === deviceReq[1] });
  say("N1's own device approves its node-role request:", await tryCall(selfOp, "device.pair.approve", { requestId: selfReq ?? deviceReq[1] }));
  for (const [i, rid] of deviceReq.entries()) {
    const use = i === 1 && selfReq ? selfReq : rid;
    say(`admin device.pair.approve N${i}:`, await tryCall(admin, "device.pair.approve", { requestId: use }).then((r) => ({ ok: r.ok, error: r.error })));
  }

  // Stage 2: the node's command surface.
  const nodes: Conn[] = [];
  const surface: string[] = [];
  for (const [i, id] of ids.entries()) {
    const r = await node(`N${i}`, id);
    say(`N${i} connects after the device approval:`, "conn" in r ? { hello: r.conn.hello } : r.refused);
    if ("conn" in r) nodes.push(r.conn);
    surface.push((await waitForPending(admin, id.deviceId)) ?? "");
  }
  say("admin node.pair.list:", pendingSummary(await admin.request("node.pair.list", {})));
  say("another device at pairing, node.pair.list:", pendingSummary(await otherP.request("node.pair.list", {})));
  say("another device at pairing, approve N0:", await tryCall(otherP, "node.pair.approve", { requestId: surface[0] }));
  say("another device at pairing+write, approve N0:", await tryCall(otherPW, "node.pair.approve", { requestId: surface[0] }));
  say("another device at pairing+write, reject N0:", await tryCall(otherPW, "node.pair.reject", { requestId: surface[0] }));
  await selfOp.close();
  const selfP = await operator("N1-as-operator", ["pairing"], ids[1]);
  say("N1's own device at pairing only, hello:", selfP.hello);
  say("N1's own device at pairing, node.pair.list:", pendingSummary(await selfP.request("node.pair.list", {})));
  say("N1's own device at pairing, approve N1:", await tryCall(selfP, "node.pair.approve", { requestId: surface[1] }));
  await selfP.close();
  const selfPW = await operator("N1-as-operator", ["pairing", "write"], ids[1]);
  say("N1's own device at pairing+write, hello:", selfPW.hello);
  say("N1's own device at pairing+write, approve N2:", await tryCall(selfPW, "node.pair.approve", { requestId: surface[2] }));
  say("N1's own device at pairing+write, approve N1:", await tryCall(selfPW, "node.pair.approve", { requestId: surface[1] }).then((r) => ({ ok: r.ok, error: r.error })));
  say("admin approve N0:", await tryCall(admin, "node.pair.approve", { requestId: surface[0] }).then((r) => ({ ok: r.ok, error: r.error })));
  say("admin reject N2:", await tryCall(admin, "node.pair.reject", { requestId: surface[2] }).then((r) => ({ ok: r.ok, error: r.error })));
  await sleep(800);
  for (const w of [watcher, otherP, admin]) {
    say(
      `${w.label} saw:`,
      w.events.filter((e) => e.event.startsWith("node.pair") || e.event.startsWith("device.pair")).map((e) => {
        const p = e.payload as Record<string, unknown>;
        return { event: e.event, requestId: short(p.requestId), nodeId: short(p.nodeId ?? p.deviceId), decision: p.decision, keys: Object.keys(p) };
      }),
    );
  }
  say("paired now:", pendingSummary(await admin.request("node.pair.list", {})).paired);
  for (const c of [...nodes, watcher, otherP, otherPW, selfPW, reader, admin]) await c.close();
}

/** One device, both roles: which request is filed, what it asks for, and who may approve it. */
async function same() {
  const admin = await operator("admin", ["admin", "pairing", "read", "write"]);
  // (a) The operator is paired first, read only, then the same device connects as a node.
  const a = identity();
  const opA = await operator("A-operator", ["read"], a);
  say("(a) operator hello:", opA.hello);
  const nodeA = await node("A-node", a);
  say("(a) the same device connects as a node:", "conn" in nodeA ? { hello: nodeA.conn.hello } : { code: (nodeA.refused.details as Record<string, unknown>)?.code });
  say("(a) pending device requests:", devicePending(await admin.request("device.pair.list", {})).filter((p) => p.deviceId === short(a.deviceId)));
  await opA.close();
  // The same device's operator asks for more (Clawtrate's own upgrade path is a reconnect or requestUpgrade; here a reconnect).
  const up = await connectOnce({ label: "A-operator", id: a, role: "operator", scopes: ["operator.read", "operator.pairing", "operator.write"], shared: false });
  say("(a) the operator reconnects asking pairing+write:", "conn" in up ? { hello: up.conn.hello } : { code: (up.refused.details as Record<string, unknown>)?.code, message: up.refused.message });
  if ("conn" in up) {
    say("(a) requestUpgrade:", await tryCall(up.conn, "device.scopes.requestUpgrade", { scopes: ["operator.pairing", "operator.write"] }));
  }
  say("(a) pending device requests now:", devicePending(await admin.request("device.pair.list", {})).filter((p) => p.deviceId === short(a.deviceId)));
  const listed = (await admin.request("device.pair.list", {})) as { pending?: { requestId: string; deviceId: string }[] };
  const current = (listed.pending ?? []).find((p) => p.deviceId === a.deviceId)?.requestId;
  if ("conn" in up && current) say("(a) the device's own read connection approves it:", await tryCall(up.conn, "device.pair.approve", { requestId: current }));
  if (current) say("(a) admin approves it:", await tryCall(admin, "device.pair.approve", { requestId: current }).then((r) => ({ ok: r.ok, error: r.error })));
  say("(a) the device now:", devicesList().filter((d) => d.deviceId === short(a.deviceId)));
  if ("conn" in up) await up.conn.close();
  const opA2 = admin;
  // (b) The node asks first, then the same device asks to be an operator.
  const b = identity();
  const nodeB = await node("B-node", b);
  say("(b) node first:", "conn" in nodeB ? { hello: nodeB.conn.hello } : { code: (nodeB.refused.details as Record<string, unknown>)?.code });
  const opFirst = await connectOnce({ label: "B-operator", id: b, role: "operator", scopes: ["operator.read"] });
  say("(b) then the same device as an operator:", "conn" in opFirst ? { hello: opFirst.conn.hello } : { code: (opFirst.refused.details as Record<string, unknown>)?.code });
  say("(b) pending device requests:", devicePending(await admin.request("device.pair.list", {})).filter((p) => p.deviceId === short(b.deviceId)));
  void opA2;
  // (c) The operator holds pairing and write first; then the same device asks for the node role.
  const c = identity();
  const opC = await operator("C-operator", ["pairing", "write"], c);
  say("(c) operator hello:", opC.hello);
  const nodeC = await node("C-node", c);
  say("(c) the same device connects as a node:", "conn" in nodeC ? { hello: nodeC.conn.hello } : { code: (nodeC.refused.details as Record<string, unknown>)?.code });
  const own = (await opC.request("device.pair.list", {})) as { pending?: { requestId: string; deviceId: string; roles?: string[] }[] };
  say("(c) its own operator lists:", (own.pending ?? []).map((p) => ({ deviceId: short(p.deviceId), roles: p.roles })));
  const rid = (own.pending ?? []).find((p) => p.deviceId === c.deviceId)?.requestId;
  if (rid) say("(c) its own operator approves its node-role request:", await tryCall(opC, "device.pair.approve", { requestId: rid }));
  if (rid) say("(c) its own operator rejects it:", await tryCall(opC, "device.pair.reject", { requestId: rid }));
  await opC.close();
  await admin.close();
}

/** Both stages, approved by admin: the device pairing (role node), then the command surface. The node keeps its connection. */
async function pairedNode(admin: Conn, label: string, extra: Partial<ConnectOptions> = {}) {
  const id = identity();
  const first = await node(label, id, extra);
  if ("conn" in first) throw new Error(`${label}: paired without approval`);
  const deviceRequest = requestIdOf(first);
  const d = await tryCall(admin, "device.pair.approve", { requestId: deviceRequest });
  if (!d.ok) throw new Error(`${label}: device approve ${JSON.stringify(d)}`);
  const second = await node(label, id, extra);
  if (!("conn" in second)) throw new Error(`${label}: ${JSON.stringify(second.refused)}`);
  const surface = await waitForPending(admin, id.deviceId);
  if (!surface) throw new Error(`${label}: no surface request`);
  const n = await tryCall(admin, "node.pair.approve", { requestId: surface });
  if (!n.ok) throw new Error(`${label}: node approve ${JSON.stringify(n)}`);
  await sleep(500);
  return { id, conn: second.conn };
}

const call = (nodeId: string, command: string, timeoutMs = 3000) => ({
  nodeId,
  command,
  params: { note: "fixed probe parameters" },
  timeoutMs,
  idempotencyKey: crypto.randomUUID(),
});

async function invoke() {
  const admin = await operator("admin", ["admin", "pairing", "read", "write"]);
  say("allowlist:", (await configAllow(admin, PROBE_COMMANDS)).ok);
  await sleep(1500);
  const { id, conn } = await pairedNode(admin, "N-invoke", { permissions: { "clawtrate.probe": false } });
  say("node.describe:", await tryCall(admin, "node.describe", { nodeId: id.deviceId }));
  const writer = await operator("writer", ["read", "write"]);
  const reader = await operator("reader", ["read"]);
  say("reader node.list:", await tryCall(reader, "node.list", {}));
  say("writer echo:", await tryCall(writer, "node.invoke", call(id.deviceId, "clawtrate.probe.echo")));
  say("writer refuse:", await tryCall(writer, "node.invoke", call(id.deviceId, "clawtrate.probe.refuse")));
  say("writer silent, 2000 ms:", await tryCall(writer, "node.invoke", call(id.deviceId, "clawtrate.probe.silent", 2000)));
  say("writer late, 2000 ms:", await tryCall(writer, "node.invoke", call(id.deviceId, "clawtrate.probe.late", 2000)));
  await sleep(2500);
  say("writer silent, no timeoutMs:", await tryCall(writer, "node.invoke", { ...call(id.deviceId, "clawtrate.probe.silent"), timeoutMs: undefined }, 40_000));
  say("reader echo:", await tryCall(reader, "node.invoke", call(id.deviceId, "clawtrate.probe.echo")));
  say("writer undeclared clawtrate.probe.other:", await tryCall(writer, "node.invoke", call(id.deviceId, "clawtrate.probe.other")));
  await conn.close();
  await sleep(1000);
  say("node.describe after it left:", await tryCall(admin, "node.describe", { nodeId: id.deviceId }).then((r) => {
    const d = r.result as Record<string, unknown> | undefined;
    return d ? { connected: d.connected, lastSeenReason: d.lastSeenReason, approvalState: d.approvalState } : r;
  }));
  say("writer echo, node offline:", await tryCall(writer, "node.invoke", call(id.deviceId, "clawtrate.probe.echo", 5000)));
  for (const c of [writer, reader, admin]) await c.close();
}

async function revoke() {
  const admin = await operator("admin", ["admin", "pairing", "read", "write"]);
  say("allowlist:", (await configAllow(admin, PROBE_COMMANDS)).ok);
  await sleep(1500);
  const writer = await operator("writer", ["read", "write"]);

  // 1. The allowlist entry is taken away while a late call waits.
  const a = await pairedNode(admin, "N-allow");
  const pending = tryCall(writer, "node.invoke", call(a.id.deviceId, "clawtrate.probe.slow", 8000));
  await sleep(800);
  say("allowlist emptied while the call waits:", await configAllow(admin, []).then((r) => ({ ok: r.ok, error: r.error })));
  say("the waiting call ended:", await pending);
  await sleep(1500);
  say("a new call after:", await tryCall(writer, "node.invoke", call(a.id.deviceId, "clawtrate.probe.echo")));
  say("node.describe commands after:", await tryCall(admin, "node.describe", { nodeId: a.id.deviceId }).then((r) => (r.result as { commands?: unknown })?.commands ?? r));
  await a.conn.close();
  say("allowlist again:", (await configAllow(admin, PROBE_COMMANDS)).ok);
  await sleep(1500);

  // 2. The pairing is removed while a late call waits.
  const b = await pairedNode(admin, "N-remove");
  const self = await operator("self-pairing-write", ["pairing", "write"], b.id);
  say("the node's own device removes it:", await tryCall(self, "node.pair.remove", { nodeId: b.id.deviceId }));
  const other = await operator("other-pairing", ["pairing"]);
  say("another device at pairing removes it:", await tryCall(other, "node.pair.remove", { nodeId: b.id.deviceId }));
  const waiting = tryCall(writer, "node.invoke", call(b.id.deviceId, "clawtrate.probe.slow", 8000));
  await sleep(1000);
  say("admin removes it while the call waits:", await tryCall(admin, "node.pair.remove", { nodeId: b.id.deviceId }));
  say("the waiting call ended:", await waiting);
  say("node.list after:", await tryCall(admin, "node.list", {}).then((r) => (r.result as { nodes?: unknown[] })?.nodes?.length ?? r));
  say("the node connects again:", await node("N-remove", b.id).then((r) => ("conn" in r ? { hello: r.conn.hello } : r.refused)));
  for (const c of [self, other, writer, admin]) await c.close();
  await b.conn.close();
}

/** A node that reports a permission as newly granted: does the gateway ask again, and what runs meanwhile? */
async function perm() {
  const admin = await operator("admin", ["admin", "pairing", "read", "write"]);
  say("allowlist:", (await configAllow(admin, PROBE_COMMANDS)).ok);
  await sleep(1500);
  const p = await pairedNode(admin, "N-perm", { permissions: { "clawtrate.probe": false } });
  const writer = await operator("writer", ["read", "write"]);
  await p.conn.close();
  await sleep(500);
  const again = await node("N-perm", p.id, { permissions: { "clawtrate.probe": true }, shared: false });
  say("reconnect reporting the permission granted:", "conn" in again ? { hello: again.conn.hello } : again.refused);
  await sleep(500);
  say("node.pair.list:", pendingSummary(await admin.request("node.pair.list", {})).pending.filter((x) => x.nodeId === short(p.id.deviceId)));
  say("node.describe permissions:", await tryCall(admin, "node.describe", { nodeId: p.id.deviceId }).then((r) => (r.result as Record<string, unknown>)?.permissions));
  say("a call meanwhile:", await tryCall(writer, "node.invoke", call(p.id.deviceId, "clawtrate.probe.echo")).then((r) => ({ ok: r.ok, error: r.error })));
  const rid = await waitForPending(admin, p.id.deviceId, 2000);
  if (rid) say("admin approves the new surface:", (await tryCall(admin, "node.pair.approve", { requestId: rid })).ok);
  await sleep(500);
  say("node.describe permissions after:", await tryCall(admin, "node.describe", { nodeId: p.id.deviceId }).then((r) => (r.result as Record<string, unknown>)?.permissions));
  const back = await node("N-perm", p.id, { permissions: { "clawtrate.probe": false }, shared: false });
  if ("conn" in again) await again.conn.close();
  say("reconnect reporting it withdrawn:", "conn" in back ? { hello: back.conn.hello } : back.refused);
  await sleep(500);
  say("node.pair.list:", pendingSummary(await admin.request("node.pair.list", {})).pending.filter((x) => x.nodeId === short(p.id.deviceId)));
  if ("conn" in back) await back.conn.close();
  for (const c of [writer, admin]) await c.close();
}

/** What the share sheet and the two Shortcuts actions would call, at each tier. */
async function share() {
  const reader = await operator("reader", ["read"]);
  const writer = await operator("writer", ["read", "write"]);
  const listed = await tryCall(reader, "agents.list", {});
  const agents = listed.result as { defaultId?: string; agents?: { id: string; name?: string }[] } | undefined;
  say("agents.list at read:", listed.ok ? { defaultId: agents?.defaultId, agents: agents?.agents?.map((a) => a.id) } : listed);
  const prefs = await tryCall(reader, "users.prefs.get", {});
  say("users.prefs.get at read:", prefs.ok ? { keys: Object.keys((prefs.result as { entries?: Record<string, unknown> })?.entries ?? {}) } : prefs);
  const create = (c: Conn) =>
    tryCall(c, "sessions.create", {
      agentId: agents?.defaultId,
      message: "Shared from the probe: a fixed line of text.",
      idempotencyKey: crypto.randomUUID(),
    });
  say("sessions.create with a message at read:", await create(reader).then((r) => ({ ok: r.ok, error: r.error })));
  const made = await create(writer);
  const result = made.result as Record<string, unknown> | undefined;
  say("sessions.create with a message at write:", made.ok ? { ok: true, keys: Object.keys(result ?? {}), key: result?.key, runId: Boolean(result?.runId) } : made);
  // A shared item: a small text file with fixed content, as the composer sends files.
  // Another bot than the one above, so this run is not queued behind the first.
  const withFile = await tryCall(writer, "sessions.create", {
    agentId: agents?.agents?.find((a) => a.id !== agents?.defaultId)?.id ?? agents?.defaultId,
    message: "Shared from the probe, with a file.",
    idempotencyKey: crypto.randomUUID(),
    attachments: [
      { type: "file", mimeType: "text/plain", fileName: "shared-note.txt", content: Buffer.from("A fixed line of shared text.\n").toString("base64") },
      // A 1x1 picture, drawn here; a picture is kept in the transcript as an image block.
      { type: "image", mimeType: "image/png", fileName: "shared-dot.png", content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==" },
    ],
  });
  const fileResult = withFile.result as Record<string, unknown> | undefined;
  say("sessions.create with a message and a file at write:", withFile.ok ? { ok: true, key: fileResult?.key, runId: Boolean(fileResult?.runId) } : withFile);
  if (withFile.ok && typeof fileResult?.key === "string") {
    // The run may still hold the message as a pending input, or have taken it into the transcript.
    const strip = (m: Record<string, unknown>) => {
      const { __openclaw: _meta, ...rest } = m; // the sender's identity is not printed
      return JSON.stringify(rest).replace(/"(data|content)":"[A-Za-z0-9+/=]{40,}"/g, '"$1":"<base64>"').slice(0, 700);
    };
    let seen: string[] = [];
    for (let i = 0; i < 40 && !seen.some((line) => line.startsWith("transcript")); i += 1) {
      await sleep(500);
      const history = await tryCall(reader, "chat.history", { sessionKey: fileResult.key, limit: 10 });
      const r = (history.result ?? {}) as { messages?: Record<string, unknown>[]; pendingInputs?: { items?: { message?: Record<string, unknown> }[] } };
      seen = [
        ...(r.messages ?? []).filter((m) => m.role === "user").map((m) => `transcript: ${strip(m)}`),
        ...(r.pendingInputs?.items ?? []).map((item) => `pending input: ${strip(item.message ?? {})}`),
      ];
    }
    say("the shared task's first message, as the gateway holds it:", seen);
  }
  // A share whose reply was lost is sent again with the same key and arguments: does the gateway make a second task?
  const retryKey = crypto.randomUUID();
  const retryArgs = { agentId: agents?.agents?.at(-1)?.id ?? agents?.defaultId, message: "Shared once, sent twice.", idempotencyKey: retryKey };
  const firstSend = await tryCall(writer, "sessions.create", retryArgs);
  const secondSend = await tryCall(writer, "sessions.create", retryArgs);
  const changed = await tryCall(writer, "sessions.create", { ...retryArgs, message: "Shared once, changed before the retry." });
  const keyOf = (r: { ok: boolean; result?: unknown; error?: string }) => (r.ok ? String((r.result as Record<string, unknown>)?.key).replace(/[0-9a-f-]{36}/, "<uuid>") : r.error);
  say("sessions.create twice with one key and the same arguments:", {
    first: keyOf(firstSend),
    second: keyOf(secondSend),
    sameTask: firstSend.ok && secondSend.ok && (firstSend.result as Record<string, unknown>).key === (secondSend.result as Record<string, unknown>).key,
    secondKeys: secondSend.ok ? Object.keys(secondSend.result as object) : null,
  });
  say("the same key with different arguments:", { ok: changed.ok, error: changed.error, code: changed.code });
  // Another person's device, paired at write, makes a task: what does this device's read say about it?
  const other = await operator("another-person", ["read", "write"]);
  const theirs = await tryCall(other, "sessions.create", { agentId: agents?.defaultId, message: "A task of another device.", idempotencyKey: crypto.randomUUID() });
  const theirKey = theirs.ok ? String((theirs.result as Record<string, unknown>).key) : "";
  const seenByReader = ((await tryCall(reader, "sessions.list", {})).result as { sessions?: Record<string, unknown>[] })?.sessions ?? [];
  const row = seenByReader.find((r) => r.key === theirKey);
  say("another device's task, as this device's read lists it:", row ? { kind: row.kind, chatType: row.chatType, listed: true } : { listed: false });
  await other.close();
  // What the gateway says about a task's kind. It classifies a task; it does not say whose it is.
  const listedSessions = await tryCall(reader, "sessions.list", {});
  const rows = (listedSessions.result as { sessions?: Record<string, unknown>[] })?.sessions ?? [];
  say(
    "sessions.list kinds at read:",
    listedSessions.ok ? rows.slice(0, 6).map((r) => ({ key: String(r.key).replace(/[0-9a-f-]{36}/, "<uuid>"), kind: r.kind, chatType: r.chatType, channel: r.channel })) : listedSessions,
  );
  for (const c of [reader, writer]) await c.close();
}

/**
 * The node role's own credential on Clawtrate's ordinary path: the device is
 * paired as an operator and holds only its operator device token. An admin
 * connection asks the gateway for a node-only setup code; the node connection
 * presents its bootstrap token. No shared token is sent by that device.
 */
async function roleCredential() {
  const admin = await operator("admin", ["admin", "pairing", "read", "write"]);
  say("allowlist:", (await configAllow(admin, PROBE_COMMANDS)).ok);
  await sleep(1500);
  const id = identity();
  const op = await operator("X-operator", ["read"], id);
  say("X as an operator, device token only:", op.hello);
  const bare = await node("X-node", id, { shared: false });
  say("X as a node with only its operator token:", "conn" in bare ? { hello: bare.conn.hello } : { code: (bare.refused.details as Record<string, unknown>)?.code });
  const writer = await operator("writer", ["read", "write"]);
  say("setupCode at read and write:", await tryCall(writer, "device.pair.setupCode", { bootstrapProfile: "node", includeQr: false }).then((r) => ({ ok: r.ok, error: r.error })));
  const noUrl = await tryCall(admin, "device.pair.setupCode", { bootstrapProfile: "node", includeQr: false });
  say("setupCode at admin with no publicUrl:", { ok: noUrl.ok, error: noUrl.error, code: noUrl.code });
  const minted = await tryCall(admin, "device.pair.setupCode", { bootstrapProfile: "node", includeQr: false, publicUrl: url });
  const m = (minted.result ?? {}) as Record<string, unknown>;
  say("setupCode at admin:", minted.ok ? { keys: Object.keys(m), access: m.access, auth: m.auth, expiresInS: Math.round((Number(m.expiresAtMs) - Date.now()) / 1000) } : minted);
  if (!minted.ok) return;
  const payload = JSON.parse(Buffer.from(String(m.setupCode), "base64url").toString("utf8")) as Record<string, unknown>;
  const bootstrapToken = String(payload.bootstrapToken ?? "");
  secrets.push(bootstrapToken);
  say("the setup code holds:", Object.keys(payload));
  const before = devicesList().filter((d) => d.deviceId === short(id.deviceId));
  const withCode = await node("X-node", id, { bootstrap: bootstrapToken });
  say("X as a node with the node-only bootstrap token:", "conn" in withCode ? { hello: withCode.conn.hello } : withCode.refused);
  await sleep(800);
  say("X on the gateway before and after:", { before, after: devicesList().filter((d) => d.deviceId === short(id.deviceId)) });
  const described = await tryCall(admin, "node.describe", { nodeId: id.deviceId });
  const dd = (described.result ?? {}) as Record<string, unknown>;
  say("node.describe after:", described.ok ? { approvalState: dd.approvalState, paired: dd.paired, connected: dd.connected, commands: dd.commands } : described);
  say("node.pair.list pending for X:", pendingSummary(await admin.request("node.pair.list", {})).pending.filter((p) => p.nodeId === short(id.deviceId)));
  if ("conn" in withCode) await withCode.conn.close();
  const reuse = await node("Y-node", identity(), { bootstrap: bootstrapToken });
  say("the same bootstrap token again, on another device:", "conn" in reuse ? { hello: reuse.conn.hello } : { code: (reuse.refused.details as Record<string, unknown>)?.code, message: reuse.refused.message });
  if ("conn" in reuse) await reuse.conn.close();

  // (a) The same device: admin approves the role upgrade, then a second code.
  const upgrade = "refused" in withCode ? requestIdOf(withCode) : undefined;
  if (upgrade) say("(a) admin approves X's role upgrade:", await tryCall(admin, "device.pair.approve", { requestId: upgrade }).then((r) => ({ ok: r.ok, error: r.error })));
  say("(a) X on the gateway:", devicesList().filter((d) => d.deviceId === short(id.deviceId)));
  const second = await tryCall(admin, "device.pair.setupCode", { bootstrapProfile: "node", includeQr: false, publicUrl: url });
  const token2 = String(JSON.parse(Buffer.from(String((second.result as Record<string, unknown>).setupCode), "base64url").toString("utf8")).bootstrapToken);
  secrets.push(token2);
  const withSecond = await node("X-node", id, { bootstrap: token2 });
  say("(a) X as a node with a second code:", "conn" in withSecond ? { hello: withSecond.conn.hello } : { code: (withSecond.refused.details as Record<string, unknown>)?.code, reason: (withSecond.refused.details as Record<string, unknown>)?.reason });
  await sleep(800);
  say("(a) X's surface:", pendingSummary(await admin.request("node.pair.list", {})).pending.filter((p) => p.nodeId === short(id.deviceId)).map((p) => ({ commands: p.commands, requiredApproveScopes: p.requiredApproveScopes })));
  if ("conn" in withSecond) await withSecond.conn.close();
  const xAgain = await node("X-node", id, { shared: false });
  say("(a) X as a node again, its node device token only:", "conn" in xAgain ? { hello: xAgain.conn.hello } : { code: (xAgain.refused.details as Record<string, unknown>)?.code });
  if ("conn" in xAgain) await xAgain.conn.close();

  // (b) A key of its own for the node: a device that is only a node.
  const n = identity();
  const third = await tryCall(admin, "device.pair.setupCode", { bootstrapProfile: "node", includeQr: false, publicUrl: url });
  const token3 = String(JSON.parse(Buffer.from(String((third.result as Record<string, unknown>).setupCode), "base64url").toString("utf8")).bootstrapToken);
  secrets.push(token3);
  const fresh = await node("N-own-key", n, { bootstrap: token3 });
  say("(b) a node with its own key and the code:", "conn" in fresh ? { hello: fresh.conn.hello } : fresh.refused);
  await sleep(800);
  const nd = await tryCall(admin, "node.describe", { nodeId: n.deviceId });
  const ndr = (nd.result ?? {}) as Record<string, unknown>;
  say("(b) node.describe:", nd.ok ? { approvalState: ndr.approvalState, paired: ndr.paired, connected: ndr.connected, commands: ndr.commands } : nd);
  say("(b) on the gateway:", devicesList().filter((d) => d.deviceId === short(n.deviceId)));
  say("(b) node.pair.list pending:", pendingSummary(await admin.request("node.pair.list", {})).pending.filter((p) => p.nodeId === short(n.deviceId)));
  if ("conn" in fresh) await fresh.conn.close();
  const nAgain = await node("N-own-key", n, { shared: false });
  say("(b) reconnect with its node device token only:", "conn" in nAgain ? { hello: nAgain.conn.hello } : { code: (nAgain.refused.details as Record<string, unknown>)?.code });
  if ("conn" in nAgain) await nAgain.conn.close();
  // Stop and remove: the node's pairing is removed while it is stopped; then its saved token is tried.
  const mk = identity();
  const fifth = await tryCall(admin, "device.pair.setupCode", { bootstrapProfile: "node", includeQr: false, publicUrl: url });
  const token5 = String(JSON.parse(Buffer.from(String((fifth.result as Record<string, unknown>).setupCode), "base64url").toString("utf8")).bootstrapToken);
  secrets.push(token5);
  const mFirst = await node("M-remove", mk, { bootstrap: token5 });
  if ("conn" in mFirst) await mFirst.conn.close();
  const mBack = await node("M-remove", mk, { shared: false });
  say("(c) stopped, then reconnected on its saved node token:", "conn" in mBack ? { hello: mBack.conn.hello } : { code: (mBack.refused.details as Record<string, unknown>)?.code });
  if ("conn" in mBack) await mBack.conn.close();
  say("(c) admin removes the stopped node:", await tryCall(admin, "node.pair.remove", { nodeId: mk.deviceId }).then((r) => ({ ok: r.ok, error: r.error })));
  say("(c) node.describe after removal:", await tryCall(admin, "node.describe", { nodeId: mk.deviceId }).then((r) => (r.ok ? "listed" : r.error)));
  say("(c) on the gateway after removal:", devicesList().filter((d) => d.deviceId === short(mk.deviceId)));
  const mAfter = await node("M-remove", mk, { shared: false });
  say("(c) its saved node token after removal:", "conn" in mAfter ? { hello: mAfter.conn.hello } : { code: (mAfter.refused.details as Record<string, unknown>)?.code });
  if ("conn" in mAfter) await mAfter.conn.close();
  const rv = await tryCall(admin, "device.token.revoke", { deviceId: n.deviceId, role: "node" });
  say("(b) admin revokes its node token:", { ok: rv.ok, error: rv.error });
  const nAfter = await node("N-own-key", n, { shared: false });
  say("(b) reconnect after the revocation:", "conn" in nAfter ? { hello: nAfter.conn.hello } : { code: (nAfter.refused.details as Record<string, unknown>)?.code });
  if ("conn" in nAfter) await nAfter.conn.close();
  tokenStore.delete(`${n.deviceId}:node`);
  const fourth = await tryCall(admin, "device.pair.setupCode", { bootstrapProfile: "node", includeQr: false, publicUrl: url });
  const token4 = String(JSON.parse(Buffer.from(String((fourth.result as Record<string, unknown>).setupCode), "base64url").toString("utf8")).bootstrapToken);
  secrets.push(token4);
  const recovered = await node("N-own-key", n, { bootstrap: token4 });
  say("(b) recovery with a new code:", "conn" in recovered ? { hello: recovered.conn.hello } : { code: (recovered.refused.details as Record<string, unknown>)?.code, reason: (recovered.refused.details as Record<string, unknown>)?.reason });
  if ("conn" in recovered) await recovered.conn.close();
  await op.close();
  const opAgain = await operator("X-operator", ["read"], id);
  say("X as an operator after the revocation:", opAgain.hello);
  for (const c of [opAgain, writer, admin]) await c.close();
}

/** Which connections hear about another device's node requests. */
async function events() {
  const admin = await operator("admin", ["admin", "pairing", "read", "write"]);
  say("allowlist:", (await configAllow(admin, PROBE_COMMANDS)).ok);
  await sleep(1500);
  const watchers = [await operator("watch-pairing", ["pairing"]), await operator("watch-read-write", ["read", "write"]), await operator("watch-read", ["read"])];
  const p = await pairedNode(admin, "N-events");
  await sleep(800);
  for (const w of watchers) {
    say(
      `${w.label} (device token) heard:`,
      w.events
        .filter((e) => /^(device|node)\.pair\./.test(e.event))
        .filter((e) => {
          const pl = e.payload as Record<string, unknown>;
          return (pl.nodeId ?? pl.deviceId) === p.id.deviceId;
        })
        .map((e) => e.event),
    );
  }
  await p.conn.close();
  for (const c of [...watchers, admin]) await c.close();
}

async function local() {
  if (!recordedStartOptions(inst).defaultLocalPairing) throw new Error("start the instance with --default-local-pairing");
  const admin = await operator("admin", ["admin", "pairing", "read", "write"]);
  say("admin hello:", admin.hello);
  say("allowlist:", (await configAllow(admin, PROBE_COMMANDS)).ok);
  await sleep(1500);
  const id = identity();
  const direct = await node("N-loopback", id);
  say("node with commands on loopback:", "conn" in direct ? { hello: direct.conn.hello } : direct.refused);
  if ("conn" in direct) await direct.conn.close();
  say("node.pair.list:", pendingSummary(await admin.request("node.pair.list", {})));

  // The same through a loopback proxy that adds the header every reverse proxy adds.
  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    try {
      connection.recheck();
    } catch {
      socket.destroy();
      return;
    }
    const upstream = netConnect(gatewayPort, "127.0.0.1", () => {
      const headers = { ...req.headers, "x-forwarded-for": "192.0.2.10" };
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const proxied = await node("N-proxied", identity(), { proxy: server });
  say("node with commands through the proxy:", "conn" in proxied ? { hello: proxied.conn.hello } : proxied.refused);
  if ("conn" in proxied) await proxied.conn.close();
  say("node.pair.list:", pendingSummary(await admin.request("node.pair.list", {})));
  server.close();
  await admin.close();
}

function devicesList() {
  const { status, out } = runOpenclaw(["devices", "list", "--json"]);
  if (status !== 0) return { error: out.slice(0, 300) };
  const parsed = parseJsonOutput<{ paired?: Record<string, unknown>[] }>(out);
  return (parsed.paired ?? []).map((d) => ({ deviceId: short(d.deviceId), displayName: d.displayName, roles: d.roles, scopes: d.scopes }));
}

const experiments: Record<string, () => Promise<unknown>> = { drop, tiers, same, invoke, revoke, perm, share, events, roleCredential, local };
if (!experiment || !experiments[experiment]) {
  console.log(`usage: node-probe.ts <${Object.keys(experiments).join("|")}> --instance <name>`);
  process.exit(1);
}
await experiments[experiment]!();
say("gateway devices:", devicesList());
setTimeout(() => process.exit(0), 300);
