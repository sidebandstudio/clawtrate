// Each task a bot starts, as a card where it was asked (docs/parity.md F-587). Otto's open task
// becomes the conversation where Otto started four tasks with the gateway's sessions_spawn: one
// working, one waiting for the person, one done that Otto reported back on, and one the gateway
// refused because its label was in use; and, on its own, one start refused for its model (#799).
// The rows are the shapes OpenClaw 2026.10.6 stores; the tasks are listed under Otto as started
// from here, as the host's next snapshot would bring them.
// Every name and text is invented.
import { test, type Page } from "@playwright/test";
import {
  mapHistory,
  mapSessionRow,
  RawTable,
  runsFromHistory,
  type ClawtrateState,
  type Task,
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

const HERE = "agent:otto:disk-space";
const RUN = "run-split";
const T = NOW.getTime() - 600_000;

const STARTS = [
  {
    key: "agent:otto:dashboard:backup-drive",
    run: "child-backup",
    label: "Check the backup drive",
    task: "Check the backup drive's free space and last good copy.\nSay if anything looks off.",
    status: "running",
  },
  {
    key: "agent:otto:dashboard:media-logs",
    run: "child-logs",
    label: "Rotate the media logs",
    task: "Rotate the transcode logs and keep the last month. Ask before deleting anything older.",
    status: "running",
  },
  {
    key: "agent:otto:dashboard:old-downloads",
    run: "child-downloads",
    label: "Clear old downloads",
    task: "Clear downloads older than 90 days from the media box.",
    status: "done",
  },
] as const;

const row = (role: string, id: string, at: number, extra: Record<string, unknown>) => ({
  role,
  timestamp: T + at,
  ...extra,
  __openclaw: { id, ...((extra.__openclaw as object) ?? {}) },
});

function history() {
  const rows: unknown[] = [
    row("user", "ask", 0, {
      content: "Put each part of the clean-up in a task of its own.",
      __openclaw: { idempotencyKey: `${RUN}:user` },
    }),
  ];
  const start = (i: number, args: Record<string, unknown>, body: unknown, isError: boolean) => {
    const id = `call-${i}`;
    rows.push(
      row("assistant", `a-${i}`, 1_000 + i * 100, {
        content: [{ type: "toolCall", id, name: "sessions_spawn", arguments: args }],
        __openclaw: { runId: RUN },
      }),
      row("toolResult", `r-${i}`, 1_050 + i * 100, {
        toolCallId: id,
        toolName: "sessions_spawn",
        isError,
        content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
        __openclaw: { runId: RUN },
      }),
    );
  };
  STARTS.forEach((each, i) =>
    start(
      i,
      { task: each.task, label: each.label, visible: true },
      { status: "accepted", childSessionKey: each.key, runId: each.run, label: each.label },
      false,
    ),
  );
  start(
    3,
    { task: "Check the backup drive's SMART status.", label: STARTS[0].label, visible: true },
    { status: "error", tool: "sessions_spawn", error: `label already in use: ${STARTS[0].label}` },
    true,
  );
  rows.push(
    row("assistant", "said", 1_500, {
      content: [
        { type: "text", text: "I started three tasks. A fourth had a name already in use." },
      ],
      __openclaw: { runId: RUN },
    }),
    row("assistant", "report", 90_000, {
      content: [{ type: "text", text: "Clear old downloads finished: 18 GB freed." }],
      __openclaw: { runId: `announce:v1:${STARTS[2].key}:${STARTS[2].run}` },
    }),
  );
  return rows;
}

/** The started tasks as listed: by index, a row status, or "unlisted" for one the list doesn't hold. */
function startedTasks(statuses: string[]): Task[] {
  return STARTS.map((each, i) =>
    mapSessionRow({
      key: each.key,
      agentId: "otto",
      createdVia: "spawn",
      spawnedBy: HERE,
      label: each.label,
      status: statuses[i] ?? each.status,
      updatedAt: T + 2_000 + i,
    })!,
  )
    .map((task, i) =>
      i === 1 ? { ...task, status: "waiting" as const, waitingFor: "approval" as const } : task,
    )
    .filter((_, i) => statuses[i] !== "unlisted");
}

type Fixture = { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };

/**
 * One start the gateway refused because its model list doesn't allow the model the task would run
 * on (#799), as both OpenClaw versions word it when the call names no model.
 */
function refusedForModel() {
  return [
    row("user", "ask", 0, {
      content: "Put the log rotation in a task of its own.",
      __openclaw: { idempotencyKey: `${RUN}:user` },
    }),
    row("assistant", "a-0", 1_000, {
      content: [
        {
          type: "toolCall",
          id: "call-0",
          name: "sessions_spawn",
          arguments: { task: STARTS[1].task, label: STARTS[1].label, visible: true },
        },
      ],
      __openclaw: { runId: RUN },
    }),
    row("toolResult", "r-0", 1_050, {
      toolCallId: "call-0",
      toolName: "sessions_spawn",
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { status: "error", tool: "sessions_spawn", error: "model not allowed: openai/gpt-5.5" },
            null,
            2,
          ),
        },
      ],
      __openclaw: { runId: RUN },
    }),
    row("assistant", "said", 1_500, {
      content: [{ type: "text", text: "The gateway wouldn't start that task." }],
      __openclaw: { runId: RUN },
    }),
  ];
}

