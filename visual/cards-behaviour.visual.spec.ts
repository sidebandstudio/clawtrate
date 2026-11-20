// How the cards behave in the fixture mode (conversation.md sections 9 to 13):
// decisions and answers go through the bridge to the engine's reducers, and
// the cards show only what the engine's state establishes.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { contextFor, openFixture, settle, SIZES } from "./fixture.ts";

/** The gateway's id for the fixture's question: run `run_7f3a91c2`, call `call_ask` (`askUserQuestionId`). */
const QUESTION_ID = "ask_26e18573cf5e61d9e5d65618d22de594";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

/** Record every command the interface sends through the bridge. */
async function recordCommands(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      clawtrateFixture: Record<string, (command: unknown) => Promise<unknown>>;
      sent: unknown[];
    };
    w.sent = [];
    const fixture = w.clawtrateFixture;
    const invoke = fixture.invoke!.bind(fixture);
    const send = fixture.send!.bind(fixture);
    // The card list of the open task (`listArtifacts`) is read as the task is: not recorded.
    const list = (command: unknown) => (command as { type?: string }).type === "listArtifacts";
    fixture.invoke = (command) => (list(command) || w.sent.push(command), invoke(command));
    fixture.send = (command) => (w.sent.push(command), send(command));
  });
}

const sent = (page: Page) =>
  page.evaluate(() => (window as unknown as { sent: Array<Record<string, unknown>> }).sent);

/** The live state of the fixture's card task. */
const transcript = (page: Page, key = "agent:otto:transcode-cache") =>
  page.evaluate(
    (task) =>
      (
        window as unknown as {
          clawtrateFixture: {
            getState(): { transcripts: Record<string, Record<string, unknown>> };
          };
        }
      ).clawtrateFixture.getState().transcripts[task] as {
        runs: Array<{ state: string }>;
        approvals: Array<{ decisionDigest: string; status: string }>;
      },
    key,
  );

const approvalCard = (page: Page) => page.getByTestId("approval-card");
const questionCard = (page: Page) => page.getByTestId("question-card");

