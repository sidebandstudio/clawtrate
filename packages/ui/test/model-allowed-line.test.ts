// #799: the line after a model went on a bot's model list, and for a bot whose own model the list
// refuses, by their exact words.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  initialState,
  type ClawtrateBridge,
  type ModelAllowed,
  type RefusedBotModel,
} from "@clawtrate/core";
import { BridgeProvider } from "../src/bridge.tsx";
import { allowedWords, ModelAllowedLine, refusedWords } from "../src/bots/ModelAllowedLine.tsx";

const added: ModelAllowed = {
  id: "a1",
  gatewayId: "gw",
  botId: "pip",
  provider: "openai",
  model: "gpt-5.5",
  entry: "openai/gpt-5.5",
  scope: "gateway",
  list: "gateway",
  digest: "d",
  status: "added",
  error: null,
  at: 0,
};

const REFUSED: RefusedBotModel = {
  botId: "pip",
  provider: "openai",
  model: "gpt-5.5",
  full: false,
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
    expect(allowedWords({ ...added, status: "kept", error: "moved" }, "Pip")).toBe(
      "Kept OpenAI's gpt-5.5 on the models this gateway allows: another list now decides Pip's models, so nothing was changed.",
    );
    expect(allowedWords({ ...added, status: "kept", error: "changed" }, "Pip")).toBe(
      "Kept OpenAI's gpt-5.5 on the models this gateway allows: the list has changed since it was added, so nothing was changed.",
    );
    expect(allowedWords({ ...added, status: "kept", error: "last" }, "Pip")).toBe(
      "Kept OpenAI's gpt-5.5 on the models this gateway allows: it's the only one left there, and taking it out would allow every model.",
    );
    expect(allowedWords({ ...added, status: "failed", error: "config changed" }, "Pip")).toBe(
      "Couldn't take OpenAI's gpt-5.5 out of the models this gateway allows: config changed",
    );
  });

  it("says why a bot's tasks can't start on its own model", () => {
    expect(refusedWords({ ...REFUSED, full: false }, "Pip")).toBe(
      "Pip can't start tasks on OpenAI's gpt-5.5: this gateway's model list doesn't include it.",
    );
  });
});

describe("F-042 #799: the line's Undo", () => {
  /** The line for Pip, drawn from a host state with this record and these refusals. */
  const drawn = (
    allowed: ModelAllowed | null,
    admin = true,
    refused: RefusedBotModel[] = [],
    gatewayId = "gw",
  ) => {
    const state = {
      ...initialState,
      accounts: { ...initialState.accounts, allowed, modelsRefused: refused },
      connection: { ...initialState.connection, canAdmin: admin, gatewayId },
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
  const words = (markup: string) =>
    markup
      .split(/<[^>]*>/)
      .join(" ")
      .split("&#x27;")
      .join("'")
      .replace(/\s+/g, " ")
      .trim();

  it("a refusal true now shows, before an earlier addition's line", () => {
    // Added gpt-5.5 earlier; Pip now runs on gpt-6, which its list refuses.
    const now = { ...REFUSED, model: "gpt-6" };
    expect(words(drawn(added, true, [now]))).toBe(
      "Pip can't start tasks on OpenAI's gpt-6: this gateway's model list doesn't include it. Allow gpt-6 Added OpenAI's gpt-5.5 to the models this gateway allows. · Undo",
    );
    // Undo kept it, and the bot's model is refused: the refusal shows too.
    expect(words(drawn({ ...added, status: "kept", error: "moved" }, true, [REFUSED]))).toContain(
      "Pip can't start tasks on OpenAI's gpt-5.5",
    );
  });

  it("a list too long for Clawtrate to change offers no Allow, and says why", () => {
    const markup = drawn(null, true, [{ ...REFUSED, full: true }]);
    expect(words(markup)).toBe(
      "Pip can't start tasks on OpenAI's gpt-5.5: this gateway's model list doesn't include it. The list is too long for Clawtrate to change.",
    );
    expect(markup).not.toContain("<button");
  });

  it("an addition made on another gateway is neither drawn nor offered", () => {
    expect(drawn(added, true, [], "another")).toBe("");
    expect(drawn({ ...added, gatewayId: null }, true, [], "gw")).toBe("");
  });

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
