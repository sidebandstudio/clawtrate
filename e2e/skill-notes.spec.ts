// The gateway's skill-change note against a real development gateway: this
// file's skill-review instance (`e2e-<id>-skills`, started with
// `--with-skill-review` and `--with-message-tool`), where a `#learn` turn makes
// the gateway review the task in the background, save a skill and append its
// note ("Learned: …") to the task about 30 seconds later. With "Show commands"
// off, the default, the note shows as any message does, in the conversation and
// as the bot's preview; so does a bot's own message sent with a key of the
// note's shape (`#send-keyed`), which the gateway writes with every field the
// note has (docs/parity.md F-560). The unread mark is the gateway's own, which
// the note does not raise.
//
// The instance is this file's own (`INSTANCE`), started and removed here, so a
// shard that does not run this file starts none.
//
// With CLAWTRATE_SKILL_NOTE_SHOTS=<folder outside the repository>, it also saves
// screenshots of what it checked there, at 1440 and 390 px.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { scriptedFinalText } from "../tools/dev-gateway/src/scenario-check.ts";
import { SEND_KEYED_KEY, SEND_KEYED_TEXT } from "../tools/dev-gateway/src/scenarios.ts";
import { newRunId, ownIdentity, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import {
  devGateway,
  FORBIDDEN_PORTS,
  listInstances,
  startHost,
  stopChild,
} from "./global-setup.ts";
import {
  cleanUp,
  readRecord,
  recordPath,
  saveRecord,
  TEMP_PREFIX,
  type RunRecord,
} from "./run-record.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
/**
 * This file's own instance, started with the gateway's background skill review by this file
 * alone, so only the shard that runs it starts one. It is recorded in a run record of this
 * file's own before it starts, so a run killed outright is cleaned up by the next `pnpm e2e`.
 */
const RUN = randomBytes(4).toString("hex");
const INSTANCE = `e2e-${RUN}-skills`;
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
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const SHOTS = process.env.CLAWTRATE_SKILL_NOTE_SHOTS ?? null;
const REPLY = scriptedFinalText("#learn");

test.describe.configure({ mode: "serial" });

let host: { child: ChildProcess; url: string; data: string } | null = null;
let page: Page;

type Json = Record<string, unknown>;
const meta = (row: Json) => (row.__openclaw ?? {}) as Json;
/** The row's idempotency key, under `__openclaw` or else on the row. */
const keyOf = (row: Json) => meta(row).idempotencyKey ?? row.idempotencyKey;
async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  const result = await openInstance(INSTANCE).runner.run([
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--json",
  ]);
  if (result.status !== 0) throw new Error(`${method} failed:\n${result.stdout}${result.stderr}`);
  return parseJsonOutput<T>(result.stdout);
}

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

/** One bridge command, over the host's own bridge socket, as another viewer of the page sends it. */
async function hostCommand(command: Json): Promise<void> {
  await page.evaluate(
    (command) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; id?: string };
          if (message.type === "hello")
            socket.send(JSON.stringify({ type: "command", id: "do", command }));
          else if (message.id === "do") {
            socket.close();
            resolve();
          }
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
      }),
    command,
  );
}

const botRow = (bot: string) => page.locator(`[data-testid="bot"][data-bot="${bot}"]`);
const transcript = () => page.getByTestId("transcript");

async function setCommandsShown(on: boolean): Promise<void> {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  const toggle = settings.getByRole("switch", { name: "Show commands" });
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
}

/** Screenshots of the page as it is, at 1440 and 390, when asked for. */
async function shots(name: string): Promise<void> {
  if (!SHOTS) return;
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
}

/**
 * A preview host on this file's instance, recorded by PID in this file's run record before its
 * gate opens, so a worker killed outright leaves a host the next run stops and a folder it
 * removes. A host that never becomes ready is stopped here.
 */
async function startRecordedHost(data: string): Promise<{ child: ChildProcess; url: string }> {
  record.hostPending = true;
  saveRecord(RECORDS, record);
  const started = startHost(INSTANCE, STATIC, data);
  const found = processIdentity(started.host.pid!);
  if (found.state !== "alive") {
    started.url.catch(() => {});
    started.gated.abort();
    throw new Error("could not record the preview host");
  }
  record.host = { pid: started.host.pid!, identity: found.identity };
  delete record.hostPending;
  saveRecord(RECORDS, record);
  started.gated.release();
  try {
    return { child: started.host, url: await started.url };
  } catch (error) {
    await stopChild(started.host);
    throw error;
  }
}