test.describe("approval cards", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-163 F-171 F-329 F-155: a pending approval names the bot, says what runs where, shows its warnings, and offers only the request's decisions, its refusal labelled Deny", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-pending", "light");
    const card = page.getByRole("region", { name: "Otto wants to run a command. Needs approval." });
    await expect(card.getByRole("heading", { name: "Otto wants to run a command" })).toBeVisible();
    await expect(card.locator(".tag")).toHaveText("Needs approval");
    await expect(card.locator(".request-summary")).toHaveText(
      "Run mv /srv/media/transcode-cache /srv/scratch/transcode-cache on media-box.",
    );
    await expect(card.locator(".request-summary b")).toHaveText("media-box");
    await expect(card.locator(".request-warnings li")).toHaveText(["This can't be undone"]);
    const actions = card.locator('.request-actions[data-row="main"] button');
    await expect(actions).toHaveText(["Allow once", "Always allow…", "Deny"]);
    // A refusal is always called Deny; there is no Skip or Not now.
    await expect(card.getByRole("button", { name: /Skip|Not now|Never/ })).toHaveCount(0);

    await openFixture(page, "scene=approval-allow-only", "light");
    await expect(approvalCard(page).locator('.request-actions[data-row="main"] button')).toHaveText(
      ["Allow", "Deny"],
    );
  });

  test("F-163: keyboard order is Show full request, Allow once, Always allow…, Deny, Raw", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-pending", "light");
    const card = approvalCard(page);
    await card.locator(".request-full > summary").focus();
    const order: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      order.push(
        await page.evaluate(() => {
          const active = document.activeElement as HTMLElement;
          return active.tagName === "SUMMARY"
            ? "Show full request"
            : (active.textContent ?? "").trim();
        }),
      );
      await page.keyboard.press("Tab");
    }
    expect(order).toEqual(["Show full request", "Allow once", "Always allow…", "Deny", "Raw"]);
    // Focus is drawn where the keyboard put it.
    await page.keyboard.press("Shift+Tab");
    const raw = card.getByRole("button", { name: "Raw" });
    await expect(raw).toBeFocused();
    expect(await raw.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    expect(
      await raw.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.outlineStyle !== "none" || style.boxShadow !== "none";
      }),
    ).toBe(true);
  });

  test("F-163: Deny is there in every pending state, and last at full width on a phone", async ({
    browser,
  }) => {
    for (const size of [WIDE, PHONE]) {
      const context = await browser.newContext(contextFor(size, "light"));
      const page = await context.newPage();
      for (const scene of [
        "approval-pending",
        "approval-sending",
        "approval-refused",
        "approval-unknown",
        "approval-cut",
        "approval-run-ended",
      ]) {
        await openFixture(page, `scene=${scene}`, "light");
        const row = approvalCard(page).locator(".request-actions").first();
        const buttons = row.locator("button");
        await expect(buttons.last(), `${scene} ${size.name}`).toHaveText("Deny");
        if (size.phone) {
          const [rowBox, denyBox] = await Promise.all([
            row.boundingBox(),
            buttons.last().boundingBox(),
          ]);
          expect(Math.round(denyBox!.width), scene).toBe(Math.round(rowBox!.width));
          expect(denyBox!.height, scene).toBe(48);
        }
      }
      // With the form open too.
      await openFixture(page, "scene=approval-pending", "light");
      await approvalCard(page).getByRole("button", { name: "Always allow…" }).click();
      await expect(
        approvalCard(page).getByRole("group", { name: "Always allow" }).locator("button").last(),
      ).toHaveText("Deny");
      await context.close();
    }
  });

  test("F-164: Show full request opens the exact command with a copy button, and reads Hide full request", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-pending", "light");
    const card = approvalCard(page);
    await card.getByText("Show full request").click();
    await expect(card.locator(".command-line code")).toHaveText(
      "mv /srv/media/transcode-cache /srv/scratch/transcode-cache",
    );
    await expect(card.locator(".command-line code")).toHaveCSS("font-family", /Mono/);
    await expect(card.getByRole("button", { name: "Copy command" })).toBeVisible();
    await expect(card.locator(".request-inset dt")).toHaveText([
      "Runs on",
      "Folder",
      "Asked by",
      "Warning",
    ]);
    await expect(card.locator(".request-full > summary .when-open")).toBeVisible();
    await expect(card.locator(".request-full > summary .when-open")).toHaveText(
      "Hide full request",
    );
    await expect(card.locator(".request-full > summary .when-closed")).toBeHidden();
    await card.getByText("Hide full request").click();
    await expect(card.locator(".request-inset")).toBeHidden();
  });

  test("F-163 F-325: Allow once goes through the engine: Sending…, then Allowed once, with focus on the resolved line", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-pending", "light");
    await recordCommands(page);
    // The gateway's answer is held until the check has seen the decision on its way: that state
    // lasts only until the answer, so a fixed delay is never long enough on a loaded machine.
    await page.evaluate(() =>
      (window as unknown as { clawtrateFixture: { hold(): void } }).clawtrateFixture.hold(),
    );
    const card = approvalCard(page);
    await card.getByRole("button", { name: "Allow once" }).focus();
    await page.keyboard.press("Enter");
    const chosen = card.getByRole("button", { name: "Sending…" });
    await expect(chosen).toHaveAttribute("aria-disabled", "true");
    await expect(chosen).toBeFocused();
    await expect(card.getByText("Sending your decision…")).toBeVisible();
    await expect(card.getByRole("button", { name: "Deny" })).toBeEnabled();
    await page.evaluate(() =>
      (window as unknown as { clawtrateFixture: { release(): void } }).clawtrateFixture.release(),
    );
    await expect(card.locator(".tag")).toHaveText("Allowed once");
    await expect(card).toHaveAttribute("data-state", "allowed");
    await expect(page.locator(":focus")).toHaveText(/Allowed once/);
    await card.locator("summary").first().click();
    await expect(
      card.getByText("Allowed once. The command can run now. Otto will ask again next time."),
    ).toBeVisible();
    expect(await sent(page)).toContainEqual({
      type: "resolveApproval",
      key: "agent:otto:transcode-cache",
      approvalId: "apr_5d2a",
      decision: "allow-once",
      expiresInDays: null,
      shownDigest: null,
    });
  });

  test("F-163: Deny works while an earlier decision is on its way; a second allow is not offered", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-sending", "light");
    await recordCommands(page);
    const card = approvalCard(page);
    await expect(card.getByText("Sending your decision…")).toBeVisible();
    await expect(card.getByRole("button", { name: "Always allow…" })).toHaveCount(0);
    await card.getByRole("button", { name: "Allow once" }).click({ force: true });
    await card.getByRole("button", { name: "Deny" }).click();
    await expect(card.locator(".tag")).toHaveText("Denied");
    expect((await sent(page)).map((command) => command.decision)).toEqual(["deny"]);
  });

  test("F-165: Deny sends deny, the buttons go, and the card says the command was not run", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-pending", "light");
    await recordCommands(page);
    const card = approvalCard(page);
    await card.getByRole("button", { name: "Deny" }).click();
    await expect(card.locator(".tag")).toHaveText("Denied");
    await expect(card.getByRole("button", { name: /Allow|Deny/ })).toHaveCount(0);
    await card.locator("summary").first().click();
    await expect(card.getByText("Denied. The command was not run.")).toBeVisible();
    expect((await sent(page)).at(-1)).toMatchObject({ decision: "deny" });
  });

  test("F-167 F-155: Always allow… shows the request's own fields and what is kept, with focus on Allow and save; Escape returns; saving sends allow-always", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-pending", "light");
    await recordCommands(page);
    const card = approvalCard(page);
    const always = card.getByRole("button", { name: "Always allow…" });
    await always.click();
    const form = card.getByRole("group", { name: "Always allow" });
    await expect(form.locator("dt")).toHaveText([
      "Command",
      "Arguments",
      "Folder",
      "Runs on",
      "Bot",
    ]);
    await expect(form.locator("dd").last()).toHaveText("Otto");
    await expect(form.locator(".standing-outcome")).toHaveText(
      "The gateway will add this to media-box's allowlist, so Otto is not asked again for commands it matches. The gateway decides what that covers; it can be wider than this exact command.",
    );
    await expect(form.getByLabel("Number of days")).toHaveCount(0);
    await expect(form.getByRole("button", { name: "Allow and save" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(form).toBeHidden();
    await expect(always).toBeFocused();
    await always.click();
    await form.getByRole("button", { name: "Back" }).click();
    await expect(always).toBeFocused();
    await always.click();
    await form.getByRole("button", { name: "Allow and save" }).click();
    await expect(card.locator(".tag")).toHaveText("Always allowed");
    await card.locator("summary").first().click();
    await expect(
      card.getByText(
        "Added to media-box's allowlist. The gateway decides what it covers. Seeing that list needs admin access.",
      ),
    ).toBeVisible();
    expect((await sent(page)).at(-1)).toMatchObject({
      decision: "allow-always",
      expiresInDays: null,
    });
  });

  test("F-167: a routine's grant takes whole days from 1 to 3650", async ({ page }) => {
    await openFixture(page, "scene=approval-routine", "light");
    await recordCommands(page);
    const card = approvalCard(page);
    await card.getByRole("button", { name: "Always allow…" }).click();
    const form = card.getByRole("group", { name: "Always allow" });
    await expect(form.locator("dt").last()).toHaveText("For");
    await expect(form.locator(".standing-outcome")).toHaveText(
      "The routine Weekly cleanup may run this command without asking.",
    );
    const days = form.getByLabel("Number of days");
    // It starts from the lifetime the gateway gives the grant (`scope.expiresInDays`).
    await expect(days).toHaveValue("7");
    for (const bad of ["0", "3651", "1.5"]) {
      await days.fill(bad);
      await expect(form.getByText("Between 1 and 3650 days.")).toBeVisible();
      await expect(form.getByRole("button", { name: "Allow and save" })).toBeDisabled();
    }
    await days.fill("30");
    await expect(form.getByText("Between 1 and 3650 days.")).toBeHidden();
    await form.getByRole("button", { name: "Allow and save" }).click();
    await expect(card.locator(".tag")).toHaveText("Always allowed");
    expect((await sent(page)).at(-1)).toMatchObject({
      decision: "allow-always",
      expiresInDays: 30,
    });
  });

  test("F-167: a routine's grant left as it starts lasts the gateway's default", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-routine", "light");
    await recordCommands(page);
    const card = approvalCard(page);
    await card.getByRole("button", { name: "Always allow…" }).click();
    const form = card.getByRole("group", { name: "Always allow" });
    await expect(form.getByLabel("Number of days")).toHaveValue("7");
    await form.getByRole("button", { name: "Allow and save" }).click();
    await expect(card.locator(".tag")).toHaveText("Always allowed");
    expect((await sent(page)).at(-1)).toMatchObject({
      decision: "allow-always",
      expiresInDays: 7,
    });
  });

  test("F-163: ⌘↵ in the card allows once, or allows and saves with the form open; Deny has no shortcut", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-pending", "light");
    await recordCommands(page);
    const card = approvalCard(page);
    await card.getByRole("button", { name: "Always allow…" }).click();
    await expect(card.getByRole("button", { name: "Allow and save" })).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(card.locator(".tag")).toHaveText("Always allowed");
    expect((await sent(page)).at(-1)).toMatchObject({ decision: "allow-always" });

    await openFixture(page, "scene=approval-pending", "light");
    await recordCommands(page);
    await approvalCard(page).getByRole("button", { name: "Deny" }).focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(approvalCard(page).locator(".tag")).toHaveText("Allowed once");
    expect((await sent(page)).map((command) => command.decision)).toEqual(["allow-once"]);
  });

  test("F-163: a refused save says why, offers Try again, Allow once instead, Back and Deny, and says the request is open only once read back", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-refused", "light");
    const card = approvalCard(page);
    // Opened already refused: the reason, and the choices beside it.
    await expect(card.getByRole("alert")).toHaveText(
      "The gateway refused this decision. allow-always is unavailable for this command The request is still open.",
    );
    await card.getByRole("button", { name: "Always allow…" }).click();
    await card.getByRole("button", { name: "Allow and save" }).click();
    const alert = card.getByRole("alert");
    await expect(alert).toContainText("The gateway refused this decision.");
    await expect(alert).toContainText("The request is still open.");
    await expect(
      card.getByRole("group", { name: "Always allow" }).locator(".request-actions button"),
    ).toHaveText(["Try again", "Allow once instead", "Back", "Deny"]);
    await card.getByRole("button", { name: "Allow once instead" }).click();
    await expect(card.getByRole("alert")).toContainText("refused");
  });

  test("F-163: with no answer, the outcome is unknown: only Check again and Deny until the request is read back, then the choices return", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-unknown", "light");
    await recordCommands(page);
    const card = approvalCard(page);
    await expect(card.getByRole("status")).toHaveText(
      "No answer from the gateway says what happened. Your decision may or may not have been applied.",
    );
    await expect(card.locator('.request-actions[data-row="main"] button')).toHaveText([
      "Check again",
      "Deny",
    ]);
    await card.getByRole("button", { name: "Check again" }).click();
    await expect(card.locator('.request-actions[data-row="main"] button')).toHaveText([
      "Allow once",
      "Always allow…",
      "Deny",
    ]);
    expect(await sent(page)).toContainEqual({
      type: "checkApproval",
      key: "agent:otto:transcode-cache",
      approvalId: "apr_5d2a",
    });
  });

  test("F-163: a request whose text the engine cut offers only Deny until it is read whole; the allow then names the whole text's digest", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-cut", "light");
    await recordCommands(page);
    const card = approvalCard(page);
    await expect(card.locator('.request-actions[data-row="main"] button')).toHaveText(["Deny"]);
    await card.getByText("Show full request").click();
    const before = (await card.locator(".command-line code").first().textContent())!.length;
    await card.getByRole("button", { name: "Read the whole request" }).click();
    await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
    expect(
      (await card.locator(".command-line code").first().textContent())!.length,
    ).toBeGreaterThan(before);
    await card.getByRole("button", { name: "Allow once" }).click();
    await expect(card.locator(".tag")).toHaveText("Allowed once");
    const digest = (await sent(page)).find(
      (command) => command.type === "resolveApproval",
    )!.shownDigest;
    expect(digest).toBeTruthy();
    expect((await sent(page)).map((command) => command.type)).toEqual([
      "readApprovalText",
      "resolveApproval",
    ]);
  });

  test("F-163: Allow is offered only while the whole text read through the engine is on screen, its fields kept apart", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-cut", "light");
    await recordCommands(page);
    const card = approvalCard(page);
    // Read without opening the full request first: reading opens it.
    await card.getByRole("button", { name: "Read the whole request" }).click();
    const inset = card.locator('.request-inset[data-whole="true"]');
    await expect(inset).toBeVisible();
    await expect(card.locator(".request-full")).toHaveAttribute("open", "");
    await expect(inset.locator(".code-label")).toHaveText(["Command", "Folder"]);
    await expect(inset.locator(".command-line code").last()).toHaveText("/srv/media");
    expect((await inset.locator(".command-line code").first().textContent())!).not.toContain(
      "\n/srv/media",
    );
    await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
    // Hidden again, it is no longer shown: Allow goes with it.
    await card.getByText("Hide full request").click();
    await expect(card.getByRole("button", { name: "Allow once" })).toHaveCount(0);
    await expect(card.locator('.request-actions[data-row="main"] button')).toHaveText(["Deny"]);
    await card.getByText("Show full request").click();
    await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
  });

  test("F-163: a long command keeps the card compact; the summary shows its start, the full request the rest", async ({
    browser,
  }) => {
    for (const size of [WIDE, PHONE]) {
      const context = await browser.newContext(contextFor(size, "light"));
      const page = await context.newPage();
      await openFixture(page, "scene=approval-cut", "light");
      const card = approvalCard(page);
      const code = card.locator(".request-summary code");
      await expect(code).toHaveText(/…$/);
      expect((await code.textContent())!.length).toBeLessThanOrEqual(73);
      const box = await card.boundingBox();
      expect(box!.height, size.name).toBeLessThan(size.phone ? 760 : 520);
      await context.close();
    }
  });

  test("F-167: the Always allow form shows the command exactly and each argument on its own", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-pending", "light");
    const card = approvalCard(page);
    await card.getByRole("button", { name: "Always allow…" }).click();
    const form = card.getByRole("group", { name: "Always allow" });
    await expect(form.locator("dt")).toHaveText([
      "Command",
      "Arguments",
      "Folder",
      "Runs on",
      "Bot",
    ]);
    await expect(form.locator("dd").first()).toHaveText(
      "mv /srv/media/transcode-cache /srv/scratch/transcode-cache",
    );
    await expect(form.getByRole("list", { name: "Arguments" }).locator("li")).toHaveText([
      "mv",
      "/srv/media/transcode-cache",
      "/srv/scratch/transcode-cache",
    ]);
  });

  test("F-168: a pending card says when it expires; an expired one says the command was not run", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-pending", "light");
    await expect(approvalCard(page).locator(".request-foot")).toHaveText(
      "Expires in 28 minutes; the command is not run if it does.",
    );
    await openFixture(page, "scene=approval-expired", "light");
    const card = approvalCard(page);
    await expect(card.locator(".tag")).toHaveText("Expired");
    await card.locator("summary").first().click();
    await expect(card.locator(".request-resolved-body > p").first()).toHaveText(
      /^Expired at \d+:\d\d [AP]M without an answer\. The command was not run\.$/,
    );
  });

  test("F-169 F-418: Stop's cancellation, a closed request, and one still open after its run ended say exactly that", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-cancelled", "light");
    await expect(approvalCard(page).locator(".tag")).toHaveText("Cancelled");
    await approvalCard(page).locator("summary").first().click();
    await expect(
      approvalCard(page).getByText(
        "You stopped the run before answering. The command was not run.",
      ),
    ).toBeVisible();
    await openFixture(page, "scene=approval-closed-ended", "light");
    await expect(approvalCard(page).locator(".tag")).toHaveText("Closed: the run ended");
    await openFixture(page, "scene=approval-run-ended", "light");
    await expect(
      approvalCard(page).getByText(
        "Otto's run has ended. This request is still open, and you can still answer it.",
      ),
    ).toBeVisible();
    await expect(approvalCard(page).getByRole("button", { name: "Allow once" })).toBeVisible();
  });

  test("F-163: Raw shows the request as the gateway sent it; Escape closes it and returns focus to Raw", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-pending", "light");
    const card = approvalCard(page);
    const raw = card.getByRole("button", { name: "Raw" });
    await raw.click();
    await expect(raw).toHaveAttribute("aria-expanded", "true");
    const panel = card.getByRole("region", { name: "What the gateway sent" });
    await expect(panel.locator(".code-label").first()).toHaveText(
      "The request record, as the gateway sent it (exec.approval.requested or exec.approval.list)",
    );
    await expect(panel.locator("pre").first()).toContainText('"allowedDecisions"');
    await expect(panel.getByRole("button", { name: "Copy approval id" })).toBeVisible();
    await panel.locator("pre").first().focus();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(raw).toBeFocused();
  });

  test("F-163 F-113: Raw shows the request, the record that settled it and what this app sent, each labelled, and says what it does not have", async ({
    page,
  }) => {
    const REQUEST =
      "The request record, as the gateway sent it (exec.approval.requested or exec.approval.list)";
    // Settled elsewhere: the gateway's event, and a line that this app sent nothing.
    await openFixture(page, "scene=approval-denied", "light");
    let card = approvalCard(page);
    await card.locator("summary").first().click();
    await card.getByRole("button", { name: "Raw" }).click();
    let panel = card.getByRole("region", { name: "What the gateway sent" });
    await expect(panel.locator(".code-label")).toHaveText([
      REQUEST,
      "The event that settled it, as the gateway sent it (exec.approval.resolved)",
      "Identifiers",
    ]);
    await expect(panel.locator("pre").nth(1)).toContainText('"decision": "deny"');
    await expect(panel).toContainText("This app sent nothing to settle it.");
    await expect(panel).not.toContainText("did not receive");

    // No record of how it ended reached the engine: it says so, and shows nothing in its place.
    await openFixture(page, "scene=approval-expired", "light");
    card = approvalCard(page);
    await card.locator("summary").first().click();
    await card.getByRole("button", { name: "Raw" }).click();
    panel = card.getByRole("region", { name: "What the gateway sent" });
    await expect(panel).toContainText(
      "This app did not receive the gateway's record of how it was settled.",
    );
    await expect(panel.locator("pre")).toHaveCount(1);

    // Decided here: the parameters sent, the gateway's reply and its event.
    await openFixture(page, "scene=approval-pending", "light");
    card = approvalCard(page);
    await card.getByRole("button", { name: "Allow once" }).click();
    await expect(card.locator(".tag")).toHaveText("Allowed once");
    await card.locator("summary").first().click();
    await card.getByRole("button", { name: "Raw" }).click();
    panel = card.getByRole("region", { name: "What the gateway sent" });
    await expect(panel.locator(".code-label")).toHaveText([
      REQUEST,
      "The gateway's reply to this app's request, as sent (exec.approval.resolve)",
      "The event that settled it, as the gateway sent it (exec.approval.resolved)",
      "What this app sent (exec.approval.resolve)",
      "Identifiers",
    ]);
    await expect(panel.locator("pre").nth(3)).toContainText('"decision": "allow-once"');
    await expect(panel.locator("pre").nth(3)).toContainText('"id": "apr_5d2a"');
    await expect(panel).not.toContainText("did not receive");
    await expect(panel).not.toContainText("sent nothing");

    // A question answered here: the same, with the answer as sent.
    await openFixture(page, "scene=question-single", "light");
    card = questionCard(page);
    await card.getByRole("radio", { name: /A week/ }).click();
    await expect(card).toHaveAttribute("data-state", "answered");
    await card.getByRole("button", { name: "Raw" }).click();
    panel = card.getByRole("region", { name: "What the gateway sent" });
    await expect(panel.locator(".code-label")).toHaveText([
      "The question record, as the gateway sent it (question.requested or question.list)",
      "The gateway's reply to this app's request, as sent (question.resolve)",
      "The event that settled it, as the gateway sent it (question.resolved)",
      "What this app sent (question.resolve)",
      "Identifiers",
    ]);
    await expect(panel.locator("pre").nth(2)).toContainText('"status": "answered"');
    await expect(panel.locator("pre").nth(3)).toContainText('"A week"');

    // Dismissed elsewhere: its event, and nothing sent from here.
    await openFixture(page, "scene=question-dismissed", "light");
    card = questionCard(page);
    await card.getByRole("button", { name: "Raw" }).click();
    panel = card.getByRole("region", { name: "What the gateway sent" });
    await expect(panel.locator(".code-label").nth(1)).toHaveText(
      "The event that settled it, as the gateway sent it (question.resolved)",
    );
    await expect(panel).toContainText("This app sent nothing to settle it.");

    await openFixture(page, "scene=incoming-line", "light");
    const line = page.getByTestId("incoming-line");
    await line.locator("summary").click();
    await line.getByRole("button", { name: "Raw" }).click();
    panel = line.getByRole("region", { name: "What the gateway sent" });
    await expect(panel).toContainText(
      "This app does not keep the history row this message came from",
    );
    await expect(panel.locator("pre")).toHaveCount(0);
  });

  test("F-163: a request this device can read but not answer has no decisions and offers Request access", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-readonly", "light");
    await recordCommands(page);
    const card = approvalCard(page);
    await expect(
      card.getByText("You can read this request but not answer it from this device."),
    ).toBeVisible();
    await expect(card.getByRole("button", { name: /Allow|Deny/ })).toHaveCount(0);
    await card.getByRole("button", { name: "Request access" }).click();
    expect(await sent(page)).toEqual([{ type: "requestAccess" }]);
  });

  test("F-163: on a connection without approval access neither the shortcut nor anything else sends a decision", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-readonly", "light");
    await recordCommands(page);
    const card = approvalCard(page);
    await card.getByRole("button", { name: "Raw" }).focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await card.getByText("Show full request").click();
    await page.keyboard.press("ControlOrMeta+Enter");
    await settle(page);
    expect(await sent(page)).toEqual([]);
    await expect(card).toHaveAttribute("data-state", "pending");
  });

  test("F-163: ⌘J moves focus to the oldest pending card", async ({ page }) => {
    await openFixture(page, "scene=approval-pending", "light");
    // The card has arrived and is the task's pending one, and the page has focus, before the
    // key: the app's handler, attached before the first paint, reads the transcript then.
    await expect(approvalCard(page)).toBeVisible();
    await expect(approvalCard(page)).toHaveAttribute("data-pending", "true");
    // The page takes focus from a click on the transcript's corner, away from every control:
    // the middle of the page is the card's Always allow…, whose form takes focus a frame later.
    await page.getByTestId("transcript").click({ position: { x: 4, y: 4 } });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await expect(approvalCard(page)).not.toBeFocused();
    await page.keyboard.press("ControlOrMeta+j");
    await expect(approvalCard(page)).toBeFocused();
  });
});

