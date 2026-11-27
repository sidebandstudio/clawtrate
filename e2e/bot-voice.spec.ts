// Bot voice against a real development gateway: an instance of its own, seeded,
// that loads plugins/clawtrate-voice with its conversation hook allowed (its
// contract addition), so no task or prompt change of this check reaches another
// spec. A preview host of its own, granted the interactive tier, turns
// the setting off and on in Settings; the scripted model's record of each
// request shows whether the guide reached the system prompt of each of the
// four seeded bots. The switch showing at all proves the hello lists the
// plugin's methods. The setting is left on, as it started.
//
// The instance is this file's own: started in its beforeAll and reset in its
// afterAll, so only the shard that runs this file starts it. It is recorded,
// with the preview host and its folder, in a run record of this file's own
// before each starts, so a run killed outright is cleaned up by the next
// `pnpm e2e`.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeUntilGone, type Presence } from "../tools/dev-gateway/src/cleanup.ts";
import { instancePorts, openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { SYSTEM_PROMPT_PATH } from "../tools/dev-gateway/src/fake-provider.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { newRunId, ownIdentity, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import { approveDevice } from "./approve.ts";
import {
  devGateway,
  FORBIDDEN_PORTS,
  listInstances,
  resetInstance,
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

/**
 * This spec's own run record, beside global setup's: its instance, its preview host and that
 * host's data folder are written here before each starts, so an interrupted worker's instance is
 * reset, its host stopped by PID and its folder removed by the next run's clean-up.
 */
const RECORDS = join(import.meta.dirname, "../tools/dev-gateway/.run/e2e");
const record: RunRecord = {
  run: randomBytes(4).toString("hex"),
  runner: { pid: process.pid, identity: "" },
  instances: [],
  host: null,
  dirs: [],
};
/** This spec's own seeded instance, with the voice plugin, which no other spec uses. */
const INSTANCE = `e2e-${record.run}-voice`;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const GUIDE = readFileSync(
  new URL("../plugins/clawtrate-voice/voice.md", import.meta.url),
  "utf8",
).trim();
/** Each paragraph of the guide, with its heading: none of them may reach a prompt while it's off. */
const GUIDE_PARTS = GUIDE.split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

let host: { child: ChildProcess; data: string } | null = null;
/**
 * Every task this check makes, by a key chosen before it is asked for, so a create whose
 * answer is lost is still removed: later checks in the shard see the seed's tasks only.
 */
const made = new Set<string>();
const RUN = randomBytes(4).toString("hex");
const taskKey = (agentId: string) => `agent:${agentId}:voice-check-${RUN}`;

/** Every create this check sent, settled or not: teardown waits for each before it looks. */
const creates = new Set<Promise<unknown>>();

/** Whether the gateway has the task now: asked for that key itself, never inferred from a list. */
async function present(key: string): Promise<Presence> {
  return gatewayCall<{ session: { sessionId?: string } | null }>("sessions.describe", { key }).then(
    (result) => Boolean(result.session?.sessionId),
    () => "unknown" as const,
  );
}

/** A gateway method with an instance's own operator credentials, through the guarded runner. */
async function gatewayCall<T>(method: string, params: unknown, instance = INSTANCE): Promise<T> {
  const result = await openInstance(instance).runner.run([
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--json",
  ]);
  // The gateway's refusal comes on stdout, the CLI's own complaints on stderr.
  if (result.status !== 0)
    throw new Error(`gateway call ${method} failed: ${result.stdout}${result.stderr}`);
  return parseJsonOutput<T>(result.stdout);
}

/** Stops any run, archives, then deletes the task with its transcript; one already gone is left. */
async function removeTask(key: string): Promise<void> {
  const row = await gatewayCall<{ session: { sessionId?: string; archived?: boolean } }>(
    "sessions.describe",
    { key },
  )
    .then((result) => result.session)
    .catch(() => null);
  if (!row?.sessionId) return;
  await gatewayCall("chat.abort", { sessionKey: key }).catch(() => {});
  if (!row.archived)
    await gatewayCall("sessions.patch", {
      key,
      archived: true,
      expectedSessionId: row.sessionId,
    }).catch(() => {});
  await gatewayCall("sessions.delete", {
    key,
    archivedOnly: true,
    deleteTranscript: true,
    expectedSessionId: row.sessionId,
  }).catch(() => {});
}
let gateway: OperatorSession;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(480_000);
  // Recorded before anything starts: the instance, then the host's folder, then the host.
  const self = ownIdentity();
  record.runner.identity = self;
  const runId = newRunId();
  record.instances.push({ name: INSTANCE, runId });
  saveRecord(RECORDS, record);
  // Its own gateway, never the one the other specs share: what it leaves stays there.
  expect(INSTANCE).not.toBe(process.env.CLAWTRATE_DEV_INSTANCE);
  // Seeded for its four bots, with the voice plugin and its conversation hook (F-527).
  process.stdout.write(
    devGateway(INSTANCE, "start", "--run-id", runId, "--with-plugin", "clawtrate-voice"),
  );
  const mine = listInstances().find((row) => row.name === INSTANCE);
  if (!mine?.gatewayRunning) throw new Error(`instance ${INSTANCE} is not running`);
  for (const port of [mine.gatewayPort, mine.providerPort]) {
    if (port === null || FORBIDDEN_PORTS.includes(port)) {
      throw new Error(`instance ${INSTANCE} is on port ${port}, which e2e never uses`);
    }
  }
  // And the shared gateway doesn't have the voice plugin at all: to its own operator, an admin,
  // the plugin's read is a method it doesn't know.
  await expect(
    gatewayCall("clawtrate-voice.get", {}, process.env.CLAWTRATE_DEV_INSTANCE!),
  ).rejects.toThrow(/unknown method/);
  gateway = await openOperator(
    openInstance(INSTANCE),
    "Bot voice checks",
    ["operator.read", "operator.write"],
    [],
  );
  const data = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  record.dirs.push(data);
  record.hostPending = true;
  saveRecord(RECORDS, record);
  const started = startHost(INSTANCE, STATIC, data);
  // Teardown's to stop from here, whatever fails before the host is released; a startup that
  // ends with the gate closed is observed here, and still fails the await below.
  host = { child: started.host, data };
  started.url.catch(() => {});
  try {
    const found = processIdentity(started.host.pid!);
    if (found.state !== "alive") throw new Error("could not record the voice check's preview host");
    record.host = { pid: started.host.pid!, identity: found.identity };
    delete record.hostPending;
    saveRecord(RECORDS, record);
    // What a later run's clean-up would read: the instance, the host by PID, and its folder.
    expect(readRecord(recordPath(RECORDS, record.run))).toMatchObject({
      instances: [{ name: INSTANCE, runId }],
      host: { pid: started.host.pid },
      dirs: [data],
    });
  } catch (error) {
    // Never released: the gate closes and the host doesn't run.
    started.gated.abort();
    await stopChild(started.host).catch(() => started.host.kill("SIGKILL"));
    throw error;
  }
  started.gated.release();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  await page.goto(await started.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approveDevice(INSTANCE);
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  // Interactive access, asked as the person asks it: Request access in the access bar.
  await page
    .getByTestId("bot-list")
    .getByRole("button", { name: /^Otto\b/ })
    .first()
    .click();
  const bar = page.getByRole("region", { name: "Access" });
  await bar.getByRole("button", { name: "Request access" }).click();
  await approveDevice(INSTANCE);
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  // Left as it started, whatever the check reached: the setting on, and no task of its own.
  let left: string[] = [];
  try {
    await gateway?.request("clawtrate-voice.set", { on: true }).catch(() => {});
    // The creating connection goes quiet first: every create has answered or given up, and the
    // connection is closed, so nothing it sent is still on its way when the check looks.
    await Promise.allSettled([...creates]);
    await gateway?.close().catch(() => {});
    // Each key asked for itself, until two passes a second apart find none.
    if (made.size > 0) {
      const removed = await removeUntilGone(made, { present, remove: removeTask });
      if (!removed.gone) left = removed.left;
    }
  } finally {
    await gateway?.close().catch(() => {});
    if (host) {
      await stopChild(host.child).catch(() => host!.child.kill("SIGKILL"));
      rmSync(host.data, { recursive: true, force: true });
    }
    // The host is gone and its folder removed, the instance is reset: the record goes too.
    const problems = cleanUp(RECORDS, record, resetInstance);
    expect(problems, "the voice check's run record").toEqual([]);
    expect(existsSync(recordPath(RECORDS, record.run))).toBe(false);
    expect(
      listInstances().some((row) => row.name === INSTANCE),
      "the voice check's instance",
    ).toBe(false);
  }
  // Said after everything is closed: a task left behind would change later checks' lists.
  expect(left, "tasks this check couldn't remove").toEqual([]);
});

/** One turn in a task, and the system text the scripted model received for it. */
async function promptOf(key: string): Promise<string> {
  const run = await gateway.send(key, "Hello there");
  expect((await gateway.terminal(String(run.runId))).state).toBe("final");
  const provider = `http://127.0.0.1:${instancePorts(openInstance(INSTANCE)).providerPort}`;
  const answer = (await (
    await fetch(`${provider}${SYSTEM_PROMPT_PATH}?session=${encodeURIComponent(key)}`)
  ).json()) as { system: string | null };
  expect(answer.system, "the scripted model saw the turn").not.toBeNull();
  return answer.system!;
}

async function openVoice() {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Conversation", exact: true }).click();
  return settings.getByRole("switch", { name: "Bot voice" });
}

test("F-527: with Bot voice on each seeded bot's prompt carries the plugin's guide, and turning it off removes it", async () => {
  test.setTimeout(300_000);
  // The four seeded bots, each with a task that already exists.
  const { agents } = await gateway.request<{ agents: { id: string }[] }>("agents.list", {});
  expect(agents).toHaveLength(4);
  // One task per bot, kept across the toggle: a guide cached in an open conversation would show.
  const tasks: string[] = [];
  for (const agent of agents) {
    const key = taskKey(agent.id);
    // Tracked before it is asked for, so a lost answer can't leave it behind.
    made.add(key);
    const create = gateway.request<{ key: string }>("sessions.create", {
      key,
      agentId: agent.id,
    });
    creates.add(create.catch(() => {}));
    const created = await create;
    expect(created.key).toBe(key);
    tasks.push(key);
  }
  for (const key of tasks) expect(await promptOf(key), key).toContain(GUIDE);

  const voice = await openVoice();
  await expect(voice).toBeChecked({ timeout: 15_000 });
  await expect(page.getByTestId("bot-voice-hook")).toHaveText("Yes");
  await voice.click();
  await expect(voice).not.toBeChecked({ timeout: 15_000 });
  // The plugin tells every other connection, this check's own among them.
  await gateway.waitFor(
    "the voice plugin's change event",
    (event) => event.event === "plugin.clawtrate-voice.changed",
    15_000,
  );
  // The gateway holds it off, and the next reply in the same tasks no longer gets the guide.
  expect((await gateway.request<{ on: boolean }>("clawtrate-voice.get", {})).on).toBe(false);
  for (const key of tasks) {
    const prompt = await promptOf(key);
    for (const part of GUIDE_PARTS) expect(prompt, key).not.toContain(part);
  }

  await voice.click();
  await expect(voice).toBeChecked({ timeout: 15_000 });
  expect((await gateway.request<{ on: boolean }>("clawtrate-voice.get", {})).on).toBe(true);
  for (const key of tasks) expect(await promptOf(key), key).toContain(GUIDE);

  // Another device turns it off while Settings is open here: the switch follows the gateway.
  await gateway.request("clawtrate-voice.set", { on: false });
  await expect(voice).not.toBeChecked({ timeout: 15_000 });
  await gateway.request("clawtrate-voice.set", { on: true });
  await expect(voice).toBeChecked({ timeout: 15_000 });
});
