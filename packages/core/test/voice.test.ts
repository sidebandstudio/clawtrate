import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { readVoice, setVoice } from "../src/voice.ts";
import { FakeGateway, helloOk, testHost, until } from "./fake-gateway.ts";

describe("the plain voice setting", () => {
  it("asks nothing of a gateway whose hello does not list the plugin", async () => {
    const asked: string[] = [];
    const request = async (method: string) => void asked.push(method);
    expect(await readVoice(request, false)).toEqual({ plugin: false });
    expect(asked).toEqual([]);
  });

  it("shows only what the plugin answered", async () => {
    const answer = { plain: false, reachesBots: true, guide: "x" };
    const calls: unknown[] = [];
    const request = async (method: string, params: unknown) => {
      calls.push([method, params]);
      return answer;
    };
    expect(await readVoice(request, true)).toEqual({
      plugin: true,
      plain: false,
      reachesBots: true,
    });
    expect(await setVoice(request, true)).toMatchObject({ plain: false });
    expect(calls).toEqual([
      ["clawtrate-voice.get", {}],
      ["clawtrate-voice.set", { plain: true }],
    ]);
    await expect(readVoice(async () => ({ plain: "yes" }), true)).rejects.toThrow(
      /did not say whether/,
    );
  });

  it("F-523: a view reading the setting as the connection is published connected reads this gateway's plugin", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: {
        ...helloOk((params as { scopes: string[] }).scopes),
        features: { methods: ["clawtrate-voice.get"], events: [] },
      },
    });
    gateway.handlers["clawtrate-voice.get"] = () => ({
      plain: true,
      reachesBots: true,
      guide: "g",
    });
    const client = new ClawtrateClient(testHost(gateway));
    let read: Promise<unknown> | null = null;
    const stop = client.store.subscribe(() => {
      if (!read && client.state.connection.status === "connected") read = client.readVoice();
    });
    try {
      await client.connect({ url: "ws://127.0.0.1:19001", token: "t" });
      await until(() => read !== null);
      expect(await read).toEqual({ plugin: true, plain: true, reachesBots: true });
    } finally {
      stop();
      client.stop();
    }
  });
});
