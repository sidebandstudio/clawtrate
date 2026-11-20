import { describe, expect, it } from "vitest";
import { deferred, GatewayError, until } from "./fake-gateway.ts";
import { grantingGateway, openTask } from "./client-harness.ts";

describe("the confirmed gateway identity", () => {
  it("F-189: an older refresh whose identity read fails does not clear what a newer one confirmed", async () => {
    const gateway = grantingGateway();
    const older = deferred<unknown>();
    let reads = 0;
    gateway.handlers["gateway.identity.get"] = () =>
      (reads += 1) === 2 ? older.promise : { deviceId: "gateway-1" };
    const { client } = await openTask({ gateway });
    await until(() => client.state.connection.gatewayId === "gateway-1");
    // Two refreshes on the same connection: the older one's identity read is held.
    const first = client.retryNow();
    await until(() => reads === 2);
    const second = client.retryNow();
    await second;
    await until(() => client.state.connection.gatewayId === "gateway-1");
    older.reject(new GatewayError({ code: "UNAVAILABLE", message: "timed out" }));
    await first;
    expect(client.state.connection.gatewayId).toBe("gateway-1");
    client.stop();
  });
});
