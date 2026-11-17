// N-01: deadlines on discovery, connection and every command reply;
// cancellation through every step; release, expiry and shutdown that complete
// with any transport stage stalled; and what retires streams and leases when
// a browser or profile is replaced.

import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { cdpTargets } from "../lib/cdp.js";
import { parseCdpUrl } from "../lib/config.js";
import { ATLAS, ATLAS_TAB, BROWSER_CONFIG, load, page, sleep, until } from "./harness.ts";

const tab = { targetId: ATLAS_TAB };
const TIMEOUTS = { discoveryMs: 200, connectMs: 200, commandMs: 200 };

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
});

const elapsed = async <T>(fn: () => Promise<T>) => {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
};

describe("deadlines", () => {
  it("discovery against a server that accepts and never answers ends at its deadline", async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => sockets.push(socket));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const bot = {
      agentId: "atlas",
      profile: "bot-atlas",
      ...parseCdpUrl(`http://127.0.0.1:${port}`),
    };
    const { ms } = await elapsed(() =>
      cdpTargets(bot, { timeouts: TIMEOUTS }).then(
        () => expect.unreachable(),
        (error: { reason: string }) => expect(error.reason).toBe("discovery_timeout"),
      ),
    );
    expect(ms).toBeLessThan(1500);
    for (const socket of sockets) socket.destroy();
  });

  it("a stalled discovery makes tabs answer 'not running' and other calls refuse, in time", async () => {
    const h = load({ timeouts: TIMEOUTS });
    h.browser.stallDiscovery = true;
    const tabs = await elapsed(() => h.call("tabs", {}));
    expect(tabs.value.payload).toMatchObject({
      browser: "not-running",
      reason: "discovery_timeout",
      tabs: [],
    });
    expect(tabs.ms).toBeLessThan(1500);
    for (const method of ["view.open", "control.take", "view.renew"]) {
      const answer = await elapsed(() => h.call(method, { ...tab, streamId: "x" }));
      expect(answer.value.error?.code, method).toBe("UNAVAILABLE");
      expect(answer.ms).toBeLessThan(1500);
    }
    expect(h.state.leases.size).toBe(0);
  });

  it("a stalled connection fails the take in time and grants nothing", async () => {
    const h = load({ timeouts: TIMEOUTS });
    h.browser.stallConnect = true;
    const { value, ms } = await elapsed(() => h.call("control.take", tab));
    expect(value.error?.details?.reason).toBe("control_request_ended");
    expect(ms).toBeLessThan(1500);
    expect(h.state.leases.size).toBe(0);
    const generation = h.events[0]!.generation;
    expect(h.statesOf(generation)).toEqual(["draining", "revoked"]);
    expect(h.browser.sockets.every((s) => s.closed)).toBe(true);
  });

  it("a stalled command reply fails the input in time", async () => {
    const h = load({ timeouts: TIMEOUTS });
    const generation = (await h.call("control.take", tab)).payload!.generation;
    h.browser.stalledMethods.add("Input.insertText");
    const { value, ms } = await elapsed(() =>
      h.call("input", { ...tab, generation, kind: "text", text: "x" }),
    );
    expect(value.error?.details?.reason).toBe("input_not_delivered");
    expect(value.error?.message).toMatch(/not answered in time/);
    expect(ms).toBeLessThan(1500);
  });
});

