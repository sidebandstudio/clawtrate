// Taking control, input and handing back: fail closed, the holder alone, one
// command at a time, and nothing landing after a lease ends.

import { describe, expect, it } from "vitest";
import { ATLAS_TAB, Access, load, sleep, until } from "./harness.ts";

const tab = { targetId: ATLAS_TAB };
const A = { connId: "conn-A" };
const B = { connId: "conn-B" };

async function granted(h: ReturnType<typeof load>, caller = A) {
  const answer = await h.call("control.take", tab, caller);
  expect(answer.payload?.state).toBe("granted");
  return String(answer.payload!.generation);
}

describe("C-02: taking control fails closed", () => {
  it("C-02a: a bot call still running at the drain deadline leaves no lease", async () => {
    const h = load();
    await h.before("atlas", "run-1", "slow-1", { action: "act" });
    const started = Date.now();
    const answer = await h.call("control.take", tab);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(answer.payload).toMatchObject({ state: "busy", runningCalls: 1 });
    expect(h.statesOf(answer.payload!.generation)).toEqual(["draining", "busy"]);
    expect(h.state.leases.size).toBe(0);
    // The bot is not blocked once the take has failed.
    expect((await h.before("atlas", "run-2", "c2", { action: "tabs" }))?.block).toBeUndefined();
    await h.after("atlas", "run-2", "c2");
    await h.after("atlas", "run-1", "slow-1");
    expect((await h.call("control.take", tab)).payload?.state).toBe("granted");
  });

  it("a call that ends during the drain lets the take through, and new calls are blocked while it waits", async () => {
    const h = load();
    await h.before("atlas", "run-1", "c1", { action: "act" });
    const take = h.call("control.take", tab);
    await until(() => h.state.leases.size === 1);
    const blocked = await h.before("atlas", "run-2", "c2", { action: "tabs" });
    expect(blocked?.blockReason).toBe(
      "A person has control of this bot's browser. Wait until they give it back.",
    );
    await h.after("atlas", "run-1", "c1");
    const answer = await take;
    expect(answer.payload?.state).toBe("granted");
    expect(h.statesOf(answer.payload!.generation)).toEqual(["draining", "granted"]);
  });

  it("a second take of a held or draining tab is refused", async () => {
    const h = load();
    await h.before("atlas", "run-1", "c1", { action: "act" });
    const first = h.call("control.take", tab, A);
    await until(() => h.state.leases.size === 1);
    const second = await h.call("control.take", tab, B);
    expect([second.error?.code, second.error?.details?.reason]).toEqual([
      "UNAVAILABLE",
      "control_held",
    ]);
    await h.after("atlas", "run-1", "c1");
    await first;
    expect((await h.call("control.take", tab, B)).error?.details?.reason).toBe("control_held");
  });
});

