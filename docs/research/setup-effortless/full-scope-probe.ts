// Probes behind docs/design/setup-effortless.md: full operator scopes asked for
// at the first connect, read the gateway's address and token from its config
// file instead of running OpenClaw, and approve another device from the app.
// Research code, not a check.
//
//   pnpm dev-gateway start --instance <local> --default-local-pairing --no-seed
//   pnpm dev-gateway start --instance <remote> --no-seed
//   node docs/research/setup-effortless/full-scope-probe.ts <experiment> --instance <name>
//
// It acts only on a named development instance this checkout started. The
// address and the shared token are read from that instance's own
// `openclaw.json` (as the design reads a real one), never from `~/.openclaw`.
// `openclaw` runs only through the development tool's guarded runner, so
// always with `--profile clawtrate-dev-<name>`, and only to list devices or,
// in `remote`, to approve the first device as the gateway's owner would.
// Nothing it prints carries a token: every line passes through `redact`.
//
// Experiments:
//   local     a new device asks for all six scopes with the shared token on
//             loopback (instance with OpenClaw's default local pairing); then
//             reconnects with its device token alone, asking for the same six
//   remote    the same on an instance whose local auto-approval is off, the
//             stand-in for a gateway on another computer: one pending request,
//             approved once on the gateway's computer
//   inapp     after `remote`: device A (all six, device token) watches events;
//             device B asks for all six and A approves it with device.pair.approve;
//             device C asks and A rejects it; device P, paired for pairing
//             without admin, tries to approve device D
//   repair    a device paired for read alone reconnects presenting the shared
//             token and asking for all six (the shared-token scope-upgrade path)

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash, generateKeyPairSync, createPublicKey, createPrivateKey, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openInstance, recordedStartOptions } from "../../../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../../../tools/dev-gateway/src/env.ts";

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
const localPairing = recordedStartOptions(inst).defaultLocalPairing === true;

// --- the config file, read as the design reads it ------------------------------
const stateDir = join(process.env.HOME!, `.openclaw-clawtrate-dev-${values.instance}`);
const configPath = join(stateDir, "openclaw.json");
const configMode = (statSync(configPath).mode & 0o777).toString(8);
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  gateway?: { port?: number; bind?: string; auth?: { mode?: string; token?: unknown } };
};
const port = config.gateway?.port;
const token = config.gateway?.auth?.token;
if (typeof port !== "number" || typeof token !== "string") throw new Error("config has no plain port and token");
const url = `ws://127.0.0.1:${port}`;

const FULL = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.admin",
  "operator.pairing",
];
const CAPS = ["tool-events", "approvals", "exec-approvals", "plugin-approvals"];