describe("cancellation", () => {
  it("a connection that finishes opening after its lease ended is closed at once and never used", async () => {
    const h = load({ timeouts: { ...TIMEOUTS, connectMs: 2000 } });
    h.browser.connectDelayMs = 300;
    const connection = new AbortController();
    const take = h.call("control.take", tab, { connection });
    await until(() => h.browser.sockets.length === 1);
    connection.abort();
    expect((await take).ok).toBe(false);
    await sleep(400);
    const [socket] = h.browser.sockets;
    expect(socket!.closed).toBe(true);
    expect(h.browser.sent()).toEqual([]);
    expect(h.state.leases.size).toBe(0);
  });

  it("a caller whose connection closes during the drain leaves nothing granted", async () => {
    const h = load();
    await h.before("atlas", "run-1", "c1", { action: "act" });
    const connection = new AbortController();
    const take = h.call("control.take", tab, { connection });
    await until(() => h.state.leases.size === 1);
    connection.abort();
    const answer = await take;
    expect(answer.ok).toBe(false);
    const generation = h.events[0]!.generation;
    expect(h.statesOf(generation)).toEqual(["draining", "revoked"]);
    expect(h.events.at(-1)!.reason).toBe("connection-closed");
    await h.after("atlas", "run-1", "c1");
    expect(h.state.leases.size).toBe(0);
    expect(h.browser.sockets).toEqual([]);
  });

  it("a holder whose connection closes loses its lease at once, and its views end", async () => {
    const h = load();
    const connection = new AbortController();
    const generation = (await h.call("control.take", tab, { connection })).payload!.generation;
    const view = await h.call("view.open", tab, { connection });
    const socket = await h.upgrade(String(view.payload!.wsPath));
    connection.abort();
    await until(() => h.statesOf(generation).includes("revoked"));
    expect(socket.closeCode()).toEqual({ code: 4006, reason: "authority_revoked" });
    expect(h.state.streams.size).toBe(0);
  });

  it("a caller that never uses its ticket and leaves ends its view", async () => {
    const h = load();
    const connection = new AbortController();
    const view = await h.call("view.open", tab, { connection });
    connection.abort();
    expect(h.state.streams.size).toBe(0);
    const socket = await h.upgrade(String(view.payload!.wsPath));
    expect(socket.status).toBe("HTTP/1.1 401 Unauthorized");
  });

  it("a call from a connection that has already closed is refused", async () => {
    const h = load();
    const connection = new AbortController();
    connection.abort();
    for (const method of ["view.open", "control.take"]) {
      expect((await h.call(method, tab, { connection })).error?.details?.reason, method).toBe(
        "connection_closed",
      );
    }
    expect(h.state.leases.size + h.state.streams.size).toBe(0);
  });
});

describe("release, expiry and shutdown complete with a stage stalled", () => {
  const stalledInput = async (h: ReturnType<typeof load>) => {
    const generation = (await h.call("control.take", tab)).payload!.generation;
    h.browser.stalledMethods.add("Input.insertText");
    const input = h.call("input", { ...tab, generation, kind: "text", text: "x" });
    await until(() => h.browser.sent("Input.").length === 1);
    return { generation, input };
  };

  it("release completes while a command is stalled", async () => {
    const h = load({ timeouts: { ...TIMEOUTS, commandMs: 10_000 } });
    const { generation, input } = await stalledInput(h);
    const { value, ms } = await elapsed(() => h.call("control.release", { ...tab, generation }));
    expect(value.ok).toBe(true);
    expect(ms).toBeLessThan(500);
    expect((await input).ok).toBe(false);
    expect((await h.before("atlas", "run-1", "c1", { action: "tabs" }))?.block).toBeUndefined();
  });

  it("release completes while discovery is stalled", async () => {
    const h = load({ timeouts: { ...TIMEOUTS, discoveryMs: 10_000 } });
    const generation = (await h.call("control.take", tab)).payload!.generation;
    h.browser.stallDiscovery = true;
    const { value, ms } = await elapsed(() => h.call("control.release", { ...tab, generation }));
    expect(value.payload?.state).toBe("released");
    expect(ms).toBeLessThan(500);
  });

  it("expiry completes while a command is stalled", async () => {
    const h = load({ timeouts: { ...TIMEOUTS, commandMs: 10_000 }, renewTimeoutMs: 150 });
    const { generation, input } = await stalledInput(h);
    await until(() => h.statesOf(generation).includes("expired"), 1000);
    expect((await input).ok).toBe(false);
    expect(h.state.leases.size).toBe(0);
  });

  it("shutdown completes while a take drains, a connection stalls and a command stalls", async () => {
    const h = load({ timeouts: { discoveryMs: 10_000, connectMs: 10_000, commandMs: 10_000 } });
    // A held tab with a stalled command…
    const { generation } = await stalledInput(h);
    // …a view whose connection never opens…
    h.browser.stallConnect = true;
    const view = await h.call("view.open", tab);
    const socket = await Promise.race([
      h.upgrade(String(view.payload!.wsPath)),
      sleep(50).then(() => null),
    ]);
    // …and a second bot's take waiting on a running call.
    await h.before("pixel", "run-p", "c-p", { action: "act" });
    const pixelTake = h.call(
      "control.take",
      { targetId: "B".repeat(32) },
      { agentId: "pixel", connId: "conn-P" },
    );
    await until(() => h.state.leases.size === 2);
    const { ms } = await elapsed(() => h.stop());
    expect(ms).toBeLessThan(1500);
    expect(h.state.leases.size).toBe(0);
    expect(h.state.streams.size).toBe(0);
    expect(h.statesOf(generation)).toEqual(["draining", "granted", "revoked"]);
    expect(
      h.events.filter((e) => e.state === "revoked").every((e) => e.reason === "plugin-stopped"),
    ).toBe(true);
    expect((await pixelTake).ok).toBe(false);
    void socket;
  });
});

