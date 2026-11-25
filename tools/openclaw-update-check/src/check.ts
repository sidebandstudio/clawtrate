// The real OpenClaw update check: connects to a gateway on a GitHub-hosted runner as an admin
// operator, calls `update.run` as Clawtrate does (a `webchat` requester with a tag of its own), follows the run across the gateway's restart
// and judges it (record.ts). It refuses to run anywhere else.
//
//   node tools/openclaw-update-check/src/check.ts --url ws://127.0.0.1:<port> \
//     --profile clawtrate-dev-<name> --mode <name> --out <dir> [--expect updated|unmanaged] \
//     [--busy-seconds <n>] [--second-press] [--reopen] [--untagged] [--drop-answer]
//     [--await-campaign] [--warm-session] [--measure]
//
// The gateway's shared token comes from OPENCLAW_CHECK_TOKEN. The first connect is refused with
// PAIRING_REQUIRED; the request is approved by id with the profile's own `devices approve`, as
// the development gateway tool does, and the client connects again with the scopes it asked for.
//
// --busy-seconds starts a chat turn on the scripted model (`#slow <n>`) just before the press, so
// the gateway has work in flight when the update drains it. --second-press sends another
// `update.run` once the first is answered. --reopen closes the client and opens it again while
// the run validates. After the run finishes the check keeps listening until terminal
// `update.run.changed` events stop for 30 s, or --listen-minutes pass.
// --measure writes the verdict to the run's summary and exits 0 whatever it says.

import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { GatewayClient, type DeviceIdentity } from "@openclaw/gateway-client";
import {
  STATUS_DONE,
  describe,
  judge,
  readRun,
  refusalToRun,
  summary,
  timeline,
  type Entry,
  type Plan,
} from "./record.ts";

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    profile: { type: "string" },
    mode: { type: "string", default: "unknown" },
    out: { type: "string" },
    expect: { type: "string", default: "updated" },
    "busy-seconds": { type: "string", default: "0" },
    "second-press": { type: "boolean", default: false },
    reopen: { type: "boolean", default: false },
    untagged: { type: "boolean", default: false },
    "drop-answer": { type: "boolean", default: false },
    "await-campaign": { type: "boolean", default: false },
    "warm-session": { type: "boolean", default: false },
    measure: { type: "boolean", default: false },
    "deadline-minutes": { type: "string", default: "20" },
    "listen-minutes": { type: "string", default: "5" },
  },
});
const url = values.url ?? "";
const profile = values.profile ?? "";
const out = values.out ?? "";
const mode = values.mode ?? "unknown";
const token = process.env.OPENCLAW_CHECK_TOKEN ?? "";
const refusal = refusalToRun(process.env, profile);
if (refusal) throw new Error(refusal);
if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(url) || !out || !token) {
  throw new Error(
    "usage: --url ws://127.0.0.1:<port> --profile <p> --out <dir>, token in OPENCLAW_CHECK_TOKEN",
  );
}
if (values.expect !== "updated" && values.expect !== "unmanaged") {
  throw new Error("--expect is updated or unmanaged");
}
const busySeconds = Number(values["busy-seconds"]);
const BUSY_SESSION = "agent:main:main";
/** Clawtrate tags each press so its run can be found by the tag (PR #569). */
const TAG_PREFIX = "clawtrate-update:";
const press = (): JsonRecord =>
  values.untagged
    ? {}
    : { requester: { channel: "webchat", senderId: `${TAG_PREFIX}${randomUUID()}` } };
const plan: Plan = {
  expect: values.expect,
  ...(values.untagged ? {} : { requesterPrefix: TAG_PREFIX }),
  ...(values["drop-answer"] ? { dropAnswer: true } : {}),
  ...(values["await-campaign"] ? { campaign: true } : {}),
  ...(values["second-press"] ? { secondPress: true } : {}),
  ...(values.reopen ? { reopen: true } : {}),
  ...(busySeconds > 0 ? { busySession: BUSY_SESSION } : {}),
};
mkdirSync(out, { recursive: true });
const deadline = Date.now() + Number(values["deadline-minutes"]) * 60_000;

const entries: Entry[] = [];
const log = (entry: Entry) => {
  entries.push(entry);
  console.log(`${new Date(entry.at).toISOString()}  ${describe(entry)}`);
};
const note = (line: string) => log({ at: Date.now(), kind: "note", text: line });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A new device key each run, kept in memory, and its device token once paired.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const identity: DeviceIdentity = {
  deviceId: createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }).subarray(-32))
    .digest("hex"),
  publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const tokens = new Map<string, { token: string; scopes: string[] }>();

