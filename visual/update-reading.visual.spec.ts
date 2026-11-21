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
  readable: boolean;
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
            { track: "nightly", source: "beta.example" },
          ],
          lastCheck: null,
          preferenceIssue: null,
          lastAttempt: null,
          install: { kind: "unavailable-in-this-build", reason: "no-verified-download" },
          state: { kind: "not-checked" },
        };
        const probe: Probe = {
          active: 0,
          readable: false,
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
          get: () => (probe.readable ? first.promise : Promise.reject(new Error("Read failed"))),
          subscribe(fn) {
            listeners.add(fn);
            probe.active = listeners.size;
            return () => {
              listeners.delete(fn);
              probe.active = listeners.size;
            };
          },
          check: (track) => send("check " + track),
          restart: (id) => send("restart " + id),
          download: (id) => send("download " + id),
          chooseTrack: (track) => send("choose " + track),
        };
      },
    });
  });
  await openFixture(page, "scene=main", "light");
  await expect.poll(() => page.evaluate(() => window.updateProbe.active)).toBe(1);
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  const retry = page.getByRole("button", { name: "Retry reading settings" });
  await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(retry).toBeFocused();
  await page.evaluate(() => {
    window.updateProbe.readable = true;
  });
  await page.keyboard.press("Enter");
  await expect(retry).toHaveAttribute("aria-disabled", "true");
  await page.evaluate(() => window.updateProbe.emit(1, { kind: "not-checked" }));
  await expect(page.getByRole("group", { name: "Update status" })).toBeFocused();
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
  await expect(page.getByRole("radio", { name: "Beta" })).toBeFocused();
  await expect(page.locator(".update-result dd")).toHaveText("Not checked yet.");
  await expect(status).toHaveText("Changing the update track…");
  await page.evaluate(() => window.updateProbe.emit(8, { kind: "not-checked" }, "nightly"));
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Space");
  await expect(radio).toBeChecked();
  const line = page.locator(".update-result dd");
  await page.evaluate(() => window.updateProbe.emit(9, { kind: "not-checked" }, null, "nightly"));
  await expect(page.getByRole("radio", { name: "Beta" })).toBeChecked();
  await expect(status).toHaveText("Not checked yet.");
  await expect(page.locator(".updates-section")).not.toContainText("Saving");
  const check = page.getByRole("button", { name: "Check for Updates" });
  await expect(check).toBeVisible();
  await expect(check).toHaveAccessibleDescription(
    "Checks beta.example for a newer build, only when you choose to.",
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
  await expect(page.getByRole("radio", { name: "Beta" })).toBeChecked();
  await expect(line).toHaveText("Not checked yet.");
  await expect(page.locator(".update-result p").first()).toHaveText(
    "Couldn't save the track. Beta is still selected.",
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

type OfferProbe = Window & {
  publishOffer: (snapshot: DesktopUpdateSnapshot) => void;
  updateCalls: string[];
  clawtrateFixture: { desktopUpdates: DesktopUpdates };
};

for (const reason of [
  "build-not-signed",
  "windows-install-pending-trial",
  "no-installer-path",
] as const) {
  test.describe(reason, () => {
    test("F-231: a stale Download control sends nothing after a permanent refusal", async ({
      page,
    }) => {
      await page.addInitScript(() => {
        const w = window as unknown as OfferProbe;
        w.updateCalls = [];
        Object.defineProperty(w, "clawtrateFixture", {
          configurable: true,
          set(bridge: { desktopUpdates: DesktopUpdates }) {
            Object.defineProperty(w, "clawtrateFixture", { value: bridge });
            const host = bridge.desktopUpdates;
            const subscribe = host.subscribe;
            host.subscribe = (listener) => {
              w.publishOffer = listener;
              return subscribe(listener);
            };
            const { check, download } = host;
            host.check = (track, revision) => {
              w.updateCalls.push(`check ${track} ${revision}`);
              return check(track, revision);
            };
            host.download = (id) => {
              w.updateCalls.push(`download ${id}`);
              return download(id);
            };
          },
        });
      });
      await openFixture(page, "scene=main&updates=offered", "light");
      await page.getByRole("button", { name: "Open Updates" }).click();
      const download = page.getByRole("button", { name: "Download", exact: true });
      await download.evaluate(async (button, reason) => {
        const w = window as unknown as OfferProbe;
        const offer = await w.clawtrateFixture.desktopUpdates.get();
        w.publishOffer({
          ...offer,
          revision: offer.revision + 1,
          install: { kind: "unavailable-in-this-build", reason },
        });
        (button as HTMLButtonElement).click();
      }, reason);
      await expect(download).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as OfferProbe).updateCalls)).toEqual([]);
      await page.getByRole("button", { name: "Check for Updates" }).click();
      expect(await page.evaluate(() => (window as unknown as OfferProbe).updateCalls)).toEqual([
        "check stable 1",
      ]);
    });
  });
}

test("F-231: an unanswered check leaves the startup retry advice out", async ({ page }) => {
  await openFixture(page, "scene=main&updates=not-checked&after=old-version-running", "light");
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  const result = page.getByRole("group", { name: "Update status" });
  await expect(result).toContainText(
    "Clawtrate 0.1.0 is running, not 0.2.0. Check for updates to try again.",
  );
  const revision = await page.evaluate(async () => {
    const host = (window as unknown as OfferProbe).clawtrateFixture.desktopUpdates;
    host.check = async () => {
      throw new Error("Missing reply");
    };
    return (await host.get()).revision;
  });
  expect(revision).toBe(0);
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await expect(result).toContainText("Couldn't get a reply to the update check.");
  await expect(
    page
      .locator(".updates-section .facts div")
      .filter({ has: page.getByText("Version", { exact: true }) })
      .locator("dd"),
  ).toContainText("Clawtrate 0.1.0");
  await expect(page.locator(".updates-section")).not.toContainText("not 0.2.0");
  await expect(page.locator(".updates-section")).not.toContainText(
    "Check for updates to try again.",
  );
});
