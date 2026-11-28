// How Connect says a sign-in ended that didn't connect (#932, #848): a sign-in the gateway refused
// says "Couldn't connect"; one that ended where Clawtrate can't tell whether the account connected
// says so, offers Check again, and claims neither a failure nor a success. The read after it shows
// the gateway's accounts and, when it has it, the bot's model.
import {
  initialState,
  type Bot,
  type ClawtrateBridge,
  type HostInfo,
  type SignInResult,
  type SignInState,
} from "@clawtrate/core";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { Connect } from "../src/bots/Connect.tsx";

const METHOD = "openai/device-code";
const info: HostInfo = {
  kind: "desktop",
  version: "test",
  devGateway: null,
  setup: { look: true, pair: true, platform: "darwin" },
};
const bots = [
  { id: "main", name: "Juniper", isDefault: true, model: null },
  { id: "pip", name: "Pip", isDefault: false, model: null },
] as unknown as Bot[];

const signIn = (patch: Partial<SignInState>): SignInState => ({
  id: "clawtrate-made-up",
  method: METHOD,
  provider: "openai",
  label: "Use a device code",
  flow: "code",
  forBot: "pip",
  keptOnly: true,
  stage: "failed",
  step: null,
  error: null,
  cancelling: false,
  saving: false,
  startedAt: 0,
  result: null,
  byKey: false,
  known: [],
  cancelUnknown: false,
  unsure: false,
  ...patch,
});

const read = (patch: Partial<SignInResult>): SignInResult => ({
  added: [],
  landed: null,
  keptBy: null,
  readFailed: false,
  locks: [],
  modelChange: null,
  model: null,
  ...patch,
});

/** Connect's body and foot for this sign-in, as words. */
function words(sign: SignInState): string {
  const accounts = {
    ...initialState.accounts,
    signIn: sign,
    methods: [
      {
        id: METHOD,
        provider: "openai",
        providerLabel: null,
        label: "Use a device code",
        hint: null,
        kind: "device-code",
        flow: "code" as const,
        group: "subscription" as const,
      },
    ],
  };
  const connection = { ...initialState.connection, status: "connected" as const, canAdmin: true };
  const markup = renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge: { info } as ClawtrateBridge,
      children: createElement(Connect, {
        from: "settings",
        draftName: null,
        forBot: "pip",
        accounts,
        bots,
        connection,
        info,
        announce: () => {},
        onDone: () => {},
        onLeave: () => {},
        startWith: METHOD,
        children: (view) => createElement(Fragment, null, view.body, view.foot),
      }),
    }),
  );
  return markup
    .split(/<[^>]*>/)
    .join(" ")
    .split("&#x27;")
    .join("'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("F-474: how a sign-in that didn't connect is said", () => {
  it("a sign-in the gateway refused says it couldn't connect, and what the gateway has", () => {
    const text = words(
      signIn({ error: "OpenAI refused the sign-in: the code was not accepted.", result: read({}) }),
    );
    expect(text).toBe(
      "Couldn't connect OpenAI refused the sign-in: the code was not accepted. Clawtrate checked the gateway's accounts: no new OpenAI account. Try again Choose another way",
    );
  });

  it("a step Clawtrate can't read, with the account and the bot's model in the read after it", () => {
    const text = words(
      signIn({
        error: "The gateway sent a step Clawtrate can't read.",
        unsure: true,
        result: read({ added: ["openai:made-up"], model: "openai/gpt-5.5" }),
      }),
    );
    expect(text).toBe(
      "Couldn't confirm the connection Clawtrate couldn't read how the sign-in ended, so it can't tell whether the OpenAI account connected. Check again to read the gateway's accounts now. The gateway now has a OpenAI account it didn't have before, openai:made-up . It may not be ready to use. Pip's model is gpt-5.5. Name it Disconnect it… Check again Try again Choose another way",
    );
    expect(text).not.toContain("Couldn't connect");
  });

  it("a step Clawtrate can't read, with no read after it, says nothing of the model", () => {
    const text = words(
      signIn({
        error: "The gateway sent a step Clawtrate can't read.",
        unsure: true,
        result: read({ readFailed: true }),
      }),
    );
    expect(text).toBe(
      "Couldn't confirm the connection Clawtrate couldn't read how the sign-in ended, so it can't tell whether the OpenAI account connected. Check again to read the gateway's accounts now. Clawtrate couldn't read the gateway's accounts after the sign-in. Check again Try again Choose another way",
    );
  });
});
