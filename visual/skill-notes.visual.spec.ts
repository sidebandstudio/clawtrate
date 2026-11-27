// A row of the gateway's skill-note shape in the mounted conversation and rail,
// fed to the fixture as the host's next snapshot would bring it (docs/parity.md
// F-560): with "Show commands" off it is drawn, it is new activity for "Jump to
// latest" and the view at the end follows it. A bot can write such a row, so it is
// shown as any message.
// After a stopped or failed run, a row with no run is not that run's reply: it
// takes neither its "Incomplete" nor its error. Every name and text is invented.
import { test, type Page } from "@playwright/test";
import {
  mapHistory,
  type ClawtrateState,
  type Run,
  type Task,
  type TranscriptItem,
} from "../packages/core/src/index.ts";
import { contextFor, expect, NOW, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

const TASK = "agent:otto:disk-space";
const NOTE_TEXT = "Learned: saved the example skill.";
const NOTE_KEY = "skill-workshop-notice:skill-workshop-review:0b6c1f2e-4d5a-4b7c-9e1f-2a3b4c5d6e7f";
const EPOCH = NOW.getTime() - 120_000;

const said = (
  role: "user" | "assistant",
  id: string,
  text: string,
  at: number,
  runId?: string,
) => ({
  role,
  timestamp: EPOCH + at,
  content: role === "user" ? text : [{ type: "text", text }],
  __openclaw: { id, ...(runId ? { runId } : {}) },
});
/** A row of the note's shape, as OpenClaw 2026.10.6 writes the note or a bot's message under its key. */
const note = (id: string) => ({
  ...said("assistant", id, NOTE_TEXT, 1_000),
  api: "openclaw-transcript",
  provider: "openclaw",
  model: "delivery-mirror",
  idempotencyKey: NOTE_KEY,
});
/** A full history page: 200 messages, the person's and the bot's in turn. */
const PAGE = Array.from({ length: 200 }, (_, n) =>
  said(n % 2 ? "assistant" : "user", `record-${n}`, `Conversation entry ${n}`, n, `run-${n}`),
);

const transcript = (page: Page) => page.getByTestId("transcript");
const jump = (page: Page) => page.getByTestId("jump-latest");
const open = (page: Page, commands = false) =>
  openFixture(page, `scene=main&${OTTO_DISK}&panel=closed${commands ? "&commands=show" : ""}`);

/**
 * Otto's task's history, and its row in the list, as the host's next snapshot would have them.
 * With `run`, the task keeps one finished run: the scene's own, changed by it.
 */
async function update(
  page: Page,
  data: { items?: TranscriptItem[]; row?: Partial<Task>; run?: Partial<Run> },
) {
  await page.evaluate(
    ({ items, row, run, key }) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const held = state.transcripts[key]!;
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...held,
              ...(items
                ? {
                    items,
                    live: null,
                    runs: run ? [{ ...held.runs.at(-1)!, ...run }] : [],
                    outbox: [],
                  }
                : {}),
            },
          },
          ...(row
            ? {
                tasksByBot: {
                  ...state.tasksByBot,
                  // This task is Otto's latest.
                  otto: state.tasksByBot.otto!.map((task) =>
                    task.key === key ? { ...task, ...row } : { ...task, updatedAt: 1 },
                  ),
                },
              }
            : {}),
        };
      });
    },
    { ...data, key: TASK },
  );
  await settle(page);
}

const measured = (page: Page) =>
  transcript(page).evaluate((element) => ({
    top: element.scrollTop,
    below: element.scrollHeight - element.scrollTop - element.clientHeight,
  }));

