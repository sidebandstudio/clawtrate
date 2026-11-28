// F-504: the preview host has a writable, admin connection before the walk.
// The gateway and the provider's sign-in page both belong to this test.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newRunId,
  ownIdentity,
  processIdentity,
  readMarker,
} from "../tools/dev-gateway/src/state-guard.ts";
import { callGateway, openInstance, restartGateway } from "../tools/dev-gateway/src/cli.ts";
import type { BridgeServerMessage } from "../packages/core/src/bridge.ts";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import {
  devGateway,
  FORBIDDEN_PORTS,
  listInstances,
  resetInstance,
  startHost,
} from "./global-setup.ts";
import { cleanUp, saveRecord, TEMP_PREFIX, type RunRecord } from "./run-record.ts";

const RECORDS = join(import.meta.dirname, "../tools/dev-gateway/.run/e2e");

type FirstRun = {
  instance: string;
  dev: ReturnType<typeof openInstance>;
  provider: string;
  gatewayPid: number | null;
  dialog: Locator;
  /** The newest state the host sent. */
  latest: () => ClawtrateState | null;
};

/**
 * A fresh skip-auth gateway, the preview host paired to it with full control, and first setup's
 * "Connect an account" open on its provider tiles. `onState` sees every state the host sends.
 */
async function openFirstRun(
  page: Page,
  record: RunRecord,
  onState: (state: ClawtrateState) => void = () => {},
): Promise<FirstRun> {
  const instance = record.instances[0]!.name;
  process.stdout.write(
    devGateway(
      instance,
      "start",
      "--run-id",
      record.instances[0]!.runId,
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
  const dev = openInstance(instance);
  const roster = await callGateway<{ agents: { id: string }[] }>(dev, "agents.list", {});
  expect(roster.agents.map((agent) => agent.id)).toEqual(["main"]);
  const freshConfig = await callGateway<{
    path: string;
    config: { agents: { entries: { main: { agentDir?: string } } } };
  }>(dev, "config.get", {});
  expect(freshConfig.path).toBe(dev.configPath);
  expect(freshConfig.config.agents.entries.main.agentDir).toBe(
    join(dev.stateDir, "agents", "main", "agent"),
  );
  for (const scope of [{ agentId: "main" }, {}]) {
    const auth = await callGateway<{
      providers: { profiles: unknown[]; apiKey?: unknown }[];
      providerCapabilities: unknown[];
      unavailable?: unknown;
    }>(dev, "models.authStatus", { ...scope, refresh: true });
    expect(auth.unavailable).toBeUndefined();
    expect(auth.providers.flatMap((provider) => provider.profiles)).toEqual([]);
    expect(auth.providers.some((provider) => provider.apiKey !== undefined)).toBe(false);
    expect(auth.providerCapabilities.length).toBeGreaterThan(0);
  }
  let latest: ClawtrateState | null = null;
  // What the sheet decides from, written when it changes, so a failed run says where it stood.
  let said = "";
  const sayAccounts = (state: ClawtrateState) => {
    const { accounts, connection } = state;
    const line = JSON.stringify({
      connection: [
        connection.status,
        connection.connectedAt,
        connection.gatewayId !== null,
        connection.canAdmin,
      ],
      accounts: [
        accounts.status,
        accounts.modelsStatus,
        accounts.readOn?.connectedAt ?? null,
        accounts.readOn?.gatewayId !== null,
      ],
      rows: accounts.accounts.map((a) => [a.id, a.status, a.keptBy]),
      firstBotModels: accounts.firstBotModels ?? null,
      signIn: accounts.signIn?.stage ?? null,
      bots: state.bots.length,
    });
    if (line !== said) process.stdout.write(`first-run state ${line}\n`);
    said = line;
  };
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/bridge") return;
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(payload.toString()) as BridgeServerMessage;
      if (message.type !== "state") return;
      latest = message.state;
      sayAccounts(message.state);
      onState(message.state);
    });
  });

  record.hostPending = true;
  saveRecord(RECORDS, record);
  const started = startHost(instance, process.env.CLAWTRATE_E2E_STATIC!, record.dirs[0]!);
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
    expect.poll(() => devGateway(instance, "approve"), { timeout: 60_000 }).toMatch(/^Approved /m);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 30_000,
  });
  await approve();
  await expect(page.getByTestId("bot")).toHaveCount(1, { timeout: 30_000 });
  // The web host has no secure credential storage. Grant the needed scopes before the walk.
  await hostCommand(page, { type: "requestAccess", tier: "admin" });
  await approve();

  const dialog = page.getByTestId("new-bot");
  await expect(dialog.getByRole("heading", { name: "Connect an account" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(dialog.getByRole("radio", { name: /^Let the gateway choose/ })).toHaveCount(0);
  return {
    instance,
    dev,
    provider: `http://127.0.0.1:${providerPort}`,
    gatewayPid: running!.gatewayPid,
    dialog,
    latest: () => latest,
  };
}

/** One command to the preview host on a bridge socket of the test's own, answered before it returns. */
function hostCommand(page: Page, command: Record<string, unknown>) {
  return page.evaluate(
    (command) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; id?: string };
          if (message.type === "hello")
            socket.send(JSON.stringify({ type: "command", id: "test", command }));
          else if (message.id === "test") {
            socket.close();
            resolve();
          }
        };
        socket.onerror = () => reject(new Error("Could not reach the preview host"));
      }),
    command,
  );
}

