// Access that ends while the plugin waits on the browser. The gateway checks
// a caller's access when it admits the call, not when the plugin answers;
// and a retained access can stop holding before its abort is delivered
// (here: `revoked` set without the signal). So after every wait the plugin
// checks again, and on failure says nothing and retires what it had
// prepared for that caller.

import { describe, expect, it } from "vitest";
import { ATLAS_TAB, Access, FakeBrowser, load, until } from "./harness.ts";

const tab = { targetId: ATLAS_TAB };
const texts = (socket: { frames(): { opcode: number; payload: Buffer }[] }) =>
  socket.frames().filter((f) => f.opcode === 0x1);

/** A browser whose next target list waits until `release` is called. */
function gatedDiscovery() {
  const browser = new FakeBrowser();
  const original = browser.fetchImpl;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let gated = true;
  browser.fetchImpl = async (input, init) => {
    if (gated) {
      gated = false;
      entered();
      await gate;
    }
    return original(input, init);
  };
  return { browser, started, release };
}

const ended = (answer: { ok: boolean; error?: { code: string; details?: { reason?: string } } }) =>
  [answer.ok, answer.error?.code, answer.error?.details?.reason] as const;

describe("tabs", () => {
  for (const quiet of [false, true]) {
    it(`says nothing about the tabs when access ends during discovery${quiet ? " without a signal" : ""}`, async () => {
      const { browser, started, release } = gatedDiscovery();
      const h = load({ browser });
      const access = new Access();
      const answer = h.call("tabs", {}, { access });
      await started;
      if (quiet) access.revoked = true;
      else access.revoke();
      release();
      const result = await answer;
      expect(ended(result)).toEqual([false, "FORBIDDEN", "session_access_ended"]);
      expect(result.payload).toBeUndefined();
      await h.stop();
    });
  }

  it("says nothing when the caller's connection closes during discovery", async () => {
    const { browser, started, release } = gatedDiscovery();
    const h = load({ browser });
    const connection = new AbortController();
    const answer = h.call("tabs", {}, { connection });
    await started;
    connection.abort();
    release();
    expect((await answer).payload).toBeUndefined();
    await h.stop();
  });

  it("does not report a stopped browser to a caller whose access ended", async () => {
    const { browser, started, release } = gatedDiscovery();
    browser.lists.clear();
    const h = load({ browser });
    const access = new Access();
    const answer = h.call("tabs", {}, { access });
    await started;
    access.revoked = true;
    release();
    expect(ended(await answer)).toEqual([false, "FORBIDDEN", "session_access_ended"]);
    await h.stop();
  });
});

describe("view.open and view.renew", () => {
  it("issues no ticket when access ends while the tab is checked", async () => {
    const { browser, started, release } = gatedDiscovery();
    const h = load({ browser });
    const access = new Access();
    const answer = h.call("view.open", tab, { access });
    await started;
    access.revoked = true;
    release();
    const result = await answer;
    expect(ended(result)).toEqual([false, "FORBIDDEN", "session_access_ended"]);
    expect([h.state.streams.size, h.state.tickets.size]).toEqual([0, 0]);
    await h.stop();
  });

  it("issues no ticket when the access is already stale as it is retained", async () => {
    const h = load();
    const access = new Access();
    // Current when the request was admitted; stale by the time it is retained.
    let checks = 0;
    access.assertCurrent = () => {
      checks += 1;
      if (checks > 1) throw new Error("session access changed");
    };
    const result = await h.call("view.open", tab, { access });
    expect(ended(result)).toEqual([false, "FORBIDDEN", "session_access_ended"]);
    expect([h.state.streams.size, h.state.tickets.size]).toEqual([0, 0]);
    await h.stop();
  });

  it("a renewal after access quietly ended renews nothing and ends the caller's view and lease", async () => {
    const h = load();
    const access = new Access();
    const view = await h.call("view.open", tab, { access });
    const socket = await h.upgrade(String(view.payload!.wsPath));
    await until(() => h.browser.sent("Page.startScreencast").length === 1);
    const taken = await h.call("control.take", tab, { access });
    expect(taken.payload?.state).toBe("granted");
    access.revoked = true;
    const renewal = await h.call(
      "view.renew",
      { ...tab, streamId: view.payload!.streamId, generation: taken.payload!.generation },
      { access },
    );
    expect(ended(renewal)).toEqual([false, "FORBIDDEN", "session_access_ended"]);
    expect(socket.closeCode()).toEqual({ code: 4006, reason: "authority_revoked" });
    await until(() => h.state.leases.size === 0);
    expect(h.statesOf(taken.payload!.generation)).toEqual(["draining", "granted", "revoked"]);
    await h.stop();
  });

  it("a renewal by a current request does not renew a view whose retained access went stale", async () => {
    const h = load();
    const viewer = new Access();
    const view = await h.call("view.open", tab, { access: viewer });
    const socket = await h.upgrade(String(view.payload!.wsPath));
    await until(() => h.browser.sent("Page.startScreencast").length === 1);
    viewer.revoked = true;
    const renewal = await h.call("view.renew", { ...tab, streamId: view.payload!.streamId });
    expect(renewal.payload).toMatchObject({ streamRenewed: false });
    expect(socket.closeCode()).toEqual({ code: 4006, reason: "authority_revoked" });
    await h.stop();
  });
});

