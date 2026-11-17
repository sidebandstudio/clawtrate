// How the live conversation behaves, in the fixture mode: sending, the keys,
// Stop, queueing, steering and holding, the access request, notices, motion
// and attachments (docs/design/conversation.md). The fixture answers the
// engine's commands closely enough for the interface; what depends on the
// gateway is proven in e2e/. Each title starts with the rows it covers.
import type { Run } from "../packages/core/src/runs.ts";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import { expect, test, type Page } from "@playwright/test";
import { openFixture, OTTO_DISK, settle } from "./fixture.ts";

const open = (page: Page, scene: string, extra = "") =>
  openFixture(page, `scene=${scene}&${OTTO_DISK}&panel=closed${extra}`, "light");

const field = (page: Page) => page.getByTestId("composer-input");
const announcer = (page: Page) => page.getByTestId("announcer");

/** Change the fixture's state from the test, as the host's next snapshot would. */
async function setRun(page: Page, change: Record<string, unknown>) {
  await page.evaluate((patch) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture;
    fixture.setState((state) => {
      const key = "agent:otto:disk-space";
      const transcript = state.transcripts[key]!;
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [key]: {
            ...transcript,
            runs: transcript.runs.map((run: Run) =>
              run.id === "run-live" ? { ...run, ...patch } : run,
            ),
          },
        },
      };
    });
  }, change);
}

