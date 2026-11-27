// "This person has used Clawtrate with this gateway" (`used-marker.ts`): one key in the person's
// own preferences, written where the connection may write, never by a read-only one.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { markUsed, USED_PREF_KEY } from "../src/used-marker.ts";
import { FAST, grantingGateway, URL_A } from "./client-harness.ts";
import { memoryStorage, sleep, testHost, tokenKey, until } from "./fake-gateway.ts";

/** A gateway that keeps the person's preferences, as `users.prefs.get` and `.set` answer them. */
function prefsGateway(held: Record<string, unknown> = {}) {
  const sets: unknown[] = [];
  const request = async (method: string, params: unknown) => {
    if (method === "users.prefs.get") return { status: "ok", entries: { ...held } };
    if (method === "users.prefs.set") {
      sets.push(params);
      const { entries } = params as { entries: Record<string, unknown> };
      Object.assign(held, entries);
      return { status: "ok" };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { request, sets, held };
}

describe("the clawtrate.used marker", () => {
  it("writes the app's version when the key is missing, held to its absence", async () => {
    const gateway = prefsGateway();
    expect(await markUsed({ ...gateway, canWrite: () => true }, "0.4.0")).toBe("written");
    expect(gateway.sets).toEqual([
      {
        entries: { [USED_PREF_KEY]: { version: "0.4.0" } },
        expectedEntries: { [USED_PREF_KEY]: null },
      },
    ]);
  });

  it("keeps the version that first wrote it: a later version writes nothing", async () => {
    const gateway = prefsGateway({ [USED_PREF_KEY]: { version: "0.4.0" } });
    expect(await markUsed({ ...gateway, canWrite: () => true }, "0.4.0")).toBe("current");
    expect(await markUsed({ ...gateway, canWrite: () => true }, "0.5.0")).toBe("current");
    expect(gateway.sets).toEqual([]);
    expect(gateway.held[USED_PREF_KEY]).toEqual({ version: "0.4.0" });
  });

  it("a person new under one build, who could write but not make the Main Bot, keeps that build's version on every later connection", async () => {
    // First connection: write access, no full control. The marker names this build.
    const gateway = prefsGateway();
    expect(await markUsed({ ...gateway, canWrite: () => true }, "0.6.0")).toBe("written");
    // Later, with full control, and after an update: the marker still names the first build,
    // so a first-run build of 0.6.0 or earlier never reads this person as "before".
    expect(await markUsed({ ...gateway, canWrite: () => true }, "0.7.0")).toBe("current");
    expect(gateway.held[USED_PREF_KEY]).toEqual({ version: "0.6.0" });
  });

  it("a read-only connection writes nothing", async () => {
    const gateway = prefsGateway();
    expect(await markUsed({ ...gateway, canWrite: () => false }, "0.4.0")).toBe("not-written");
    expect(gateway.sets).toEqual([]);
  });

  it("a connection with no preferences, or a version that isn't one, writes nothing", async () => {
    const sets: unknown[] = [];
    const none = async (method: string, params: unknown) => {
      if (method === "users.prefs.set") sets.push(params);
      return { status: "unavailable", reason: "no_durable_identity" };
    };
    expect(await markUsed({ request: none, canWrite: () => true }, "0.4.0")).toBe("not-written");
    const gateway = prefsGateway();
    expect(await markUsed({ ...gateway, canWrite: () => true }, "")).toBe("not-written");
    expect(await markUsed({ ...gateway, canWrite: () => true }, "x".repeat(65))).toBe(
      "not-written",
    );
    expect([...sets, ...gateway.sets]).toEqual([]);
  });

  it("a conflict leaves what another device wrote", async () => {
    const request = async (method: string) =>
      method === "users.prefs.get" ? { status: "ok", entries: {} } : { status: "conflict" };
    expect(await markUsed({ request, canWrite: () => true }, "0.4.0")).toBe("not-written");
  });
});

describe("the clawtrate.used marker on connecting", () => {
  /** A device that holds `scopes` for the gateway, as one paired earlier does. */
  async function connect(scopes: string[]) {
    const gateway = grantingGateway();
    const prefs = prefsGateway();
    gateway.handlers["users.prefs.get"] = (params) => prefs.request("users.prefs.get", params);
    gateway.handlers["users.prefs.set"] = (params) => prefs.request("users.prefs.set", params);
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: scopes,
        heldScopes: scopes,
      }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    return { client, gateway, prefs };
  }

  it("a connection that may write marks the person, once", async () => {
    const { client, prefs } = await connect(["operator.read", "operator.write"]);
    await until(() => prefs.sets.length === 1);
    expect(prefs.held[USED_PREF_KEY]).toEqual({ version: "0.0.0" });
    client.stop();
  });

  it("a read-only connection reads and writes nothing", async () => {
    const { client, gateway, prefs } = await connect(["operator.read"]);
    await until(() => gateway.calls("users.prefs.get").length > 0);
    await sleep(30);
    expect(prefs.sets).toEqual([]);
    expect(gateway.calls("users.prefs.set")).toEqual([]);
    client.stop();
  });
});
