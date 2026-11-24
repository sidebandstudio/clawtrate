// A run's line sits under that run's last message, above the time divider that
// introduces a later message (#466). The fixture's run is followed, three hours
// later, by a new message of the person's, as the gateway's history would hold it.
import { test, type Page } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/index.ts";
import { contextFor, expect, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";

/** Change Otto's open task, as the host's next snapshot would. */
async function changeTask(page: Page, change: string) {
  await page.evaluate((source) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture;
    const apply = new Function("t", source) as (t: unknown) => unknown;
    fixture.setState((state) => {
      const t = state.transcripts["agent:otto:disk-space"]!;
      return {
        ...state,
        transcripts: { ...state.transcripts, ["agent:otto:disk-space"]: apply(t) as typeof t },
      };
    });
  }, change);
}

/** A new message of the person's, three hours after the last item. */
const later = `
  const last = t.items.at(-1);
  const items = [...t.items, { id: "later", role: "user", timestamp: last.timestamp + 3 * 3600 * 1000,
    blocks: [{ kind: "text", text: "Anything new since then?" }], model: null }];`;

/** Where the line sits against the divider and the message after it, in the transcript's order. */
const order = (page: Page) =>
  page.getByTestId("transcript").evaluate((transcript) => {
    const line = [...transcript.querySelectorAll('[data-testid="run-line"]')].at(-1)!;
    const stamp = [...transcript.querySelectorAll(".stamp")].at(-1)!;
    const message = [...transcript.querySelectorAll("p")].find(
      (p) => p.textContent === "Anything new since then?",
    )!;
    const before = (a: Node, b: Node) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      line: line.textContent,
      lineAboveDivider: before(line, stamp),
      dividerAboveMessage: before(stamp, message),
    };
  });

test.describe("a run's line and the next message's time (#466)", () => {
  test.use(contextFor(SIZES[0]!));

  for (const [name, runs, extra] of [
    ["a finished run", "t.runs", ""],
    ["a finished run, with commands shown", "t.runs", "&commands=show"],
    ["a stopped run", `t.runs.map((r) => ({ ...r, state: "stopped" }))`, ""],
    ["history that names no run", "[]", ""],
  ] as const)
    test(`F-090 F-530: the line of ${name} stays above the divider of a message hours later`, async ({
      page,
    }) => {
      await openFixture(page, `scene=actions-short&${OTTO_DISK}&panel=closed${extra}`);
      await expect(page.getByTestId("run-line").last()).toBeVisible();
      await changeTask(page, `${later} return { ...t, items, runs: ${runs} };`);
      await expect(page.getByText("Anything new since then?")).toBeVisible();
      expect(await order(page)).toMatchObject({
        lineAboveDivider: true,
        dividerAboveMessage: true,
      });
    });
});
