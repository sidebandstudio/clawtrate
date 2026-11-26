// The client and the device approval engine (setup-effortless.md §5): an admin connection lists
// the waiting requests, an event reads them again, and a close takes them with it.
import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { ADMIN_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, URL_A } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

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

  it("forgets them when the person suspends the connection", async () => {
    const { client } = await adminClient([row("r1")]);
    await until(() => client.state.deviceRequests?.requests.length === 1);
    await client.suspend();
    expect(client.state.deviceRequests?.requests ?? []).toEqual([]);
    client.stop();
  });
});
