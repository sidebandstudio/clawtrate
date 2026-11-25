// Clawtrate's own update engine against a real update, on a GitHub-hosted runner only. A Node host
// runs `ClawtrateClient` from `@clawtrate/core` with a file store and key in a fresh folder, pairs
// and gets admin through the gateway's own approval, and does what the interface does: it opens
// the confirmation (`checkOpenClawUpdate`), then presses Update (`startOpenClawUpdate` with the
// stamp read on its connection). It records every request the client sends and every
// `openclawUpdating` state, and judges them (engine-record.ts). It refuses to run anywhere else.
//
//   node tools/openclaw-update-check/src/engine.ts --url ws://127.0.0.1:<port> \
//     --profile clawtrate-dev-<name> --mode <name> --out <dir> [--drop-answer] [--reopen]
//     [--warm-session] [--measure]
//
// --drop-answer closes the client's socket right after it sends `update.run`. --reopen stops the
// client while the run validates and starts a new one on the same storage, then presses at once.
// --warm-session gives the main bot a main task first, so the gateway's notice has a place to land.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ClawtrateClient,
  createBridgeSession,
  gatewayStamp,
  type BridgeSession,
  type ClawtrateState,
} from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";
import { refusalToRun } from "./record.ts";
import {
  engineSummary,
  judgeEngine,
  type EngineEntry,
  type EnginePlan,
  type EngineView,
} from "./engine-record.ts";

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    profile: { type: "string" },
    mode: { type: "string", default: "engine" },
    out: { type: "string" },
    "drop-answer": { type: "boolean", default: false },
    reopen: { type: "boolean", default: false },
    "warm-session": { type: "boolean", default: false },
    measure: { type: "boolean", default: false },
    reconnects: { type: "string", default: "3" },
    "deadline-minutes": { type: "string", default: "20" },
  },
});
const url = values.url ?? "";
const profile = values.profile ?? "";
const out = values.out ?? "";
const mode = values.mode ?? "engine";
const token = process.env.OPENCLAW_CHECK_TOKEN ?? "";
const refusal = refusalToRun(process.env, profile);
if (refusal) throw new Error(refusal);
if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(url) || !out || !token) {
  throw new Error(
    "usage: --url ws://127.0.0.1:<port> --profile <p> --out <dir>, token in OPENCLAW_CHECK_TOKEN",
  );
}
mkdirSync(out, { recursive: true });
const plan: EnginePlan = {
  reconnects: Number(values.reconnects),
  ...(values["drop-answer"] ? { dropAnswer: true } : {}),
  ...(values.reopen ? { reopen: true } : {}),
};
const deadline = Date.now() + Number(values["deadline-minutes"]) * 60_000;
const MAIN = "agent:main:main";
const DISPLAY_NAME = "Clawtrate update engine check";

const entries: EngineEntry[] = [];
const push = (entry: EngineEntry) => {
  entries.push(entry);
  if (entry.kind !== "state" || process.env.ENGINE_VERBOSE) {
    console.log(`${new Date(entry.at).toISOString()}  ${JSON.stringify(entry).slice(0, 400)}`);
  }
};
const mark = (name: string, detail?: string) =>
  push({ at: Date.now(), kind: "mark", name, ...(detail ? { detail } : {}) });
const note = (text: string) => push({ at: Date.now(), kind: "note", text });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Requests whose parameters are kept: none carry a credential. */
const KEEP_PARAMS = /^(update\.|models\.list$|gateway\.identity\.get$|chat\.history$)/;

// The client's sockets, each wrapped to record what it sends and receives.
let sockets = 0;
let current: { close(): void } | null = null;
/** Close the client's newest socket, as a network drop does. */
const dropSocket = () => (current as { close(): void } | null)?.close();
let dropOnUpdateRun = false;
let hellos = 0;
let mainTurnEnded = false;
const methods = new Map<string, string>();

