import { describe, expect, it } from "vitest";
import {
  parseVoice,
  readVoice,
  setVoice,
  updateVoicePlugin,
  VOICE_CHANGED_EVENT,
  VOICE_GET,
  type BotVoiceAnswer,
} from "../src/voice.ts";
import { createBridgeSession } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, openTask, URL_A, URL_B } from "./client-harness.ts";
import type { helloOk } from "./fake-gateway.ts";
import { GatewayError, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const answer = {
  plugin: "clawtrate-voice",
  version: "0.1.0",
  on: false,
  changed: { at: 5 },
  hook: {
    state: "allowed",
    settings: { allowPromptInjection: true, allowConversationAccess: true },
    lastRanAt: 7,
  },
  guide: "Never use an em dash.",
};
/** The same plugin from 0.2.0, with the where-you-live guide. */
const newer = {
  ...answer,
  version: "0.2.0",
  where: { on: true, changed: null, guide: "## Where you live" },
};

describe("bot voice", () => {
  it("reads the setting as the voice plugin gives it", async () => {
    expect(await readVoice(async () => answer, true)).toEqual({
      status: "read",
      on: false,
      changedAt: 5,
      hook: "allowed",
      hookSettings: { allowPromptInjection: true, allowConversationAccess: true },
      lastRanAt: 7,
      guide: "Never use an em dash.",
      version: "0.1.0",
      // 0.1.0 has no where-you-live guide.
      where: null,
    });
    expect(parseVoice({ ...answer, changed: null }).changedAt).toBeNull();
    expect(
      parseVoice({ ...newer, where: { on: false, changed: { at: 9 }, guide: "## Where you live" } })
        .where,
    ).toEqual({ on: false, changedAt: 9, guide: "## Where you live" });
    // A plugin that doesn't report the two settings still reads; the hint names both.
    expect(parseVoice({ ...answer, hook: { state: "allowed" } }).hookSettings).toBeNull();
  });

  it("says the plugin is missing only when the gateway's hello or answer says so", async () => {
    const asked: string[] = [];
    const never = async (method: string) => {
      asked.push(method);
      return answer;
    };
    // The hello lists the gateway's methods, and the plugin's aren't among them: nothing is asked.
    await expect(readVoice(never, false)).resolves.toEqual({
      status: "missing",
    });
    expect(asked).toEqual([]);
    // An admin connection is told the method is unknown.
    await expect(
      readVoice(() => Promise.reject(new Error("unknown method: clawtrate-voice.get")), null),
    ).resolves.toEqual({ status: "missing" });
  });

  it("reports a scope refusal as access, not as a missing plugin", async () => {
    const missingAdmin = Object.assign(new Error("missing scope: operator.admin"), {
      details: { code: "MISSING_SCOPE", missingScope: "operator.admin" },
    });
    const refuse = () => Promise.reject(missingAdmin);
    // Listed in the hello, yet refused: a plugin of another version, asking for more.
    await expect(readVoice(refuse, true)).resolves.toEqual({
      status: "refused",
      advertised: true,
      message: "missing scope: operator.admin",
    });
    // No list in the hello: the plugin may be absent, or ask for more. Neither is claimed.
    await expect(readVoice(refuse, null)).resolves.toEqual({
      status: "refused",
      advertised: null,
      message: "missing scope: operator.admin",
    });
    await expect(readVoice(() => Promise.reject(new Error("timed out")), true)).rejects.toThrow(
      "timed out",
    );
  });

  it("refuses an answer it can't read rather than guessing", () => {
    for (const bad of [
      null,
      { ...answer, plugin: "other" },
      { ...answer, on: "yes" },
      { ...answer, hook: { state: "maybe" } },
      { ...answer, guide: "x".repeat(9000) },
      { ...newer, where: { on: "yes", guide: "" } },
      { ...newer, where: { on: true } },
      { ...newer, where: { on: true, guide: "x".repeat(9000) } },
      { ...newer, where: null },
    ])
      expect(() => parseVoice(bad)).toThrow(/can't read/);
  });

  it("sends only on or off, and shows what the gateway stored", async () => {
    const asked: unknown[] = [];
    const read = await setVoice(async (method, params) => {
      asked.push([method, params]);
      return { ...answer, on: true };
    }, true);
    expect(asked).toEqual([["clawtrate-voice.set", { on: true }]]);
    expect(read).toMatchObject({ status: "read", on: true });
  });

  it("asks the gateway to load an older plugin again, and leaves a current one alone", async () => {
    const asked: unknown[] = [];
    const request = async (method: string, params: unknown) => (asked.push([method, params]), {});
    expect(await updateVoicePlugin(request, parseVoice(newer))).toBe("current");
    expect(await updateVoicePlugin(request, { status: "missing" })).toBe("current");
    expect(asked).toEqual([]);
    expect(await updateVoicePlugin(request, parseVoice(answer))).toBe("reloaded");
    expect(asked).toEqual([["plugins.reload", { plugins: [{ pluginId: "clawtrate-voice" }] }]]);
    const refused = () => Promise.reject(new Error("missing scope: operator.admin"));
    expect(await updateVoicePlugin(refused, parseVoice(answer))).toEqual({
      failed: "missing scope: operator.admin",
    });
  });
});

describe("an older voice plugin, after a connect", () => {
  /** A device that holds admin access, as Clawtrate pairs one at first connect. */
  const adminStorage = () =>
    memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: ADMIN_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
        adminHeld: true,
      }),
    });
  /** A gateway whose plugin is `version` until a reload brings `after`. */
  const reloadingGateway = (after: Record<string, unknown> | null) => {
    const gateway = grantingGateway();
    const reply = gateway.connectReply;
    gateway.connectReply = (params, url) => {
      const hello = reply(params, url) as { ok: true; payload: ReturnType<typeof helloOk> };
      return {
        ...hello,
        payload: { ...hello.payload, features: { methods: [VOICE_GET], events: [] } },
      };
    };
    const reloads: unknown[] = [];
    let current: Record<string, unknown> = answer;
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gw-a" });
    gateway.handlers[VOICE_GET] = () => current;
    gateway.handlers["plugins.reload"] = (params) => {
      reloads.push(params);
      if (after) current = after;
      gateway.emit("plugins.changed", { generation: reloads.length + 1 });
      return { ok: true, restartRequired: false };
    };
    return { gateway, reloads };
  };

  it("is loaded again once, with admin access, and Settings then reads the newer one", async () => {
    const { gateway, reloads } = reloadingGateway(newer);
    const { client } = await openTask({ gateway, storage: adminStorage() });
    try {
      await until(() => reloads.length === 1);
      expect(reloads).toEqual([{ plugins: [{ pluginId: "clawtrate-voice" }] }]);
      expect(await client.readBotVoice()).toMatchObject({ where: { on: true } });
      // A reconnect finds it current: nothing more is asked.
      gateway.dropAll();
      await until(() => client.state.connection.status === "connected");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(reloads).toHaveLength(1);
    } finally {
      client.stop();
    }
  });

  it("is loaded again only once per version when its files are still older", async () => {
    const { gateway, reloads } = reloadingGateway(null);
    const { client } = await openTask({ gateway, storage: adminStorage() });
    try {
      await until(() => reloads.length === 1);
      gateway.dropAll();
      await until(() => client.state.connection.status === "connected");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(reloads).toHaveLength(1);
      expect(await client.readBotVoice()).toMatchObject({ version: "0.1.0", where: null });
    } finally {
      client.stop();
    }
  });

  it("is left alone below admin, and from a read-only viewer", async () => {
    for (const options of [
      { held: INTERACTIVE_SCOPES },
      { storage: adminStorage(), client: { readOnly: true } },
    ]) {
      const { gateway, reloads } = reloadingGateway(newer);
      const { client } = await openTask({ gateway, ...options });
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(reloads).toEqual([]);
      } finally {
        client.stop();
      }
    }
  });
});

