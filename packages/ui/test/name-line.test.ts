// What a bot's name line says after Undo (F-552): that the name isn't used again, or, when Undo's
// record couldn't be kept on the gateway, the engine's warning in place of that promise.
import { describe, expect, it } from "vitest";
import { undoneNote } from "../src/bots/NameLine.tsx";

describe("F-552: the line after Undo", () => {
  it("F-552: promises the name isn't used again only when its decline was kept on the gateway", () => {
    expect(undoneNote({ to: "Juniper", error: null })).toBe(
      "Juniper isn't used again unless you rename it yourself.",
    );
    const warning =
      "Clawtrate couldn't keep this on the gateway yet, so Pip may take Juniper again on another device.";
    expect(undoneNote({ to: "Juniper", error: warning })).toBe(warning);
  });
});