/** Otto's open task as the conversation the four starts (or `only` those rows) were asked in. */
async function scene(page: Page, statuses: string[] = [], only?: unknown[]) {
  const rows = only ?? history();
  const items = mapHistory(rows);
  const runs = runsFromHistory(rows, null, {
    sessionKey: HERE,
    now: NOW.getTime(),
    raw: new RawTable(),
  });
  // The one refused start lists no task.
  const tasks = only ? [] : startedTasks(statuses);
  await page.evaluate(
    ({ items, runs, tasks, key }) => {
      const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        transcripts: {
          ...state.transcripts,
          [key]: { ...state.transcripts[key]!, items, live: null, runs, outbox: [] },
        },
        tasksByBot: {
          ...state.tasksByBot,
          otto: [
            ...state.tasksByBot.otto!.filter((t) => !tasks.some((s) => s.key === t.key)),
            ...tasks,
          ],
        },
      }));
    },
    { items, runs, tasks, key: HERE },
  );
  await settle(page);
}

const card = (page: Page, title: string) =>
  page
    .getByRole("group", { name: new RegExp(`^(Started|Couldn't start) a task: ${title}$`) })
    .first();
const open = (page: Page, theme: (typeof THEMES)[number] = "dark") =>
  openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, theme);

for (const size of [SIZES[0]!, SIZES.at(-1)!]) {
  for (const theme of THEMES) {
    test.describe(`started-task cards ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      test(`F-587: Working, Waiting for you, Done with its report and Couldn't start match their baseline, ${theme}, ${size.name}`, async ({
        page,
      }) => {
        await open(page, theme);
        await scene(page);
        const cards = page.getByTestId("started-task-card");
        await expect(cards).toHaveCount(4);
        await expect(cards.locator(".state")).toHaveText([
          "Working",
          "Waiting for you",
          "Done",
          "Couldn't start",
        ]);
        await cards.first().evaluate((element) => element.scrollIntoView({ block: "start" }));
        await page.getByTestId("transcript").evaluate((element) => {
          element.scrollTop = Math.max(0, element.scrollTop - 72);
        });
        await settle(page);
        await expect(page).toHaveScreenshot(`started-task-cards-${theme}-${size.name}.png`);
      });
    });
  }
}

for (const size of [SIZES[0]!, SIZES.at(-1)!]) {
  for (const theme of THEMES) {
    test.describe(`a start refused for its model ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      test(`#799: Couldn't start for its model matches its baseline, ${theme}, ${size.name}`, async ({
        page,
      }) => {
        await open(page, theme);
        await scene(page, [], refusedForModel());
        const cards = page.getByTestId("started-task-card");
        await expect(cards).toHaveCount(1);
        await expect(cards.locator(".state")).toHaveText(["Couldn't start"]);
        await settle(page);
        await expect(page).toHaveScreenshot(`started-task-model-refused-${theme}-${size.name}.png`);
      });
    });
  }
}

