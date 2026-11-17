// A take is granted only when the tab is quiet. A finished tool result or a
// stopped run does not prove that the gateway's browser work has settled,
// so the plugin stops loading at the browser and waits for the tab to stay
// quiet; if it cannot establish that within its deadline it grants nothing.
// (The real case, a cancelled navigation on a real gateway, is a computer
// check in `pnpm scenarios`.)

import { describe, expect, it } from "vitest";
import { ATLAS_TAB, load, until } from "./harness.ts";

const tab = { targetId: ATLAS_TAB };

describe("a take waits for a quiet tab", () => {
  it("stops loading at the browser, then grants after a whole quiet window", async () => {
    const h = load({ quietWindowMs: 150 });
    const asked = performance.now();
    const answer = await h.call("control.take", tab);
    const answered = performance.now();
    expect(answer.payload?.state).toBe("granted");
    const stops = h.browser.sent("Page.stopLoading");
    // On the lease's own connection to this tab: a stop before Page.enable
    // (which Chromium holds back while a navigation is pending), and one after.
    expect(stops.map((e) => e.url)).toEqual([
      `ws://127.0.0.1:19113/devtools/page/${ATLAS_TAB}`,
      `ws://127.0.0.1:19113/devtools/page/${ATLAS_TAB}`,
    ]);
    const enable = h.browser.sent("Page.enable")[0]!;
    expect(stops[0]!.t).toBeGreaterThan(asked);
    expect(stops[0]!.t).toBeLessThan(enable.t);
    expect(enable.t).toBeLessThan(stops[1]!.t);
    expect(answered - stops[1]!.t).toBeGreaterThanOrEqual(140);
    expect(h.statesOf(answer.payload!.generation)).toEqual(["draining", "granted"]);
    await h.stop();
  });

  it("stops again, and starts the window over, when a navigation starts or commits within it", async () => {
    const h = load({ quietWindowMs: 120, quietTimeoutMs: 3000 });
    const take = h.call("control.take", tab);
    // The stop before Page.enable, then one that opens a window: disturb each window once.
    let stops = 2;
    for (const method of ["Page.frameStartedLoading", "Page.frameNavigated"]) {
      await until(() => h.browser.sent("Page.stopLoading").length >= stops);
      h.browser.sockets.at(-1)!.event(method, { frameId: "f", frame: { id: "f", url: "x" } });
      stops += 1;
    }
    const answer = await take;
    expect(answer.payload?.state).toBe("granted");
    expect(h.browser.sent("Page.stopLoading")).toHaveLength(4);
    await h.stop();
  });

  it("refuses the take, busy because the browser is not quiet, when the tab keeps loading", async () => {
    const h = load({ quietWindowMs: 100, quietTimeoutMs: 600 });
    const take = h.call("control.take", tab);
    await until(() => h.browser.sockets.length > 0);
    const socket = h.browser.sockets.at(-1)!;
    const keepLoading = setInterval(
      () => socket.event("Page.frameStartedLoading", { frameId: "f" }),
      30,
    );
    let answer;
    try {
      answer = await take;
    } finally {
      clearInterval(keepLoading);
    }
    expect(answer.payload).toMatchObject({
      state: "busy",
      reason: "the bot's browser is still loading a page",
      runningCalls: 0,
    });
    const generation = answer.payload!.generation;
    expect(h.statesOf(generation)).toEqual(["draining", "busy"]);
    expect(h.events.find((e) => e.state === "busy")?.reason).toBe("browser-not-quiet");
    expect(h.state.leases.size).toBe(0);
    expect(socket.closed).toBe(true);
    // The bot is not left blocked.
    expect((await h.before("atlas", "run-a", "c1", { action: "tabs" }))?.block).toBeUndefined();
    await h.stop();
  });

  it("refuses the take in time when the browser holds back Page.enable (a navigation it could not stop)", async () => {
    const h = load({
      timeouts: { discoveryMs: 300, connectMs: 300, commandMs: 200 },
      quietTimeoutMs: 2000,
    });
    h.browser.stalledMethods.add("Page.enable");
    const answer = await h.call("control.take", tab);
    expect(answer.payload?.state).toBe("busy");
    expect(h.events.some((e) => e.state === "granted")).toBe(false);
    await h.stop();
  });

  it("refuses the take in time when the browser does not answer the stop", async () => {
    const h = load({
      timeouts: { discoveryMs: 300, connectMs: 300, commandMs: 200 },
      quietTimeoutMs: 2000,
    });
    h.browser.stalledMethods.add("Page.stopLoading");
    const started = performance.now();
    const answer = await h.call("control.take", tab);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(answer.payload?.state).toBe("busy");
    expect(h.events.some((e) => e.state === "granted")).toBe(false);
    expect(h.state.leases.size).toBe(0);
    await h.stop();
  });

  it("does not count the tab's own end of loading as activity", async () => {
    const h = load({ quietWindowMs: 120 });
    const take = h.call("control.take", tab);
    await until(() => h.browser.sent("Page.stopLoading").length >= 2);
    h.browser.sockets.at(-1)!.event("Page.frameStoppedLoading", { frameId: "f" });
    expect((await take).payload?.state).toBe("granted");
    expect(h.browser.sent("Page.stopLoading")).toHaveLength(2);
    await h.stop();
  });

  it("a caller that leaves while the tab is brought to rest is granted nothing", async () => {
    const h = load({ quietWindowMs: 300 });
    const connection = new AbortController();
    const take = h.call("control.take", tab, { connection });
    await until(() => h.browser.sent("Page.stopLoading").length >= 2);
    connection.abort();
    const answer = await take;
    expect(answer.error?.details?.reason).toBe("control_request_ended");
    expect(h.events.map((e) => e.state)).toEqual(["draining", "revoked"]);
    await h.stop();
  });

  it("stops listening to the tab's navigations once granted", async () => {
    const h = load();
    const answer = await h.call("control.take", tab);
    expect(answer.payload?.state).toBe("granted");
    const socket = h.browser.sockets.at(-1)!;
    // A person's own navigation after the grant changes nothing.
    socket.event("Page.frameStartedLoading", { frameId: "f" });
    socket.event("Page.frameNavigated", { frame: { id: "f", url: "x" } });
    expect(h.browser.sent("Page.stopLoading")).toHaveLength(2);
    expect(h.state.leases.values().next().value?.state).toBe("granted");
    await h.stop();
  });
});