describe("C-03: only the holder, with the lease's generation", () => {
  it("C-03a: another connection cannot release, take or send input, with or without the generation", async () => {
    const h = load();
    const generation = await granted(h);
    for (const g of [undefined, generation]) {
      expect(
        (await h.call("control.release", { ...tab, generation: g }, B)).error?.details?.reason,
      ).toBe("not_holder");
      expect(
        (await h.call("input", { ...tab, generation: g, kind: "click", x: 1, y: 1 }, B)).error
          ?.details?.reason,
      ).toBe("not_holder");
    }
    expect(
      (await h.call("control.release", { ...tab, generation: "f".repeat(32) }, A)).error?.code,
    ).toBe("FORBIDDEN");
    const renew = await h.call("view.renew", { ...tab, generation }, B);
    expect(renew.payload).toMatchObject({ leaseRenewed: false });
    expect(h.statesOf(generation)).toEqual(["draining", "granted"]);
    expect((await h.call("control.release", { ...tab, generation }, A)).payload).toEqual({
      state: "released",
      generation,
      targetId: ATLAS_TAB,
    });
    expect(h.statesOf(generation)).toEqual(["draining", "granted", "released"]);
    // A refused release proves nothing: here the lease has already ended.
    expect(
      (await h.call("control.release", { ...tab, generation }, A)).error?.details?.reason,
    ).toBe("not_holder");
  });

  it("C-03b: input admitted under a lease cannot land under a replacement lease", async () => {
    const h = load();
    const generation = await granted(h, A);
    h.browser.replyDelayMs = 100;
    const pending = h.call("input", { ...tab, generation, kind: "click", x: 5, y: 5 }, A);
    await sleep(20);
    await h.call("control.release", { ...tab, generation }, A);
    h.browser.replyDelayMs = 0;
    const replacement = await h.call("control.take", tab, B);
    const grantedAt = performance.now();
    expect(replacement.payload?.state).toBe("granted");
    expect((await pending).ok).toBe(false);
    const inputs = h.browser.sent("Input.");
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((e) => e.t < grantedAt)).toBe(true);
  });

  it("the generation is 128 random bits, new for every lease, and every event carries it", async () => {
    const h = load();
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const generation = await granted(h);
      expect(generation).toMatch(/^[0-9a-f]{32}$/);
      seen.add(generation);
      await h.call("control.release", { ...tab, generation });
    }
    expect(seen.size).toBe(3);
    const control = h.events.filter((e) => e.name === "control");
    expect(
      control.every((e) => typeof e.generation === "string" && seen.has(e.generation as string)),
    ).toBe(true);
    expect(control.map((e) => [e.state, e.holder])).toEqual(
      Array.from({ length: 3 }, () => [
        ["draining", "user"],
        ["granted", "user"],
        ["released", "bot"],
      ]).flat(),
    );
  });
});

describe("N-02: input and its positive control", () => {
  it("a valid click, text and scroll are dispatched to the tab, in order", async () => {
    const h = load();
    const generation = await granted(h);
    for (const input of [
      { kind: "click", x: 120, y: 45.5 },
      { kind: "text", text: "hello" },
      { kind: "scroll", x: 10, y: 20, deltaY: 300 },
    ]) {
      expect((await h.call("input", { ...tab, generation, ...input })).payload).toEqual({
        ok: true,
      });
    }
    const sent = h.browser.sent("Input.").map((e) => [e.method, e.params]);
    expect(sent).toEqual([
      ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 120, y: 45.5 }],
      [
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: 120, y: 45.5, button: "left", buttons: 1, clickCount: 1 },
      ],
      [
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", x: 120, y: 45.5, button: "left", buttons: 0, clickCount: 1 },
      ],
      ["Input.insertText", { text: "hello" }],
      ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 10, y: 20, deltaX: 0, deltaY: 300 }],
    ]);
    // Every command went to the tab's own debugger URL.
    expect(new Set(h.browser.sent("Input.").map((e) => e.url))).toEqual(
      new Set([`ws://127.0.0.1:19113/devtools/page/${ATLAS_TAB}`]),
    );
  });

  it("refuses input of another kind, out of range or without control", async () => {
    const h = load();
    expect(
      (await h.call("input", { ...tab, generation: "0".repeat(32), kind: "click", x: 1, y: 1 }))
        .error?.details?.reason,
    ).toBe("not_holder");
    const generation = await granted(h);
    for (const bad of [
      { kind: "key", text: "a" },
      { kind: "click", x: -1, y: 1 },
      { kind: "click", x: Number.NaN, y: 1 },
      { kind: "click", x: 1 },
      { kind: "scroll", deltaY: 1e9 },
      { kind: "text", text: "" },
      { kind: "text", text: "x".repeat(2001) },
    ]) {
      expect(
        (await h.call("input", { ...tab, generation, ...bad })).error?.code,
        JSON.stringify(bad),
      ).toBe("INVALID_REQUEST");
    }
    expect(h.browser.sent("Input.")).toEqual([]);
  });

  it("serializes input at the command level: one input's commands never interleave with another's", async () => {
    const h = load();
    const generation = await granted(h);
    h.browser.replyDelayMs = 15;
    await Promise.all([
      h.call("input", { ...tab, generation, kind: "click", x: 1, y: 1 }),
      h.call("input", { ...tab, generation, kind: "click", x: 2, y: 2 }),
      h.call("input", { ...tab, generation, kind: "text", text: "z" }),
    ]);
    const xs = h.browser.sent("Input.").map((e) => e.params?.x ?? e.params?.text);
    expect(xs).toEqual([1, 1, 1, 2, 2, 2, "z"]);
  });

  it("release waits for input already sent, and nothing is sent after it", async () => {
    const h = load();
    const generation = await granted(h);
    h.browser.replyDelayMs = 50;
    const input = h.call("input", { ...tab, generation, kind: "click", x: 3, y: 3 });
    await until(() => h.browser.sent("Input.").length === 1);
    const released = await h.call("control.release", { ...tab, generation });
    const releasedAt = performance.now();
    expect(released.ok).toBe(true);
    expect((await input).error?.details?.reason).toBe("input_not_delivered");
    expect(h.browser.sent("Input.").length).toBe(1);
    expect(h.browser.sent("Input.").every((e) => e.t < releasedAt)).toBe(true);
    // The bot is unblocked only once the release has completed.
    expect((await h.before("atlas", "run-9", "c9", { action: "tabs" }))?.block).toBeUndefined();
  });

  it("delayed revocation of the session's access during input stops it before the next command", async () => {
    const h = load();
    const access = new Access();
    const take = await h.call("control.take", tab, { ...A, access });
    const generation = take.payload!.generation;
    h.browser.replyDelayMs = 40;
    const input = h.call(
      "input",
      { ...tab, generation, kind: "click", x: 1, y: 1 },
      { ...A, access },
    );
    await until(() => h.browser.sent("Input.").length === 1);
    access.revoke();
    expect((await input).ok).toBe(false);
    expect(h.browser.sent("Input.").length).toBe(1);
    await until(() => h.statesOf(generation).includes("revoked"));
    expect(h.state.leases.size).toBe(0);
  });
});