describe("control.take", () => {
  it("grants nothing when access quietly ends while the bot's call drains", async () => {
    const h = load();
    const access = new Access();
    await h.before("atlas", "run-a", "c1", { action: "act" });
    const take = h.call("control.take", tab, { access });
    await until(() => h.events.some((e) => e.state === "draining"));
    access.revoked = true;
    await h.after("atlas", "run-a", "c1");
    const result = await take;
    expect(ended(result)).toEqual([false, "FORBIDDEN", "session_access_ended"]);
    const [draining] = h.events;
    expect(h.statesOf(draining!.generation)).toEqual(["draining", "revoked"]);
    expect(h.state.leases.size).toBe(0);
    await h.stop();
  });

  it("says nothing about a busy bot to a caller whose access ended at the drain deadline", async () => {
    const h = load();
    const access = new Access();
    await h.before("atlas", "run-a", "c1", { action: "act" });
    const take = h.call("control.take", tab, { access });
    await until(() => h.events.some((e) => e.state === "draining"));
    access.revoked = true;
    const result = await take;
    expect(ended(result)).toEqual([false, "FORBIDDEN", "session_access_ended"]);
    expect(result.payload).toBeUndefined();
    expect(h.events.map((e) => e.state)).toEqual(["draining", "revoked"]);
    await h.stop();
  });

  for (const quiet of [false, true]) {
    it(`announces no grant when access ends while it connects to the tab${quiet ? " without a signal" : ""}`, async () => {
      const h = load();
      const access = new Access();
      h.browser.connectDelayMs = 80;
      const take = h.call("control.take", tab, { access });
      await until(() => h.browser.tabSockets.length > 0);
      if (quiet) access.revoked = true;
      else access.revoke();
      const result = await take;
      expect(result.payload?.state).toBeUndefined();
      expect(result.ok).toBe(false);
      expect(h.events.some((e) => e.state === "granted")).toBe(false);
      expect(h.events.at(-1)?.state).toBe("revoked");
      expect(h.state.leases.size).toBe(0);
      expect(h.browser.tabSockets.every((s) => s.closed)).toBe(true);
      expect(access.releases).toBe(1);
      await h.stop();
    });
  }
});

describe("the stream", () => {
  for (const quiet of [false, true]) {
    it(`sends no ready when access ends while it connects to the tab${quiet ? " without a signal" : ""}`, async () => {
      const h = load();
      const access = new Access();
      const view = await h.call("view.open", tab, { access });
      h.browser.connectDelayMs = 80;
      const upgrade = h.upgrade(String(view.payload!.wsPath));
      await until(() => h.browser.tabSockets.length > 0);
      if (quiet) access.revoked = true;
      else access.revoke();
      const socket = await upgrade;
      expect(texts(socket)).toEqual([]);
      expect(socket.closeCode()).toEqual({ code: 4006, reason: "authority_revoked" });
      expect(h.browser.sent("Page.startScreencast")).toEqual([]);
      expect(h.browser.sockets.every((s) => s.closed)).toBe(true);
      expect(h.state.streams.size).toBe(0);
      await h.stop();
    });
  }

  it("sends no later address once access has quietly ended", async () => {
    const h = load();
    const access = new Access();
    const view = await h.call("view.open", tab, { access });
    const socket = await h.upgrade(String(view.payload!.wsPath));
    await until(() => h.browser.sent("Page.startScreencast").length === 1);
    const cdp = h.browser.tabSockets.at(-1)!;
    expect(texts(socket)).toHaveLength(1);
    access.revoked = true;
    cdp.event("Page.frameNavigated", { frame: { id: "f", url: "http://127.0.0.1:9/after" } });
    expect(texts(socket)).toHaveLength(1);
    expect(socket.closeCode()).toEqual({ code: 4006, reason: "authority_revoked" });
    expect(cdp.closed).toBe(true);
    await h.stop();
  });
});

