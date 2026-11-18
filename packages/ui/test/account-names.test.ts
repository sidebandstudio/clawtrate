// No two accounts ever read the same (docs/design/bots.md, section 6): an
// account without a label, or with a label another account of its provider
// shares, is named by its id on the gateway too.

import type { GatewayAccount } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { accountName, accountParts, howMade } from "../src/bots/words.ts";

const account = (id: string, label: string | null): GatewayAccount => ({
  id,
  provider: id.split(":")[0]!,
  label,
  type: "oauth",
  status: "ok",
  expiresAt: null,
  kind: "subscription",
  made: "sign-in",
  keptBy: null,
  logoutSupported: true,
});

const names = (list: GatewayAccount[], labels: boolean) =>
  list.map((each) => accountName(each, { labels, accounts: list }));

describe("account names", () => {
  it("tells two unlabelled accounts of one provider apart on admin", () => {
    const list = [account("acme:work", null), account("acme:home", null)];
    expect(names(list, true).map((name, i) => name.endsWith(list[i]!.id))).toEqual([true, true]);
    expect(new Set(names(list, true)).size).toBe(2);
  });

  it("tells two accounts sharing a label apart, whatever its case", () => {
    const list = [account("acme:work", "Work"), account("acme:home", "work")];
    expect(new Set(names(list, true)).size).toBe(2);
    expect(accountParts(list[0]!, { labels: true, accounts: list }).id).toBe("acme:work");
  });

  it("names a labelled account by its label alone when the label is its own", () => {
    const list = [account("acme:work", "Work"), account("acme:home", "Home")];
    expect(accountParts(list[0]!, { labels: true, accounts: list })).toEqual({
      label: "Work",
      id: null,
    });
  });

  it("names every account by its id below admin", () => {
    const list = [account("acme:work", "Work"), account("acme:home", null)];
    expect(names(list, false).every((name, i) => name.endsWith(list[i]!.id))).toBe(true);
  });
});

describe("how an account was made", () => {
  it("says a key typed into Clawtrate was entered here, and a key a browser sign-in saved was not", () => {
    const key = { ...account("openrouter:default", null), type: "api_key", kind: "key" as const };
    expect(howMade({ ...key, made: "typed" })).toBe("An API key, entered in Clawtrate");
    expect(howMade({ ...key, made: "sign-in" })).toBe("A sign-in that saves a key");
  });
});
