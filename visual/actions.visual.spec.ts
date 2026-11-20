// The action cards (docs/design/conversation.md, sections 7 to 9): each
// scene matches its approved baseline at 1440, 1100, 800 and 390 px in both
// themes, and the cards behave as the design says. The scenes are written in
// the gateway's own shapes and go through the engine
// (apps/desktop/src/fixture/actions.ts).
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/index.ts";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const open = (page: Page, scene: string, theme: "light" | "dark" = "light", extra = "") =>
  openFixture(page, `scene=${scene}&${OTTO_DISK}&panel=closed${extra}`, theme);

const transcript = (page: Page) => page.getByTestId("transcript");
/** The action cards and folds in the transcript, in order. */
const cards = (page: Page) => page.locator(".transcript details.card.action");
const line = (locator: Locator) => locator.locator(":scope > summary");
const names = (page: Page) =>
  cards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector(":scope > summary")!.getAttribute("aria-label")!),
  );

/** Change the fixture's state, as the host's next snapshot would. */
async function setState(page: Page, change: string, arg?: unknown) {
  await page.evaluate(
    ([source, value]) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      const apply = new Function("state", "value", source) as (
        s: ClawtrateState,
        v: unknown,
      ) => ClawtrateState;
      fixture.setState((state) => apply(state, value));
    },
    [change, arg] as const,
  );
}

/** Scroll so an element's top is at the reading line, the same way every time. */
async function atReadingLine(target: Locator) {
  await settle(target.page());
  await expect
    .poll(
      () =>
        target.evaluate(async (element) => {
          const scroller = element.closest<HTMLElement>('[data-testid="transcript"]')!;
          const band =
            Number.parseFloat(getComputedStyle(scroller.firstElementChild!).paddingTop) || 0;
          const offset = () =>
            element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - band;
          const desired = () =>
            Math.min(
              scroller.scrollHeight - scroller.clientHeight,
              Math.max(0, scroller.scrollTop + Math.round(offset())),
            );
          scroller.scrollTop = desired();
          scroller.dispatchEvent(new Event("scroll"));
          // Opening a details row can still move the transcript on the next layout.
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          return Math.abs(scroller.scrollTop - desired());
        }),
      { message: "place the opened summary at the reading line for the screenshot" },
    )
    .toBeLessThanOrEqual(1);
}

// Baselines ---------------------------------------------------------------------------

