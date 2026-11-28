// F-504: the preview host has a writable, admin connection before the walk.
// The gateway and the provider's sign-in page both belong to this test.
import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId, ownIdentity, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import {
  devGateway,
  FORBIDDEN_PORTS,
  listInstances,
  resetInstance,
  startHost,
} from "./global-setup.ts";
import { cleanUp, saveRecord, TEMP_PREFIX, type RunRecord } from "./run-record.ts";

const RECORDS = join(import.meta.dirname, "../tools/dev-gateway/.run/e2e");

test("F-504: a gateway nobody has used goes from connected to a bot's first answer", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const run = randomBytes(4).toString("hex");
  const instance = `e2e-${run}-setup`;
  const runId = newRunId();
  const data = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const record: RunRecord = {
    run,
    runner: { pid: process.pid, identity: ownIdentity() },
    instances: [{ name: instance, runId }],
    host: null,
    dirs: [data],
  };
  saveRecord(RECORDS, record);
  try {
    process.stdout.write(
      devGateway(
        instance,
        "start",
        "--run-id",
        runId,
        "--first-bot",
        "--with-plugin",
        "clawtrate-dev-signin",
      ),
    );
    const running = listInstances().find((row) => row.name === instance);
    expect(running?.gatewayRunning).toBe(true);
    const { providerPort, gatewayPort } = running!;
    for (const port of [providerPort, gatewayPort]) {
      if (port === null || FORBIDDEN_PORTS.includes(port)) throw new Error("Unsafe test port");
    }
    const provider = `http://127.0.0.1:${providerPort}`;

    record.hostPending = true;
    saveRecord(RECORDS, record);
    const started = startHost(instance, process.env.CLAWTRATE_E2E_STATIC!, data);
    const found = processIdentity(started.host.pid!);
    if (found.state !== "alive") {
      started.url.catch(() => {});
      started.gated.abort();
      throw new Error("Could not record the preview host");
    }
    record.host = { pid: started.host.pid!, identity: found.identity };
    delete record.hostPending;
    saveRecord(RECORDS, record);
    started.gated.release();

    await page.goto(await started.url);
    const approve = () =>
      expect
        .poll(() => devGateway(instance, "approve"), { timeout: 60_000 })
        .toMatch(/^Approved /m);
    await page.getByRole("button", { name: "Use the development gateway" }).click();
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
      timeout: 30_000,
    });
    await approve();
    await expect(page.getByTestId("bot")).toHaveCount(1, { timeout: 30_000 });
    // The web host has no secure credential storage. Grant the needed scopes before the walk.
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`ws://${location.host}/bridge`);
          socket.onmessage = (event) => {
            const message = JSON.parse(String(event.data)) as { type: string; id?: string };
            if (message.type === "hello")
              socket.send(
                JSON.stringify({
                  type: "command",
                  id: "admin",
                  command: { type: "requestAccess", tier: "admin" },
                }),
              );
            else if (message.id === "admin") {
              socket.close();
              resolve();
            }
          };
          socket.onerror = () => reject(new Error("Could not request test access"));
        }),
    );
    await approve();

    await expect(page.getByRole("heading", { name: "Set up your first bot" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Get started" }).click();
    const dialog = page.getByTestId("new-bot");
    await expect(dialog.getByRole("heading", { name: "Connect an account" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.getByRole("radio", { name: /^Let the gateway choose/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Show more" }).click();
    await dialog.getByRole("button", { name: /^Acme \(scripted\)/ }).click();
    await dialog.getByRole("button", { name: /^Acme \(scripted\)/ }).click();

    const code = dialog.locator(".b-code code");
    const answer = async (outcome: "approve" | "refuse") => {
      await expect(code).toBeVisible({ timeout: 30_000 });
      const response = await fetch(`${provider}/scripted/signin/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode: await code.textContent(), outcome, account: "first" }),
      });
      expect(response.ok).toBe(true);
    };
    await answer("refuse");
    await expect(dialog.getByText("Couldn't connect", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await dialog.getByRole("button", { name: "Try again", exact: true }).click();
    await answer("approve");

    await expect(dialog.getByRole("heading", { name: "Make your first bot" })).toBeVisible({
      timeout: 45_000,
    });
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Juniper");
    await expect(dialog.getByText("Uses Acme.")).toBeVisible();
    await dialog.getByRole("button", { name: "Create bot" }).click();
    const composer = page.getByTestId("composer-input");
    await expect(composer).toBeFocused({ timeout: 60_000 });
    await expect(dialog).toHaveCount(0);
    await composer.fill("Hello from my first conversation.");
    await composer.press("Enter");
    await expect(
      page
        .getByTestId("transcript")
        .getByText("This is the scripted development model.", { exact: false }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("turn-error")).toHaveCount(0);
    const receipt = (await (await fetch(`${provider}/scripted/requests`)).json()) as {
      requests: { account: string | null; model: string; session: string | null; status: number }[];
    };
    expect(receipt.requests).toContainEqual(
      expect.objectContaining({
        account: "acme:first",
        model: "dev-1",
        session: "agent:juniper:main",
        status: 200,
      }),
    );
  } finally {
    expect(cleanUp(RECORDS, record, resetInstance)).toEqual([]);
  }
});