/** Stop the preview host and start another on the same data, as the app quit and opened again. */
async function restartHost(): Promise<void> {
  await stopChild(host!.child);
  host = { ...host!, ...(await startRecordedHost(host!.data)) };
  await page.goto(host.url);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  const self = ownIdentity();
  record.runner.identity = self;
  const runId = newRunId();
  record.instances.push({ name: INSTANCE, runId });
  saveRecord(RECORDS, record);
  cli(
    "start",
    "--run-id",
    runId,
    "--instance",
    INSTANCE,
    "--with-skill-review",
    "--with-message-tool",
    "--no-seed",
  );
  const mine = listInstances().find((each) => each.name === INSTANCE);
  expect(mine?.gatewayRunning, "this file's skill-review instance runs").toBe(true);
  for (const port of [mine!.gatewayPort, mine!.providerPort]) {
    expect(port !== null && !FORBIDDEN_PORTS.includes(port), `port ${port}`).toBe(true);
  }
  const data = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  record.dirs.push(data);
  saveRecord(RECORDS, record);
  host = { ...(await startRecordedHost(data)), data };
  // What a later run's clean-up would read: the instance, the host by PID, and its folder.
  expect(readRecord(recordPath(RECORDS, record.run))).toMatchObject({
    instances: [{ name: INSTANCE, runId }],
    host: { pid: host.child.pid },
    dirs: [data],
  });
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(host.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  // A connection that writes, so opening a task reads it on the gateway, as most viewers do.
  await hostCommand({ type: "requestAccess" });
  await approve();
  await expect(page.getByTestId("plus")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  if (host) await stopChild(host.child);
  // This file's host, folder and instance, stopped by their recorded processes and removed.
  const problems = cleanUp(RECORDS, record, (name, runId) =>
    cli("reset", "--run-id", runId, "--instance", name),
  );
  expect(problems).toEqual([]);
});

test("F-560: a real skill note shows in the default conversation and as the bot's preview", async () => {
  test.setTimeout(300_000);
  const key = `agent:main:skill-note-${Date.now()}`;
  await gatewayCall("chat.send", { sessionKey: key, message: "#learn", idempotencyKey: key });

  // The person reads the bot's reply, then goes to another bot before the review ends.
  await botRow("main").click();
  await expect(transcript()).toContainText(REPLY, { timeout: 60_000 });
  const other = page.locator('[data-testid="bot"]:not([data-bot="main"])').first();
  await other.click();
  await expect(botRow("main")).not.toHaveAttribute("aria-current", "true");

  // The gateway's review saves the skill and appends its note, under its key.
  let note: Json | undefined;
  await expect
    .poll(
      async () => {
        const history = await gatewayCall<{ messages: Json[] }>("chat.history", {
          sessionKey: key,
        });
        note = history.messages.find((row) =>
          /^skill-workshop-notice:skill-workshop-review:/.test(String(keyOf(row))),
        );
        return note !== undefined;
      },
      { timeout: 150_000, intervals: [5_000] },
    )
    .toBe(true);
  const noteText = String((note!.content as Json[])[0]!.text);
  expect(noteText).toMatch(/^💾 Learned: created `trail-check/);
  expect([note!.api, note!.provider, note!.model]).toEqual([
    "openclaw-transcript",
    "openclaw",
    "delivery-mirror",
  ]);

  // The note sends no sessions.changed, so the host's list still has the reply. The app opened
  // again reads the list fresh: the gateway's row now has the note as its preview and time.
  // On this connection, which writes, the unread mark is the gateway's own: the note, which came
  // after the person read the task, did not raise it.
  await restartHost();
  await expect(botRow("main")).toBeVisible({ timeout: 30_000 });
  await expect(botRow("main").locator(".unread-dot")).toHaveCount(0);
  await expect(botRow("main")).not.toHaveAccessibleName(/, unread/);

  // With Show commands off, the note is in the conversation after the reply, drawn as the bot's
  // words are (its code marks are formatting), and is the bot's preview.
  await setCommandsShown(false);
  await botRow("main").click();
  await expect(transcript()).toContainText(REPLY, { timeout: 60_000 });
  await expect(transcript()).toContainText(noteText.replaceAll("`", ""));
  const text = await transcript().innerText();
  expect(text.indexOf("Learned:")).toBeGreaterThan(text.lastIndexOf(REPLY));
  await expect(botRow("main").locator(".bot-preview")).toContainText(
    "Learned: created trail-check",
  );
  await shots("note-shown");
});

test("F-560: a bot's message sent with a key of the note's shape shows with Show commands off", async () => {
  test.setTimeout(120_000);
  const key = `agent:main:keyed-${Date.now()}`;
  await gatewayCall("chat.send", { sessionKey: key, message: "#send-keyed", idempotencyKey: key });

  // The gateway copies the bot's message into the task with every field its own note has.
  let row: Json | undefined;
  await expect
    .poll(
      async () => {
        const history = await gatewayCall<{ messages: Json[] }>("chat.history", {
          sessionKey: key,
        });
        row = history.messages.find((each) => keyOf(each) === SEND_KEYED_KEY);
        return row !== undefined;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  expect([row!.role, row!.api, row!.provider, row!.model, row!.idempotencyKey]).toEqual([
    "assistant",
    "openclaw-transcript",
    "openclaw",
    "delivery-mirror",
    SEND_KEYED_KEY,
  ]);
  expect(row!.content).toEqual([{ type: "text", text: SEND_KEYED_TEXT }]);

  // With Show commands off, it is in the conversation and is the bot's preview.
  await setCommandsShown(false);
  await page.locator('[data-testid="bot"]:not([data-bot="main"])').first().click();
  await botRow("main").click();
  await expect(transcript()).toContainText(SEND_KEYED_TEXT, { timeout: 60_000 });
  await expect(botRow("main").locator(".bot-preview")).toHaveText(SEND_KEYED_TEXT);
  await shots("keyed-message-shown");
});