/** The client whose hello was last received, and the newest one started. */
let client: GatewayClient | null = null;
let started: GatewayClient | null = null;
let connected = false;
/** A close the check causes itself is logged as its own. */
let closingOwn = false;
let hellos = 0;
let pairing: string | null = null;
let paused = false;
let chatDeltas = 0;
/** Whether the busy turn has reached the model. */
let busyStarted = false;
/** Whether a turn in the busy session has ended. */
let turnEnded = false;
let lastTerminalAt = 0;

function connect(): GatewayClient {
  const next: GatewayClient = new GatewayClient({
    url,
    token,
    clientName: "gateway-client",
    mode: "ui",
    clientDisplayName: "Clawtrate update check",
    clientVersion: "0.0.0",
    platform: process.platform,
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
    minProtocol: 4,
    maxProtocol: 4,
    deviceIdentity: identity,
    hostDeps: {
      signDevicePayload: (pem, payload) =>
        sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
      publicKeyRawBase64UrlFromPem: (pem) =>
        createPublicKey(pem)
          .export({ type: "spki", format: "der" })
          .subarray(-32)
          .toString("base64url"),
      loadDeviceAuthToken: ({ deviceId, role }) => tokens.get(`${deviceId}:${role}`) ?? null,
      storeDeviceAuthToken: ({ deviceId, role, token: deviceToken, scopes }) => {
        tokens.set(`${deviceId}:${role}`, { token: deviceToken, scopes });
      },
      clearDeviceAuthToken: ({ deviceId, role }) => {
        tokens.delete(`${deviceId}:${role}`);
      },
    },
    onHelloOk: (hello) => {
      const record = asRecord(hello);
      const snapshot = asRecord(record.snapshot);
      const version = asRecord(record.server).version;
      log({
        at: Date.now(),
        kind: "hello",
        serverVersion: typeof version === "string" ? version : null,
        updateAvailable: snapshot.updateAvailable ?? null,
        uptimeMs: typeof snapshot.uptimeMs === "number" ? snapshot.uptimeMs : null,
      });
      client = next;
      connected = true;
      hellos += 1;
    },
    onClose: (code, reason) => {
      if (connected) {
        log({ at: Date.now(), kind: "close", code, reason, ...(closingOwn ? { own: true } : {}) });
      }
      connected = false;
    },
    onEvent: (frame) => {
      if (frame.event === "tick" || frame.event === "health" || frame.event === "agent") return;
      const payload = asRecord(frame.payload);
      // A streamed reply sends a delta every few milliseconds: keep the first and count the rest.
      if (
        frame.event === "chat" &&
        payload.sessionKey === BUSY_SESSION &&
        (payload.phase === "starting_model" || payload.state === "delta")
      ) {
        busyStarted = true;
      }
      if (
        frame.event === "chat" &&
        payload.sessionKey === BUSY_SESSION &&
        ["final", "aborted", "error"].includes(String(payload.state))
      ) {
        turnEnded = true;
      }
      if (frame.event === "chat" && payload.state === "delta") {
        chatDeltas += 1;
        if (chatDeltas > 1) return;
      }
      if (
        frame.event === "update.run.changed" &&
        typeof payload.status === "string" &&
        STATUS_DONE.has(payload.status)
      ) {
        lastTerminalAt = Date.now();
      }
      log({ at: Date.now(), kind: "event", event: frame.event, payload: frame.payload });
    },
    onConnectError: (error) => {
      const details = asRecord((error as { details?: unknown }).details);
      if (details.code === "PAIRING_REQUIRED" && typeof details.requestId === "string") {
        pairing = details.requestId;
      }
    },
    onReconnectPaused: () => {
      paused = true;
    },
  });
  started = next;
  next.start();
  return next;
}

/** Stop the newest client, and with it its reconnects. */
async function stopStarted(): Promise<void> {
  await started?.stopAndWait({ timeoutMs: 5_000 }).catch(() => {});
}

/** Wait for the next hello, up to a limit. */
async function nextHello(limitMs: number): Promise<boolean> {
  const seen = hellos;
  const until = Date.now() + limitMs;
  while (hellos === seen && !paused && Date.now() < until) await sleep(100);
  return hellos !== seen;
}

/** Connect, approving this device's own pairing request once. */
async function open(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    paused = false;
    pairing = null;
    const attemptClient = connect();
    if (await nextHello(60_000)) return;
    await attemptClient.stopAndWait({ timeoutMs: 5_000 }).catch(() => {});
    if (!pairing) throw new Error("the gateway refused the connection without a pairing request");
    note(`approving pairing request ${pairing}`);
    execFileSync("openclaw", ["--profile", profile, "devices", "approve", pairing], {
      stdio: "inherit",
    });
  }
  throw new Error("still not paired after approving the request");
}

