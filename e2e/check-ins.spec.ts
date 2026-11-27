// A bot's check-ins (docs/design/automation.md section 13) against a real
// development gateway: this run's accounts instance, whose bots are the seeded
// four with the gateway's default check-ins (Juniper's, through
// `agents.defaults.heartbeat`). The interface runs on a preview host of its
// own and is driven as a person drives it; what landed is read back from the
// gateway's config and its heartbeat jobs, and the patches counted in the
// gateway's own log. The instance's scheduler is off, so no check-in runs on
// its schedule here: Off is shown by the job the scheduler would run, and by
// the gateway's own refusal to run it when asked to run it if enabled.
//
// An OpenClaw that retired heartbeats (2026.11.5 on, such as 2026.11.10) keeps
// check-ins as routines, with no setting or job that says which. Against one,
// this file has the one test that applies there: Check-ins say so for each
// bot, offer no change with admin, send no `config.patch`, and lead to the
// bot's routines. The tests registered are those of the version the run's
// gateway is (`OPENCLAW_BIN`, else the pin), and `beforeAll` checks that the
// gateway agrees, by the same schema lookup the app makes.
import { expect, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClawtrateClient } from "../packages/core/src/client.ts";
import { createBridgeSession } from "../packages/core/src/bridge.ts";
import { createNodeHost } from "../packages/core/src/node/index.ts";
import { ACCOUNT_CLIENTS } from "../tools/dev-gateway/src/account-checks.ts";
import { openInstance, openOperator, readDevConnection } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { programVersion } from "../tools/dev-gateway/src/pinned.ts";
import { PINNED_OPENCLAW, shapeOf } from "../tools/dev-gateway/src/versions.ts";
import { ACCOUNTS, test } from "./accounts-instance.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = ACCOUNTS;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;

test.describe.configure({ mode: "serial" });

let host: { child: ChildProcess; url: string; data: string } | null = null;
let page: Page;
let admin: OperatorSession;
/** The run's gateway keeps check-ins as heartbeats (the pin) rather than as routines. */
const HEARTBEATS = shapeOf(
  process.env.OPENCLAW_BIN
    ? (programVersion(resolve(process.env.OPENCLAW_BIN)) ?? "")
    : PINNED_OPENCLAW,
).heartbeat;

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

