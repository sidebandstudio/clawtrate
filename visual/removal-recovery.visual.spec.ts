import { expect, test } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import { openFixture, OTTO_DISK } from "./fixture.ts";

type Controls = {
  clawtrateFixture: {
    invoke: (command: { type: string }) => Promise<unknown>;
    setState: (change: (state: ClawtrateState) => ClawtrateState) => void;
  };
  refuseSend?: () => void;
};

for (const editor of ["composer", "thread"] as const) {
  for (const order of ["list removal", "closing and reopening the editor"] as const) {
    test(`F-278: the ${editor} recovers a refused ordinary send after ${order}, without losing newer edits`, async ({
      page,
    }) => {
      await openFixture(page, `scene=message-actions&${OTTO_DISK}&panel=closed`, "light");
      await page.evaluate(() => {
        const controls = window as unknown as Controls;
        const fixture = controls.clawtrateFixture;
        const invoke = fixture.invoke.bind(fixture);
        fixture.invoke = (command) =>
          command.type === "sendMessage"
            ? new Promise((_, reject) => {
                controls.refuseSend = () => reject(new Error("Host refused before queuing."));
              })
            : invoke(command);
      });
      if (editor === "thread") await page.getByTestId("reply-quote").click();
      const field = page.getByTestId(`${editor}-input`);
      await field.fill("First draft.");
      await field.press("Enter");
      await expect
        .poll(() => page.evaluate(() => !!(window as unknown as Controls).refuseSend))
        .toBe(true);
      await expect(field).toHaveValue("");
      if (order === "list removal") {
        await page.evaluate(() =>
          (window as unknown as Controls).clawtrateFixture.setState((state) => ({
            ...state,
            tasksByBot: { ...state.tasksByBot, otto: [] },
          })),
        );
        await expect(page.locator(".conversation-header")).toContainText(
          "Disk almost full on the media box",
        );
        await field.fill("Newer words.");
      } else {
        await field.fill("Newer words.");
        if (editor === "thread") {
          await field.press("Escape");
          await expect(field).toHaveCount(0);
        } else {
          await page.getByTestId("task").filter({ hasText: "Weekly backup check" }).first().click();
          await expect(page.locator(".conversation-header")).toContainText("Weekly backup check");
        }
      }
      await page.evaluate(() => (window as unknown as Controls).refuseSend!());
      if (order !== "list removal") {
        if (editor === "thread") await page.getByTestId("reply-quote").click();
        else await page.getByTestId("task").filter({ hasText: "Disk almost full" }).first().click();
      }
      await expect(field).toHaveValue("First draft.\nNewer words.");
      if (order === "list removal") {
        await expect(page.getByTestId(`${editor}-waits`)).toContainText(
          "Start a new task with this message",
        );
      }
    });
  }
}