describe("bot voice in the client", () => {
  const voiceGateway = (methods: string[]) => {
    const gateway = grantingGateway();
    const reply = gateway.connectReply;
    gateway.connectReply = (params, url) => {
      const hello = reply(params, url) as { ok: true; payload: ReturnType<typeof helloOk> };
      return { ...hello, payload: { ...hello.payload, features: { methods, events: [] } } };
    };
    return gateway;
  };
  const adminOnly = () => {
    throw new GatewayError({
      code: "FORBIDDEN",
      message: "missing scope: operator.admin",
      details: { code: "MISSING_SCOPE", missingScope: "operator.admin" },
    });
  };

  it("asks nothing when the hello leaves the plugin out", async () => {
    const gateway = voiceGateway(["health"]);
    let asked = 0;
    gateway.handlers[VOICE_GET] = () => ((asked += 1), answer);
    const { client } = await openTask({ gateway });
    try {
      expect(await client.readBotVoice()).toMatchObject({ status: "missing" });
      expect(asked).toBe(0);
    } finally {
      client.stop();
    }
  });

  it("counts the plugin's change event and plugins.changed, and forgets the hello's list after a plugin change", async () => {
    const gateway = voiceGateway([VOICE_GET]);
    gateway.handlers[VOICE_GET] = adminOnly;
    const { client } = await openTask({ gateway });
    try {
      // Listed in the hello: a refusal is about the plugin's version or access.
      expect(await client.readBotVoice()).toMatchObject({ status: "refused", advertised: true });
      const before = client.state.voiceChanges ?? 0;
      gateway.emit(VOICE_CHANGED_EVENT, {});
      await until(() => client.state.voiceChanges === before + 1);
      gateway.emit("plugins.changed", { generation: 2 });
      await until(() => client.state.voiceChanges === before + 2);
      // After a plugin change the hello's list no longer holds, so nothing is claimed.
      expect(await client.readBotVoice()).toMatchObject({ status: "refused", advertised: null });
    } finally {
      client.stop();
    }
  });
});

