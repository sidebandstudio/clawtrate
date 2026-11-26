// A picture a bot makes with image_generate, in the conversation (F-535), on
// this run's own development gateway, started with the stand-in image provider
// (`--with-images`). The bot's run asks for the picture, the gateway delivers
// it in a turn of its own (on 2026.11.10, a row of its own), and the page
// draws the bytes the host fetched through the download the gateway issued.
// The file runs after preview.spec.ts, whose checks read Otto's task list as
// the seed left it.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { solidPng } from "../packages/core/test/sent-attachments-rows.ts";
import { instanceForm, openInstance, readDevConnection } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import {
  IMAGE_PROMPT,
  SEND_PICTURE_AFTER,
  SEND_PICTURE_TEXT,
} from "../tools/dev-gateway/src/scenarios.ts";
import { scriptedPicture } from "../tools/dev-gateway/src/scripted-images.ts";
import { trailMap } from "../tools/dev-gateway/src/seed-files.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";
import { protectedGateway } from "./protected-gateway.ts";

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
  // The picture arrives after the bot's run, a few seconds later.
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
  // 2026.10.6 delivers the picture in a turn of the gateway's own, with its text, named for the
  // description it was made from. 2026.11.10 writes it into the task as a row of its own, with no
  // text and no turn of that run (`pictureTurn`), so it shows as a picture the bot handed over.
  const { pictureTurn } = instanceForm(openInstance(INSTANCE));
  const turn = page
    .getByTestId("transcript-turn")
    .filter(
      pictureTurn
        ? { hasText: "Here is the picture you asked for." }
        : { has: page.getByTestId("picture") },
    );
  const picture = turn.getByRole("img", {
    name: pictureTurn ? ALT : "A picture the bot handed over",
  });
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

test("F-535: a picture the bot sends with its message tool shows under that message, as the bytes the gateway staged", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const key = "agent:pip:e2e-send-picture";
  const task = "A picture sent from the end-to-end run";
  await gatewayCall("sessions.create", { key, agentId: "pip", label: task });
  // Sent as a person's message from a client, so the gateway runs the send as its reply in the task.
  await gatewayCall("chat.send", {
    sessionKey: key,
    message: "#send-picture",
    idempotencyKey: "e2e-send-picture",
  });
  await expect
    .poll(
      async () => {
        const history = await gatewayCall<{
          messages: Array<{ model?: string; content?: unknown }>;
        }>("chat.history", { sessionKey: key, limit: 50 });
        return history.messages.some(
          (message) =>
            message.model === "delivery-mirror" &&
            Array.isArray(message.content) &&
            message.content.some((part: { type?: string }) => part.type === "image"),
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  const gatewayPort = String(listInstances().find((row) => row.name === INSTANCE)!.gatewayPort);
  const toGateway: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).port === gatewayPort) toGateway.push(request.url());
  });

  await openShell(page);
  await openTask(page, "Pip", task);
  const turn = page.getByTestId("transcript-turn").filter({ hasText: SEND_PICTURE_TEXT });
  const picture = turn.getByRole("img", { name: "A picture the bot handed over" });
  await expect(picture).toBeVisible({ timeout: 30_000 });
  await expect(turn.getByTestId("picture")).toHaveCount(1);
  expect(await picture.getAttribute("src")).toBe(
    `data:image/png;base64,${trailMap().toString("base64")}`,
  );
  // Under the message's bubble, above what the bot said after sending it. On 2026.11.10 the send
  // ends the turn without asking the model again (`messageSendEndsTurn`): nothing comes after.
  const shown = (await picture.boundingBox())!;
  const bubble = (await turn.getByText(SEND_PICTURE_TEXT).boundingBox())!;
  expect(shown.y).toBeGreaterThan(bubble.y);
  if (!instanceForm(openInstance(INSTANCE)).messageSendEndsTurn) {
    const after = (await turn.getByText(SEND_PICTURE_AFTER).boundingBox())!;
    expect(shown.y + shown.height).toBeLessThan(after.y);
  }
  expect(toGateway).toEqual([]);
});

