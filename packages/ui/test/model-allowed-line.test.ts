// #799: the line after a model went on a bot's model list, and for a bot whose own model the list
// refuses, by their exact words.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initialState, type ClawtrateBridge, type ModelAllowed } from "@clawtrate/core";
import { BridgeProvider } from "../src/bridge.tsx";
import { allowedWords, ModelAllowedLine, refusedWords } from "../src/bots/ModelAllowedLine.tsx";

const added: ModelAllowed = {
  botId: "pip",
  provider: "openai",
  model: "gpt-5.5",
  entry: "openai/gpt-5.5",
  scope: "gateway",
  list: "gateway",
  status: "added",
  error: null,
  at: 0,
};

describe("F-042 F-587: the model list's line (#799)", () => {
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
    expect(allowedWords({ ...added, status: "kept", error: "gone" }, "Pip")).toBe(
      "OpenAI's gpt-5.5 is no longer on the models this gateway allows, so nothing was changed.",
    );
    expect(allowedWords({ ...added, status: "kept", error: "last" }, "Pip")).toBe(
      "Kept OpenAI's gpt-5.5 on the models this gateway allows: it's the only one left there, and taking it out would allow every model.",
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

describe("F-042 #799: the line's Undo", () => {
  /** The line for Pip, drawn from a host state with this record, on an admin connection or not. */
  const drawn = (allowed: ModelAllowed, admin = true) => {
    const state = {
      ...initialState,
      accounts: { ...initialState.accounts, allowed },
      connection: { ...initialState.connection, canAdmin: admin },
    };
    const bridge = {
      getState: () => state,
      subscribe: () => () => {},
    } as unknown as ClawtrateBridge;
    return renderToStaticMarkup(
      createElement(BridgeProvider, {
        bridge,
        children: createElement(ModelAllowedLine, { botId: "pip", botName: "Pip" }),
      }),
    );
  };

  it("stays offered after a failed write, until the gateway shows the entry gone", () => {
    for (const status of ["added", "failed"] as const)
      expect(drawn({ ...added, status, error: status === "failed" ? "timeout" : null })).toContain(
        ">Undo</button>",
      );
    for (const status of ["undone", "kept"] as const)
      expect(drawn({ ...added, status })).not.toContain(">Undo</button>");
    // Never below admin access.
    expect(drawn(added, false)).not.toContain(">Undo</button>");
  });
});
