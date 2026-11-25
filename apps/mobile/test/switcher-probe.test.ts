import { afterEach, describe, expect, it, vi } from "vitest";
import { openSwitcherProbe } from "../src/switcher-probe.ts";

/** A socket that records what was opened and closes when told to. */
class FakeSocket {
  static opened: FakeSocket[] = [];
  onclose: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.opened.push(this);
  }
  close() {
    this.onclose?.();
  }
}

afterEach(() => {
  FakeSocket.opened = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the Simulator check's switcher probe", () => {
  it("opens another socket when one closes, and none once it is closed for good", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const stop = openSwitcherProbe(4321);
    expect(FakeSocket.opened.map((s) => s.url)).toEqual(["ws://127.0.0.1:4321"]);

    // The socket closes while the app is away from the front.
    FakeSocket.opened[0]!.onclose?.();
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.opened).toHaveLength(2);

    stop();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.opened).toHaveLength(2);
  });
});