describe("replacing a browser or a profile", () => {
  it("a tab that disappears from its browser ends its lease and views at the next look", async () => {
    const h = load();
    const generation = (await h.call("control.take", tab)).payload!.generation;
    const view = await h.call("view.open", tab);
    // The browser was replaced: same port, new targets.
    h.browser.lists.set("http://127.0.0.1:19113", [page("http://127.0.0.1:19113", "9".repeat(32))]);
    expect((await h.call("tabs", {})).payload?.tabs).toEqual([
      expect.objectContaining({ targetId: "9".repeat(32), lease: null }),
    ]);
    await until(() => h.statesOf(generation).includes("tab-closed"));
    expect(h.state.streams.has(String(view.payload!.streamId))).toBe(false);
  });

  it("the lease's own connection closing because the tab closed ends the lease as tab-closed", async () => {
    const h = load();
    const generation = (await h.call("control.take", tab)).payload!.generation;
    h.browser.lists.set(ATLAS, []);
    h.browser.sockets[0]!.close();
    await until(() => h.statesOf(generation).includes("tab-closed"));
    expect(h.events.at(-1)!.reason).toBe("target-closed");
  });

  it("the lease's own connection closing while the tab is still listed, or the browser is gone, is not reported as the tab closing", async () => {
    for (const browserGone of [false, true]) {
      const h = load();
      const generation = (await h.call("control.take", tab)).payload!.generation;
      if (browserGone) h.browser.lists.delete(ATLAS);
      h.browser.sockets[0]!.close();
      await until(() => h.statesOf(generation).includes("revoked"));
      expect(h.events.at(-1)!.reason, String(browserGone)).toBe("browser-unavailable");
      expect(h.statesOf(generation)).not.toContain("tab-closed");
      expect(h.state.leases.size).toBe(0);
      await h.stop();
    }
  });

  it("a bot's profile given another port in the gateway's config retires its leases and views, and refuses calls", async () => {
    const h = load();
    const generation = (await h.call("control.take", tab)).payload!.generation;
    const view = await h.call("view.open", tab);
    h.setCurrent({
      browser: {
        ...BROWSER_CONFIG.browser,
        profiles: { ...BROWSER_CONFIG.browser.profiles, "bot-atlas": { cdpPort: 19200 } },
      },
    });
    const answer = await h.call("tabs", {});
    expect(answer.error?.details?.reason).toBe("browser_config_mismatch");
    await until(() => h.statesOf(generation).includes("revoked"));
    expect(h.events.at(-1)!.reason).toBe("browser-config-changed");
    expect(h.state.streams.has(String(view.payload!.streamId))).toBe(false);
    expect((await h.before("atlas", "run-1", "c1", { action: "tabs" }))?.block).toBe(true);
  });

  it("stopping the plugin (a reload with a new config) retires what it created", async () => {
    const h = load();
    const generation = (await h.call("control.take", tab)).payload!.generation;
    await h.stop();
    expect(h.statesOf(generation)).toEqual(["draining", "granted", "revoked"]);
    expect(h.state.leases.size).toBe(0);
  });
});
