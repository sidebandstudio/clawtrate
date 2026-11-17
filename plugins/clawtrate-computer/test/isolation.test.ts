// Browser isolation: each configured bot acts only in its own profile on the
// host browser, and no other agent reaches a bot's profile. Rights to view and
// control come only from the admitted session's bot and its live tab list.

import { describe, expect, it } from "vitest";
import {
  ATLAS_SESSION,
  ATLAS_TAB,
  BASE_CONFIG,
  BROWSER_CONFIG,
  FOREIGN_TAB,
  PIXEL_SESSION,
  PIXEL_TAB,
  load,
} from "./harness.ts";

const withDefault = (defaultProfile: string) => ({
  browser: { ...BROWSER_CONFIG.browser, defaultProfile },
});

describe("R3-01: selectors are read the way the browser tool reads them", () => {
  it("R3-01a: an unconfigured agent cannot reach a bot profile by padding or case", async () => {
    const h = load();
    for (const profile of [
      " bot-atlas ",
      "bot-atlas\n",
      "\tbot-pixel",
      "BOT-ATLAS",
      " Bot-Pixel ",
    ]) {
      const result = await h.before("ledger", "run-l", "c1", { action: "snapshot", profile });
      expect(result?.block, JSON.stringify(profile)).toBe(true);
    }
    // The shared default profile stays usable for it.
    expect(
      (await h.before("ledger", "run-l", "c2", { action: "snapshot" }))?.block,
    ).toBeUndefined();
    expect(
      (await h.before("ledger", "run-l", "c3", { action: "snapshot", profile: "   " }))?.block,
    ).toBeUndefined();
  });

  it("R3-01b: a bot's profile as the browser default is refused, so an omitted profile never lands there", () => {
    for (const defaultProfile of ["bot-atlas", " bot-atlas ", "BOT-PIXEL"]) {
      expect(() => load({ hostConfig: withDefault(defaultProfile) }), defaultProfile).toThrow(
        /defaultProfile must not be a bot's profile/,
      );
    }
  });

  it("R3-01b: an omitted profile resolves to the current default; a default changed later is refused per call", async () => {
    const h = load();
    expect((await h.before("ledger", "run-l", "c1", { action: "tabs" }))?.block).toBeUndefined();
    h.setCurrent(withDefault("bot-atlas"));
    expect((await h.before("ledger", "run-l", "c2", { action: "tabs" }))?.block).toBe(true);
    // And the bots themselves stop, since the browser config no longer matches.
    expect((await h.before("atlas", "run-a", "c3", { action: "tabs" }))?.block).toBe(true);
  });

  it("R3-01c: a configured bot's padded or foreign profile is rewritten to its own", async () => {
    const h = load();
    const result = await h.before("atlas", "run-a", "c1", {
      action: " open ",
      url: "http://127.0.0.1:9/",
      profile: " bot-pixel ",
    });
    expect(result?.params).toEqual({
      action: "open",
      url: "http://127.0.0.1:9/",
      profile: "bot-atlas",
      target: "host",
    });
  });
});

describe("R3-02: bot calls are tracked by run id and tool call id together", () => {
  const take = (h: ReturnType<typeof load>) => h.call("control.take", { targetId: ATLAS_TAB });

  it("R3-02a: two bots' runs with the same call id are tracked separately", async () => {
    const h = load();
    await h.before("atlas", "run-atlas", "call_1", { action: "act" });
    await h.before("pixel", "run-pixel", "call_1", { action: "act" });
    await h.after("pixel", "run-pixel", "call_1");
    expect((await take(h)).payload?.state).toBe("busy");
  });

  it("R3-02b: two runs of one bot with the same call id are tracked separately", async () => {
    const h = load();
    await h.before("atlas", "run-a", "call_1", { action: "act" });
    await h.before("atlas", "run-b", "call_1", { action: "act" });
    await h.after("atlas", "run-b", "call_1");
    expect((await take(h)).payload?.state).toBe("busy");
    await h.after("atlas", "run-a", "call_1");
    expect((await take(h)).payload?.state).toBe("granted");
  });

  it("R3-02c: another agent's completion with the same ids does not clear a bot's call", async () => {
    const h = load();
    await h.before("atlas", "run-x", "call_1", { action: "act" });
    await h.after("ledger", "run-x", "call_1");
    expect((await take(h)).payload?.state).toBe("busy");
  });

  it("C-02b: a call without a run id or a call id is refused, not tracked", async () => {
    const h = load();
    expect((await h.before("atlas", "run-1", undefined, { action: "snapshot" }))?.block).toBe(true);
    expect((await h.before("atlas", undefined, "c1", { action: "snapshot" }))?.block).toBe(true);
    expect((await h.before("atlas", " ", " ", { action: "snapshot" }))?.block).toBe(true);
    expect((await take(h)).payload?.state).toBe("granted");
  });

  it("a cancelled call stops counting as running", async () => {
    const h = load();
    const abort = new AbortController();
    await h.before("atlas", "run-c", "call_c", { action: "act" }, { abortSignal: abort.signal });
    expect(h.state.inflight.size).toBe(1);
    abort.abort();
    expect(h.state.inflight.size).toBe(0);
  });
});

