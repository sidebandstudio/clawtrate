import type { ClawtrateState } from "@clawtrate/core";
import { MAX_TRACKED_TASKS, MAX_OUTBOX, MAX_NAME_CHARS } from "../packages/core/src/state-bounds.ts";import type { DesktopUpdates } from "../packages/core/src/desktop-updates.ts";
import { expect, test } from "@playwright/test";
import { contextFor, openFixture, settle, showList, SIZES, OTTO_DISK } from "./fixture.ts";

for (const size of SIZES.filter((s) => s.name === "1440" || s.phone)) {
  test.describe(size.name, () => {
    test.use(contextFor(size, "light"));
    for (const state of [
      "ready",
      "confirmation",
      "preparing",
      "handing-off",
      "handed-to-system",
      "handoff-unconfirmed",
      "installer-failed",
      "target-running",
      "unreadable",
      "old-version-running",
      "unconfirmed",
    ]) {
      test(`F-231 F-030: Restart ${state} fits ${size.name}`, async ({ page }) => {
        const after = [
          "target-running",
          "old-version-running",
          "unconfirmed",
          "unreadable",
        ].includes(state);
        await openFixture(
          page,
          `scene=main&updates=${after ? "not-checked&after=" + state : state === "confirmation" ? "ready" : state}`,
          "light",
        );
        await showList(page);
        if (after) {
          await page.keyboard.press("ControlOrMeta+,");
          await page.getByRole("button", { name: "Updates", exact: true }).click();
        } else {
          await page.getByRole("button", { name: "Open Updates" }).click();
        }
        if (state === "confirmation")
          await page.getByRole("button", { name: "Restart to Update", exact: true }).click();
        const panel = page.getByRole(state === "confirmation" ? "alertdialog" : "dialog");
        await expect(panel).toBeVisible();
        await settle(page);
        expect(
          await panel.evaluate(
            (el) =>
              el.scrollWidth <= el.clientWidth &&
              [...el.querySelectorAll("p,dd")].every(
                (row) => row.scrollWidth <= row.clientWidth + 1,
              ),
          ),
        ).toBe(true);
        await expect(panel).toHaveScreenshot(`restart-${state}-${size.name}.png`);
      });
    }
  });
}

for (const [scene, warning] of [
  [
    "stopped-not-sent",
    "1 message to Otto hasn't been sent yet. Restarting discards it: it isn't kept as a draft. Runs on the gateway keep going.",
  ],
  [
    "send-unknown",
    "1 message to Otto was sent to the gateway and isn't confirmed yet. Restarting stops following it. The gateway may still have it.",
  ],
] as const) {
  test(`F-231: confirmation describes the outbox in ${scene}`, async ({ page }) => {
    await openFixture(page, `scene=${scene}&${OTTO_DISK}&updates=ready`, "light");
    await page.getByRole("button", { name: "Open Updates" }).click();
    await page.getByRole("button", { name: "Restart to Update" }).click();
    await expect(page.getByRole("alertdialog")).toContainText(warning);
  });
}

test("F-231: a retired offer closes its confirmation without restarting", async ({ page }) => {
  await openFixture(page, "scene=main&updates=ready", "light");
  await page.getByRole("button", { name: "Open Updates" }).click();
  await page.getByRole("button", { name: "Restart to Update" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.evaluate(() => {
    const host = window as unknown as {
      clawtrateFixture: { desktopUpdates: DesktopUpdates };
    };
    return host.clawtrateFixture.desktopUpdates.chooseTrack("nightly");
  });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restart to Update" })).toHaveCount(0);
  const result = page.getByRole("group", { name: "Update status" });
  await expect(result).toContainText("Not checked yet.");
  await expect(result).toBeFocused();
});

for (const size of SIZES.filter((s) => s.name === "1440" || s.phone))
  for (const height of [720, 820]) {
    test.describe(`${size.name} × ${height}`, () => {
      test.use(contextFor({ ...size, height }, "light"));
      test("F-231: a full outbox keeps the restart terms and both buttons in view", async ({ page }) => {
        await openFixture(page, `scene=stopped-not-sent&${OTTO_DISK}&updates=ready`, "light");
        await showList(page);
        await page.evaluate(({ tasks, messages, nameLength }) => {
          const fixture = (window as unknown as {
            clawtrateFixture: { setState: (change: (s: ClawtrateState) => ClawtrateState) => void }
          }).clawtrateFixture;
          fixture.setState(s => {
            const task = s.tasksByBot.otto!.find(t => t.key === "agent:otto:disk-space")!;
            const transcript = s.transcripts[task.key]!;
            const all = Array.from({ length: tasks }, (_, i) => ({ ...task, key: task.key + i }));
            return {
              ...s,
              bots: s.bots.map(bot => bot.id === "otto" ? { ...bot, name: "W".repeat(nameLength) } : bot),
              tasksByBot: { ...s.tasksByBot, otto: all },
              transcripts: Object.fromEntries(all.map(t => [t.key, { ...transcript,
                outbox: Array.from({ length: messages }, (_, i) => ({
                  ...transcript.outbox[0]!, id: t.key + "-" + i,
                  status: i % 2 ? "unknown" : "not-sent", leftAt: i % 2 ? 1 : null,
                })),
              }])),
            };
          });
        }, {tasks: MAX_TRACKED_TASKS, messages: MAX_OUTBOX, nameLength: MAX_NAME_CHARS});
        await page.getByRole("button", { name: "Open Updates" }).click();
        await page.getByRole("button", { name: "Restart to Update" }).click();
        const dialog = page.getByRole("alertdialog");
        const count = MAX_TRACKED_TASKS * MAX_OUTBOX / 2;
        const description = dialog.locator("#b-confirm-details");
        await expect(description).toHaveText(new RegExp(`^${count} messages .*Runs on the gateway keep going\\. ${count} messages .*The gateway may still have them\\.$`));
        await expect(dialog.getByRole("button", {name: "Cancel"})).toBeFocused();
        const fixed = () => dialog.evaluate(el => {
          const card = el.getBoundingClientRect();
          return [el.querySelector("h2")!, el.querySelector("#b-confirm-text")!, ...el.querySelectorAll("button")].map(item => {
            const rect = item.getBoundingClientRect();
            return rect.top >= Math.max(card.top, 0) && rect.bottom <= Math.min(innerHeight, card.bottom) && el.scrollTop === 0;
          });
        });
        expect(await fixed()).toEqual([true,true,true,true]);
        await expect(dialog).toHaveScreenshot(`restart-full-outbox-${size.name}-${height}.png`);
        await description.evaluate(el => { el.scrollTop = el.scrollHeight; });
        expect(await fixed()).toEqual([true,true,true,true]);
      });
    });
  }