test.describe("question cards", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-112: a question shows its text, Dismiss, lettered options with their descriptions, and the own-answer field", async ({
    page,
  }) => {
    await openFixture(page, "scene=question-single", "light");
    const card = page.getByRole("region", {
      name: "Otto asks: How long should I keep the cache in /srv/scratch before deleting it?",
    });
    await expect(card.getByRole("button", { name: "Dismiss Otto's question" })).toBeVisible();
    const options = card.getByRole("radio");
    await expect(options.locator(".option-key")).toHaveText(["A", "B", "C", "D"]);
    await expect(options.nth(0)).toContainText("A weekDelete it next Monday");
    await expect(options.nth(1).locator(".option-sub")).toHaveCount(0);
    await expect(card.getByPlaceholder("Type your own answer")).toBeVisible();
  });

  test("F-113: choosing an option answers at once; the card keeps the title and shrinks to the answer with a check", async ({
    page,
  }) => {
    await openFixture(page, "scene=question-single", "light");
    await recordCommands(page);
    const card = questionCard(page);
    await card.getByRole("radio", { name: /A week/ }).click();
    await expect(card).toHaveAttribute("data-state", "answered");
    await expect(card.locator(".request-title")).toHaveText(
      "How long should I keep the cache in /srv/scratch before deleting it?",
    );
    await expect(card.locator(".answer")).toHaveText(["AA week"]);
    await expect(card.locator(".answer .glyph[data-state=check]")).toHaveCount(1);
    expect(await sent(page)).toEqual([
      {
        type: "answerQuestion",
        key: "agent:otto:transcode-cache",
        questionId: QUESTION_ID,
        answers: { keep_cache: [{ option: 0 }] },
      },
    ]);
  });

  test("F-113: once answered, the question is not repeated as a message, also after history brings the run's later rows", async ({
    page,
  }) => {
    await openFixture(page, "scene=question-single", "light");
    const card = questionCard(page);
    await card.getByRole("radio", { name: /A week/ }).click();
    await expect(card).toHaveAttribute("data-state", "answered");
    // History then holds the ask_user call and the bot's next reply, as the gateway records them.
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState(change: (state: Record<string, unknown>) => unknown): void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const transcripts = state.transcripts as Record<string, { items: unknown[] }>;
        const key = "agent:otto:transcode-cache";
        const transcript = transcripts[key]!;
        const question = "How long should I keep the cache in /srv/scratch before deleting it?";
        return {
          ...state,
          transcripts: {
            ...transcripts,
            [key]: {
              ...transcript,
              items: [
                ...transcript.items,
                {
                  id: "h-ask:1",
                  role: "assistant",
                  timestamp: Date.now(),
                  model: null,
                  blocks: [
                    {
                      kind: "tool-call",
                      callId: "call_ask",
                      name: "ask_user",
                      argumentsText: JSON.stringify({ questions: [{ question }] }, null, 2),
                      result: { isError: false, text: JSON.stringify({ status: "answered" }) },
                    },
                  ],
                },
                {
                  id: "h-reply:2",
                  role: "assistant",
                  timestamp: Date.now(),
                  model: null,
                  blocks: [{ kind: "text", text: "Keeping it for a week, then deleting it." }],
                },
              ],
            },
          },
        };
      });
    });
    await expect(page.getByText("Keeping it for a week, then deleting it.")).toBeVisible();
    await expect(
      page.locator(".bubble", { hasText: "How long should I keep the cache" }),
    ).toHaveCount(0);
    await expect(card.locator(".request-title")).toHaveText(
      "How long should I keep the cache in /srv/scratch before deleting it?",
    );
  });

  test("F-114: several answers: Choose all that apply, two chosen, Send answer, both answered", async ({
    page,
  }) => {
    await openFixture(page, "scene=question-multi", "light");
    await recordCommands(page);
    const card = questionCard(page);
    await expect(card.getByText("Choose all that apply.")).toBeVisible();
    const send = card.getByRole("button", { name: "Send answer" });
    await expect(send).toBeDisabled();
    await card.getByRole("checkbox", { name: /media-box/ }).click();
    await card.getByRole("checkbox", { name: /attic-nas/ }).click();
    await expect(card.getByText("2 chosen")).toBeVisible();
    await send.click();
    await expect(card.locator(".answer")).toHaveText(["Amedia-box", "Cattic-nas"]);
    expect((await sent(page)).at(-1)).toMatchObject({
      answers: { machines: [{ option: 0 }, { option: 2 }] },
    });
  });

  test("F-303: a typed answer is sent as typed and shown answered; typing clears chosen options and choosing clears the text", async ({
    page,
  }) => {
    await openFixture(page, "scene=question-three", "light");
    const card = questionCard(page);
    const first = card.locator(".question").first();
    await first.getByRole("radio", { name: /A month/ }).click();
    await first.getByPlaceholder("Type your own answer").fill("Two weeks");
    await expect(first.getByRole("radio", { name: /A month/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await first.getByRole("radio", { name: /A month/ }).click();
    await expect(first.getByPlaceholder("Type your own answer")).toHaveValue("");

    await openFixture(page, "scene=question-single", "light");
    await recordCommands(page);
    const single = questionCard(page);
    await single.getByPlaceholder("Type your own answer").fill("Two weeks, then ask me");
    await single.getByPlaceholder("Type your own answer").press("Enter");
    await expect(single.locator(".answer")).toHaveText(["Two weeks, then ask me"]);
    expect((await sent(page)).at(-1)).toMatchObject({
      answers: { keep_cache: ["Two weeks, then ask me"] },
    });
  });

  test("F-302: Dismiss sends no answer, folds the card to Dismissed, and the run is running again", async ({
    page,
  }) => {
    await openFixture(page, "scene=question-single", "light");
    await recordCommands(page);
    expect((await transcript(page)).runs[0]!.state).toBe("waiting");
    await questionCard(page).getByRole("button", { name: "Dismiss Otto's question" }).click();
    await expect(questionCard(page).locator(".answer")).toHaveText(["Dismissed"]);
    expect((await sent(page)).at(-1)).toEqual({
      type: "dismissQuestion",
      key: "agent:otto:transcode-cache",
      questionId: QUESTION_ID,
    });
    expect((await transcript(page)).runs[0]!.state).toBe("running");
  });

  test("F-112 F-303: keyboard: one tab stop, arrows move, letters choose; Escape clears a draft, then dismisses; ⌘↵ sends from the typed field", async ({
    page,
  }) => {
    await openFixture(page, "scene=question-multi", "light");
    await recordCommands(page);
    const card = questionCard(page);
    await card.getByRole("checkbox").first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(card.getByRole("checkbox").nth(1)).toBeFocused();
    await page.keyboard.press("c");
    await expect(card.getByRole("checkbox").nth(2)).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Space");
    await expect(card.getByRole("checkbox").nth(2)).toHaveAttribute("aria-checked", "false");
    // Only one option takes Tab: the next stop is the typed field.
    await page.keyboard.press("Tab");
    await expect(card.getByPlaceholder("Type your own answer")).toBeFocused();
    await page.keyboard.type("All three");
    await page.keyboard.press("Escape");
    await expect(card.getByPlaceholder("Type your own answer")).toHaveValue("");
    await expect(card).toHaveAttribute("data-state", "pending");
    await page.keyboard.type("All three");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(card.locator(".answer")).toHaveText(["All three"]);

    await openFixture(page, "scene=question-single", "light");
    await recordCommands(page);
    await questionCard(page).getByRole("radio").first().focus();
    await page.keyboard.press("Escape");
    await expect(questionCard(page).locator(".answer")).toHaveText(["Dismissed"]);
  });

  test("F-112 F-303 F-302: after a typed answer, its send button or Dismiss, focus is on the settled card", async ({
    page,
  }) => {
    const settledFocused = () =>
      page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return active?.dataset.testid === "question-card" && active.dataset.state !== "pending";
      });
    await openFixture(page, "scene=question-single", "light");
    const field = questionCard(page).getByPlaceholder("Type your own answer");
    await field.fill("Two weeks");
    await field.press("Enter");
    await expect(questionCard(page)).toHaveAttribute("data-state", "answered");
    expect(await settledFocused()).toBe(true);

    await openFixture(page, "scene=question-single", "light");
    await questionCard(page).getByPlaceholder("Type your own answer").fill("Two weeks");
    await questionCard(page).getByRole("button", { name: "Send this answer" }).click();
    await expect(questionCard(page)).toHaveAttribute("data-state", "answered");
    expect(await settledFocused()).toBe(true);

    await openFixture(page, "scene=question-single", "light");
    await questionCard(page).getByRole("button", { name: "Dismiss Otto's question" }).click();
    await expect(questionCard(page)).toHaveAttribute("data-state", "dismissed");
    expect(await settledFocused()).toBe(true);

    await openFixture(page, "scene=question-three", "light");
    const card = questionCard(page);
    await card.locator(".question").nth(0).getByRole("radio").first().click();
    await card.locator(".question").nth(1).getByRole("checkbox").first().click();
    await card.locator(".question").nth(2).getByRole("radio").first().click();
    await card.getByRole("button", { name: "Send answers" }).click();
    await expect(card).toHaveAttribute("data-state", "answered");
    expect(await settledFocused()).toBe(true);
  });

  test("F-303: ⌘↵ in a single question's typed field sends the answer once", async ({ page }) => {
    await openFixture(page, "scene=question-single", "light");
    await recordCommands(page);
    const field = questionCard(page).getByPlaceholder("Type your own answer");
    await field.fill("Two weeks");
    await field.press("ControlOrMeta+Enter");
    await expect(questionCard(page)).toHaveAttribute("data-state", "answered");
    expect((await sent(page)).filter((command) => command.type === "answerQuestion")).toHaveLength(
      1,
    );
  });

  test("F-112: with three questions nothing is sent until each has an answer", async ({ page }) => {
    await openFixture(page, "scene=question-three", "light");
    await recordCommands(page);
    const card = questionCard(page);
    await expect(card.getByRole("heading", { name: "Otto has 3 questions" })).toBeVisible();
    await expect(card.locator(".question-title span")).toHaveText(["1 of 3", "2 of 3", "3 of 3"]);
    const send = card.getByRole("button", { name: "Send answers" });
    await card.locator(".question").nth(0).getByRole("radio").first().click();
    await card.locator(".question").nth(1).getByRole("checkbox").first().click();
    await expect(card.getByText("2 of 3 answered")).toBeVisible();
    await expect(send).toBeDisabled();
    expect(await sent(page)).toEqual([]);
    await card.locator(".question").nth(2).getByRole("radio").last().click();
    await send.click();
    await expect(card).toHaveAttribute("data-state", "answered");
    expect((await sent(page)).at(-1)).toMatchObject({
      answers: { keep_cache: [{ option: 0 }], machines: [{ option: 0 }], when: [{ option: 1 }] },
    });
  });

  test("F-112: a question record outside the ordinary subset is readable, with Raw, and cannot be answered", async ({
    page,
  }) => {
    await openFixture(page, "scene=question-unanswerable", "light");
    const card = questionCard(page);
    await expect(
      card.getByRole("heading", { name: "Otto asked something this app can't answer yet" }),
    ).toBeVisible();
    await expect(card.getByText("Sign in to the backup provider, then confirm.")).toBeVisible();
    await expect(card.getByRole("radio")).toHaveCount(0);
    await expect(card.getByRole("textbox")).toHaveCount(0);
    await expect(card.getByRole("button", { name: /Dismiss/ })).toHaveCount(0);
    await card.getByRole("button", { name: "Raw" }).click();
    await expect(card.getByRole("region", { name: "What the gateway sent" })).toContainText(
      '"presentation": "form"',
    );
  });
});