describe("no command to the browser, and no confirmation, once access has gone", () => {
  const pageCommands = (h: ReturnType<typeof load>) =>
    h.browser
      .sent("")
      .filter((e) => e.url.includes("/devtools/page/"))
      .map((e) => e.method);

  it("a take whose access quietly ends while it connects sends the tab no command at all", async () => {
    const h = load();
    const access = new Access();
    h.browser.connectDelayMs = 60;
    const take = h.call("control.take", tab, { access });
    await until(() => h.browser.tabSockets.length > 0);
    access.revoked = true;
    const answer = await take;
    expect(ended(answer)).toEqual([false, "FORBIDDEN", "session_access_ended"]);
    expect(pageCommands(h)).toEqual([]);
    expect(h.events.map((e) => e.state)).toEqual(["draining", "revoked"]);
    expect(h.state.leases.size).toBe(0);
    await h.stop();
  });

  it("a take whose access quietly ends during the quiet window sends no further stop", async () => {
    const h = load({ quietWindowMs: 150 });
    const access = new Access();
    const take = h.call("control.take", tab, { access });
    await until(() => h.browser.sent("Page.stopLoading").length === 2);
    access.revoked = true;
    // Activity in the window would make the take stop loading again.
    h.browser.tabSockets.at(-1)!.event("Page.frameStartedLoading", { frameId: "f" });
    const answer = await take;
    expect(ended(answer)).toEqual([false, "FORBIDDEN", "session_access_ended"]);
    expect(h.browser.sent("Page.stopLoading")).toHaveLength(2);
    expect(h.events.some((e) => e.state === "granted")).toBe(false);
    await h.stop();
  });

  it("input whose last reply arrives after access quietly ended is not confirmed, and the lease is not extended but ended", async () => {
    const h = load({ renewTimeoutMs: 400 });
    const access = new Access();
    const taken = await h.call("control.take", tab, { access });
    expect(taken.payload?.state).toBe("granted");
    h.browser.replyDelayMs = 80;
    const input = h.call(
      "input",
      { ...tab, generation: taken.payload!.generation, kind: "text", text: "late" },
      { access },
    );
    await until(() => h.browser.sent("Input.insertText").length === 1);
    access.revoked = true;
    const answer = await input;
    expect(ended(answer)).toEqual([false, "FORBIDDEN", "session_access_ended"]);
    expect(h.state.leases.size).toBe(0);
    expect(h.statesOf(taken.payload!.generation)).toEqual(["draining", "granted", "revoked"]);
    await h.stop();
  });

  it("a click whose access quietly ends between its commands sends none of the rest", async () => {
    const h = load();
    const access = new Access();
    const taken = await h.call("control.take", tab, { access });
    h.browser.replyDelayMs = 60;
    const input = h.call(
      "input",
      { ...tab, generation: taken.payload!.generation, kind: "click", x: 5, y: 5 },
      { access },
    );
    await until(() => h.browser.sent("Input.dispatchMouseEvent").length === 1);
    access.revoked = true;
    const answer = await input;
    expect(answer.ok).toBe(false);
    expect(h.browser.sent("Input.dispatchMouseEvent")).toHaveLength(1);
    expect(h.state.leases.size).toBe(0);
    await h.stop();
  });

  it("a release that waited for queued input answers only a caller whose access still holds", async () => {
    const h = load();
    const access = new Access();
    const taken = await h.call("control.take", tab, { access });
    const generation = taken.payload!.generation;
    h.browser.stalledMethods.add("Input.insertText");
    void h.call("input", { ...tab, generation, kind: "text", text: "stalled" }, { access });
    await until(() => h.browser.sent("Input.insertText").length === 1);
    const release = h.call("control.release", { ...tab, generation }, { access });
    access.revoked = true;
    const answer = await release;
    expect(ended(answer)).toEqual([false, "FORBIDDEN", "session_access_ended"]);
    // Released all the same: the bot is not left blocked.
    expect(h.state.leases.size).toBe(0);
    await h.stop();
  });

  it("a frame that arrives after access quietly ended is not acknowledged", async () => {
    const h = load();
    const access = new Access();
    const view = await h.call("view.open", tab, { access });
    const socket = await h.upgrade(String(view.payload!.wsPath));
    await until(() => h.browser.sent("Page.startScreencast").length === 1);
    access.revoked = true;
    h.browser.tabSockets.at(-1)!.event("Page.screencastFrame", { data: "AA==", sessionId: 3 });
    expect(h.browser.sent("Page.screencastFrameAck")).toEqual([]);
    expect(socket.closeCode()).toEqual({ code: 4006, reason: "authority_revoked" });
    await h.stop();
  });
});