test.describe("sending", () => {
  test("F-068 F-072: Enter sends and clears the draft, Shift+Enter adds a line, and an empty draft sends nothing", async ({
    page,
  }) => {
    await open(page, "composer");
    await expect(field(page)).toHaveAttribute("placeholder", "Message Otto");
    await expect(page.getByRole("button", { name: "Attach files" })).toBeVisible();
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    await field(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("outgoing")).toHaveCount(0);

    await field(page).fill("First line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await expect(field(page)).toHaveValue("First line\nsecond line");
    await expect(send).toBeEnabled();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("outgoing")).toContainText("second line");
    await expect(field(page)).toHaveValue("");
    await expect(field(page)).toBeFocused();
  });

  test("F-072: Cmd/Ctrl+Enter sends from anywhere in the window", async ({ page }) => {
    await open(page, "composer");
    await field(page).fill("Sent from the transcript");
    await page.getByTestId("transcript").focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("outgoing")).toContainText("Sent from the transcript");
  });

  test("F-081 F-085: within a second of a send the status line shows the avatar and Thinking", async ({
    page,
  }) => {
    await open(page, "composer");
    await field(page).fill("Check the disk again");
    const sent = Date.now();
    await page.keyboard.press("Enter");
    const line = page.getByTestId("status-line");
    await expect(line).toBeVisible({ timeout: 1000 });
    expect(Date.now() - sent).toBeLessThan(1000);
    await expect(line.getByTestId("status-phrase")).toHaveText("Thinking");
    await expect(line.locator(".presence")).toHaveAttribute("data-state", "thinking");
    await expect(line).toHaveAccessibleName("Otto, thinking: Thinking. No steps yet.");
  });

  test("F-465 F-466: Cmd/Ctrl+I focuses the composer, and Cmd/Ctrl+L puts exactly the selected text in it", async ({
    page,
  }) => {
    await open(page, "composer");
    await page.getByTestId("transcript").focus();
    await page.keyboard.press("ControlOrMeta+i");
    await expect(field(page)).toBeFocused();
    await page.evaluate(() => {
      const heading = document.querySelector(".task-line")!;
      const range = document.createRange();
      range.selectNodeContents(heading);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      (document.querySelector(".transcript") as HTMLElement).focus();
    });
    await page.keyboard.press("ControlOrMeta+l");
    await expect(field(page)).toHaveValue("Disk almost full on the media box");
    await expect(field(page)).toBeFocused();
  });

  test("F-073: an unsent draft is kept per task", async ({ page }) => {
    await open(page, "composer");
    await field(page).fill("Half a thought about the disk");
    await page.getByTestId("task").filter({ hasText: "Weekly backup check" }).click();
    await expect(field(page)).toHaveValue("");
    await field(page).fill("Something about backups");
    await page.getByTestId("task").filter({ hasText: "Disk almost full" }).click();
    await expect(field(page)).toHaveValue("Half a thought about the disk");
    await page.getByTestId("task").filter({ hasText: "Weekly backup check" }).click();
    await expect(field(page)).toHaveValue("Something about backups");
  });

  test("F-260: a line starting with > is sent as a block quote", async ({ page }) => {
    await open(page, "composer");
    await field(page).fill("> the disk is 94% full\n\nIs that still true?");
    await page.keyboard.press("Enter");
    const bubble = page.getByTestId("outgoing");
    await expect(bubble.locator("blockquote")).toHaveText("the disk is 94% full");
    await expect(bubble.locator("p").last()).toHaveText("Is that still true?");
  });

  test("F-106: several messages sent quickly each appear once, in order", async ({ page }) => {
    await open(page, "composer");
    for (const text of ["one", "two", "three"]) {
      await field(page).fill(text);
      await page.keyboard.press("Enter");
    }
    await expect(page.getByTestId("outgoing").locator(".bubble")).toHaveText([
      "one",
      "two",
      "three",
    ]);
  });

  test("F-075: a failed send says so, and Resend and Delete act on it", async ({ page }) => {
    await open(page, "send-failed");
    const bubble = page.getByTestId("outgoing");
    await expect(bubble).toContainText("Failed to send");
    // Not in your colour: the gateway never accepted it.
    await expect(bubble.locator(".msg")).toHaveAttribute("data-pending", "held");
    await bubble.getByRole("button", { name: "Resend" }).click();
    await expect(bubble).toHaveAttribute("data-status", "sending");
    await expect(bubble).not.toContainText("Failed to send");
    await open(page, "send-failed");
    await page.getByTestId("outgoing").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("outgoing")).toHaveCount(0);
  });

  test("F-287: a message written offline is held in the neutral fill and marked to send when reconnected", async ({
    page,
  }) => {
    await open(page, "offline-send");
    const held = page.getByTestId("outgoing").filter({ hasText: "Skip the photos folder." });
    await expect(held).toContainText("Sends when reconnected");
    await expect(held.locator(".msg")).toHaveAttribute("data-pending", "held");
    await expect(field(page)).toHaveAttribute(
      "placeholder",
      "Offline. Messages send when you reconnect.",
    );
    // Offline the composer is Send alone.
    await expect(page.getByTestId("stop")).toHaveCount(0);
  });

  test("F-074 F-285: files attach as chips; one over the limit is refused before sending and can be removed", async ({
    page,
  }) => {
    await open(page, "composer");
    const input = page.locator('.composer input[type="file"]');
    await input.setInputFiles([
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.alloc(1024 * 1024) },
      { name: "photo.png", mimeType: "image/png", buffer: Buffer.alloc(8.2 * 1024 * 1024) },
    ]);
    const chips = page.locator(".attachments .chip");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText("1.0 MB");
    await expect(chips.nth(1)).toContainText("8.2 MB. Images can be up to 6 MB.");
    await expect(chips.nth(1)).toHaveAttribute("data-tone", "danger");
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    await page.getByRole("button", { name: "Remove photo.png" }).click();
    await expect(chips).toHaveCount(1);
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.getByTestId("outgoing")).toHaveCount(1);
    await expect(chips).toHaveCount(0);
  });
});

test("F-074: files can be dragged into the composer or pasted into its field", async ({ page }) => {
  await open(page, "composer");
  await page.locator(".composer-box").evaluate((box) => {
    const data = new DataTransfer();
    data.items.add(new File(["dragged"], "dragged.txt", { type: "text/plain" }));
    box.dispatchEvent(
      new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }),
    );
  });
  await field(page).evaluate((input) => {
    const data = new DataTransfer();
    data.items.add(new File(["pasted"], "pasted.png", { type: "image/png" }));
    input.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator(".attachments .chip")).toHaveText([/dragged\.txt/, /pasted\.png/]);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("outgoing")).toContainText("dragged.txt, pasted.png");
});

