// #637: a system event the gateway woke a task with, in the mounted conversation, fed to the
// fixture as the host's next snapshot would bring it. On a gateway that writes the event as its
// own row (OpenClaw 2026.11.10) the row is the gateway's quiet line, its text one step away, at
// 1440 and phone width in both themes; the bot's answer after it is the bot's. The row has the
// fields a development instance of 2026.11.10 returned; every name and text is invented.
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

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
/** Otto's task the fixture opens. */
const KEY = "agent:otto:disk-space";
const EPOCH = NOW.getTime() - 120_000;
const EVENT =
  "Exec completed (5e1f9a3b, code 0, 41s):\nremoved 1,204 cache files\nfreed 12.4 GB in /var/cache/builds";

const rows = [
  {
    role: "user",
    timestamp: EPOCH,
    content: "Clear the build cache in the background and tell me when it's done.",
    __openclaw: { id: "ask-1" },
  },
  {
    role: "assistant",
    timestamp: EPOCH + 2_000,
    content: [{ type: "text", text: "Started. I'll tell you when it finishes." }],
    api: "openai-completions",
    provider: "scripted",
    model: "dev-1",
    __openclaw: { id: "reply-1", runId: "run-1" },
  },
  // The event as `chat.history` returns it on 2026.11.10.
  {
    role: "user",
    timestamp: EPOCH + 60_000,
    content: EVENT,
    idempotencyKey: "event-key-1",
    provenance: { kind: "internal_system", sourceTool: "exec" },
    __openclaw: {
      senderIsOwner: false,
      transport: { channel: "webchat", messageId: "event-key-1" },
      id: "event-1",
      idempotencyKey: "event-key-1",
      seq: 3,
    },
  },
  {
    role: "assistant",
    timestamp: EPOCH + 62_000,
    content: [{ type: "text", text: "The cache is clear: 12.4 GB freed." }],
    api: "openai-completions",
    provider: "scripted",
    model: "dev-1",
    __openclaw: { id: "reply-2", runId: "run-2" },
  },
];

type Fixture = {
  clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
};

/** Otto's task's history as the host's next snapshot would have it. */
async function woken(page: Page) {
  await page.evaluate(
    ({ items, key }) => {
      (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
        ...state,
        transcripts: {
          ...state.transcripts,
          [key]: { ...state.transcripts[key]!, items, live: null, runs: [], outbox: [] },
        },
      }));
    },
    { items: mapHistory(rows, { gatewayEvents: true }), key: KEY },
  );
  await settle(page);
}

const line = (page: Page) => page.getByTestId("gateway-event");

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`gateway event ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("#637: a woken task's system event is the gateway's quiet line with its text one step away, never the person's bubble, and matches its baselines", async ({
        page,
      }) => {
        await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, theme);
        await woken(page);
        await expect(line(page)).toBeVisible();
        await expect(
          page.getByTestId("transcript").locator(".msg").filter({ hasText: "5e1f9a3b" }),
        ).toHaveCount(0);
        await settle(page);
        await expect(page).toHaveScreenshot(`gateway-event-${theme}-${size.name}.png`);
        await line(page).getByText("Event text").click();
        await expect(line(page).getByText(/^Exec completed \(5e1f9a3b/)).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`gateway-event-open-${theme}-${size.name}.png`);
      });
    });
  }
}
