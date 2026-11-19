// Routines against a real development gateway: this run's own instance, a
// preview host of its own paired at the read tier, and a paired admin
// operator that plays the gateway's other clients, adding, changing, running
// and removing jobs. Every change on screen comes from the gateway's own
// `cron` event. The scheduler is off on a development gateway, so runs are
// started with `cron.run {mode: "force"}`. Each check makes routines of its
// own, named with this run's stamp, and they are removed afterwards.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zonedTime } from "../packages/ui/src/routines/schedule.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { scriptedRoutine, SCRIPTED_ROUTINES } from "../tools/dev-gateway/src/routines.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const STAMP = Date.now().toString(36);
const NY = "America/New_York";

type Job = { id: string; name: string; state?: { nextRunAtMs?: number } };
type RunEntry = { runId: string; runAtMs: number; status: string };

/** "Tue Nov 17, 8:00 AM", with "Today, " or "Tomorrow, " before it when it is: the page's words for a time. */
function spelled(ms: number, tz: string): string {
  const day = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  })
    .formatToParts(ms)
    .filter((part) => part.type !== "literal")
    .map((part) => part.value)
    .join(" ");
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
  const now = Date.now();
  const relative =
    day(ms) === day(now) ? "Today, " : day(ms) === day(now + 86_400_000) ? "Tomorrow, " : "";
  return `${relative}${date}, ${time}`;
}

let host: { child: ChildProcess; data: string } | null = null;
let page: Page;
let admin: OperatorSession;
const made = new Set<string>();

const call = <T>(method: string, params: unknown) => admin.request(method, params) as Promise<T>;

async function add(routine: unknown): Promise<Job> {
  const job = await call<Job>("cron.add", routine);
  made.add(job.id);
  return job;
}

/** A forced run, waited for until it finishes. */
const runNow = (id: string) =>
  call<{ ok: boolean; run?: RunEntry }>("cron.run", { id, mode: "force", waitTimeoutMs: 60_000 });

const view = () => page.getByTestId("routines-view");
const row = (name: string) => view().getByTestId("routine-row").filter({ hasText: name });
const botRow = (name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

async function openRoutines(): Promise<void> {
  if (await view().count()) {
    const back = view().getByRole("button", { name: /^Back to (.+, all runs|routines)$/ });
    while (await back.count()) await back.first().click();
    return;
  }
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(view()).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate routines check",
    ["operator.admin", "operator.read"],
    [],
  );
  const data = mkdtempSync(join(tmpdir(), "clawtrate-routines-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  host = { child: started.host, data };
  const url = await started.url;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: NY,
    locale: "en-US",
  });
  page = await context.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  for (const id of made) await call("cron.remove", { id }).catch(() => {});
  await admin?.close();
  await page?.context().close();
  if (host) {
    await stopChild(host.child).catch(() => host?.child.kill("SIGKILL"));
    rmSync(host.data, { recursive: true, force: true });
  }
});
process.once("exit", () => host?.child.kill("SIGKILL"));

test("F-191: the list shows each routine with its schedule in words and zone, next and last run, or Paused", async () => {
  const digest = await add({ ...SCRIPTED_ROUTINES[0]!, name: `Morning digest ${STAMP}` });
  const paused = await add({ ...scriptedRoutine(`Paused one ${STAMP}`, "pip") });
  await call("cron.update", { id: paused.id, patch: { enabled: false } });
  await openRoutines();
  await expect(row(digest.name)).toContainText("Weekdays at 8:00 AM, New York");
  await expect(row(digest.name)).toContainText("No runs yet");
  await expect(row(digest.name)).toContainText(/Next (tomorrow|Mon|Tue|Wed|Thu|Fri|today) 8:00 AM/);
  await expect(row(paused.name)).toContainText("Paused · Every hour");
  // The gateway's scheduler is off here, and the view says so.
  await expect(view().getByTestId("scheduler-off")).toBeVisible();
  // One bot's routines only.
  await view().getByRole("combobox", { name: "Bots" }).selectOption({ label: "Pip" });
  await expect(row(paused.name)).toBeVisible();
  await expect(row(digest.name)).toHaveCount(0);
  await view().getByRole("combobox", { name: "Bots" }).selectOption({ label: "All bots" });
});

