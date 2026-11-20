// The T3 Code thread card (conversation.md section 11), from the fixture's
// engine-built scenes (apps/desktop/src/fixture/cards.ts): every state at four
// widths in both themes, and how it behaves: opening, each joined call's Raw,
// the change in place in both directions with its open state, Raw and focus,
// the reading line through it, joining, and the status line's way to a card.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { contextFor, openFixture, paintedFinal, settle, SIZES, THEMES } from "./fixture.ts";

const CARD_TASK = "agent:otto:transcode-cache";
const T3 = "F-132 F-133 F-134 F-313";

type Shot = {
  name: string;
  scene: string;
  rows: string;
  prepare?: (page: Page) => Promise<Locator>;
};

const thread = (page: Page) => page.getByTestId("t3-card").first();
const openCard = async (page: Page) => {
  const card = thread(page);
  await card.locator(":scope > summary").click();
  await expect(card).toHaveAttribute("open", "");
  return card;
};
/** The column of the scene's run: its cards and lines together. */
const column = (page: Page) => page.locator(".turn, [data-testid='transcript']").last();

/** The launch's own card, opened. */
const openOwn = async (page: Page) => {
  const own = page.locator('.card.action[data-call="call_t3"]');
  await own.locator(":scope > summary").click();
  await expect(own).toHaveAttribute("open", "");
  return own;
};

