import { describe, expect, it } from "vitest";
import { deferred, GatewayError, until } from "./fake-gateway.ts";
import { grantingGateway, openTask } from "./client-harness.ts";

describe("the confirmed gateway identity", () => {
  it("F-189: refreshes on one connection share its identity read, so an older one can't clear what a newer one confirmed", async () => {
    const gateway = grantingGateway();
    const held = deferred<unknown>();
    let reads = 0;
    // The first read fails, so the next refresh reads again, and that read is held.
    gateway.handlers["gateway.identity.get"] = () =>
      (reads += 1) === 1
        ? Promise.reject(new GatewayError({ code: "UNAVAILABLE", message: "timed out" }))
        : held.promise;
    const { client } = await openTask({ gateway });
    expect(client.state.connection.gatewayId).toBeNull();
    const first = client.retryNow();
    await until(() => reads === 2);
    const second = client.retryNow();
    held.resolve({ deviceId: "gateway-1" });
    await Promise.all([first, second]);
    expect(reads).toBe(2);
    expect(client.state.connection.gatewayId).toBe("gateway-1");
    client.stop();
  });
});
