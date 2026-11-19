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
import { readOnlyWords } from "../src/conversation-words.ts";
import { grantedWords } from "../src/gateway-state.ts";
import { statusLineFor } from "../src/live.ts";
import { listNote } from "../src/summary.ts";

const connection = (change: Partial<ConnectionState> = {}): ConnectionState => ({
  ...initialState.connection,
  ...change,
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
