// Changing routines against a real development gateway (automation.md
// sections 9 to 13): this run's own instance, a preview host of its own that
// starts at the read tier and asks for admin by its button, and a paired
// admin operator that plays the gateway's other clients. What a check did is
// read back from the gateway (`cron.get`, `cron.list`, `cron.runs`), never
// only from the screen. Each check names its routines with this run's stamp,
// and they are removed afterwards.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { setHooks, withScheduler } from "../tools/dev-gateway/src/routine-gateway.ts";
import { scriptedRoutine } from "../tools/dev-gateway/src/routines.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const STAMP = Date.now().toString(36);
const NY = "America/New_York";

test.describe.configure({ mode: "serial" });

type Job = {
  id: string;
  name: string;
  enabled: boolean;
  declarationKey?: string;
  schedule: { kind: string; expr?: string; tz?: string; at?: string; everyMs?: number };
  payload: { kind: string; message?: string; text?: string };
  delivery?: Record<string, unknown>;
  state?: { nextRunAtMs?: number; runningAtMs?: number; lastRunAtMs?: number };
};

let host: { child: ChildProcess; data: string } | null = null;
let page: Page;
let admin: OperatorSession;
const made = new Set<string>();

const call = <T>(method: string, params: unknown) => admin.request(method, params) as Promise<T>;
const gatewayCall = (method: string, params: unknown) => admin.request(method, params);

async function add(routine: ReturnType<typeof scriptedRoutine>): Promise<Job> {
  const job = await call<Job>("cron.add", routine);
  made.add(job.id);
  return job;
}
const get = (id: string) => call<Job>("cron.get", { id });
async function byName(name: string): Promise<Job | undefined> {
  const { jobs } = await call<{ jobs: Job[] }>("cron.list", { includeDisabled: true, limit: 200 });
  const job = jobs.find((each) => each.name === name);
  if (job) made.add(job.id);
  return job;
}

const view = () => page.getByTestId("routines-view");
const editor = () => page.getByTestId("routine-editor");
const row = (name: string) => view().getByTestId("routine-row").filter({ hasText: name });
const save = () => editor().getByRole("button", { name: "Save", exact: true });

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

async function openRoutines(): Promise<void> {
  if (await view().count()) {
    const back = view().getByRole("button", { name: /^Back to (the routine|routines)$/ });
    while (await back.count()) await back.first().click();
    await view().getByRole("combobox", { name: "Bots" }).selectOption({ label: "All bots" });
    return;
  }
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(view()).toBeVisible();
}

async function openPage(name: string): Promise<void> {
  await openRoutines();
  await row(name).locator(".r-row-main").click();
  await expect(view().getByRole("heading", { name })).toBeVisible();
}

/** One bridge command from another viewer of the host, and its answer. */
async function bridgeCommand(command: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    (command) =>
      new Promise<unknown>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; id?: string };
          if (message.type === "hello")
            socket.send(JSON.stringify({ type: "command", id: "do", command }));
          else if (message.id === "do") {
            socket.close();
            resolve(message);
          }
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
      }),
    command,
  );
}

// Control when one write's answer reaches the page while gateway events still go through.
type Reply = (value?: unknown) => void;
let heldWrite: { type: string; forward: boolean; ready: (reply: Reply) => void } | null = null;
const unanswered = { status: "unknown", error: "The gateway didn't answer." };

