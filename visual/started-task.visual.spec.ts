// A task a bot started (docs/parity.md F-565): the line under its name, which says who started
// it and from which task with a way to open that task, and the bot's brief as its first message.
// Otto's open task is turned into one Otto started from its weekly backup check, as the host's
// next snapshot would bring it, so no other scene changes. Every name and text is invented.
import { test, type Page } from "@playwright/test";
import { mapHistory, type ClawtrateState } from "../packages/core/src/index.ts";
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

const TASK = "agent:otto:disk-space";
const FROM = "agent:otto:backup-check";
const CREATED = NOW.getTime() - 300_000;
const BRIEF =
  "The media box disk is almost full. Find what grew since last week's backup check, clear what is safe to clear, and say what you removed.";

const row = (role: "user" | "assistant", id: string, text: string, at: number, run: string) => ({
  role,
  timestamp: CREATED + at,
  content: role === "user" ? text : [{ type: "text", text }],
  ...(role === "user" ? { idempotencyKey: `${run}:user` } : {}),
  __openclaw: { id, ...(role === "user" ? { idempotencyKey: `${run}:user` } : { runId: run }) },
});
const HISTORY = [
  row("user", "brief", BRIEF, 40, "run-brief"),
  row(
    "assistant",
    "answer",
    "Old transcode logs grew by 40 GB. I removed them; the disk is now at 61%.",
    9_000,
    "run-brief",
  ),
  row("user", "yours", "Thanks. Keep last month's logs next time.", 60_000, "run-yours"),
  row("assistant", "noted", "Noted: I will keep a month of logs.", 64_000, "run-yours"),
];

/** Otto's open task as a task Otto started from another, with its brief first. */
async function startedFrom(page: Page, fromKey: string | null) {
  const items = mapHistory(HISTORY, { startedAt: CREATED });
  await page.evaluate(
    ({ items, key, fromKey }) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        transcripts: {
          ...state.transcripts,
          [key]: { ...state.transcripts[key]!, items, live: null, runs: [], outbox: [] },
        },
        tasksByBot: {
          ...state.tasksByBot,
          otto: state.tasksByBot.otto!.map((task) =>
            task.key === key ? { ...task, startedBy: { botId: "otto", fromKey } } : task,
          ),
        },
      }));
    },
    { items, key: TASK, fromKey },
  );
  await settle(page);
}

const line = (page: Page) => page.getByTestId("started-by");
const open = (page: Page, theme: (typeof THEMES)[number] = "dark") =>
  openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, theme);

for (const size of [SIZES[0]!, SIZES.at(-1)!]) {
  for (const theme of THEMES) {
    test.describe(`a started task ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      test(`F-565: a task a bot started matches its baseline, ${theme}, ${size.name}`, async ({
        page,
      }) => {
        await open(page, theme);
        await startedFrom(page, FROM);
        await expect(line(page)).toHaveText(
          "Otto started this task from Weekly backup check · Open Weekly backup check",
        );
        await expect(page.getByTestId("task-brief")).toBeVisible();
        await page.getByTestId("transcript").evaluate((element) => {
          element.scrollTop = 0;
        });
        await settle(page);
        await expect(page).toHaveScreenshot(`started-task-${theme}-${size.name}.png`);
      });
    });
  }
}

test.describe("a started task's line", () => {
  test.use(contextFor(SIZES[0]!));

  test("F-565: Open goes to the task it was started from, and is reached by keyboard", async ({
    page,
  }) => {
    await open(page);
    await startedFrom(page, FROM);
    const button = page.getByRole("button", { name: "Open Weekly backup check" });
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".task-line")).toHaveText("Weekly backup check");
  });

  test("F-565: without the task it came from, the line says who started it and offers nothing", async ({
    page,
  }) => {
    await open(page);
    await startedFrom(page, "agent:otto:archived-elsewhere");
    await expect(line(page)).toHaveText("Otto started this task.");
    await expect(line(page).getByRole("button")).toHaveCount(0);
  });

  test("F-565: the brief is the bot's, and the person's later message is theirs", async ({
    page,
  }) => {
    await open(page);
    await startedFrom(page, FROM);
    const brief = page.getByTestId("task-brief");
    await expect(brief.locator("figcaption")).toHaveText("Otto's brief");
    await expect(brief).toContainText("Find what grew since last week's backup check");
    const yours = page.locator('.msg[data-role="user"]');
    await expect(yours).toHaveCount(1);
    await expect(yours).toHaveText("Thanks. Keep last month's logs next time.");
  });
});
