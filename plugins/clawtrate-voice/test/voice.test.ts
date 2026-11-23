import { describe, expect, it } from "vitest";
import plugin, { GUIDE, PLUGIN_ID, createVoice, hookAllowed } from "../index.js";

type Reply = { ok: boolean; payload?: unknown; error?: { message: string } | undefined };
type Method = (opts: Record<string, unknown>) => Promise<void>;

function setup(config: unknown = { plugins: { entries: { [PLUGIN_ID]: allowed } } }) {
  const rows = new Map<string, unknown>();
  const store = {
    lookup: async (key: string) => rows.get(key),
    register: async (key: string, value: unknown) => void rows.set(key, value),
  };
  const hooks = new Map<string, () => Promise<unknown>>();
  const methods = new Map<string, { handler: Method; scope: string }>();
  const api = {
    config,
    on: (name: string, handler: () => Promise<unknown>) => hooks.set(name, handler),
    registerGatewayMethod: (name: string, handler: Method, opts: { scope: string }) =>
      methods.set(name, { handler, scope: opts.scope }),
  };
  createVoice(api, { store });
  const call = async (name: string, params: unknown, direct = true) => {
    let reply: Reply | undefined;
    await methods.get(`${PLUGIN_ID}.${name}`)!.handler({
      params,
      acceptsSerializedJson: direct,
      client: { connect: { role: "operator" } },
      context: { getRuntimeConfig: () => config },
      respond: (ok: boolean, payload?: unknown, error?: { message: string }) =>
        (reply = { ok, payload, error }),
    });
    return reply!;
  };
  return { hooks, methods, call, prompt: () => hooks.get("before_prompt_build")!() };
}

const allowed = { hooks: { allowConversationAccess: true } };

describe("clawtrate-voice", () => {
  it("adds the guide to the system prompt until a person turns it off", async () => {
    const voice = setup();
    expect(await voice.prompt()).toEqual({ appendSystemContext: GUIDE });
    expect((await voice.call("set", { plain: false })).payload).toEqual({
      plain: false,
      reachesBots: true,
      guide: GUIDE,
    });
    expect(await voice.prompt()).toBeUndefined();
    expect((await voice.call("get", {})).payload).toMatchObject({ plain: false });
    await voice.call("set", { plain: true });
    expect(await voice.prompt()).toEqual({ appendSystemContext: GUIDE });
  });

  it("reads at the read tier and changes only at admin", () => {
    const { methods } = setup();
    expect(Object.fromEntries([...methods].map(([name, { scope }]) => [name, scope]))).toEqual({
      "clawtrate-voice.get": "operator.read",
      "clawtrate-voice.set": "operator.admin",
    });
  });

  it("refuses a change that is not exactly on or off, or that does not come from a person", async () => {
    const voice = setup();
    for (const params of [{}, { plain: "no" }, { plain: false, extra: 1 }]) {
      expect((await voice.call("set", params)).ok).toBe(false);
    }
    expect((await voice.call("set", { plain: false }, false)).error?.message).toMatch(
      /person's own Clawtrate connection/,
    );
    expect(await voice.prompt()).toEqual({ appendSystemContext: GUIDE });
  });

  it("says the guide reaches no bot when the gateway keeps the hook from running", async () => {
    expect(hookAllowed({ plugins: { entries: { [PLUGIN_ID]: allowed } } })).toBe(true);
    expect(hookAllowed({})).toBe(false);
    expect(
      hookAllowed({
        plugins: {
          entries: {
            [PLUGIN_ID]: { hooks: { allowConversationAccess: true, allowPromptInjection: false } },
          },
        },
      }),
    ).toBe(false);
    expect((await setup({}).call("get", {})).payload).toMatchObject({
      plain: true,
      reachesBots: false,
    });
  });

  it("writes plainly itself: the guide has no em dash except the one it names", () => {
    expect(GUIDE.split("\u2014")).toHaveLength(2);
    expect(GUIDE).toContain("(\u2014)");
    expect(plugin.id).toBe(PLUGIN_ID);
  });
});
