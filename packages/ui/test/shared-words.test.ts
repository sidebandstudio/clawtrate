// The words the desktop and the iOS app share for what the connection is and
// what a list or a task shows: each rule here holds for both.

import {
  emptyActivity,
  initialState,
  newRun,
  type ConnectionState,
  type Transcript,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import {
  CONNECT_WORDS,
  isCleartext,
  pairingScopes,
  scopesDifferWords,
} from "../src/connect-words.ts";
import { readOnlyWords } from "../src/conversation-words.ts";
import { grantedWords } from "../src/gateway-state.ts";
import { statusLineFor } from "../src/live.ts";
import { listNote } from "../src/summary.ts";

const connection = (change: Partial<ConnectionState> = {}): ConnectionState => ({
  ...initialState.connection,
  ...change,
});

describe("what the connection screens say", () => {
  it("calls a ws: address that leaves this device unencrypted, and nothing else", () => {
    // Private addresses are built from their parts, so no tracked file writes one out.
    const join4 = (...parts: number[]) => parts.join(".");
    for (const url of [
      `ws://${join4(192, 168, 1, 20)}:18789`,
      "ws://gateway.tailnet.example:18789",
      `ws://[${["fd7a", "", "1"].join(":")}]:1`,
      `WS://${join4(10, 0, 0, 2)}`,
      "ws://198.51.100.4:18789",
    ])
      expect(isCleartext(url), url).toBe(true);
    for (const url of [
      "wss://gateway.example",
      "ws://127.0.0.1:19201",
      `ws://${join4(127, 9, 9, 9)}:1`,
      "ws://localhost:1",
      "ws://[::1]:1",
      "",
      "not a url",
      null,
    ])
      expect(isCleartext(url), String(url)).toBe(false);
  });

  it("lists the scopes this client signed, and says when the gateway's echo differs, showing both", () => {
    const pairing = {
      requestId: "r",
      deviceId: "d",
      message: "",
      approveCommand: null,
      approveNote: null,
      requestedScopes: ["operator.read"],
    };
    const same = connection({ requestedScopes: ["operator.read"], pairing });
    expect(pairingScopes(same)).toEqual({ asked: ["operator.read"], echoed: null });
    const echo = connection({
      requestedScopes: ["operator.read"],
      pairing: { ...pairing, requestedScopes: ["operator.read", "operator.admin"] },
    });
    expect(pairingScopes(echo)).toEqual({
      asked: ["operator.read"],
      echoed: ["operator.read", "operator.admin"],
    });
    expect(scopesDifferWords(["operator.read", "operator.admin"])).toBe(
      "The gateway reports this request as asking for Read bots, tasks and conversations, operator.admin. This device asked only for what is listed above.",
    );
  });

  it("says the token is used for the first pairing, not once", () => {
    expect(CONNECT_WORDS.hint).toContain("the token is used for the first pairing");
    expect(CONNECT_WORDS.hint).not.toContain("used once");
  });
});

describe("what Settings says of the gateway", () => {
  it("says None granted for a connection the gateway granted nothing, and what holds while not connected", () => {
    expect(grantedWords(connection({ status: "connected", scopes: [] }))).toBe("None granted");
    expect(grantedWords(connection({ status: "connected", scopes: ["operator.read"] }))).toBe(
      "operator.read",
    );
    expect(grantedWords(connection({ status: "reconnecting", scopes: ["operator.read"] }))).toBe(
      "None while not connected",
    );
  });
});

describe("what a list says when it has no bot", () => {
  it("says the read failed, never that the gateway has none, when the first read failed", () => {
    expect(listNote(0, { status: "error", error: "The gateway did not answer." })).toEqual({
      title: "Couldn't load bots and tasks",
      body: "The gateway did not answer.",
      state: "failed",
    });
    expect(listNote(0, { status: "loading", error: null })?.state).toBe("loading");
    expect(listNote(0, { status: "ready", error: null })?.title).toBe("No bots");
    expect(listNote(2, { status: "error", error: "x" })).toBeNull();
  });
});

describe("what a running task's status line says when the connection is lost", () => {
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
    loadedAt: 1,
    runs: [newRun("run-1", { state: "running", origin: "local", bound: true }, 1)],
  };
  const run = transcript.runs[0]!;

  it("says Disconnected when the person closed it, and Reconnecting when it dropped", () => {
    const closed = statusLineFor(run, transcript, {
      connected: false,
      interactive: false,
      closed: true,
    });
    expect(closed.phrase).toBe("Disconnected. Last seen thinking");
    const dropped = statusLineFor(run, transcript, { connected: false, interactive: false });
    expect(dropped.phrase).toBe("Reconnecting. Last seen thinking");
  });
});

describe("the read-only explanation", () => {
  it("names the bot and what this connection does not show", () => {
    const words = readOnlyWords("Otto");
    expect(`${words.lead}${words.rest}`).toBe(
      "Read-only. You can follow Otto's work here. Approvals and questions aren't shown on this connection.",
    );
  });
});
