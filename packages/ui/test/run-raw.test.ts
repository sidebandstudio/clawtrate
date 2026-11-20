// A run line's Raw for a run that failed (F-094, F-301): its start from the state, and the event
// that failed it only as read from the host when Raw opened, never from the state.
import { describe, expect, it } from "vitest";
import { runRaw } from "../src/actions/ActionCards.tsx";

const start = { via: "agent (lifecycle start)", record: { runId: "run-1", seq: 1 } };
const event = { runId: "run-1", state: "error", errorMessage: "The model provider is overloaded." };

describe("F-094: the run line's Raw for a failed run", () => {
  it("shows the failure as read when Raw opened, beside the run's start, and says while it is read", () => {
    expect(runRaw("run-1", [start], null)).toMatchObject({
      events: [["The event, as the gateway sent it (agent (lifecycle start))", start.record]],
      notes: ["Reading what ended the turn…"],
    });
    expect(
      runRaw("run-1", [start], { status: "available", holds: "chat-event", payload: event }),
    ).toMatchObject({
      events: [
        ["The event, as the gateway sent it (agent (lifecycle start))", start.record],
        ["The chat event that ended the turn, as received", event],
      ],
    });
    expect(runRaw("run-1", [start], { status: "not-kept", holds: "chat-event" })).toMatchObject({
      notes: ["The chat event that ended the turn, as received is no longer kept here."],
    });
  });

  it("a run that did not fail reads nothing more", () => {
    const raw = runRaw("run-1", [start]);
    expect(raw).toMatchObject({ events: [[expect.any(String), start.record]] });
    expect("notes" in raw ? raw.notes : undefined).toBeUndefined();
  });
});