const SHOTS: Shot[] = [
  { name: "closed", scene: "t3-thread", rows: T3, prepare: async (page) => thread(page) },
  { name: "open", scene: "t3-thread", rows: `${T3} F-135`, prepare: openCard },
  {
    name: "joined-raw",
    scene: "t3-thread",
    rows: "F-313",
    prepare: async (page) => {
      const card = await openCard(page);
      const item = card.locator('[data-item-call="call_t3w"]');
      await item.getByRole("button", { name: "Raw for this call" }).click();
      await expect(item.getByRole("region", { name: "What the gateway sent" })).toBeVisible();
      return item;
    },
  },
  {
    name: "read-cut",
    scene: "t3-read-cut",
    rows: "F-133",
    prepare: async (page) => {
      const card = await openCard(page);
      return card;
    },
  },
  {
    name: "own-line",
    scene: "t3-thread",
    rows: "F-313",
    prepare: async (page) => {
      const line = page.locator('.card.action[data-call="call_t3s"]');
      await line.locator(":scope > summary").click();
      await expect(line.getByRole("button", { name: "Show this thread's card" })).toBeVisible();
      return line;
    },
  },
  { name: "started", scene: "t3-started", rows: "F-134", prepare: async (page) => thread(page) },
  { name: "approval", scene: "t3-approval", rows: "F-134", prepare: async (page) => thread(page) },
  { name: "checking", scene: "t3-checking", rows: "F-134", prepare: async (page) => column(page) },
  { name: "refused", scene: "t3-refused", rows: "F-314", prepare: openCard },
  // A launch that ended without naming a thread is a card of its own, opened.
  { name: "failed", scene: "t3-failed", rows: "F-314", prepare: openOwn },
  { name: "not-sent", scene: "t3-not-sent", rows: "F-470", prepare: openOwn },
  { name: "delivery-unknown", scene: "t3-delivery-unknown", rows: "F-470", prepare: openOwn },
  { name: "work-may-continue", scene: "t3-work-may-continue", rows: "F-137", prepare: openCard },
  {
    name: "two-threads",
    scene: "t3-two-threads",
    rows: "F-441",
    prepare: async (page) => column(page),
  },
  { name: "before-record", scene: "t3-before-record", rows: "F-313", prepare: openCard },
  { name: "listings", scene: "t3-listings", rows: "F-313", prepare: async (page) => column(page) },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`T3 Code thread ${size.name} ${theme}`, () => {
      test.use({ ...contextFor(size, theme), viewport: { width: size.width, height: 2000 } });
      for (const shot of SHOTS) {
        test(`${shot.rows}: t3-${shot.name} matches its baseline`, async ({ page }) => {
          await openFixture(page, `scene=${shot.scene}`, theme);
          await expect(page.locator(".card.action, [data-testid='t3-card']").first()).toBeVisible();
          const target = await (shot.prepare ?? (async (p: Page) => thread(p)))(page);
          await page.mouse.move(0, 0);
          // A shot that opened something holds it in view: the transcript stays where it is.
          await paintedFinal(page, { atEnd: shot.prepare === undefined });
          await expect(target).toHaveScreenshot(`t3-${shot.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}

// Behaviour ----------------------------------------------------------------------------

type FixtureState = {
  transcripts: Record<
    string,
    { runs: Array<{ steps: Array<Record<string, unknown>> }>; mcpTools: object }
  >;
};

/** The gateway's result for one call of the scene, as the engine keeps it, named for `tool`. */
async function resultFor(
  page: Page,
  callId: string,
  tool: string,
  facts: Record<string, unknown> | null,
  /** A line the reader clicks in the same task, just before the result: its toggle is reported after. */
  clickFirst: string | null = null,
): Promise<void> {
  await page.evaluate(
    ({ key, callId, tool, facts, clickFirst }) => {
      if (clickFirst) document.querySelector<HTMLElement>(clickFirst)!.click();
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState(change: (s: FixtureState) => unknown): void };
        }
      ).clawtrateFixture;
      fixture.setState((s) => {
        const t = s.transcripts[key]!;
        return {
          ...s,
          transcripts: {
            ...s.transcripts,
            [key]: {
              ...t,
              runs: t.runs.map((run) => ({
                ...run,
                steps: run.steps.map((x) =>
                  x.toolCallId !== callId
                    ? x
                    : {
                        ...x,
                        status: "done",
                        endedAt: Date.now(),
                        result: { text: "structuredContent:\n{}", totalChars: 21 },
                        details: { mcpServer: "t3code", mcpTool: tool },
                        t3: facts ? { ...(x.t3 as object), ...facts } : x.t3,
                      },
                ),
              })),
            },
          },
        };
      });
    },
    { key: CARD_TASK, callId, tool, facts, clickFirst },
  );
}

/** The gateway's map, removed: nothing names the scene's calls before their results. */
async function withoutMap(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState(change: (s: FixtureState) => unknown): void };
      }
    ).clawtrateFixture;
    fixture.setState((s) => ({
      ...s,
      transcripts: { ...s.transcripts, [key]: { ...s.transcripts[key]!, mcpTools: {} } },
    }));
  }, CARD_TASK);
}

const THREAD = "mcp:3f9c2a1e-7b4d-4c8a-9e2f-6a1b5c3d8e70";
const LAUNCHED = {
  read: true,
  threadId: THREAD,
  status: "running",
  link: "https://t3-code.example/threads/local/x",
};

async function topOf(locator: Locator): Promise<number> {
  return (await locator.boundingBox())!.y;
}

test.describe("T3 Code thread cards", () => {
  test.use(contextFor(SIZES[0]!, "light"));

  test("F-132 F-134: a general card open on Raw, with focus on Copy arguments, becomes the thread's card in place: its item's Raw open, focus on the same control", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-general", "light");
    const general = page.locator('.card.action[data-call="call_t3"]');
    await expect(general).toHaveAttribute("data-kind", "tool");
    await expect(general.locator(":scope > summary .action-state")).toHaveText("Call started");
    await general.locator(":scope > summary").click();
    await general.getByRole("tab", { name: "Raw" }).click();
    const copy = general.getByRole("button", { name: "Copy arguments" });
    await copy.focus();
    await resultFor(page, "call_t3", "t3_thread_launch", LAUNCHED);
    const card = page.getByTestId("t3-card");
    await expect(card).toHaveCount(1);
    await expect(general).toHaveCount(0);
    await settle(page);
    await expect(card).toHaveAttribute("open", "");
    const item = card.locator('[data-item-call="call_t3"]');
    await expect(item.getByRole("region", { name: "What the gateway sent" })).toBeVisible();
    await expect(item.getByRole("button", { name: "Copy arguments" })).toBeFocused();
  });

  test("F-132 F-134: on its Readable tab with focus on the line, the change keeps the card open on this call's item and focus on its line", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-general", "light");
    const general = page.locator('.card.action[data-call="call_t3"]');
    await general.locator(":scope > summary").click();
    await general.locator(":scope > summary").focus();
    await resultFor(page, "call_t3", "t3_thread_launch", LAUNCHED);
    const card = page.getByTestId("t3-card");
    await expect(card).toHaveAttribute("open", "");
    await expect(card.locator('[data-item-call="call_t3"]')).toHaveAttribute("open", "");
    await expect(card.locator('[data-item-call="call_t3"] [role=region]')).toHaveCount(0);
    await expect(card.locator(":scope > summary")).toBeFocused();
  });

  test("F-132 F-134: a card opened just before its result arrives, the result drawn before the opening is reported, is the thread's card open", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-general", "light");
    const general = page.locator('.card.action[data-call="call_t3"]');
    await expect(general).not.toHaveAttribute("open", "");
    await resultFor(
      page,
      "call_t3",
      "t3_thread_launch",
      LAUNCHED,
      '.card.action[data-call="call_t3"] > summary',
    );
    const card = page.getByTestId("t3-card");
    await expect(card).toHaveCount(1);
    await settle(page);
    await expect(card).toHaveAttribute("open", "");
  });

  test("F-132 F-134: a card the map made, its item's Raw open with focus on Copy arguments, whose result names another tool becomes that tool's card on its Raw tab, focus on the same control", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-started", "light");
    const card = await openCard(page);
    const item = card.locator('[data-item-call="call_t3"]');
    await item.getByRole("button", { name: "Raw for this call" }).click();
    const copy = item.getByRole("button", { name: "Copy arguments" });
    await copy.focus();
    await expect(copy).toBeFocused();
    await resultFor(page, "call_t3", "t3_project_list_v2", null);
    await expect(page.getByTestId("t3-card")).toHaveCount(0);
    const other = page.locator('.card.action[data-call="call_t3"]');
    await expect(other).toHaveAttribute("data-kind", "server");
    await expect(other).toHaveAttribute("open", "");
    await expect(other.getByRole("tab", { name: "Raw" })).toHaveAttribute("aria-selected", "true");
    await expect(other.getByRole("button", { name: "Copy arguments" })).toBeFocused();
  });

  test("F-132 F-134: closed with focus on its line, the change either way keeps it closed and the focus on its line", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-general", "light");
    const general = page.locator('.card.action[data-call="call_t3"]');
    await general.locator(":scope > summary").focus();
    await resultFor(page, "call_t3", "t3_thread_launch", LAUNCHED);
    const card = page.getByTestId("t3-card");
    await expect(card).not.toHaveAttribute("open", "");
    await expect(card.locator(":scope > summary")).toBeFocused();
    await openFixture(page, "scene=t3-started", "light");
    await thread(page).locator(":scope > summary").focus();
    await resultFor(page, "call_t3", "t3_project_list_v2", null);
    const other = page.locator('.card.action[data-call="call_t3"]');
    await expect(other).not.toHaveAttribute("open", "");
    await expect(other.locator(":scope > summary")).toBeFocused();
  });

  test("F-134: the reading line holds through the change in place, with the reader away from the end", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 420 });
    await openFixture(page, "scene=t3-general", "light");
    await withoutMap(page);
    const general = page.locator('.card.action[data-call="call_t3"]');
    await general.locator(":scope > summary").click();
    // The reader at the first bubble, the call's card below the reading line.
    const marked = page.getByTestId("transcript").locator(".msg").first();
    await marked.evaluate((element) => {
      const scroller = element.closest<HTMLElement>('[data-testid="transcript"]')!;
      const band = Number.parseFloat(getComputedStyle(scroller.firstElementChild!).paddingTop) || 0;
      scroller.scrollTop +=
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - band;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await settle(page);
    const before = await topOf(marked);
    await resultFor(page, "call_t3", "t3_thread_launch", LAUNCHED);
    await expect(page.getByTestId("t3-card")).toHaveCount(1);
    await settle(page);
    expect(Math.abs((await topOf(marked)) - before)).toBeLessThanOrEqual(1);
  });

  test("F-313: a call under its thread's card, closed and unfocused, with the reader at the end, closes up into the card when its result names the thread", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-joining", "light");
    const line = page.locator('.card.action[data-call="call_t3w"]');
    await expect(line).toHaveCount(1);
    await expect(line.locator(":scope > summary")).toContainText("Waiting for");
    await expect(thread(page).locator(":scope > summary .state")).toHaveText("Checking");
    await resultFor(page, "call_t3w", "t3_thread_wait", {
      read: true,
      threadId: THREAD,
      status: "completed",
      timedOut: false,
    });
    await expect(line).toHaveCount(0);
    // Two calls reported a status: Call made, each status on its own item.
    await expect(thread(page).locator(":scope > summary .state")).toHaveText("Call made");
    await expect(thread(page).locator(":scope > summary")).toContainText("· 2 calls");
    const card = await openCard(page);
    await expect(card.locator('[data-item-call="call_t3w"]')).toHaveCount(1);
  });

  test("F-313: the same call keeps its line when the reader had it open, and is an item of the card too, with Show the thread and back", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-joining", "light");
    const line = page.locator('.card.action[data-call="call_t3w"]');
    await line.locator(":scope > summary").click();
    await expect(line).toHaveAttribute("open", "");
    await resultFor(page, "call_t3w", "t3_thread_wait", {
      read: true,
      threadId: THREAD,
      status: "completed",
      timedOut: false,
    });
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute("open", "");
    await expect(line.locator(":scope > summary")).toContainText("Waited for");
    await line.getByRole("button", { name: "Show this thread's card" }).click();
    const card = thread(page);
    await expect(card).toHaveAttribute("open", "");
    const item = card.locator('[data-item-call="call_t3w"]');
    await expect(item).toHaveAttribute("open", "");
    await expect(item.locator(":scope > summary")).toBeFocused();
    await item.getByRole("button", { name: "Show this call where it happened" }).click();
    await expect(line.locator(":scope > summary")).toBeFocused();
  });

  test("F-313: every joined call's Raw opens on the thread's card, each its own call's", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-thread", "light");
    const card = await openCard(page);
    for (const id of ["call_t3", "call_t3w", "call_t3s", "call_t3r"]) {
      const item = card.locator(`[data-item-call="${id}"]`);
      await item.getByRole("button", { name: "Raw for this call" }).click();
      const raw = item.getByRole("region", { name: "What the gateway sent" });
      await expect(raw, id).toBeVisible();
      await expect(raw, id).toContainText(id);
    }
  });

  test("F-082 F-134: the status line brings a running thread's card into view and focuses its line, without opening it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 420 });
    await openFixture(page, "scene=t3-started", "light");
    const card = thread(page);
    await card.evaluate((element) => {
      const scroller = element.closest<HTMLElement>('[data-testid="transcript"]')!;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await page.getByTestId("status-line").click();
    await expect(card.locator(":scope > summary")).toBeFocused();
    await expect(card).toBeInViewport();
    await expect(card).not.toHaveAttribute("open", "");
  });

  test("F-132: the folded card shows Clawtrate's own mark, the label T3 Code, what the thread is for, its calls and the thread's state", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-thread", "light");
    const line = thread(page).locator(":scope > summary");
    await expect(line.locator(".messaged-verb")).toHaveText("Messaged");
    await expect(line.locator(".messaged-who")).toHaveText("T3 Code");
    await expect(line.locator(".agent-mark svg")).toBeVisible();
    await expect(line.locator("img")).toHaveCount(0);
    // What the thread is for: the launch's title; the count stands apart and is never cut.
    await expect(line.locator(".t3-title")).toHaveText("Skip machines that are asleep");
    await expect(line.locator(".t3-count")).toHaveText("· 4 calls");
    await expect(line.locator(".state")).toHaveText("Call made");
  });

  test("F-133 F-135: open, it shows each call's sent text, a launch's target fields, what came back with its time, and Open thread as a link", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-thread", "light");
    const card = await openCard(page);
    const launch = card.locator('[data-item-call="call_t3"]');
    await expect(launch.locator(".exchange-text").first()).toHaveText(/^In backup-scripts/);
    await expect(launch.locator(".chip")).toHaveText([
      "Project backup-scripts",
      "Title Skip machines that are asleep",
      "Branch main",
    ]);
    await expect(launch).toContainText(
      "This shows the call was made. It does not show that the work is finished.",
    );
    await expect(card.locator('[data-item-call="call_t3s"]')).toContainText("Started a new run");
    await expect(card.locator('[data-item-call="call_t3r"]')).toContainText("Read to the end");
    // Several calls reported a status: no thread-wide report; each status is on its own item.
    await expect(card.locator(".t3-reported")).toHaveCount(0);
    const link = card.getByRole("link", { name: "Open the T3 Code thread in your browser" });
    await expect(link).toHaveAttribute("href", /^https:\/\/t3-code\.example\/threads\/local\//);
    await expect(card.locator(".chips[aria-label=Files]")).toHaveCount(0);
  });

  test("F-133: a read with a cut item never says it read to the end", async ({ page }) => {
    await openFixture(page, "scene=t3-read-cut", "light");
    const card = await openCard(page);
    const cut = card.locator('[data-item-call="call_t3r"]');
    await expect(cut).toContainText(
      "Part of the reply only: its text was cut, and the rest was not read",
    );
    const page2 = card.locator('[data-item-call="call_t3p"]');
    await expect(page2).toContainText("First page only: the reply may continue");
    await expect(page2).toContainText(
      "Part of the run only: an item's text was cut, and the rest was not read",
    );
    await expect(card).not.toContainText("Read to the end");
  });

  test("F-134 F-314 F-470 F-137: each thread's state is what its calls establish", async ({
    page,
  }) => {
    const states: Record<string, string> = {
      "t3-started": "Call started",
      "t3-approval": "Waiting for approval",
      "t3-checking": "Checking",
      // Several calls reported a status: Call made; one did: its status.
      "t3-thread": "Call made",
      "t3-refused": "Running",
      "t3-work-may-continue": "Running",
      "t3-before-record": "Call made",
    };
    for (const [scene, state] of Object.entries(states)) {
      await openFixture(page, `scene=${scene}`, "light");
      await expect(thread(page).locator(":scope > summary .state"), scene).toHaveText(state);
    }
    // A launch T3 Code refused names no thread: a card of its own, saying what was asked and why not.
    await openFixture(page, "scene=t3-failed", "light");
    const failed = page.locator('.card.action[data-call="call_t3"]');
    await expect(failed).toHaveAttribute("data-kind", "t3");
    await expect(failed.locator(":scope > summary .action-state")).toHaveText("Failed");
    await expect(failed.locator(":scope > summary")).toContainText("Couldn't message");
    await expect(failed.locator(":scope > summary .action-detail")).toContainText(
      "target_required",
    );
    await expect(page.getByTestId("t3-card")).toHaveCount(0);
    // A launch denied, or cut short by a stop before it returned: what was asked, and its state.
    for (const [scene, state] of [
      ["t3-not-sent", "Not sent"],
      ["t3-delivery-unknown", "Delivery unknown"],
    ] as const) {
      await openFixture(page, `scene=${scene}`, "light");
      const own = page.locator('.card.action[data-call="call_t3"]');
      await expect(own.locator(":scope > summary .action-state"), scene).toHaveText(state);
      await expect(own.locator(":scope > summary"), scene).toContainText("Asked");
      await expect(page.getByTestId("t3-card"), scene).toHaveCount(0);
    }
    await openFixture(page, "scene=t3-refused", "light");
    // A refused follow-up is no item of the thread: a card of its own, the thread's word unchanged.
    const refused = page.locator('.card.action[data-call="call_t3s"]');
    await expect(refused.locator(":scope > summary .action-state")).toHaveText("Failed");
    await expect(refused.locator(":scope > summary")).toContainText("Couldn't follow up with");
    await expect(thread(page).locator('[data-item-call="call_t3s"]')).toHaveCount(0);
    await refused.locator(":scope > summary").click();
    await expect(refused.locator("pre[data-tone=danger]")).toContainText("thread_not_sendable");
    await refused.getByRole("button", { name: "Show this thread's card" }).click();
    await expect(thread(page).locator(":scope > summary")).toBeFocused();
    await openFixture(page, "scene=t3-work-may-continue", "light");
    await expect(
      (await openCard(page)).getByText(
        "The call was made. Work handed to T3 Code may continue there.",
      ),
    ).toHaveCSS("font-weight", "500");
  });

  test("F-441 F-313: two threads are two cards, and the same thread on another server a third; listings are lines that fold", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-two-threads", "light");
    await expect(page.getByTestId("t3-card")).toHaveCount(3);
    await openFixture(page, "scene=t3-listings", "light");
    await expect(page.getByTestId("t3-card")).toHaveCount(0);
    const fold = page.locator(".card.action[data-fold]");
    await expect(fold).toHaveAttribute("data-fold", "2");
    await expect(fold.locator(":scope > summary")).toContainText(
      "Looked through T3 Code · 2 times",
    );
  });

  test("F-313: a listing's Readable shows what it listed, and claims nothing of unfinished work", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-listings", "light");
    await page.locator(".card.action[data-fold] > summary").click();
    for (const [id, listed] of [
      ["call_t3pl", "trail-guide"],
      ["call_t3tl", "mcp:3f9c2a1e-7b4d-4c8a-9e2f-6a1b5c3d8e70"],
    ] as const) {
      const row = page.locator(`#action-${id}`);
      await row.locator(":scope > summary").click();
      const readable = row.locator('[data-view="readable"]');
      await expect(readable, id).toContainText(listed);
      await expect(readable, id).not.toContainText("does not show that the work is finished");
    }
  });

  test("F-313: a thread whose launch is not in the record says so on its card", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-before-record", "light");
    const card = await openCard(page);
    await expect(card).toContainText(
      "The thread's launch is absent from this conversation's record.",
    );
  });
});