test.describe("Messaged cards", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-119 F-122: the folded card shows Messaged, the recipient's avatar and name, the first line and the state", async ({
    page,
  }) => {
    await openFixture(page, "scene=messaged-working", "light");
    const card = page.getByTestId("messaged-card");
    const line = card.locator("summary");
    await expect(line).toHaveAccessibleName(
      "Messaged Marlow: Write a two-line entry for the house log: the weekly backup finished, 41 GB across three machines. Working.",
    );
    await expect(line.locator(".messaged-verb")).toHaveText("Messaged");
    await expect(line.locator(".messaged-who")).toHaveText("Marlow");
    await expect(line.locator(".messaged-who .avatar")).toBeVisible();
    await expect(line.locator(".state")).toHaveText("Working");
    // It sits under the message that started its run.
    const user = page.locator('.msg[data-role="user"]').first();
    const [userBox, cardBox] = await Promise.all([user.boundingBox(), card.boundingBox()]);
    expect(cardBox!.y).toBeGreaterThan(userBox!.y + userBox!.height - 1);
  });

  test("F-121: the card opens in place and folds again; nothing above it moves", async ({
    page,
  }) => {
    await openFixture(page, "scene=messaged-replied", "light");
    const card = page.getByTestId("messaged-card").last();
    const above = page.locator('.msg[data-role="user"]').first();
    const before = await above.boundingBox();
    await card.locator("summary").click();
    await expect(card).toHaveAttribute("open", "");
    expect(await above.boundingBox()).toEqual(before);
    await card.locator("summary").click();
    await expect(card).not.toHaveAttribute("open", "");
    expect(await above.boundingBox()).toEqual(before);
  });

  test("F-123: open, the card shows the exact text sent and the reply, each with its time", async ({
    page,
  }) => {
    await openFixture(page, "scene=messaged-replied", "light");
    const card = page.getByTestId("messaged-card").last();
    await card.locator("summary").click();
    const items = card.locator(".exchange-item");
    await expect(items.nth(0).locator(".exchange-meta")).toHaveText(/^Ottosent\d+:\d\d [AP]M$/);
    await expect(items.nth(0).locator(".exchange-text")).toHaveText(
      "Write a two-line entry for the house log: the weekly backup finished, 41 GB across three machines.",
    );
    await expect(items.nth(1).locator(".exchange-meta")).toHaveText(
      /^Marlowreplied\d+:\d\d [AP]M$/,
    );
    await expect(items.nth(1).locator(".exchange-text")).toHaveText(
      "Nov 16 — Weekly backup finished cleanly.\n41 GB across media-box, garage-pi and attic-nas.",
    );
  });

  test("F-122 F-134: the outgoing row says sent only where the message is known to have gone; a finished recipient run claims no missing reply", async ({
    page,
  }) => {
    const verb = async (scene: string, testId: string) => {
      await openFixture(page, `scene=${scene}`, "light");
      const card = page.getByTestId(testId).last();
      await card.locator("summary").click();
      return card
        .locator(".exchange-item")
        .first()
        .locator(".exchange-meta span")
        .first()
        .textContent();
    };
    for (const scene of [
      "messaged-started",
      "messaged-approval",
      "messaged-not-sent",
      "messaged-unknown",
      "messaged-failed",
      "messaged-blocked",
    ]) {
      expect(await verb(scene, "messaged-card"), scene).toBe("asked to send");
    }
    for (const scene of ["messaged-sent", "messaged-replied", "messaged-no-reply"]) {
      expect(await verb(scene, "messaged-card"), scene).toBe("sent");
    }
    for (const scene of [
      "t3-started",
      "t3-approval",
      "t3-delivery-unknown",
      "t3-failed",
      "t3-not-sent",
    ]) {
      expect(await verb(scene, "t3-card"), scene).toBe("asked to send");
    }
    expect(await verb("t3-call-made", "t3-card")).toBe("sent");
    await openFixture(page, "scene=received-completed", "light");
    const received = page.getByTestId("received-card");
    await received.locator("summary").click();
    await expect(received.getByText("This run has finished.")).toBeVisible();
    await expect(received).not.toContainText("without a reply");
  });

  test("F-124: Open in Marlow opens Marlow's task at its Message from Otto card; Open in Otto comes back with the card still open", async ({
    page,
  }) => {
    await openFixture(page, "scene=messaged-working", "light");
    const card = page.getByTestId("messaged-card");
    await card.locator("summary").click();
    await card.getByRole("button", { name: "Open this message in Marlow's task" }).click();
    await expect(page.locator(".title-pill")).toContainText("House log");
    const received = page.getByTestId("received-card");
    await expect(received).toHaveAttribute("open", "");
    await expect(received.locator("summary")).toBeFocused();
    await received.getByRole("button", { name: "Open this message in Otto's task" }).click();
    await expect(page.locator(".title-pill")).toContainText("Tidy the transcode cache");
    const back = page.getByTestId("messaged-card");
    await expect(back).toHaveAttribute("open", "");
    await expect(
      back.getByRole("button", { name: "Open this message in Marlow's task" }),
    ).toBeFocused();
  });

  test("F-124: Open in Marlow waits for its Message from Otto card when Marlow's task shows its runs before its history has loaded", async ({
    page,
  }) => {
    await openFixture(page, "scene=messaged-working", "light");
    type Fixture = {
      clawtrateFixture: {
        setState(
          change: (s: { transcripts: Record<string, Record<string, unknown>> }) => unknown,
        ): void;
      };
      heldHistory?: Record<string, unknown>;
    };
    // Marlow's task as it opens: its runs known, its history still loading.
    await page.evaluate((key) => {
      const w = window as unknown as Fixture;
      w.clawtrateFixture.setState((s) => {
        const t = s.transcripts[key]!;
        w.heldHistory = t;
        return {
          ...s,
          transcripts: {
            ...s.transcripts,
            [key]: { ...t, status: "loading", items: [], interSession: [] },
          },
        };
      });
    }, "agent:marlow:house-log");
    const card = page.getByTestId("messaged-card");
    await card.locator("summary").click();
    await card.getByRole("button", { name: "Open this message in Marlow's task" }).click();
    await expect(page.locator(".title-pill")).toContainText("House log");
    await expect(page.getByTestId("received-card")).toHaveCount(0);
    await settle(page);
    // The history arrives, and with it the card the arrival was for.
    await page.evaluate((key) => {
      const w = window as unknown as Fixture;
      w.clawtrateFixture.setState((s) => ({
        ...s,
        transcripts: { ...s.transcripts, [key]: w.heldHistory! },
      }));
    }, "agent:marlow:house-log");
    const received = page.getByTestId("received-card");
    await expect(received).toHaveAttribute("open", "");
    await expect(received.locator("summary")).toBeFocused();
  });

  test("F-124: coming back from Marlow's task, by Open in Otto or ⌘[, restores the transcript's place, the open card and focus", async ({
    page,
  }) => {
    for (const back of ["button", "shortcut"] as const) {
      await openFixture(page, "scene=messaged-return", "light");
      const scroller = page.getByTestId("transcript");
      const card = page.getByTestId("messaged-card");
      await card.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await scroller.evaluate((element) => {
        element.scrollTop -= 120;
        element.dispatchEvent(new Event("scroll"));
      });
      await card.locator("summary").click();
      await settle(page);
      const before = {
        top: await scroller.evaluate((element) => element.scrollTop),
        card: (await card.boundingBox())!.y,
      };
      expect(before.top, "the reader is away from the end").toBeLessThan(
        await scroller.evaluate((element) => element.scrollHeight - element.clientHeight - 200),
      );
      await card.getByRole("button", { name: "Open this message in Marlow's task" }).click();
      await expect(page.locator(".title-pill")).toContainText("House log");
      if (back === "button") {
        await page
          .getByTestId("received-card")
          .getByRole("button", { name: "Open this message in Otto's task" })
          .click();
      } else {
        await page.keyboard.press("ControlOrMeta+BracketLeft");
      }
      await expect(page.locator(".title-pill")).toContainText("Tidy the transcode cache");
      const returned = page.getByTestId("messaged-card");
      await expect(returned).toHaveAttribute("open", "");
      await expect(
        returned.getByRole("button", { name: "Open this message in Marlow's task" }),
      ).toBeFocused();
      await settle(page);
      const after = {
        top: await page.getByTestId("transcript").evaluate((element) => element.scrollTop),
        card: (await returned.boundingBox())!.y,
      };
      expect(Math.abs(after.top - before.top), back).toBeLessThanOrEqual(2);
      expect(Math.abs(after.card - before.card), back).toBeLessThanOrEqual(2);
    }
  });

  test("with the task's whole history loaded, Show full exchange shows every message between the two bots in this task, read-only, and returns to the card", async ({
    page,
  }) => {
    await openFixture(page, "scene=messaged-replied", "light");
    const card = page.getByTestId("messaged-card").last();
    await card.locator("summary").click();
    const toggle = card.getByRole("button", {
      name: "Show every message between Otto and Marlow in this task",
    });
    await toggle.click();
    const list = card.getByRole("list", {
      name: "Every message between Otto and Marlow in this task",
    });
    await expect(list.locator(".exchange-text")).toHaveText([
      "Is the house log open for this week?",
      "Yes. The week of Nov 16 is open.",
      /^Write a two-line entry/,
      /^Nov 16/,
    ]);
    await expect(list.getByRole("textbox")).toHaveCount(0);
    const back = card.getByRole("button", { name: "Show only this message" });
    await expect(back).toBeFocused();
    await back.click();
    await expect(list).toBeHidden();
    await expect(card).toHaveAttribute("open", "");
  });

  test("with only part of the task's history loaded, the exchange is not called every message, and says what may be missing", async ({
    page,
  }) => {
    await openFixture(page, "scene=messaged-replied", "light");
    const key = "agent:otto:transcode-cache";
    for (const partial of [{ hasMore: true }, { runsOmitted: 2 }]) {
      await page.evaluate(
        ({ key, partial }) => {
          const fixture = (
            window as unknown as {
              clawtrateFixture: {
                setState(change: (s: { transcripts: Record<string, object> }) => unknown): void;
              };
            }
          ).clawtrateFixture;
          fixture.setState((s) => ({
            ...s,
            transcripts: {
              ...s.transcripts,
              [key]: { ...s.transcripts[key], hasMore: false, runsOmitted: 0, ...partial },
            },
          }));
        },
        { key, partial },
      );
      const card = page.getByTestId("messaged-card").last();
      if ((await card.getAttribute("open")) === null) await card.locator("summary").click();
      const toggle = card.getByRole("button", {
        name: "Show every message between Otto and Marlow in this task that is loaded here",
        exact: true,
      });
      await expect(toggle).toHaveText("Show the loaded exchange");
      await toggle.click();
      await expect(
        card.getByRole("list", { name: "Every message between Otto and Marlow in this task" }),
      ).toHaveCount(0);
      const list = card.getByRole("list", {
        name: "Messages between Otto and Marlow in the part of this task loaded here",
        exact: true,
      });
      await expect(list.locator(".exchange-text")).toHaveCount(4);
      await expect(card.getByTestId("exchange-partial")).toHaveText(
        "Only part of this task's history is loaded here, so earlier messages between Otto and Marlow may be missing.",
      );
      await card.getByRole("button", { name: "Show only this message" }).click();
      await expect(card.getByTestId("exchange-partial")).toHaveCount(0);
    }
  });

  test("F-434 F-469: a recipient's stop, wait and finish read on the sender's card as the recipient's run established them", async ({
    page,
  }) => {
    const word = async (scene: string) => {
      await openFixture(page, `scene=${scene}`, "light");
      return page.getByTestId("messaged-card").last().locator("summary .state").textContent();
    };
    expect(await word("messaged-recipient-stopped")).toBe("Recipient stopped");
    expect(await word("messaged-recipient-waiting")).toBe("Recipient waiting");
    expect(await word("messaged-no-reply")).toBe("No reply yet");
    expect(await word("messaged-recipient-failed")).toBe("Recipient failed");
  });

  test("F-125 F-469: the receiving task starts with a Message from card: the sender, the first line and the run's own state", async ({
    page,
  }) => {
    const states: Record<string, string> = {
      "received-working": "Working",
      "received-waiting": "Waiting for you",
      "received-completed": "Completed",
      "received-failed": "Failed",
      "received-stopped": "Stopped",
    };
    for (const [scene, state] of Object.entries(states)) {
      await openFixture(page, `scene=${scene}`, "light");
      const line = page.getByTestId("received-card").locator("summary");
      await expect(line.locator(".messaged-verb")).toHaveText("Message from");
      await expect(line.locator(".messaged-who")).toHaveText("Otto");
      await expect(line.locator(".messaged-first")).toHaveText(/^Write a two-line entry/);
      await expect(line.locator(".state"), scene).toHaveText(state);
    }
    await page.getByTestId("received-card").locator("summary").click();
    await expect(
      page.getByTestId("received-card").getByText("This run was stopped before it replied."),
    ).toBeVisible();
  });

  test("F-120: a reply no identifier ties to a card arrives as a Message from line that opens to the message and its Raw", async ({
    page,
  }) => {
    await openFixture(page, "scene=incoming-line", "light");
    const line = page.getByTestId("incoming-line");
    await expect(line.locator("summary")).toHaveText("Message from Marlow");
    await line.locator("summary").click();
    await expect(line.locator(".exchange-text")).toHaveText(/^Nov 16/);
    await expect(line.getByRole("button", { name: "Raw" })).toBeVisible();
  });

  test("F-122 F-134: while the connection is lost a Working card reads Last seen working, and with reduced motion nothing on a card moves", async ({
    page,
  }) => {
    await openFixture(page, "scene=messaged-last-seen", "light");
    const state = page.getByTestId("messaged-card").locator("summary .state");
    await expect(state).toHaveText("Last seen working");
    await expect(state.locator(".glyph")).toHaveCSS("animation-name", "none");
    for (const scene of ["messaged-working", "t3-started", "messaged-approval"]) {
      await page.goto(`/?scene=${scene}&theme=light&motion=reduce`);
      await page.locator(".app").waitFor();
      const glyph = page.locator(".card summary .state .glyph").first();
      const pseudo = await glyph.evaluate(
        (element) => getComputedStyle(element, "::before").animationName,
      );
      expect(pseudo, scene).toBe("none");
    }
  });
});

