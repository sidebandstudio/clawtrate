// #913: while OpenClaw restarts, every place that says the connection's state says
// "Restarting OpenClaw…", from core's `connection.restart`; without it each says what it always
// did, and an update this app follows keeps its own words.
import {
  emptyActivity,
  initialState,
  newRun,
  type ClawtrateState,
  type ConnectionState,
  type OpenClawUpdateState,
  type Run,
  type Step,
  type Transcript,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { updatingHere } from "../src/bots/update-words.ts";
import { composerFor, statusLineFor } from "../src/live.ts";
import { presenceWords } from "../src/Rail.tsx";
import { connectionHeard, RESTARTING_WORDS } from "../src/restarting.ts";
import { gatewayDot, gatewayState } from "../src/Settings.tsx";
import { stripFor } from "../src/StatusStrip.tsx";

const NOW = 1_800_000_000_000;
const RESTART = { cause: "announced" as const, since: NOW, until: NOW + 180_000 };
const up: ConnectionState = {
  ...initialState.connection,
  status: "connected",
  gatewayUrl: "wss://gateway.example",
  gatewayId: "gw-a",
  target: 1,
};
const down: ConnectionState = { ...up, status: "reconnecting", retryAt: NOW + 4_000 };
const with_ = (connection: ConnectionState, patch: Partial<ClawtrateState> = {}) =>
  ({ ...initialState, connection, ...patch }) as ClawtrateState;
const strip = (s: ClawtrateState) => stripFor(s, "dropped", null);
const footer = (s: ClawtrateState) => presenceWords(s.connection, false, updatingHere(s));

const step: Step = {
  id: "tool:read",
  kind: "tool",
  title: "read",
  toolName: "read",
  toolCallId: "read",
  status: "running",
  startedAt: NOW,
  endedAt: null,
  argsText: { text: '{"path":"/var/log/backup.log"}', totalChars: 30 },
  output: null,
  result: null,
  error: null,
  approvalId: null,
  failureKind: null,
  truncated: false,
  replaceable: false,
  correction: 0,
  continuation: null,
  raw: null,
  rawSize: null,
};
const reading: Run = newRun(
  "run-1",
  { state: "running", origin: "local", bound: true, reportedStartAt: NOW, steps: [step] },
  NOW,
);
const transcript: Transcript = {
  ...emptyActivity,
  linkedRuns: {},
  interSession: [],
  mcpTools: {},
  sessionKey: "agent:otto:a",
  status: "ready",
  items: [],
  error: null,
  hasMore: false,
  live: null,
  loadedAt: NOW,
  runs: [reading],
};

describe("#913: the connection strip while OpenClaw restarts", () => {
  it("lost, it says Restarting OpenClaw… with saved messages and Retry, and no countdown", () => {
    for (const status of ["reconnecting", "connecting"] as const) {
      expect(strip(with_({ ...down, status, restart: RESTART }))).toEqual({
        tone: "warn",
        text: "Restarting OpenClaw…",
        more: "showing saved messages",
        action: "retry",
        countdown: false,
      });
    }
  });

  it("announced while the connection is still up, it says so with nothing to press", () => {
    expect(strip(with_({ ...up, restart: RESTART }))).toEqual({
      tone: "warn",
      text: "Restarting OpenClaw…",
      more: null,
      action: null,
      countdown: false,
    });
  });

  it("without a restart, or once its wait ran out, each state reads as it always did", () => {
    expect(strip(with_(down))).toEqual({
      tone: "warn",
      text: "Reconnecting",
      more: "showing saved messages",
      action: "retry",
      countdown: true,
    });
    expect(strip(with_({ ...down, restart: null }))?.text).toBe("Reconnecting");
    expect(stripFor(with_(up), "none", null)).toBeNull();
    // A connection that stopped says why, whatever core last kept.
    const stopped = { ...down, status: "error" as const, restart: RESTART, error: null };
    expect(strip(with_(stopped))?.text).toBe("Can't reach gateway.example");
    expect(strip(with_({ ...down, status: "disconnected", restart: RESTART }))?.text).toBe(
      "Disconnected",
    );
  });

  it("an update this device follows keeps the update's words: the restart is one of its steps", () => {
    const run = {
      runId: "3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e",
      gatewayId: "gw-a",
      mine: true,
      from: "2026.10.6",
      to: "2026.11.10",
      phase: "restarting" as const,
      outcome: "running" as const,
      reason: null,
      note: null,
      reported: null,
    };
    const updating: OpenClawUpdateState = {
      run,
      starting: false,
      blocked: null,
      error: null,
      looking: false,
      lookFailed: false,
    };
    const s = with_({ ...down, restart: RESTART }, { openclawUpdating: updating });
    expect(strip(s)?.text).toBe("Updating OpenClaw to 2026.11.10");
    expect(footer(s)).toBe("Updating OpenClaw…");
  });
});

describe("#913: the footer, Settings and what is announced", () => {
  it("the footer says Restarting OpenClaw… up or down, and Reconnecting… without one", () => {
    expect(footer(with_({ ...down, restart: RESTART }))).toBe(RESTARTING_WORDS);
    expect(footer(with_({ ...up, restart: RESTART }))).toBe(RESTARTING_WORDS);
    expect(footer(with_(down))).toBe("Reconnecting…");
    expect(footer(with_(up))).toBe("Connected");
  });

  it("Settings › Gateway says Restarting OpenClaw…, not Offline", () => {
    expect(gatewayState({ ...down, restart: RESTART })).toBe("Restarting OpenClaw…");
    expect(gatewayState(down)).toBe("Offline");
    expect(gatewayState({ ...down, retryAt: null })).toBe("Connecting");
    expect(gatewayState({ ...down, status: "error", restart: RESTART })).toBe("Offline");
    // Its dot is the one a connection on its way back has.
    expect(gatewayDot(gatewayState({ ...down, restart: RESTART }))).toBe("connecting");
    expect(gatewayDot(gatewayState(down))).toBe("error");
  });

  it("the conversation announces Restarting OpenClaw when the connection drops for one", () => {
    expect(connectionHeard({ ...down, restart: RESTART }, null)).toBe("Restarting OpenClaw");
    expect(connectionHeard(down, null)).toBe("Reconnecting");
    expect(connectionHeard({ ...down, restart: RESTART }, "Updating OpenClaw to 2026.11.10")).toBe(
      "Updating OpenClaw to 2026.11.10",
    );
    expect(connectionHeard({ ...up, restart: RESTART }, null)).toBe("Connected");
  });
});

describe("#913: the run line and the composer while OpenClaw restarts", () => {
  it("the run line says Restarting OpenClaw with what was last seen", () => {
    const lost = { connected: false, interactive: true };
    expect(statusLineFor(reading, transcript, { ...lost, restarting: true }).phrase).toBe(
      "Restarting OpenClaw. Last seen reading backup.log",
    );
    expect(statusLineFor(reading, transcript, lost).phrase).toBe(
      "Reconnecting. Last seen reading backup.log",
    );
    // Still connected (announced, not yet closed), the run line is live as before.
    expect(
      statusLineFor(reading, transcript, { connected: true, interactive: true, restarting: true })
        .phrase,
    ).toBe("Reading backup.log");
  });

  it("the composer says messages send when OpenClaw is back", () => {
    const offline = { bot: "Otto", connected: false, chosen: null };
    for (const runs of [[], [reading]]) {
      const shown = { ...transcript, runs };
      expect(composerFor(shown, { ...offline, restarting: true }).placeholder).toBe(
        "Restarting OpenClaw. Messages send when it's back.",
      );
      expect(composerFor(shown, offline).placeholder).toBe(
        "Offline. Messages send when you reconnect.",
      );
    }
    expect(
      composerFor(transcript, { bot: "Otto", connected: true, chosen: null, restarting: true })
        .placeholder,
    ).toBe("Message Otto");
  });
});