test.describe("the thread's link", () => {
  test.use(contextFor(SIZES[0]!, "light"));

  test("F-135: Open thread is offered only for an http or https address, with its host beside it; any other scheme gives no link", async ({
    page,
  }) => {
    for (const [link, host] of [
      ["http://127.0.0.1:43123/threads/one", "127.0.0.1:43123"],
      ["https://t3-code.example/threads/local/x", "t3-code.example"],
      ["javascript:alert(1)", null],
      ["file:///etc/hosts", null],
      ["t3code://thread/1", null],
      ["not an address", null],
    ] as const) {
      await openFixture(page, "scene=t3-general", "light");
      await resultFor(page, "call_t3", "t3_thread_launch", { ...LAUNCHED, link });
      const card = await openCard(page);
      const open = card.getByRole("link", { name: /^Open the T3 Code thread in your browser/ });
      if (host === null) {
        await expect(open, link).toHaveCount(0);
        await expect(card.locator("a"), link).toHaveCount(0);
      } else {
        await expect(open, link).toHaveAttribute("href", link);
        await expect(open, link).toHaveAccessibleName(
          `Open the T3 Code thread in your browser, at ${host}`,
        );
        await expect(card.locator(".t3-link-host"), link).toHaveText(host);
      }
    }
  });
});

