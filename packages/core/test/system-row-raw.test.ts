// A line the gateway wrote itself keeps the history row behind it, for its
// Raw (F-094); a person's message keeps none.

import { describe, expect, it } from "vitest";
import { mapHistory } from "../src/mapping.ts";
import { grantingGateway, openTask } from "./client-harness.ts";

describe("F-094: a system line's history row", () => {
  it("a reset boundary and a turn the gateway started keep their rows as sent", () => {
    const reset = { role: "system", content: [], __openclaw: { id: "r1", kind: "reset" } };
    const started = {
      role: "user",
      content: [{ type: "text", text: "Continue the scheduled check." }],
      provenance: { kind: "internal_system", sourceTool: "heartbeat" },
      __openclaw: { id: "u1" },
    };
    const person = {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
      __openclaw: { id: "u2" },
    };
    const items = mapHistory([reset, started, person]);
    expect(items.map((item) => [item.role, item.raw])).toEqual([
      ["system", reset],
      ["system", started],
      ["user", undefined],
    ]);
  });
});

describe("F-094: a system line's row, read through a queue alias", () => {
  it("keeps the run id the gateway sent in its Raw, though the client groups the row under the send's run", async () => {
    const gateway = grantingGateway();
    const person = {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
      __openclaw: { id: "u1", idempotencyKey: "send-1:user" },
    };
    const reply = {
      role: "assistant",
      content: [{ type: "text", text: "Hi." }],
      stopReason: "stop",
      __openclaw: { id: "a1", runId: "gw-1" },
    };
    const compaction = {
      role: "system",
      content: [],
      __openclaw: { id: "c1", kind: "compaction", runId: "gw-1" },
    };
    gateway.handlers["chat.history"] = () => ({ messages: [person, reply, compaction] });
    const { client, transcript } = await openTask({ gateway });
    try {
      // The gateway's run is the send's: the client reads its rows under the send's id.
      expect(transcript().queueAliases).toEqual({ "gw-1": "send-1" });
      const line = transcript().items.find((item) => item.role === "system");
      expect(line?.raw).toEqual(compaction);
    } finally {
      client.stop();
    }
  });
});
