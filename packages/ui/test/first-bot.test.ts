import { initialAccountsState, type AccountsState, type GatewayAccount } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { firstBotModel } from "../src/bots/words.ts";
import { settlement } from "../src/bots/settings-request.ts";

function account(id: string, changes: Partial<GatewayAccount> = {}): GatewayAccount {
  return {
    id,
    provider: id.split(":")[0]!,
    label: null,
    type: "oauth",
    status: "ok",
    expiresAt: null,
    kind: "subscription",
    made: "sign-in",
    keptBy: null,
    logoutSupported: true,
    ...changes,
  };
}

const catalog = (provider: string, id: string, available = true) => ({
  provider,
  id,
  name: null,
  available,
  levels: [],
  defaultLevel: null,
});
const state: AccountsState = {
  ...initialAccountsState,
  defaultModel: "acme/default",
  models: [catalog("acme", "default"), catalog("globex", "first"), catalog("globex", "second")],
};

describe("F-504: the first bot's account and model", () => {
  it("cannot use a gateway default without an account for it", () => {
    expect(firstBotModel(state, null)).toBeNull();
    expect(firstBotModel({ ...state, accounts: [account("globex:new")] }, null)?.model).toBe(
      "first",
    );
  });

  it("uses the account just connected, even when the gateway default has another account", () => {
    const added = account("globex:new");
    expect(
      firstBotModel({ ...state, accounts: [account("acme:existing"), added] }, added.id),
    ).toEqual({ account: added, model: "first" });
  });

  it("prefers an available default of the account's own provider", () => {
    const added = account("globex:new");
    expect(
      firstBotModel({ ...state, accounts: [added], defaultModel: "globex/second" }, added.id)
        ?.model,
    ).toBe("second");
  });

  it("skips an unavailable default, and never falls back to a different account after sign-in", () => {
    const added = account("acme:new");
    const another = account("globex:existing");
    const unavailable = {
      ...state,
      models: [catalog("acme", "default", false), ...state.models.slice(1)],
    };
    expect(firstBotModel({ ...unavailable, accounts: [added, another] }, added.id)).toBeNull();
    expect(
      firstBotModel(
        {
          ...unavailable,
          accounts: [added, another],
          models: [...unavailable.models, catalog("acme", "other")],
        },
        added.id,
      )?.model,
    ).toBe("other");
  });

  it.each([{ keptBy: "other-bot" }, { status: "missing" }, { status: "expired", type: "token" }])(
    "does not offer an account that cannot be used (%j)",
    (changes) => {
      expect(
        firstBotModel({ ...state, accounts: [account("acme:new", changes)] }, null),
      ).toBeNull();
    },
  );

  it("OAuth may be renewed by the gateway", () => {
    const added = account("acme:refreshable", { status: "expired" });
    expect(firstBotModel({ ...state, accounts: [added] }, null)?.account).toEqual(added);
  });
});

it("F-480: Connect an account waits for the right bot's provider screen and focuses it", () => {
  const request = { part: "connect", botId: "juniper", seq: 1 } as const;
  const drawn = (selector: string) => (selector === "[data-bs-connect]" ? "usable" : null);
  expect(settlement(request, "other", drawn)).toBeNull();
  expect(settlement(request, "juniper", () => null)).toBeNull();
  expect(settlement(request, "juniper", drawn)).toEqual({ focus: "[data-bs-connect]" });
});
