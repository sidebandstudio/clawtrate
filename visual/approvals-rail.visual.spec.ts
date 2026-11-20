// The approval card's run-end closing and its "why the gateway asked" line,
// and the rail's task statuses for a finished run with failed actions and a
// blocked one, in the fixture mode at every size and in both themes
// (conversation.md sections 12 and 20; visual-language.md section 7).
import { expect, test, type Locator, type Page } from "@playwright/test";
import { contextFor, openFixture, settle, SIZES, THEMES } from "./fixture.ts";

const approvalCard = (page: Page) => page.getByTestId("approval-card");

const CARD_TASK = "agent:otto:transcode-cache";

type FixtureWindow = {
  clawtrateFixture: {
    getState(): { transcripts: Record<string, { approvals: Array<Record<string, unknown>> }> };
    setState(change: (state: Record<string, unknown>) => Record<string, unknown>): void;
    invoke(command: Record<string, unknown>): Promise<unknown>;
    send(command: Record<string, unknown>): Promise<unknown>;
  };
  sentCommands?: Array<Record<string, unknown>>;
};

/** Record every command the interface sends through the bridge. */
async function recordCommands(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    w.sentCommands = [];
    const fixture = w.clawtrateFixture;
    const invoke = fixture.invoke.bind(fixture);
    const send = fixture.send.bind(fixture);
    fixture.invoke = (command) => (w.sentCommands!.push(command), invoke(command));
    fixture.send = (command) => (w.sentCommands!.push(command), send(command));
  });
}

const commandsSent = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as FixtureWindow).sentCommands ?? []).filter((each) =>
      ["resolveApproval", "checkApproval"].includes(String(each.type)),
    ),
  );

/** Change the first approval of the card task as an event from the gateway would. */
async function changeApproval(page: Page, change: Record<string, unknown>, exec = false) {
  await page.evaluate(
    ({ key, change, exec }) => {
      const fixture = (window as unknown as FixtureWindow).clawtrateFixture;
      fixture.setState((state) => {
        const transcripts = state.transcripts as Record<string, Record<string, unknown>>;
        const t = transcripts[key]!;
        const approvals = (t.approvals as Array<Record<string, unknown>>).map((card, index) =>
          index !== 0
            ? card
            : exec
              ? { ...card, exec: { ...(card.exec as Record<string, unknown>), ...change } }
              : { ...card, ...change },
        );
        return { ...state, transcripts: { ...transcripts, [key]: { ...t, approvals } } };
      });
    },
    { key: CARD_TASK, change, exec },
  );
}

const settleFromGateway = (page: Page, outcome: Record<string, unknown>) =>
  changeApproval(page, { ...outcome, resolvedAt: Date.now(), runEnded: false, inferred: false });
const changeExec = (page: Page, change: Record<string, unknown>) =>
  changeApproval(page, change, true);
const execFields = (page: Page) =>
  page.evaluate(
    (key) =>
      (window as unknown as FixtureWindow).clawtrateFixture.getState().transcripts[key]!
        .approvals[0]!.exec as Record<string, unknown>,
    CARD_TASK,
  );

/** Replace the live fixture run's kept events, as the engine would hold them. */
async function setRunLifecycle(page: Page, lifecycle: unknown[] | null): Promise<void> {
  await page.evaluate(
    ({ lifecycle }) => {
      const fixture = (window as unknown as FixtureWindow).clawtrateFixture;
      fixture.setState((state) => {
        const transcripts = state.transcripts as Record<string, Record<string, unknown>>;
        const key = "agent:otto:disk-space";
        const t = transcripts[key]!;
        const runs = (t.runs as Array<Record<string, unknown>>).map((run) =>
          run.id === "run-live"
            ? lifecycle === null
              ? (({ lifecycle: _, ...rest }) => rest)(run)
              : { ...run, lifecycle }
            : run,
        );
        return { ...state, transcripts: { ...transcripts, [key]: { ...t, runs } } };
      });
    },
    { lifecycle },
  );
}

