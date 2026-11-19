// Settings → Permissions (docs/design/controls.md sections 7 to 9) against a
// real development gateway with Clawtrate's rules plugin: an instance of its
// own, `e2e-<run>-rules`, started with `--with-plugin clawtrate-tool-rules` by
// this file alone, so only the shard that runs it starts it. It is written to
// the run's record before it starts and reset by its run id afterwards.
//
// The instance is unseeded, so its bots go by their ids ("otto", "main"), and the
// page names them so. The page runs on a preview host of its own and is driven as a person drives
// it. What the gateway holds is read from the gateway itself, through an admin
// connection that plays the routine's reviewer and the bots' runs: every wait is
// on the gateway's own state (its events, a routine's run record, its lists),
// never on time.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { newRunId } from "../tools/dev-gateway/src/state-guard.ts";
import { devGateway, listInstances, RECORDS, startHost, stopChild } from "./global-setup.ts";
import { forgetInstance, recordInstance } from "./run-record.ts";

const RUN = process.env.CLAWTRATE_E2E_RUN!;
const INSTANCE = `e2e-${RUN}-rules`;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const ADMIN_SCOPES = ["operator.admin", "operator.read", "operator.write", "operator.approvals"];

test.describe.configure({ mode: "serial" });

type Json = Record<string, unknown>;
let entry: { name: string; runId: string } | null = null;
let host: { child: ChildProcess; url: string; data: string } | null = null;
let page: Page;
let admin: OperatorSession;

const settings = () => page.getByRole("dialog", { name: "Settings" });

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

/** Settings → Permissions, on one of its parts, opened afresh so the part reads again. */
async function permissions(part: "Rules" | "Saved approvals" | "Activity") {
  if ((await settings().count()) > 0) await page.keyboard.press("Escape");
  await expect(settings()).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await settings().getByRole("button", { name: "Permissions", exact: true }).click();
  await settings().getByRole("radio", { name: part }).click();
  await expect(settings().getByRole("radio", { name: part })).toHaveAttribute(
    "aria-checked",
    "true",
  );
}

/** A routine of a bot that sends one message, as the gateway's owner makes it. */
async function routine(agentId: string, name: string, message: string): Promise<string> {
  const added = await admin.request<Json>("cron.add", {
    name,
    agentId,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message },
    delivery: { mode: "none" },
  });
  return String(added.id);
}

/**
 * Run a routine now and wait for the gateway's record of that run's end. A
 * command card the run raises reaches the admin connection, the only reviewer a
 * routine has; `decide` answers it. Returns whether a card was raised.
 */
async function runRoutine(
  id: string,
  decide: ((approvalId: string) => Promise<void>) | null,
): Promise<{ asked: boolean; sessionKey: string }> {
  const since = admin.lastSeq;
  const started = await admin.request<Json>("cron.run", { id, mode: "force" });
  let asked = false;
  let finished: Json | undefined;
  await expect
    .poll(
      async () => {
        const card = admin.events.find(
          (event) =>
            event.seq > since &&
            event.event === "exec.approval.requested" &&
            ((event.payload as Json).request as Json | undefined)?.cronExecutionSource !==
              undefined &&
            (((event.payload as Json).request as Json).cronExecutionSource as Json).jobId === id,
        );
        if (card && !asked) {
          asked = true;
          if (!decide) throw new Error("the routine's command asked, and nothing was to answer it");
          await decide(String((card.payload as Json).id));
        }
        const runs = await admin.request<{ entries?: Json[] }>("cron.runs", { id, limit: 10 });
        finished = (runs.entries ?? []).find(
          (each) => each.action === "finished" && each.runId === started.runId,
        );
        return finished !== undefined;
      },
      { timeout: 90_000, intervals: [500] },
    )
    .toBe(true);
  return { asked, sessionKey: String(finished!.sessionKey) };
}

async function grantsOf(jobId: string): Promise<Json[]> {
  const { grants } = await admin.request<{ grants: Json[] }>("exec.approval.grants.list", {});
  return grants.filter((each) => each.cronJobId === jobId);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  expect(RUN, "this end-to-end run's id").toMatch(/^[0-9a-f]{8}$/);
  // Written to the run's record before it starts, so the run's cleanup resets it whatever happens.
  entry = { name: INSTANCE, runId: newRunId() };
  recordInstance(RECORDS, RUN, entry);
  devGateway(
    INSTANCE,
    "start",
    "--run-id",
    entry.runId,
    "--with-plugin",
    "clawtrate-tool-rules",
    "--no-seed",
  );
  expect(listInstances().find((each) => each.name === INSTANCE)?.gatewayRunning).toBe(true);
  admin = await openOperator(openInstance(INSTANCE), "Clawtrate permissions check", ADMIN_SCOPES, [
    "tool-events",
    "approvals",
  ]);

  const data = mkdtempSync(join(tmpdir(), "clawtrate-permissions-"));
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
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
});

