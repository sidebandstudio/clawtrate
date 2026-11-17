// A host pinned to the read tier (`ClientOptions.readOnly`): it asks for
// `operator.read` alone even when its stored token holds more, never asks the
// gateway's owner for more, and every write fails without reaching the gateway.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { FakeGateway, helloOk, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const URL_A = "ws://127.0.0.1:19001";
const KEY = "agent:otto:disk-space";

describe("a host pinned to the read tier", () => {
  it("connects at the read tier with an interactive token, and never asks for more", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => {
      const { scopes } = params as { scopes: string[] };
      return { ok: true, payload: helloOk(scopes, "device-token") };
    };
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "never" });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: INTERACTIVE_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
      }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), {
      reconnect: { initialMs: 20, maxMs: 40 },
      readOnly: true,
    });
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    expect((gateway.connects[0] as { scopes: string[] }).scopes).toEqual([...READ_SCOPES]);
    expect(client.state.connection).toMatchObject({
      requestedScopes: [...READ_SCOPES],
      canWrite: false,
      canAnswer: false,
      canApprove: false,
    });

    await expect(client.requestAccess()).rejects.toThrow(/only reads/);
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    client.sendMessage(KEY, "Clear the cache.");
    await until(() => client.state.transcripts[KEY]!.outbox[0]?.status === "failed");
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    expect(gateway.calls("chat.send")).toEqual([]);
    client.stop();
  });
});
