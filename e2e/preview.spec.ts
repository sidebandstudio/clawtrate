import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

test("pairs with the development gateway and shows bots, tasks and a transcript", async ({
  page,
}) => {
  const url = process.env.CLAWTRATE_E2E_URL;
  expect(url, "global setup provides the preview URL").toBeTruthy();
  await page.goto(url!);

  await expect(page.getByRole("heading", { name: "Clawtrate" })).toBeVisible();
  await page.getByRole("button", { name: "Use the development gateway" }).click();

  // A fresh device identity must be approved on the gateway host, over the real protocol.
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
  const command = await page
    .locator(".command code", { hasText: "openclaw devices approve" })
    .innerText();
  const requestId = command.split(" ").at(-1)!;
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  execFileSync(
    process.execPath,
    [join(ROOT, "tools/dev-gateway/src/cli.ts"), "approve", requestId],
    {
      cwd: ROOT,
    },
  );

  // The pairing screen reconnects by itself once the request is approved.
  const bots = page.getByTestId("bot");
  await expect(bots).toHaveCount(4, { timeout: 20_000 });
  await expect(bots).toContainText(["Juniper", "Marlow", "Otto", "Pip"]);

  await bots.filter({ hasText: "Otto" }).click();
  const tasks = page.getByTestId("task");
  await expect(tasks).toHaveCount(3);
  await expect(tasks).toContainText([
    "Certificate renewal warning",
    "Weekly backup check",
    "Disk almost full on the media box",
  ]);

  await tasks.filter({ hasText: "Disk almost full" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Disk almost full on the media box" }),
  ).toBeVisible();
  const turns = page.getByTestId("transcript-turn");
  await expect(turns).toHaveCount(4);
  await expect(turns.nth(0)).toContainText("The media box says the disk is 94% full");
  await expect(turns.nth(1)).toContainText("The usual suspects on a media box");
  await expect(page.getByTestId("tool-call")).toHaveCount(3);

  // Tool calls open to show their arguments and the gateway's result.
  const read = page.getByTestId("tool-call").filter({ hasText: "read" });
  await read.locator("summary").click();
  await expect(read).toContainText('"path": "AGENTS.md"');
  await expect(read).toContainText("You are Otto, the operator for a small home server.");

  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});