/** A request, logged with its answer or refusal. Returns undefined when refused or not sent. */
async function call(method: string, params: JsonRecord = {}, timeoutMs = 30_000) {
  const current = client;
  if (!current || !connected) return undefined;
  log({ at: Date.now(), kind: "sent", method, params });
  try {
    const result = await current.request(method, params, { timeoutMs });
    log({ at: Date.now(), kind: "answer", method, result });
    return asRecord(result);
  } catch (error) {
    const failure = error as { code?: unknown; message?: unknown };
    log({
      at: Date.now(),
      kind: "refused",
      method,
      code: typeof failure.code === "string" ? failure.code : "ERROR",
      message: String(failure.message ?? error),
    });
    return undefined;
  }
}

/**
 * Work in flight: a slow reply from the scripted model. Its reasoning sends no chat delta, so the
 * turn counts as started once it reaches the model.
 */
async function startBusyTurn(): Promise<void> {
  await call("chat.send", {
    sessionKey: BUSY_SESSION,
    message: `#slow ${busySeconds} Please take your time.`,
    idempotencyKey: randomUUID(),
  });
  const until = Date.now() + 60_000;
  while (!busyStarted && Date.now() < until) await sleep(250);
  note(busyStarted ? "the turn reached the model" : "the turn did not reach the model in a minute");
}

/** Send `update.run`, close the connection at once, reconnect and find the run by its tag. */
async function pressAndDrop(params: JsonRecord): Promise<string | null> {
  const current = client as GatewayClient | null;
  if (!current) return null;
  log({ at: Date.now(), kind: "sent", method: "update.run", params });
  /** Set once the check starts closing: a rejection after that is the close's, not the gateway's. */
  let closing = false;
  current.request("update.run", params, { timeoutMs: 120_000 }).then(
    (result) => log({ at: Date.now(), kind: "answer", method: "update.run", result }),
    (error: unknown) => {
      if (closing) {
        note(`update.run answer lost when the check closed the connection: ${String(error)}`);
        return;
      }
      const failure = error as { code?: unknown; message?: unknown };
      log({
        at: Date.now(),
        kind: "refused",
        method: "update.run",
        code: typeof failure.code === "string" ? failure.code : "ERROR",
        message: String(failure.message ?? error),
      });
    },
  );
  await sleep(50);
  note("closing the connection before the answer");
  closing = true;
  closingOwn = true;
  await stopStarted();
  closingOwn = false;
  connect();
  if (!(await nextHello(60_000))) return null;
  await call("gateway.identity.get");
  const tag = asRecord(params.requester).senderId;
  const tagged = (run: unknown) =>
    asRecord(asRecord(asRecord(run).origin).requester).senderId === tag;
  const status = await call("update.status");
  for (const key of ["activeRun", "lastRun"]) {
    const run = asRecord(status?.[key]);
    if (tagged(run) && typeof run.runId === "string") {
      note(`found the run by its tag in update.status ${key}`);
      return run.runId;
    }
  }
  const listed = await call("update.runs.list", { limit: 20 });
  const runs: unknown[] = Array.isArray(listed?.runs) ? listed.runs : [];
  const found = runs.map(asRecord).find(tagged);
  note(found ? "found the run by its tag in update.runs.list" : "no run carries the tag");
  return typeof found?.runId === "string" ? found.runId : null;
}

