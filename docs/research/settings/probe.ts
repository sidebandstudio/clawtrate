// Probes behind docs/research/settings.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name>
//   node docs/research/settings/probe.ts <experiment> --instance <name> --data <dir> [...]
//
// It acts only on a named development instance this checkout started, reads
// that instance's address and token from the tool's own run files, and runs
// `openclaw` only through the tool's guarded runner (so always with
// `--profile clawtrate-dev-<name>`). Every line it prints passes through
// `redact`: tokens, this machine's names, its addresses and the home folder
// never reach the output. The client folder given with `--data` is kept
// between experiments, so one device pairs once and is reused.
//
// Experiments:
//   pair       this project's client (packages/core) connects with the shared
//              token, as the desktop app does, and the gateway's own
//              `devices approve <requestId>` approves it
//   upgrade    the same device asks for --tier interactive or admin
//              (device.scopes.requestUpgrade), approved the same way
//   call       one request on the paired device: --method <m> [--params <json>]
//   compact    `/compact` through chat.send in a new task: with nothing to
//              compact, after turns, during a run; each with chat.history read back
//   compact-default  as admin: compaction.mode "default" on this instance, /compact on --key, then restored
//   compact-steer    /compact in steer mode while a run is active in --key
//   old-protocol     a new device whose connect offers only protocol --proto (3): the gateway's answer
//   history    the last --last rows of task --key, and its sessions.list row
//   devices    the gateway's own `devices list --json`, redacted

import { mkdirSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { parseArgs } from "node:util";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ClawtrateClient, validateGatewayUrl } from "../../../packages/core/src/client.ts";
import { createNodeHost } from "../../../packages/core/src/node/index.ts";
import { openInstance, readDevConnection } from "../../../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../../../tools/dev-gateway/src/env.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    instance: { type: "string" },
    data: { type: "string" },
    tier: { type: "string", default: "interactive" },
    method: { type: "string" },
    params: { type: "string", default: "{}" },
    bot: { type: "string", default: "juniper" },
    max: { type: "string", default: "1600" },
    key: { type: "string" },
    last: { type: "string", default: "6" },
    seconds: { type: "string", default: "15" },
    proto: { type: "string", default: "3" },
    directive: { type: "string", default: "#slow-tool" },
  },
  allowPositionals: true,
});
const experiment = positionals[0];
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
const connection = readDevConnection(inst.connectionFile);
if (!connection || connection.instance !== values.instance) throw new Error("no connection record for this instance");
const url = connection.url;

const secrets: string[] = [connection.token];
const machineWords = [hostname(), hostname().split(".")[0]!].filter((w) => w.length >= 3);
const addresses = Object.values(networkInterfaces())
  .flat()
  .map((i) => i?.address)
  .filter((a): a is string => Boolean(a) && a !== "127.0.0.1" && a !== "::1");
