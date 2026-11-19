// Probes behind docs/research/setup-flow.md, points 1 to 4. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name> --default-local-pairing --no-seed
//   node docs/research/setup-flow/pair-probe.ts <experiment> --instance <name> [--port <local port>] [--scopes read,write]
//
// It acts only on a named development instance this checkout started with
// `--default-local-pairing`, reads that instance's address and token from the
// tool's own run files, and runs `openclaw` only through the tool's guarded
// runner (so always with `--profile clawtrate-dev-<name>`). It never prints a
// token: every line it prints passes through `redact`. `--port` points the
// client at another local port, and is refused unless the process listening
// there is an `ssh` whose command line forwards exactly that port to this
// instance's port on loopback: the token is never sent to an unproven
// listener. A scratch client folder it makes is removed when it ends; one
// given with `--data` is kept, for `upgrade` and `method`.
//
// Experiments:
//   pair      this project's client (packages/core) connects with the shared
//             token, as the desktop app does; prints what the gateway did
//   upgrade   the same device asks for the interactive tier
//             (device.scopes.requestUpgrade); with --approve, the gateway's own
//             `devices approve <requestId>` approves it on the gateway's computer
//   code      `openclaw qr --json --url ws://127.0.0.1:<port>` (add --limited or --voice),
//             decoded; then a new device redeems it asking for the scopes of
//             --scopes (operator.read alone by default), and a second device
//             tries the same code again
//   method    a read-only connection calls device.pair.setupCode
//   proxy     the client connects through a local proxy that adds
//             X-Forwarded-For, as a reverse-proxy route made by hand does

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash, generateKeyPairSync, createPublicKey, createPrivateKey, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ClawtrateClient } from "../../../packages/core/src/client.ts";
import { createNodeHost } from "../../../packages/core/src/node/index.ts";
import { openInstance, readDevConnection, recordedStartOptions } from "../../../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../../../tools/dev-gateway/src/env.ts";

// The pinned client, from the development tool's own dependencies.
const requireFromTool = createRequire(new URL("../../../tools/dev-gateway/package.json", import.meta.url));
const { GatewayClient } = (await import(
  pathToFileURL(requireFromTool.resolve("@openclaw/gateway-client")).href
)) as typeof import("@openclaw/gateway-client");

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    instance: { type: "string" },
    port: { type: "string" },
    approve: { type: "boolean", default: false },
    limited: { type: "boolean", default: false },
    voice: { type: "boolean", default: false },
    data: { type: "string" },
    scopes: { type: "string", default: "read" },
  },
  allowPositionals: true,
});
const experiment = positionals[0];
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
if (!recordedStartOptions(inst).defaultLocalPairing) {
  throw new Error(`instance "${values.instance}" was not started with --default-local-pairing`);
}
const connection = readDevConnection(inst.connectionFile);
if (!connection || connection.instance !== values.instance) throw new Error("no connection record for this instance");
const gatewayPort = Number(new URL(connection.url).port);
const port = values.port ? Number(values.port) : gatewayPort;
if (values.port) assertOwnForward(port, gatewayPort);
const SCOPES = values.scopes!.split(",").map((s) => `operator.${s.trim()}`);
if (!SCOPES.every((s) => /^operator\.(read|write|approvals|questions|admin)$/.test(s))) throw new Error("--scopes takes read, write, approvals, questions, admin");

