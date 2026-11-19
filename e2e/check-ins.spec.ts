// A bot's check-ins (docs/design/automation.md section 13) against a real
// development gateway: this run's accounts instance, whose bots are the seeded
// four with the gateway's default check-ins (Juniper's, through
// `agents.defaults.heartbeat`). The interface runs on a preview host of its
// own and is driven as a person drives it; what landed is read back from the
// gateway's config and its heartbeat jobs, and the patches counted in the
// gateway's own log. The instance's scheduler is off, so no check-in runs on
// its schedule here: Off is shown by the job the scheduler would run, and by
// the gateway's own refusal to run it when asked to run it if enabled.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_CLIENTS } from "../tools/dev-gateway/src/account-checks.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_E2E_ACCOUNTS!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;

test.describe.configure({ mode: "serial" });

let host: { child: ChildProcess; url: string; data: string } | null = null;
let page: Page;
let admin: OperatorSession;

type Json = Record<string, unknown>;
type Job = { id: string; agentId: string; enabled: boolean; everyMs: number | undefined };

/** The heartbeat jobs the gateway keeps now: the check-ins that will run. */
async function jobs(): Promise<Job[]> {
  const list = await admin.request<{ jobs?: Json[] }>("cron.list", { includeDisabled: true });
  return (list.jobs ?? [])
    .filter((job) => (job.payload as Json | undefined)?.kind === "heartbeat")
    .map((job) => ({
      id: String(job.id),
      agentId: String(job.agentId),
      enabled: job.enabled === true,
      everyMs: (job.schedule as Json | undefined)?.everyMs as number | undefined,
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/** Each bot's own `heartbeat` setting in the gateway's config. */
async function settings(): Promise<Record<string, unknown>> {
  const config = (await admin.request<{ config: Json }>("config.get", {})).config;
  const entries = ((config.agents as Json | undefined)?.entries ?? {}) as Record<string, Json>;
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([, entry]) => entry.heartbeat !== undefined)
      .map(([bot, entry]) => [bot, entry.heartbeat]),
  );
}

/** The `config.patch` requests the gateway has answered, from its log. */
function patches(): number {
  const log = join(openInstance(INSTANCE).stateDir, "logs", "gateway.jsonl");
  if (!existsSync(log)) return 0;
  // One JSON line per answer; its text appears in more than one field.
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => /⇄ res [✓✗] config\.patch /.test(line)).length;
}

/** Saves with `run` and checks that the gateway answered exactly one patch for it. */
async function onePatch(run: () => Promise<void>): Promise<void> {
  const before = patches();
  await run();
  await expect.poll(patches, { timeout: 10_000 }).toBeGreaterThan(before);
  expect(patches() - before).toBe(1);
}

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

const block = (bot: string) => page.locator(`[data-testid="check-in"][data-bot="${bot}"]`);

async function openCheckIns(): Promise<void> {
  await page.keyboard.press("ControlOrMeta+,");
  const settingsDialog = page.getByRole("dialog", { name: "Settings" });
  await settingsDialog.getByRole("button", { name: "Check-ins", exact: true }).click();
  await expect(block("main")).toBeVisible({ timeout: 15_000 });
}

/** Choose `choice` in a bot's dialog and save it; resolves once the dialog says it saved. */
async function save(bot: string, choice: RegExp): Promise<void> {
  await block(bot)
    .getByRole("button", { name: /^Change / })
    .click();
  const dialog = page.getByTestId("check-ins-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: choice }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("b-announcer")).toHaveText("Check-ins saved");
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  expect(INSTANCE, "this run's accounts instance").toMatch(/^e2e-[0-9a-f]{8}-acct$/);
  expect(listInstances().find((each) => each.name === INSTANCE)?.gatewayRunning).toBe(true);
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate check-ins check",
    [...ACCOUNT_CLIENTS.admin.scopes],
    [...ACCOUNT_CLIENTS.admin.caps],
  );
  // The gateway's default: only Juniper (main) checks in, every 30 minutes, with no setting of its own.
  await admin.request("config.patch", {
    raw: JSON.stringify({
      agents: {
        entries: Object.fromEntries(
          Object.keys(await settings()).map((bot) => [bot, { heartbeat: null }]),
        ),
      },
    }),
    baseHash: (await admin.request<{ hash: string }>("config.get", {})).hash,
  });
  await expect.poll(async () => (await jobs()).map((job) => job.agentId)).toEqual(["main"]);

  const data = mkdtempSync(join(tmpdir(), "clawtrate-check-ins-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  host = { child: started.host, url: await started.url, data };
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(host.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(page.getByTestId("bot").first()).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await admin?.close();
  if (host) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

test("F-201: below admin the check-ins are read from the gateway's jobs and nothing offers a change; admin is asked for only by the bar's button", async () => {
  test.setTimeout(120_000);
  await openCheckIns();
  await expect(block("main")).toContainText("Checks in every 30 minutes");
  await expect(block("marlow")).toContainText("No check-ins");
  // The development gateway's scheduler is off, and the view says what that means.
  await expect(page.getByTestId("scheduler-off")).toContainText("scheduled check-ins don't run");
  await expect(page.getByRole("button", { name: /^Change .*'s check-ins$/ })).toHaveCount(0);
  const bar = page.getByTestId("admin-bar");
  await expect(bar).toContainText("Changing check-ins needs admin access.");
  await bar.getByRole("button", { name: "Request admin access" }).click();
  await expect(bar).toContainText("Waiting for the gateway's owner.", { timeout: 15_000 });
  await approve();
  await expect(page.getByTestId("admin-bar")).toContainText("Admin access granted.", {
    timeout: 30_000,
  });
  await expect(block("marlow").getByRole("button", { name: /^Change / })).toBeVisible();
});

test("F-201: Daily for Marlow is one config.patch that also keeps Juniper's check-ins, and once it says saved the gateway's config and jobs show both", async () => {
  test.setTimeout(120_000);
  await block("marlow")
    .getByRole("button", { name: /^Change / })
    .click();
  await expect(page.getByTestId("catch-note")).toContainText(
    "checks in now through the gateway's default",
  );
  await page.getByTestId("check-ins-dialog").getByRole("button", { name: "Cancel" }).click();
  await onePatch(() => save("marlow", /^Daily/));
  expect(await settings()).toEqual({ main: { every: "30m" }, marlow: { every: "24h" } });
  expect(
    (await jobs()).map(({ agentId, enabled, everyMs }) => [agentId, enabled, everyMs]),
  ).toEqual([
    ["main", true, 1_800_000],
    ["marlow", true, 86_400_000],
  ]);
  await expect(block("marlow")).toContainText("Checks in daily");
  await expect(block("main")).toContainText("Checks in every 30 minutes");
});

test("F-201: As needed for Marlow is one config.patch of every 30m, and once it says saved its job is set to every 30 minutes", async () => {
  test.setTimeout(120_000);
  await onePatch(() => save("marlow", /^As needed/));
  expect(await settings()).toEqual({ main: { every: "30m" }, marlow: { every: "30m" } });
  expect(
    (await jobs()).map(({ agentId, enabled, everyMs }) => [agentId, enabled, everyMs]),
  ).toEqual([
    ["main", true, 1_800_000],
    ["marlow", true, 1_800_000],
  ]);
  await expect(block("marlow")).toContainText("Checks in every 30 minutes");
});

test("F-366: Off for Juniper is one config.patch of every 0m; its job stays, disabled, and the gateway declines to run it if enabled", async () => {
  test.setTimeout(120_000);
  await block("main")
    .getByRole("button", { name: /^Change / })
    .click();
  await page.getByTestId("check-ins-dialog").getByRole("radio", { name: /^Off/ }).click();
  await expect(page.getByTestId("off-note")).toContainText(
    "still reports when a command it started in the background finishes",
  );
  await page.getByTestId("check-ins-dialog").getByRole("button", { name: "Cancel" }).click();
  await onePatch(() => save("main", /^Off/));
  expect(await settings()).toEqual({ main: { every: "0m" }, marlow: { every: "30m" } });
  const main = (await jobs()).find((job) => job.agentId === "main")!;
  expect(main.enabled).toBe(false);
  // What the scheduler asks of a job: run it if it is enabled. The gateway declines.
  expect(await admin.request("cron.run", { id: main.id, mode: "if-enabled" })).toMatchObject({
    ok: true,
    ran: false,
    reason: "disabled",
  });
  await expect(block("main")).toContainText("No check-ins");
  await expect(block("main")).toContainText("doesn't check in on a schedule.");
  await expect(block("marlow")).toContainText("Checks in every 30 minutes");
});