test.describe("T3 Code words follow the record", () => {
  test.use(contextFor(SIZES[0]!, "light"));

  test("F-470: a wait whose delivery is unknown, in a run no one was seen to stop, says no result establishes delivery", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-wait-unknown", "light");
    const own = page.locator('.card.action[data-call="call_t3w"]');
    await expect(own.locator(":scope > summary .action-state")).toHaveText("Delivery unknown");
    await own.locator(":scope > summary").click();
    await expect(own).toContainText("No result establishes whether T3 Code received this call.");
    await expect(own).not.toContainText("The bot was stopped");
  });
});

test.describe("T3 Code at 390 px", () => {
  test.use(contextFor(SIZES[3]!, "light"));

  test("F-313: a line's verb, the mark and the name stay on one line, the name giving way first, and the thread's count is never clipped", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-thread", "light");
    const lines = page.locator('.card.action[data-kind="t3"]');
    await expect(lines).toHaveCount(2);
    for (const each of await lines.all()) {
      const parts = each.locator(":scope > summary .action-sentence");
      const verb = (await parts.locator(".action-verb").boundingBox())!;
      const mark = (await parts.locator(".agent-mark").boundingBox())!;
      const name = (await parts.locator(".action-object").boundingBox())!;
      const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
      expect(Math.abs(middle(verb) - middle(mark))).toBeLessThanOrEqual(3);
      expect(Math.abs(middle(verb) - middle(name))).toBeLessThanOrEqual(3);
    }
    const count = thread(page).locator(":scope > summary .t3-count");
    await expect(count).toHaveText("· 4 calls");
    expect(await count.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const summary = (await thread(page).locator(":scope > summary").boundingBox())!;
    const box = (await count.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(summary.x + summary.width);
    // The title is what gives way.
    const title = thread(page).locator(":scope > summary .t3-title");
    expect(await title.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
  });
});
