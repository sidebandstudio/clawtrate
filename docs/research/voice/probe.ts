// Probes behind docs/research/voice.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name>
//   node docs/research/voice/probe.ts <experiment> --instance <name> [...]
//
// It acts only on a named development instance this checkout started, reads
// that instance's address and token from the tool's own run files, and runs
// `openclaw` only through the tool's guarded runner (so always with
// `--profile clawtrate-dev-<name>`). Every line it prints passes through
// `redact`. It sends no audio: the only audio-shaped value it sends is a
// buffer of zeros, to a session id the gateway does not have. A development
// gateway has no voice provider and sends everything beyond loopback to its
// scripted model, which refuses it.
//
// Experiments:
//   pair     --data <dir>: this project's client connects with the shared token
//            and the gateway's own `devices approve <requestId>` approves it
//   upgrade  --data <dir>: the same device asks for the interactive tier
//   methods  --data <dir> --label <text>: on that device, whatever it holds,
//            whether each voice method and event is advertised in hello-ok,
//            then each method called with valid and invalid parameters

import { mkdirSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { ClawtrateClient } from "../../../packages/core/src/client.ts";
import { createNodeHost } from "../../../packages/core/src/node/index.ts";
import { openInstance, readDevConnection } from "../../../tools/dev-gateway/src/cli.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    instance: { type: "string" },
    data: { type: "string" },
    label: { type: "string", default: "device" },
    max: { type: "string", default: "900" },
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
  return out.replace(/("(?:token|deviceToken|bootstrapToken|publicKey|clientSecret)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const max = Number(values.max);
const say = (...parts: unknown[]) => {
  const line = redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  console.log(line.length > max ? `${line.slice(0, max)} …(${line.length} chars)` : line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function coreClient(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return new ClawtrateClient(
    createNodeHost({
      dataDir: dir,
      client: { displayName: "Clawtrate Desktop", version: "0.0.0-research", platform: process.platform },
    }),
    { reconnect: { initialMs: 500, maxMs: 2000 } },
  );
}

async function settle(done: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await sleep(100);
}

type Request = (m: string, p: unknown) => Promise<unknown>;
type Hello = { features?: { methods?: string[]; events?: string[] } };

async function device(dir: string, label: string) {
  const client = coreClient(dir);
  const hellos: Hello[] = [];
  const events: { event: string; payload: unknown }[] = [];
  const target = client as unknown as {
    handleHello(h: Hello, g: number): void;
    handleEvent(e: { event: string; payload?: unknown }, g: number): void;
  };
  const originalHello = target.handleHello.bind(client);
  target.handleHello = (hello, generation) => {
    hellos.push(hello);
    originalHello(hello, generation);
  };
  const originalEvent = target.handleEvent.bind(client);
  target.handleEvent = (event, generation) => {
    if (event.event.startsWith("talk.") || event.event.startsWith("tts.")) events.push({ event: event.event, payload: event.payload });
    originalEvent(event, generation);
  };
  await client.start();
  await settle(() => client.state.connection.status === "connected");
  if (client.state.connection.status !== "connected") throw new Error(`${label} not connected`);
  const request = (client as unknown as { request: Request }).request.bind(client);
  say(`${label}: connected with`, client.state.connection.scopes);
  return { label, client, request, hellos, events };
}

async function attempt(request: Request, method: string, params: unknown) {
  try {
    return { ok: true, result: await request(method, params) };
  } catch (error) {
    const e = error as Error & { code?: string; details?: unknown };
    return { ok: false, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
  }
}

async function pair() {
  if (!values.data) throw new Error("--data is required");
  const client = coreClient(values.data);
  await client.start();
  await client.connect({ url, token: connection!.token });
  await settle(() => ["connected", "pairing", "error"].includes(client.state.connection.status));
  const requestId = client.state.connection.pairing?.requestId;
  if (requestId) {
    const approved = inst.runner.runSync(["devices", "approve", requestId]);
    say(`devices approve <request>: exit ${approved.status}`);
    await settle(() => client.state.connection.status === "connected", 20_000);
  }
  say("paired:", { status: client.state.connection.status, scopes: client.state.connection.scopes });
  client.stop();
}

async function upgrade() {
  if (!values.data) throw new Error("--data is required");
  const client = coreClient(values.data);
  await client.start();
  await settle(() => client.state.connection.status === "connected");
  const asked = client.requestAccess("interactive").catch((e: unknown) => say("requestAccess:", String(e)));
  await settle(() => !["idle", "requesting"].includes(client.state.connection.upgrade.status), 10_000);
  const requestId = client.state.connection.upgrade.requestId;
  if (requestId) {
    const approved = inst.runner.runSync(["devices", "approve", requestId]);
    say(`devices approve <request>: exit ${approved.status}`);
    await settle(() => client.state.connection.canWrite, 20_000);
    await sleep(1500);
  }
  say("after approval:", client.state.connection.scopes);
  void asked;
  client.stop();
}

const METHODS = [
  "talk.catalog",
  "talk.config",
  "talk.session.create",
  "talk.session.appendAudio",
  "talk.session.cancelOutput",
  "talk.session.close",
  "talk.client.create",
  "talk.client.transcript",
  "talk.client.close",
  "talk.voice.get",
  "talk.voice.set",
  "talk.voice.complete",
  "talk.speak",
  "talk.mode",
  "tts.status",
  "tts.providers",
  "tts.convert",
  "tts.speak",
  "transcripts.list",
  "chat.history",
];
const EVENTS = ["talk.event", "talk.mode", "talk.voice.change"];

async function taskKey(d: { request: Request }, name: string) {
  const agents = await attempt(d.request, "agents.list", {});
  const list = ((agents.result as { agents?: { id: string; name?: string; identity?: { name?: string } }[] })?.agents ?? []);
  const agent = list.find((a) => (a.identity?.name ?? a.name ?? a.id).toLowerCase() === name) ?? list[0];
  const agentId = agent?.id ?? name;
  const listed = await attempt(d.request, "sessions.list", { agentId, limit: 5 });
  const rows = ((listed.result as { sessions?: { key: string }[] })?.sessions ?? []).map((s) => s.key);
  return rows.find((k) => k.startsWith(`agent:${agentId}:`)) ?? `agent:${agentId}:main`;
}

async function methods() {
  if (!values.data) throw new Error("--data is required");
  const d = await device(values.data, values.label!);
  const hello = d.hellos.at(-1);
  const advertised = new Set(hello?.features?.methods ?? []);
  const advertisedEvents = new Set(hello?.features?.events ?? []);
  say(
    "advertised methods:",
    Object.fromEntries(METHODS.map((m) => [m, advertised.has(m)])),
    "events:",
    Object.fromEntries(EVENTS.map((e) => [e, advertisedEvents.has(e)])),
  );
  const key = await taskKey(d, "juniper");
  say("task key used: one of Juniper's tasks, agent-prefixed:", key.startsWith("agent:"), key.split(":").length);
  const zeros = Buffer.alloc(480).toString("base64"); // 10 ms of 24 kHz PCM16 silence
  const calls: [string, string, unknown][] = [
    ["talk.catalog", "no params", {}],
    ["talk.config", "no params", {}],
    ["talk.config", "includeSecrets", { includeSecrets: true }],
    ["talk.session.create", "realtime, no key", {}],
    ["talk.session.create", "realtime, Juniper's task", { sessionKey: key }],
    ["talk.session.create", "realtime, Juniper's task, language en, ttlMs 60000", { sessionKey: key, language: "en", ttlMs: 60_000 }],
    ["talk.session.create", "language english (not two letters)", { sessionKey: key, language: "english" }],
    ["talk.session.create", "ttlMs 500 (below 1 s)", { sessionKey: key, ttlMs: 500 }],
    ["talk.session.create", "transport webrtc", { sessionKey: key, transport: "webrtc" }],
    ["talk.session.create", "transcription", { mode: "transcription", transport: "gateway-relay", brain: "none" }],
    ["talk.session.create", "transcription, language en", { mode: "transcription", transport: "gateway-relay", brain: "none", language: "en" }],
    ["talk.session.create", "an unknown field", { sessionKey: key, speed: 1.5 }],
    ["talk.client.create", "Juniper's task", { sessionKey: key }],
    ["talk.client.create", "with language", { sessionKey: key, language: "en" }],
    ["talk.client.create", "with ttlMs", { sessionKey: key, ttlMs: 60_000 }],
    ["talk.client.create", "resume an unknown voiceSessionId", { sessionKey: key, voiceSessionId: randomUUID() }],
    ["talk.session.appendAudio", "an unknown session, 10 ms of zeros", { sessionId: randomUUID(), audioBase64: zeros }],
    ["talk.session.cancelOutput", "an unknown session", { sessionId: randomUUID() }],
    ["talk.session.close", "an unknown session", { sessionId: randomUUID() }],
    ["talk.client.transcript", "an unknown voice session", { sessionKey: key, voiceSessionId: randomUUID(), entryId: "e1", role: "user", text: "probe" }],
    ["talk.client.close", "an unknown voice session", { sessionKey: key, voiceSessionId: randomUUID() }],
    ["talk.voice.get", "no call", {}],
    ["talk.voice.get", "Juniper's task, no call", { sessionKey: key }],
    ["talk.voice.set", "no call", { voice: "marin" }],
    ["talk.voice.set", "Juniper's task, no call", { voice: "marin", sessionKey: key }],
    ["talk.voice.complete", "an unknown change", { changeId: randomUUID() }],
    ["tts.status", "no params", {}],
    ["tts.providers", "no params", {}],
    ["tts.convert", "empty text", { text: "" }],
    ["transcripts.list", "no params", {}],
  ];
  for (const [method, what, params] of calls) {
    const r = await attempt(d.request, method, params);
    say(`${method} (${what}):`, r.ok ? { ok: true, result: r.result } : r.error);
  }
  say("talk.* events received:", d.events);
  d.client.stop();
}

const experiments: Record<string, () => Promise<void>> = { pair, upgrade, methods };
const run = experiment ? experiments[experiment] : undefined;
if (!run) throw new Error(`experiment: one of ${Object.keys(experiments).join(", ")}`);
await run();
process.exit(0);
