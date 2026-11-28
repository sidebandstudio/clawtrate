// #913: the gateway restarts with the app connected. OpenClaw announces the restart before it
// closes the connection, and the app says "Restarting OpenClaw…" in the strip and the footer,
// never "Reconnecting", until it is back; then nothing is left on screen.
import { expect, test, type Page } from "@playwright/test";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { devGateway } from "./global-setup.ts";

/** This run's own development gateway instance, created by global setup. */
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;

/** A gateway method, called with the instance's own operator credentials. */
async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  const result = await openInstance(INSTANCE).runner.run([
    ...["gateway", "call", method, "--params", JSON.stringify(params), "--json"],
  ]);
  if (result.status !== 0) throw new Error(`${method} failed:\n${result.stdout}${result.stderr}`);
  return parseJsonOutput<T>(result.stdout);
}

/** The shared preview host, paired. */
async function openShell(page: Page) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!);
  const connect = page.getByRole("button", { name: "Use the development gateway" });
  const bots = page.getByTestId("bot");
  await expect
    .poll(async () => (await connect.isVisible()) || (await bots.count()) >= 4, { timeout: 30_000 })
    .toBe(true);
  if (await connect.isVisible()) {
    await connect.click();
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
      .toMatch(/^Approved /m);
  }
  await expect(bots).toHaveCount(4, { timeout: 30_000 });
}

test("#913: a restart of the gateway says Restarting OpenClaw… until the app is back, never Reconnecting", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openShell(page);
  // Every strip and every footer state seen from here on, in order.
  await page.evaluate(() => {
    const seen = { strips: [] as string[], footers: [] as string[] };
    (window as unknown as { seen: typeof seen }).seen = seen;
    const look = () => {
      const strip = document.querySelector('[data-testid="status-strip"] strong')?.textContent;
      if (strip && seen.strips.at(-1) !== strip) seen.strips.push(strip);
      const footer = document.querySelector(".gateway-pill-text span")?.textContent;
      if (footer && seen.footers.at(-1) !== footer) seen.footers.push(footer);
    };
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  type Seen = { strips: string[]; footers: string[] };
  const seen = () => page.evaluate(() => (window as unknown as { seen: Seen }).seen);

  // The gateway restarts in its own process, as a setting that needs it or an update makes it.
  await gatewayCall("gateway.restart.request", { reason: "clawtrate-e2e", skipDeferral: true });
  const strip = page.getByTestId("status-strip");
  await expect(strip).toContainText("Restarting OpenClaw…", { timeout: 30_000 });
  await expect
    .poll(async () => (await seen()).footers, { timeout: 10_000 })
    .toContain("Restarting OpenClaw…");

  // A slow watcher close can take over 100 seconds after the restart notice.
  const app = page.locator(".app");
  await expect(app).toHaveAttribute("data-connection", "lost", { timeout: 120_000 });
  await expect(app).not.toHaveAttribute("data-connection", "lost", { timeout: 180_000 });
  await expect(strip).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("bot")).toHaveCount(4);
  const { strips, footers } = await seen();
  expect(
    strips.filter((text) => /Reconnecting/.test(text)),
    strips.join(" | "),
  ).toEqual([]);
  expect(
    footers.filter((text) => /Reconnecting/.test(text)),
    footers.join(" | "),
  ).toEqual([]);
});