/** A run record for one test: its instance, and the preview host's data folder. */
function newRecord(): RunRecord {
  const run = randomBytes(4).toString("hex");
  const record: RunRecord = {
    run,
    runner: { pid: process.pid, identity: ownIdentity() },
    instances: [{ name: `e2e-${run}-setup`, runId: newRunId() }],
    host: null,
    dirs: [mkdtempSync(join(tmpdir(), TEMP_PREFIX))],
  };
  saveRecord(RECORDS, record);
  return record;
}

/** Answer the scripted provider's device-code page for the code the sheet shows. */
async function answerCode(
  dialog: Locator,
  provider: string,
  outcome: "approve" | "refuse",
  account: string,
) {
  const code = dialog.locator(".b-code code");
  await expect(code).toBeVisible({ timeout: 30_000 });
  const response = await fetch(`${provider}/scripted/signin/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode: await code.textContent(), outcome, account }),
  });
  expect(response.ok).toBe(true);
}

async function chooseAcmeDeviceCode(dialog: Locator) {
  await dialog.getByRole("button", { name: "Show more" }).click();
  await dialog.getByRole("button", { name: /^Acme \(scripted\)/ }).click();
  await dialog.getByRole("button", { name: /^Acme \(scripted\)/ }).click();
}

/** Create the offered bot, send one message, and check which account answered it. */
async function createAndReply(page: Page, dialog: Locator, provider: string, account: string) {
  await dialog.getByRole("button", { name: "Create bot" }).click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeFocused({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Send a message to start" })).toBeVisible();
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
      account,
      model: "dev-1",
      session: "agent:juniper:main",
      status: 200,
    }),
  );
}

/**
 * Restart the gateway for real while the sheet watches, optionally saving an account by the
 * gateway's own command while it is down. The sheet shows its waiting line, the gateway comes back
 * as a new process, and the app reconnects as soon as it can, during the gateway's startup, as the
 * installed app does.
 *
 * The development host proves its gateway again before each attempt; while the gateway is stopped
 * that proof fails and ends the retries (GATEWAY_NOT_ALLOWED). An installed gateway has no such
 * proof and the app keeps retrying by itself. So, once the new gateway process is on record, the
 * host's own retry command, sent on a socket of the test's, stands in for those automatic attempts.
 * Nothing on the page is pressed: the sheet is modal, and the person in the packaged app pressed
 * nothing either.
 */
async function restartWhileOpen(run: FirstRun, page: Page, account?: string) {
  let restarted = false;
  const restarting = restartGateway(run.dev, account).finally(() => {
    restarted = true;
  });
  const reconnectEarly = async () => {
    for (;;) {
      const connection = run.latest()?.connection;
      const pid = readMarker(run.dev.stateDir)?.gatewayPid;
      const newProcess = pid !== undefined && pid !== run.gatewayPid;
      if (newProcess && connection?.status === "connected") {
        process.stdout.write(
          `reconnected ${restarted ? "after" : "before"} the gateway admitted requests\n`,
        );
        return;
      }
      if (newProcess && connection?.error?.code === "GATEWAY_NOT_ALLOWED")
        await hostCommand(page, { type: "retry" });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  await Promise.all([
    restarting,
    expect(
      run.dialog.getByText("Waiting for your gateway to reconnect.", { exact: false }),
    ).toBeVisible({ timeout: 60_000 }),
    Promise.race([
      reconnectEarly(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("never reconnected")), 120_000)),
    ]),
  ]);
  const after = listInstances().find((row) => row.name === run.instance)?.gatewayPid;
  expect(after).not.toBeNull();
  expect(after).not.toBe(run.gatewayPid);
  await expect(page.getByTestId("bot")).toHaveCount(1);
}

test("F-504: a gateway nobody has used goes from connected to a bot's first answer", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const record = newRecord();
  try {
    let measuring = false;
    let disconnectedAt: number | null = null;
    let disconnectedMs = 0;
    let disconnects = 0;
    let firstAccounts: { shared: boolean; count: number } | null = null;
    const run = await openFirstRun(page, record, (state) => {
      const accounts = state.accounts;
      if (accounts.status === "ready" && accounts.modelsStatus === "ready")
        firstAccounts ??= { shared: accounts.mainShared, count: accounts.accounts.length };
      if (!measuring) return;
      if (state.connection.status !== "connected" && disconnectedAt === null) {
        disconnects += 1;
        disconnectedAt = Date.now();
      } else if (state.connection.status === "connected" && disconnectedAt !== null) {
        disconnectedMs += Date.now() - disconnectedAt;
        disconnectedAt = null;
      }
    });
    const { dev, dialog, provider, instance } = run;
    const mainDir = join(dev.stateDir, "agents", "main", "agent");
    expect(firstAccounts).toEqual({ shared: true, count: 0 });
    await chooseAcmeDeviceCode(dialog);

    await answerCode(dialog, provider, "refuse", "first");
    await expect(dialog.getByText("Couldn't connect", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await dialog.getByRole("button", { name: "Try again", exact: true }).click();
    const configBefore = readFileSync(dev.configPath, "utf8");
    const stores = [
      join(mainDir, "auth-profiles.json"),
      join(mainDir, "openclaw-agent.sqlite"),
      join(mainDir, "openclaw-agent.sqlite-wal"),
      join(dev.stateDir, "state", "openclaw.sqlite"),
      join(dev.stateDir, "state", "openclaw.sqlite-wal"),
    ];
    const storeTimes = () =>
      stores.map((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs);
    const storeBefore = storeTimes();
    const logPath = join(dev.runDir, "gateway.log");
    const logBefore = readFileSync(logPath, "utf8").length;
    const approvedAt = Date.now();
    measuring = true;
    await answerCode(dialog, provider, "approve", "first");

    await expect(dialog.getByRole("heading", { name: "Make your first bot" })).toBeVisible({
      timeout: 45_000,
    });
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Juniper");
    await expect(dialog.getByText("Uses Acme.")).toBeVisible();
    measuring = false;
    const reloadLog = readFileSync(logPath, "utf8").slice(logBefore);
    const storeAfter = storeTimes();
    process.stdout.write(
      `Sign-in measurement ${JSON.stringify({
        accountStoreChanges: stores
          .filter((_, i) => storeBefore[i] !== storeAfter[i])
          .map((file) => file.slice(dev.stateDir.length + 1)),
        configChanged: readFileSync(dev.configPath, "utf8") !== configBefore,
        hotReload: reloadLog.includes("config hot reload applied"),
        dynamicConfig: reloadLog.includes("config change applied (dynamic reads"),
        gatewayPidChanged:
          listInstances().find((row) => row.name === instance)?.gatewayPid !== run.gatewayPid,
        disconnects,
        disconnectedMs,
        approvalToCreateMs: Date.now() - approvedAt,
      })}\n`,
    );
    await createAndReply(page, dialog, provider, "acme:first");
  } finally {
    expect(cleanUp(RECORDS, record, resetInstance)).toEqual([]);
  }
});

test("F-504: an account saved on the gateway while first setup is open moves it on after a real restart", async ({
  page,
}) => {
  test.setTimeout(480_000);
  const record = newRecord();
  try {
    const run = await openFirstRun(page, record);
    const { dialog, provider } = run;
    await expect(dialog.getByRole("button", { name: "Show more" })).toBeVisible();
    // The gateway's own command saves a named account in the shared store while it is down.
    await restartWhileOpen(run, page, "acme:work");
    // Moves on by itself: never back to the provider tiles with a usable account present.
    await expect(dialog.getByRole("heading", { name: "Make your first bot" })).toBeVisible({
      timeout: 45_000,
    });
    await expect(dialog.getByRole("button", { name: "Show more" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Create bot" })).toBeEnabled();
    await createAndReply(page, dialog, provider, "acme:work");
  } finally {
    expect(cleanUp(RECORDS, record, resetInstance)).toEqual([]);
  }
});

test("F-504: first setup reaches its bot when the gateway restarts right after a device-code sign-in", async ({
  page,
}) => {
  test.setTimeout(480_000);
  const record = newRecord();
  try {
    const run = await openFirstRun(page, record);
    const { dialog, provider } = run;
    await chooseAcmeDeviceCode(dialog);
    await answerCode(dialog, provider, "approve", "first");
    await restartWhileOpen(run, page);
    await expect(dialog.getByRole("heading", { name: "Make your first bot" })).toBeVisible({
      timeout: 45_000,
    });
    await expect(dialog.getByRole("button", { name: "Create bot" })).toBeEnabled();
    await createAndReply(page, dialog, provider, "acme:first");
  } finally {
    expect(cleanUp(RECORDS, record, resetInstance)).toEqual([]);
  }
});

test("F-504: first setup reaches its bot when the gateway restarts right after an API key is saved", async ({
  page,
}) => {
  test.setTimeout(480_000);
  const record = newRecord();
  try {
    const run = await openFirstRun(page, record);
    const { dialog, provider } = run;
    await dialog.locator("details.b-disclosure summary").click();
    await dialog.getByRole("combobox", { name: "Provider" }).selectOption("acme");
    await dialog.getByTestId("api-key").fill("clawtrate-dev-key.acme.typed");
    await dialog.getByRole("button", { name: "Save key" }).click();
    await expect(dialog.getByTestId("api-key")).toHaveCount(0, { timeout: 30_000 });
    await restartWhileOpen(run, page);
    await expect(dialog.getByRole("heading", { name: "Make your first bot" })).toBeVisible({
      timeout: 45_000,
    });
    await expect(dialog.getByRole("button", { name: "Create bot" })).toBeEnabled();
    await createAndReply(page, dialog, provider, "acme:typed");
  } finally {
    expect(cleanUp(RECORDS, record, resetInstance)).toEqual([]);
  }
});
