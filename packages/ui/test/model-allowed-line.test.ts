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
  revision: "h2",
  status: "added",
  error: null,
  at: 0,
};

const REFUSED: RefusedBotModel = {
  botId: "pip",
  provider: "openai",
  model: "gpt-5.5",
  why: null,
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
    // The config changed since, by anyone: only that is said, and nothing about the list.
    expect(allowedWords({ ...added, status: "changed" }, "Pip")).toBe(
      "Added OpenAI's gpt-5.5 to the models this gateway allows. The gateway's settings have changed since, so it can't be undone here.",
    );
    // Its answer didn't come, and a read since shows it isn't there.
    expect(allowedWords({ ...added, status: "not-added", revision: null }, "Pip")).toBe(
      "The gateway didn't confirm the change. OpenAI's gpt-5.5 is missing from the models this gateway allows.",
    );
    // Its answer didn't come: never "nothing changed".
    expect(allowedWords({ ...added, status: "unconfirmed", revision: null }, "Pip")).toBe(
      "It isn't confirmed yet whether OpenAI's gpt-5.5 was added to the models this gateway allows.",
    );
    expect(allowedWords({ ...added, status: "failed", error: "config changed" }, "Pip")).toBe(
      "Couldn't take OpenAI's gpt-5.5 out of the models this gateway allows: config changed",
    );
  });

  it("says why a bot's tasks can't start on its own model", () => {
    expect(refusedWords(REFUSED, "Pip")).toBe(
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
    // The settings changed since, and the bot's model is refused: the refusal shows too.
    expect(words(drawn({ ...added, status: "changed" }, true, [REFUSED]))).toContain(
      "Pip can't start tasks on OpenAI's gpt-5.5",
    );
  });

  it("a list Clawtrate doesn't change offers no Allow, and says why in one line", () => {
    const reason =
      "Pip can't start tasks on OpenAI's gpt-5.5: this gateway's model list doesn't include it.";
    for (const [why, said] of [
      ["full", "The list is too long for Clawtrate to change."],
      ["long", "The model's id is longer than Clawtrate carries."],
      ["layout", "This gateway's model list is set up in a way Clawtrate doesn't change."],
    ] as const) {
      const markup = drawn(null, true, [{ ...REFUSED, why }]);
      expect(words(markup)).toBe(`${reason} ${said}`);
      expect(markup).not.toContain("<button");
    }
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
    for (const status of ["undone", "changed", "unconfirmed"] as const)
      expect(drawn({ ...added, status })).not.toContain(">Undo</button>");
    // Not before a read has given it the revision it is held to.
    expect(drawn({ ...added, revision: null })).not.toContain(">Undo</button>");
    // Never below admin access.
    expect(drawn(added, false)).not.toContain(">Undo</button>");
  });
});