test("F-188 F-353: a routine's page shows its instruction, when it runs in words with its zone and next run, where runs go and what triggers it", async () => {
  const name = `Page check ${STAMP}`;
  const job = await add({ ...SCRIPTED_ROUTINES[0]!, name });
  await openRoutines();
  await row(name).click();
  await expect(view().getByRole("heading", { name })).toBeVisible();
  await expect(view()).toContainText(SCRIPTED_ROUTINES[0]!.payload.message);
  const facts = view().getByTestId("routine-facts");
  await expect(facts).toContainText("Weekdays at 8:00 AM");
  await expect(facts).toContainText("New York");
  await expect(facts).toContainText(NY);
  // The gateway's own next run, in the routine's zone, written out here rather than by the product's formatter.
  const next = (await call<Job>("cron.get", { id: job.id })).state!.nextRunAtMs!;
  await expect(view().getByTestId("routine-next")).toContainText(spelled(next, NY));
  await expect(facts).toContainText("A new conversation each time");
  await expect(facts).toContainText("Kept with the run");
  await expect(facts).toContainText("This gateway's webhooks start a bot directly, not a routine.");
  await expect(view().getByTestId("no-runs")).toContainText("No runs yet. The first is due");
});

test("F-353: a cron schedule with no zone runs in the gateway's, and its next run is said in the viewer's", async () => {
  const name = `No zone ${STAMP}`;
  const job = await add({
    ...SCRIPTED_ROUTINES[0]!,
    name,
    schedule: { kind: "cron", expr: "0 9 * * *" },
  });
  await openRoutines();
  await row(name).click();
  await expect(view().getByTestId("routine-facts")).toContainText(
    "Time zoneThe gateway's own time zone",
  );
  const next = (await call<Job>("cron.get", { id: job.id })).state!.nextRunAtMs!;
  // The page is in New York (the browser's zone); the gateway's own zone is the host's.
  await expect(view().getByTestId("routine-next")).toHaveText(
    `${spelled(next, NY)}Your time. The schedule itself runs in the gateway's time zone.`,
  );
});

test("live: added shows a routine another client made", async () => {
  await openRoutines();
  const name = `Added elsewhere ${STAMP}`;
  await add(scriptedRoutine(name));
  await expect(row(name)).toBeVisible();
});

test("live: updated shows another client's change, and a pause", async () => {
  const job = await add(scriptedRoutine(`Before rename ${STAMP}`));
  await openRoutines();
  await expect(row(job.name)).toBeVisible();
  const renamed = `After rename ${STAMP}`;
  await call("cron.update", { id: job.id, patch: { name: renamed } });
  await expect(row(renamed)).toBeVisible();
  await expect(row(job.name)).toHaveCount(0);
  await call("cron.update", { id: job.id, patch: { enabled: false } });
  await expect(row(renamed)).toContainText("Paused");
});

test("live: removed takes the row away, and an open page says it was deleted", async () => {
  const listed = await add(scriptedRoutine(`Removed from list ${STAMP}`));
  const open = await add(scriptedRoutine(`Removed while open ${STAMP}`));
  await openRoutines();
  await expect(row(listed.name)).toBeVisible();
  await call("cron.remove", { id: listed.id });
  await expect(row(listed.name)).toHaveCount(0);
  await row(open.name).click();
  await call("cron.remove", { id: open.id });
  await expect(view().getByTestId("routine-deleted")).toContainText("This routine was deleted.");
  await expect(view().getByRole("heading", { name: open.name })).toBeVisible();
});

test("F-024: started marks the routine and its bot as working, and finished clears it with the run in its history", async () => {
  const name = `Slow run ${STAMP}`;
  const job = await add(scriptedRoutine(name, "otto", "#slow 8"));
  await openRoutines();
  await row(name).click();
  await expect(view().getByTestId("no-runs")).toBeVisible();
  const started = call<{ runId: string }>("cron.run", { id: job.id, mode: "force" });
  // started: the page, and Otto's row in the rail.
  await expect(view().getByTestId("routine-state")).toContainText("Running since", {
    timeout: 20_000,
  });
  await expect(view().locator('[data-testid="run-row"][data-running="true"]')).toBeVisible();
  await expect(botRow("Otto").first()).toHaveAttribute("data-state", "working");
  await expect(botRow("Otto").first()).toContainText(`Running ${name}`);
  // Its row under Otto opens the routine, where the run in progress is.
  const otto = botRow("Otto").first();
  if ((await otto.getAttribute("aria-expanded")) === "false") {
    await otto.focus();
    await page.keyboard.press("ArrowRight");
  }
  await view().getByRole("button", { name: "Back to routines" }).click();
  await page.getByTestId("routine-task").filter({ hasText: name }).click();
  await expect(view().getByRole("heading", { name })).toBeVisible();
  await expect(view().locator('[data-testid="run-row"][data-running="true"]')).toBeVisible();
  await started;
  // finished: the mark clears and the run is listed with how it ended.
  await expect(view().getByTestId("routine-state")).not.toContainText("Running", {
    timeout: 30_000,
  });
  await expect(botRow("Otto").first()).not.toContainText(`Running ${name}`);
  await expect(view().getByTestId("run-row")).toHaveCount(1);
  await expect(view().getByTestId("run-row").first()).toContainText("Succeeded");
  await expect(view().getByTestId("run-row").first()).toContainText("started by hand");
});

