// What Connect on this computer asks for (docs/design/setup.md §7): read,
// always. A device with a saved pairing reconnects for setup asking for
// `operator.read` alone, whatever its saved record holds or comes to hold;
// every hello is held to the signed request; and a pairing-only upgrade
// adds pairing and nothing else, whatever the gateway grants.

import { describe, expect, it } from "vitest";
import { ClawtrateClient, SETUP_PAIRING_GONE } from "../src/client.ts";
import { PAIRING_SCOPE, READ_SCOPE, READ_SCOPES, WRITE_SCOPE } from "../src/scopes.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { FAST, URL_A } from "./client-harness.ts";
import {
  deferred,
  FakeGateway,
  gatedStorage,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19940";
type Connect = { scopes: string[]; auth?: Record<string, string> };

const record = (heldScopes: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ token: "device-token", grantedScopes: heldScopes, heldScopes, ...extra });

/** A gateway that grants `granted` to any device-token connect. */
function granting(granted: string[]) {
  const gateway = new FakeGateway();
  gateway.connectReply = () => ({ ok: true, payload: helloOk(granted, "device-token") });
  return gateway;
}

describe("a setup reconnect with a saved pairing", () => {
  it("F-492: a device that holds write asks for read alone, holds read, and keeps write saved for later ordinary connections", async () => {
    const gateway = granting([READ_SCOPE, WRITE_SCOPE]);
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE, WRITE_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectForSetup(URL);
    await until(() => client.state.discovery.status === "ready");
    expect((gateway.connects[0] as Connect).scopes).toEqual([READ_SCOPE]);
    expect((gateway.connects[0] as Connect).auth).toEqual({ deviceToken: "device-token" });
    expect(client.state.connection.scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.canWrite).toBe(false);
    expect(JSON.parse(storage.data.get(tokenKey(URL))!).heldScopes).toEqual([
      READ_SCOPE,
      WRITE_SCOPE,
    ]);
    // Setup is over: the next ordinary connection asks for what the device holds.
    gateway.dropAll();
    await until(
      () => gateway.connects.length === 2 && client.state.connection.status === "connected",
    );
    expect((gateway.connects[1] as Connect).scopes).toEqual([READ_SCOPE, WRITE_SCOPE]);
    expect(client.state.connection.canWrite).toBe(true);
    client.stop();
  });

  it("F-492: a device that holds pairing alone asks for read alone", async () => {
    const gateway = granting([READ_SCOPE, PAIRING_SCOPE]);
    const storage = memoryStorage({
      [tokenKey(URL)]: record([READ_SCOPE], { pairingHeld: true }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectForSetup(URL);
    await until(() => client.state.connection.status === "connected");
    expect((gateway.connects[0] as Connect).scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.scopes).toEqual([READ_SCOPE]);
    client.stop();
  });

  it("F-492: a wider record that appears after the dialog, before the request is signed, still asks for read alone", async () => {
    const gateway = granting([READ_SCOPE, WRITE_SCOPE]);
    const storage = gatedStorage({ [tokenKey(URL)]: record([READ_SCOPE]) });
    storage.hold(tokenKey(URL));
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    const connecting = client.connectForSetup(URL);
    await until(() => storage.waiting(tokenKey(URL)) > 0);
    storage.data.set(tokenKey(URL), record([READ_SCOPE, WRITE_SCOPE]));
    storage.release(tokenKey(URL));
    await connecting;
    await until(() => client.state.connection.status === "connected");
    for (const connect of gateway.connects)
      expect((connect as Connect).scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.canWrite).toBe(false);
    client.stop();
  });

  it("F-492: a saved pairing gone before the request is signed sends nothing and asks for a new consent", async () => {
    const gateway = granting([READ_SCOPE]);
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    storage.data.delete(tokenKey(URL));
    await client.connectForSetup(URL);
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe(SETUP_PAIRING_GONE);
    expect(gateway.connects).toEqual([]);
    await sleep(100);
    expect(gateway.connects).toEqual([]);
    client.stop();
  });

  it("F-492: a hello granting more than asked is held to the request, on a read-only host with a wider record too", async () => {
    const gateway = granting([READ_SCOPE, WRITE_SCOPE, "operator.approvals"]);
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE, WRITE_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), { ...FAST, readOnly: true });
    await client.start();
    await client.connect({ url: URL, token: null });
    await until(() => client.state.connection.status === "connected");
    expect((gateway.connects[0] as Connect).scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.canWrite).toBe(false);
    expect(client.state.connection.canApprove).toBe(false);
    client.stop();
  });

  it("F-492: a write grant supplies the read that was asked; an unasked scope never enters", async () => {
    const gateway = granting([WRITE_SCOPE]);
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: null });
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.canWrite).toBe(false);
    client.stop();
  });

  it("F-492: says whether this device has a saved pairing for an address", async () => {
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE, WRITE_SCOPE]) });
    const client = new ClawtrateClient(testHost(new FakeGateway(), storage), FAST);
    expect(await client.deviceAccess(URL)).toBe("paired");
    expect(await client.deviceAccess("ws://127.0.0.1:19960")).toBe("new");
  });
});

describe("an upgrade is held to what it asked for", () => {
  it("F-492: a pairing-only upgrade the gateway answers with write and approvals stores pairing and nothing more", async () => {
    const fake = new AccountsGateway();
    const wait = deferred<unknown>();
    fake.gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    fake.gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const { client, storage } = await accountsClient({ gateway: fake, scopes: READ_SCOPES });
    await client.requestAccess("pairing");
    await until(() => client.state.connection.upgrade.status === "pending");
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([
      { scopes: [READ_SCOPE, PAIRING_SCOPE] },
    ]);
    const wider = [READ_SCOPE, WRITE_SCOPE, "operator.approvals", PAIRING_SCOPE];
    wait.resolve({ status: "approved", requestId: "up-1", deviceToken: "rotated", scopes: wider });
    await until(() => JSON.parse(storage.data.get(tokenKey(URL_A))!).token === "rotated");
    const stored = JSON.parse(storage.data.get(tokenKey(URL_A))!);
    expect(stored.heldScopes).toEqual([READ_SCOPE, PAIRING_SCOPE]);
    expect(stored.grantedScopes).toEqual([READ_SCOPE, PAIRING_SCOPE]);
    expect(stored.adminHeld).toBeUndefined();
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.canWrite).toBe(false);
    client.stop();
  });
});