/** Nothing inside reaches past its own right edge: no horizontal scroll at this width. */
async function fitsWidth(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-418: a request that outlived its run says the run ended and stays answerable; it closes only with the gateway's outcome, naming who decided, and the app sends nothing", async ({
        page,
      }) => {
        await openFixture(page, "scene=approval-run-ended", theme);
        await recordCommands(page);
        const card = approvalCard(page);
        await expect(card).toHaveAttribute("data-state", "pending");
        await expect(card.locator(".request-ended")).toHaveText(
          "Otto's run has ended. The last gateway record shows this request pending.",
        );
        for (const name of ["Allow once", "Always allow…", "Deny"]) {
          await expect(card.getByRole("button", { name, exact: true })).toBeVisible();
        }
        await fitsWidth(page, card);
        // The gateway's own outcome arrives, decided on another device.
        await settleFromGateway(page, {
          status: "denied",
          decision: "deny",
          resolvedBy: "Pip's laptop",
          reason: "user",
        });
        await expect(card.locator(".tag")).toHaveText("Denied");
        await card.locator("summary").first().click();
        await expect(card.locator(".request-resolved-body > p").first()).toHaveText(
          /^Denied by Pip's laptop at \d+:\d\d [AP]M\.$/,
        );
        await expect(card).not.toContainText(/run ended|not run|can run now/);
        expect(await commandsSent(page)).toEqual([]);
      });

      test("F-164: the full request gives the exact command to copy and states the host's policy from the request's own fields, as policy", async ({
        page,
      }) => {
        await openFixture(page, "scene=approval-pending", theme);
        const card = approvalCard(page);
        const full = card.locator("details.request-full");
        await full.locator("summary").click();
        await expect(full.locator("summary")).toHaveText(/Hide full request/);
        await expect(full.locator(".command-line code")).toHaveText(
          "mv /srv/media/transcode-cache /srv/scratch/transcode-cache",
        );
        await expect(full.getByRole("button", { name: "Copy command" })).toBeVisible();
        // The line follows the request's own fields, and says nothing of why this request asked.
        expect(await execFields(page)).toMatchObject({ security: "allowlist", ask: "on-miss" });
        await expect(full.locator(".request-why")).toHaveText(
          "Request policy: security allowlist, ask on-miss.",
        );
        await expect(full.getByRole("button", { name: "Manage settings" })).toHaveCount(0);
        await fitsWidth(page, card);
        // A two-phase request that carries the fields and no evaluation: the same policy line.
        await changeExec(page, { commandAnalysis: null });
        await expect(full.locator(".request-why")).toHaveText(
          "Request policy: security allowlist, ask on-miss.",
        );
        await changeExec(page, { ask: "always" });
        await expect(full.locator(".request-why")).toHaveText(
          "Request policy: security allowlist, ask always.",
        );
        // A denied host rejects before asking: the line gives the fields and forecasts nothing.
        await changeExec(page, { security: "deny", ask: "always" });
        await expect(full.locator(".request-why")).toHaveText(
          "Request policy: security deny, ask always.",
        );
        await changeExec(page, { security: null, ask: null });
        await expect(full.locator(".request-why")).toHaveCount(0);
        await full.locator("summary").click();
        await expect(full.locator("summary")).toHaveText(/Show full request/);
      });

      test("F-094: a stop note, a failed turn's card and the run line each have Raw with the event behind it", async ({
        page,
      }) => {
        const raw = (target: Locator) =>
          target.getByRole("region", { name: "What the gateway sent" });
        await openFixture(
          page,
          "scene=run-stopped&bot=otto&task=agent:otto:disk-space&panel=closed",
          theme,
        );
        const note = page.getByTestId("stop-note");
        await note.getByRole("button", { name: "Raw" }).click();
        await expect(raw(note)).toContainText(
          "The event, as the gateway sent it (agent (lifecycle end))",
        );
        await expect(raw(note)).toContainText('"aborted": true');
        await fitsWidth(page, note);
        const line = page.getByTestId("run-line").last();
        await line.locator("summary").click();
        await line.getByRole("button", { name: "Raw" }).click();
        await expect(raw(line)).toContainText("(agent (lifecycle start))");
        // Nothing received about the run: Raw says so, and does not claim it was read from history.
        await setRunLifecycle(page, null);
        await line.getByRole("button", { name: "Raw" }).click();
        await line.getByRole("button", { name: "Raw" }).click();
        await expect(raw(line)).toContainText(
          "This view has no retained start or end record for the run.",
        );
        await expect(raw(line)).not.toContainText("history");
        // A run read from history: a received history row for it, labelled as that.
        await setRunLifecycle(page, [
          {
            via: "chat.history (the run's last correlated row)",
            record: { role: "assistant", stopReason: "stop", __openclaw: { runId: "run-live" } },
          },
        ]);
        await expect(raw(line)).toContainText("A received history row for this run (chat.history)");
        await openFixture(
          page,
          "scene=run-failed&bot=otto&task=agent:otto:disk-space&panel=closed",
          theme,
        );
        // A failed run: the event that failed it is in no snapshot, so Raw shows it once opened,
        // read from the host, with the run's start beside it; on the card and on the run line.
        const state = () =>
          page.evaluate(() =>
            JSON.stringify(
              (
                window as unknown as { clawtrateFixture: { getState: () => unknown } }
              ).clawtrateFixture.getState(),
            ),
          );
        expect(await state()).not.toContain("(agent (lifecycle error))");
        const error = page.getByTestId("turn-error");
        await error.getByRole("button", { name: "Raw" }).click();
        await expect(raw(error)).toContainText("The chat event that ended the turn, as received");
        await expect(raw(error)).toContainText("The model provider is overloaded.");
        await expect(raw(error)).toContainText("(agent (lifecycle start))");
        await fitsWidth(page, error);
        const failedLine = page.getByTestId("run-line").last();
        await failedLine.locator("summary").click();
        await failedLine.getByRole("button", { name: "Raw" }).click();
        await expect(raw(failedLine)).toContainText(
          "The chat event that ended the turn, as received",
        );
        await expect(raw(failedLine)).toContainText("The model provider is overloaded.");
        await expect(raw(failedLine)).toContainText("(agent (lifecycle start))");
      });

      test("F-057: a task done with failures shows the failed mark, and a blocked task says blocked", async ({
        page,
      }) => {
        await openFixture(page, "scene=task-states&bot=otto", theme);
        // In one pane the conversation is on screen: the rail is one step back.
        const back = async () => {
          if (size.phone) await page.getByRole("button", { name: "Back to bots" }).click();
        };
        await back();
        const otto = page
          .getByTestId("bot-list")
          .getByRole("button", { name: /^Otto\b/ })
          .first();
        await expect(otto).toHaveAccessibleName(/^Otto, done with failures, /);
        const tasks = page.getByRole("list", { name: "Otto's tasks" }).getByTestId("task");
        const backup = tasks.filter({ hasText: "Weekly backup check" });
        await expect(backup.locator(".glyph")).toHaveAttribute("data-state", "failed");
        await expect(backup).toHaveAccessibleName(/, done with failures$/);
        // A task with no mark still says its state: idle or done.
        const quiet = tasks.filter({ hasNot: page.locator(".glyph") });
        const names = await quiet.evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("aria-label") ?? ""),
        );
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) expect(name).toMatch(/, (idle|done)(, unread)?$/);
        await settle(page);
        await fitsWidth(page, otto);
        // Opened, the task's mark gives way.
        await backup.click();
        await back();
        await expect(backup.locator(".glyph")).toHaveCount(0);
        await expect(otto).not.toHaveAccessibleName(/done with failures/);
        // Marlow's only task is blocked: the bot and its state say so.
        await expect(
          page.getByTestId("bot-list").getByRole("button", { name: /^Marlow\b/ }),
        ).toHaveAccessibleName(/^Marlow, blocked, /);
      });
    });
  }
}
