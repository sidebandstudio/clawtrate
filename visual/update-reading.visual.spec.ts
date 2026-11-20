import { expect, test } from "@playwright/test";
import type {
  DesktopUpdateSnapshot,
  DesktopUpdateState,
  DesktopUpdateReply,
  DesktopUpdates,
} from "../packages/core/src/desktop-updates.ts";
import { openFixture } from "./fixture.ts";

type Probe = {
  active: number;
  commands: string[];
  emit: (revision: number, state: DesktopUpdateState, pending?: boolean) => void;
  finish: (revision: number, state: DesktopUpdateState) => void;
  read: () => void;
  mutations: number;
};
declare global {
  interface Window {
    updateProbe: Probe;
  }
}

// Hold the initial read and command replies independently of subscription events.
test("F-231 F-030: Settings and the sidebar keep the latest revision across reopen", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "clawtrateFixture", {
      configurable: true,
      set(bridge: { desktopUpdates: DesktopUpdates }) {
        Object.defineProperty(window, "clawtrateFixture", { configurable: true, value: bridge });
        const listeners = new Set<(s: DesktopUpdateSnapshot) => void>();
        const first = Promise.withResolvers<DesktopUpdateSnapshot>();
        let command = Promise.withResolvers<DesktopUpdateReply>();
        const s: DesktopUpdateSnapshot = {
          revision: 0,
          runningVersion: "1.0.0",
          runningTrack: "stable",
          selectedTrack: "stable",
          pendingTrack: null,
          tracks: [
            { track: "stable", source: "stable.example" },
            { track: "nightly", source: "nightly.example" },
          ],
          lastCheck: null,
          preferenceIssue: null,
          install: { kind: "unavailable-in-this-build" },
          state: { kind: "not-checked" },
        };
        const probe: Probe = {
          active: 0,
          commands: [],
          mutations: 0,
          emit: (revision, state, pending = false) => {
            for (const fn of listeners)
              fn({ ...s, revision, state, pendingTrack: pending ? "nightly" : null });
          },
          read: () => first.resolve({ ...s, revision: 3 }),
          finish: (revision, state) => {
            command.resolve({ outcome: "accepted", snapshot: { ...s, revision, state } });
            command = Promise.withResolvers();
          },
        };
        window.updateProbe = probe;
        function send(action: string) {
          probe.commands.push(action);
          return command.promise;
        }
        bridge.desktopUpdates = {
          get: () => first.promise,
          subscribe(fn) {
            listeners.add(fn);
            probe.active = listeners.size;
            return () => {
              listeners.delete(fn);
              probe.active = listeners.size;
            };
          },
          check: (track) => send("check " + track),
          download: (id) => send("download " + id),
          chooseTrack: (track) => send("choose " + track),
        };
      },
    });
  });
  await openFixture(page, "scene=main", "light");
  await expect.poll(() => page.evaluate(() => window.updateProbe.active)).toBe(1);
  await page.evaluate(() => window.updateProbe.emit(1, { kind: "not-checked" }));
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await page.evaluate(() => {
    window.updateProbe.emit(5, {
      kind: "offered",
      version: "2.0.0",
      offerId: "B",
      releaseDate: "2026-11-02",
    });
    window.updateProbe.finish(4, {
      kind: "offered",
      version: "1.1.0",
      offerId: "A",
      releaseDate: "2026-11-01",
    });
    window.updateProbe.read();
  });
  await expect(page.locator(".update-result dd")).toHaveText(
    "Clawtrate 2.0.0 is offered by the update source.",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open Updates" }).click();
  expect(await page.evaluate(() => window.updateProbe.active)).toBe(1);
  await page.getByRole("button", { name: "Download", exact: true }).click();
  expect(await page.evaluate(() => window.updateProbe.commands)).toEqual([
    "check stable",
    "download B",
  ]);
  await page.evaluate(() =>
    window.updateProbe.emit(6, {
      kind: "downloading",
      received: 110,
      expected: 1000,
      version: "2.0.0",
    }),
  );
  await expect(page.getByRole("group", { name: "Update status" })).toBeFocused();
  const radio = page.getByRole("radio", { name: "Stable" });
  await page.keyboard.press("Shift+Tab");
  await expect(radio).toBeFocused();
  const status = page.getByRole("dialog").getByRole("status");
  await expect(status).toHaveText("Downloading Clawtrate 2.0.0… 10%");
  await status.evaluate((node) =>
    new MutationObserver(() => window.updateProbe.mutations++).observe(node, {
      subtree: true,
      childList: true,
      characterData: true,
    }),
  );
  await page.evaluate(() =>
    window.updateProbe.emit(7, {
      kind: "downloading",
      received: 119,
      expected: 1000,
      version: "2.0.0",
    }),
  );
  await expect(page.locator(".update-result dd")).toContainText("119 of 1,000 bytes");
  await expect(radio).toBeFocused();
  expect(await page.evaluate(() => window.updateProbe.mutations)).toBe(0);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Nightly" })).toBeFocused();
  await expect(page.locator(".update-result dd")).toHaveText("Not checked yet.");
  await page.evaluate(() => window.updateProbe.emit(8, { kind: "not-checked" }, true));
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Space");
  await expect(radio).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open Updates" })).toHaveCount(0);
  expect(await page.evaluate(() => window.updateProbe.commands)).toEqual([
    "check stable",
    "download B",
    "choose nightly",
  ]);
  expect(await page.evaluate(() => window.updateProbe.active)).toBe(1);
});
