// Settings › Models (docs/design/gateway-settings.md sections 4.1, 6 and 7): its words, the line a
// change leaves, the hold for a change that restarts OpenClaw, and Put back.
import {
  initialAccountsState,
  initialState,
  type AccountsState,
  type ClawtrateBridge,
  type ConnectionState,
  type DefaultsChange,
  type HostInfo,
} from "@clawtrate/core";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import {
  changeLine,
  modelWords,
  restartWords,
  useModelsSection,
} from "../src/bots/ModelsSection.tsx";

const info: HostInfo = { kind: "desktop", version: "test", devGateway: null, fullControl: true };
const admin: ConnectionState = {
  ...initialState.connection,
  status: "connected",
  scopes: ["operator.read", "operator.write", "operator.admin"],
  canWrite: true,
  canAdmin: true,
  serverVersion: "2026.11.10",
};

const accounts: AccountsState = {
  ...initialAccountsState,
  status: "ready",
  labels: true,
  accounts: [
    { id: "acme:work", provider: "acme", label: "Work" } as AccountsState["accounts"][number],
    { id: "globex:team", provider: "globex", label: "Team" } as AccountsState["accounts"][number],
  ],
  models: [
    {
      provider: "acme",
      id: "swift-1",
      name: "Swift 1",
      available: true,
      levels: ["low", "high"],
      defaultLevel: "low",
    },
    {
      provider: "acme",
      id: "swift-2",
      name: "Swift 2",
      available: true,
      levels: [],
      defaultLevel: null,
    },
    {
      provider: "globex",
      id: "one",
      name: "Globex One",
      available: true,
      levels: [],
      defaultLevel: null,
    },
  ],
  defaults: {
    primary: "acme/swift-1@acme:work",
    fallbacks: ["globex/one@globex:team"],
    thinking: "low",
    reloadOff: false,
  },
};

const change = (over: Partial<DefaultsChange>): DefaultsChange => ({
  status: "saved",
  before: { primary: "acme/swift-1@acme:work" },
  after: { primary: "acme/swift-2@acme:work" },
  current: null,
  restart: false,
  putBack: false,
  error: null,
  at: 1,
  gatewayId: "gateway-a",
  ...over,
});

function render(state: AccountsState, connection: ConnectionState = admin): string {
  function Section(): ReactNode {
    const view = useModelsSection({
      accounts: state,
      bots: [
        { id: "main", name: "Gateway bot", isDefault: true },
        { id: "juniper", name: "Juniper" },
        { id: "otto", name: "Otto" },
      ] as never,
      connection,
      info,
      announce: () => {},
      toNav: null,
    });
    return createElement("div", null, view.title, view.body, view.foot);
  }
  return renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge: { info, getState: () => ({ connection }) } as unknown as ClawtrateBridge,
      children: createElement(Section),
    }),
  );
}

describe("Settings › Models", () => {
  it("names a model with the account it runs on", () => {
    expect(modelWords("acme/swift-2@acme:work", accounts)).toBe("Swift 2, on Acme · Work");
    expect(modelWords(null, accounts)).toBe("None");
  });

  it("shows the default, the backups, thinking and each bot's model", () => {
    const html = render(accounts);
    expect(html).toContain("Default model");
    expect(html).toContain(
      '<option value="acme/swift-1@acme:work" selected="">Swift 1 · Acme · Work</option>',
    );
    expect(html).toContain("Globex One, on Globex · Team");
    expect(html).toContain("If it can&#x27;t answer");
    expect(html).toContain("Thinking");
    expect(html).toContain("The default: Swift 1, on Acme · Work");
  });

  it("after a change: one line, and Put back with the earlier value", () => {
    const html = render({ ...accounts, defaultsChange: change({}) });
    expect(html).toContain("Default model is now Swift 2, on Acme · Work.");
    expect(html).toContain("Put back Swift 1, on Acme · Work");
  });

  it("no Put back once another device changed the setting", () => {
    const since = change({
      status: "changedSince",
      current: { primary: "globex/one@globex:team" },
    });
    expect(changeLine(since, accounts, "2026.11.10")).toBe(
      "Changed on another device since: default model is now Globex One, on Globex · Team.",
    );
    expect(render({ ...accounts, defaultsChange: since })).not.toContain("Put back");
  });

  it("leaves the gateway's own bot out of Each bot, as every bot list does", () => {
    const html = render(accounts);
    expect(html).not.toContain(">Gateway bot<");
    expect(html).toContain(">Juniper<");
  });

  it("a change that restarts OpenClaw waits for one press, with the version's words", () => {
    const held = change({ status: "held", restart: true });
    const html = render({ ...accounts, defaultsChange: held });
    expect(html).toContain(
      "Saving restarts OpenClaw. Conversations pick up where they left off; tasks a bot started stop and may need starting again.",
    );
    expect(html).toContain(">Save and restart</button>");
    const older = render(
      { ...accounts, defaultsChange: held },
      { ...admin, serverVersion: "2026.10.6" },
    );
    expect(older).toContain(
      "Saving restarts OpenClaw once its bots finish what they&#x27;re doing, which can take up to 5 minutes.",
    );
  });

  it("with reload off on 2026.11.10, Save says it applies at the next start, and doesn't claim a restart", () => {
    expect(restartWords("2026.11.10", true)).toEqual({
      line: "OpenClaw applies changes like this when it restarts. Save now, and it uses this the next time it starts.",
      button: "Save",
    });
    expect(restartWords(null, false)).toEqual({
      line: "Saving may restart OpenClaw. Work running now may be interrupted.",
      button: "Save and restart",
    });
  });

  it("the other outcomes say what Clawtrate knows, and never that a restart failed", () => {
    expect(changeLine(change({ status: "notApplied" }), accounts, null)).toBe(
      "Saved. OpenClaw applies it when it next restarts.",
    );
    expect(changeLine(change({ status: "unconfirmed" }), accounts, null)).toBe(
      "Clawtrate can't reach OpenClaw yet, so it can't confirm the change applied.",
    );
    expect(changeLine(change({ status: "restarting" }), accounts, null)).toBe(
      "OpenClaw is restarting to apply default model.",
    );
  });

  it("without admin, the controls can't be changed and the bar asks for admin", () => {
    const html = render(accounts, { ...admin, canAdmin: false, scopes: ["operator.read"] });
    expect(html).toContain("disabled");
    expect(html).toContain("Changing the models needs admin access.");
    // Nothing that looks pressable is shown for what can't be changed.
    expect(html).not.toContain(">Remove<");
  });
});