test.describe("the status line", () => {
  test("F-082 F-086 F-087: a running step's title is the phrase, the avatar works, and the phrase is its own tooltip", async ({
    page,
  }) => {
    await open(page, "run-working");
    const line = page.getByTestId("status-line");
    await expect(line.getByTestId("status-phrase")).toHaveText("Reading backup-2026-11-15.log");
    await expect(line.locator(".presence")).toHaveAttribute("data-state", "working");
    await expect(line).toHaveAttribute("title", "Reading backup-2026-11-15.log");
    await expect(line).toHaveAccessibleName(
      "Otto, working: Reading backup-2026-11-15.log. Show steps.",
    );
  });

  test("F-084: a light crosses the phrase while the bot works, and stops when it waits or stops", async ({
    page,
  }) => {
    const shimmer = (page: Page) =>
      page.getByTestId("status-phrase").evaluate((el) => getComputedStyle(el).animationName);
    await open(page, "run-working");
    expect(await shimmer(page)).toContain("shimmer");
    await open(page, "run-waiting");
    expect(await shimmer(page)).not.toContain("shimmer");
    await open(page, "run-stopping");
    expect(await shimmer(page)).not.toContain("shimmer");
  });

  test("F-291 F-086: with reduced motion nothing loops: the avatar, the phrase and the caret keep still forms", async ({
    page,
  }) => {
    await open(page, "run-working", "&motion=reduce");
    const still = await page.evaluate(() =>
      [".status-line .presence svg", ".status-line .presence", ".status-phrase"].map((selector) => {
        const element = document.querySelector(selector)!;
        return [
          getComputedStyle(element).animationName,
          getComputedStyle(element, "::before").animationName,
        ];
      }),
    );
    expect(still.flat().every((name) => name === "none")).toBe(true);
    // The working state still shows: the arc is held in place.
    expect(
      await page
        .locator(".status-line .presence")
        .evaluate((el) => getComputedStyle(el, "::before").opacity),
    ).toBe("1");
    await open(page, "run-streaming", "&motion=reduce");
    expect(
      await page.locator(".stream-caret").evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
  });

  test("F-292: a pending card reads Waiting for you, and the running phrase returns when it settles", async ({
    page,
  }) => {
    await open(page, "run-waiting");
    const phrase = page.getByTestId("status-phrase");
    await expect(phrase).toHaveText("Waiting for you");
    await expect(page.locator(".status-line .presence")).toHaveAttribute("data-state", "waiting");
    await expect(page.getByTestId("needs-you")).toContainText("Otto needs your approval");
    await setRun(page, {
      state: "running",
      pendingCards: [],
      steps: [],
    });
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: { ...state.transcripts[key]!, approvals: [] },
          },
        };
      });
    });
    await expect(phrase).toHaveText("Thinking");
    await expect(page.getByTestId("needs-you")).toHaveCount(0);
  });

  test("F-089: the status line stays while replies and cards arrive and leaves only when the run ends", async ({
    page,
  }) => {
    await open(page, "run-working");
    await setRun(page, { text: "Half of the reply." });
    await expect(page.getByTestId("status-line")).toBeVisible();
    await setRun(page, {
      state: "waiting",
      pendingCards: [{ id: "x", kind: "approval", since: 1 }],
    });
    await expect(page.getByTestId("status-line")).toBeVisible();
    await setRun(page, { state: "completed", textComplete: true, endedAt: Date.now() });
    await expect(page.getByTestId("status-line")).toHaveCount(0);
    // No message that only says it is done.
    await expect(page.locator(".transcript")).not.toContainText(/Otto is done|finished\./);
    await expect(announcer(page)).toHaveText("Otto finished");
  });

  test("F-095 F-433: the reply streams with a caret and aria-busy until the gateway says it is complete", async ({
    page,
  }) => {
    await open(page, "run-streaming");
    const bubble = page.getByTestId("live-turn").locator(".bubble");
    await expect(bubble).toHaveAttribute("aria-busy", "true");
    await expect(bubble.locator(".stream-caret")).toHaveCount(1);
    await setRun(page, { text: "The backup finished at 02:14 and wrote 41 GB in all." });
    await expect(bubble).toContainText("wrote 41 GB in all.");
    await setRun(page, { textComplete: true });
    await expect(bubble).toHaveAttribute("aria-busy", "false");
    await expect(bubble.locator(".stream-caret")).toHaveCount(0);
  });

  test("F-433: a reply cut off by a stop or a failure keeps its text, captioned Incomplete", async ({
    page,
  }) => {
    for (const scene of ["run-stopped", "run-failed"]) {
      await open(page, scene);
      const reply = page.getByTestId("live-turn");
      await expect(reply).toContainText("Two folders were skipped because they were");
      await expect(reply.getByTestId("incomplete")).toHaveText("Incomplete");
    }
  });
});

