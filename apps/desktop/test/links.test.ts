import { EventEmitter } from "node:events";
import type { ChatLinkDelivery } from "@clawtrate/core";
import { describe, expect, it, vi } from "vitest";
import { givesSwitch, LinkInbox, linkArgument } from "../src/main/links.ts";
import type { DesktopHostApi } from "../src/preload/index.ts";
import { createDesktopBridge } from "../src/renderer/bridge-desktop.ts";

const GATEWAY = "ab".repeat(32);
const LINK = `clawtrate://chat?bot=marlow&gateway=${GATEWAY}&text=Hi`;

describe("links from the operating system", () => {
  it("F-248: takes the link from after `--`, as the registered command passes it, and nothing else", () => {
    expect(linkArgument(["/app/Clawtrate", "--", LINK])).toBe(LINK);
    // Switches Chromium adds, and those of a development launch, come before it.
    expect(
      linkArgument([
        "/app/Clawtrate",
        "--allow-file-access-from-files",
        "/path/to/app",
        "--",
        LINK,
      ]),
    ).toBe(LINK);
    // Without `--` an argument is no link: Chromium has read its switches already.
    expect(linkArgument(["/app/Clawtrate", LINK])).toBeNull();
    expect(linkArgument(["/app/Clawtrate", "/path/to/app", "--user-data-dir=/tmp/x"])).toBeNull();
    expect(linkArgument(["/app/Clawtrate", "--"])).toBeNull();
    expect(linkArgument(["/app/Clawtrate", "--", "https://example.com/clawtrate:"])).toBeNull();
    expect(linkArgument([])).toBeNull();
    // Another case is still a link, so it is shown as invalid rather than ignored.
    expect(linkArgument(["/app/Clawtrate", "--", "CLAWTRATE://chat?x"])).toBe("CLAWTRATE://chat?x");
  });

  it("F-248: a link Windows split into several arguments is one invalid link, and passes no switch", () => {
    // A link with a quote in it, as `"<app>" -- "%1"` hands it over once Windows splits it.
    const split = ["/app/Clawtrate", "--", `${LINK}`, "--user-data-dir=/tmp/other", "--x"];
    const raw = linkArgument(split);
    expect(raw).toBe(`${LINK} --user-data-dir=/tmp/other --x`);
    const inbox = new LinkInbox(() => {});
    inbox.receive(raw!);
    expect(inbox.take()).toEqual({ id: 1, status: "invalid" });
    // Only the first `--` ends the switches; a later one is part of the link.
    expect(linkArgument(["/app/Clawtrate", "--", LINK, "--", "x"])).toBe(`${LINK} -- x`);
  });

  it("F-248: a piece of a split link that looks like a switch does not make the launch automated", () => {
    const split = ["/app/Clawtrate", "--", LINK, "--remote-debugging-port=0", "--inspect"];
    expect(givesSwitch(split, "remote-debugging-port")).toBe(false);
    expect(givesSwitch(split, "inspect")).toBe(false);
    expect(
      givesSwitch(
        ["/app/Clawtrate", "--", "--clawtrate-setup-sandbox=/tmp/x"],
        "clawtrate-setup-sandbox",
      ),
    ).toBe(false);
    // Before `--`, with or without a value, it is one.
    expect(
      givesSwitch(
        ["/app/Clawtrate", "--remote-debugging-port=0", "--", LINK],
        "remote-debugging-port",
      ),
    ).toBe(true);
    expect(givesSwitch(["/app/Clawtrate", "--inspect"], "inspect")).toBe(true);
    // Another switch that starts the same is not it.
    expect(givesSwitch(["/app/Clawtrate", "--inspect-brk"], "inspect")).toBe(false);
  });

  it("F-248: holds the latest link, validated, until the window takes it once", () => {
    let told = 0;
    const inbox = new LinkInbox(() => (told += 1));
    expect(inbox.take()).toBeNull();
    inbox.receive(LINK);
    inbox.receive(`${LINK}&send=1`);
    expect(told).toBe(2);
    expect(inbox.take()).toEqual({ id: 2, status: "invalid" });
    expect(inbox.take()).toBeNull();
    inbox.receive(LINK);
    expect(inbox.take()).toEqual({
      id: 3,
      status: "valid",
      link: { bot: "marlow", gateway: GATEWAY, text: "Hi" },
    });
  });

  it("F-248: refuses a link without logging it", () => {
    const logged = (["debug", "error", "info", "log", "trace", "warn"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    );
    try {
      const inbox = new LinkInbox(() => {});
      inbox.receive(`${LINK}%C3`);
      expect(inbox.take()).toEqual({ id: 1, status: "invalid" });
      for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

const sent = (id: number, text: string): ChatLinkDelivery => ({
  id,
  status: "valid",
  link: { bot: "marlow", gateway: GATEWAY, text },
});
const invalid = (id: number): ChatLinkDelivery => ({ id, status: "invalid" });

/** The preload's API over a fake `ipcRenderer`, whose takes wait for the test's answers. */
async function preload() {
  const waiting: { resolve(link: ChatLinkDelivery | null): void; reject(error: Error): void }[] =
    [];
  const events = Object.assign(new EventEmitter(), {
    invoke: vi.fn(
      (..._args: unknown[]) =>
        new Promise<ChatLinkDelivery | null>((resolve, reject) =>
          waiting.push({ resolve, reject }),
        ),
    ),
  });
  const expose = vi.fn();
  vi.resetModules();
  vi.doMock("electron", () => ({
    ipcRenderer: events,
    contextBridge: { exposeInMainWorld: expose },
  }));
  await import("../src/preload/index.ts");
  const api: DesktopHostApi = expose.mock.calls[0]![1];
  /** Answer the take on its way, the only one there may be, and let the page act on it. */
  const answer = async (link: ChatLinkDelivery | null | Error) => {
    expect(waiting, "one take at a time").toHaveLength(1);
    const take = waiting.shift()!;
    if (link instanceof Error) take.reject(link);
    else take.resolve(link);
    await Promise.resolve();
  };
  return { api, events, waiting, answer };
}

describe("links in the page", () => {
  it("F-248: the page takes a link waiting from before it loaded, then each one announced", async () => {
    const { api, events, waiting, answer } = await preload();
    const received: ChatLinkDelivery[] = [];
    const stop = api.onChatLink((link) => received.push(link));
    await answer(sent(1, "Hi"));
    expect(received).toEqual([sent(1, "Hi")]);
    events.emit("clawtrate:link", {});
    await answer(null);
    events.emit("clawtrate:link", {});
    await answer(invalid(2));
    expect(received).toEqual([sent(1, "Hi"), invalid(2)]);
    // Only the channel crosses: the page sends nothing of its own.
    expect(events.invoke.mock.calls).toEqual(Array(3).fill(["clawtrate:link:take"]));
    stop();
    expect(events.listenerCount("clawtrate:link")).toBe(0);
    expect(waiting).toHaveLength(0);
  });

  it("F-248: asks while a take is on its way make one more take, and only its newer link is handed over", async () => {
    const { api, events, waiting, answer } = await preload();
    const listener = vi.fn();
    api.onChatLink(listener);
    events.emit("clawtrate:link", {});
    events.emit("clawtrate:link", {});
    api.onChatLink(() => {})();
    expect(events.invoke).toHaveBeenCalledOnce();
    await answer(sent(3, "Older"));
    expect(listener, "held for the take asked for meanwhile").not.toHaveBeenCalled();
    await answer(sent(4, "Newer"));
    expect(listener.mock.calls).toEqual([[sent(4, "Newer")]]);
    expect(events.invoke).toHaveBeenCalledTimes(2);
    expect(waiting).toHaveLength(0);
  });

  it("F-248: a subscription made while an older take is on its way gets the newer link waiting, not the older", async () => {
    const { api, answer } = await preload();
    const gone = vi.fn();
    api.onChatLink(gone)();
    const fresh = vi.fn();
    api.onChatLink(fresh);
    await answer(sent(5, "Older"));
    expect(fresh).not.toHaveBeenCalled();
    await answer(sent(6, "Newer"));
    expect(fresh.mock.calls).toEqual([[sent(6, "Newer")]]);
    expect(gone).not.toHaveBeenCalled();
  });

  it("F-248: when the take asked for meanwhile brings nothing or fails, the link taken before still arrives", async () => {
    const { api, events, waiting, answer } = await preload();
    const listener = vi.fn();
    api.onChatLink(listener);
    events.emit("clawtrate:link", {});
    await answer(sent(7, "Taken"));
    await answer(null);
    expect(listener.mock.calls).toEqual([[sent(7, "Taken")]]);
    events.emit("clawtrate:link", {});
    events.emit("clawtrate:link", {});
    await answer(sent(8, "Taken too"));
    await answer(new Error("No handler registered for 'clawtrate:link:take'"));
    expect(listener.mock.calls).toEqual([[sent(7, "Taken")], [sent(8, "Taken too")]]);
    // A failed take is not tried again on its own.
    expect(waiting).toHaveLength(0);
    expect(events.invoke).toHaveBeenCalledTimes(4);
  });

  it("F-248: a link taken with no one subscribed waits for the next subscription, which asks first", async () => {
    const { api, answer } = await preload();
    api.onChatLink(() => {})();
    await answer(sent(9, "Waiting"));
    const next = vi.fn();
    const stopNext = api.onChatLink(next);
    expect(next, "not before its own take answers").not.toHaveBeenCalled();
    await answer(null);
    expect(next.mock.calls).toEqual([[sent(9, "Waiting")]]);
    stopNext();
    // A newer link the main process holds replaces the one waiting here.
    api.onChatLink(() => {})();
    await answer(sent(10, "Replaced"));
    const last = vi.fn();
    api.onChatLink(last);
    await answer(sent(11, "Newest"));
    expect(last.mock.calls).toEqual([[sent(11, "Newest")]]);
    expect(next).toHaveBeenCalledOnce();
  });

  it("F-248: a link goes to the listeners there are as it is handed over: none closed meanwhile, none added by a call", async () => {
    const { api, answer } = await preload();
    let stopSecond = () => {};
    const added = vi.fn();
    const first = vi.fn(() => {
      stopSecond();
      api.onChatLink(added);
    });
    const second = vi.fn();
    api.onChatLink(first);
    stopSecond = api.onChatLink(second);
    await answer(null);
    await answer(sent(12, "Now"));
    expect(first.mock.calls).toEqual([[sent(12, "Now")]]);
    expect(second, "closed by the first listener").not.toHaveBeenCalled();
    expect(added, "added by the first listener").not.toHaveBeenCalled();
    // The added subscription's own take finds nothing newer, and the link is not given twice.
    await answer(null);
    expect(added).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledOnce();
  });

  it("F-248: a listener that throws, or a take that fails, leaves the others their link and no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { api, events, answer } = await preload();
      const throws = vi.fn(() => {
        throw new Error("screen gone");
      });
      const other = vi.fn();
      api.onChatLink(throws);
      api.onChatLink(other);
      await answer(null);
      await answer(invalid(1));
      expect(throws).toHaveBeenCalledOnce();
      expect(other.mock.calls).toEqual([[invalid(1)]]);
      events.emit("clawtrate:link", {});
      await answer(new Error("No handler registered for 'clawtrate:link:take'"));
      // One turn of the event loop, after which Node reports any rejection left unhandled.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("F-248: the renderer's bridge hands its listener to the preload and returns its stop", async () => {
    const stop = () => {};
    const onChatLink = vi.fn(() => stop);
    const api = {
      hello: async () => ({ info: {}, state: {} }),
      onState: () => () => {},
      onChatLink,
    };
    const bridge = await createDesktopBridge(api as unknown as DesktopHostApi);
    const listener = () => {};
    expect(bridge.onChatLink?.(listener)).toBe(stop);
    expect(onChatLink).toHaveBeenCalledWith(listener);
  });
});