test.describe("a started task's card", () => {
  test.use(contextFor(SIZES[0]!));

  test("F-587: Open task goes to that task, by keyboard, and is named for it", async ({ page }) => {
    await open(page);
    await scene(page);
    const button = card(page, "Check the backup drive").getByRole("button", {
      name: "Open Check the backup drive",
    });
    await expect(button).toHaveText("Open task");
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".task-line")).toHaveText("Check the backup drive");
  });

  test("F-587: Couldn't start says the gateway's words and offers nothing to open", async ({
    page,
  }) => {
    await open(page);
    await scene(page);
    const refused = page.getByRole("group", {
      name: "Couldn't start a task: Check the backup drive",
    });
    await expect(refused.getByTestId("started-task-reason")).toHaveText(
      "label already in use: Check the backup drive",
    );
    await expect(refused.getByRole("button", { name: /^Open/ })).toHaveCount(0);
  });

  test("#799: a start refused for its model says which model in plain words, not the gateway's", async ({
    page,
  }) => {
    await open(page);
    await scene(page, [], refusedForModel());
    const refused = page.getByRole("group", {
      name: "Couldn't start a task: Rotate the media logs",
    });
    await expect(refused).toContainText("This gateway doesn't allow tasks on OpenAI's gpt-5.5.");
    await expect(refused).not.toContainText("model not allowed");
    await expect(refused.getByTestId("started-task-reason")).toHaveCount(0);
    await expect(refused.getByRole("button", { name: /^Open/ })).toHaveCount(0);
  });

  test("F-587: the report back is offered, and goes to Otto's reply", async ({ page }) => {
    await open(page);
    await scene(page);
    const done = card(page, "Clear old downloads");
    await expect(done.getByTestId("started-task-reported")).toHaveText("Otto reported back.");
    await done.getByRole("button", { name: "Show Otto's report on Clear old downloads" }).click();
    await expect(page.locator(":focus")).toContainText(
      "Clear old downloads finished: 18 GB freed.",
    );
  });

  test("F-587: a change of state is said once, politely", async ({ page }) => {
    await open(page);
    await scene(page);
    await expect(card(page, "Check the backup drive").locator(".state")).toHaveText("Working");
    await scene(page, ["done"]);
    await expect(card(page, "Check the backup drive").locator(".state")).toHaveText("Done");
    const announcer = page.getByTestId("card-announcer");
    await expect(announcer).toHaveAttribute("aria-live", "polite");
    await expect(announcer).toHaveText("Check the backup drive: Done");
  });

  test("F-587: a state that reads the same is not said again", async ({ page }) => {
    await open(page);
    // Not listed yet: "Started"; then listed with a row that says nothing of a run: "Started".
    await scene(page, ["unlisted"]);
    const backup = card(page, "Check the backup drive");
    await expect(backup.locator(".state")).toHaveText("Started");
    await expect(backup.getByRole("button", { name: /^Open/ })).toHaveCount(0);
    // Every announcement from here on, as the live region receives it.
    await page.getByTestId("card-announcer").evaluate((region) => {
      const said: string[] = [];
      (window as unknown as { said: string[] }).said = said;
      new MutationObserver(() => {
        if (region.textContent) said.push(region.textContent);
      }).observe(region, { childList: true, characterData: true, subtree: true });
    });
    await scene(page, [""]);
    await expect(backup.getByRole("button", { name: "Open Check the backup drive" })).toBeVisible();
    await expect(backup.locator(".state")).toHaveText("Started");
    await scene(page, ["done"]);
    await expect(backup.locator(".state")).toHaveText("Done");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { said: string[] }).said))
      .toEqual(["Check the backup drive: Done"]);
  });

  test("F-587: after a switch to another gateway, a card shows no task's state and opens nothing", async ({
    page,
  }) => {
    await open(page);
    await scene(page);
    await page.evaluate(() => {
      const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
      // The list in state was read on the gateway the host was pointed at before.
      fixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, target: state.connection.target + 1 },
      }));
    });
    await settle(page);
    const cards = page.getByTestId("started-task-card");
    await expect(cards.locator(".state")).toHaveText([
      "Started",
      "Started",
      "Started",
      "Couldn't start",
    ]);
    await expect(cards.getByRole("button", { name: /^Open/ })).toHaveCount(0);
  });
});
