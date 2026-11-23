// A picture a bot makes with image_generate, in the conversation (F-535), on
// this run's own development gateway, started with the stand-in image provider
// (`--with-images`). The bot's run asks for the picture, the gateway delivers
// it in a turn of its own, and the page draws the bytes the host fetched
// through the download the gateway issued. The file runs after
// preview.spec.ts, whose checks read Otto's task list as the seed left it.
import { expect, test, type Page } from "@playwright/test";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { IMAGE_PROMPT } from "../tools/dev-gateway/src/scenarios.ts";
import { scriptedPicture } from "../tools/dev-gateway/src/scripted-images.ts";
import { devGateway, listInstances } from "./global-setup.ts";

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
