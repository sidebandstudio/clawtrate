// The gateway's skill-change note in the mounted conversation and rail, fed to
// the fixture as the host's next snapshot would bring it (docs/parity.md F-560):
// it is not new activity for "Jump to latest", hidden or shown, and the view at
// the end keeps up; and the bot's preview leaves it out only when the gateway's
// listed preview is that note. Every name and text is invented.
import { test, type Page } from "@playwright/test";
import {
  mapHistory,
  type ClawtrateState,
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
/** The note as OpenClaw 2026.10.6 writes it. */
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

/** Otto's task's history, and its row in the list, as the host's next snapshot would have them. */
async function update(page: Page, data: { items?: TranscriptItem[]; row?: Partial<Task> }) {
  await page.evaluate(
    ({ items, row, key }) => {
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
            [key]: { ...held, ...(items ? { items, live: null, runs: [], outbox: [] } : {}) },
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

test.describe("the gateway's skill notes", () => {
  test.use(contextFor(SIZES[0]!));

  for (const commands of [false, true]) {
    test(`F-560: a note arriving on a full page while the person reads back is not new activity, with commands ${commands ? "shown" : "hidden"}; a real reply is`, async ({
      page,
    }) => {
      await open(page, commands);
      await update(page, { items: mapHistory(PAGE) });
      const top = await readBack(page);
      // The note takes the last place on the page and the first message leaves it.
      await update(page, { items: mapHistory([...PAGE.slice(1), note("note-1")]) });
      await expect(transcript(page).getByText(NOTE_TEXT)).toHaveCount(commands ? 1 : 0);
      await expect(jump(page)).toHaveCount(0);
      expect((await measured(page)).top).toBe(top);
      // A reply the person can see is new.
      await update(page, {
        items: mapHistory([
          ...PAGE.slice(2),
          note("note-1"),
          said("assistant", "reply-1", "A new reply.", 5_000, "run-new"),
        ]),
      });
      await expect(jump(page)).toHaveText("Jump to latest");
      await jump(page).click();
      await atEnd(page);
    });

    test(`F-560: at the end, the view keeps up with a note and a reply, with commands ${commands ? "shown" : "hidden"}`, async ({
      page,
    }) => {
      await open(page, commands);
      const first = PAGE.slice(0, 30);
      await update(page, { items: mapHistory(first) });
      await atEnd(page);
      const before = await measured(page);
      await update(page, { items: mapHistory([...first, note("note-1")]) });
      await atEnd(page);
      const afterNote = await measured(page);
      // Shown, the note is followed; hidden, nothing moves.
      if (commands) expect(afterNote.top).toBeGreaterThan(before.top);
      else expect(afterNote.top).toBe(before.top);
      await update(page, {
        items: mapHistory([
          ...first,
          note("note-1"),
          said("assistant", "reply-1", "Another reply.", 5_000, "run-new"),
        ]),
      });
      await expect(transcript(page).getByText("Another reply.")).toBeInViewport();
      await atEnd(page);
      await expect(jump(page)).toHaveCount(0);
    });
  }

  test("F-560: a hidden note that pushes a merged turn's first row off a full page is not new activity", async ({
    page,
  }) => {
    await open(page);
    const run = "run-long";
    const opening = said("assistant", "opening", "Starting the review.", 300, run);
    const rounds = Array.from({ length: 33 }, (_, n) => [
      {
        ...said("assistant", `batch-${n}`, "", 400 + n, run),
        content: Array.from({ length: 5 }, (_, t) => ({
          type: "toolCall",
          name: "read",
          id: `call-${n}-${t}`,
          arguments: { path: "sample.md" },
        })),
        stopReason: "toolUse",
      },
      ...Array.from({ length: 5 }, (_, t) => ({
        role: "toolResult",
        timestamp: EPOCH + 400 + n,
        content: "Sample text.",
        toolCallId: `call-${n}-${t}`,
        __openclaw: { id: `result-${n}-${t}`, runId: run },
      })),
    ]).flat();
    const findings = Array.from({ length: 60 }, (_, n) => `Finding ${n + 1}.`).join("\n\n");
    const final = said("assistant", "final", findings, 900, run);
    const before = [opening, ...rounds, final];
    const after = [...before.slice(1), note("note-1")];
    expect([before.length, after.length]).toEqual([200, 200]);
    // The turn's display item changes with its first row; the message it shows does not.
    const shown = [before, after].map((rows) =>
      mapHistory(rows).findLast((item) => item.skillNote !== true),
    );
    expect(shown.map((item) => item?.messageId)).toEqual(["final", "final"]);
    expect(shown[0]!.id).not.toBe(shown[1]!.id);

    await update(page, { items: mapHistory(before) });
    await expect(transcript(page).getByText("Finding 60.")).toHaveCount(1);
    const top = await readBack(page);
    await update(page, { items: mapHistory(after) });
    await expect(transcript(page).getByText(NOTE_TEXT)).toHaveCount(0);
    await expect(jump(page)).toHaveCount(0);
    expect((await measured(page)).top).toBe(top);
  });

  test("F-560: turning Show commands on keeps the place the person reads and is not new activity", async ({
    page,
  }) => {
    await open(page);
    await update(page, { items: mapHistory([...PAGE.slice(1), note("note-1")]) });
    const top = await readBack(page);
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Advanced", exact: true }).click();
    const toggle = settings.getByRole("switch", { name: "Show commands" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await page.keyboard.press("Escape");
    await settle(page);
    await expect(transcript(page).getByText(NOTE_TEXT)).toHaveCount(1);
    await expect(jump(page)).toHaveCount(0);
    expect((await measured(page)).top).toBe(top);
  });

  test("F-560: the bot's preview leaves out the note only when the listed preview is that note, whatever the clocks say", async ({
    page,
  }) => {
    await open(page);
    const history = mapHistory([said("assistant", "prior", "Old reply.", 800), note("note-1")]);
    // The list's preview is the note: the rail shows the reply before it.
    await update(page, { items: history, row: { updatedAt: EPOCH + 1_005, preview: NOTE_TEXT } });
    await expect(preview(page)).toHaveText("Old reply.");
    // A newer reply on the list shows at once, though the history still ends with the note.
    await update(page, { row: { updatedAt: EPOCH + 5_005, preview: "New reply." } });
    await expect(preview(page)).toHaveText("New reply.");
  });
});
