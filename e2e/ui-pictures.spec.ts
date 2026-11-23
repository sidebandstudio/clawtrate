// A picture a bot makes with image_generate, in the conversation (F-535), on
// this run's own development gateway, started with the stand-in image provider
// (`--with-images`). The bot's run asks for the picture, the gateway delivers
// it in a turn of its own, and the page draws the bytes the host fetched
// through the download the gateway issued. The file runs after
// preview.spec.ts, whose checks read Otto's task list as the seed left it.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { solidPng } from "../packages/core/test/sent-attachments-rows.ts";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { IMAGE_PROMPT } from "../tools/dev-gateway/src/scenarios.ts";
import { scriptedPicture } from "../tools/dev-gateway/src/scripted-images.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";

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
    devGateway(INSTANCE, "approve");
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

test.describe.configure({ mode: "serial" });

const TASK = "A picture from the end-to-end run";
const ALT = `Picture made from the description: ${IMAGE_PROMPT}`;

test("F-535: a picture the bot makes with image_generate shows in the conversation, as the bytes the gateway made", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const key = "agent:otto:e2e-picture";
  await gatewayCall("sessions.create", { key, agentId: "otto", label: TASK });
  await openclaw(["agent", "--agent", "otto", "--session-key", key, "--message", "#image"]);
  // The picture arrives in the gateway's own turn after the bot's run, a few seconds later.
  await expect
    .poll(
      async () => {
        const history = await gatewayCall<{ messages: Array<{ content?: unknown }> }>(
          "chat.history",
          { sessionKey: key, limit: 50 },
        );
        return history.messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((part: { type?: string }) => part.type === "image"),
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  // The page itself asks the gateway for nothing: the host fetches the picture.
  const gatewayPort = String(listInstances().find((row) => row.name === INSTANCE)!.gatewayPort);
  const toGateway: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).port === gatewayPort) toGateway.push(request.url());
  });

  await openShell(page);
  await openTask(page, "Otto", TASK);
  const turn = page
    .getByTestId("transcript-turn")
    .filter({ hasText: "Here is the picture you asked for." });
  const picture = turn.getByRole("img", { name: ALT });
  await expect(picture).toBeVisible({ timeout: 30_000 });
  const drawn = await picture.evaluate((img: HTMLImageElement) => ({
    src: img.src,
    width: img.naturalWidth,
  }));
  expect(drawn.width).toBe(256);
  expect(drawn.src).toBe(`data:image/png;base64,${scriptedPicture().toString("base64")}`);
  expect(toGateway).toEqual([]);

  // Dark is the default; light and the phone width show it too, within the screen.
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(picture).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(picture).toBeVisible();
  const box = (await turn.getByTestId("picture").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.emulateMedia({ colorScheme: null });
});

// A picture a person attaches (#451), sent through the composer of a host of this test's own,
// with interactive access. The gateway keeps the file only as a `media://inbound` reference that
// nothing serves, so the preview is the app's own copy while the task stays open; once the page
// is reloaded the host has let the task go, and the message says plainly what was sent.
test.describe("F-557: a picture you attach", () => {
  const OWN_TASK = "Your picture from the end-to-end run";
  const OWN_KEY = "agent:pip:e2e-own-picture";
  const WORDS = "can u add this to my calendar?";
  const MINE = "Your picture: shot.png";
  const own: { child: ChildProcess; data: string }[] = [];

  test.afterAll(async () => {
    for (const host of own.splice(0)) {
      await stopChild(host.child).catch(() => host.child.kill("SIGKILL"));
      rmSync(host.data, { recursive: true, force: true });
    }
  });

  test("F-557 F-117: the picture shows on your message at once and after history holds it, opens larger, and after a reload says it was sent", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    await gatewayCall("sessions.create", { key: OWN_KEY, agentId: "pip", label: OWN_TASK });
    const data = mkdtempSync(join(tmpdir(), "clawtrate-own-picture-"));
    const started = startHost(INSTANCE, process.env.CLAWTRATE_E2E_STATIC!, data);
    own.push({ child: started.host, data });
    started.gated.release();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(await started.url);
    await page.getByRole("button", { name: "Use the development gateway" }).click();
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
      .toMatch(/^Approved /m);
    await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
    await openTask(page, "Pip", OWN_TASK);
    const bar = page.getByRole("region", { name: "Access" });
    await bar.getByRole("button", { name: "Request access" }).click();
    await expect
      .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
      .toMatch(/^Approved /m);
    await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });

    const shot = Buffer.from(solidPng(48, 32, [220, 40, 40]));
    await page
      .locator('.composer input[type="file"]')
      .setInputFiles([{ name: "shot.png", mimeType: "image/png", buffer: shot }]);
    await expect(page.locator(".attachments .chip:not([aria-busy=true])")).toHaveCount(1);
    await page.getByTestId("composer-input").fill(WORDS);
    await page.getByTestId("composer-input").press("Enter");

    const mine = page.getByRole("img", { name: MINE });
    await expect(mine).toBeVisible({ timeout: 20_000 });
    expect(await mine.getAttribute("src")).toBe(`data:image/png;base64,${shot.toString("base64")}`);
    // The gateway's history holds the message with the file named, and no picture of it.
    await expect
      .poll(
        async () => {
          const history = await gatewayCall<{ messages: Array<Record<string, unknown>> }>(
            "chat.history",
            { sessionKey: OWN_KEY, limit: 20 },
          );
          const row = history.messages.find((message) => message.role === "user");
          const media = (row?.__openclaw as { media?: Array<{ fileName?: string }> })?.media;
          return row ? [row.content, media?.map((each) => each.fileName)] : null;
        },
        { timeout: 60_000 },
      )
      .toEqual([WORDS, ["shot.png"]]);
    // History holds it now: the message is history's row, and its picture still shows.
    await expect(page.getByTestId("outgoing")).toHaveCount(0, { timeout: 30_000 });
    const turn = page.getByTestId("transcript-turn").filter({ hasText: WORDS });
    await expect(turn.getByRole("img", { name: MINE })).toBeVisible();
    await expect(turn.locator(".bubble")).toHaveText(WORDS);

    // Larger, and back.
    await turn.getByRole("button", { name: MINE }).click();
    const viewer = page.getByRole("dialog", { name: MINE });
    await expect(viewer.getByRole("img", { name: MINE })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(turn.getByRole("button", { name: MINE })).toBeFocused();

    // A reload lets the task go, and its copy with it: the message says what was sent.
    await page.reload();
    await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
    await openTask(page, "Pip", OWN_TASK);
    const again = page.getByTestId("transcript-turn").filter({ hasText: WORDS });
    await expect(again.getByTestId("sent-picture")).toHaveAttribute("data-state", "not-kept", {
      timeout: 20_000,
    });
    await expect(again.getByTestId("sent-picture")).toContainText(
      "shot.pngPicture sent with this message. The gateway doesn't give it back to show here.",
    );
    await context.close();
    await gatewayCall("sessions.delete", { key: OWN_KEY, deleteTranscript: true }).catch(() => {});
  });
});