describe("N-02: revocation seen only when asked", () => {
  it("access revoked without an abort signal stops input before its next command", async () => {
    const h = load();
    const access = new Access();
    // The host's retained access may change without signalling: only assertCurrent says so.
    const quiet = Object.assign(access, {
      retain: () => ({
        signal: new AbortController().signal,
        assertCurrent: access.assertCurrent,
        release() {},
      }),
    });
    const generation = (await h.call("control.take", tab, { ...A, access: quiet })).payload!
      .generation;
    h.browser.replyDelayMs = 40;
    const input = h.call(
      "input",
      { ...tab, generation, kind: "click", x: 1, y: 1 },
      { ...A, access: quiet },
    );
    await until(() => h.browser.sent("Input.").length === 1);
    access.revoked = true;
    expect((await input).ok).toBe(false);
    expect(h.browser.sent("Input.").length).toBe(1);
    await until(() => h.statesOf(generation).includes("revoked"));
  });
});

describe("N-02: lease expiry", () => {
  it("a lease that is not renewed expires; renewing it keeps it", async () => {
    const h = load({ renewTimeoutMs: 150 });
    const generation = await granted(h);
    for (let i = 0; i < 4; i += 1) {
      await sleep(80);
      expect((await h.call("view.renew", { ...tab, generation })).payload?.leaseRenewed).toBe(true);
    }
    expect(h.state.leases.size).toBe(1);
    await until(() => h.statesOf(generation).includes("expired"), 1000);
    expect(h.statesOf(generation)).toEqual(["draining", "granted", "expired"]);
    expect((await h.call("view.renew", { ...tab, generation })).payload?.leaseRenewed).toBe(false);
    expect((await h.before("atlas", "run-1", "c1", { action: "tabs" }))?.block).toBeUndefined();
  });

  it("a renewal after the session's access was revoked ends the lease", async () => {
    const h = load();
    const access = new Access();
    const generation = (await h.call("control.take", tab, { ...A, access })).payload!.generation;
    access.revoke();
    await until(() => h.statesOf(generation).includes("revoked"));
    expect(h.events.find((e) => e.state === "revoked")?.reason).toBe("access-revoked");
  });
});
