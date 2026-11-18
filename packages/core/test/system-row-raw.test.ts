// A line the gateway wrote itself keeps the history row behind it, for its
// Raw (F-094); a person's message keeps none.

import { describe, expect, it } from "vitest";
import { mapHistory } from "../src/mapping.ts";

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