test.afterAll(async () => {
  await admin?.close();
  if (host) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
  if (entry) {
    devGateway(INSTANCE, "reset", "--run-id", entry.runId);
    forgetInstance(RECORDS, RUN, entry);
  }
});

test("F-324: at the read tier, a call Otto's rule blocked shows its recorded cause and the rule's version now, a routine's call shows Cause not recorded, and Show in chat opens the call in its task", async () => {
  test.setTimeout(240_000);
  // The rules plugin runs, and says so first.
  await permissions("Rules");
  await expect(page.getByTestId("rules-plugin-state")).toHaveText(
    /^Rules plugin answered at .+\. (No tool call seen yet\.|Last tool call seen .+\.) No rules are saved in it\.$/,
  );
  // This connection reads only: saved approvals ask for approvals access, and nothing more.
  await settings().getByRole("radio", { name: "Saved approvals" }).click();
  await expect(settings().getByTestId("admin-bar")).toContainText(
    "Seeing saved approvals needs approvals access.",
  );

  // Otto's rule: never read AGENTS.md. A run reads it, and the plugin blocks the call.
  const saved = await admin.request<Json>("clawtrate-tool-rules.set", {
    scope: "otto",
    rules: [{ action: "never", tools: ["read"], target: { kind: "path", pattern: "AGENTS.md" } }],
    fallback: false,
    expectedVersion: 0,
  });
  const title = `Blocked read ${Math.random().toString(16).slice(2, 6)}`;
  const { key } = await admin.request<{ key: string }>("sessions.create", {
    agentId: "otto",
    label: title,
  });
  const run = await admin.send(key, "#read");
  await admin.terminal(String(run.runId));
  const [audited] = (
    await admin.request<{ events: Json[] }>("audit.activity.list", {
      kind: "tool_action",
      runId: run.runId,
      status: "blocked",
    })
  ).events;
  expect(audited, "the audit log's record of the blocked call").toBeTruthy();
  // The call's task loaded on this device: open it in the rail. The instance is unseeded, so
  // its bots go by their ids, and Otto's one task opens with its row.
  await page.keyboard.press("Escape");
  await page
    .getByTestId("bot-list")
    .getByRole("button", { name: /^otto\b/ })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({
    timeout: 30_000,
  });

  await permissions("Activity");
  const blocked = page.getByTestId("activity-row").filter({ hasText: title }).filter({
    hasText: "Blocked",
  });
  await expect(blocked).toHaveCount(1, { timeout: 20_000 });
  await expect(blocked).toContainText("read");
  await expect(blocked).toContainText("Recorded: otto's rule 'Never · AGENTS.md', version 1.");

  // The rule is edited: the record names the version it was decided by, and the version now.
  const rule = (saved.rules as Json[])[0]!;
  await admin.request("clawtrate-tool-rules.set", {
    scope: "otto",
    rules: [
      {
        id: rule.id,
        action: "never",
        tools: ["read"],
        target: { kind: "path", pattern: "AGENTS*.md" },
      },
    ],
    fallback: false,
    expectedVersion: saved.version,
  });
  // Juniper's routine reads its instructions: the plugin decides nothing, and nothing else joins.
  const job = await routine("main", "Morning read", "#read");
  const ran = await runRoutine(job, null);
  expect(ran.asked).toBe(false);
  await permissions("Activity");
  await expect(blocked).toContainText("Recorded: otto's Never rule, version 1 (now version 2).", {
    timeout: 20_000,
  });
  const routineRow = page
    .getByTestId("activity-row")
    .filter({ hasText: "A routine's run" })
    .filter({ hasText: "read" })
    .first();
  await expect(routineRow).toContainText("Cause not recorded");
  await expect(routineRow).toContainText("Ran");

  // Show in chat: Settings closes and the blocked call is in view in its task, focused.
  await blocked.click();
  await page.getByRole("button", { name: "Show in chat" }).click();
  await expect(settings()).toHaveCount(0);
  // The task's one call, the blocked read.
  const call = page.locator(".transcript [data-call]");
  await expect(call).toHaveCount(1);
  await expect(call).toBeInViewport({ timeout: 10_000 });
  await expect(call.locator(":scope > summary")).toBeFocused();
  await admin.request("cron.remove", { id: job });
});

