// Every state of every card (conversation.md sections 10 to 13) matches its
// approved baseline in light and dark, at desktop width and at phone width.
// Each scene is built from the engine's own state (apps/desktop/src/fixture/cards.ts).
import { expect, test, type Locator, type Page } from "@playwright/test";
import { contextFor, openFixture, settle, SIZES, THEMES } from "./fixture.ts";

const CARD =
  '[data-testid="approval-card"], [data-testid="question-card"], [data-testid="messaged-card"], ' +
  '[data-testid="t3-card"], [data-testid="received-card"], [data-testid="incoming-line"]';

type Shot = {
  name: string;
  scene: string;
  rows: string;
  /** What to do before the picture; by default a card that folds is opened. */
  prepare?: (page: Page, card: Locator) => Promise<void>;
  /** Which card, when the scene has several. */
  pick?: (page: Page) => Locator;
};

const open = async (_page: Page, card: Locator) => {
  await card.evaluate((element) => {
    if (element instanceof HTMLDetailsElement) element.open = true;
  });
};

const APPROVAL = "F-163 F-164 F-170 F-171 F-329";
const RESOLVED = "F-165 F-168 F-169 F-325";
const QUESTION = "F-112 F-113 F-114 F-302 F-303";
const MESSAGED = "F-119 F-121 F-122 F-123 F-434 F-469";
const T3 = "F-132 F-133 F-134 F-135 F-137 F-314 F-470";

