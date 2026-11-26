// What a person pins and chooses follows them to each device on their gateway (#639, F-601),
// against a real development gateway: two preview hosts, two devices of one person, paired with
// one instance of this file's own (`e2e-<id>-follow`), so nothing they keep there reaches another
// spec. Paired devices with no signed-in user are the gateway's owner profile, one user.
//
// Each device pairs and asks for write access as a person does. The second device starts with
// "Show sessions from other tools" turned on of its own: the first time its connection writes, it
// merges that into the gateway's choices with nothing to click, and the first device shows it. A choice turned on on one shows on the other; turned off where it was
// turned on, it goes off on the other, whose own was never on. A pin on one is a pin on the other.
//
// The instance is recorded in a run record of this file's own before it starts, as
// e2e/gateway-bot.spec.ts does, so a run killed outright is cleaned up by the next `pnpm e2e`.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_FILE } from "../packages/core/src/node/secure.ts";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { newRunId, ownIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import {
  devGateway,
  FORBIDDEN_PORTS,
  listInstances,
  startHost,
  stopChild,
} from "./global-setup.ts";
import { cleanUp, saveRecord, type RunRecord } from "./run-record.ts";

const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
const RUN = randomBytes(4).toString("hex");
const MINE = `e2e-${RUN}-follow`;
const record: RunRecord = {
  run: RUN,
  runner: { pid: process.pid, identity: "" },
  instances: [],
  host: null,
  dirs: [],
};
const cli = (...args: string[]) =>
  execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "CLAWTRATE_DEV_INSTANCE"),
    ),
    stdio: ["ignore", "inherit", "inherit"],
  });

type Host = { child: ChildProcess; data: string };
const hosts: Host[] = [];
const contexts: Array<{ close(): Promise<void> }> = [];

/** A device: a preview host of its own on this file's instance, paired, with `own` in its storage. */
async function device(browser: Browser, own: Record<string, string> = {}): Promise<Page> {
  const data = mkdtempSync(join(tmpdir(), "clawtrate-follow-"));
  if (Object.keys(own).length > 0)
    writeFileSync(join(data, STATE_FILE), `${JSON.stringify(own, null, 2)}\n`, { mode: 0o600 });
  const started = startHost(MINE, STATIC, data);
  hosts.push({ child: started.host, data });
  started.gated.release();
  const url = await started.url;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => devGateway(MINE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("bot").first()).toBeVisible({ timeout: 30_000 });
  // A paired device reads; write access is asked as the person asks it, in otto's access bar.
  await page.locator('[data-testid="bot"][data-bot="otto"]').click();
  await page
    .getByRole("region", { name: "Access" })
    .getByRole("button", { name: "Request access" })
    .click();
  await expect
    .poll(() => devGateway(MINE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
  return page;
}

/** Settings, Advanced, open on `page`; closed again by `close`. */
async function advanced(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  return {
    toggle: (name: string) => settings.getByRole("switch", { name }),
    close: async () => {
      await page.keyboard.press("Escape");
      await expect(settings).toHaveCount(0);
    },
  };
}

/** Whether a switch shows on, read in a fresh look at Settings. */
async function shown(page: Page, name: string): Promise<string | null> {
  const pane = await advanced(page);
  const value = await pane.toggle(name).getAttribute("aria-checked");
  await pane.close();
  return value;
}

test.afterAll(async () => {
  test.setTimeout(120_000);
  for (const context of contexts) await context.close().catch(() => {});
  for (const host of hosts) {
    await stopChild(host.child).catch(() => host.child.kill("SIGKILL"));
    rmSync(host.data, { recursive: true, force: true });
  }
  if (record.instances.length === 0) return;
  const problems = cleanUp(RECORDS, record, (name, runId) =>
    cli("reset", "--run-id", runId, "--instance", name),
  );
  expect(problems).toEqual([]);
});
process.once("exit", () => hosts.forEach((host) => host.child.kill("SIGKILL")));

test("F-601: two devices on one gateway: a choice and a pin made on one show on the other, and the second device's own choice is merged in the first time with nothing to click", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  record.runner.identity = ownIdentity();
  const runId = newRunId();
  record.instances.push({ name: MINE, runId });
  saveRecord(RECORDS, record);
  // Unseeded: every instance declares the four bots, and this check needs nothing more.
  cli("start", "--run-id", runId, "--instance", MINE, "--no-seed");
  const mine = listInstances().find((row) => row.name === MINE);
  if (!mine?.gatewayRunning) throw new Error(`instance ${MINE} is not running`);
  for (const port of [mine.gatewayPort, mine.providerPort])
    if (port === null || FORBIDDEN_PORTS.includes(port))
      throw new Error(`instance ${MINE} is on port ${port}, which e2e never uses`);

  // Otto's main task, so the access bar shows there, made as the gateway's own command line makes it.
  const made = await openInstance(MINE).runner.run([
    "gateway",
    "call",
    "sessions.create",
    "--params",
    JSON.stringify({ key: "agent:otto:main", agentId: "otto", label: "Main" }),
    "--json",
  ]);
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);

  const one = await device(browser);
  expect(await shown(one, "Show sessions from other tools")).toBe("false");
  expect(await shown(one, "Show thinking")).toBe("false");
  // The second device turned "Show sessions from other tools" on of its own before it paired.
  const two = await device(browser, { "show-other-tool-sessions": "true" });
  expect(await shown(two, "Show sessions from other tools")).toBe("true");
  // Merged in the first time, with nothing clicked: the first device shows it too.
  await expect
    .poll(() => shown(one, "Show sessions from other tools"), { timeout: 30_000 })
    .toBe("true");

  // A choice turned on on one device shows on the other.
  const pane = await advanced(one);
  await pane.toggle("Show thinking").click();
  await expect(pane.toggle("Show thinking")).toHaveAttribute("aria-checked", "true");
  await pane.close();
  await expect.poll(() => shown(two, "Show thinking"), { timeout: 30_000 }).toBe("true");
  // Turned off where it was turned on: off on the other too, whose own was never on.
  const again = await advanced(one);
  await again.toggle("Show thinking").click();
  await expect(again.toggle("Show thinking")).toHaveAttribute("aria-checked", "false");
  await again.close();
  await expect.poll(() => shown(two, "Show thinking"), { timeout: 30_000 }).toBe("false");

  // A pin made on one device is a pin on the other.
  const pip = (page: Page) => page.locator('.pin[data-bot="pip"]');
  await expect(pip(two)).toHaveCount(0);
  await one.locator('[data-testid="bot"][data-bot="pip"]').click({ button: "right" });
  await one.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(pip(one)).toHaveCount(1);
  await expect(pip(two)).toHaveCount(1, { timeout: 30_000 });
});
