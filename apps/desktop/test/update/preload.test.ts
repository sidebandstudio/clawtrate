import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { DesktopHostApi } from "../../src/preload/index.ts";

it("delivers each update to later subscribers when the first throws", async () => {
  const events = new EventEmitter();
  const expose = vi.fn();
  vi.doMock("electron", () => ({
    ipcRenderer: events,
    contextBridge: { exposeInMainWorld: expose },
  }));
  await import("../../src/preload/index.ts");
  const api: DesktopHostApi = expose.mock.calls[0]![1];
  const first = vi.fn(() => {
    throw Error("subscriber closed");
  });
  const later = vi.fn();
  const stopFirst = api.desktopUpdates.subscribe(first);
  const stopLater = api.desktopUpdates.subscribe(later);
  const channel = "clawtrate:update:changed";
  for (const state of [{ kind: "checking" }, { kind: "failed", reason: "unreachable" }])
    events.emit(channel, {}, { state });
  expect(later.mock.calls).toEqual(first.mock.calls);
  expect(later).toHaveBeenCalledTimes(2);
  stopLater();
  events.emit(channel, {}, { state: { kind: "checking" } });
  expect(first).toHaveBeenCalledTimes(3);
  expect(later).toHaveBeenCalledTimes(2);
  stopFirst();
  expect(events.listenerCount(channel)).toBe(0);
});

it("sends only the declared update arguments over IPC", async () => {
  vi.resetModules();
  const invoke = vi.fn(),
    expose = vi.fn();
  vi.doMock("electron", () => ({
    ipcRenderer: { invoke },
    contextBridge: { exposeInMainWorld: expose },
  }));
  await import("../../src/preload/index.ts");
  const api: DesktopHostApi = expose.mock.calls[0]![1];
  const updates = api.desktopUpdates;
  const check = updates.check as (...args: unknown[]) => unknown;
  check("stable", 7, "https://unused.example");
  expect(invoke).toHaveBeenLastCalledWith("clawtrate:update:check", "stable", 7);
  for (const args of [[], ["other", 7], ["nightly", {}], ["stable", -1]]) {
    check(...args);
    expect(invoke).toHaveBeenLastCalledWith("clawtrate:update:check");
  }
  for (const [name, channel, valid] of [
    ["chooseTrack", "track", "nightly"],
    ["download", "download", "opaque-id"],
    ["restart", "restart", "verified-id"],
  ] as const) {
    const call = updates[name] as (...args: unknown[]) => unknown;
    call(valid, "https://unused.example");
    expect(invoke).toHaveBeenLastCalledWith("clawtrate:update:" + channel, valid);
    for (const input of [
      [],
      [{}],
      ...(name === "download" || name === "restart" ? [] : [["other"]]),
    ]) {
      call(...input);
      expect(invoke).toHaveBeenLastCalledWith("clawtrate:update:" + channel);
    }
  }
});
