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
