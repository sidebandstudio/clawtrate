import { expect, test, type Page } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import { openFixture, OTTO_DISK } from "./fixture.ts";

type Controls = {
  clawtrateFixture: {
    invoke: (command: { type: string }) => Promise<unknown>;
    setState: (change: (state: ClawtrateState) => ClawtrateState) => void;
  };
  refuseSend?: () => void;
  acceptSend?: () => void;
  acceptCreate?: () => void;
};

const diskTitle = "Disk almost full on the media box";

async function removeDiskTask(page: Page) {
  await page.evaluate(() =>
    (window as unknown as Controls).clawtrateFixture.setState((state) => ({
      ...state,
      tasksByBot: {
        ...state.tasksByBot,
        otto: state.tasksByBot.otto!.filter((task) => task.key !== "agent:otto:disk-space"),
      },
    })),
  );
  await expect(page.getByTestId("task").filter({ hasText: diskTitle })).toHaveCount(0);
}

async function delaySend(page: Page) {
  await page.evaluate(() => {
    const controls = window as unknown as Controls;
    const fixture = controls.clawtrateFixture;
    const invoke = fixture.invoke.bind(fixture);
    fixture.invoke = (command) =>
      command.type === "sendMessage"
        ? new Promise((resolve, reject) => {
            controls.refuseSend = () => reject(new Error("Host refused before queuing."));
            controls.acceptSend = () => resolve({ messageId: "accepted-reply" });
          })
        : invoke(command);
  });
}

for (const editor of ["composer", "thread"] as const) {
  for (const order of ["list removal", "closing and reopening the editor"] as const) {
    test(`F-278: the ${editor} recovers a refused ordinary send after ${order}, without losing newer edits`, async ({
      page,
    }) => {
      await openFixture(page, `scene=message-actions&${OTTO_DISK}&panel=closed`, "light");
      await delaySend(page);
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

for (const outcome of ["refusal", "acceptance"] as const) {
  test(`F-278: a pending reply keeps its task after the thread closes and the row disappears, through ${outcome}`, async ({
    page,
  }) => {
    await openFixture(page, `scene=message-actions&${OTTO_DISK}&panel=closed`, "light");
    await delaySend(page);
    const openThread = page.getByTestId("reply-quote");
    await openThread.click();
    const field = page.getByTestId("thread-input");
    await field.fill("Recover this reply.");
    await field.press("Enter");
    await expect(field).toHaveValue("");
    await field.press("Escape");
    await expect(field).toHaveCount(0);
    await removeDiskTask(page);
    const header = page.locator(".conversation-header");
    await expect(header).toContainText(diskTitle);
    if (outcome === "refusal") {
      await page.evaluate(() => (window as unknown as Controls).refuseSend!());
      await expect(header).toContainText(diskTitle);
      await openThread.click();
      await expect(field).toHaveValue("Recover this reply.");
      await expect(page.getByRole("alert")).toContainText("Host refused before queuing.");
      await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Start a new task with this message" }),
      ).toBeVisible();
      await page.getByTestId("thread-waits").getByRole("button", { name: "Delete" }).click();
    } else {
      await page.evaluate(() => (window as unknown as Controls).acceptSend!());
    }
    await expect(header).toContainText("Rotate the logs");
  });
}

for (const edit of ["retyped", "untouched"] as const) {
  test(`F-278: delayed new-task success clears only the submitted revision when a reopened reply is ${edit}`, async ({
    page,
  }) => {
    await openFixture(page, `scene=message-actions&${OTTO_DISK}&panel=closed`, "light");
    await page.evaluate(() => {
      const controls = window as unknown as Controls;
      const fixture = controls.clawtrateFixture;
      const invoke = fixture.invoke.bind(fixture);
      fixture.invoke = (command) =>
        command.type === "createTask"
          ? new Promise((resolve) => {
              controls.acceptCreate = () => resolve({ key: "agent:otto:new-task" });
            })
          : invoke(command);
    });
    const original = page.getByTestId("reply-quote");
    const field = page.getByTestId("thread-input");
    const words = "Keep this reply.";
    await original.click();
    await field.fill(words);
    await removeDiskTask(page);
    await page.getByRole("button", { name: "Start a new task with this message" }).click();
    await expect
      .poll(() => page.evaluate(() => !!(window as unknown as Controls).acceptCreate))
      .toBe(true);
    await field.press("Escape");
    await expect(field).toHaveCount(0);
    await original.click();
    await expect(field).toHaveValue(words);
    if (edit === "retyped") {
      await field.fill("");
      await expect(field).toHaveValue("");
      await field.fill(words);
    }
    await field.press("Escape");
    const other = page.getByTestId("message").filter({ has: page.getByTestId("reactions") });
    await other.getByRole("button", { name: "Reply in a thread" }).press("Enter");
    await expect(field).toHaveValue("");
    await field.fill(words);
    await page.evaluate(() => (window as unknown as Controls).acceptCreate!());
    await expect(page.getByTestId("announcer")).toHaveText("Started as a new task");
    await expect(field).toHaveValue(words);
    await field.press("Escape");
    await original.click();
    await expect(field).toHaveValue(edit === "retyped" ? words : "");
  });
}
