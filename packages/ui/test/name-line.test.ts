// What a bot's name line says after Undo (F-552): "Back to …" only when the name the gateway lists
// afterwards is the one Undo put back, otherwise what it lists; and, when Undo's record couldn't
// be kept on the gateway, the engine's warning after it.
import { describe, expect, it } from "vitest";
import { undoneText } from "../src/bots/NameLine.tsx";

describe("F-552: the line after Undo", () => {
  it("F-552: says the name is back only when the name read back is the one Undo put back", () => {
    expect(undoneText({ from: "Pip", after: "Pip", error: null })).toBe("Back to Pip.");
    // Read back otherwise (another writer, or the gateway changed it): what it lists, said as it is.
    expect(undoneText({ from: "Pip", after: "Otto's twin", error: null })).toBe(
      "Undo sent Pip, but the gateway lists the bot as Otto's twin.",
    );
    expect(undoneText({ from: "Pip", after: null, error: null })).toBe(
      "Undo sent Pip; the gateway's bot list doesn't show it yet.",
    );
  });

  it("F-552: adds the engine's warning when the Undo's record couldn't be kept on the gateway", () => {
    const warning =
      "Clawtrate couldn't save this Undo to the gateway's record yet, so another device may still show the rename.";
    expect(undoneText({ from: "Pip", after: "Pip", error: warning })).toBe(
      `Back to Pip. ${warning}`,
    );
  });
});
