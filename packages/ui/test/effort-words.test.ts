// "Not offered" is said only when the gateway lists the model with no levels
// (docs/design/bots.md section 9, conversation.md 25.2).

import { describe, expect, it } from "vitest";
import { noLevelsWord } from "../src/bots/words.ts";

const MODELS = [
  { id: "dev-1", levelsReported: true },
  { id: "dev-old", levelsReported: true },
  { id: "dev-quiet", levelsReported: false },
];

describe("the effort of a bot's model with no levels to choose", () => {
  it("F-043: is Not offered for a model the gateway lists with none", () => {
    expect(noLevelsWord(MODELS, "dev-old", null)).toBe("Not offered");
  });

  it("F-043: keeps the effort last read for a model the list does not contain, or says it is not reported", () => {
    expect(noLevelsWord(MODELS, "dev-gone", "ultra")).toBe("Ultra");
    expect(noLevelsWord([], "dev-1", "high")).toBe("High");
    expect(noLevelsWord(MODELS, "dev-gone", null)).toBe("Not reported");
  });

  it("F-043: a catalogue entry without thinkingLevels does not establish an empty level list", () => {
    expect(noLevelsWord(MODELS, "dev-quiet", null)).toBe("Not reported");
    expect(noLevelsWord(MODELS, "dev-old", "high")).toBe("High");
    expect(noLevelsWord(MODELS, null, null)).toBe("Choose a model");
  });
});