test("F-193: the latest routine run and tasks share the sidebar cap in recency order", async () => {
  const job = await add(scriptedRoutine(`Recent routine ${STAMP}`, "otto", "Note the time."));
  const tasks = page
    .locator(".bot-group")
    .filter({ has: page.locator('[data-bot="otto"]') })
    .locator('[data-testid="task"], [data-testid="routine-task"]');
  for (let index = 0; index < 6; index += 1)
    await call("sessions.create", {
      key: `agent:otto:recency-${STAMP}-${index}`,
      agentId: "otto",
      label: `Recency task ${index}`,
    });
  const otto = botRow("Otto").first();
  if ((await otto.getAttribute("aria-expanded")) === "false") {
    await otto.focus();
    await page.keyboard.press("ArrowRight");
  }
  await expect(tasks).toHaveCount(6);
  expect((await runNow(job.id)).run?.status).toBe("ok");
  await expect(tasks.first()).toContainText(job.name);
  await expect(tasks).toHaveCount(6);
});

test("F-190 F-193: a run opens its conversation as the run recorded it, from the routine's page and from the rail", async () => {
  const name = `Conversation ${STAMP}`;
  const job = await add(scriptedRoutine(name, "marlow", "Summarise my notes. #steps"));
  const ran = await runNow(job.id);
  expect(ran.run?.status).toBe("ok");
  // Changed after the run: the run still shows what it was given.
  await call("cron.update", {
    id: job.id,
    patch: { payload: { kind: "agentTurn", message: "Something else entirely." } },
  });
  await openRoutines();
  await row(name).click();
  await expect(view()).toContainText("Something else entirely.");
  await view().getByTestId("run-row").first().click();
  const message = view().getByTestId("scheduled-message");
  // The message as recorded with the run, whole: the job's words then the gateway's own.
  await expect(message.locator("> p")).toContainText("Summarise my notes. #steps\nCurrent time: ");
  await expect(message).toContainText("This is an unattended scheduled run.");
  await expect(message).not.toContainText("Something else entirely.");
  await expect(view().getByTestId("run-view")).toContainText(
    "I listed my workspace and read my instructions.",
  );
  await expect(view().getByTestId("run-view")).toContainText("600 tokens");
  // The rail: the routine's latest run under Marlow opens the same run.
  await view()
    .getByRole("button", { name: `Back to ${name}, all runs` })
    .click();
  await view().getByRole("button", { name: "Back to routines" }).click();
  // A bot's rows, its routine runs among them, show while it is unfolded.
  const marlow = botRow("Marlow").first();
  if ((await marlow.getAttribute("aria-expanded")) === "false") {
    await marlow.focus();
    await page.keyboard.press("ArrowRight");
  }
  const task = page.getByTestId("routine-task").filter({ hasText: name });
  await expect(task).toBeVisible();
  await task.click();
  await expect(view().getByTestId("scheduled-message")).toContainText("Summarise my notes. #steps");
  // The gateway normalizes an unbound current target back to isolated.
  const key = `agent:marlow:changed-target:${STAMP}`;
  await call("sessions.create", { key, agentId: "marlow" });
  await call("cron.update", {
    id: job.id,
    patch: { sessionTarget: "current", sessionKey: key },
  });
  expect(await call("cron.get", { id: job.id })).toMatchObject({
    sessionTarget: "current",
    sessionKey: key,
  });
  await view()
    .getByRole("button", { name: `Back to ${name}, all runs` })
    .click();
  await expect(view().getByTestId("routine-facts")).toContainText(
    "The conversation it was made in",
  );
  await view().getByTestId("run-row").first().click();
  await expect(view().getByTestId("scheduled-message")).toContainText("Summarise my notes. #steps");
});