describe("bot voice, bound to where it was read", () => {
  /** A voice gateway that names itself `identity` and records every change sent to it. */
  const voiceGateway = (identity: string) => {
    const gateway = grantingGateway();
    const sets: unknown[] = [];
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: identity });
    gateway.handlers[VOICE_GET] = () => answer;
    gateway.handlers["clawtrate-voice.set"] = (params) => {
      sets.push(params);
      return { ...answer, on: (params as { on: boolean }).on };
    };
    return { gateway, sets };
  };

  it("refuses a change from a stale screen after a switch, even to a gateway with the same id", async () => {
    // Two gateways at two addresses that both say they are "gw-a".
    const a = voiceGateway("gw-a");
    const b = voiceGateway("gw-a");
    const token = JSON.stringify({
      token: "device-token",
      grantedScopes: INTERACTIVE_SCOPES,
      heldScopes: INTERACTIVE_SCOPES,
    });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: token,
      [tokenKey(URL_B)]: token,
    });
    const client = new ClawtrateClient(
      {
        ...testHost(a.gateway, storage),
        createWebSocket: (url: string) => (url === URL_B ? b : a).gateway.createWebSocket(url),
      },
      FAST,
    );
    await client.start();
    try {
      await until(() => client.state.connection.status === "connected");
      const shown = await client.readBotVoice();
      expect(shown.stamp).toEqual({ gatewayId: "gw-a", target: client.state.connection.target });
      // Another tab switches the host to the gateway at B.
      await client.connect({ url: URL_B });
      await until(
        () =>
          client.state.connection.status === "connected" &&
          client.state.connection.gatewayUrl === URL_B,
      );
      // The first tab's switch still shows what was read at A: its change goes nowhere.
      await expect(client.setBotVoice(false, shown.stamp)).rejects.toThrow();
      expect(a.sets).toEqual([]);
      expect(b.sets).toEqual([]);
      // Read at B now, a change made for B is sent to B.
      const now = await client.readBotVoice();
      expect(now.stamp.target).not.toBe(shown.stamp.target);
      expect(await client.setBotVoice(false, now.stamp)).toMatchObject({ on: false });
      expect(b.sets).toEqual([{ on: false }]);
      expect(a.sets).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("withdraws a viewer's change that was still unsent when the viewer went away", async () => {
    const { gateway, sets } = voiceGateway("gw-a");
    const { client } = await openTask({ gateway });
    try {
      const viewer = createBridgeSession(client);
      const shown = (await viewer.apply({ type: "readBotVoice" })) as BotVoiceAnswer;
      // The change is past the viewer and waiting on the same-gateway check when the tab
      // closes: it goes with the tab, unsent.
      const change = viewer.apply({ type: "setBotVoice", on: false, stamp: shown.stamp });
      viewer.dispose();
      await expect(change).rejects.toThrow(/withdrawn/);
      expect(sets).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("refuses a change made on a gateway that has since said it is another", async () => {
    const world = { identity: "gw-a" };
    const { gateway, sets } = voiceGateway("unused");
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: world.identity });
    const { client } = await openTask({ gateway });
    try {
      const shown = await client.readBotVoice();
      world.identity = "gw-b";
      gateway.dropAll();
      await until(
        () =>
          client.state.connection.status === "connected" &&
          client.state.connection.gatewayId === "gw-b",
      );
      await expect(client.setBotVoice(false, shown.stamp)).rejects.toThrow(/another gateway/);
      expect(sets).toEqual([]);
    } finally {
      client.stop();
    }
  });
});