const SHOTS: Shot[] = [
  { name: "approval-pending", scene: "approval-pending", rows: APPROVAL },
  {
    name: "approval-full-request",
    scene: "approval-pending",
    rows: "F-164",
    prepare: async (_page, card) => {
      await card.getByText("Show full request").click();
    },
  },
  {
    name: "approval-form",
    scene: "approval-pending",
    rows: "F-167 F-155",
    prepare: async (_page, card) => {
      await card.getByRole("button", { name: "Always allow…" }).click();
    },
  },
  {
    name: "approval-routine-form",
    scene: "approval-routine",
    rows: "F-167",
    prepare: async (_page, card) => {
      await card.getByRole("button", { name: "Always allow…" }).click();
    },
  },
  {
    name: "approval-raw",
    scene: "approval-pending",
    rows: "F-163",
    prepare: async (_page, card) => {
      await card.getByRole("button", { name: "Raw" }).click();
    },
  },
  { name: "approval-allow-only", scene: "approval-allow-only", rows: "F-329" },
  { name: "approval-sending", scene: "approval-sending", rows: APPROVAL },
  { name: "approval-refused", scene: "approval-refused", rows: APPROVAL },
  { name: "approval-unknown", scene: "approval-unknown", rows: APPROVAL },
  { name: "approval-cut", scene: "approval-cut", rows: APPROVAL },
  {
    name: "approval-cut-read",
    scene: "approval-cut",
    rows: APPROVAL,
    prepare: async (_page, card) => {
      await card.getByRole("button", { name: "Read the whole request" }).click();
      await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
    },
  },
  { name: "approval-run-ended", scene: "approval-run-ended", rows: "F-418" },
  { name: "approval-helper", scene: "approval-helper", rows: APPROVAL },
  { name: "approval-messaged", scene: "approval-messaged", rows: APPROVAL },
  { name: "approval-readonly", scene: "approval-readonly", rows: APPROVAL },
  { name: "approval-plugin", scene: "approval-plugin", rows: APPROVAL },
  { name: "approval-allowed-once", scene: "approval-allowed-once", rows: RESOLVED },
  { name: "approval-always-allowlist", scene: "approval-always-allowlist", rows: "F-167" },
  { name: "approval-always-routine", scene: "approval-always-routine", rows: "F-167" },
  { name: "approval-denied", scene: "approval-denied", rows: RESOLVED },
  { name: "approval-expired", scene: "approval-expired", rows: RESOLVED },
  { name: "approval-cancelled", scene: "approval-cancelled", rows: RESOLVED },
  { name: "approval-closed-ended", scene: "approval-closed-ended", rows: "F-418" },
  { name: "approval-closed-failed", scene: "approval-closed-failed", rows: RESOLVED },
  { name: "approval-closed-unknown", scene: "approval-closed-unknown", rows: RESOLVED },
  { name: "approval-winner", scene: "approval-winner", rows: RESOLVED },
  { name: "question-single", scene: "question-single", rows: QUESTION },
  { name: "question-multi", scene: "question-multi", rows: "F-114" },
  { name: "question-three", scene: "question-three", rows: QUESTION },
  { name: "question-unanswerable", scene: "question-unanswerable", rows: "F-112" },
  { name: "question-readonly", scene: "question-readonly", rows: "F-112" },
  { name: "question-answered", scene: "question-answered", rows: "F-113" },
  { name: "question-answered-typed", scene: "question-answered-typed", rows: "F-303" },
  { name: "question-answered-multi", scene: "question-answered-multi", rows: "F-114" },
  { name: "question-dismissed", scene: "question-dismissed", rows: "F-302" },
  { name: "question-expired", scene: "question-expired", rows: "F-302" },
  { name: "question-cancelled", scene: "question-cancelled", rows: "F-302" },
  { name: "question-closed-ended", scene: "question-closed-ended", rows: "F-302" },
  { name: "question-closed-failed", scene: "question-closed-failed", rows: "F-302" },
  {
    name: "messaged-folded",
    scene: "messaged-working",
    rows: "F-119 F-122",
    prepare: async () => undefined,
  },
  { name: "messaged-started", scene: "messaged-started", rows: MESSAGED },
  { name: "messaged-approval", scene: "messaged-approval", rows: MESSAGED },
  { name: "messaged-sent", scene: "messaged-sent", rows: MESSAGED },
  { name: "messaged-working", scene: "messaged-working", rows: MESSAGED },
  { name: "messaged-recipient-waiting", scene: "messaged-recipient-waiting", rows: MESSAGED },
  { name: "messaged-no-reply", scene: "messaged-no-reply", rows: MESSAGED },
  { name: "messaged-no-reply-timeout", scene: "messaged-no-reply-timeout", rows: MESSAGED },
  { name: "messaged-replied", scene: "messaged-replied", rows: MESSAGED },
  {
    name: "messaged-full-exchange",
    scene: "messaged-replied",
    rows: "F-308",
    prepare: async (_page, card) => {
      await open(_page, card);
      await card.getByRole("button", { name: /Show every message between/ }).click();
    },
  },
  {
    name: "messaged-raw",
    scene: "messaged-replied",
    rows: MESSAGED,
    prepare: async (_page, card) => {
      await open(_page, card);
      await card.getByRole("button", { name: "Raw" }).click();
    },
  },
  { name: "messaged-recipient-stopped", scene: "messaged-recipient-stopped", rows: "F-434" },
  { name: "messaged-recipient-failed", scene: "messaged-recipient-failed", rows: MESSAGED },
  { name: "messaged-failed", scene: "messaged-failed", rows: MESSAGED },
  { name: "messaged-blocked", scene: "messaged-blocked", rows: MESSAGED },
  { name: "messaged-not-sent", scene: "messaged-not-sent", rows: MESSAGED },
  { name: "messaged-unknown", scene: "messaged-unknown", rows: MESSAGED },
  { name: "messaged-last-seen", scene: "messaged-last-seen", rows: MESSAGED },
  { name: "received-working", scene: "received-working", rows: "F-125" },
  { name: "received-waiting", scene: "received-waiting", rows: "F-125 F-469" },
  { name: "received-completed", scene: "received-completed", rows: "F-125 F-469" },
  { name: "received-failed", scene: "received-failed", rows: "F-125" },
  { name: "received-stopped", scene: "received-stopped", rows: "F-125" },
  { name: "incoming-line", scene: "incoming-line", rows: "F-120" },
  {
    name: "t3-folded",
    scene: "t3-call-made",
    rows: "F-132",
    prepare: async () => undefined,
  },
  { name: "t3-started", scene: "t3-started", rows: T3 },
  { name: "t3-approval", scene: "t3-approval", rows: T3 },
  { name: "t3-call-made", scene: "t3-call-made", rows: T3 },
  {
    name: "t3-raw",
    scene: "t3-call-made",
    rows: T3,
    prepare: async (_page, card) => {
      await open(_page, card);
      await card.getByRole("button", { name: "Raw" }).click();
    },
  },
  { name: "t3-work-may-continue", scene: "t3-work-may-continue", rows: "F-137" },
  { name: "t3-delivery-unknown", scene: "t3-delivery-unknown", rows: "F-470" },
  { name: "t3-failed", scene: "t3-failed", rows: "F-314" },
  { name: "t3-not-sent", scene: "t3-not-sent", rows: T3 },
];

/** The card a scene is about: the one its name begins with. */
function testIdOf(scene: string): string {
  const prefix = scene.split("-")[0];
  return prefix === "incoming"
    ? "incoming-line"
    : prefix === "t3"
      ? "t3-card"
      : `${prefix === "messaged" ? "messaged" : prefix}-card`;
}

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`cards ${size.name} ${theme}`, () => {
      // The same widths, made tall, so the tallest card fits whole inside the transcript.
      test.use({ ...contextFor(size, theme), viewport: { width: size.width, height: 2400 } });
      for (const shot of SHOTS) {
        test(`${shot.rows}: ${shot.name} matches its baseline`, async ({ page }) => {
          await openFixture(page, `scene=${shot.scene}`, theme);
          const cards = page.locator(CARD);
          await expect(cards.first()).toBeVisible();
          const card = shot.pick ? shot.pick(page) : page.getByTestId(testIdOf(shot.scene)).last();
          await (shot.prepare ?? open)(page, card);
          await settle(page);
          await page.mouse.move(0, 0);
          // The card alone: the controls that float over the transcript's top are not part of it.
          await expect(card).toHaveScreenshot(`card-${shot.name}-${theme}-${size.name}.png`, {
            style: ".conversation-header, .status-strip { visibility: hidden !important; }",
          });
        });
      }
    });
  }
}