/** The only listener on `port` must be an ssh forwarding exactly `port` to the instance's own port. */
function assertOwnForward(local: number, target: number) {
  if (!Number.isInteger(local) || local < 1024 || local > 65535 || local === target) throw new Error("--port must be another unprivileged port");
  const pids = spawnSync("lsof", ["-nP", `-iTCP:${local}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  if (pids.length !== 1) throw new Error(`expected one listener on ${local}, found ${pids.length}`);
  const command = spawnSync("ps", ["-o", "command=", "-p", pids[0]!], { encoding: "utf8" }).stdout.trim();
  const words = command.split(/\s+/);
  const forward = `127.0.0.1:${local}:127.0.0.1:${target}`;
  if (!/(^|\/)ssh$/.test(words[0] ?? "") || !words.some((w, i) => w === forward && words[i - 1] === "-L")) {
    throw new Error(`the listener on ${local} is not an ssh forward to 127.0.0.1:${target}`);
  }
}
const url = `ws://127.0.0.1:${port}`;

const secrets: string[] = [connection.token];
const redact = (text: string) => {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  return out.replace(/("(?:token|deviceToken|bootstrapToken|setupCode)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const say = (...parts: unknown[]) =>
  console.log(redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")));
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
    clientId: d.clientId,
    clientMode: d.clientMode,
    displayName: d.displayName,
    roles: d.roles,
    scopes: d.scopes,
    approvedVia: d.approvedVia,
  });
  return { pending: (parsed.pending ?? []).map(pick), paired: (parsed.paired ?? []).map(pick) };
}

function coreClient(dataDir: string) {
  return new ClawtrateClient(
    createNodeHost({
      dataDir,
      client: { displayName: "Clawtrate Desktop", version: "0.0.0-research", platform: process.platform },
    }),
    { reconnect: { initialMs: 500, maxMs: 2000 } },
  );
}

async function settle(client: ClawtrateClient, done: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await sleep(100);
}

function summary(client: ClawtrateClient) {
  const c = client.state.connection;
  return {
    status: c.status,
    url: c.gatewayUrl,
    scopes: c.scopes,
    requestedScopes: c.requestedScopes,
    paired: c.paired,
    pairing: c.pairing && { requestId: c.pairing.requestId, requestedScopes: c.pairing.requestedScopes },
    error: c.error && { code: c.error.code, message: c.error.message },
    upgrade: { status: c.upgrade.status, requestId: c.upgrade.requestId, scopes: c.upgrade.scopes, error: c.upgrade.error },
    gatewayId: c.gatewayId?.slice(0, 12) ?? null,
  };
}

async function pair() {
  const dataDir = values.data ?? mkdtempSync(join(tmpdir(), "su-pair-"));
  if (!values.data) process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));
  const client = coreClient(dataDir);
  await client.start();
  say("connect", url, "with the shared token, data", dataDir);
  await client.connect({ url, token: connection!.token });
  await settle(client, () => ["connected", "pairing", "error"].includes(client.state.connection.status));
  await settle(client, () => client.state.connection.gatewayId !== null, 5000);
  say("core client:", summary(client));
  say("gateway devices:", devices());
  client.stop();
}

async function upgrade() {
  if (!values.data) throw new Error("--data <dir> from a paired `pair` run is required");
  const client = coreClient(values.data);
  await client.start();
  await settle(client, () => client.state.connection.status === "connected");
  say("before:", summary(client));
  const asked = client.requestAccess("interactive").catch((e: unknown) => say("requestAccess:", String(e)));
  await settle(client, () => !["idle", "requesting"].includes(client.state.connection.upgrade.status), 10_000);
  say("after asking:", summary(client));
  say("gateway devices:", devices());
  const requestId = client.state.connection.upgrade.requestId;
  if (values.approve && requestId) {
    const approved = runOpenclaw(["devices", "approve", requestId]);
    say(`devices approve ${requestId}: exit ${approved.status}`);
    say(approved.out.trim());
    await settle(client, () => client.state.connection.canWrite, 15_000);
    say("after approval:", summary(client));
  }
  void asked;
  client.stop();
}

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    deviceId: createHash("sha256").update(raw).digest("hex"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function redeem(bootstrapToken: string, label: string) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const tokens: Record<string, unknown> = {};
    let finished = false;
    const finish = (value: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      void client.stopAndWait().catch(() => {});
      resolve(value);
    };
    const client = new GatewayClient({
      url,
      bootstrapToken,
      clientName: "gateway-client",
      mode: "ui",
      clientDisplayName: `Clawtrate research ${label}`,
      clientVersion: "0.0.0-research",
      platform: process.platform,
      role: "operator",
      scopes: SCOPES,
      caps: ["tool-events"],
      minProtocol: 4,
      maxProtocol: 4,
      deviceIdentity: identity(),
      hostDeps: {
        signDevicePayload: (pem: string, payload: string) =>
          sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
        publicKeyRawBase64UrlFromPem: (pem: string) =>
          createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
        loadDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) => tokens[`${deviceId}:${role}`],
        storeDeviceAuthToken: (rec: { deviceId: string; role: string; token: string }) => {
          secrets.push(rec.token);
          tokens[`${rec.deviceId}:${rec.role}`] = rec;
        },
        clearDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) => delete tokens[`${deviceId}:${role}`],
      },
      onHelloOk: (hello: { auth?: { role?: string; scopes?: string[]; deviceToken?: string } }) => {
        if (hello.auth?.deviceToken) secrets.push(hello.auth.deviceToken);
        finish({ outcome: "hello", role: hello.auth?.role, scopes: hello.auth?.scopes, deviceToken: Boolean(hello.auth?.deviceToken) });
      },
      onConnectError: (error: Error & { details?: Record<string, unknown>; code?: string }) =>
        finish({ outcome: "refused", message: error.message, code: error.code, details: error.details }),
    } as never);
    client.start();
    setTimeout(() => finish({ outcome: "no answer in 15 s" }), 15_000);
  });
}

