// The gateway's skill note in the mounted conversation and rail, fed to the fixture as the host's
// next snapshot would bring it (docs/parity.md F-560). The note folds into the line of the run it
// follows, "Saved a skill: …", whatever "Show commands" says; opened, the line shows its text and
// its undo, the gateway's own on OpenClaw 2026.11.10 (admin) and a message "undo" on 2026.10.6. A
// note with no run line to fold into is a line of its own. It is not new activity and not the
// bot's preview. A row with the note's fields and other words, or naming a run, is a message as
// any other: a bot can write such a row. After a stopped or failed run, a row with no run is not
// that run's reply: it takes neither its "Incomplete" nor its error. Every name and text is
// invented.
import { test, type Page } from "@playwright/test";
import {
  mapHistory,
  RawTable,
  runsFromHistory,
  type BridgeCommand,
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
const preview = (page: Page) => page.locator('[data-testid="bot"][data-bot="otto"] .bot-preview');
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
                  // This task is Otto's latest, so its preview is the bot's.
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

  test("F-560: with Show commands off, the bot's preview is the row the gateway lists", async ({
    page,
  }) => {
    await open(page);
    const history = mapHistory([said("assistant", "prior", "Old reply.", 800), note("note-1")]);
    await update(page, { items: history, row: { updatedAt: EPOCH + 1_005, preview: NOTE_TEXT } });
    await expect(preview(page)).toHaveText(NOTE_TEXT);
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

// The gateway's note after a run with an action, as each version writes it.
const REVIEW = "7c4e2a1b-9d3f-4e6a-8b5c-0d1e2f3a4b5c";
const SKILL_KEY = `skill-workshop-notice:skill-workshop-review:${REVIEW}`;
const SKILL_TEXT =
  '💾 Learned: created `disk-check` (check free space before a big download). Say "undo" to revert this skill change.';
const SKILL_LISTED =
  '💾 Learned: created disk-check (check free space before a big download). Say "undo" to revert this skill change.';
const REPLY = "About 40 GB are free. The cache uses most of the rest.";
const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

/** The note; `marked` as OpenClaw 2026.11.10 writes it, else as 2026.10.6 does. */
const skillNote = (marked: boolean, at = 40_000) => ({
  role: "assistant",
  timestamp: EPOCH + at,
  content: [{ type: "text", text: SKILL_TEXT }],
  api: "openclaw-transcript",
  provider: "openclaw",
  model: "delivery-mirror",
  stopReason: "stop",
  idempotencyKey: SKILL_KEY,
  ...(marked
    ? {
        openclawDeliveryMirror: {
          kind: "plugin-notice",
          pluginId: "skill-workshop",
          type: "skills-changed",
          data: {
            agentId: "otto",
            runId: `skill-workshop-review:${REVIEW}`,
            skills: [
              {
                name: "disk-check",
                action: "created",
                summary: "check free space before a big download",
              },
            ],
          },
        },
      }
    : {}),
  __openclaw: { id: "skill-note-1", idempotencyKey: SKILL_KEY },
});
/** The person's question and the bot's run: one command, then its reply. With `actions` false, the reply alone. */
const workedRun = (actions = true) => [
  said("user", "ask-1", "How much space is left on the disk?", 0),
  ...(actions
    ? [
        {
          role: "assistant",
          timestamp: EPOCH + 1_000,
          content: [
            { type: "toolCall", id: "call-1", name: "exec", arguments: { command: "df -h /" } },
          ],
          __openclaw: { id: "call-row", runId: "run-1" },
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "exec",
          content: [{ type: "text", text: "/dev/disk1  500G  460G  40G  92% /" }],
          isError: false,
          timestamp: EPOCH + 1_500,
          __openclaw: { id: "result-row", runId: "run-1" },
        },
      ]
    : []),
  said("assistant", "reply-1", REPLY, 3_000, "run-1"),
];

/** Otto's task with these rows, its runs rebuilt from them as after a reload, and its listed row. */
async function showRows(page: Page, rows: unknown[], row: Partial<Task> = {}) {
  const items = mapHistory(rows);
  const runs = runsFromHistory(rows, null, {
    sessionKey: TASK,
    now: NOW.getTime(),
    raw: new RawTable(),
  });
  await page.evaluate(
    ({ items, runs, row, key }) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        transcripts: {
          ...state.transcripts,
          [key]: { ...state.transcripts[key]!, items, runs, live: null, outbox: [] },
        },
        tasksByBot: {
          ...state.tasksByBot,
          otto: state.tasksByBot.otto!.map((task) =>
            task.key === key ? { ...task, ...row } : { ...task, updatedAt: 1 },
          ),
        },
      }));
    },
    { items, runs, row, key: TASK },
  );
  await settle(page);
}

const runLine = (page: Page) => transcript(page).getByTestId("run-line");
const sentOf = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { clawtrateFixture: { sent: BridgeCommand[] } }).clawtrateFixture.sent,
  );