const secrets: string[] = [token];
const redact = (text: string) => {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  return out.replace(/("(?:token|deviceToken|bootstrapToken|publicKey)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const say = (...parts: unknown[]) =>
  console.log(redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function devices() {
  const result = inst.runner.runSync(["devices", "list", "--json"]);
  if (result.status !== 0) return { error: `${result.stdout}${result.stderr}`.slice(0, 300) };
  const parsed = parseJsonOutput<{ pending?: Record<string, unknown>[]; paired?: Record<string, unknown>[] }>(
    `${result.stdout}`,
  );
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

type Device = {
  label: string;
  identity: { deviceId: string; publicKeyPem: string; privateKeyPem: string };
  tokens: Record<string, { token: string; scopes?: string[] }>;
};

function newDevice(label: string): Device {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    label,
    identity: {
      deviceId: createHash("sha256").update(raw).digest("hex"),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    tokens: {},
  };
}

type Session = {
  outcome: Record<string, unknown>;
  client: InstanceType<typeof GatewayClient>;
  events: Array<{ event: string; payload: unknown }>;
};

/** One connect. `shared` presents the shared token; otherwise only the stored device token. */
function connect(device: Device, scopes: string[], opts: { shared: boolean; keep?: boolean }) {
  return new Promise<Session>((resolve) => {
    const events: Session["events"] = [];
    let finished = false;
    const finish = (outcome: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      if (!opts.keep || outcome.outcome !== "hello") void client.stopAndWait().catch(() => {});
      resolve({ outcome, client, events });
    };
    const client = new GatewayClient({
      url,
      ...(opts.shared ? { token } : {}),
      clientName: "gateway-client",
      mode: "ui",
      clientDisplayName: `Clawtrate research ${device.label}`,
      clientVersion: "0.0.0-research",
      platform: process.platform,
      role: "operator",
      scopes,
      caps: scopes.includes("operator.approvals") ? CAPS : ["tool-events"],
      minProtocol: 4,
      maxProtocol: 4,
      deviceIdentity: device.identity,
      hostDeps: {
        signDevicePayload: (pem: string, payload: string) =>
          sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
        publicKeyRawBase64UrlFromPem: (pem: string) =>
          createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
        // With the shared token presented, no stored token is offered: that is the shared-token path.
        loadDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) =>
          opts.shared ? undefined : device.tokens[`${deviceId}:${role}`],
        storeDeviceAuthToken: (rec: { deviceId: string; role: string; token: string; scopes?: string[] }) => {
          secrets.push(rec.token);
          device.tokens[`${rec.deviceId}:${rec.role}`] = rec;
        },
        clearDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) =>
          delete device.tokens[`${deviceId}:${role}`],
      },
      onEvent: (frame: { event: string; payload?: unknown }) => {
        if (frame.event.startsWith("device.")) events.push({ event: frame.event, payload: frame.payload });
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

async function call(session: Session, method: string, params: unknown) {
  try {
    return { ok: true, result: await session.client.request(method, params) };
  } catch (error) {
    const e = error as Error & { code?: string; details?: unknown };
    return { ok: false, error: e.message, code: e.code, details: e.details };
  }
}

function says() {
  say("instance:", values.instance, "default local pairing:", localPairing);
  say("config:", configPath, "mode", configMode, "port", port, "bind", config.gateway?.bind, "auth mode", config.gateway?.auth?.mode, "token is a plain string of", token.length, "chars");
}

async function firstPairing(device: Device) {
  const first = await connect(device, FULL, { shared: true });
  say(`${device.label} asks for all six with the shared token:`, first.outcome);
  return first;
}

async function local() {
  says();
  if (!localPairing) throw new Error("`local` needs an instance started with --default-local-pairing");
  const a = newDevice("A-local");
  await firstPairing(a);
  say("gateway devices:", devices());
  const again = await connect(a, FULL, { shared: false });
  say("A reconnects with its device token alone, asking for all six:", again.outcome);
}

async function remote() {
  says();
  if (localPairing) throw new Error("`remote` needs an instance with local auto-approval off");
  const a = newDevice("A-remote");
  const first = await firstPairing(a);
  const list = devices();
  say("gateway devices:", list);
  const requestId = (first.outcome.details as { requestId?: string } | undefined)?.requestId;
  const pending = "pending" in list ? list.pending.filter((p) => p.requestId === requestId) : [];
  say("pending requests for A:", pending.length);
  if (!requestId) return;
  const approved = inst.runner.runSync(["devices", "approve", requestId]);
  say(`devices approve <A's request>: exit ${approved.status}`, `${approved.stdout}`.trim().split("\n").at(-1));
  const retry = await connect(a, FULL, { shared: true });
  say("A connects again:", retry.outcome);
  const later = await connect(a, FULL, { shared: false });
  say("A reconnects with its device token alone:", later.outcome);
  // Keep A for `inapp`, in this process only.
  return a;
}

async function inapp() {
  const a = await remote();
  if (!a) return;
  const watcher = await connect(a, FULL, { shared: false, keep: true });
  say("A watches, connected with its device token:", watcher.outcome);

  const b = newDevice("B-phone");
  const bFirst = await connect(b, FULL, { shared: true });
  say("B asks for all six:", bFirst.outcome);
  await sleep(500);
  say("A heard:", watcher.events.map((e) => e.event));
  const requested = watcher.events.find((e) => e.event === "device.pair.requested");
  say("device.pair.requested payload:", requested?.payload);
  const listed = await call(watcher, "device.pair.list", {});
  const pend = (listed.result as { pending?: Array<Record<string, unknown>> } | undefined)?.pending ?? [];
  say("A's device.pair.list pending:", pend.map((p) => ({ requestId: p.requestId, displayName: p.displayName, platform: p.platform, clientId: p.clientId, clientMode: p.clientMode, roles: p.roles, scopes: p.scopes, remoteIp: p.remoteIp, isRepair: p.isRepair, keys: Object.keys(p) })));
  const bRequest = (bFirst.outcome.details as { requestId?: string } | undefined)?.requestId;
  say("A approves B:", await call(watcher, "device.pair.approve", { requestId: bRequest }));
  await sleep(300);
  say("A heard after approving:", watcher.events.map((e) => e.event));
  say("device.pair.resolved payload:", watcher.events.find((e) => e.event === "device.pair.resolved")?.payload);
  say("B connects again:", (await connect(b, FULL, { shared: true })).outcome);
  say("A approves B's request a second time:", await call(watcher, "device.pair.approve", { requestId: bRequest }));

  const c = newDevice("C-unknown");
  const cFirst = await connect(c, FULL, { shared: true });
  const cRequest = (cFirst.outcome.details as { requestId?: string } | undefined)?.requestId;
  say("A rejects C:", await call(watcher, "device.pair.reject", { requestId: cRequest }));
  say("C connects again:", (await connect(c, FULL, { shared: true })).outcome);

  // A device that holds pairing without admin.
  const p = newDevice("P-pairing-only");
  const pFirst = await connect(p, ["operator.read", "operator.pairing"], { shared: true });
  const pRequest = (pFirst.outcome.details as { requestId?: string } | undefined)?.requestId;
  say("A approves P (read + pairing):", await call(watcher, "device.pair.approve", { requestId: pRequest }));
  await connect(p, ["operator.read", "operator.pairing"], { shared: true });
  const pSession = await connect(p, ["operator.read", "operator.pairing"], { shared: false, keep: true });
  say("P connects with its device token:", pSession.outcome);
  const d = newDevice("D-another");
  const dFirst = await connect(d, FULL, { shared: true });
  const dRequest = (dFirst.outcome.details as { requestId?: string } | undefined)?.requestId;
  await sleep(500);
  say("P heard:", pSession.events.map((e) => e.event));
  say("P lists pending:", await call(pSession, "device.pair.list", {}).then((r) => (r.ok ? { pending: (r.result as { pending: unknown[] }).pending.length } : r)));
  say("P approves D:", await call(pSession, "device.pair.approve", { requestId: dRequest }));
  const dRead = newDevice("D-read");
  const drFirst = await connect(dRead, ["operator.read"], { shared: true });
  const drRequest = (drFirst.outcome.details as { requestId?: string } | undefined)?.requestId;
  say("P approves a read-only request of another device:", await call(pSession, "device.pair.approve", { requestId: drRequest }));
  say("A approves D:", await call(watcher, "device.pair.approve", { requestId: dRequest }));
  say("A rejects the read-only request:", await call(watcher, "device.pair.reject", { requestId: drRequest }));
  await pSession.client.stopAndWait().catch(() => {});
  await watcher.client.stopAndWait().catch(() => {});
}

async function repair() {
  says();
  const f = newDevice("F-read-first");
  const first = await connect(f, ["operator.read"], { shared: true });
  say("F pairs asking for read:", first.outcome);
  const firstRequest = (first.outcome.details as { requestId?: string } | undefined)?.requestId;
  if (firstRequest) {
    const approved = inst.runner.runSync(["devices", "approve", firstRequest]);
    say(`devices approve <F's read request>: exit ${approved.status}`);
    say("F connects again:", (await connect(f, ["operator.read"], { shared: true })).outcome);
  }
  say("F with its device token, asking for all six:", (await connect(f, FULL, { shared: false })).outcome);
  say("F presents the shared token, asking for all six:", (await connect(f, FULL, { shared: true })).outcome);
  say("F with its device token afterwards, asking for all six:", (await connect(f, FULL, { shared: false })).outcome);
  say("gateway devices:", devices());
}

/** Redeem a bootstrap token as a new device, asking for `scopes`. */
function redeem(device: Device, bootstrapToken: string, scopes: string[]) {
  secrets.push(bootstrapToken);
  return new Promise<Record<string, unknown>>((resolve) => {
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
      clientDisplayName: `Clawtrate research ${device.label}`,
      clientVersion: "0.0.0-research",
      platform: "ios",
      role: "operator",
      scopes,
      caps: ["tool-events"],
      minProtocol: 4,
      maxProtocol: 4,
      deviceIdentity: device.identity,
      hostDeps: {
        signDevicePayload: (pem: string, payload: string) =>
          sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
        publicKeyRawBase64UrlFromPem: (pem: string) =>
          createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
        loadDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) => device.tokens[`${deviceId}:${role}`],
        storeDeviceAuthToken: (rec: { deviceId: string; role: string; token: string }) => {
          secrets.push(rec.token);
          device.tokens[`${rec.deviceId}:${rec.role}`] = rec;
        },
        clearDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) => delete device.tokens[`${deviceId}:${role}`],
      },
      onHelloOk: (hello: { auth?: { role?: string; scopes?: string[] } }) =>
        finish({ outcome: "hello", role: hello.auth?.role, scopes: hello.auth?.scopes }),
      onConnectError: (error: Error & { details?: Record<string, unknown>; code?: string }) =>
        finish({ outcome: "refused", message: error.message, code: error.code, details: error.details }),
    } as never);
    client.start();
    setTimeout(() => finish({ outcome: "no answer in 15 s" }), 15_000);
  });
}

/** After `remote`: A makes a setup code through the gateway method; a new device redeems it. */
async function code() {
  const a = await remote();
  if (!a) return;
  const watcher = await connect(a, FULL, { shared: false, keep: true });
  for (const profile of [undefined, "limited"] as const) {
    watcher.events.length = 0;
    const made = await call(watcher, "device.pair.setupCode", {
      publicUrl: url,
      includeQr: false,
      ...(profile ? { bootstrapProfile: profile } : {}),
    });
    const result = made.result as Record<string, unknown> & { setupCode?: string; setupId?: string };
    if (!made.ok || !result.setupCode) {
      say(`setupCode (${profile ?? "default"}) refused:`, made);
      continue;
    }
    secrets.push(result.setupCode);
    const payload = JSON.parse(Buffer.from(result.setupCode, "base64url").toString("utf8")) as { bootstrapToken: string; url: string; expiresAtMs: number };
    say(`A makes a ${profile ?? "default"} code:`, { keys: Object.keys(result), access: result.access, urlSource: result.urlSource, url: payload.url, livesSeconds: Math.round((payload.expiresAtMs - Date.now()) / 1000) });
    const phone = newDevice(`phone-${profile ?? "full"}`);
    const first = await redeem(phone, payload.bootstrapToken, FULL);
    say("a new device redeems it asking for all six:", first);
    await sleep(500);
    say("A heard:", watcher.events.map((e) => ({ event: e.event, keys: Object.keys(e.payload as object) })));
    say("setupStatus:", await call(watcher, "device.pair.setupStatus", { setupId: result.setupId }));
    const requestId = (first.details as { requestId?: string } | undefined)?.requestId;
    if (requestId) {
      say("A approves it:", (await call(watcher, "device.pair.approve", { requestId })).ok);
      await sleep(300);
      say("A heard:", watcher.events.map((e) => e.event));
      say("setupStatus after approval:", await call(watcher, "device.pair.setupStatus", { setupId: result.setupId }));
      say("the device retries with the same code:", await redeem(phone, payload.bootstrapToken, FULL));
      say("the device with its device token:", (await connect(phone, FULL, { shared: false })).outcome);
    }
  }
  await watcher.client.stopAndWait().catch(() => {});
}

const experiments: Record<string, () => Promise<unknown>> = { local, remote, inapp, repair, code };
if (!experiment || !experiments[experiment]) {
  console.log(`usage: full-scope-probe.ts <${Object.keys(experiments).join("|")}> --instance <name>`);
  process.exit(1);
}
await experiments[experiment]!();
setTimeout(() => process.exit(0), 300);