/** Scroll up from the end, as a person reading back does. */
async function readBack(page: Page): Promise<number> {
  await transcript(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await settle(page);
  const { top, below } = await measured(page);
  expect(below).toBeGreaterThan(96);
  await expect(jump(page)).toHaveCount(0);
  return top;
}

const atEnd = (page: Page) =>
  expect.poll(async () => (await measured(page)).below).toBeLessThanOrEqual(1);

test.describe("rows of the gateway's skill-note shape", () => {
  test.use(contextFor(SIZES[0]!));

  test("F-560: with Show commands off, a row of the note's shape arriving while the person reads back is drawn and is new activity", async ({
    page,
  }) => {
    await open(page);
    await update(page, { items: mapHistory(PAGE) });
    await readBack(page);
    await update(page, { items: mapHistory([...PAGE.slice(1), note("note-1")]) });
    await expect(transcript(page).getByText(NOTE_TEXT)).toHaveCount(1);
    await expect(jump(page)).toHaveText("Jump to latest");
    await jump(page).click();
    await atEnd(page);
    await expect(transcript(page).getByText(NOTE_TEXT)).toBeInViewport();
  });

  test("F-560: with Show commands off, the view at the end follows the row", async ({ page }) => {
    await open(page);
    const first = PAGE.slice(0, 30);
    await update(page, { items: mapHistory(first) });
    await atEnd(page);
    const before = await measured(page);
    await update(page, { items: mapHistory([...first, note("note-1")]) });
    await atEnd(page);
    expect((await measured(page)).top).toBeGreaterThan(before.top);
    await expect(transcript(page).getByText(NOTE_TEXT)).toBeInViewport();
    await expect(jump(page)).toHaveCount(0);
  });

  // A row the gateway appends after a turn names no run: whatever its fields, it is not the
  // stopped or failed run's reply, so it neither takes the run's "Incomplete" nor hides its error.
  const ASK = said("user", "ask", "How much space is left?", 100);
  const askItem = () => mapHistory([ASK])[0]!.id;
  const stoppedRun = (state: "stopped" | "failed", error?: string): Partial<Run> => ({
    id: "run-x",
    state,
    anchorItemId: askItem(),
    messageId: null,
    textComplete: false,
    ...(error ? { error: { message: error, kind: "provider" } } : {}),
  });

  test("F-433 F-560: after a stopped run, the cut reply keeps Incomplete and a row with no run after it has none", async ({
    page,
  }) => {
    await openFixture(page, `scene=run-stopped&${OTTO_DISK}&panel=closed`);
    const cut = said("assistant", "cut", "Two folders were skipped because", 200, "run-x");
    await update(page, {
      items: mapHistory([ASK, cut, note("note-1")]),
      run: stoppedRun("stopped"),
    });
    const turn = (text: string) => page.getByTestId("transcript-turn").filter({ hasText: text });
    await expect(turn(NOTE_TEXT)).toHaveCount(1);
    await expect(page.getByTestId("incomplete")).toHaveCount(1);
    await expect(turn("Two folders were skipped").getByTestId("incomplete")).toHaveCount(1);
    await expect(turn(NOTE_TEXT).getByTestId("incomplete")).toHaveCount(0);
  });

  test("F-532 F-560: after a failed run, its error shows once though a row with no run follows it", async ({
    page,
  }) => {
    await openFixture(page, `scene=run-stopped&${OTTO_DISK}&panel=closed`);
    const ERROR = "The provider went away.";
    const failure = said("assistant", "failure", ERROR, 200, "run-x");
    await update(page, {
      items: mapHistory([ASK, failure, note("note-1")]),
      run: stoppedRun("failed", ERROR),
    });
    await expect(page.getByTestId("turn-error")).toBeVisible();
    await expect(transcript(page).getByText(ERROR)).toHaveCount(1);
    await expect(transcript(page).getByText(NOTE_TEXT)).toHaveCount(1);
    await expect(page.getByTestId("incomplete")).toHaveCount(0);
  });

  test("F-433: a bot's message with the note's fields that names the stopped run is its cut reply, as before", async ({
    page,
  }) => {
    await openFixture(page, `scene=run-stopped&${OTTO_DISK}&panel=closed`);
    // The copy the gateway makes of a message the bot sent in this run: the note's fields and key.
    const copied = { ...note("copy-1"), __openclaw: { id: "copy-1", runId: "run-x" } };
    await update(page, { items: mapHistory([ASK, copied]), run: stoppedRun("stopped") });
    const turn = page.getByTestId("transcript-turn").filter({ hasText: NOTE_TEXT });
    await expect(turn.getByTestId("incomplete")).toHaveText("Incomplete");
  });
});
