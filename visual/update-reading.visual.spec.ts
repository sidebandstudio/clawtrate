import { expect, test } from "@playwright/test";
import type {
  DesktopUpdateSnapshot,
  DesktopUpdateState,
  DesktopUpdateReply,
  DesktopUpdates,
  UpdateTrack,
} from "../packages/core/src/desktop-updates.ts";
import { openFixture } from "./fixture.ts";

type Probe = {
  active: number;
  commands: string[];
  emit: (
    revision: number,
    state: DesktopUpdateState,
    pending?: UpdateTrack | null,
    selected?: UpdateTrack,
    issue?: DesktopUpdateSnapshot["preferenceIssue"],
  ) => void;
  finish: (action: string, revision: number, state: DesktopUpdateState) => void;
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
        const commands = new Map<string, (reply: DesktopUpdateReply) => void>();
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
          emit: (
            revision,
            state,
            pendingTrack = null,
            selectedTrack = "stable",
            preferenceIssue = null,
          ) => {
            for (const fn of listeners)
              fn({ ...s, revision, state, pendingTrack, selectedTrack, preferenceIssue });
          },
          read: () => first.resolve({ ...s, revision: 3 }),
          finish: (action, revision, state) => {
            commands.get(action)!({ outcome: "accepted", snapshot: { ...s, revision, state } });
            commands.delete(action);
          },
        };
        window.updateProbe = probe;
        function send(action: string) {
          probe.commands.push(action);
          return new Promise<DesktopUpdateReply>((resolve) => commands.set(action, resolve));
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
    window.updateProbe.finish("check stable", 4, {
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
  await expect(status).toHaveText("Changing the update track…");
  await page.evaluate(() => window.updateProbe.emit(8, { kind: "not-checked" }, "nightly"));
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Space");
  await expect(radio).toBeChecked();
  const line = page.locator(".update-result dd");
  await page.evaluate(() => window.updateProbe.emit(9, { kind: "not-checked" }, null, "nightly"));
  await expect(page.getByRole("radio", { name: "Nightly" })).toBeChecked();
  await expect(status).toHaveText("Not checked yet.");
  await expect(page.locator(".updates-section")).not.toContainText("Saving");
  const check = page.getByRole("button", { name: "Check for Updates" });
  await expect(check).toBeVisible();
  await expect(check).toHaveAccessibleDescription(
    "Checks nightly.example for a newer build, only when you choose to.",
  );
  await radio.click();
  await expect(status).toHaveText("Changing the update track…");
  await page.evaluate(() =>
    window.updateProbe.finish("choose nightly", 8, { kind: "not-checked" }),
  );
  await expect(status).toHaveText("Changing the update track…");
  await expect(check).toHaveCount(0);
  await radio.press("Space");
  await page.evaluate(() =>
    window.updateProbe.emit(10, { kind: "not-checked" }, "stable", "nightly"),
  );
  await expect(status).toHaveText("Saving Stable as the update track…");
  await page.evaluate(() =>
    window.updateProbe.emit(11, { kind: "not-checked" }, null, "nightly", "track-not-saved"),
  );
  await expect(page.getByRole("radio", { name: "Nightly" })).toBeChecked();
  await expect(line).toHaveText("Not checked yet.");
  await expect(page.locator(".update-result p").first()).toHaveText(
    "Couldn't save the track. Nightly is still selected.",
  );
  await expect(check).toBeVisible();
  await expect(status).not.toContainText("Saving");
  await expect(page.getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open Updates" })).toHaveCount(0);
  expect(await page.evaluate(() => window.updateProbe.commands)).toEqual([
    "check stable",
    "download B",
    "choose nightly",
    "choose stable",
  ]);
  expect(await page.evaluate(() => window.updateProbe.active)).toBe(1);
  await page.evaluate(() => window.updateProbe.emit(12, { kind: "not-checked" }));
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await page.evaluate(() => window.updateProbe.emit(13, { kind: "checking" }));
  await page.keyboard.press("Escape");
  const entry = page.getByRole("button", { name: "Open Updates" });
  await expect(entry).toHaveCount(0);
  await page.evaluate(() =>
    window.updateProbe.finish("check stable", 14, {
      kind: "failed",
      stage: "check",
      reason: "timed-out",
    }),
  );
  await entry.click();
  await expect(page.locator(".update-result dd")).toHaveText("Couldn't check for updates.");
});