function holdWrite(type: "updateRoutine" | "removeRoutine", forward: boolean): Promise<Reply> {
  const ready = Promise.withResolvers<Reply>();
  heldWrite = { type, forward, ready: ready.resolve };
  return ready.promise;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate routine editing check",
    ["operator.admin", "operator.read"],
    [],
  );
  const data = mkdtempSync(join(tmpdir(), "clawtrate-routines-edit-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  host = { child: started.host, data };
  const url = await started.url;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: NY,
    locale: "en-US",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  page = await context.newPage();
  await page.routeWebSocket(/\/bridge$/, (ws) => {
    const server = ws.connectToServer();
    let hold: { id: string; ready: (reply: Reply) => void } | null = null;
    ws.onMessage((message) => {
      const request = JSON.parse(String(message)) as { id: string; command?: { type: string } };
      const write = heldWrite;
      if (write && request.command?.type === write.type) {
        heldWrite = null;
        if (write.forward) hold = { id: request.id, ready: write.ready };
        else {
          write.ready((value) =>
            ws.send(JSON.stringify({ type: "result", id: request.id, ok: true, value })),
          );
          return;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const response = JSON.parse(String(message)) as {
        type: string;
        id?: string;
        value?: unknown;
      };
      if (hold && response.type === "result" && response.id === hold.id) {
        hold.ready((value = response.value) => ws.send(JSON.stringify({ ...response, value })));
        hold = null;
      } else ws.send(message);
    });
  });
  await page.goto(url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  for (const id of made) await call("cron.remove", { id }).catch(() => {});
  await setHooks(gatewayCall, false).catch(() => {});
  await admin?.close();
  await page?.context().close();
  if (host) {
    await stopChild(host.child).catch(() => host?.child.kill("SIGKILL"));
    rmSync(host.data, { recursive: true, force: true });
  }
});
process.once("exit", () => host?.child.kill("SIGKILL"));

test("on the read tier nothing that writes is offered, and a write sent anyway is refused before it reaches the gateway", async () => {
  const job = await add(scriptedRoutine(`Read only ${STAMP}`));
  await openRoutines();
  await expect(row(job.name)).toBeVisible();
  await expect(view().getByRole("switch")).toHaveCount(0);
  await expect(view().getByTestId("new-routine")).toHaveCount(0);
  await expect(view().getByTestId("admin-bar")).toContainText(
    "Read-only. Creating and changing routines needs admin access.",
  );
  await row(job.name).locator(".r-row-main").click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Open"]);
  await page.keyboard.press("Escape");
  await openPage(job.name);
  await expect(view().getByTestId("routine-actions")).toHaveCount(0);
  // The bridge's own commands are refused below admin as well: nothing reaches the gateway.
  const answer = (await bridgeCommand({ type: "removeRoutine", id: job.id })) as {
    value?: unknown;
  };
  expect(JSON.stringify(answer)).toContain('"not-sent"');
  expect((await get(job.id)).id).toBe(job.id);
});

test("admin is asked for by its button only, and once approved the controls appear", async () => {
  test.setTimeout(120_000);
  await openRoutines();
  const bar = view().getByTestId("admin-bar");
  await bar.getByRole("button", { name: "Request admin access" }).click();
  await expect(bar).toContainText("Waiting for the gateway's owner.", { timeout: 15_000 });
  await approve();
  await expect(view().getByTestId("admin-bar")).toContainText("Admin access granted.", {
    timeout: 30_000,
  });
  await expect(view().getByTestId("new-routine")).toBeVisible();
  await expect(view().getByRole("switch").first()).toBeVisible();
});

test("F-189 F-354: a routine made in the form is on the gateway as written, and with the scheduler on it waits for its slot", async () => {
  test.setTimeout(120_000);
  const name = `Made here ${STAMP}`;
  await withScheduler(gatewayCall, async () => {
    await openRoutines();
    await view().getByTestId("new-routine").click();
    await editor().getByLabel("Bot").selectOption({ label: "Marlow" });
    await editor().getByLabel("Name").fill(name);
    await editor().getByLabel("Instruction").fill("#text");
    await editor().getByRole("radio", { name: "Every few hours or minutes" }).click();
    await editor().getByLabel("Every").fill("5");
    await save().click();
    await expect(view().getByRole("heading", { name })).toBeVisible({ timeout: 15_000 });
    await expect(view().getByTestId("no-runs")).toContainText("No runs yet. The first is due");
    const job = (await byName(name))!;
    expect(job).toMatchObject({
      agentId: "marlow",
      schedule: { kind: "every", everyMs: 300_000 },
      payload: { kind: "agentTurn", message: "#text" },
      delivery: { mode: "none" },
    });
    expect(job.declarationKey).toMatch(/^clawtrate:/u);
    // Creating it does not run it: with the scheduler on, it waits for its slot.
    await page.waitForTimeout(6_000);
    expect(
      (await call<{ entries: unknown[] }>("cron.runs", { id: job.id, limit: 5 })).entries,
    ).toEqual([]);
    expect((await get(job.id)).state?.lastRunAtMs).toBeUndefined();
    expect((await get(job.id)).state!.nextRunAtMs!).toBeGreaterThan(Date.now() + 60_000);
  });
});

test("F-189: a refused save says the gateway's reason and keeps what was typed", async () => {
  const name = `Never fires ${STAMP}`;
  await openRoutines();
  await view().getByTestId("new-routine").click();
  await editor().getByLabel("Name").fill(name);
  await editor().getByLabel("Instruction").fill("#text");
  await editor().locator("summary", { hasText: "More" }).click();
  await editor().getByLabel("Cron expression").fill("0 0 30 2 *");
  await save().click();
  await expect(editor().getByTestId("editor-refused")).toContainText(
    'The gateway didn\'t save this. invalid cron.add params: cron expression "0 0 30 2 *" has no upcoming run time',
  );
  await expect(editor().getByLabel("Name")).toHaveValue(name);
  expect(await byName(name)).toBeUndefined();
  await editor().getByRole("button", { name: "Cancel" }).click();
});

test("F-189: a new name leaves a one-time schedule's saved time and the instruction as the gateway has them", async () => {
  const at = new Date(Date.now() + 40 * 86_400_000).toISOString().replace(/\.\d+Z$/u, ".000Z");
  const job = await add({
    ...scriptedRoutine(`Once ${STAMP}`),
    schedule: { kind: "at", at },
  });
  await openPage(job.name);
  await view().getByRole("button", { name: "Edit", exact: true }).click();
  await editor().getByLabel("Name").fill(`Once renamed ${STAMP}`);
  await save().click();
  await expect(view().getByRole("heading", { name: `Once renamed ${STAMP}` })).toBeVisible();
  const after = await get(job.id);
  expect(after.name).toBe(`Once renamed ${STAMP}`);
  expect(Date.parse(after.schedule.at!)).toBe(Date.parse(at));
  expect(after.payload).toMatchObject({ kind: "agentTurn", message: "#steps" });
});

test("F-189: Once writes the chosen time in its zone as an instant", async () => {
  const job = await add(scriptedRoutine(`Becomes once ${STAMP}`));
  await openPage(job.name);
  await view().getByRole("button", { name: "Edit", exact: true }).click();
  await editor().getByRole("radio", { name: "Once" }).click();
  await editor().getByLabel("On", { exact: true }).fill("2035-01-01");
  await editor().getByLabel("At", { exact: true }).fill("09:00");
  await editor().getByLabel("Time zone").selectOption("Europe/Paris");
  await save().click();
  await expect(editor()).toHaveCount(0, { timeout: 15_000 });
  expect((await get(job.id)).schedule).toEqual({ kind: "at", at: "2035-01-01T08:00:00.000Z" });
});

test("F-189: another client's change while the editor is open is shown before saving, and nothing of theirs is overwritten", async () => {
  const job = await add(scriptedRoutine(`Contested ${STAMP}`));
  await openPage(job.name);
  await view().getByRole("button", { name: "Edit", exact: true }).click();
  await editor().getByLabel("Name").fill(`Contested, mine ${STAMP}`);
  await call("cron.update", {
    id: job.id,
    patch: { payload: { kind: "agentTurn", message: "#text theirs" } },
  });
  const note = editor().getByTestId("editor-changed");
  await expect(note).toContainText("This routine was changed elsewhere while you were editing.");
  await note.getByRole("button", { name: "Show the new version" }).click();
  await expect(editor().getByLabel("Instruction")).toHaveValue("#text theirs");
  await expect(editor().getByTestId("your-version")).toBeVisible();
  // Nothing was written while the note was up.
  expect((await get(job.id)).name).toBe(job.name);
  await editor().getByLabel("Name").fill(`Contested, merged ${STAMP}`);
  await save().click();
  await expect(editor()).toHaveCount(0, { timeout: 15_000 });
  expect(await get(job.id)).toMatchObject({
    name: `Contested, merged ${STAMP}`,
    payload: { message: "#text theirs" },
  });
});

test("F-189: accepting a conflict saves only fields edited from the original", async () => {
  const job = await add(scriptedRoutine(`Overwrite ${STAMP}`));
  const name = `My name ${STAMP}`;
  await openPage(job.name);
  await view().getByRole("button", { name: "Edit", exact: true }).click();
  await editor().getByLabel("Name").fill(name);
  await call("cron.update", {
    id: job.id,
    patch: { payload: { kind: "agentTurn", message: "Their new instruction." } },
  });
  await editor().getByRole("button", { name: "Save mine anyway" }).click();
  await expect(editor()).toHaveCount(0);
  expect(await get(job.id)).toMatchObject({ name, payload: { message: "Their new instruction." } });
});

test("F-189: a late save answer leaves a deleted routine's draft available as new", async () => {
  const job = await add(scriptedRoutine(`Delete during save ${STAMP}`));
  const name = `Keep this draft ${STAMP}`;
  await openPage(job.name);
  await view().getByRole("button", { name: "Edit", exact: true }).click();
  await editor().getByLabel("Name").fill(name);
  const held = holdWrite("updateRoutine", true);
  await save().click();
  const reply = await held;
  await call("cron.remove", { id: job.id });
  await expect(editor().getByTestId("editor-deleted")).toBeVisible();
  reply();
  await editor().getByRole("button", { name: "Save as a new routine" }).click();
  await expect(editor()).toHaveCount(0);
  await expect(view().getByRole("heading", { name })).toBeVisible();
  expect((await byName(name))?.id).not.toBe(job.id);
  await expect(get(job.id)).rejects.toThrow(/not found/iu);
});

test("F-189: checking an unanswered edit shows a conflict only when the write differs", async () => {
  for (const lands of [false, true]) {
    const job = await add(scriptedRoutine(`Unanswered ${lands} ${STAMP}`));
    const name = `My unanswered edit ${lands} ${STAMP}`;
    await openPage(job.name);
    await view().getByRole("button", { name: "Edit", exact: true }).click();
    await editor().getByLabel("Name").fill(name);
    const held = holdWrite("updateRoutine", lands);
    await save().click();
    const reply = await held;
    const liveName = lands ? name : `Their edit ${STAMP}`;
    if (!lands) await call("cron.update", { id: job.id, patch: { name: liveName } });
    await expect(view().locator("h1")).toHaveText(liveName);
    reply(unanswered);
    const conflict = editor().getByTestId("editor-changed");
    const unknown = editor().getByTestId("editor-unknown");
    await expect(conflict).toHaveCount(0);
    await unknown.getByRole("button", { name: "Check now" }).click();
    if (lands) {
      await expect(unknown).toContainText(`${name} now reads as you typed it.`);
      await expect(conflict).toHaveCount(0);
      await unknown.getByRole("button", { name: "Close" }).click();
    } else {
      await expect(conflict).toBeVisible();
      await expect(unknown).toHaveCount(0);
      await conflict.getByRole("button", { name: "Save mine anyway" }).click();
      await expect(editor()).toHaveCount(0);
    }
    expect((await get(job.id)).name).toBe(name);
  }
});

test("F-189: a reminder in the main conversation keeps its text: renaming it never sends its payload", async () => {
  const job = await add({
    ...scriptedRoutine(`Reminder ${STAMP}`, "main"),
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "Stand up and stretch." },
  } as unknown as ReturnType<typeof scriptedRoutine>);
  await openPage(job.name);
  await view().getByRole("button", { name: "Edit", exact: true }).click();
  await expect(editor()).toContainText("This reminder's text was set on the gateway.");
  await editor().getByLabel("Name").fill(`Reminder renamed ${STAMP}`);
  await save().click();
  await expect(editor()).toHaveCount(0, { timeout: 15_000 });
  expect(await get(job.id)).toMatchObject({
    name: `Reminder renamed ${STAMP}`,
    payload: { kind: "systemEvent", text: "Stand up and stretch." },
  });
});

test("F-350: the switch pauses and resumes it on the gateway, and the list says Paused", async () => {
  const job = await add(scriptedRoutine(`Switch ${STAMP}`));
  await openRoutines();
  await row(job.name).getByRole("switch").click();
  await expect(row(job.name)).toContainText("Paused · Every hour");
  expect((await get(job.id)).enabled).toBe(false);
  await openPage(job.name);
  await expect(view().getByTestId("routine-state")).toHaveText(
    "Paused. It won't run until resumed.",
  );
  await view().getByRole("button", { name: "Resume" }).click();
  await expect(view().getByTestId("routine-state")).toHaveText("Runs every hour.");
  expect((await get(job.id)).enabled).toBe(true);
});

test("F-351: Run now runs it, reads Running until done, and says when one is already running", async () => {
  test.setTimeout(120_000);
  const job = await add(scriptedRoutine(`Run now ${STAMP}`, "otto", "#slow 4"));
  await openPage(job.name);
  await view().getByRole("button", { name: "Run now" }).click();
  await expect(view().getByTestId("routine-state")).toContainText("Running since", {
    timeout: 15_000,
  });
  await expect(view().getByTestId("run-row").first()).toContainText("Running…");
  await view().getByRole("button", { name: "Run now" }).click();
  await expect(view().getByTestId("run-note")).toHaveText("It's already running.");
  await expect(view().getByTestId("run-row").first()).toContainText("started by hand", {
    timeout: 60_000,
  });
  // A paused routine runs once and stays paused.
  await call("cron.update", { id: job.id, patch: { enabled: false } });
  await expect(view().getByRole("button", { name: "Run once now" })).toBeVisible();
});

test("F-352: an unanswered delete checks both a routine still present and a routine already gone", async () => {
  const job = await add(scriptedRoutine(`Delete me ${STAMP}`));
  await openPage(job.name);
  await view().getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByTestId("routine-delete");
  await expect(dialog).toContainText(
    "It won't run again, and Clawtrate can't show its runs afterwards. It hasn't run yet.",
  );
  const missed = holdWrite("removeRoutine", false);
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  (await missed)(unanswered);
  const check = dialog.getByRole("button", { name: "Check now" });
  await expect(check).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Delete again" })).toHaveCount(0);
  await check.click();
  await expect(dialog).toContainText(
    "The gateway still lists this routine. The delete may still arrive.",
  );
  expect((await get(job.id)).id).toBe(job.id);
  const landed = holdWrite("removeRoutine", true);
  await dialog.getByRole("button", { name: "Delete again" }).click();
  (await landed)(unanswered);
  await expect(check).toBeFocused();
  await check.click();
  await expect(dialog).toHaveCount(0);
  await expect(view().getByRole("heading", { name: "Routines" })).toBeVisible();
  await expect(row(job.name)).toHaveCount(0);
  await expect(get(job.id)).rejects.toThrow(/not found/iu);
  made.delete(job.id);
});

test("F-192: a routine's menu pauses, runs, edits and deletes it", async () => {
  const job = await add(scriptedRoutine(`Menu ${STAMP}`));
  await openRoutines();
  await row(job.name).locator(".r-row-main").click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
    "Open",
    "Pause",
    "Run now",
    "Edit…",
    "Delete…",
  ]);
  await page.getByRole("menuitem", { name: "Pause" }).click();
  await expect(row(job.name)).toContainText("Paused");
  expect((await get(job.id)).enabled).toBe(false);
  await row(job.name).locator(".r-row-main").focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  await expect(editor().getByLabel("Name")).toHaveValue(job.name);
  await editor().getByRole("button", { name: "Cancel" }).click();
});