/** The part of the fixture's state the transition check changes. */
type FixtureStep = {
  toolName: string;
  toolCallId: string;
  argsText?: { text: string } | null;
  raw: Record<string, unknown> | null;
};
type FixtureState = {
  transcripts: Record<
    string,
    { items: unknown[]; runs: Array<{ steps: FixtureStep[] }>; mcpTools: unknown }
  >;
};
const TASK = "agent:otto:transcode-cache";

/**
 * The call as history holds it before its result: an ordinary tool step, with
 * text after it. `map` keeps the gateway's map of tool names, or clears it.
 */
async function historyStep(page: Page, map: boolean): Promise<void> {
  await page.evaluate(
    ({ key, map }) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState(change: (s: FixtureState) => unknown): void };
        }
      ).clawtrateFixture;
      fixture.setState((s) => {
        const t = s.transcripts[key]!;
        const step = t.runs[0]!.steps[0]!;
        const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of what came after.`);
        return {
          ...s,
          transcripts: {
            ...s.transcripts,
            [key]: {
              ...t,
              mcpTools: map ? t.mcpTools : {},
              items: [
                ...t.items,
                {
                  id: "after-call",
                  role: "assistant",
                  timestamp: Date.now(),
                  blocks: [
                    {
                      kind: "tool-call",
                      callId: step.toolCallId,
                      name: step.toolName,
                      argumentsText: step.argsText?.text ?? "{}",
                      result: null,
                    },
                    { kind: "text", text: lines.join("\n\n") },
                  ],
                },
              ],
            },
          },
        };
      });
    },
    { key: TASK, map },
  );
}

/** The call's result arrives, naming `tool` as its own. */
async function resultNaming(page: Page, tool: string): Promise<void> {
  await page.evaluate(
    ({ key, tool }) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState(change: (s: FixtureState) => unknown): void };
        }
      ).clawtrateFixture;
      fixture.setState((s) => {
        const t = s.transcripts[key]!;
        const details = { mcpServer: "t3code", mcpTool: tool };
        return {
          ...s,
          transcripts: {
            ...s.transcripts,
            [key]: {
              ...t,
              runs: t.runs.map((run) => ({
                ...run,
                steps: run.steps.map((x) => ({
                  ...x,
                  status: "done",
                  endedAt: Date.now(),
                  result: { text: "Started thread", totalChars: 14 },
                  raw: {
                    ...x.raw,
                    result: {
                      phase: "result",
                      name: x.toolName,
                      toolCallId: x.toolCallId,
                      isError: false,
                      result: { content: [{ type: "text", text: "Started thread" }], details },
                    },
                  },
                })),
              })),
            },
          },
        };
      });
    },
    { key: TASK, tool },
  );
}

/** Put a line at the reading line, just under the protected band at the top. */
async function toReadingLine(line: Locator): Promise<void> {
  await line.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-testid="transcript"]')!;
    const band = Number.parseFloat(getComputedStyle(scroller.firstElementChild!).paddingTop) || 0;
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - band;
    scroller.dispatchEvent(new Event("scroll"));
  });
}

test.describe("Messaged T3 Code cards", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-134: when a step becomes the T3 Code card, the reading line holds, and the card is open, with Raw, and focused as the step was", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 640 });
    await openFixture(page, "scene=t3-approval", "light");
    // No map from the gateway: the call is an ordinary step until its result names it.
    await historyStep(page, false);
    const step = page.getByTestId("tool-call");
    await step.locator("summary").click();
    await expect(step).toHaveAttribute("open", "");
    // The card below, open; the reader at a marked line: the approval's title at the reading line.
    const approval = page.getByTestId("approval-card");
    await approval.getByText("Show full request").click();
    const marked = approval.locator(".request-title");
    await toReadingLine(marked);
    // Focus back in the step, as a reader reading it would leave it.
    await step
      .locator("summary")
      .evaluate((summary: HTMLElement) => summary.focus({ preventScroll: true }));
    await settle(page);
    const before = (await marked.boundingBox())!.y;
    await expect(page.getByTestId("t3-card")).toHaveCount(0);

    await resultNaming(page, "t3_thread_launch");
    const card = page.getByTestId("t3-card");
    await expect(card).toHaveCount(1);
    await settle(page);
    // The reading line did not move, and the card below stayed open.
    expect(Math.abs((await marked.boundingBox())!.y - before)).toBeLessThanOrEqual(1);
    await expect(approval.locator(".request-full")).toHaveAttribute("open", "");
    // The step is now the card: open as the step was, its Raw open, focus on it.
    await expect(step).toHaveCount(0);
    await expect(card).toHaveAttribute("open", "");
    await expect(card.getByRole("region", { name: "What the gateway sent" })).toBeVisible();
    await expect(card.locator("summary")).toBeFocused();
  });

  test("F-132 F-134: a card the gateway's map made, whose result names another tool, becomes the ordinary step again: the reading line holds, open and focused as the card was", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 640 });
    await openFixture(page, "scene=t3-approval", "light");
    // The gateway's map names T3 Code's tool: the card from the call's start, the step not drawn.
    await historyStep(page, true);
    const card = page.getByTestId("t3-card");
    await expect(card).toHaveCount(1);
    await expect(card.locator("summary .state")).toHaveText("Waiting for approval");
    await expect(page.getByTestId("tool-call")).toHaveCount(0);
    await card.locator("summary").click();
    await expect(card).toHaveAttribute("open", "");
    const approval = page.getByTestId("approval-card");
    await approval.getByText("Show full request").click();
    const marked = approval.locator(".request-title");
    await toReadingLine(marked);
    await card
      .locator("summary")
      .evaluate((summary: HTMLElement) => summary.focus({ preventScroll: true }));
    await settle(page);
    const before = (await marked.boundingBox())!.y;

    // The result names another tool: the map named the wrong one.
    await resultNaming(page, "t3_project_list_v2");
    await expect(card).toHaveCount(0);
    await settle(page);
    expect(Math.abs((await marked.boundingBox())!.y - before)).toBeLessThanOrEqual(1);
    await expect(approval.locator(".request-full")).toHaveAttribute("open", "");
    // The ordinary action card again, in its run's column, open and focused as the card was.
    const step = page.getByTestId("tool-call");
    await expect(step).toHaveCount(1);
    await expect(step).toHaveAttribute("open", "");
    await expect(step.locator("summary")).toBeFocused();
  });

  test("F-132 F-134: a T3 Code card read on Raw, with focus on Copy arguments, becomes the ordinary action on its Raw tab with focus on its Copy arguments", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-approval", "light");
    await historyStep(page, true);
    const card = page.getByTestId("t3-card");
    await card.locator("summary").click();
    await card.getByRole("button", { name: "Raw" }).click();
    const copy = card.getByRole("button", { name: "Copy arguments" });
    await copy.focus();
    await expect(copy).toBeFocused();
    await resultNaming(page, "t3_project_list_v2");
    await expect(card).toHaveCount(0);
    const step = page.getByTestId("tool-call");
    await expect(step).toHaveAttribute("open", "");
    await expect(step.getByRole("tab", { name: "Raw" })).toHaveAttribute("aria-selected", "true");
    await expect(step.getByRole("button", { name: "Copy arguments" })).toBeFocused();
  });

  test("a closed step or card that has focus hands focus over as it is replaced, and stays closed", async ({
    page,
  }) => {
    // Step to card: the call's action card closed, focus on its line.
    await openFixture(page, "scene=t3-approval", "light");
    await historyStep(page, false);
    const step = page.getByTestId("tool-call");
    await step
      .locator("summary")
      .evaluate((summary: HTMLElement) => summary.focus({ preventScroll: true }));
    await expect(step).not.toHaveAttribute("open", "");
    await resultNaming(page, "t3_thread_launch");
    const card = page.getByTestId("t3-card");
    await expect(card).toHaveCount(1);
    await expect(card).not.toHaveAttribute("open", "");
    await expect(card.locator("summary")).toBeFocused();

    // Card to step: the card the map made, closed, focus on its line.
    await openFixture(page, "scene=t3-approval", "light");
    await historyStep(page, true);
    await expect(card).toHaveCount(1);
    await card
      .locator("summary")
      .evaluate((summary: HTMLElement) => summary.focus({ preventScroll: true }));
    await expect(card).not.toHaveAttribute("open", "");
    await resultNaming(page, "t3_project_list_v2");
    await expect(card).toHaveCount(0);
    await expect(step).toHaveCount(1);
    await expect(step).not.toHaveAttribute("open", "");
    await expect(step.locator("summary")).toBeFocused();
  });

  test("F-132: without the gateway's map a call is an ordinary step until its result names it; with it, the card from its start", async ({
    page,
  }) => {
    for (const scene of ["t3-started", "t3-approval", "t3-delivery-unknown", "t3-not-sent"]) {
      await openFixture(page, `scene=${scene}`, "light");
      await expect(page.getByTestId("t3-card"), scene).toHaveCount(1);
      await historyStep(page, false);
      await expect(page.getByTestId("t3-card"), scene).toHaveCount(0);
    }
    await openFixture(page, "scene=t3-call-made", "light");
    await expect(page.getByTestId("t3-card")).toHaveCount(1);
  });

  test("F-132: the folded card shows Clawtrate's own mark, the label T3 Code, the first line sent and the state", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-call-made", "light");
    const line = page.getByTestId("t3-card").locator("summary");
    await expect(line.locator(".messaged-verb")).toHaveText("Messaged");
    await expect(line.locator(".messaged-who")).toHaveText("T3 Code");
    await expect(line.locator(".agent-mark svg")).toBeVisible();
    await expect(line.locator("img")).toHaveCount(0);
    await expect(line.locator(".messaged-first")).toHaveText(
      /^In backup-scripts, make the weekly check/,
    );
    await expect(line.locator(".state")).toHaveText("Call made");
  });

  test("F-133 F-135: open, it shows the text sent and its target fields, the result with its time, its files, and Open thread as a link", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-call-made", "light");
    const card = page.getByTestId("t3-card");
    await card.locator("summary").click();
    await expect(card.locator(".exchange-item").first().locator(".exchange-text")).toHaveText(
      /^In backup-scripts/,
    );
    await expect(card.locator(".exchange-item").first().locator(".chip")).toHaveText([
      "Project backup-scripts",
      "Branch main",
    ]);
    await expect(card.locator(".exchange-item").nth(1).locator(".exchange-meta")).toHaveText(
      /^T3 Code· the call returned\d+:\d\d [AP]M$/,
    );
    await expect(
      card.getByText("This shows the call was made. It does not show that the work is finished."),
    ).toBeVisible();
    await expect(card.locator(".messaged-body > .chips .chip")).toHaveText(["plan.md"]);
    const link = card.getByRole("link", { name: "Open the T3 Code thread in your browser" });
    await expect(link).toHaveAttribute(
      "href",
      "https://t3.example.test/projects/backup-scripts/threads/18",
    );
    await openFixture(page, "scene=t3-failed", "light");
    await page.getByTestId("t3-card").locator("summary").click();
    await expect(page.getByTestId("t3-card").getByRole("link")).toHaveCount(0);
  });

  test("F-134 F-314 F-470: each state is what the call's events establish, before its result by the gateway's map", async ({
    page,
  }) => {
    const states: Record<string, string> = {
      "t3-started": "Call started",
      "t3-approval": "Waiting for approval",
      "t3-delivery-unknown": "Delivery unknown",
      "t3-not-sent": "Not sent",
      "t3-call-made": "Call made",
      "t3-failed": "Failed",
    };
    for (const [scene, state] of Object.entries(states)) {
      await openFixture(page, `scene=${scene}`, "light");
      await expect(page.getByTestId("t3-card").locator("summary .state"), scene).toHaveText(state);
    }
    await page.getByTestId("t3-card").locator("summary").click();
    await expect(page.getByTestId("t3-card").getByText("The call failed.")).toBeVisible();
    await expect(page.getByTestId("t3-card").locator("pre[data-tone=danger]")).toContainText(
      "ECONNREFUSED",
    );
  });

  test("F-137: after a stop, a call that returned keeps Call made and says work may continue", async ({
    page,
  }) => {
    await openFixture(page, "scene=t3-work-may-continue", "light");
    const card = page.getByTestId("t3-card");
    await expect(card.locator("summary .state")).toHaveText("Call made");
    await card.locator("summary").click();
    await expect(
      card.getByText("The call was made. Work handed to T3 Code may continue there."),
    ).toHaveCSS("font-weight", "500");
  });

  test("F-138: nothing goes to T3 Code: not on first render, updates, opening, Raw, a stop or a reconnect; the link opens only when chosen; no address is kept", async ({
    page,
    context,
  }) => {
    const outbound: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith("http://127.0.0.1:") && !url.startsWith("data:")) outbound.push(url);
    });
    page.on("websocket", (socket) => outbound.push(socket.url()));
    await context.route("https://t3.example.test/**", (route) => route.abort());
    await openFixture(page, "scene=t3-started", "light");
    const card = page.getByTestId("t3-card");
    // Later gateway updates: the call returns, the bot is stopped, the connection drops and returns.
    for (const scene of ["t3-call-made", "t3-work-may-continue"]) {
      await openFixture(page, `scene=${scene}`, "light");
    }
    await card.locator("summary").click();
    await card.getByRole("button", { name: "Raw" }).click();
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: {
            setState(change: (state: { connection: object }) => object): void;
          };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, status: "reconnecting" },
      }));
      fixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, status: "connected" },
      }));
    });
    await settle(page);
    expect(outbound).toEqual([]);
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(stored).not.toContain("t3.example.test");
    const chosen = context.waitForEvent("request", (request) =>
      request.url().startsWith("https://t3.example.test/"),
    );
    await card.getByRole("link", { name: "Open the T3 Code thread in your browser" }).click();
    expect((await chosen).url()).toBe("https://t3.example.test/projects/backup-scripts/threads/18");
  });
});