for (const size of [WIDE, PHONE]) {
  test.describe(`the folded skill note ${size.name}`, () => {
    test.use(contextFor(size));

    test(`F-560: the note folds into its run's line, closed and open, ${size.name}`, async ({
      page,
    }) => {
      await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed&access=admin`);
      await showRows(page, [...workedRun(), skillNote(true)], {
        preview: SKILL_LISTED,
        updatedAt: EPOCH + 40_005,
      });
      // Never a bubble: the transcript draws the reply, and the note only on the run's line.
      await expect(transcript(page).getByText(REPLY)).toHaveCount(1);
      await expect(page.getByTestId("transcript-turn").filter({ hasText: "Learned" })).toHaveCount(
        0,
      );
      await expect(runLine(page)).toHaveCount(1);
      const line = runLine(page).locator(":scope > summary");
      await expect(line).toContainText("Saved a skill: disk-check");
      await expect(line).toHaveAccessibleName(/^Worked · 1 action · Saved a skill: disk-check$/);
      await expect(page.getByTestId("skill-note")).toBeHidden();
      await expect(page).toHaveScreenshot(`skill-note-folded-${size.name}.png`);
      // Opened by keyboard: the note's own text, whole, and its undo.
      await line.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("skill-note")).toBeVisible();
      await expect(page.getByTestId("skill-note").locator(".skill-note-text")).toHaveText(
        SKILL_TEXT,
      );
      await expect(
        page.getByRole("button", { name: "Undo: Saved a skill: disk-check" }),
      ).toBeVisible();
      await page.getByTestId("skill-note").scrollIntoViewIfNeeded();
      await expect(page).toHaveScreenshot(`skill-note-open-${size.name}.png`);
      // Nothing scrolls sideways at this width.
      expect(
        await transcript(page).evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
    });
  });
}

test.describe("the folded skill note's undo, preview and activity", () => {
  test.use(contextFor(WIDE));

  test("F-560: on 2026.11.10, Undo asks the gateway to undo the review and says it did", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed&access=admin`);
    await showRows(page, [...workedRun(), skillNote(true)]);
    await runLine(page).locator(":scope > summary").click();
    await page.getByRole("button", { name: "Undo: Saved a skill: disk-check" }).click();
    await expect(page.getByTestId("skill-note-undo").getByRole("status")).toHaveText("Undone.");
    const sent = await sentOf(page);
    expect(sent.filter((command) => command.type === "undoSkillChange")).toEqual([
      expect.objectContaining({ type: "undoSkillChange", agentId: "otto", reviewId: REVIEW }),
    ]);
    expect(sent.some((command) => command.type === "sendMessage")).toBe(false);
  });

  test("F-560: on 2026.11.10 without admin access, the line says what undoing it needs", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed&access=write`);
    await showRows(page, [...workedRun(), skillNote(true)]);
    await runLine(page).locator(":scope > summary").click();
    await expect(page.getByTestId("skill-note-undo")).toHaveText(
      "Undoing it needs admin access to this gateway.",
    );
    await expect(page.getByTestId("skill-note-undo").getByRole("button")).toHaveCount(0);
  });

  test('F-560: on 2026.10.6, the undo sends "undo" to the bot and says so', async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed&access=admin`);
    await showRows(page, [...workedRun(), skillNote(false)]);
    await runLine(page).locator(":scope > summary").click();
    await page.getByRole("button", { name: 'Send "undo" to Otto' }).click();
    await expect(page.getByTestId("skill-note-undo").getByRole("status")).toHaveText(
      'Sent "undo" to Otto.',
    );
    const sent = await sentOf(page);
    expect(sent.filter((command) => command.type === "sendMessage")).toEqual([
      expect.objectContaining({ type: "sendMessage", key: TASK, text: "undo" }),
    ]);
    expect(sent.some((command) => command.type === "undoSkillChange")).toBe(false);
  });

  test("F-560: with Show commands on, the note still folds into the run's line", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed&commands=show&access=admin`);
    await showRows(page, [...workedRun(), skillNote(true)]);
    await expect(runLine(page).locator(":scope > summary")).toContainText(
      "Saved a skill: disk-check",
    );
    await expect(page.getByTestId("transcript-turn").filter({ hasText: "Learned" })).toHaveCount(0);
  });

  test("F-560: a note after a run with no actions is a line of its own", async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed&access=admin`);
    await showRows(page, [...workedRun(false), skillNote(true)]);
    // A run with no actions has no line, so the note has its own.
    await expect(runLine(page)).toHaveCount(0);
    const alone = page.getByTestId("skill-note-line");
    await expect(alone).toHaveCount(1);
    await expect(alone.locator(":scope > summary")).toHaveAccessibleName(
      "Saved a skill: disk-check",
    );
    await expect(page.getByTestId("transcript-turn").filter({ hasText: "Learned" })).toHaveCount(0);
    await alone.locator(":scope > summary").click();
    await expect(alone.locator(".skill-note-text")).toHaveText(SKILL_TEXT);
  });

  test("F-560: the bot's preview is the reply before the note the gateway lists", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed&access=admin`);
    await showRows(page, [...workedRun(), skillNote(true)], {
      preview: SKILL_LISTED,
      updatedAt: EPOCH + 40_005,
    });
    await expect(preview(page)).toHaveText(REPLY);
  });

  test("F-560: a note arriving while the person reads back is not new activity", async ({
    page,
  }) => {
    await open(page);
    await update(page, { items: mapHistory(PAGE) });
    const top = await readBack(page);
    await update(page, { items: mapHistory([...PAGE.slice(1), skillNote(true, 5_000)]) });
    await expect(jump(page)).toHaveCount(0);
    expect((await measured(page)).top).toBe(top);
  });

  test("F-560: a bot's message in the note's exact form that names its run is the bot's message", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed&access=admin`);
    const copied = { ...skillNote(false), __openclaw: { id: "copy-1", runId: "run-1" } };
    await showRows(page, [...workedRun(), copied]);
    await expect(page.getByTestId("transcript-turn").filter({ hasText: "Learned" })).toHaveCount(1);
    await expect(runLine(page).locator(":scope > summary")).not.toContainText("Saved a skill");
  });
});
