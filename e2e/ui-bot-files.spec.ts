// A file a bot attaches that isn't a picture, in the conversation (F-115), on
// this run's own development gateway. The scripted bot writes a PDF and a text
// note and ends its answer with a `MEDIA:` line for each (`#attach`). The
// gateway stages both and gives the reply an `attachment` block for each in its
// history. The rows show as soon as the reply arrives, Save gives exactly the
// PDF's bytes under its name, and the rows are still there when the task is
// opened again.
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { ATTACH_TEXT, reviewsDraftPdf } from "../tools/dev-gateway/src/scripted-files.ts";
import { approveDevice } from "./approve.ts";
import { listInstances } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;

async function openclaw(args: string[]): Promise<string> {
  const result = await openInstance(INSTANCE).runner.run(args);
  if (result.status !== 0) {
    throw new Error(`openclaw ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

const gatewayCall = async <T>(method: string, params: unknown): Promise<T> =>
  parseJsonOutput<T>(
    await openclaw(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]),
  );

async function openShell(page: Page) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!);
  const connect = page.getByRole("button", { name: "Use the development gateway" });
  const bots = page.getByTestId("bot");
  await expect
    .poll(async () => (await connect.isVisible()) || (await bots.count()) === 4, {
      timeout: 20_000,
    })
    .toBe(true);
  if (await connect.isVisible()) {
    await connect.click();
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
    await approveDevice(INSTANCE);
  }
  await expect(bots).toHaveCount(4, { timeout: 20_000 });
}

async function openTask(page: Page, bot: string, task: string) {
  const back = page.getByRole("button", { name: "Back to bots" });
  if (await back.isVisible()) await back.click();
  const row = page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${bot}\\b`) });
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  const list = page.getByRole("list", { name: `${bot}'s tasks` });
  const all = list.getByRole("button", { name: /^Show all/ });
  if (await all.isVisible()) await all.click();
  await list.getByTestId("task").filter({ hasText: task }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${bot}, ${task}\\.`) })).toBeVisible();
}

// A task of each run's own, so a repeated or retried run never meets an earlier one's messages.
const RUN = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
const TASK = `Files from the end-to-end run ${RUN}`;
const KEY = `agent:pip:e2e-attach-${RUN}`;

test("F-115: a PDF the bot attaches shows under its message as it arrives, Save gives its exact bytes, and it is still there when the task is opened again", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gatewayCall("sessions.create", { key: KEY, agentId: "pip", label: TASK });
  const gatewayPort = String(listInstances().find((row) => row.name === INSTANCE)!.gatewayPort);
  const toGateway: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).port === gatewayPort) toGateway.push(request.url());
  });
  await openShell(page);
  await openTask(page, "Pip", TASK);

  // Sent as a person's message from another client while the task is open here.
  await gatewayCall("chat.send", {
    sessionKey: KEY,
    message: "#attach",
    idempotencyKey: `e2e-attach-${RUN}`,
  });
  const turn = page.getByTestId("transcript-turn").filter({ hasText: ATTACH_TEXT });
  const pdf = turn.getByTestId("bot-file").filter({ hasText: "reviews-draft.pdf" });
  await expect(pdf).toBeVisible({ timeout: 60_000 });
  await expect(pdf).toContainText("1 KB · application/pdf");
  await expect(turn.getByTestId("bot-file").locator(".bot-file-name")).toHaveText([
    "reviews-draft.pdf",
    "reviews.txt",
  ]);
  // The MEDIA: lines are not in the text.
  await expect(turn).not.toContainText("MEDIA:");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    pdf.getByRole("button", { name: "Save reviews-draft.pdf" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("reviews-draft.pdf");
  expect(readFileSync((await download.path())!, "latin1")).toBe(reviewsDraftPdf());
  await expect(pdf.getByRole("status")).toHaveText("Handed to your browser's downloads.");
  // The page itself asks the gateway for nothing: the host read the file.
  expect(toGateway).toEqual([]);

  // Opened again in a new page: the rows come from the gateway's history.
  await page.reload();
  await openShell(page);
  await openTask(page, "Pip", TASK);
  await expect(
    page
      .getByTestId("transcript-turn")
      .filter({ hasText: ATTACH_TEXT })
      .getByTestId("bot-file")
      .locator(".bot-file-name"),
  ).toHaveText(["reviews-draft.pdf", "reviews.txt"], { timeout: 30_000 });

  // Dark is the default; light and the phone width show it too, within the screen.
  const again = page
    .getByTestId("transcript-turn")
    .filter({ hasText: ATTACH_TEXT })
    .getByTestId("bot-file")
    .first();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(again).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await again.scrollIntoViewIfNeeded();
  const box = (await again.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.emulateMedia({ colorScheme: null });
});