const redact = (text: string) => {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  out = out.split(homedir()).join("~");
  for (const word of machineWords) out = out.split(word).join("<this machine>");
  for (const address of addresses) out = out.split(address).join("<an address>");
  out = out.replace(/"\/Volumes\/[^"]*"/g, '"<a mounted volume>"');
  out = out.replace(/("(?:machineName|hostname|cpuModel|lanAddress|label|senderName|displayName)"\s*:\s*")[^"]+/g, "$1<redacted>");
  return out.replace(/("(?:token|deviceToken|bootstrapToken|setupCode|publicKey)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const max = Number(values.max);
const say = (...parts: unknown[]) => {
  const line = redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  console.log(line.length > max ? `${line.slice(0, max)} …(${line.length} chars)` : line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runOpenclaw(args: string[]) {
  const result = inst.runner.runSync(args);
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function devices() {
  const { status, out } = runOpenclaw(["devices", "list", "--json"]);
  if (status !== 0) return { error: out.slice(0, 400) };
  const parsed = parseJsonOutput<{ pending?: Record<string, unknown>[]; paired?: Record<string, unknown>[] }>(out);
  const pick = (d: Record<string, unknown>) => ({
    deviceId: String(d.deviceId ?? "").slice(0, 12),
    requestId: d.requestId,
    displayName: d.displayName,
    roles: d.roles,
    scopes: d.scopes,
    approvedVia: d.approvedVia,
  });
  return { pending: (parsed.pending ?? []).map(pick), paired: (parsed.paired ?? []).map(pick) };
}

function coreClient() {
  if (!values.data) throw new Error("--data <dir> is required");
  mkdirSync(values.data, { recursive: true, mode: 0o700 });
  return new ClawtrateClient(
    createNodeHost({
      dataDir: values.data,
      client: { displayName: "Clawtrate Desktop", version: "0.0.0-research", platform: process.platform },
    }),
    { reconnect: { initialMs: 500, maxMs: 2000 } },
  );
}

async function settle(done: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await sleep(100);
}

function summary(client: ClawtrateClient) {
  const c = client.state.connection;
  return {
    status: c.status,
    scopes: c.scopes,
    pairing: c.pairing && { requestId: c.pairing.requestId },
    error: c.error && { code: c.error.code, message: c.error.message },
    upgrade: { status: c.upgrade.status, requestId: c.upgrade.requestId, scopes: c.upgrade.scopes },
    deviceId: c.deviceId?.slice(0, 12) ?? null,
    gatewayId: c.gatewayId?.slice(0, 12) ?? null,
  };
}

/**
 * `start()` resumes the gateway saved in the --data folder, not the one --instance names. Refuse before it
 * when the saved gateway isn't this instance's (compared as `connect()` stores it); `pair` may start from an
 * empty folder.
 */
async function sameGatewayOrRefuse(client: ClawtrateClient, { allowNone = false } = {}) {
  const saved = await client.savedSettings();
  if (!saved && allowNone) return;
  if (!saved || saved.url !== validateGatewayUrl(url)) {
    throw new Error("the --data folder's saved gateway is not this instance's: use a client folder paired with this instance, or a new one with `pair`");
  }
}

async function connected() {
  const client = coreClient();
  await sameGatewayOrRefuse(client);
  await client.start();
  await settle(() => client.state.connection.status === "connected");
  if (client.state.connection.status !== "connected") throw new Error(`not connected: ${JSON.stringify(summary(client))}`);
  const request = (client as unknown as { request(m: string, p: unknown): Promise<unknown> }).request.bind(client);
  return { client, request };
}

async function attempt(request: (m: string, p: unknown) => Promise<unknown>, method: string, params: unknown) {
  try {
    return { ok: true, result: await request(method, params) };
  } catch (error) {
    const e = error as Error & { code?: string; details?: unknown };
    return { ok: false, error: { name: e.name, code: e.code, message: e.message, details: e.details } };
  }
}

async function pair() {
  const client = coreClient();
  await sameGatewayOrRefuse(client, { allowNone: true });
  await client.start();
  await client.connect({ url, token: connection!.token });
  await settle(() => ["connected", "pairing", "error"].includes(client.state.connection.status));
  say("after connect:", summary(client));
  const requestId = client.state.connection.pairing?.requestId;
  if (requestId) {
    const approved = runOpenclaw(["devices", "approve", requestId]);
    say(`devices approve <request>: exit ${approved.status}`);
    await settle(() => client.state.connection.status === "connected", 20_000);
  }
  await settle(() => client.state.connection.gatewayId !== null, 5000);
  say("paired:", summary(client));
  client.stop();
}

async function upgrade() {
  const { client } = await connected();
  const tier = values.tier === "admin" ? "admin" : "interactive";
  const asked = client.requestAccess(tier).catch((e: unknown) => say("requestAccess:", String(e)));
  await settle(() => !["idle", "requesting"].includes(client.state.connection.upgrade.status), 10_000);
  say(`asked for ${tier}:`, summary(client));
  const requestId = client.state.connection.upgrade.requestId;
  if (requestId) {
    const approved = runOpenclaw(["devices", "approve", requestId]);
    say(`devices approve <request>: exit ${approved.status}`);
    await settle(() => (tier === "admin" ? client.state.connection.canAdmin : client.state.connection.canWrite), 20_000);
    await sleep(1500);
  }
  say("after approval:", summary(client));
  void asked;
  client.stop();
}

async function call() {
  if (!values.method) throw new Error("--method is required");
  const { client, request } = await connected();
  say("as:", summary(client).scopes);
  const params = JSON.parse(values.params!.replace(/\$SELF/g, client.state.connection.deviceId ?? "")) as unknown;
  say(`${values.method}:`, await attempt(request, values.method, params));
  await sleep(1000);
  say("after:", summary(client));
  client.stop();
}

/** The rows of a task's history, each reduced to what this note needs. */
async function historyRows(request: (m: string, p: unknown) => Promise<unknown>, sessionKey: string) {
  const read = await attempt(request, "chat.history", { sessionKey, limit: 200 });
  if (!read.ok) return read;
  const messages = ((read.result as { messages?: Record<string, unknown>[] }).messages ?? []) as Record<string, unknown>[];
  return messages.map((m) => {
    const meta = (m.__openclaw ?? {}) as Record<string, unknown>;
    const content = m.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.map((c) => (c as { text?: string }).text ?? `[${(c as { type?: string }).type}]`).join(" ")
      : "";
    return {
      role: m.role,
      kind: meta.kind,
      ...(meta.kind === "compaction" ? { tokensBefore: meta.tokensBefore, tokensAfter: meta.tokensAfter } : {}),
      ...(m.openclawStatusNotice ? { statusNotice: true } : {}),
      text: text.slice(0, 120),
    };
  });
}

async function waitIdle(request: (m: string, p: unknown) => Promise<unknown>, sessionKey: string, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rows = await historyRows(request, sessionKey);
    const last = Array.isArray(rows) ? rows.at(-1) : null;
    if (last && last.role === "assistant") return;
    await sleep(500);
  }
}

async function compact() {
  const { client, request } = await connected();
  say("as:", summary(client).scopes);
  const created = await attempt(request, "sessions.create", { agentId: values.bot, idempotencyKey: randomUUID() });
  say("sessions.create:", created);
  const key = (created.result as { key?: string })?.key;
  if (!key) throw new Error("no task");
  const send = (message: string) =>
    attempt(request, "chat.send", { sessionKey: key, message, idempotencyKey: randomUUID(), queueMode: "followup" });

  say("1. /compact in a new task, nothing in it:", await send("/compact"));
  await sleep(4000);
  say("   history:", await historyRows(request, key));

  for (const text of ["#steps", "#think", "#steps"]) {
    say(`2. send ${text}:`, (await send(text)).ok);
    await waitIdle(request, key);
  }
  say("   history before compacting:", await historyRows(request, key));
  say("3. /compact after three turns:", await send("/compact"));
  await sleep(8000);
  say("   history:", await historyRows(request, key));

  say("4. send #slow-tool 20:", (await send("#slow-tool 20")).ok);
  await sleep(3000);
  say("   /compact while that run is active:", await send("/compact"));
  await sleep(4000);
  say("   history while active:", await historyRows(request, key));
  await waitIdle(request, key, 60_000);
  await sleep(3000);
  say("   history after the run:", await historyRows(request, key));
  say("task key:", key);
  client.stop();
}

/** As admin, on this instance only: compaction.mode "default", /compact on --key, history, then the mode put back. */
async function compactDefault() {
  if (!values.key) throw new Error("--key is required");
  const { client, request } = await connected();
  say("as:", summary(client).scopes);
  const get = async () => (await request("config.get", {})) as { hash: string; config?: { agents?: { defaults?: { compaction?: { mode?: string } } } } };
  const before = await get();
  const original = before.config?.agents?.defaults?.compaction?.mode ?? null;
  say("compaction.mode before:", original);
  say("config.patch mode default:", (await attempt(request, "config.patch", { raw: JSON.stringify({ agents: { defaults: { compaction: { mode: "default" } } } }), baseHash: before.hash })).ok);
  await sleep(3000);
  try {
    const rowsBefore = await historyRows(request, values.key);
    say("rows before:", Array.isArray(rowsBefore) ? rowsBefore.length : rowsBefore);
    say("/compact:", await attempt(request, "chat.send", { sessionKey: values.key, message: "/compact", idempotencyKey: randomUUID(), queueMode: "followup" }));
    await sleep(10_000);
    const rows = await historyRows(request, values.key);
    say("rows after:", Array.isArray(rows) ? rows.length : rows, "last:", Array.isArray(rows) ? rows.slice(-3) : null);
    const raw = (await request("chat.history", { sessionKey: values.key, limit: 200 })) as { messages?: Record<string, unknown>[] };
    say("compaction rows, raw:", (raw.messages ?? []).filter((m) => (m.__openclaw as { kind?: string } | undefined)?.kind === "compaction"));
  } finally {
    const after = await get();
    say("restore:", (await attempt(request, "config.patch", { raw: JSON.stringify({ agents: { defaults: { compaction: { mode: original } } } }), baseHash: after.hash })).ok);
    await sleep(2000);
    say("compaction.mode after:", (await get()).config?.agents?.defaults?.compaction?.mode ?? null);
  }
  client.stop();
}

/** /compact sent in steer mode while a slow run is active, in task --key. */
async function compactSteer() {
  if (!values.key) throw new Error("--key is required");
  const { client, request } = await connected();
  const send = (message: string, queueMode: string) =>
    attempt(request, "chat.send", { sessionKey: values.key, message, idempotencyKey: randomUUID(), queueMode });
  const seconds = Number(values.seconds);
  say(`send ${values.directive} ${seconds}:`, (await send(`${values.directive} ${seconds}`, "followup")).ok);
  await sleep(3000);
  const t0 = Date.now();
  say("/compact, steer, while active:", await send("/compact", "steer"));
  await sleep(3000);
  say("history while active:", ((await historyRows(request, values.key!)) as unknown[]).slice(-3));
  for (let i = 0; i < 60; i++) {
    const rows = (await historyRows(request, values.key!)) as { text?: string }[];
    if (rows.at(-1)?.text?.startsWith("⚙️")) break;
    await sleep(2000);
  }
  say(`notice after ${Math.round((Date.now() - t0) / 1000)} s`);
  say("history after:", ((await historyRows(request, values.key!)) as unknown[]).slice(-4));
  client.stop();
}

/** A new device whose connect offers only protocol --proto (3 by default): what the gateway answers. */
async function oldProtocol() {
  const requireFromTool = createRequire(new URL("../../../tools/dev-gateway/package.json", import.meta.url));
  const { GatewayClient } = (await import(pathToFileURL(requireFromTool.resolve("@openclaw/gateway-client")).href)) as {
    GatewayClient: new (options: unknown) => { start(): void; stopAndWait(): Promise<void> };
  };
  const proto = Number(values.proto);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const identity = {
    deviceId: createHash("sha256").update(raw).digest("hex"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const outcome = await new Promise<unknown>((resolve) => {
    const client = new GatewayClient({
      url,
      token: connection!.token,
      clientName: "gateway-client",
      mode: "ui",
      clientDisplayName: "Clawtrate research",
      clientVersion: "0.0.0-research",
      platform: process.platform,
      role: "operator",
      scopes: ["operator.read"],
      caps: ["tool-events"],
      minProtocol: proto,
      maxProtocol: proto,
      deviceIdentity: identity,
      hostDeps: {
        signDevicePayload: (pem: string, payload: string) => sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
        publicKeyRawBase64UrlFromPem: (pem: string) => createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
        loadDeviceAuthToken: () => undefined,
        storeDeviceAuthToken: () => {},
        clearDeviceAuthToken: () => {},
      },
      onHelloOk: (hello: { protocol?: number }) => resolve({ outcome: "hello", protocol: hello.protocol }),
      onConnectError: (error: Error & { details?: unknown; code?: string }) => resolve({ outcome: "refused", message: error.message, code: error.code, details: error.details }),
      onClose: (code: number, reason: string) => resolve({ outcome: "closed", code, reason }),
    });
    client.start();
    setTimeout(() => resolve({ outcome: "no answer in 15 s" }), 15_000);
    void client;
  });
  say(`connect offering protocol ${proto} only:`, outcome);
}

async function history() {
  if (!values.key) throw new Error("--key is required");
  const { client, request } = await connected();
  const rows = await historyRows(request, values.key);
  say("history:", Array.isArray(rows) ? rows.slice(-Number(values.last)) : rows);
  say("sessions.list row:", await attempt(request, "sessions.list", { search: values.key, limit: 5 }));
  client.stop();
}

const experiments: Record<string, () => Promise<void> | void> = {
  "compact-default": compactDefault,
  "old-protocol": oldProtocol,
  "compact-steer": compactSteer,
  history,
  pair,
  upgrade,
  call,
  compact,
  devices: () => say(devices()),
};
const run = experiment ? experiments[experiment] : undefined;
if (!run) throw new Error(`experiment: ${Object.keys(experiments).join(", ")}`);
await run();
process.exit(0);
