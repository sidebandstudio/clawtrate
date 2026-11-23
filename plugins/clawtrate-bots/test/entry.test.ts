// The shipped entry, index.js, loaded as the gateway loads it: every other
// test builds the plugin through createBots with options of its own.

import { expect, it, vi } from "vitest";
import { memoryStore } from "./harness.ts";

type Json = Record<string, unknown>;
const dispatched: string[] = [];
vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod: async (method: string) => {
    dispatched.push(method);
    if (method === "config.get") return { ok: true, payload: { config: {}, hash: "h0" } };
    return { ok: true, payload: { agents: [{ id: "pip", createdAt: 2 }] } };
  },
}));

it("the shipped entry gets no Apply and dispatches only reads and its own config write", async () => {
  const handlers = new Map<string, (opts: Json) => Promise<void>>();
  (await import("../index.js")).default.register({
    registerGatewayMethod: (name: string, handler: (opts: Json) => Promise<void>) =>
      handlers.set(name, handler),
    registerReload: () => {},
    registerService: () => {},
    runtime: { state: { openKeyedStore: () => memoryStore() } },
  });
  const call = async (name: string, params: Json = {}) => {
    let answer: { ok: boolean; payload?: Json | undefined; error?: { details: Json } | undefined } =
      {
        ok: false,
      };
    await handlers.get(`clawtrate-bots.${name}`)!({
      params,
      acceptsSerializedJson: true,
      client: { connect: { role: "operator", device: { id: "d" } } },
      respond: (ok: boolean, payload?: Json, error?: { details: Json }) =>
        (answer = { ok, payload, error }),
    });
    return answer;
  };
  expect((await call("status")).payload!.apply).toEqual({
    available: false,
    reason: "incarnation",
  });
  const undo = await call("changes.undo", { id: `j:p_${"0".repeat(32)}:1:label` });
  expect(undo.error!.details.reason).toBe("undo-unavailable");
  expect((await call("changes.list")).payload!.changes).toEqual([]);
  await call("managers.set", { bots: ["pip"] });
  expect(new Set(dispatched)).toEqual(new Set(["agents.list", "config.get", "config.patch"]));
});
