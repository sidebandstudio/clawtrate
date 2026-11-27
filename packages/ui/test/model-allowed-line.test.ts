// #799: the line after a model went on a bot's model list, and for a bot whose own model the list
// refuses, by their exact words.
import { describe, expect, it } from "vitest";
import type { ModelAllowed } from "@clawtrate/core";
import { allowedWords, refusedWords } from "../src/bots/ModelAllowedLine.tsx";

const added: ModelAllowed = {
  botId: "pip",
  provider: "openai",
  model: "gpt-5.5",
  entry: "openai/gpt-5.5",
  scope: "gateway",
  status: "added",
  error: null,
  at: 0,
};

describe("the model list's line (#799)", () => {
  it("says what was added to which list, and what Undo did", () => {
    expect(allowedWords(added, "Pip")).toBe(
      "Added OpenAI's gpt-5.5 to the models this gateway allows.",
    );
    expect(allowedWords({ ...added, scope: "bot" }, "Pip")).toBe(
      "Added OpenAI's gpt-5.5 to the models Pip may use.",
    );
    expect(allowedWords({ ...added, status: "undone" }, "Pip")).toBe(
      "Took OpenAI's gpt-5.5 out of the models this gateway allows again.",
    );
    expect(allowedWords({ ...added, status: "kept" }, "Pip")).toBe(
      "OpenAI's gpt-5.5 wasn't taken out: the models this gateway allows changed since.",
    );
    expect(allowedWords({ ...added, status: "failed", error: "config changed" }, "Pip")).toBe(
      "Couldn't take OpenAI's gpt-5.5 out of the models this gateway allows: config changed",
    );
  });

  it("says why a bot's tasks can't start on its own model", () => {
    expect(refusedWords({ botId: "pip", provider: "openai", model: "gpt-5.5" }, "Pip")).toBe(
      "Pip can't start tasks on OpenAI's gpt-5.5: this gateway's model list doesn't include it.",
    );
  });
});
