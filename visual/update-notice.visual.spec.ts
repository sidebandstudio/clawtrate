// The gateway's own "OpenClaw updated" notice in the mounted conversation and rail (F-590), fed
// to the fixture as the host's next snapshot would bring it. With this device's record of the
// run, it is Clawtrate's quiet line, at 1440 and phone width in both themes, its disclosure
// opened by keyboard; without one, the same row is the bot's message, as it was. The row is the
// shape recorded from real update runs; no update runs here. Every other name and text is invented.
import { test, type Page } from "@playwright/test";
import {
  mapHistory,
  type ClawtrateState,
  type Task,
  type UpdatedRun,
} from "../packages/core/src/index.ts";
import {
  contextFor,
  expect,
  NOW,
  openFixture,
  OTTO_DISK,
  settle,
  SIZES,
  THEMES,
} from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const TASK = "agent:otto:disk-space";
const RUN = "3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e";
const EPOCH = NOW.getTime() - 120_000;
const TEXT =
  "✅ OpenClaw updated.\nFor details, open Settings → Updates in the OpenClaw app or run `openclaw update status` in your terminal.";
const LISTED =
  "✅ OpenClaw updated. For details, open Settings → Updates in the OpenClaw app or run openclaw update status in your terminal.";

const rows = [
  {
    role: "user",
    timestamp: EPOCH,
    content: "How much space is left on the disk?",
    __openclaw: { id: "ask-1" },
  },
  {
    role: "assistant",
    timestamp: EPOCH + 2_000,
    content: [{ type: "text", text: "About 40 GB are free. The cache uses most of the rest." }],
    api: "openai-completions",
    provider: "scripted",
    model: "dev-1",
    __openclaw: { id: "reply-1", runId: "run-1" },
  },
  // The notice as `chat.history` returns it.
  {
    role: "assistant",
    timestamp: EPOCH + 60_000,
    content: [{ type: "text", text: TEXT }],
    api: "openclaw-transcript",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: { input: 0, output: 0, totalTokens: 0 },
    stopReason: "stop",
    idempotencyKey: `update-run-finished:${RUN}`,
    __openclaw: { id: "notice-1", idempotencyKey: `update-run-finished:${RUN}`, seq: 3 },
  },
];

type Fixture = {
  clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
};

/** Otto's task's history and row as the host's next snapshot would have them, and whether this device saw the run succeed. */
async function update(page: Page, seen: boolean) {
  await page.evaluate(
    ({ items, key, run, seen, listed, at }) => {
      (window as unknown as Fixture).clawtrateFixture.setState((state) => {
        const updated: UpdatedRun[] = seen
          ? [{ gatewayId: state.connection.gatewayId!, runId: run, to: "2026.11.10", at }]
          : [];
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: { ...state.transcripts[key]!, items, live: null, runs: [], outbox: [] },
          },
          tasksByBot: {
            ...state.tasksByBot,
            // This task is Otto's latest, so its preview is the bot's.
            otto: state.tasksByBot.otto!.map((task: Task) =>
              task.key === key
                ? { ...task, preview: listed, updatedAt: at + 5 }
                : { ...task, updatedAt: 1 },
            ),
          },
          openclawUpdating: {
            ...(state.openclawUpdating ?? {
              run: null,
              starting: false,
              blocked: null,
              error: null,
              looking: false,
              lookFailed: false,
            }),
            updated,
          },
        };
      });
    },
    { items: mapHistory(rows), key: TASK, run: RUN, seen, listed: LISTED, at: EPOCH + 60_000 },
  );
  await settle(page);
}

const open = (page: Page, theme: (typeof THEMES)[number]) =>
  openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, theme);
const line = (page: Page) => page.getByTestId("update-line");

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`update notice ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-590: the gateway's update notice is a quiet line with the gateway's message one step away, and matches its baselines", async ({
        page,
      }) => {
        await open(page, theme);
        await update(page, true);
        await expect(line(page)).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`update-notice-${theme}-${size.name}.png`);
        await line(page).getByText("The gateway's message").click();
        await expect(line(page).getByText(/^✅ OpenClaw updated\. For details/)).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`update-notice-open-${theme}-${size.name}.png`);
      });
    });
  }
}

test.describe("update notice behaviour", () => {
  test.use(contextFor(WIDE, "dark"));

  test("F-590: the line is read once as OpenClaw updated, carries none of the bot's message parts, and its disclosure opens by keyboard", async ({
    page,
  }) => {
    await open(page, "dark");
    await update(page, true);
    const transcript = page.getByTestId("transcript");
    await expect(
      transcript.getByText("OpenClaw updated to 2026.11.10", { exact: true }),
    ).toHaveCount(1);
    // The gateway's sentence is not drawn as a message of the bot's.
    await expect(transcript.locator(".msg").filter({ hasText: "OpenClaw updated." })).toHaveCount(
      0,
    );
    await expect(line(page).locator(".avatar, .bubble, .msg-actions, button")).toHaveCount(0);
    // Its sentence is one step away, by keyboard.
    const summary = line(page).locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(line(page).locator("details")).toHaveAttribute("open", "");
    await expect(line(page).locator(".update-line-text")).toHaveText(
      "✅ OpenClaw updated. For details, open Settings → Updates in the OpenClaw app or run `openclaw update status` in your terminal.",
    );
    // The rail's preview is the bot's last words before it.
    await expect(page.locator('[data-testid="bot"][data-bot="otto"] .bot-preview')).toHaveText(
      "About 40 GB are free. The cache uses most of the rest.",
    );
  });

  test("F-590: without this device's record of the run, the same row is the bot's message, as before", async ({
    page,
  }) => {
    await open(page, "dark");
    await update(page, false);
    const transcript = page.getByTestId("transcript");
    await expect(line(page)).toHaveCount(0);
    await expect(transcript.locator(".msg").filter({ hasText: "OpenClaw updated." })).toHaveCount(
      1,
    );
    await expect(page.locator('[data-testid="bot"][data-bot="otto"] .bot-preview')).toHaveText(
      LISTED,
    );
  });
});
