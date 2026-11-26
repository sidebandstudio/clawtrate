// The client and the device approval engine (setup-effortless.md §5): an admin connection lists
// the waiting requests, an event reads them again, and a close takes them with it.
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/bytes.ts";
import { ClawtrateClient } from "../src/client.ts";
import { pairCode, rawPublicKey } from "../src/device-approval.ts";
import { gatewayStamp } from "../src/types.ts";
import { ADMIN_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, URL_A } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

/** A protected address: a setup code's first pairing there asks for all six scopes. */
const SETUP_URL = "wss://gateway.example:19950";
const KEY_B64 = "q3J8bW2xR5tY7uN0kP4sV6aD9fG1hL3zX8cB5nM2vQw";
const row = (requestId: string) => ({
  requestId,
  deviceId: "device-waiting",
  publicKey: KEY_B64,
  role: "operator",
  roles: ["operator"],
  scopes: ["operator.read"],
  ts: 1,
});

async function adminClient(pending: unknown[]) {
  const gateway = grantingGateway();
  gateway.handlers["device.pair.list"] = () => ({ pending, paired: [] });
  const storage = memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: JSON.stringify({
      token: "device-token",
      grantedScopes: ADMIN_SCOPES,
      heldScopes: ADMIN_SCOPES.filter((scope) => scope !== "operator.admin"),
      adminHeld: true,
    }),
  });
  const client = new ClawtrateClient(testHost(gateway, storage), FAST);
  await client.start();
  await until(() => client.state.connection.canAdmin);
  return { client, gateway, pending };
}

describe("waiting devices on the client", () => {
  it("lists them on an admin hello and reads again on a pairing event", async () => {
    const pending: unknown[] = [row("r1")];
    const { client, gateway } = await adminClient(pending);
    await until(() => client.state.deviceRequests?.requests.length === 1);
    expect(client.state.deviceRequests?.access).toBe("admin");
    pending.push({ ...row("r2"), deviceId: "device-other", ts: 2 });
    gateway.emit("device.pair.requested", { requestId: "r2" });
    await until(() => client.state.deviceRequests?.requests.length === 2);
    client.stop();
  });

  it("reads and publishes no list on a setup connection, though it holds admin", async () => {
    const gateway = grantingGateway();
    gateway.handlers["device.pair.list"] = () => ({ pending: [row("r1")], paired: [] });
    // The first read of bots is held, so the connection stays setup's.
    gateway.handlers["agents.list"] = () => new Promise(() => {});
    const host = { ...testHost(gateway, memoryStorage()), secureCredentials: async () => true };
    const client = new ClawtrateClient(host, FAST);
    await client.start();
    await client.connectWithSetupCode({
      url: SETUP_URL,
      bootstrapToken: "setup-bootstrap-0123456789abcdefghijklmnopqrstuvw",
      expiresAtMs: Date.now() + 600_000,
    });
    await until(() => gateway.calls("agents.list").length === 1);
    expect(client.state.connection.canAdmin).toBe(true);
    // A window's refresh, the path the hello and the events don't take.
    await client.readDeviceRequests();
    expect(gateway.calls("device.pair.list")).toEqual([]);
    expect(client.state.deviceRequests?.requests ?? []).toEqual([]);
    client.stop();
  });

  it("approves nothing on a decision read older than a Machines read that shows a shared code", async () => {
    // A request with a real key, so it offers codes; listed twice, its two copies share a code.
    const waiting = { ...row("r1"), deviceId: sha256Hex(rawPublicKey(KEY_B64)!) };
    const { client, gateway } = await adminClient([waiting]);
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gw-a" });
    gateway.handlers["node.list"] = () => ({ nodes: [] });
    gateway.handlers["config.get"] = () => ({ config: {}, hash: "h1" });
    await until(() => client.state.deviceRequests?.requests[0]?.blocked === null);
    let reads = 0;
    let releaseDecision: () => void = () => {};
    gateway.handlers["device.pair.list"] = async () => {
      const read = (reads += 1);
      // The decision's read again answers only after the Machines read's newer reply.
      if (read === 1) await new Promise<void>((resolve) => (releaseDecision = resolve));
      return { pending: read === 1 ? [waiting] : [waiting, { ...waiting, ts: 0 }], paired: [] };
    };
    await until(() => client.state.connection.gatewayId === "gw-a");
    const { listedOn } = client.state.deviceRequests!;
    const decision = client.approveDevice(
      "r1",
      pairCode(KEY_B64, "r1")!,
      ["operator.read"],
      listedOn,
      gatewayStamp(client.state.connection),
    );
    await until(() => reads === 1);
    await client.readMachines();
    expect(reads).toBe(2);
    releaseDecision();
    const outcome = await decision;
    expect(gateway.calls("device.pair.approve")).toEqual([]);
    expect(outcome).toEqual({ kind: "not-allowed" });
    expect(client.state.deviceRequests?.requests[0]?.blocked).toBe("same-code");
    client.stop();
  });

  it("lists a request already waiting once setup ends on the same connection, with no event", async () => {
    const gateway = grantingGateway();
    gateway.handlers["device.pair.list"] = () => ({ pending: [row("r1")], paired: [] });
    // The first read of bots, which ends setup, answers when the test says.
    const bots = gateway.handlers["agents.list"]!;
    let endSetup: () => void = () => {};
    const ended = new Promise<void>((resolve) => (endSetup = resolve));
    gateway.handlers["agents.list"] = async (params) => {
      await ended;
      return bots(params);
    };
    const host = { ...testHost(gateway, memoryStorage()), secureCredentials: async () => true };
    const client = new ClawtrateClient(host, FAST);
    await client.start();
    await client.connectWithSetupCode({
      url: SETUP_URL,
      bootstrapToken: "setup-bootstrap-0123456789abcdefghijklmnopqrstuvw",
      expiresAtMs: Date.now() + 600_000,
    });
    await until(() => gateway.calls("agents.list").length === 1);
    expect(client.state.connection.canAdmin).toBe(true);
    // While setup lasts, nothing is listed.
    expect(gateway.calls("device.pair.list")).toEqual([]);
    const connects = gateway.connects.length;
    endSetup();
    await until(() => client.state.deviceRequests?.requests.length === 1);
    expect(client.state.deviceRequests?.access).toBe("admin");
    // The same connection, and no event or refresh asked for it.
    expect(gateway.connects).toHaveLength(connects);
    client.stop();
  });

  it("forgets them when the person suspends the connection", async () => {
    const { client } = await adminClient([row("r1")]);
    await until(() => client.state.deviceRequests?.requests.length === 1);
    await client.suspend();
    expect(client.state.deviceRequests?.requests ?? []).toEqual([]);
    client.stop();
  });
});