test.describe("Stop", () => {
  test("F-097: Stop sits beside Send; Cmd/Ctrl+. stops; Stopping… replaces it, then the run ends as stopped", async ({
    page,
  }) => {
    await open(page, "run-working");
    await expect(page.getByRole("button", { name: "Stop Otto" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Steer this turn" })).toBeVisible();
    await page.getByTestId("transcript").focus();
    await page.keyboard.press("ControlOrMeta+.");
    await expect(page.getByTestId("status-phrase")).toHaveText("Stopping…");
    await expect(page.getByRole("button", { name: "Stop Otto" })).toHaveCount(0);
    await expect(page.locator(".composer-status")).toHaveText("Stopping…");
    await expect(page.getByTestId("stop-note")).toContainText("Completed steps are not undone.");
    await expect(page.getByTestId("status-line")).toHaveCount(0);
    await expect(announcer(page)).toHaveText("Stopped");
  });

  test("F-299: the stop note says how long the run took and that completed steps are not undone", async ({
    page,
  }) => {
    await open(page, "run-stopped");
    await expect(page.getByTestId("stop-note")).toHaveText(
      "Stopped after 40s. Completed steps are not undone.",
    );
    await open(page, "run-stopped-elsewhere");
    await expect(page.getByTestId("stop-note")).toContainText(
      "from another device or session. Completed steps are not undone.",
    );
  });

  test("F-419: a run that completed before Stop took effect says so", async ({ page }) => {
    await open(page, "run-finished-before-stop");
    await expect(page.getByTestId("stop-note")).toHaveText(
      "Finished before Stop took effect. The turn completed normally.",
    );
    await expect(page.getByTestId("incomplete")).toHaveCount(0);
  });

  test("F-100: a run that reached its time limit ends with a card naming the limit", async ({
    page,
  }) => {
    await open(page, "run-turn-limit");
    const card = page.getByTestId("turn-error");
    await expect(card).toContainText("Otto's turn reached its 50 minute limit");
    await expect(card).toContainText(
      "The gateway ended the turn so it would not hang. Send a message to pick up where it left off.",
    );
  });
});

test.describe("steering, queueing and holding", () => {
  test("F-096: a message sent while the run works is a steer, captioned Steer", async ({
    page,
  }) => {
    await open(page, "run-working");
    await field(page).fill("Skip the photos folder");
    await expect(page.getByRole("button", { name: "How to send: Steer" })).toBeVisible();
    await page.keyboard.press("Enter");
    const steer = page.getByTestId("outgoing").filter({ hasText: "Skip the photos folder" });
    await expect(steer.locator(".msg-caption")).toHaveText("Steer");
  });

  test("F-061: the mode word's menu is keyboard operable; Queue after this turn queues as a shelf row", async ({
    page,
  }) => {
    await open(page, "run-working");
    await field(page).fill("Then send me a summary");
    const word = page.getByRole("button", { name: "How to send: Steer" });
    await word.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "How to send" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemradio", { name: /Steer this turn/ })).toBeFocused();
    await expect(menu.getByRole("menuitemradio", { name: /Steer this turn/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(word).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "How to send: Queue" })).toBeVisible();
    await field(page).focus();
    await page.keyboard.press("Enter");
    const row = page.getByTestId("shelf-row");
    await expect(row).toContainText("Queued");
    await expect(row).toContainText("Then send me a summary");
    await expect(page.getByTestId("outgoing").filter({ hasText: "Then send me" })).toHaveCount(0);
    await expect(announcer(page)).toHaveText("Queued");
  });

  test("F-061: Alt+Enter queues one message without changing the mode", async ({ page }) => {
    await open(page, "run-working");
    await field(page).fill("Queue just this one");
    await page.keyboard.press("Alt+Enter");
    await expect(page.getByTestId("shelf-row")).toContainText("Queue just this one");
    await field(page).fill("x");
    await expect(page.getByRole("button", { name: "How to send: Steer" })).toBeVisible();
  });

  test("F-280 F-281: Send now steers a queued message into the run; Cancel removes another, which never runs", async ({
    page,
  }) => {
    await open(page, "run-queued");
    const row = page.getByTestId("shelf-row");
    await row.getByRole("button", { name: "Send now" }).click();
    await expect(row).toHaveCount(0);
    const sent = page.getByTestId("outgoing").filter({ hasText: "Then send me a summary." });
    await expect(sent.locator(".msg-caption")).toHaveText("Steer");

    await open(page, "run-queued");
    await page.getByTestId("shelf-row").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("shelf-row")).toHaveCount(0);
    await expect(page.getByTestId("outgoing").filter({ hasText: "Then send me" })).toHaveCount(0);
  });

  test("F-421: a message sent while the run is stopping is queued, with no Send now", async ({
    page,
  }) => {
    await open(page, "run-stopping");
    await expect(field(page)).toHaveAttribute("placeholder", "Queue a message for Otto");
    await field(page).fill("Try again afterwards");
    await page.keyboard.press("Enter");
    const rows = page.getByTestId("shelf-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.last()).toContainText("Try again afterwards");
    await expect(page.getByRole("button", { name: "Send now" })).toHaveCount(0);
  });

  test("F-468: while a question is pending every message is held, never offered Send now, and Edit takes it back without losing the draft", async ({
    page,
  }) => {
    await open(page, "run-question");
    await expect(page.getByTestId("status-phrase")).toHaveText("Waiting for you");
    await field(page).fill("Keep the yearly ones too");
    await expect(page.getByRole("button", { name: "How to send: Hold" })).toBeVisible();
    await expect(page.getByTestId("needs-you")).toHaveText(
      "Otto asked a question. A message sent now is held until you answer.Review",
    );
    await expect(page.getByRole("button", { name: "Hold until you answer" })).toBeVisible();
    await page.keyboard.press("Enter");
    const held = page.getByTestId("shelf-row").filter({ hasText: "Held until you answer" });
    await expect(held).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Send now" })).toHaveCount(0);
    await expect(page.getByTestId("outgoing").filter({ hasText: "yearly" })).toHaveCount(0);

    await field(page).fill("A draft in progress");
    await held.first().getByRole("button", { name: "Edit" }).click();
    await expect(field(page)).toHaveValue(
      "A draft in progress\nAlso keep anything from this month.",
    );
    await expect(held).toHaveCount(1);
  });

  test("F-282: Start as new task runs the message in a new task and keeps this one open", async ({
    page,
  }) => {
    await open(page, "run-working");
    await field(page).fill("Look at the printer instead");
    await page.keyboard.press("ControlOrMeta+Shift+Enter");
    await expect(announcer(page)).toHaveText("Started as a new task");
    await expect(field(page)).toHaveValue("");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Disk almost full on the media box",
    );
  });
});

test.describe("keyboard", () => {
  test("F-097 F-102: focus is never left on a control that has gone", async ({ page }) => {
    await open(page, "run-working");
    await page.getByRole("button", { name: "Stop Otto" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Stop Otto" })).toHaveCount(0);
    await expect(field(page)).toBeFocused();

    await open(page, "run-queued");
    await page.getByTestId("shelf-row").getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Enter");
    await expect(field(page)).toBeFocused();

    await open(page, "run-failed");
    await page.getByRole("button", { name: "Dismiss this error" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-error-line")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Dismiss this error" })).toBeFocused();
  });

  test("F-282 F-072: with no run, Shift+F10 on Send opens its menu: Send and Start as new task", async ({
    page,
  }) => {
    await open(page, "composer");
    await field(page).fill("Start this somewhere new");
    await page.getByRole("button", { name: "Send", exact: true }).focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "How to send" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Send↵", "Start as new task⇧⌘↵"]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(announcer(page)).toHaveText("Started as a new task");
  });
});

test("F-467: Cmd/Ctrl+/ shows every keyboard shortcut; Escape closes the list and returns focus", async ({
  page,
}) => {
  await open(page, "composer");
  await field(page).focus();
  await page.keyboard.press("ControlOrMeta+/");
  const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(list).toBeFocused();
  for (const keys of ["↵", "⇧↵", "⌥↵", "⇧⌘↵", "⌘↵", "⌘.", "⌘J", "⌘I", "⌘L", "⌘\\", "⌘/"]) {
    await expect(list.locator("kbd", { hasText: keys }).first()).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(field(page)).toBeFocused();
});

test.describe("access", () => {
  test("F-456: Request access asks once, shows the host's command and request id, and is never made silently", async ({
    page,
  }) => {
    await open(page, "main");
    const bar = page.getByRole("region", { name: "Access" });
    await expect(bar).toContainText(
      "Read-only. You can follow Otto's work here. Approvals and questions aren't shown on this connection.",
    );
    await expect(page.getByTestId("composer-input")).toHaveCount(0);
    await bar.getByRole("button", { name: "Request access" }).click();
    await expect(bar).toContainText("Waiting for the gateway's owner.");
    await expect(bar.locator(".command code")).toHaveText(
      "openclaw devices approve 7c41d09e-52b3-4e8a-9f10-3d6b2a7e9c41",
    );
    await expect(bar).toContainText("Request 7c41d09e");
    await expect(bar.getByRole("button", { name: "Copy approve command" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Copy request id" })).toBeVisible();
    await expect(announcer(page)).toHaveText("Access requested");
  });

  test("F-456: denied and expired requests keep the read tier and offer to ask again", async ({
    page,
  }) => {
    await open(page, "access-denied");
    await expect(page.getByRole("region", { name: "Access" })).toContainText(
      "The request was denied. Nothing changed. This device can still read.",
    );
    await expect(page.getByRole("button", { name: "Request again" })).toBeVisible();
    await open(page, "access-expired");
    await expect(page.getByRole("region", { name: "Access" })).toContainText(
      "The request expired before it was approved.",
    );
    await expect(page.getByRole("button", { name: "Request again" })).toBeVisible();
  });

  test("F-456: when access arrives the composer takes the bar's place and the strip says Access granted", async ({
    page,
  }) => {
    await open(page, "access-granted");
    await page.getByRole("button", { name: "Copy request id" }).focus();
    await expect(page.getByTestId("status-strip")).toContainText(
      "Access granted· you can send, stop and answer",
    );
    await expect(page.getByRole("region", { name: "Access" })).toHaveCount(0);
    await expect(field(page)).toBeVisible();
    await expect(announcer(page)).toHaveText("You can now send, stop and answer");
  });

  test("a host pinned to the read tier never offers to ask for access", async ({ page }) => {
    await open(page, "access-pinned");
    await expect(page.getByRole("region", { name: "Access" })).toContainText("Read-only.");
    await expect(page.getByRole("button", { name: "Request access" })).toHaveCount(0);
  });
});

test.describe("errors and resync", () => {
  test("F-102: a failed turn shows its card; Dismiss folds it to a line that opens it again; Try again sends the message", async ({
    page,
  }) => {
    await open(page, "run-failed");
    const card = page.getByRole("alert").filter({ hasText: "Otto couldn't finish this turn" });
    await expect(card).toContainText("The model provider is overloaded.");
    await card.getByRole("button", { name: "Dismiss this error" }).click();
    await expect(card).toHaveCount(0);
    await page.getByTestId("turn-error-line").click();
    await expect(page.getByTestId("turn-error")).toBeVisible();
    await page.getByTestId("turn-error").getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("status-line")).toBeVisible();
  });

  test("F-103 F-300: errors collect above the composer, each can be dismissed, and Clear all clears them", async ({
    page,
  }) => {
    await open(page, "stop-failed");
    const notices = page.locator(".composer-shelf [role=alert]");
    await expect(notices).toHaveCount(1);
    await expect(notices).toContainText("Couldn't stop Otto.");
    await notices.getByRole("button", { name: "Dismiss" }).click();
    await expect(notices).toHaveCount(0);

    await open(page, "stop-failed");
    // A second error: a message too long for the gateway.
    await field(page).fill("x");
    await page.evaluate(() => {
      const fixture = (window as unknown as { clawtrateFixture: { invoke: unknown } })
        .clawtrateFixture as { invoke: (c: unknown) => Promise<unknown> };
      const original = fixture.invoke;
      fixture.invoke = (command: unknown) =>
        (command as { type: string }).type === "sendMessage"
          ? Promise.reject(new Error("The message is too long."))
          : original(command);
    });
    await page.keyboard.press("Enter");
    await expect(notices).toHaveCount(2);
    await expect(notices.last()).toContainText(
      "Couldn't send this message. The message is too long.",
    );
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(notices).toHaveCount(0);
  });

  test("F-104: while the connection is lost nothing moves, the status line says what was last seen, and the composer is offline", async ({
    page,
  }) => {
    await open(page, "offline-send");
    await expect(page.locator(".app")).toHaveAttribute("data-connection", "lost");
    await expect(page.getByTestId("status-phrase")).toHaveText(
      "Reconnecting. Last seen reading backup-2026-11-15.log",
    );
    const moving = await page.evaluate(() =>
      [...document.querySelectorAll(".presence, .presence svg, .status-phrase, .glyph")].some(
        (el) =>
          getComputedStyle(el).animationName !== "none" ||
          getComputedStyle(el, "::before").animationName !== "none",
      ),
    );
    expect(moving).toBe(false);
    await expect(page.locator(".status-elapsed")).toHaveCount(0);
    await expect(page.getByTestId("status-strip")).toContainText("Reconnecting");
  });

  test("F-107: after a reconnect the conversation catches up without showing a message twice", async ({
    page,
  }) => {
    await open(page, "run-working");
    await expect(page.getByTestId("outgoing")).toHaveCount(1);
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, status: "reconnecting", retryAt: Date.now() + 4000 },
      }));
    });
    await expect(page.getByTestId("status-strip")).toContainText("Reconnecting");
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      // History now holds the message: it leaves the outbox and the run is anchored to it.
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        const sent = transcript.outbox[0]!;
        return {
          ...state,
          connection: { ...state.connection, status: "connected", connectedAt: Date.now() + 1 },
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...transcript,
              loadedAt: Date.now() + 2,
              outbox: [],
              items: [
                ...transcript.items,
                {
                  id: "h-sent",
                  role: "user",
                  timestamp: Date.now(),
                  blocks: [{ kind: "text", text: sent.text }],
                  model: null,
                },
              ],
              runs: transcript.runs.map((run: Run) => ({
                ...run,
                messageId: null,
                anchorItemId: "h-sent",
              })),
            },
          },
        };
      });
    });
    await expect(page.getByTestId("status-strip")).toContainText("Synced");
    await expect(
      page.locator(".transcript").getByText("Can you check the backup log from last night too?"),
    ).toHaveCount(1);
    await expect(page.getByTestId("status-line")).toBeVisible();
    await settle(page);
  });
});