test("F-178: approvals access alone shows a routine's grant with what it is bound to and when; Revoke reads it back revoked, and the routine's next matching command asks again", async () => {
  test.setTimeout(300_000);
  // The person asks for approvals access, and the gateway's owner approves it.
  await permissions("Saved approvals");
  await settings().getByTestId("admin-bar").getByRole("button", { name: "Request access" }).click();
  await expect(settings().getByTestId("admin-bar")).toContainText(
    "Waiting for the gateway's owner.",
    { timeout: 15_000 },
  );
  await approve();
  await expect(settings().getByTestId("saved-approvals")).toBeVisible({ timeout: 30_000 });
  // Exactly read and approvals were asked for and granted: no write, no admin.
  await settings().getByRole("button", { name: "Gateway", exact: true }).click();
  await expect(settings().getByTestId("granted-scopes")).toHaveText(
    /^(operator\.read, operator\.approvals|operator\.approvals, operator\.read)$/,
  );

  // Otto's routine runs a command; its reviewer allows it always, for one day.
  const job = await routine("otto", "Weekly cleanup", "#approve");
  const first = await runRoutine(job, (id) =>
    admin.request("exec.approval.resolve", { id, decision: "allow-always", grantExpiresInDays: 1 }),
  );
  expect(first.asked).toBe(true);
  const [minted] = await grantsOf(job);
  expect(minted).toMatchObject({ command: "ls", revokedAtMs: null, useCount: 0 });

  await permissions("Saved approvals");
  const row = page.getByTestId("routine-grant").filter({ hasText: "Weekly cleanup" });
  await expect(row).toContainText("Routine Weekly cleanup (otto) · Saved command ls in ");
  await expect(row).toContainText(/granted .+ · until .+ · not used yet/);
  await expect(row).toContainText("The gateway enforces this");

  // Its next run runs the command under the grant, with no card; the page shows the use.
  const second = await runRoutine(job, null);
  expect(second.asked).toBe(false);
  expect((await grantsOf(job))[0]).toMatchObject({ useCount: 1 });
  await permissions("Saved approvals");
  await expect(row).toContainText(/used 1 time, last /);

  // Revoke: the row says Revoked only from the list read back, as the gateway lists it.
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row.getByTestId("grant-revoked")).toHaveText(
    /^Revoked .+\. The routine's next matching command no longer runs under this grant\.$/,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("b-announcer")).toHaveText("Revoked");
  expect((await grantsOf(job))[0]!.revokedAtMs).toEqual(expect.any(Number));
  // The routine's next run asks again.
  const third = await runRoutine(job, (id) =>
    admin.request("exec.approval.resolve", { id, decision: "deny" }),
  );
  expect(third.asked).toBe(true);
  await admin.request("cron.remove", { id: job });
});

test("F-178: with admin access, the gateway machine's allowlist entry from Always allow is listed in its own terms, and Remove… writes the file without it and reads it back", async () => {
  test.setTimeout(240_000);
  // Otto's command allowed always, from its card, by a reviewer: the gateway saves allowlist entries.
  const { key } = await admin.request<{ key: string }>("sessions.create", {
    agentId: "otto",
    label: `Allow always ${Math.random().toString(16).slice(2, 6)}`,
  });
  /** Run Otto's command and answer the card it raises; resolves once the run has ended. */
  const command = async (decision: "allow-always" | "deny") => {
    const since = admin.lastSeq;
    const run = await admin.send(key, "#approve");
    const card = await admin.waitFor(
      "the command's card",
      (event) =>
        event.event === "exec.approval.requested" &&
        ((event.payload as Json).request as Json).sessionKey === key,
      60_000,
      since,
    );
    await admin.request("exec.approval.resolve", { id: (card.payload as Json).id, decision });
    await admin.terminal(String(run.runId));
    return true;
  };
  expect(await command("allow-always")).toBe(true);
  const file = await admin.request<{ file: { agents: Record<string, { allowlist: Json[] }> } }>(
    "exec.approvals.get",
    {},
  );
  // The entry for the command itself: the executable's path, with the arguments and folder bound.
  const saved = file.file.agents.otto!.allowlist.find(
    (each) => each.source === "allow-always" && typeof each.argPattern === "string",
  );
  expect(saved, "an allowlist entry from Always allow").toBeTruthy();
  const pattern = String(saved!.pattern);

  // Admin access is asked for by the person, for exactly that.
  await permissions("Saved approvals");
  await expect(
    settings().getByText("Seeing the gateway machine's allowlist needs admin access."),
  ).toBeVisible({
    timeout: 20_000,
  });
  await settings()
    .getByTestId("admin-bar")
    .getByRole("button", { name: "Request admin access" })
    .click();
  await approve();
  const entry = page.getByTestId("allowlist-entry").filter({ hasText: pattern });
  await expect(entry).toContainText(
    `${pattern} · otto · on the gateway's machine · from Always allow`,
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("allowlist-no-time")).toHaveText(
    "The gateway records no time for these commands being added, so none is shown.",
  );
  await expect(page.getByTestId("saved-not-listed")).toContainText("placement grants");
  await expect(entry).toContainText(`Argument pattern ${String(saved!.argPattern)}`);

  await entry.getByRole("button", { name: "Remove…" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(
    page.getByText(`Removed ${pattern} for otto. Read back at `, { exact: false }),
  ).toContainText("the gateway's file no longer lists it.", { timeout: 20_000 });
  await expect(page.getByTestId("b-announcer")).toHaveText("Removed");
  const after = await admin.request<{ file: { agents: Record<string, { allowlist?: Json[] }> } }>(
    "exec.approvals.get",
    {},
  );
  expect((after.file.agents.otto?.allowlist ?? []).some((each) => each.id === saved!.id)).toBe(
    false,
  );
  // The same command asks again.
  expect(await command("deny")).toBe(true);
});