async function code() {
  const args = [
    "qr",
    "--json",
    "--url",
    `ws://127.0.0.1:${port}`,
    ...(values.limited ? ["--limited"] : []),
    ...(values.voice ? ["--voice-node"] : []),
  ];
  const { status, out } = runOpenclaw(args);
  say(`openclaw ${args.join(" ")}: exit ${status}`);
  if (status !== 0) return say(out.slice(0, 600));
  const result = parseJsonOutput<Record<string, unknown> & { setupCode: string }>(out);
  const decoded = Buffer.from(result.setupCode, "base64url").toString("utf8");
  const payload = JSON.parse(decoded) as Record<string, unknown> & { bootstrapToken?: string; expiresAtMs?: number };
  if (payload.bootstrapToken) secrets.push(payload.bootstrapToken);
  secrets.push(result.setupCode);
  say("result keys:", Object.keys(result), "access:", result.access, "auth:", result.auth, "urlSource:", result.urlSource);
  say("payload keys:", Object.keys(payload), "url:", payload.url, "bootstrapToken length:", payload.bootstrapToken?.length);
  say("shared token in the code:", decoded.includes(connection!.token));
  if (payload.expiresAtMs) say("lives for seconds:", Math.round((payload.expiresAtMs - Date.now()) / 1000));
  say(`first device redeems it asking for ${SCOPES.join(", ")}:`, await redeem(payload.bootstrapToken!, "first"));
  say("gateway devices:", devices());
  say("second device, same code:", await redeem(payload.bootstrapToken!, "second"));
}

async function method() {
  if (!values.data) throw new Error("--data <dir> from a paired `pair` run is required");
  const client = coreClient(values.data);
  await client.start();
  await settle(client, () => client.state.connection.status === "connected");
  say("scopes:", client.state.connection.scopes);
  const request = (client as unknown as { request(m: string, p: unknown): Promise<unknown> }).request.bind(client);
  try {
    say("device.pair.setupCode:", await request("device.pair.setupCode", { bootstrapProfile: "limited", includeQr: false }));
  } catch (error) {
    say("device.pair.setupCode refused:", String(error));
  }
  client.stop();
}

async function proxy() {
  // A loopback proxy that adds the header every reverse proxy adds.
  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
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
  const proxyPort = (server.address() as { port: number }).port;
  const dataDir = mkdtempSync(join(tmpdir(), "su-proxy-"));
  const client = coreClient(dataDir);
  await client.start();
  say("connect through a header-adding proxy on", proxyPort);
  await client.connect({ url: `ws://127.0.0.1:${proxyPort}`, token: connection!.token });
  await settle(client, () => ["connected", "pairing", "error"].includes(client.state.connection.status), 10_000);
  say("core client:", summary(client));
  client.stop();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  void httpRequest;
}

const experiments: Record<string, () => Promise<unknown>> = { pair, upgrade, code, method, proxy };
if (!experiment || !experiments[experiment]) {
  console.log(`usage: pair-probe.ts <${Object.keys(experiments).join("|")}> --instance <name> [--port <n>] [--data <dir>] [--approve] [--limited]`);
  process.exit(1);
}
await experiments[experiment]!();
setTimeout(() => process.exit(0), 300);
