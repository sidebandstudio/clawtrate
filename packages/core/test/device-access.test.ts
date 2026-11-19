// Device access (`operator.pairing`) for Settings, Machines' paired devices
// (controls.md section 15): asked for only by name, on top of what the device
// holds, never by itself, and held once granted.
import { describe, expect, it } from "vitest";
import { parseBridgeCommand } from "../src/bridge.ts";
import { INTERACTIVE_SCOPES, PAIRING_SCOPE } from "../src/scopes.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { URL_A } from "./client-harness.ts";
import { deferred, tokenKey, until } from "./fake-gateway.ts";

describe("device access", () => {
  it("F-157: is asked for only by an explicit request, with the scopes already held, and held once granted", async () => {
    const fake = new AccountsGateway();
    const wait = deferred<unknown>();
    fake.gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-7" });
    fake.gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    fake.gateway.handlers["node.list"] = () => ({ nodes: [] });
    fake.gateway.handlers["config.get"] = () => ({ config: {}, hash: "c1" });
    fake.gateway.handlers["device.pair.list"] = () => ({
      paired: [{ deviceId: "dev-phone", displayName: "Clawtrate on iPhone", role: "operator" }],
    });
    const { client, storage } = await accountsClient({ gateway: fake, scopes: INTERACTIVE_SCOPES });
    // Reading the machines asks for nothing: devices say which access they need.
    const before = await client.readMachines();
    expect(before.devices).toEqual({ status: "needs-pairing" });
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    expect(fake.gateway.calls("device.pair.list")).toEqual([]);

    await client.requestAccess("pairing");
    await until(() => client.state.connection.upgrade.status === "pending");
    const wanted = [...INTERACTIVE_SCOPES, PAIRING_SCOPE];
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([{ scopes: wanted }]);
    wait.resolve({ status: "approved", requestId: "up-7", deviceToken: "rotated", scopes: wanted });
    await until(() => client.state.connection.scopes.includes(PAIRING_SCOPE));
    const stored = JSON.parse(storage.data.get(tokenKey(URL_A))!);
    expect(stored).toMatchObject({ pairingHeld: true, heldScopes: wanted });
    expect(stored.adminHeld).toBeUndefined();
    expect(client.state.connection.canAdmin).toBe(false);

    const after = await client.readMachines();
    expect(Array.isArray(after.devices) && after.devices.map((d) => d.name)).toEqual([
      "Clawtrate on iPhone",
    ]);
    // Every later connect asks for what was granted, and nothing more.
    fake.gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.scopes.includes(PAIRING_SCOPE),
    );
    const connects = fake.gateway.connects as Array<{ scopes: string[] }>;
    expect(connects.at(-1)!.scopes).toEqual(wanted);
    client.stop();
  });

  it("F-157: the bridge takes the request by name and nothing else", () => {
    expect(parseBridgeCommand({ type: "requestAccess", tier: "pairing" })).toEqual({
      type: "requestAccess",
      tier: "pairing",
    });
    expect(parseBridgeCommand({ type: "requestAccess", tier: "everything" })).toEqual({
      type: "requestAccess",
    });
    expect(() =>
      parseBridgeCommand({ type: "setMachineDefaults", machineId: "gateway", choice: "maybe" }),
    ).toThrow("invalid choice");
    expect(() =>
      parseBridgeCommand({ type: "setBotWorkspace", botId: "otto", path: "a\nb" }),
    ).toThrow();
  });
});