// A picture a person attaches (#451), sent through the composer of a host of this test's own,
// with interactive access. The preview is the app's own copy, kept by its host whenever the task
// is opened again there (another task and back, or a reload of the page, #509). Another device's
// host has none: at the development gateway's loopback address it reads nothing back and says so;
// at a protected address (e2e/protected-gateway.ts) it reads the picture back from the gateway
// by the `media://inbound` reference history gives (#469).
test.describe("F-557: a picture you attach", () => {
  // A task of each run's own, so a repeated or retried run never meets an earlier one's messages.
  const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const OWN_TASK = `Your picture from the end-to-end run ${RUN}`;
  const OWN_KEY = `agent:pip:e2e-own-picture-${RUN}`;
  const WORDS = "can u add this to my calendar?";
  const MINE = "Your picture: shot.png";
  // Your own turn: the scripted reply quotes your words, so a text filter alone finds its turn too.
  const YOURS = '[data-testid="transcript-turn"][data-role="user"]';
  const own: { child: ChildProcess; data: string }[] = [];

  /** A new device of this gateway at a typed address, with the gateway's token, approved. */
  async function pairAt(on: Page, url: string, gateway: string): Promise<void> {
    await on.goto(url);
    await expect(on.getByRole("button", { name: "Use the development gateway" })).toBeVisible({
      timeout: 20_000,
    });
    const { token } = readDevConnection(openInstance(INSTANCE).connectionFile)!;
    await on.evaluate(
      ({ gateway, token }) =>
        new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`ws://${location.host}/bridge${location.search}`);
          socket.onmessage = (event) => {
            const message = JSON.parse(String(event.data)) as { type: string; id?: string };
            if (message.type === "hello")
              socket.send(
                JSON.stringify({
                  type: "command",
                  id: "connect",
                  command: { type: "connect", url: gateway, token },
                }),
              );
            else if (message.id === "connect") {
              socket.close();
              resolve();
            }
          };
          socket.onerror = () => reject(new Error("bridge socket error"));
        }),
      { gateway, token },
    );
    // Approved only while the page asks for it: each approve starts the gateway's own command,
    // which is slow on a busy machine, and the pairing and the bot list can each take a while.
    const asking = on.getByRole("heading", { name: "Approve this device" });
    await expect
      .poll(
        async () => {
          if ((await on.getByTestId("bot").count()) === 4) return "ready";
          if (await asking.isVisible()) devGateway(INSTANCE, "approve");
          return "waiting";
        },
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe("ready");
  }

  /** A new device of this gateway: the page paired, its pairing approved by id. */
  async function pair(on: Page, url: string): Promise<void> {
    await on.goto(url);
    await on.getByRole("button", { name: "Use the development gateway" }).click();
    await expect(on.getByRole("heading", { name: "Approve this device" })).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
      .toMatch(/^Approved /m);
    await expect(on.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  }

  test.afterAll(async () => {
    for (const host of own.splice(0)) {
      await stopChild(host.child).catch(() => host.child.kill("SIGKILL"));
      rmSync(host.data, { recursive: true, force: true });
    }
  });

  test("F-557 F-117: the picture shows on your message at once and after history holds it, opens larger, still after a reload; on another device it is read back from the gateway at a protected address, and at a loopback one says it can't be loaded", async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    await gatewayCall("sessions.create", { key: OWN_KEY, agentId: "pip", label: OWN_TASK });
    const data = mkdtempSync(join(tmpdir(), "clawtrate-own-picture-"));
    const started = startHost(INSTANCE, process.env.CLAWTRATE_E2E_STATIC!, data);
    own.push({ child: started.host, data });
    started.gated.release();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await pair(page, await started.url);
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
    const turn = page.locator(YOURS).filter({ hasText: WORDS });
    await expect(turn.getByRole("img", { name: MINE })).toBeVisible();
    await expect(turn.locator(".bubble")).toHaveText(WORDS);

    // Larger, and back.
    await turn.getByRole("button", { name: MINE }).click();
    const viewer = page.getByRole("dialog", { name: MINE });
    await expect(viewer.getByRole("img", { name: MINE })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(turn.getByRole("button", { name: MINE })).toBeFocused();

    // The bot has answered, so nothing keeps the task followed once you leave it. Another task and
    // back: the host let the task go, and still shows its copy (#509).
    await expect(
      page.getByTestId("transcript-turn").filter({ hasText: "scripted development model" }),
    ).toBeVisible({ timeout: 30_000 });
    await openTask(page, "Pip", "Saturday errands route");
    await openTask(page, "Pip", OWN_TASK);
    const back = page.locator(YOURS).filter({ hasText: WORDS });
    await expect(back.getByRole("img", { name: MINE })).toBeVisible({ timeout: 20_000 });

    // A reload of the page lets this viewer's tasks go too: the copy still shows.
    await page.reload();
    await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
    await openTask(page, "Pip", OWN_TASK);
    const again = page.locator(YOURS).filter({ hasText: WORDS });
    await expect(again.getByRole("img", { name: MINE })).toBeVisible({ timeout: 20_000 });

    // Another device at the loopback address has no copy and reads nothing back: it says so.
    const otherData = mkdtempSync(join(tmpdir(), "clawtrate-own-picture-"));
    const other = startHost(INSTANCE, process.env.CLAWTRATE_E2E_STATIC!, otherData);
    own.push({ child: other.host, data: otherData });
    other.gated.release();
    const otherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const second = await otherContext.newPage();
    await pair(second, await other.url);
    await openTask(second, "Pip", OWN_TASK);
    const there = second.locator(YOURS).filter({ hasText: WORDS });
    await expect(there.getByTestId("sent-picture")).toHaveAttribute("data-state", "cannot-load", {
      timeout: 20_000,
    });
    await expect(there.getByTestId("sent-picture")).toContainText(
      // Its name and size as the gateway recorded them, then the plain line.
      `shot.png${Math.round(shot.length / 1024)} KBThis connection can't load the picture back from the gateway.`,
    );
    await expect(there.locator(".bubble")).toHaveText(WORDS);
    await otherContext.close();

    // A third device reaches the gateway at a protected address: the host reads the picture back.
    const gatewayPort = listInstances().find((row) => row.name === INSTANCE)!.gatewayPort!;
    const tls = await protectedGateway(gatewayPort);
    try {
      const farData = mkdtempSync(join(tmpdir(), "clawtrate-own-picture-"));
      const far = startHost(INSTANCE, process.env.CLAWTRATE_E2E_STATIC!, farData, {
        env: tls.env,
      });
      own.push({ child: far.host, data: farData });
      far.gated.release();
      const farContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const third = await farContext.newPage();
      // The page asks no gateway for anything: its host does.
      const fromPage: string[] = [];
      third.on("request", (request) => {
        if (/gateway\.clawtrate\.test|assistant-media|media:\/\//.test(request.url()))
          fromPage.push(request.url());
      });
      await pairAt(third, await far.url, tls.url);
      await openTask(third, "Pip", OWN_TASK);
      const read = third.locator(YOURS).filter({ hasText: WORDS });
      const back = read.getByRole("img", { name: MINE });
      await expect(back).toBeVisible({ timeout: 30_000 });
      expect(await back.getAttribute("src")).toBe(
        `data:image/png;base64,${shot.toString("base64")}`,
      );
      await expect(read.getByTestId("sent-picture")).toHaveAttribute("data-state", "shown");
      // It opens larger the same way as any picture.
      await read.getByRole("button", { name: MINE }).click();
      await expect(third.getByRole("dialog", { name: MINE }).getByRole("img")).toBeVisible();
      await third.keyboard.press("Escape");
      expect(fromPage).toEqual([]);
      await farContext.close();
    } finally {
      await tls.close();
    }
    await context.close();
    await gatewayCall("sessions.delete", { key: OWN_KEY, deleteTranscript: true }).catch(() => {});
  });
});