test.beforeAll(async ({ accountsInstance, browser }) => {
  // Started by the first of the accounts instance's specs this worker runs (accounts-instance.ts).
  expect(accountsInstance).toBe(INSTANCE);
  test.setTimeout(180_000);
  expect(INSTANCE, "this run's accounts instance").toMatch(/^e2e-[0-9a-f]{8}-acct$/);
  expect(listInstances().find((each) => each.name === INSTANCE)?.gatewayRunning).toBe(true);
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate check-ins check",
    [...ACCOUNT_CLIENTS.admin.scopes],
    [...ACCOUNT_CLIENTS.admin.caps],
  );
  // The gateway says which it is, as the app reads it: its schema has `agents.defaults.heartbeat` or not.
  const hasHeartbeats = await admin
    .request("config.schema.lookup", { path: "agents.defaults.heartbeat" })
    .then(
      () => true,
      (error: Error) => {
        if (/config schema path not found/.test(error.message)) return false;
        throw error;
      },
    );
  expect(hasHeartbeats, "the gateway's schema agrees with the version under test").toBe(HEARTBEATS);
  if (HEARTBEATS) {
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
  }

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

// The tests of a gateway with heartbeats (the pin).
if (HEARTBEATS) {
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

  test("F-201: closing the viewer or reconnecting before the patch sends nothing, and after it neither turns the outcome into a refusal", async () => {
    test.setTimeout(120_000);
    const instance = openInstance(INSTANCE);
    const connection = readDevConnection(instance.connectionFile)!;
    const dataDir = mkdtempSync(join(tmpdir(), "clawtrate-check-in-viewers-"));
    const node = createNodeHost({
      dataDir,
      client: {
        displayName: "Clawtrate check-in viewers",
        version: "0.0.0",
        platform: process.platform,
      },
    });
    // The client sends `config.get` for more than check-ins, so holding the Nth one can hold
    // another reader's and let the save's own read through (#709). While holding, every
    // `config.get` waits, so the save's read waits whatever else is read meanwhile.
    // `holdReads("patch")` starts at the save's `config.patch`, so its read-back waits, and
    // `patchAnswered` says the patch's answer has reached the client. `withholdAnswer` keeps the
    // gateway's answer to the next `config.patch` from the client, picked out by its id, and
    // `answerWithheld` says the gateway has answered.
    let hold: "reads" | "after the patch" | null = null;
    const held: Array<() => void> = [];
    let patchId: unknown;
    let patchAnswered = false;
    let withholdAnswer = false;
    let answerWithheld = false;
    const holdReads = (from: "now" | "patch") => {
      held.length = 0;
      patchId = undefined;
      patchAnswered = false;
      hold = from === "now" ? "reads" : "after the patch";
    };
    /** Sends what was held, in order; `drop` forgets it instead, for a socket that has closed. */
    const stopHolding = (drop = false) => {
      hold = null;
      for (const send of held.splice(0)) if (!drop) send();
    };
    const client = new ClawtrateClient(
      {
        ...node,
        createWebSocket(url) {
          const socket = node.createWebSocket(url);
          const send = socket.send.bind(socket);
          socket.send = (data) => {
            const frame = JSON.parse(data) as { id?: unknown; method?: string };
            if (frame.method === "config.patch") {
              patchId = frame.id;
              if (hold === "after the patch") hold = "reads";
            }
            if (hold === "reads" && frame.method === "config.get") held.push(() => send(data));
            else send(data);
          };
          // Registered before the client's own `onmessage`, so it runs first.
          (socket as unknown as EventTarget).addEventListener("message", (event) => {
            const frame = JSON.parse(String((event as MessageEvent).data)) as { id?: unknown };
            if (patchId === undefined || frame.id !== patchId) return;
            if (withholdAnswer) {
              // The client's own `onmessage` was registered after this listener: it never sees it.
              event.stopImmediatePropagation();
              answerWithheld = true;
            } else patchAnswered = true;
          });
          return socket;
        },
      },
      { allowGatewayUrl: (url) => url === connection.url },
    );
    const observer = createBridgeSession(client);
    try {
      await client.start();
      await client.connect({ url: connection.url, token: connection.token });
      await approve();
      await expect
        .poll(() => client.state.connection.status, { timeout: 30_000 })
        .toBe("connected");
      await observer.apply({ type: "requestAccess", tier: "admin" });
      await approve();
      await expect.poll(() => client.state.connection.canAdmin, { timeout: 30_000 }).toBe(true);
      await expect.poll(() => client.state.discovery.status).toBe("ready");
      expect(await observer.apply({ type: "refreshCheckIns", botId: "marlow" })).not.toBeNull();
      // Each draft is stamped by the latest read, as the dialog's is: a Disconnect moves the host
      // to a new target, and a draft read before it is refused.
      const draft = (saveId: string, every = "24h", was = "30m") => ({
        type: "saveCheckIn" as const,
        saveId,
        botId: "marlow",
        stamp: client.state.checkIns!.stamp!,
        every,
        prompt: null,
        was: { every: was, prompt: null },
        kept: [],
      });
      const before = patches();
      /**
       * Waits until `reached`, for as long as a loaded gateway can take to get a save there. On a
       * timeout it shows the save as it stood: still saving, or how it ended instead.
       */
      const until = (reached: () => boolean) =>
        expect.poll(() => reached() || client.state.checkIns?.save, { timeout: 30_000 }).toBe(true);
      /** The save is under way and its read is held, or will be: it can't reach its patch. */
      const reading = (saveId: string) =>
        until(() => client.state.checkIns?.save?.id === saveId && held.length > 0);

      // The viewer closes while the save reads, before its patch: nothing is sent.
      const first = createBridgeSession(client);
      holdReads("now");
      const unsent = first.apply(draft("unsent"));
      await reading("unsent");
      first.dispose();
      stopHolding();
      await unsent;
      expect(patches()).toBe(before);
      expect(client.state.checkIns?.save).toMatchObject({
        id: "unsent",
        status: "failed",
        error: "The request was withdrawn.",
      });
      expect(client.state.connection.status).toBe("connected");

      // The viewer closes once the patch is answered, while its read-back is held: still saved.
      const second = createBridgeSession(client);
      holdReads("patch");
      const sent = second.apply(draft("sent"));
      await until(() => patchAnswered);
      await expect.poll(patches, { timeout: 10_000 }).toBe(before + 1);
      second.dispose();
      expect(client.state.connection.status).toBe("connected");
      stopHolding();
      await sent;
      expect(client.state.checkIns?.save).toMatchObject({ id: "sent", status: "saved" });

      // The same two moments, ended by a reconnect instead of a closed viewer.
      const reconnect = async () => {
        expect(client.state.checkIns?.stamp).toBeNull();
        await observer.apply({ type: "retry" });
        await expect
          .poll(() => client.state.connection.status, { timeout: 30_000 })
          .toBe("connected");
        expect(await observer.apply({ type: "refreshCheckIns", botId: "marlow" })).not.toBeNull();
      };
      const third = createBridgeSession(client);
      holdReads("now");
      const cut = third.apply(draft("cut-unsent", "30m", "24h"));
      await reading("cut-unsent");
      await observer.apply({ type: "suspend" });
      await cut;
      stopHolding(true);
      expect(client.state.checkIns?.save).toMatchObject({ id: "cut-unsent", status: "failed" });
      await reconnect();
      expect(patches()).toBe(before + 1);

      // The suspend lands before the read-back's answer: the patch may have taken, so unknown.
      holdReads("patch");
      const cutSent = third.apply(draft("cut-sent", "30m", "24h"));
      await until(() => patchAnswered);
      await expect.poll(patches, { timeout: 10_000 }).toBe(before + 2);
      await observer.apply({ type: "suspend" });
      await cutSent;
      stopHolding(true);
      expect(client.state.checkIns?.save).toMatchObject({ id: "cut-sent", status: "unknown" });
      await reconnect();
      expect(client.state.checkIns?.jobs.find((job) => job.botId === "marlow")?.everyMs).toBe(
        1_800_000,
      );
      expect(patches()).toBe(before + 2);

      // The other order: the read-back's answer lands first, so it is saved, and the suspend
      // after it leaves it so.
      holdReads("patch");
      const cutAfter = third.apply(draft("cut-after", "24h", "30m"));
      await until(() => patchAnswered);
      stopHolding();
      await cutAfter;
      expect(client.state.checkIns?.save).toMatchObject({ id: "cut-after", status: "saved" });
      await observer.apply({ type: "suspend" });
      expect(client.state.checkIns?.save).toMatchObject({ id: "cut-after", status: "saved" });
      await reconnect();
      expect(client.state.checkIns?.jobs.find((job) => job.botId === "marlow")?.everyMs).toBe(
        86_400_000,
      );
      expect(patches()).toBe(before + 3);

      // The patch is sent and the gateway answers it, but the suspend lands before the answer
      // reaches the client: the patch may have taken, so unknown, and never failed. The client
      // rejects the patch with its own "gateway client stopped", which is never shown (#788).
      patchId = undefined;
      answerWithheld = false;
      withholdAnswer = true;
      const cutUnanswered = third.apply(draft("cut-unanswered", "30m", "24h"));
      await until(() => answerWithheld);
      await expect.poll(patches, { timeout: 10_000 }).toBe(before + 4);
      await observer.apply({ type: "suspend" });
      await cutUnanswered;
      withholdAnswer = false;
      expect(client.state.checkIns?.save).toMatchObject({
        id: "cut-unanswered",
        status: "unknown",
        error: "The connection changed before Clawtrate could confirm the change.",
      });
      await reconnect();
      expect(client.state.checkIns?.jobs.find((job) => job.botId === "marlow")?.everyMs).toBe(
        1_800_000,
      );
      expect(patches()).toBe(before + 4);
      third.dispose();
    } finally {
      observer.dispose();
      client.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

// The test of a gateway that keeps check-ins as routines.
if (!HEARTBEATS) {
  test("F-201: on an OpenClaw that keeps check-ins as routines, Check-ins say so for each bot, offer no change with admin, send no config.patch and lead to the bot's routines", async () => {
    test.setTimeout(120_000);
    const before = patches();
    await openCheckIns();
    for (const bot of ["main", "marlow", "otto", "pip"])
      await expect(block(bot).getByTestId("check-in-text")).toContainText(
        "This OpenClaw keeps check-ins as routines.",
      );
    await expect(page.getByText("No check-ins")).toHaveCount(0);
    // Below admin nothing asks for admin here: admin can't change them either.
    await expect(page.getByTestId("admin-bar")).toHaveCount(0);
    // With admin, granted where something can change, nothing here can change them.
    const settingsDialog = page.getByRole("dialog", { name: "Settings" });
    await settingsDialog.getByRole("button", { name: "Accounts", exact: true }).click();
    await page
      .getByTestId("admin-bar")
      .getByRole("button", { name: "Request admin access" })
      .click();
    await approve();
    await expect(page.getByTestId("admin-bar")).toContainText("Admin access granted.", {
      timeout: 30_000,
    });
    await settingsDialog.getByRole("button", { name: "Check-ins", exact: true }).click();
    await expect(block("marlow").getByTestId("check-in-text")).toContainText(
      "This OpenClaw keeps check-ins as routines.",
    );
    await expect(page.getByRole("button", { name: /^Change .*'s check-ins$/ })).toHaveCount(0);
    await block("marlow").getByRole("button", { name: "Marlow's routines" }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await expect(
      page.getByTestId("routines-view").getByRole("combobox", { name: "Bots" }),
    ).toHaveValue("marlow");
    expect(patches()).toBe(before);
  });
}