describe("R3-03: profile import", () => {
  it("R3-03: importprofile never writes into a bot's browser", async () => {
    const h = load();
    for (const params of [
      { action: "importprofile", into: "bot-pixel" },
      { action: "importprofile" },
      { action: " importprofile " },
      { action: "IMPORTPROFILE" },
    ]) {
      expect((await h.before("atlas", "run-a", "c1", params))?.block, JSON.stringify(params)).toBe(
        true,
      );
    }
    for (const into of ["bot-atlas", " bot-atlas ", "BOT-PIXEL"]) {
      expect(
        (await h.before("ledger", "run-l", "c1", { action: "importprofile", into }))?.block,
        into,
      ).toBe(true);
    }
    expect(
      (await h.before("ledger", "run-l", "c2", { action: "importprofile", into: "scratch" }))
        ?.block,
    ).toBeUndefined();
    expect(
      (await h.before("ledger", "run-l", "c3", { action: "importprofile" }))?.block,
    ).toBeUndefined();
  });

  it("R3-03: a bot profile named like the import default is refused", () => {
    expect(() =>
      load({
        config: { bots: { atlas: { profile: "imported", cdpUrl: "http://127.0.0.1:19113" } } },
        hostConfig: { browser: { profiles: { imported: { cdpPort: 19113 } } } },
      }),
    ).toThrow(/may not be "imported"/);
  });

  it("R3-03b: only tab actions are available to a bot", async () => {
    const h = load();
    for (const action of [
      "profiles",
      "stop",
      "download",
      "upload",
      "doctor",
      "requests",
      "errors",
      "emulate",
      "create-profile",
      undefined,
      "",
    ]) {
      expect((await h.before("atlas", "run-a", "c1", { action }))?.block, String(action)).toBe(
        true,
      );
    }
    for (const action of [
      "status",
      "start",
      "tabs",
      "open",
      "focus",
      "close",
      "snapshot",
      "screenshot",
      "navigate",
      "text",
      "act",
    ]) {
      const result = await h.before("atlas", "run-a", `c-${action}`, { action });
      expect(result?.params?.action, action).toBe(action);
      await h.after("atlas", "run-a", `c-${action}`);
    }
  });
});

describe("R3-05: routing is pinned to the host", () => {
  it("R3-05: an omitted or explicit host target is pinned; node, sandbox and dashboard routing are refused", async () => {
    const h = load();
    expect(
      (await h.before("atlas", "run-a", "c1", { action: "open", url: "http://127.0.0.1:9/" }))
        ?.params?.target,
    ).toBe("host");
    const host = await h.before("atlas", "run-a", "c2", { action: "tabs", target: " host " });
    expect([host?.block, host?.params?.target]).toEqual([undefined, "host"]);
    for (const params of [
      { action: "tabs", target: "sandbox" },
      { action: "tabs", target: "node" },
      { action: "tabs", node: "n1" },
      { action: "tabs", dashboard: "w1" },
      { action: "tabs", into: "x" },
    ]) {
      expect((await h.before("atlas", "run-a", "c3", params))?.block, JSON.stringify(params)).toBe(
        true,
      );
    }
    // Other agents may not use dashboards while bots have their own browsers.
    expect(
      (await h.before("ledger", "run-l", "c4", { action: "snapshot", dashboard: "w1" }))?.block,
    ).toBe(true);
  });

  it("runs before other hooks, for the browser tool only", () => {
    const h = load();
    const [entry] = h.hooks.get("before_tool_call")!;
    expect(entry!.opts).toEqual({ matcher: ["browser"], priority: 1000 });
  });

  it("warns when another hook ran a bot's call with another profile", async () => {
    const h = load();
    await h.before("atlas", "run-a", "c1", { action: "tabs" });
    await h.after("atlas", "run-a", "c1", { profile: "openclaw" });
    expect(h.warnings.some((w) => w.includes("ran with profile openclaw"))).toBe(true);
  });
});