let runId: string | null = null;
try {
  await open();
  await call("gateway.identity.get");

  // With a campaign, the turn starts first, so the campaign waits for it instead of applying.
  if (plan.campaign) await startBusyTurn();

  // The startup check fills updateAvailable a few seconds after the gateway starts. A gateway
  // that can't update itself may never report one; the refusal is what that check looks for.
  const offerUntil = Date.now() + (plan.expect === "updated" ? 3 * 60_000 : 30_000);
  for (;;) {
    const status = await call("update.status");
    if (asRecord(status?.updateAvailable).latestVersion) break;
    if (Date.now() > offerUntil) {
      note("update.status reported no newer version within its wait");
      break;
    }
    await sleep(5_000);
  }

  if (values["warm-session"]) {
    // The main session exists but is idle at the press: one short turn, finished first.
    await call("chat.send", {
      sessionKey: BUSY_SESSION,
      message: "Hello.",
      idempotencyKey: randomUUID(),
    });
    const until = Date.now() + 120_000;
    while (!turnEnded && Date.now() < until) await sleep(250);
    note(turnEnded ? "the short turn ended" : "the short turn did not end in two minutes");
  }
  if (busySeconds > 0 && !plan.campaign) await startBusyTurn();
  if (plan.campaign) {
    // Press while the gateway's own automatic update is announced and waiting for the turn.
    const until = Date.now() + 5 * 60_000;
    for (;;) {
      const status = await call("update.status");
      if (asRecord(status?.schedule).campaign) break;
      if (Date.now() > until) {
        note("no automatic-update campaign was announced within five minutes");
        break;
      }
      await sleep(5_000);
    }
  }

  // What the gateway's sessions look like before, to see whether the run delivers anything.
  await call("sessions.list", { limit: 100, includeLastMessage: true });

  // Check the case's setup once more, right before the press: a busy case needs its turn running,
  // a warm one its short turn finished. Otherwise nothing is sent and the case says so.
  if (busySeconds > 0 && !busyStarted) plan.notExercised = "the turn never reached the model";
  else if (busySeconds > 0 && turnEnded) plan.notExercised = "the turn ended before the press";
  else if (values["warm-session"] && !turnEnded) {
    plan.notExercised = "the short turn had not ended before the press";
  }
  if (plan.notExercised !== undefined) note(`not pressing: ${plan.notExercised}`);

  const params = press();
  if (plan.notExercised !== undefined) {
    // No press.
  } else if (plan.dropAnswer) {
    runId = await pressAndDrop(params);
  } else {
    const answer = await call("update.run", params, 120_000);
    runId = typeof answer?.runId === "string" ? answer.runId : null;
  }
  note(`following run ${runId}`);
  if (plan.secondPress && plan.notExercised === undefined) {
    await call("update.run", press(), 120_000);
  }

  // Follow the run: events arrive by themselves; read the record every 2 s while connected, and
  // read identity and update.status on each new connection.
  let seenHellos = hellos;
  let reopened = false;
  while (runId !== null && Date.now() < deadline) {
    await sleep(2_000);
    if (paused) {
      // The client stopped retrying (a close it treats as final): start a new one, same device.
      paused = false;
      note("the client stopped reconnecting; starting a new one");
      await stopStarted();
      connect();
    }
    if (!connected) continue;
    if (hellos !== seenHellos) {
      seenHellos = hellos;
      await call("gateway.identity.get");
      await call("update.status");
    }
    const got = await call("update.runs.get", { runId }, 10_000);
    const run = got ? readRun(got.run) : null;
    if (run?.status && run.status !== "running") break;
    if (plan.reopen && !reopened && run?.phase === "validating") {
      // As if Clawtrate were closed and opened again mid-run: a new connection, same device.
      reopened = true;
      note("closing the client and opening it again");
      closingOwn = true;
      await stopStarted();
      closingOwn = false;
      connect();
      if (await nextHello(30_000)) {
        seenHellos = hellos;
        await call("gateway.identity.get");
        await call("update.status");
      }
    }
  }
  if (Date.now() >= deadline) note("the deadline passed before the run finished");

  // The gateway can rebroadcast the terminal state: listen until it has been quiet for 30 s.
  const listenUntil = Date.now() + Number(values["listen-minutes"]) * 60_000;
  lastTerminalAt = Math.max(lastTerminalAt, Date.now());
  while (Date.now() < listenUntil && Date.now() - lastTerminalAt < 30_000) await sleep(1_000);
  if (Date.now() >= listenUntil) note("terminal events were still arriving when listening ended");
  // Read identity on the connection whose hello is judged, the runs by tag, and the sessions.
  if (connected) {
    await call("gateway.identity.get");
    await call("update.runs.list", { limit: 20 });
    const sessions = await call("sessions.list", { limit: 100, includeLastMessage: true });
    const keys = (Array.isArray(sessions?.sessions) ? sessions.sessions : [])
      .map((item) => asRecord(item).key)
      .filter((key): key is string => typeof key === "string");
    for (const sessionKey of keys.slice(0, 5))
      await call("chat.history", { sessionKey, limit: 40 });
  }
} catch (error) {
  note(`stopped: ${error instanceof Error ? error.message : String(error)}`);
}
// Our own close is not the gateway's.
connected = false;
await stopStarted();

const verdict = judge(entries, runId, plan);
const lines = timeline(entries);
writeFileSync(join(out, "timeline.txt"), `${lines.join("\n")}\n`);
writeFileSync(
  join(out, "result.json"),
  `${JSON.stringify({ mode, plan, runId, chatDeltas, verdict, entries }, null, 2)}\n`,
);
// A measuring job records its verdict without failing: its outcome depends on timing (#572).
const report = summary(verdict, values.measure ? `${mode}, measured, not a gate` : mode);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(`\n${lines.join("\n")}\n\n${report}`);
process.exitCode = verdict.passed || values.measure ? 0 : 1;