test("F-195: the form keeps schedules five minutes apart, though the gateway itself takes less", async () => {
  await openRoutines();
  await view().getByTestId("new-routine").click();
  await editor().getByLabel("Name").fill(`Too often ${STAMP}`);
  await editor().getByLabel("Instruction").fill("#text");
  await editor().locator("summary", { hasText: "More" }).click();
  await editor().getByLabel("Cron expression").fill("*/7 * * * *");
  await save().click();
  await expect(editor()).toContainText("Routines run at least 5 minutes apart.");
  expect(await byName(`Too often ${STAMP}`)).toBeUndefined();
  await editor().getByRole("button", { name: "Cancel" }).click();
});

test("F-196: a time-zone change asks again when an unlisted routine would be changed", async () => {
  const one = await add({
    ...scriptedRoutine(`Zone a ${STAMP}`, "pip"),
    schedule: { kind: "cron", expr: "0 9 * * *", tz: NY },
  });
  const two = await add({
    ...scriptedRoutine(`Zone b ${STAMP}`, "pip"),
    schedule: { kind: "cron", expr: "30 17 * * 1-5", tz: "Europe/London" },
  });
  await openRoutines();
  await view().getByRole("combobox", { name: "Bots" }).selectOption({ label: "Pip" });
  const line = view().getByTestId("routines-zone");
  await expect(line).toContainText("Mixed: New York, London");
  await line.getByRole("button", { name: "Change…" }).click();
  const dialog = page.getByTestId("routines-zone-dialog");
  await dialog.getByLabel("Time zone").selectOption("Asia/Tokyo");
  const three = await add({
    ...scriptedRoutine(`Zone c ${STAMP}`, "pip"),
    schedule: { kind: "cron", expr: "0 7 * * *", tz: NY },
  });
  await expect(dialog).not.toContainText(three.name);
  const confirm = dialog.getByRole("button", { name: "Save" });
  await confirm.click();
  await expect(dialog.getByTestId("zone-reconfirm")).toBeVisible();
  await expect(dialog).toContainText(three.name);
  expect((await get(one.id)).schedule.tz).toBe(NY);
  expect((await get(two.id)).schedule.tz).toBe("Europe/London");
  expect((await get(three.id)).schedule.tz).toBe(NY);
  await confirm.click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  expect((await get(one.id)).schedule).toEqual({
    kind: "cron",
    expr: "0 9 * * *",
    tz: "Asia/Tokyo",
  });
  expect((await get(two.id)).schedule).toEqual({
    kind: "cron",
    expr: "30 17 * * 1-5",
    tz: "Asia/Tokyo",
  });
  expect((await get(three.id)).schedule.tz).toBe("Asia/Tokyo");
  await expect(line).toContainText("Routines' time zone: Tokyo");
});

