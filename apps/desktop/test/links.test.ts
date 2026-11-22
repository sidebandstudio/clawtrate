import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { givesSwitch, LinkInbox, linkArgument } from "../src/main/links.ts";
import type { DesktopHostApi } from "../src/preload/index.ts";

const GATEWAY = "ab".repeat(32);
const LINK = `clawtrate://chat?bot=marlow&gateway=${GATEWAY}&text=Hi`;

describe("links from the operating system", () => {
  it("F-248: takes the link from after `--`, as the installer's command passes it, and nothing else", () => {
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

  it("F-248: the page takes a link waiting from before it loaded, then each one announced", async () => {
    const waiting = [{ id: 1, status: "invalid" }, null, { id: 2, status: "invalid" }];
    const events = Object.assign(new EventEmitter(), {
      invoke: vi.fn(async () => waiting.shift() ?? null),
    });
    const expose = vi.fn();
    vi.resetModules();
    vi.doMock("electron", () => ({
      ipcRenderer: events,
      contextBridge: { exposeInMainWorld: expose },
    }));
    await import("../src/preload/index.ts");
    const api: DesktopHostApi = expose.mock.calls[0]![1];
    const received: unknown[] = [];
    const stop = api.onChatLink((link) => received.push(link));
    await vi.waitFor(() => expect(received).toEqual([{ id: 1, status: "invalid" }]));
    events.emit("clawtrate:link", {});
    events.emit("clawtrate:link", {});
    await vi.waitFor(() => expect(events.invoke).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toEqual({ id: 2, status: "invalid" });
    // Only the channel crosses: the page sends nothing of its own.
    for (const call of events.invoke.mock.calls) expect(call).toEqual(["clawtrate:link:take"]);
    stop();
    expect(events.listenerCount("clawtrate:link")).toBe(0);
  });
});