test("F-190: shared routine runs open the recorded conversation", async () => {
  const title = `Bound conversation ${STAMP}`;
  const key = `agent:marlow:dashboard:${STAMP}`;
  await call("sessions.create", { key, agentId: "marlow", label: title });
  await call("sessions.create", { key: "agent:main:main", agentId: "main", label: "Main" });
  for (const target of ["current", `session:${key}`, "main"]) {
    const name = `Shared ${target} ${STAMP}`;
    const job = await add({
      ...scriptedRoutine(name, target === "main" ? "main" : "marlow", "Note the time."),
      sessionTarget: target,
      ...(target === "current" ? { sessionKey: key } : {}),
      ...(target === "main" ? { payload: { kind: "systemEvent", text: "A reminder." } } : {}),
    });
    expect((await runNow(job.id)).run?.status).toBe("ok");
    await openRoutines();
    await row(name).click();
    await view().getByTestId("run-row").first().click();
    await expect(view().getByTestId("run-summary")).toBeVisible();
    if (target === "main") {
      await view().getByRole("button", { name: "Open Juniper's main conversation" }).click();
      await expect(
        page.getByTestId("transcript").getByRole("heading", { name: "Main", exact: true }),
      ).toBeVisible();
    } else {
      await view().getByRole("button", { name: "Open conversation", exact: true }).click();
      await expect(
        page.getByTestId("transcript").getByRole("heading", { name: title }),
      ).toBeVisible();
    }
  }
});

test("F-355: a routine's page lists the 20 runs that finished most recently, in the gateway's order, when it has more", async () => {
  test.setTimeout(240_000);
  const name = `Many runs ${STAMP}`;
  // No directive: the scripted model's shortest reply.
  const job = await add(scriptedRoutine(name, "pip", "Note the time."));
  for (let index = 0; index < 22; index += 1) expect((await runNow(job.id)).ok).toBe(true);
  const all = await call<{ entries: RunEntry[] }>("cron.runs", { id: job.id, limit: 200 });
  expect(all.entries.length).toBe(22);
  // The gateway's order (newest finished first) is the contract; the page does not reorder it.
  const newest = all.entries.slice(0, 20).map((entry) => String(entry.runAtMs));
  await openRoutines();
  await row(name).click();
  const rows = view().locator('[data-testid="run-row"][data-run-at]');
  await expect(rows).toHaveCount(20);
  expect(
    await rows.evaluateAll((each) => each.map((el) => el.getAttribute("data-run-at"))),
  ).toEqual(newest);
});

test("F-197: the week calendar shows today's recorded run and the coming scheduled times, and moves by its arrows and keys", async () => {
  const digest = await add({ ...SCRIPTED_ROUTINES[0]!, name: `Calendar digest ${STAMP}` });
  await runNow(digest.id);
  await openRoutines();
  await view().getByRole("radio", { name: "Week" }).click();
  const calendar = view().getByTestId("calendar");
  // Today's forced run, from `cron.runs`, and each weekday morning still to come this week.
  await expect(calendar.locator('.r-occ[data-past="true"]', { hasText: digest.name })).toHaveCount(
    1,
  );
  const now = Date.now();
  const mornings = Array.from({ length: 7 }, (_, days) => {
    const [month, day, year] = new Intl.DateTimeFormat("en-US", { timeZone: NY })
      .format(now + days * 86_400_000)
      .split("/")
      .map(Number) as [number, number, number];
    return zonedTime(year, month, day, 8, 0, NY);
  }).filter((at) => {
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short" }).format(at);
    return at > now && weekday !== "Sat" && weekday !== "Sun";
  });
  await expect(calendar.locator(".r-occ:not([data-past])", { hasText: digest.name })).toHaveCount(
    mornings.length,
  );
  const range = calendar.getByTestId("calendar-range");
  const before = await range.textContent();
  await calendar.getByRole("button", { name: "Next 7 days" }).click();
  await expect(range).not.toHaveText(before!);
  await calendar.getByRole("button", { name: "Today" }).click();
  await expect(range).toHaveText(before!);
  // Left and Right move between chips on nearby days; the dates stay.
  const ran = calendar.locator('.r-occ[data-past="true"]', { hasText: digest.name });
  await ran.focus();
  await page.keyboard.press("ArrowRight");
  if (mornings.length > 0) {
    await expect(ran).not.toBeFocused();
    await expect(calendar.locator(".r-occ:focus")).toHaveCount(1);
  }
  await expect(range).toHaveText(before!);
  await view().getByRole("radio", { name: "List" }).click();
});