function makeClient(dataDir: string): { client: ClawtrateClient; bridge: BridgeSession } {
  const base = createNodeHost({
    dataDir,
    client: { displayName: DISPLAY_NAME, version: "0.0.0", platform: process.platform },
    log: (level, message) => {
      if (level !== "debug") note(`client ${level}: ${message.slice(0, 300)}`);
    },
  });
  const host = {
    ...base,
    createWebSocket: (address: string) => {
      const ws = base.createWebSocket(address);
      const socket = ++sockets;
      current = ws;
      const send = ws.send.bind(ws);
      ws.send = (data: string) => {
        let frame: JsonRecord = {};
        try {
          frame = asRecord(JSON.parse(data));
        } catch {
          // Not JSON: nothing to record.
        }
        const method = typeof frame.method === "string" ? frame.method : null;
        if (frame.type === "req" && method !== null && typeof frame.id === "string") {
          methods.set(`${socket}:${frame.id}`, method);
          push({
            at: Date.now(),
            kind: "sent",
            socket,
            id: frame.id,
            method,
            params: KEEP_PARAMS.test(method) ? (frame.params ?? null) : null,
          });
        }
        send(data);
        if (method === "update.run" && dropOnUpdateRun) {
          // The answer is lost: the socket closes right after the press goes out.
          dropOnUpdateRun = false;
          mark("dropped");
          ws.close();
        }
      };
      (ws as unknown as EventTarget).addEventListener("message", (event) => {
        let frame: JsonRecord;
        try {
          frame = asRecord(JSON.parse(String((event as MessageEvent).data)));
        } catch {
          return;
        }
        if (frame.type === "res" && typeof frame.id === "string") {
          const method = methods.get(`${socket}:${frame.id}`);
          const ok = frame.ok === true;
          const payload =
            method && KEEP_PARAMS.test(method) ? (frame.payload ?? frame.error) : null;
          push({ at: Date.now(), kind: "answer", socket, id: frame.id, ok, payload });
          if (method === "connect" && ok) {
            hellos += 1;
            push({ at: Date.now(), kind: "hello", socket });
          }
        } else if (frame.type === "event" && typeof frame.event === "string") {
          const payload = asRecord(frame.payload);
          if (
            frame.event === "chat" &&
            payload.sessionKey === MAIN &&
            ["final", "error", "aborted"].includes(String(payload.state))
          ) {
            mainTurnEnded = true;
          }
          if (["tick", "health", "agent", "presence"].includes(frame.event)) return;
          if (frame.event === "chat" && payload.state === "delta") return;
          push({
            at: Date.now(),
            kind: "event",
            socket,
            event: frame.event,
            payload: frame.payload,
          });
        }
      });
      return ws;
    },
  };
  const client = new ClawtrateClient(host);
  let last = "";
  client.store.subscribe((state: ClawtrateState) => {
    const view = viewOf(state);
    const json = JSON.stringify(view);
    if (json === last) return;
    last = json;
    push({ at: Date.now(), kind: "state", view });
  });
  return { client, bridge: createBridgeSession(client) };
}

function viewOf(state: ClawtrateState): EngineView {
  const c = state.connection;
  const u = state.openclawUpdating;
  const run = u?.run ?? null;
  return {
    status: c.status,
    gatewayId: c.gatewayId,
    serverVersion: c.serverVersion,
    canAdmin: c.canAdmin,
    offer: c.openclawUpdate?.latest ?? null,
    run: run
      ? {
          runId: run.runId,
          gatewayId: run.gatewayId,
          mine: run.mine,
          phase: run.phase,
          outcome: run.outcome,
          from: run.from,
          to: run.to,
          reported: run.reported,
        }
      : null,
    starting: u?.starting ?? false,
    looking: u?.looking ?? false,
    error: u?.error ?? null,
  };
}

/** Approve every pending request of this check's device, with the profile's own command. */
function approvePending(): number {
  const listed = asRecord(
    JSON.parse(
      execFileSync("openclaw", ["--profile", profile, "devices", "list", "--json"], {
        encoding: "utf8",
      }),
    ),
  );
  const pending = (Array.isArray(listed.pending) ? listed.pending : [])
    .map(asRecord)
    .filter(
      (request) => request.displayName === DISPLAY_NAME && typeof request.requestId === "string",
    );
  for (const request of pending) {
    execFileSync(
      "openclaw",
      ["--profile", profile, "devices", "approve", String(request.requestId)],
      {
        stdio: "inherit",
      },
    );
    note(`approved request ${String(request.requestId)}`);
  }
  return pending.length;
}

/** Wait until `ready` holds, approving pending requests meanwhile. */
async function until(
  what: string,
  ready: () => boolean,
  limitMs: number,
  approve = false,
): Promise<void> {
  const end = Date.now() + limitMs;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`${what} did not happen within ${limitMs / 1000} s`);
    if (approve) approvePending();
    await sleep(approve ? 2_000 : 200);
  }
}