test("F-349 F-358: with the gateway's hooks on, the page shows their address to copy, and a POST to it starts a bot, not the routine", async () => {
  test.setTimeout(120_000);
  const job = await add(scriptedRoutine(`Hooks ${STAMP}`));
  const token = (await setHooks(gatewayCall, true))!;
  await openPage(job.name);
  await expect(view().getByTestId("routine-facts")).toContainText(
    "This gateway's webhooks start a bot directly, not a routine.",
  );
  const hooks = view().getByTestId("gateway-hooks");
  await hooks.getByText("Gateway webhooks").click();
  const address = (await hooks.locator("code").textContent())!;
  expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\/agent$/u);
  await expect(hooks).toContainText("Key: kept on the gateway.");
  await expect(hooks).not.toContainText(token);
  await hooks.getByRole("button", { name: "Copy the webhook address" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
  // The address answers: 200 and a run id for a bot's turn. The routine did not run.
  const response = await fetch(address, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message: "#text", agentId: "marlow" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, runId: expect.any(String) });
  expect(
    (await call<{ entries: unknown[] }>("cron.runs", { id: job.id, limit: 5 })).entries,
  ).toEqual([]);
  await setHooks(gatewayCall, false);
  await openPage(job.name);
  await expect(view().getByTestId("gateway-hooks")).toHaveCount(0);
});