const BASELINES: Array<{ scene: string; rows: string; prepare?: (page: Page) => Promise<void> }> = [
  { scene: "actions-short", rows: "F-488 F-090" },
  { scene: "actions-long", rows: "F-488 F-090 F-092" },
  { scene: "actions-thought", rows: "F-423" },
  { scene: "actions-running", rows: "F-082 F-432" },
  { scene: "actions-failed", rows: "F-092 F-294" },
  { scene: "actions-mixed", rows: "F-092" },
  { scene: "actions-question", rows: "F-488" },
  {
    scene: "actions-failed",
    rows: "F-293",
    prepare: async (page) => {
      // A fold opened, with its failed row open on Readable.
      const fold = cards(page).first();
      await line(fold).click();
      await fold.locator(".step").nth(1).locator(":scope > summary").click();
      await atReadingLine(line(fold));
    },
  },
  {
    scene: "actions-short",
    rows: "F-093",
    prepare: async (page) => {
      // Raw open on the command.
      const command = cards(page).nth(1);
      await line(command).click();
      await command.getByRole("tab", { name: "Raw" }).click();
      await expect(command.getByText("Arguments")).toBeVisible();
      await atReadingLine(line(command));
    },
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`actions ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const view of BASELINES) {
        const name = `${view.scene}${view.prepare ? `-${view.rows.split(" ")[0]}` : ""}`;
        test(`${view.rows}: ${name} matches its baseline`, async ({ page }) => {
          await open(page, view.scene, theme);
          await expect(
            page.locator(".transcript :is(details.card.action, .thought)").first(),
          ).toBeVisible();
          if (view.prepare) await view.prepare(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`actions-${name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}

// Behaviour ---------------------------------------------------------------------------

test.describe("action cards", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("a question takes its own ask_user call's place, found by the gateway's question id; an ask_user that failed first stays a failed action", async ({
    page,
  }) => {
    await open(page, "actions-question");
    const question = page.getByTestId("question-card");
    await expect(question).toHaveCount(1);
    // The failed call is an ordinary failed action, in its place among the reads.
    await expect(cards(page)).toHaveCount(3);
    expect(
      await cards(page).evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-call"))),
    ).toEqual(["call_1_01", "call_1_02", "call_1_03"]);
    await expect(line(cards(page).nth(1))).toHaveAccessibleName(
      /^Couldn't ask a question, .*, failed$/,
    );
    // The question follows the marker read, where its call was; the valid call is not drawn again.
    const order = await page
      .locator('.transcript :is(details.card.action, [data-testid="question-card"])')
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-call") ?? n.getAttribute("data-testid")),
      );
    expect(order).toEqual(["call_1_01", "call_1_02", "call_1_03", "question-card"]);
    await expect(page.locator('[data-call="call_1_04"]')).toHaveCount(0);
  });

  test("F-488: one call of every listed kind shows its label, in order; nothing opened, no reasoning on screen", async ({
    page,
  }) => {
    await open(page, "actions-kinds");
    const all = await names(page);
    const labels = all.map((name) => name.split(",")[0]);
    expect(labels).toEqual([
      "Read notes.md",
      "Looked in logs",
      "Edited house-log.md",
      "Saved to memory",
      'Searched memory for "boiler service"',
      "Ran du",
      "Looked at shared terminals",
      'Searched the web for "cold climate heat pump"',
      'Searched posts on X for "heat pump rebate"',
      "Opened energy.example.org",
      "Opened shop.example",
      "Looked at the screen",
      "Looked at the phone",
      "Changed the Control UI",
      "Created routine Weekly cleanup",
      "Looked through tasks",
      "Started a helper: Price check",
      "Made a plan",
      "Made 2 images",
      "Read 3 PDFs",
      "Message on Telegram",
      "Used linear",
      // Its result has no field the design reads: the call is made, nothing more (7.3).
      "Call to skills search",
    ]);
    // Nothing is open, and no reasoning text, argument or raw payload is on screen.
    await expect(page.locator(".transcript details[open]")).toHaveCount(0);
    await expect(page.locator(".step-thought:visible")).toHaveCount(0);
    await expect(page.locator(".raw-panel")).toHaveCount(0);
  });

  test("F-090: a run that kept 128 of 400 actions says so on its run line and in line where the gap is; text keeps its call", async ({
    page,
  }) => {
    await open(page, "actions-retained");
    const runLine = page.getByTestId("run-line").locator("summary");
    await expect(runLine).toHaveAccessibleName(/^Worked for 6m 41s · 400 actions · 128 shown$/);
    const gap = page.getByTestId("actions-not-kept");
    await expect(gap).toHaveCount(1);
    await expect(gap).toHaveText(
      "272 actions not kept here; the gateway's transcript still has them",
    );
    // The note is in line, before the first action kept.
    const order = await page
      .locator('.transcript :is([data-testid="actions-not-kept"], details.card.action)')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-testid") ?? "card"));
    expect(order[0]).toBe("actions-not-kept");
    // The text written before call 390 is directly before the card that holds it.
    const text = page.locator(".bubble", { hasText: "The last eleven logs are this week's." });
    await expect(text).toHaveCount(1);
    const next = text.locator(
      "xpath=following::details[contains(concat(' ', @class, ' '), ' action ')][1]",
    );
    // A fold of the last eleven, whose first member is call 390.
    await expect(next).toHaveAttribute("data-first", "call_r390");
    await expect(next).toHaveAttribute("data-fold", "11");
  });

  test("F-090: the run line counts the run's actions as its cards are drawn: a failure history alone holds is counted", async ({
    page,
  }) => {
    await open(page, "actions-retained-history");
    // The first read failed; only history's row holds it, since the engine kept the newest 128.
    await setState(
      page,
      `const key = "agent:otto:disk-space"; const t = state.transcripts[key];
       const items = t.items.map((item) => ({ ...item, blocks: item.blocks.map((b, i) =>
         b.kind === "tool-call" && b.callId === "call_1_01"
           ? { ...b, result: { isError: true, text: "ENOENT: no such file or directory" } } : b) }));
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, items } } };`,
    );
    const fold = cards(page).first();
    await expect(line(fold)).toHaveAccessibleName(/, 1 failed$/);
    await expect(page.getByTestId("run-line").locator("summary")).toHaveAccessibleName(
      "Worked · 150 actions · 1 failed",
    );
  });

  test("F-093: Raw for a call history alone holds shows its arguments as received: none says they weren't kept, an explicit null stays null", async ({
    page,
  }) => {
    await open(page, "actions-history");
    await setState(
      page,
      `const key = "agent:otto:disk-space"; const t = state.transcripts[key];
       const user = { id: "u-old", role: "user", timestamp: Date.now() - 1, model: null, blocks: [{ kind: "text", text: "Old calls." }] };
       const done = { isError: false, text: "ok" };
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, runs: [], items: [user,
         { id: "a-absent", role: "assistant", timestamp: Date.now(), model: null, blocks: [
           { kind: "tool-call", callId: "old-absent", name: "custom_lookup", argumentsText: "", argumentsAbsent: true, result: done }] },
         { id: "a-between", role: "assistant", timestamp: Date.now(), model: null, blocks: [{ kind: "text", text: "Between." }] },
         { id: "a-null", role: "assistant", timestamp: Date.now(), model: null, blocks: [
           { kind: "tool-call", callId: "old-null", name: "custom_lookup", argumentsText: "null", result: done }] },
       ] } } };`,
    );
    const raw = async (id: string) => {
      const card = page.locator(`[data-call="${id}"]`);
      await line(card).click();
      await card.getByRole("tab", { name: "Raw" }).click();
      return card.getByRole("region", { name: "What the gateway sent" });
    };
    const absent = await raw("old-absent");
    await expect(absent.getByTestId("raw-missing")).toHaveText("ArgumentsArguments weren't kept.");
    await expect(absent).not.toContainText("{}");
    const explicit = await raw("old-null");
    await expect(
      explicit.getByText("Arguments, from the history the gateway returned"),
    ).toBeVisible();
    await expect(explicit.locator("pre").first()).toHaveText("null");
    await expect(explicit).not.toContainText("{}");
  });

  test("F-093: Raw shows only parts received, each under its heading, and says which were not: a start with no result, and a result with no start", async ({
    page,
  }) => {
    // One call of a reloaded run: the engine's step holds the call's start as history sent it,
    // and no result.
    await open(page, "actions-short");
    await setState(
      page,
      `const key = "agent:otto:disk-space"; const t = state.transcripts[key]; const base = t.runs[0];
       const seed = base.steps.find((s) => s.kind === "tool");
       const user = { id: "u-raw", role: "user", timestamp: Date.now() - 1, model: null, blocks: [{ kind: "text", text: "Read it." }] };
       const startOnly = { ...seed, id: "tool:start-only", toolCallId: "start-only", toolName: "read", status: "running",
         rowTimes: true, args: { path: "empty.md" }, result: null, details: null, output: null, rawSize: null,
         raw: { source: "history", runId: base.id, call: { type: "toolCall", id: "start-only", name: "read", arguments: { path: "empty.md" } }, result: null } };
       const resultOnly = { ...seed, id: "tool:result-only", toolCallId: "result-only", toolName: "read", status: "done",
         args: null, argsText: null, result: { text: "Output as received", totalChars: 18 }, details: { kind: "file" }, output: null, rawSize: null,
         raw: { source: "live", runId: base.id, call: null, result: { phase: "result", name: "read", toolCallId: "result-only",
           result: { content: [{ type: "text", text: "Output as received" }], details: { kind: "file" } } } } };
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t,
         runs: [{ ...base, anchorItemId: user.id, steps: [startOnly, resultOnly], origin: "history", state: "completed" }],
         items: [user, { id: "a-raw", role: "assistant", timestamp: Date.now(), model: null, blocks: [
           { kind: "tool-call", callId: "start-only", name: "read", argumentsText: '{"path":"empty.md"}', result: null },
           { kind: "text", text: "Between." },
           { kind: "tool-call", callId: "result-only", name: "read", argumentsText: "{}", result: { text: "Output as received", isError: false } },
         ] }] } } };`,
    );
    const raw = async (id: string) => {
      const card = page.locator(`[data-call="${id}"]`);
      await line(card).click();
      await card.getByRole("tab", { name: "Raw" }).click();
      return card.getByRole("region", { name: "What the gateway sent" });
    };
    // A start with no result: its arguments, and the result said not to be there.
    const start = await raw("start-only");
    await expect(start.locator(".code-label", { hasText: /^Arguments$/ })).toHaveCount(1);
    await expect(start).toContainText("empty.md");
    await expect(start.getByTestId("raw-missing")).toHaveText(
      "ResultThe gateway's history holds no result for this call.",
    );
    await expect(start.locator(".code-label", { hasText: /^Result$/ })).toHaveCount(1);
    // A result with no start: no "Arguments null", the arguments said not to be there.
    const result = await raw("result-only");
    await expect(result).not.toContainText("null");
    await expect(result.getByTestId("raw-missing")).toHaveText(
      "ArgumentsThis app received no start for this call, so its arguments are not here.",
    );
    await expect(result).toContainText("Output as received");
  });

  test("F-090: history that draws every action the engine dropped says none is missing: the run line counts what is drawn, and no gap line is drawn", async ({
    page,
  }) => {
    await open(page, "actions-retained-history");
    // All 150 reads are drawn: history's rows hold the 22 the engine's retention dropped.
    const drawn = await page
      .locator(".transcript details.card.action[data-kind='read']")
      .evaluateAll((nodes) =>
        nodes.reduce((n, node) => n + Number((node as HTMLElement).dataset.fold ?? 1), 0),
      );
    expect(drawn).toBe(150);
    await expect(page.getByTestId("actions-not-kept")).toHaveCount(0);
    await expect(page.getByTestId("run-line").locator("summary")).toHaveAccessibleName(
      "Worked · 150 actions",
    );
  });

  test("F-093: Raw never builds a result: a call history kept no result for is unavailable, and kept text names where it came from", async ({
    page,
  }) => {
    await open(page, "actions-history");
    await setState(
      page,
      `const key = "agent:otto:disk-space";
       const t = state.transcripts[key];
       const block = (callId, path, result) => ({
         kind: "tool-call", callId, name: "custom_lookup",
         argumentsText: JSON.stringify({ path }), result,
       });
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, runs: [], items: [
         { id: "h-user", role: "user", timestamp: Date.now(), model: null, blocks: [{ kind: "text", text: "Look them up." }] },
         { id: "h-a", role: "assistant", timestamp: Date.now(), model: null, blocks: [block("call_none", "a.md", null)] },
         { id: "h-t", role: "assistant", timestamp: Date.now(), model: null, blocks: [{ kind: "text", text: "Between." }] },
         { id: "h-b", role: "assistant", timestamp: Date.now(), model: null, blocks: [block("call_text", "b.md", { isError: false, text: "two entries" })] },
       ] } } };`,
    );
    const none = page.locator('[data-call="call_none"]');
    await line(none).click();
    await none.getByRole("tab", { name: "Raw" }).click();
    // Its arguments, as history holds them, and its result said to be missing.
    await expect(none.getByTestId("raw-missing")).toHaveText(
      "ResultThe gateway's history holds no result for this call.",
    );
    await expect(none.getByText('"content"')).toHaveCount(0);
    const kept = page.locator('[data-call="call_text"]');
    await line(kept).click();
    await kept.getByRole("tab", { name: "Raw" }).click();
    await expect(
      kept.getByText("Result text, from the history the gateway returned"),
    ).toBeVisible();
    await expect(kept.locator(".raw-panel pre").last()).not.toContainText('"content"');
    await expect(
      kept.locator(".raw-panel").getByText("two entries", { exact: true }),
    ).toBeVisible();
  });

  test("F-488: closed cards say no more than happened, also after a reload: Partial is not counted as done, a cut page is partial, a refused PDF read and a read without contents are not read", async ({
    page,
  }) => {
    await open(page, "actions-outcomes");
    expect(await names(page)).toEqual([
      'Searched memory 1 time, "loft insulation", "heating bills", 1 partial',
      "Opened energy.example.org, Heat pump guide, partial",
      "Didn't read 11 PDFs, Too many PDFs: 11 provided, maximum is 10. Please reduce the number., too many",
      "Couldn't read survey.pdf, Read did not return file contents because it detected a binary document [application/pdf], unavailable",
    ]);
    // The partial search is counted as partial, never in the done plural.
    const memory = cards(page).first();
    await expect(memory.locator(".action-verb")).toHaveText("Searched memory");
    await expect(memory.locator(".action-object")).toHaveText("1 time");
  });

  test("F-488 F-091: a run of six reads is one card with a count; reasoning between actions is not shown", async ({
    page,
  }) => {
    await open(page, "actions-history");
    await expect(cards(page)).toHaveCount(1);
    await expect(line(cards(page).first())).toHaveAccessibleName(
      /^Read 6 files, backup-2026-11-01\.log/,
    );
    await expect(cards(page).first()).toHaveAttribute("data-fold", "6");
    await open(page, "actions-long");
    await expect(page.getByText("The floor plan and the bills give the heat demand.")).toBeHidden();
    // Reasoning between actions is in the card it led to, drawn only when that card is opened.
    await expect(page.locator(".thought")).toHaveCount(0);
  });

  test("F-090: each run with actions ends with one run line: worked, failed count; a run with no action has none", async ({
    page,
  }) => {
    await open(page, "actions-short");
    const run = page.getByTestId("run-line");
    await expect(run).toHaveCount(1);
    // A run read from history reports no duration: its rows' times are not the run's own.
    await expect(run.locator("summary")).toHaveAccessibleName("Worked · 2 actions");
    await open(page, "actions-failed");
    await expect(page.getByTestId("run-line").locator("summary")).toHaveAccessibleName(
      /^Worked · 6 actions · 2 failed · 1 unavailable$/,
    );
    await expect(page.getByTestId("run-line").locator(".run-failed")).toHaveText("2 failed");
    await open(page, "actions-thought");
    await expect(page.getByTestId("run-line")).toHaveCount(0);
    // Opened, the run line is the run's record, with its id to copy.
    await open(page, "actions-short");
    await page.getByTestId("run-line").locator("summary").click();
    await expect(page.getByTestId("run-line")).toContainText(
      "scripted/dev-1 · effort not reported",
    );
    await expect(page.getByRole("button", { name: "Copy run id" })).toBeVisible();
    // The effort the task asks for, when its row records one.
    await setState(
      page,
      `const tasks = Object.fromEntries(Object.entries(state.tasksByBot).map(([bot, list]) =>
         [bot, list.map((t) => t.key === "agent:otto:disk-space" ? { ...t, effort: "high" } : t)]));
       return { ...state, tasksByBot: tasks };`,
    );
    await expect(page.getByTestId("run-line")).toContainText(
      "scripted/dev-1 · requested effort high",
    );
  });

  test("F-090: a stopped run's line reads Stopped after, under the stop note", async ({ page }) => {
    await open(page, "run-stopped");
    await expect(page.getByTestId("run-line").locator("summary")).toHaveAccessibleName(
      /^Stopped after 40s · 1 action/,
    );
    const note = await page.getByTestId("stop-note").boundingBox();
    const runLine = await page.getByTestId("run-line").boundingBox();
    expect(runLine!.y).toBeGreaterThan(note!.y);
  });

  test("F-091: a call waiting for approval is its waiting card, then the approval card, counted once", async ({
    page,
  }) => {
    await open(page, "run-waiting");
    const waiting = cards(page).last();
    await expect(line(waiting)).toHaveAccessibleName(
      /^Wants to run rm, rm -rf \/srv\/media\/cache\/thumbs, waiting for you$/,
    );
    // The approval card follows it directly, ending the column.
    await expect(waiting.locator("xpath=following-sibling::*[1]")).toHaveAttribute(
      "data-testid",
      "approval-card",
    );
    await expect(page.locator('[data-testid="approval-card"]')).toHaveCount(1);
  });

  test("F-092 F-294: a failure is on its own line; a fold names its first problem and counts problems in order", async ({
    page,
  }) => {
    await open(page, "actions-failed");
    const fold = cards(page).nth(0);
    // The plural counts the reads that were done; the failed one is named and counted beside it.
    await expect(line(fold)).toHaveAccessibleName(
      "Read 2 files, couldn't read backup-2026-11-08.log, 1 failed",
    );
    await expect(fold.locator(".action-detail")).toHaveAttribute("data-tone", "danger");
    // Two commands fold; the timed-out one is named on the fold's line.
    const commands = cards(page).nth(1);
    await expect(line(commands)).toHaveAccessibleName("Ran 1 command, timed out: rsync, 1 failed");
    await line(commands).click();
    const rows = commands.locator(".fold-rows .step > summary");
    // A non-zero exit is the command's answer, not a failure.
    await expect(rows.nth(0)).toHaveAccessibleName(
      "Ran grep, grep -c transcode /etc/backup/exclude, exit 1, done",
    );
    await expect(rows.nth(1)).toHaveAccessibleName("Timed out: rsync, its 120s limit, timed out");
    await expect(line(cards(page).nth(2))).toHaveAccessibleName(
      'Couldn\'t search posts on X for "heat pump rebate 2026 experiences", x_search needs xAI credentials, unavailable',
    );
    // The error stays in Raw, as the gateway sent it.
    const timedOut = commands.locator(".fold-rows .step").nth(1);
    await timedOut.locator(":scope > summary").click();
    await timedOut.getByRole("tab", { name: "Raw" }).click();
    await expect(timedOut.getByRole("region", { name: "What the gateway sent" })).toContainText(
      "Command timed out after 120 seconds.",
    );
    // A mixed fold: the first problem in row order, its count, and a waiting member waits.
    await open(page, "actions-mixed");
    await expect(line(cards(page).nth(0))).toHaveAccessibleName(
      'Searched memory 1 time, couldn\'t search memory for "loft insulation", 1 unavailable, 1 partial',
    );
    await expect(line(cards(page).nth(2))).toHaveAccessibleName(
      "Commands · 3 calls, 1 failed: couldn't run mv, waiting for you",
    );
  });

  test("F-294: a denial, a stop and an external effect left unknown each read as what the gateway established", async ({
    page,
  }) => {
    await open(page, "actions-short");
    await setState(
      page,
      `const key = "agent:otto:disk-space";
       const t = state.transcripts[key];
       const runs = t.runs.map((run) => ({ ...run, steps: run.steps.map((step, i) => i === 1
         ? { ...step, status: "failed", result: { text: "Exec denied (gateway id=apr_1, user-denied): tail", totalChars: 50 }, details: null }
         : step) }));
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, runs } } };`,
    );
    await expect(line(cards(page).nth(1))).toHaveAccessibleName(/^Didn't run tail, .*, denied$/);
  });

  test("F-293: one card opens to its readable view, with Raw one step further; a fold lists its actions, each opening to its own", async ({
    page,
  }) => {
    await open(page, "actions-short");
    const command = cards(page).nth(1);
    const before = await cards(page).nth(0).boundingBox();
    await line(command).click();
    await expect(command).toHaveAttribute("open", "");
    await expect(page.locator(".transcript details.card.action[open]")).toHaveCount(1);
    // Readable first: the command, where it runs, its output and its exit code.
    await expect(command.getByRole("tab", { name: "Readable" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(command.getByRole("tabpanel")).toContainText(
      "tail -n 2 logs/backup-2026-11-15.log",
    );
    await expect(command.getByRole("tabpanel")).toContainText("Exit code");
    // Nothing above it moved.
    expect((await cards(page).nth(0).boundingBox())!.y).toBe(before!.y);
    // A fold opens to one row per action, in the singular; a row opens to its own detail.
    await open(page, "actions-failed");
    const fold = cards(page).nth(0);
    await line(fold).click();
    const rows = fold.locator(".fold-rows > li > .step");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1).locator(":scope > summary")).toHaveAccessibleName(
      /^Couldn't read backup-2026-11-08\.log, ENOENT/,
    );
    await rows.nth(1).locator(":scope > summary").click();
    await expect(rows.nth(1).getByRole("tabpanel")).toContainText(
      "ENOENT: no such file or directory",
    );
    await rows.nth(1).getByRole("tab", { name: "Raw" }).click();
    await expect(rows.nth(1).getByRole("region", { name: "What the gateway sent" })).toContainText(
      "read",
    );
  });

  test("F-093: Raw shows the tool, arguments, result, timing and ids, each copyable; the tabs are one tab stop", async ({
    page,
  }) => {
    await open(page, "actions-short");
    const command = cards(page).nth(1);
    await line(command).click();
    const readable = command.getByRole("tab", { name: "Readable" });
    await readable.focus();
    await page.keyboard.press("ArrowRight");
    const raw = command.getByRole("tab", { name: "Raw" });
    await expect(raw).toBeFocused();
    await expect(raw).toHaveAttribute("aria-selected", "true");
    const panel = command.getByRole("region", { name: "What the gateway sent" });
    await expect(panel).toContainText("exec");
    await expect(panel).toContainText("tail -n 2 logs/backup-2026-11-15.log");
    await expect(panel).toContainText("03:25:03 backup: finished ok");
    for (const what of ["tool name", "arguments", "result", "tool call id", "run id", "session id"])
      await expect(panel.getByRole("button", { name: `Copy ${what}` })).toBeVisible();
    // History's rows give no time of the call's own: its timing is not reported, never a row's time.
    await expect(panel.getByRole("button", { name: "Copy started time" })).toHaveCount(0);
    await expect(panel.locator(".fields-row", { hasText: "Started" })).toContainText(
      "not reported",
    );
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await panel.getByRole("button", { name: "Copy tool call id" }).click();
    await expect(page.getByTestId("card-announcer")).toHaveText("Copied tool call id");
    await page.keyboard.press("Home");
  });

  test("F-423: reasoning before a reply is one folded line over it; opened it shows the text, with Raw; no card, no run line", async ({
    page,
  }) => {
    await open(page, "actions-thought");
    const thought = page.locator(".thought");
    await expect(thought).toHaveCount(1);
    // History keeps no times for a reasoning block: the line says "Thought", never a zero.
    await expect(thought.locator("summary")).toHaveText("Thought");
    await expect(thought).toHaveAttribute("data-place", "reply");
    await expect(page.getByText("The user asks whether a heat pump is worth it")).toBeHidden();
    await expect(cards(page)).toHaveCount(0);
    await expect(page.getByTestId("run-line")).toHaveCount(0);
    // The line sits directly over the reply's bubble.
    await expect(thought.locator("xpath=following-sibling::*[1]")).toHaveClass(/msg/);
    await thought.locator("summary").click();
    await expect(page.getByText("The user asks whether a heat pump is worth it")).toBeVisible();
    await thought.getByRole("button", { name: "Raw" }).click();
    await expect(thought.getByRole("region", { name: "What the gateway sent" })).toContainText(
      '"type": "thinking"',
    );
  });

  test("F-430: a closed card shows verb, icon, object, detail and state; hover gives the whole line", async ({
    page,
  }) => {
    await open(page, "actions-short");
    const read = cards(page).nth(0);
    await expect(read.locator(".action-verb")).toHaveText("Read");
    await expect(read.locator(".action-what svg.icon")).toHaveCount(1);
    await expect(read.locator(".action-object")).toHaveText("backup-2026-11-15.log");
    await expect(read.locator(".action-detail")).toHaveText("6 lines");
    // Read from history: no duration the gateway did not report.
    await expect(read.locator(".action-state")).toHaveText("");
    await expect(line(read)).toHaveAttribute("title", "Read backup-2026-11-15.log · 6 lines");
    const box = await line(read).boundingBox();
    expect(Math.round(box!.height)).toBe(40);
    // Each part is visibly there: on screen, opaque, with a colour unlike the card's, and not cut.
    for (const part of [
      ".action-verb",
      ".action-object",
      ".action-detail",
      ".action-what svg.icon",
    ]) {
      const seen = await read.locator(part).evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const card = getComputedStyle(element.closest(".card")!).backgroundColor;
        const colour = element instanceof SVGElement ? style.stroke || style.color : style.color;
        let opacity = 1;
        for (let e: Element | null = element; e; e = e.parentElement)
          opacity *= Number(getComputedStyle(e).opacity);
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          size: rect.width > 4 && rect.height > 4,
          shown: style.visibility === "visible" && style.display !== "none" && opacity > 0.9,
          contrast: colour !== card && colour !== "rgba(0, 0, 0, 0)",
          onTop:
            hit !== null && (hit === element || element.contains(hit) || hit.contains(element)),
          whole: element instanceof SVGElement || element.scrollWidth <= element.clientWidth + 1,
        };
      });
      expect(seen, part).toEqual({
        size: true,
        shown: true,
        contrast: true,
        onTop: true,
        whole: true,
      });
    }
    // A live card reports the duration the gateway's events gave.
    await open(page, "actions-running");
    const live = cards(page).filter({
      has: page.locator(':scope > summary[aria-label^="Read 2 files"]'),
    });
    await expect(live.locator(".action-state")).toHaveText("2.0s");
  });

  test("F-082 F-087: the status line says the running card's words, its tooltip is the whole phrase, and it brings that card into view and focuses its line without opening it", async ({
    page,
  }) => {
    await open(page, "actions-running");
    const status = page.getByTestId("status-line");
    const running = cards(page).last();
    await expect(line(running)).toHaveAccessibleName(
      /^Running du, du -sh \/srv\/media\/\*, running$/,
    );
    await expect(status.getByTestId("status-phrase")).toHaveText("Running du");
    await expect(status).toHaveAttribute("title", "Running du");
    await expect(status).toHaveAccessibleName("Otto, working: Running du. Show the action.");
    await transcript(page).evaluate((element) => (element.scrollTop = 0));
    await status.click();
    await expect(line(running)).toBeFocused();
    await expect(running).not.toHaveAttribute("open", "");
    await expect(line(running)).toBeInViewport();
  });

  test("F-082 F-087: while a Messaged or T3 Code card's call runs, the status line says that card's words and brings the card into view", async ({
    page,
  }) => {
    for (const [scene, testId, words] of [
      ["messaged-started", "messaged-card", "Messaging Marlow"],
      ["t3-started", "t3-card", "Messaging T3 Code"],
    ] as const) {
      await openFixture(page, `scene=${scene}`, "light");
      const status = page.getByTestId("status-line");
      await expect(status.getByTestId("status-phrase")).toHaveText(words);
      const card = page.getByTestId(testId);
      await expect(card.locator(":scope > summary")).toHaveAccessibleName(/^Messaged /);
      await transcript(page).evaluate((element) => (element.scrollTop = 0));
      await status.click();
      await expect(card.locator(":scope > summary")).toBeFocused();
      await expect(card).not.toHaveAttribute("open", "");
      await expect(card).toBeInViewport();
    }
  });

  test("F-423: the Thought line of reasoning that led to a Messaged card's call is inside that card, not left in the conversation", async ({
    page,
  }) => {
    await openFixture(page, "scene=messaged-started", "light");
    const card = page.getByTestId("messaged-card");
    await expect(card).toHaveCount(1);
    // Reasoning before the send, as the engine records it: a reasoning step before the call.
    await setState(
      page,
      `const key = Object.keys(state.transcripts).find((k) =>
         state.transcripts[k].runs.some((r) => r.steps.some((s) => s.toolName === "sessions_send")));
       const t = state.transcripts[key];
       const runs = t.runs.map((r) => {
         const i = r.steps.findIndex((s) => s.toolName === "sessions_send");
         if (i === -1) return r;
         const at = r.steps[i].startedAt;
         const thought = { ...r.steps[i], id: "reasoning:" + r.id + ":start:0", kind: "reasoning",
           title: "Reasoning", toolName: null, toolCallId: null, status: "done",
           startedAt: at - 3000, endedAt: at - 1000, argsText: null,
           output: { text: "Marlow keeps the shared notes, so ask Marlow.", totalChars: 45 },
           result: null, error: null, raw: null, rawSize: null };
         return { ...r, steps: [...r.steps.slice(0, i), thought, ...r.steps.slice(i)] };
       });
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, runs } } };`,
    );
    const thought = page.locator(".transcript .thought");
    await expect(thought).toHaveCount(1);
    // Inside the card, so closed with it.
    await expect(card.locator(".thought")).toHaveCount(1);
    await expect(thought).toBeHidden();
    await card.locator(":scope > summary").click();
    await expect(card.locator(".thought")).toBeVisible();
    await expect(card.locator(".thought")).toContainText("Thought for 2s");
  });

  test("text written beside a tool call is one bubble before its card, never repeated as the streaming reply", async ({
    page,
  }) => {
    await open(page, "actions-running");
    const text = "Both logs are fine. Checking how full the disk is.";
    const bubble = page.getByText(text, { exact: true });
    await expect(bubble).toHaveCount(1);
    // It sits directly before the card of the call it came with.
    await expect(
      page.locator(".msg", { hasText: text }).locator("xpath=following-sibling::*[1]"),
    ).toHaveAttribute("data-call", "call_l3");
    // The gateway's chat stream carries the same text while that message streams: still one bubble.
    await setState(
      page,
      `const key = "agent:otto:disk-space";
       const t = state.transcripts[key];
       const runs = t.runs.map((run) => run.id === "run-live" ? { ...run, text: "Both logs are fine. Checking" } : run);
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, runs } } };`,
    );
    await expect(page.getByText("Both logs are fine. Checking")).toHaveCount(1);
    await expect(page.getByTestId("live-turn")).toHaveCount(0);
  });

  test("F-432: an opened running action shows its output as the gateway streams it", async ({
    page,
  }) => {
    await open(page, "actions-running");
    const running = cards(page).last();
    await line(running).click();
    await expect(running.getByText("Output so far")).toBeVisible();
    await expect(running.locator("pre")).toContainText("182G\t/srv/media/transcode-cache");
    // More output arrives: the open card shows it, before the call completes.
    await setState(
      page,
      `const key = "agent:otto:disk-space";
       const t = state.transcripts[key];
       const runs = t.runs.map((run) => ({ ...run, steps: run.steps.map((step) => step.toolCallId === "call_l3"
         ? { ...step, output: { text: step.output.text + "640G\\t/srv/media/films\\n", totalChars: 60 } }
         : step) }));
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, runs } } };`,
    );
    await expect(running.locator("pre")).toContainText("640G\t/srv/media/films");
    await expect(running).toHaveAttribute("data-status", "running");
  });

  test("F-429: an opened card and fold stay open across scrolling away and back, a switch to another task, and a reconnect", async ({
    page,
  }) => {
    await open(page, "actions-long");
    const fold = cards(page)
      .filter({ has: page.locator(":scope > summary", { hasText: "Read" }) })
      .first();
    await line(fold).click();
    const row = fold.locator(".fold-rows .step").first();
    await row.locator(":scope > summary").click();
    await row.getByRole("tab", { name: "Raw" }).click();
    const thought = fold.locator(".thought").first();
    await thought.locator("summary").click();
    // Scroll away and back.
    await transcript(page).evaluate((element) => (element.scrollTop = element.scrollHeight));
    await settle(page);
    await transcript(page).evaluate((element) => (element.scrollTop = 0));
    await expect(fold).toHaveAttribute("open", "");
    await expect(row).toHaveAttribute("open", "");
    await expect(row.getByRole("tab", { name: "Raw" })).toHaveAttribute("aria-selected", "true");
    // Another task and back.
    await page
      .getByTestId("bot-list")
      .getByRole("button", { name: /^Weekly backup check/ })
      .click();
    await expect(page.locator(".title-pill")).toContainText("Weekly backup check");
    await page
      .getByTestId("bot-list")
      .getByRole("button", { name: /^Disk almost full/ })
      .click();
    await expect(fold).toHaveAttribute("open", "");
    await expect(row).toHaveAttribute("open", "");
    await expect(row.getByRole("tab", { name: "Raw" })).toHaveAttribute("aria-selected", "true");
    await expect(thought).toHaveAttribute("open", "");
    // A reconnect: the connection drops and comes back; nothing the reader opened closes.
    await setState(
      page,
      `return { ...state, connection: { ...state.connection, status: "reconnecting" } };`,
    );
    await setState(
      page,
      `return { ...state, connection: { ...state.connection, status: "connected" } };`,
    );
    await expect(fold).toHaveAttribute("open", "");
    await expect(row).toHaveAttribute("open", "");
    await expect(thought).toHaveAttribute("open", "");
    // A reconciliation that changes the run's reasoning revision closes the Thought line only.
    await setState(
      page,
      `const key = "agent:otto:disk-space";
       const t = state.transcripts[key];
       const runs = t.runs.map((run) => ({ ...run, reasoningRevision: run.reasoningRevision + 1 }));
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, runs } } };`,
    );
    await expect(thought).not.toHaveAttribute("open", "");
    await expect(fold).toHaveAttribute("open", "");
    await expect(row).toHaveAttribute("open", "");
  });

  test("F-293: while one card is open, other cards keep updating and new ones keep arriving; it stays open and nothing above it moves", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "actions-becoming-fold");
    // An earlier card, opened: the read of AGENTS.md.
    const opened = cards(page).filter({
      has: page.locator(':scope > summary[aria-label^="Read AGENTS.md"]'),
    });
    await line(opened).click();
    await expect(opened).toHaveAttribute("open", "");
    const top = (await line(opened).boundingBox())!.y;
    // A card below updates: the run's read becomes a fold of two as the second read arrives.
    const fold = page.locator(".transcript details.card.action[data-fold]");
    await expect(fold).toHaveCount(1, { timeout: 5000 });
    await expect(line(fold)).toHaveAccessibleName(/^Read 2 files/);
    // A new card arrives below it: the command the run starts next, as the gateway's events say.
    await setState(
      page,
      `const key = "agent:otto:disk-space"; const t = state.transcripts[key];
       const runs = t.runs.map((r) => {
         if (r.id !== "run-live") return r;
         const seed = r.steps.find((s) => s.kind === "tool");
         const step = { ...seed, id: "tool:call_new", toolCallId: "call_new", toolName: "exec", title: "exec",
           status: "running", startedAt: Date.now() - 1000, endedAt: null, commandBearing: true,
           args: { command: "df -h /srv" }, argsText: null, result: null, details: null, raw: null, rawSize: null,
           output: { text: "Filesystem  Size  Used", totalChars: 22 } };
         return { ...r, steps: [...r.steps, step] };
       });
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, runs } } };`,
    );
    const arrived = page.locator('.transcript details.card.action[data-call="call_new"]');
    await expect(line(arrived)).toHaveAccessibleName(/^Running df, df -h \/srv, running$/);
    await expect(arrived).toBeVisible();
    // That card then updates in view: its command finishes.
    await setState(
      page,
      `const key = "agent:otto:disk-space"; const t = state.transcripts[key];
       const runs = t.runs.map((r) => ({ ...r, steps: r.steps.map((s) => s.toolCallId === "call_new"
         ? { ...s, status: "done", endedAt: Date.now(), output: null,
             result: { text: "Filesystem  Size  Used\\n/dev/sda1  1T  61%", totalChars: 40 },
             details: { status: "completed", exitCode: 0 } } : s) }));
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, runs } } };`,
    );
    await expect(line(arrived)).toHaveAccessibleName(/^Ran df, df -h \/srv, /);
    await expect(arrived.locator(".action-verb")).toHaveText("Ran");
    await settle(page);
    // The opened card stays open, on Readable, and has not moved.
    await expect(opened).toHaveAttribute("open", "");
    await expect(opened.getByRole("tab", { name: "Readable" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect((await line(opened).boundingBox())!.y).toBe(top);
    // Only the card that was opened is open.
    await expect(page.locator(".transcript details.card.action[open]")).toHaveCount(1);
  });

  test("an open card becomes a fold with its first row open in its view; focus stays on the same control; nothing above moves", async ({
    page,
  }) => {
    await open(page, "actions-becoming-fold");
    const first = cards(page).last();
    await expect(line(first)).toHaveAccessibleName(/^Read backup-2026-11-15\.log/);
    await line(first).click();
    await first.getByRole("tab", { name: "Raw" }).click();
    await expect(first.getByRole("tab", { name: "Raw" })).toBeFocused();
    // Opening Raw reflows the card. Measure its position before the second read arrives.
    await settle(page);
    await expect(line(first)).toHaveAccessibleName(/^Read backup-2026-11-15\.log/);
    const top = (await line(first).boundingBox())!.y;
    // The second read arrives: one fold, open, its first row open on Raw, focus on that Raw tab.
    const fold = page.locator(".transcript details.card.action[data-fold]");
    await expect(fold).toHaveCount(1, { timeout: 5000 });
    await expect(line(fold)).toHaveAccessibleName(/^Read 2 files/);
    await expect(fold).toHaveAttribute("open", "");
    const row = fold.locator(".fold-rows .step").first();
    await expect(row).toHaveAttribute("open", "");
    await expect(row.getByRole("tab", { name: "Raw" })).toHaveAttribute("aria-selected", "true");
    await expect(row.getByRole("tab", { name: "Raw" })).toBeFocused();
    expect((await line(fold).boundingBox())!.y).toBe(top);
  });

  test("the reading line holds while a fold above it splits on a reconciliation, and the parts keep their open state", async ({
    page,
  }) => {
    // Short enough that the reading line can sit mid-transcript, with the reader not at the end.
    await page.setViewportSize({ width: 1440, height: 520 });
    await open(page, "actions-long");
    const reads = cards(page).filter({
      has: page.locator(':scope > summary[aria-label^="Read 3 files"]'),
    });
    await line(reads).click();
    await reads.locator(".fold-rows .step").nth(3).locator(":scope > summary").click();
    // Read further down: the next bubble at the reading line, the fold above it.
    const marker = page.getByText("The house loses most heat through the loft.");
    await marker.evaluate((element) => {
      const scroller = element.closest<HTMLElement>('[data-testid="transcript"]')!;
      const band = Number.parseFloat(getComputedStyle(scroller.firstElementChild!).paddingTop) || 0;
      scroller.scrollTop +=
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - band;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await settle(page);
    const before = (await marker.boundingBox())!.y;
    // History now shows a bubble between the second and third read: the fold splits in two.
    await setState(
      page,
      `const key = "agent:otto:disk-space";
       const t = state.transcripts[key];
       const items = t.items.map((item) => {
         const at = item.blocks.findIndex((b) => b.kind === "tool-call" && b.name === "read" && b.argumentsText.includes("energy-bills"));
         if (at === -1) return item;
         const blocks = [...item.blocks];
         blocks.splice(at + 1, 0, { kind: "text", text: "The bills are in. Two more files to read." });
         return { ...item, blocks };
       });
       return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, items } } };`,
    );
    await expect(page.getByText("The bills are in.")).toBeVisible();
    await settle(page);
    expect(Math.abs((await marker.boundingBox())!.y - before)).toBeLessThanOrEqual(1);
    // The first part keeps the fold's key and its open state; the part after it opens too.
    // The second part holds the failed read, which its plural does not count.
    const parts = cards(page).filter({
      has: page.locator(
        ':scope > summary:is([aria-label^="Read 2 files"], [aria-label^="Read 1 file,"])',
      ),
    });
    await expect(parts).toHaveCount(2);
    await expect(parts.nth(0)).toHaveAttribute("open", "");
    await expect(parts.nth(1).locator(".fold-rows .step").nth(1)).toHaveAttribute("open", "");
  });

  test("F-430: at phone width the sentence wraps to at most two lines, the detail is below it, and the state word is whole", async ({
    browser,
  }) => {
    const context = await browser.newContext(
      contextFor(
        SIZES.find((s) => s.phone)!,
        "light",
      ),
    );
    const page = await context.newPage();
    await open(page, "actions-failed");
    for (const each of await cards(page).all()) {
      const sentence = each.locator(".action-sentence");
      const height = await sentence.evaluate((element) => element.getBoundingClientRect().height);
      const lineHeight = await sentence.evaluate(
        (element) => Number.parseFloat(getComputedStyle(element).lineHeight) || 20,
      );
      expect(height).toBeLessThanOrEqual(lineHeight * 2 + 1);
      const state = each.locator(".action-state");
      expect(
        await state.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      const detail = each.locator(".action-detail");
      if ((await detail.textContent())?.trim()) {
        expect((await detail.boundingBox())!.y).toBeGreaterThan((await sentence.boundingBox())!.y);
      }
      expect((await each.boundingBox())!.width).toBeLessThanOrEqual(390);
    }
    // The long X search keeps its query on screen.
    await expect(cards(page).nth(2).locator(".action-object")).toBeVisible();
    await context.close();
  });

  test("F-291: a card or fold row that arrives live rises in over 200 ms in ordinary motion; cards drawn with the page and reduced motion do not move", async ({
    page,
  }) => {
    for (const reduce of [false, true]) {
      await page.emulateMedia({ reducedMotion: reduce ? "reduce" : "no-preference" });
      await open(page, "actions-becoming-fold");
      // Drawn with the page: no arrival.
      await expect(cards(page).last()).not.toHaveAttribute("data-fresh", "true");
      // The second read arrives: the card becomes a fold, and its new row arrives.
      const fold = page.locator(".transcript details.card.action[data-fold]").last();
      await expect(fold).toBeAttached();
      const row = fold.locator(".fold-rows > li").last();
      await expect(row).toHaveAttribute("data-fresh", "true");
      const motion = await row.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.animationName, style.animationDuration];
      });
      expect(motion).toEqual(reduce ? ["none", "0s"] : ["rise", "0.2s"]);
    }
  });

  test("with reduced motion, cards, rows and Thought lines appear and open without animation, and the working mark is still", async ({
    page,
  }) => {
    for (const how of ["system", "app"] as const) {
      if (how === "system") await page.emulateMedia({ reducedMotion: "reduce" });
      else await page.emulateMedia({ reducedMotion: "no-preference" });
      await open(page, "actions-running", "light", how === "app" ? "&motion=reduce" : "");
      if (how === "app")
        await page.evaluate(() => (document.documentElement.dataset.motion = "reduce"));
      const running = cards(page).last();
      await line(running).click();
      const animations = await page.evaluate(() =>
        [
          ...document.querySelectorAll(".action-body, .step-body, .action .glyph, .thought-body"),
        ].map((element) => {
          const style = getComputedStyle(element);
          const before = getComputedStyle(element, "::before");
          return [style.animationName, before.animationName];
        }),
      );
      for (const [own, before] of animations) {
        expect(own).toBe("none");
        expect(before === "none" || before === "").toBe(true);
      }
    }
  });
});