const dataDir = join(out, "client-data");
let { client, bridge } = makeClient(dataDir);
const state = () => client.state;
const connected = () => state().connection.status === "connected";
const admin = () => connected() && state().connection.canAdmin;
const notice: unknown[] = [];

try {
  await client.start();
  await bridge.apply({ type: "connect", url, token });
  await until("pairing", connected, 120_000, true);
  void bridge.apply({ type: "requestAccess", tier: "admin" }).catch((error: unknown) => {
    note(`requestAccess: ${String(error)}`);
  });
  await until("admin access", admin, 120_000, true);
  note(`connected with admin; scopes ${state().connection.scopes.join(" ")}`);

  if (values["warm-session"]) {
    // The main bot's main task exists before the update, idle at the press.
    await bridge.apply({ type: "openSession", key: MAIN });
    await bridge.apply({
      type: "sendMessage",
      key: MAIN,
      text: "Hello.",
      mode: "auto",
      attachmentIds: [],
    });
    await until("the main task's first turn", () => mainTurnEnded, 120_000);
    await sleep(3_000);
  }

  // Plain reconnects: nothing about updating may be asked.
  for (let i = 0; i < plan.reconnects; i += 1) {
    const seen = hellos;
    mark("reconnect");
    dropSocket();
    await until("a reconnect", () => hellos > seen && admin(), 120_000);
    await sleep(5_000);
    mark("reconnected");
  }

  await until(
    "the gateway's offer of a newer OpenClaw",
    () => state().connection.openclawUpdate !== null,
    180_000,
  );
  note(`offered ${state().connection.openclawUpdate?.latest}`);

  // The confirmation opens: it asks where updating stands, once.
  mark("confirm");
  await bridge.apply({ type: "checkOpenClawUpdate" });
  await sleep(3_000);

  mark("press");
  if (plan.dropAnswer) dropOnUpdateRun = true;
  try {
    await bridge.apply({ type: "startOpenClawUpdate", stamp: gatewayStamp(state().connection) });
  } catch (error) {
    note(`startOpenClawUpdate: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (plan.reopen) {
    // As if Clawtrate were quit and opened again while the run validates.
    await until(
      "the run validating",
      () => state().openclawUpdating?.run?.phase === "validating",
      600_000,
    );
    mark("reopen");
    client.stop();
    bridge.dispose();
    ({ client, bridge } = makeClient(dataDir));
    void client.start();
    await until(
      "the reopened client connected",
      () => admin() && state().connection.gatewayId !== null,
      120_000,
    );
    try {
      await bridge.apply({ type: "startOpenClawUpdate", stamp: gatewayStamp(state().connection) });
      mark("press-accepted");
    } catch (error) {
      mark("press-refused", error instanceof Error ? error.message : String(error));
    }
  }

  // Follow until the engine says how it ended.
  const settled = () => {
    const outcome = state().openclawUpdating?.run?.outcome;
    return outcome !== undefined && outcome !== "running" && outcome !== "late";
  };
  await until("the engine's outcome", settled, Math.max(1_000, deadline - Date.now()));
  // Anything the outcome sets off: the model list, repeated events.
  await sleep(60_000);

  if (values["warm-session"]) {
    // The gateway's notice of the update, as the engine shows the main task.
    await bridge.apply({ type: "reloadSession", key: MAIN }).catch(() => {});
    await sleep(5_000);
    const transcript = asRecord(state().transcripts[MAIN]);
    for (const item of Array.isArray(transcript.items) ? transcript.items : []) {
      if (JSON.stringify(item).includes("OpenClaw updated")) notice.push(item);
    }
    note(`the main task shows ${notice.length} item(s) with the gateway's notice`);
  }
} catch (error) {
  note(`stopped: ${error instanceof Error ? error.message : String(error)}`);
}
mark("stop");
client.stop();

const verdict = judgeEngine(entries, plan);
writeFileSync(
  join(out, "engine-result.json"),
  `${JSON.stringify({ mode, plan, verdict, notice, entries }, null, 2)}\n`,
);
const report = engineSummary(verdict, values.measure ? `${mode}, measured, not a gate` : mode);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(`\n${report}\nnotice items: ${JSON.stringify(notice).slice(0, 2000)}`);
process.exitCode = verdict.passed || values.measure ? 0 : 1;