describe("C-01: rights come from the session's bot and its live tab list, never from tool results", () => {
  it("C-01a: a tab list in a tool result grants nothing", async () => {
    const h = load();
    await h.hook(
      "after_tool_call",
      {
        toolName: "browser",
        runId: "r",
        toolCallId: "t1",
        result: { details: { tabs: [{ targetId: PIXEL_TAB }, { targetId: FOREIGN_TAB }] } },
      },
      { agentId: "atlas" },
    );
    for (const targetId of [PIXEL_TAB, FOREIGN_TAB]) {
      const answer = await h.call("view.open", { targetId });
      expect(answer.error?.details?.reason, targetId).toBe("tab_not_in_bots_browser");
    }
  });

  it("C-01b: a nested, page-controlled targetId in a result grants nothing", async () => {
    const h = load();
    await h.hook(
      "after_tool_call",
      {
        toolName: "browser",
        runId: "r",
        toolCallId: "t2",
        result: { details: { result: { targetId: FOREIGN_TAB } } },
      },
      { agentId: "atlas" },
    );
    expect((await h.call("view.open", { targetId: FOREIGN_TAB })).ok).toBe(false);
  });

  it("C-01c: one bot's session cannot list, view, take or renew another bot's tab", async () => {
    const h = load();
    const pixel = { agentId: "pixel", sessionKey: PIXEL_SESSION };
    const tabs = await h.call("tabs", {}, pixel);
    expect((tabs.payload?.tabs as { targetId: string }[]).map((t) => t.targetId)).toEqual([
      PIXEL_TAB,
    ]);
    for (const method of ["view.open", "control.take"]) {
      const answer = await h.call(method, { targetId: ATLAS_TAB }, pixel);
      expect([answer.error?.code, answer.error?.details?.reason], method).toEqual([
        "FORBIDDEN",
        "tab_not_in_bots_browser",
      ]);
    }
    expect((await h.call("view.renew", { targetId: ATLAS_TAB, streamId: "x" }, pixel)).ok).toBe(
      false,
    );
    expect(
      (await h.call("view.open", { targetId: ATLAS_TAB }, { sessionKey: ATLAS_SESSION })).ok,
    ).toBe(true);
  });

  it("C-01d: an unconfigured bot gets a distinct answer, and a call without session access is refused", async () => {
    const h = load();
    const answer = await h.call("tabs", {}, { agentId: "ledger" });
    expect([answer.error?.code, answer.error?.details?.reason]).toEqual([
      "UNAVAILABLE",
      "bot_not_configured",
    ]);
    const entry = h.methods.get("clawtrate-computer.tabs")!;
    let out: unknown;
    await entry.handler({
      params: {},
      client: { connId: "c" },
      respond: (...a: unknown[]) => (out = a),
    });
    expect((out as [boolean, unknown, { details: { reason: string } }])[2].details.reason).toBe(
      "session_access_required",
    );
  });

  it("every method is on the write tier with session access and the browser tool", () => {
    const h = load();
    expect([...h.methods.keys()].sort()).toEqual(
      ["control.release", "control.take", "input", "tabs", "view.open", "view.renew"].map(
        (m) => `clawtrate-computer.${m}`,
      ),
    );
    for (const { opts } of h.methods.values()) {
      expect(opts).toEqual({
        scope: "operator.write",
        sessionAccess: { mode: "write", requiredTool: "browser" },
      });
    }
  });
});

describe("configuration", () => {
  it("refuses unknown settings, bad bot entries, shared profiles or ports, and out-of-range timings", () => {
    const bad = [
      { ...BASE_CONFIG, extra: 1 },
      { bots: { atlas: { profile: "bot-atlas" } } },
      { bots: { atlas: { profile: "Bot Atlas", cdpUrl: "http://127.0.0.1:19113" } } },
      {
        bots: {
          atlas: { profile: "p", cdpUrl: "http://127.0.0.1:19113" },
          pixel: { profile: "p", cdpUrl: "http://127.0.0.1:19114" },
        },
      },
      {
        bots: {
          atlas: { profile: "a", cdpUrl: "http://127.0.0.1:19113" },
          pixel: { profile: "b", cdpUrl: "http://[::1]:19113" },
        },
      },
      { ...BASE_CONFIG, drainTimeoutMs: 10 },
      { ...BASE_CONFIG, renewTimeoutMs: 999999 },
    ];
    for (const config of bad) expect(() => load({ config }), JSON.stringify(config)).toThrow();
  });

  it("refuses a browser config that does not give each bot its own managed profile on its port", () => {
    const profiles = BROWSER_CONFIG.browser.profiles;
    const bad = [
      { profiles: { ...profiles, "bot-atlas": undefined } },
      { profiles: { ...profiles, "bot-atlas": { cdpPort: 19999 } } },
      {
        profiles: {
          ...profiles,
          "bot-atlas": { cdpPort: 19113, cdpUrl: "http://127.0.0.1:19113" },
        },
      },
      { profiles: { ...profiles, "bot-atlas": { cdpPort: 19113, driver: "existing-session" } } },
      { profiles: { ...profiles, other: { cdpPort: 19113 } } },
      { profiles: { ...profiles, other: { cdpUrl: "http://127.0.0.1:19114" } } },
      { profiles, cdpUrl: "http://127.0.0.1:19113" },
    ];
    for (const browser of bad) {
      expect(
        () => load({ hostConfig: { browser: { defaultProfile: "openclaw", ...browser } } }),
        JSON.stringify(browser),
      ).toThrow(/browser config/);
    }
  });
});
