// Provider accounts per bot (docs/design/bots.md) against a real development
// gateway: this run's accounts instance, started with two scripted providers,
// labelled accounts and the scripted sign-ins (tools/dev-gateway/README.md).
// The interface runs on a preview host of its own and is driven as a person
// drives it; what landed is read from the gateway and from the scripted
// model's record of which account each request came from. Nothing here
// reaches a real provider.
//
// With CLAWTRATE_ACCOUNT_SHOTS=<folder outside the repository>, it also saves
// screenshots of what it checked there, at 1440 and 390 px in both themes.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_CLIENTS, SIGNIN_CHOICES } from "../tools/dev-gateway/src/account-checks.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_E2E_ACCOUNTS!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const SHOTS = process.env.CLAWTRATE_ACCOUNT_SHOTS ?? null;
/** A made-up key for the scripted API-key sign-in: its account is `acme:typed`. */
const TYPED_KEY = "clawtrate-dev-key.acme.typed";

test.describe.configure({ mode: "serial" });

let host: { child: ChildProcess; url: string; data: string } | null = null;
let page: Page;
let admin: OperatorSession;
let providerUrl: string;
/** Every frame the host sent the page, as text. */
const frames: string[] = [];
/** Every frame the page sent the host, as text. */
const sentFrames: string[] = [];

type Json = Record<string, unknown>;

async function config(): Promise<Json> {
  return ((await admin.request<{ config: Json }>("config.get", {})).config ?? {}) as Json;
}
const entry = (cfg: Json, bot: string) =>
  ((cfg.agents as Json | undefined)?.entries as Record<string, Json> | undefined)?.[bot];

/** A bot's view of a provider's accounts, refreshed, as the gateway reports it. */
async function view(bot: string, provider: string) {
  const status = await admin.request<{
    providers?: Array<{
      provider: string;
      profiles: Array<{ profileId: string; source: string; type: string }>;
      profileOrder?: string[];
    }>;
  }>("models.authStatus", { agentId: bot, refresh: true });
  return status.providers?.find((each) => each.provider === provider);
}

async function scripted<T = Json>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${providerUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as T;
}

type Request = { seq: number; account: string | null; session: string | null; status: number };
async function requestsFor(session: string): Promise<Request[]> {
  const all = await scripted<{ requests: Request[] }>("/scripted/requests");
  return all.requests.filter((each) => each.session === session);
}

/** Screenshots of the page as it is, at 1440 and 390 in both themes, when asked for. */
async function shots(name: string): Promise<void> {
  if (!SHOTS) return;
  const size = page.viewportSize()!;
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(SHOTS, `${name}-${theme}-${width}.png`) });
    }
  }
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: "light" });
}

const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });
const botRow = (name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

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

/** Every file under the host's data folder, as text: what the host keeps on disk. */
function hostFiles(dir: string): string {
  let text = "";
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) text += hostFiles(path);
    else text += readFileSync(path, "latin1");
  }
  return text;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  expect(INSTANCE, "this run's accounts instance").toMatch(/^e2e-[0-9a-f]{8}-acct$/);
  const row = listInstances().find((each) => each.name === INSTANCE);
  expect(row?.gatewayRunning, "the accounts instance runs").toBe(true);
  providerUrl = `http://127.0.0.1:${row!.providerPort}`;
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate accounts check",
    [...ACCOUNT_CLIENTS.admin.scopes],
    [...ACCOUNT_CLIENTS.admin.caps],
  );

  const data = mkdtempSync(join(tmpdir(), "clawtrate-accounts-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  host = { child: started.host, url: await started.url, data };

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  page = await context.newPage();
  // What the host sends the page, to show that a typed key never comes back.
  await page.routeWebSocket(/\/bridge$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      sentFrames.push(String(message));
      server.send(message);
    });
    server.onMessage((message) => {
      frames.push(String(message));
      ws.send(message);
    });
  });
  await page.goto(host.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  // The interactive tier first, through the bridge's requestAccess, as the composer's access
  // bar asks for it ("+" needs it); these bots have no task yet, so no composer to ask from.
  await hostCommand({ type: "requestAccess" });
  await approve();
  await expect(page.getByTestId("plus")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await admin?.close();
  if (host) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

test("F-034 F-472: New bot asks for admin access, then creates a bot on the second of two accounts of one provider; its first run sends that account's credential", async () => {
  test.setTimeout(180_000);
  await page.keyboard.press("ControlOrMeta+n");
  const create = dialog("New bot");
  await expect(create).toBeVisible();
  await expect(create.getByRole("textbox", { name: "Name" })).toBeFocused();
  await create.getByRole("textbox", { name: "Name" }).fill("Second");
  await create.getByRole("radio", { name: "hex" }).click();
  await create.getByRole("radio", { name: "Sky" }).click();
  await create.getByRole("button", { name: "Next" }).click();
  const account = dialog("Account");
  await expect(account.getByText("Choose the account Second runs on.")).toBeVisible();
  // Below admin the rows are shown but cannot be chosen; the access bar takes Create's place.
  const bar = account.getByTestId("admin-bar");
  await expect(bar).toContainText("Admin access needed.");
  await expect(account.getByRole("button", { name: "Create" })).toHaveCount(0);
  await bar.getByRole("button", { name: "Request admin access" }).click();
  await expect(bar).toContainText("Waiting for the gateway's owner.", { timeout: 15_000 });
  await approve();
  await expect(account.getByTestId("admin-bar")).toContainText("Admin access granted.", {
    timeout: 30_000,
  });
  // On admin the gateway sends labels: the two Acme accounts are told apart by them.
  const home = account.getByRole("radio", { name: /^Acme · Home/ });
  await expect(home).toBeVisible({ timeout: 15_000 });
  await expect(account.getByRole("radio", { name: /^Acme · Work/ })).toBeVisible();
  await expect(account.getByRole("radio", { name: /^Let the gateway choose/ })).toBeVisible();
  // Nothing is chosen at first: the default model names no account.
  await expect(account.getByRole("radio", { checked: true })).toHaveCount(0);
  await home.click();
  await expect(home).toHaveAttribute("aria-checked", "true");
  await shots("account-step");
  await account.getByRole("button", { name: "Create" }).click();
  await expect(account).toHaveCount(0, { timeout: 30_000 });

  // Stored on the account, with an empty fallback list, and the picture chosen.
  const created = entry(await config(), "second")!;
  expect(created.model).toEqual({ primary: "acme/dev-1@acme:home", fallbacks: [] });
  expect(String((created.identity as Json | undefined)?.avatar ?? "")).toMatch(
    /^data:image\/png;base64,/,
  );
  // The new bot is selected, on its first, empty task, with the composer ready.
  await expect(botRow("Second")).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
  // Drawn with the picture chosen, which the gateway keeps with the bot.
  await expect(botRow("Second").locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  const field = page.getByTestId("composer-input");
  await expect(field).toBeVisible({ timeout: 20_000 });

  // Its first run reaches the scripted model with the second account's credential only.
  await field.fill("#text");
  await field.press("Enter");
  await expect
    .poll(async () => (await requestsFor("agent:second:main")).length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  const requests = await requestsFor("agent:second:main");
  expect(requests[0]).toMatchObject({ account: "acme:home", status: 200 });
  expect(requests.every((each) => each.account === "acme:home")).toBe(true);
});

test("F-472: a bot created with Let the gateway choose is stored with no account and an empty fallback list", async () => {
  await page.keyboard.press("ControlOrMeta+n");
  const create = dialog("New bot");
  await create.getByRole("textbox", { name: "Name" }).fill("Chooser");
  await create.getByRole("button", { name: "Next" }).click();
  const account = dialog("Account");
  const choose = account.getByRole("radio", { name: /^Let the gateway choose/ });
  await expect(choose).toContainText("No fixed account.");
  await choose.click();
  await account.getByRole("button", { name: "Create" }).click();
  await expect(account).toHaveCount(0, { timeout: 30_000 });
  // The gateway's default model, without an account, and no fallbacks.
  expect(entry(await config(), "chooser")!.model).toEqual({
    primary: "scripted/dev-1",
    fallbacks: [],
  });
  // Its settings show the third state.
  await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Account: .*Gateway chooses\. Open\.$/ }).click();
  await expect(page.getByTestId("gateway-note")).toContainText("The gateway chooses.");
  await expect(page.getByTestId("retained-order")).toHaveCount(0);
  await shots("account-page-gateway");
  await page.getByRole("button", { name: "Back to settings" }).click();
  await page.keyboard.press("ControlOrMeta+\\");
});

/** Open Settings on Accounts, and the connect component. */
async function connectFromSettings() {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = dialog("Settings");
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Accounts", level: 3 })).toBeVisible();
  return settings;
}

test("F-474 F-476: a sign-in with a link and a code lands where the screen says it landed, and takes a label", async () => {
  const settings = await connectFromSettings();
  await shots("settings-accounts");
  await settings.getByRole("button", { name: "Connect an account" }).first().click();
  await settings.getByRole("button", { name: /^Acme \(scripted\) · a link and a code/ }).click();
  const code = settings.locator(".b-code code");
  await expect(code).toBeVisible({ timeout: 20_000 });
  await expect(settings.getByText(/The code works for 15 minutes\./)).toBeVisible();
  await expect(settings.getByTestId("open-page")).toHaveAttribute(
    "href",
    new RegExp(`^${providerUrl}/`),
  );
  // Where it opens, before it is chosen: the parsed address without its query, and that a
  // loopback address points to this device.
  const href = new URL((await settings.getByTestId("open-page").getAttribute("href"))!);
  await expect(settings.getByTestId("page-address")).toHaveText(
    `http://${href.hostname}:${href.port}${href.pathname}`,
  );
  await expect(settings.getByTestId("page-opens")).toHaveText(
    "Opens in this device's browser. This address points to this device. It points directly to the gateway's machine only when this is the gateway's machine.",
  );
  await shots("signin-waiting");
  // The person approves on the provider's page, as account "travel".
  await scripted("/scripted/signin/answer", {
    userCode: await code.textContent(),
    outcome: "approve",
    account: "travel",
  });
  await expect(settings.getByRole("heading", { name: "Connected to Acme" })).toBeVisible({
    timeout: 30_000,
  });
  // The screen says every bot can use it: another bot's refreshed view lists it as inherited.
  await expect(settings.getByTestId("landed")).toHaveText(
    "Every bot can use it: the gateway shows it to other bots as shared.",
  );
  expect(
    (await view("pip", "acme"))?.profiles.find((p) => p.profileId === "acme:travel"),
  ).toMatchObject({ source: "inherited", type: "oauth" });
  // Another Acme account exists: a label is required, and one already used is refused.
  const label = settings.getByRole("textbox", { name: "Label" });
  const done = settings.getByRole("button", { name: "Done" });
  await expect(done).toBeDisabled();
  await label.fill("work");
  await expect(
    settings.getByText("Another Acme account is called Work. Choose a different label."),
  ).toBeVisible();
  await expect(done).toBeDisabled();
  await label.fill("Travel");
  await done.click();
  await expect(
    settings.getByRole("button", { name: /^Acme · Travel, Subscription, / }),
  ).toBeVisible({ timeout: 20_000 });
  expect(((await config()).auth as Json).profiles).toMatchObject({
    "acme:travel": { displayName: "Travel" },
  });
  await page.keyboard.press("Escape");
});

test("F-474: a browser sign-in with the code pasted back lands where the screen says it landed", async () => {
  const settings = await connectFromSettings();
  await settings.getByRole("button", { name: "Connect an account" }).first().click();
  await settings.getByRole("button", { name: /^Acme in the browser \(scripted\)/ }).click();
  const paste = settings.getByTestId("paste");
  await expect(paste).toBeVisible({ timeout: 20_000 });
  await expect(paste).toHaveAttribute("type", "password");
  const href = await settings.getByTestId("open-page").getAttribute("href");
  const state = new URL(href!).searchParams.get("state");
  const answered = await scripted<{ code: string }>("/scripted/signin/answer", {
    state,
    outcome: "approve",
    account: "browse",
  });
  await paste.fill(answered.code);
  await settings.getByRole("button", { name: "Continue" }).click();
  await expect(settings.getByRole("heading", { name: "Connected to Acme" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(settings.getByTestId("landed")).toContainText("Every bot can use it");
  expect(
    (await view("otto", "acme"))?.profiles.find((p) => p.profileId === "acme:browse")?.source,
  ).toBe("inherited");
  // The pasted code went to the gateway; the host sent none of it back.
  expect(frames.some((frame) => frame.includes(answered.code))).toBe(false);
  await settings.getByRole("textbox", { name: "Label" }).fill("Browse");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByRole("button", { name: /^Acme · Browse/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
});

test("F-474 F-475: an API key typed into the key path reaches the gateway once and is kept nowhere in Clawtrate", async () => {
  const settings = await connectFromSettings();
  await settings.getByRole("button", { name: "Connect an account" }).first().click();
  // Never open by default, never chosen: a disclosure under the sign-ins.
  const disclosure = settings.locator("details.b-disclosure");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await disclosure.locator("summary").click();
  await settings.getByRole("combobox", { name: "Provider" }).selectOption("acme");
  // Acme's key goes through its own sign-in, which adds an account: nothing is replaced.
  await expect(settings.getByText(/This replaces the Acme key/)).toHaveCount(0);
  const field = settings.getByTestId("api-key");
  await field.fill(TYPED_KEY);
  await settings.getByRole("button", { name: "Save key" }).click();
  await expect(field).toHaveCount(0, { timeout: 30_000 });
  await expect(settings.getByRole("heading", { name: "Key saved" })).toBeVisible({
    timeout: 30_000,
  });
  expect(
    (await view("main", "acme"))?.profiles.find((p) => p.profileId === "acme:typed")?.type,
  ).toBe("api_key");
  // Kept nowhere: not in anything the host sent the page, not in the host's files, not on the page.
  expect(frames.some((frame) => frame.includes(TYPED_KEY))).toBe(false);
  expect(hostFiles(host!.data).includes(TYPED_KEY)).toBe(false);
  expect(await page.content()).not.toContain(TYPED_KEY);
  await settings.getByRole("textbox", { name: "Label" }).fill("Typed");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByRole("button", { name: /^Acme · Typed, API key/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
});

test("F-474: a sign-in that is refused says so, and what the gateway now has", async () => {
  const settings = await connectFromSettings();
  await settings.getByRole("button", { name: "Connect an account" }).first().click();
  await settings.getByRole("button", { name: /^Acme \(scripted\) · a link and a code/ }).click();
  const code = settings.locator(".b-code code");
  await expect(code).toBeVisible({ timeout: 20_000 });
  await scripted("/scripted/signin/answer", {
    userCode: await code.textContent(),
    outcome: "refuse",
    account: "nope",
  });
  await expect(settings.getByRole("heading", { name: "Couldn't connect" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(settings.getByText(/refused the sign-in/)).toBeVisible();
  await expect(settings.getByTestId("reread")).toHaveText(
    "Clawtrate checked the gateway's accounts: no new Acme account.",
    { timeout: 20_000 },
  );
  expect((await view("main", "acme"))?.profiles.some((p) => p.profileId === "acme:nope")).toBe(
    false,
  );
  await page.keyboard.press("Escape");
});

/** Second's Account page, in the Work pane's Settings tab. */
async function accountPage() {
  await botRow("Second").click();
  if (!(await page.getByTestId("work-panel").isVisible()))
    await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  const back = page.getByRole("button", { name: "Back to settings" });
  if (!(await back.isVisible())) await page.getByRole("button", { name: /^Account: / }).click();
  return page.getByTestId("bot-settings");
}

test("F-476 F-490: a bot locked with the tool's command shows as Locked, and one unlocked shows as Bound", async () => {
  test.setTimeout(120_000);
  const settings = await accountPage();
  await expect(settings.getByTestId("bound-note")).toContainText(
    "Bound. Second runs on Acme · Home.",
  );
  // The lock command, for the gateway's owner to run, in the instance's own form.
  const command = settings.getByTestId("command");
  await expect(command).toContainText(
    `openclaw --profile clawtrate-dev-${INSTANCE} models auth order set --provider acme --agent second acme:home`,
  );
  await expect(settings.getByTestId("evidence")).toContainText("Not locked. Checked at");
  await shots("account-page-bound");
  devGateway(INSTANCE, "lock", "--agent", "second", "--provider", "acme", "acme:home");
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(settings.getByTestId("locked-note")).toContainText(
    "Locked. Second's ordinary runs use Acme · Home only",
    { timeout: 20_000 },
  );
  await expect(settings.getByTestId("evidence")).toContainText("Checked with the gateway at");
  await shots("account-page-locked");
  await page.getByRole("button", { name: "Back to settings" }).click();
  await expect(page.getByTestId("account-word")).toHaveText("Locked");
  // Unlocked on the gateway: Bound again, and the page says the lock is gone.
  devGateway(INSTANCE, "unlock", "--agent", "second", "--provider", "acme");
  await page.getByRole("button", { name: /^Account: / }).click();
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(settings.getByTestId("bound-note")).toBeVisible({ timeout: 20_000 });
  await expect(
    settings.getByText(/The lock is gone: the gateway's order for Second changed/),
  ).toBeVisible();
});

test("F-473: changing a locked bot to another account of its provider shows the lock out of date", async () => {
  test.setTimeout(120_000);
  devGateway(INSTANCE, "lock", "--agent", "second", "--provider", "acme", "acme:home");
  const settings = await accountPage();
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(settings.getByTestId("locked-note")).toBeVisible({ timeout: 20_000 });
  await settings.getByRole("button", { name: "Change account" }).click();
  await settings.getByRole("radio", { name: /^Acme · Work/ }).click();
  await expect(
    settings.getByText(
      /Second is locked to Acme · Home\. After saving, Second is bound to Acme · Work while the gateway.s order for Second still names only Acme · Home/,
    ),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByTestId("stale-note")).toContainText(
    "The lock is out of date. Second runs on Acme · Work first, but the gateway's order for Second still lists only Acme · Home",
    { timeout: 20_000 },
  );
  await expect(settings.getByTestId("command").first()).toContainText(
    "order set --provider acme --agent second acme:work",
  );
  expect(entry(await config(), "second")!.model).toEqual({
    primary: "acme/dev-1@acme:work",
    fallbacks: [],
  });
  // The gateway still keeps the old one-account order: the next run goes to the new account first.
  expect((await view("second", "acme"))?.profileOrder).toEqual(["acme:home"]);
  devGateway(INSTANCE, "unlock", "--agent", "second", "--provider", "acme");
});

/** Requests of a session the scripted model answered after `seq`. */
async function requestsSince(session: string, seq: number): Promise<Request[]> {
  return (await requestsFor(session)).filter((each) => each.seq > seq);
}
const lastSeq = async () =>
  (await scripted<{ requests: Request[] }>("/scripted/requests")).requests.at(-1)?.seq ?? 0;

test("F-473: changing a bot's account draws a grey line in its open task naming the binding read back, and the next run uses the new account", async () => {
  test.setTimeout(180_000);
  const settings = await accountPage();
  // The check before unlocked Second on the gateway: read its order again.
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(settings.getByTestId("bound-note")).toContainText("Second runs on Acme · Work.", {
    timeout: 20_000,
  });
  await settings.getByRole("button", { name: "Change account" }).click();
  await settings.getByRole("radio", { name: /^Acme · Home/ }).click();
  // Nothing predicts which account a run uses.
  await expect(settings.getByText(/finishes on|next run/)).toHaveCount(0);
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByTestId("bound-note")).toContainText("Second runs on Acme · Home.", {
    timeout: 20_000,
  });
  // The gateway records no line for it: Clawtrate draws one in the open task.
  // The check before changed Second's account too, from the same task: this line is the last.
  const line = page.getByTestId("client-event-line").last();
  await expect(line).toHaveText("Second is now bound to Acme · Home.");
  await shots("account-change-line");
  expect(entry(await config(), "second")!.model).toEqual({
    primary: "acme/dev-1@acme:home",
    fallbacks: [],
  });
  // The next run reaches the scripted model with the new account's credential only.
  const since = await lastSeq();
  const field = page.getByTestId("composer-input");
  await field.fill("#text");
  await field.press("Enter");
  await expect
    .poll(async () => (await requestsSince("agent:second:main", since)).length, {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  const after = await requestsSince("agent:second:main", since);
  expect(after.map((each) => each.account)).toEqual(after.map(() => "acme:home"));
});

test("F-473: a run in progress finishes on the account it started with and the next run uses the new one, while the screen predicts neither", async () => {
  test.setTimeout(240_000);
  await accountPage();
  await page.getByRole("button", { name: "Back to settings" }).click();
  const since = await lastSeq();
  // A run with a slow tool: one request before the change, one after it, in the same run.
  const field = page.getByTestId("composer-input");
  await field.fill("#slow-tool 15");
  await field.press("Enter");
  await expect
    .poll(async () => (await requestsSince("agent:second:main", since)).length, {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  const settings = page.getByTestId("bot-settings");
  await page.getByRole("button", { name: /^Account: / }).click();
  await settings.getByRole("button", { name: "Change account" }).click();
  await settings.getByRole("radio", { name: /^Acme · Work/ }).click();
  await expect(settings.getByRole("button", { name: "Save" })).toBeEnabled({ timeout: 20_000 });
  await expect(settings.getByText(/finishes on|next run|run in progress/)).toHaveCount(0);
  await shots("account-change-running");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("client-event-line").last()).toHaveText(
    "Second is now bound to Acme · Work.",
    { timeout: 20_000 },
  );
  expect(entry(await config(), "second")!.model).toEqual({
    primary: "acme/dev-1@acme:work",
    fallbacks: [],
  });
  // The run ends, every request of it on the account it started with.
  await expect
    .poll(async () => (await requestsSince("agent:second:main", since)).length, {
      timeout: 120_000,
    })
    .toBeGreaterThan(1);
  await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0, { timeout: 120_000 });
  const during = await requestsSince("agent:second:main", since);
  expect(during.map((each) => each.account)).toEqual(during.map(() => "acme:home"));
  // The next run uses the new account.
  const next = await lastSeq();
  await field.fill("#text");
  await field.press("Enter");
  await expect
    .poll(async () => (await requestsSince("agent:second:main", next)).length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  const after = await requestsSince("agent:second:main", next);
  expect(after.map((each) => each.account)).toEqual(after.map(() => "acme:work"));
});

test("F-473: a task set to another account by another client keeps it after a change; the line names only the binding", async () => {
  test.setTimeout(180_000);
  // Another client sets one of Second's tasks to Work, while Second itself moves to Home.
  const other = await admin.request<{ key: string }>("sessions.create", {
    agentId: "second",
    label: "Set elsewhere",
  });
  await admin.request("sessions.patch", { key: other.key, model: "acme/dev-1@acme:work" });
  const settings = await accountPage();
  await settings.getByRole("button", { name: "Change account" }).click();
  await settings.getByRole("radio", { name: /^Acme · Home/ }).click();
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("client-event-line").last()).toHaveText(
    "Second is now bound to Acme · Home.",
    { timeout: 20_000 },
  );
  // Nothing on the page says which account the next run, or that task's, uses.
  await expect(page.getByText(/finishes on|next run|run in progress/)).toHaveCount(0);
  // The gateway lets the task's own account win: its run goes to Work.
  const since = await lastSeq();
  await admin.request("chat.send", {
    sessionKey: other.key,
    message: "#text",
    idempotencyKey: `${other.key}-after-change`,
  });
  await expect
    .poll(async () => (await requestsSince(other.key, since)).length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  const served = await requestsSince(other.key, since);
  expect(served.map((each) => each.account)).toEqual(served.map(() => "acme:work"));
  expect(entry(await config(), "second")!.model).toEqual({
    primary: "acme/dev-1@acme:home",
    fallbacks: [],
  });
});

test("F-473: a binding another client made while Change account was open is found before the write: no second change and no line", async () => {
  test.setTimeout(120_000);
  const settings = await accountPage();
  await settings.getByRole("button", { name: "Change account" }).click();
  await settings.getByRole("radio", { name: /^Acme · Work/ }).click();
  const lines = await page.getByTestId("client-event-line").count();
  // Another admin moves Second to Work with the dialog still open.
  const before = await admin.request<{ hash: string; configRevisionHash?: string }>(
    "config.get",
    {},
  );
  await admin.request("config.patch", {
    raw: JSON.stringify({
      agents: {
        entries: { second: { model: { primary: "acme/dev-1@acme:work", fallbacks: [] } } },
      },
    }),
    baseHash: before.hash,
    replacePaths: ["agents.entries.second.model.fallbacks"],
  });
  await expect
    .poll(async () => (entry(await config(), "second")!.model as Json).primary, {
      timeout: 30_000,
    })
    .toBe("acme/dev-1@acme:work");
  const revision = (await admin.request<{ hash: string }>("config.get", {})).hash;
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByTestId("bound-note")).toContainText("Acme · Work", {
    timeout: 20_000,
  });
  // Nothing was written, and no line was drawn for a change Clawtrate didn't make.
  expect((await admin.request<{ hash: string }>("config.get", {})).hash).toBe(revision);
  await expect(page.getByTestId("client-event-line")).toHaveCount(lines);
});

test("F-473: a bot locked to its old account and moved to another of the provider: the gateway puts the new one first and still tries the old one", async () => {
  test.setTimeout(240_000);
  // Accounts of its own, so a failure's rest touches no other check.
  const old = await signInKey("staleold");
  const fresh = await signInKey("stalenew");
  const created = await admin.request<{ agentId: string }>("agents.create", {
    name: "Mover",
    model: `acme/dev-1@${old}`,
  });
  const bot = created.agentId;
  await patchConfig({
    agents: { entries: { [bot]: { model: { primary: `acme/dev-1@${old}`, fallbacks: [] } } } },
  });
  devGateway(INSTANCE, "lock", "--agent", bot, "--provider", "acme", old);
  await patchConfig({
    agents: { entries: { [bot]: { model: { primary: `acme/dev-1@${fresh}`, fallbacks: [] } } } },
  });
  // The order still names only the old account: the lock is out of date.
  expect((await view(bot, "acme"))?.profileOrder).toEqual([old]);
  // The new account fails: the run goes to it first, then to the old one.
  await scripted("/scripted/accounts/fail", { account: fresh, status: 401 });
  try {
    const session = `agent:${bot}:stale`;
    const sent = await admin.send(session, "#text");
    await admin.terminal(String(sent.runId), 180_000);
    const requests = await requestsFor(session);
    expect(requests.map((each) => [each.account, each.status])).toEqual([
      [fresh, 401],
      [old, 200],
    ]);
  } finally {
    await scripted("/scripted/accounts/clear", { account: fresh });
    devGateway(INSTANCE, "unlock", "--agent", bot, "--provider", "acme");
  }
});

/** Settings → Accounts → Connect an account, and one of the sign-in methods. */
async function startFromSettings(method: RegExp) {
  const settings = await connectFromSettings();
  await settings.getByRole("button", { name: "Connect an account" }).first().click();
  await settings.getByRole("button", { name: method }).click();
  return settings;
}
const stateOf = (href: string | null) => new URL(href!).searchParams.get("state");

test("F-474: a sign-in that finishes on the gateway's machine shows the gateway's words and the port to forward, and connects when the browser comes back there", async () => {
  const settings = await startFromSettings(/^Acme \(scripted\) on the gateway's machine/);
  await expect(settings.getByText("The gateway says:")).toBeVisible({ timeout: 20_000 });
  await expect(settings.getByTestId("gateway-says").first()).toContainText(
    "Sign in on the scripted page.",
  );
  const command = settings.getByTestId("command");
  await expect(command).toContainText(/^ssh -N -L (\d+):127\.0\.0\.1:\1 user@gateway-host$/);
  await expect(settings.getByTestId("paste")).toHaveCount(0);
  await shots("signin-host");
  const href = await settings.getByTestId("open-page").getAttribute("href");
  expect(href).toMatch(new RegExp(`^${providerUrl}/`));
  const answered = await scripted<{ redirectUrl: string }>("/scripted/signin/answer", {
    state: stateOf(href),
    outcome: "approve",
    account: "machine",
  });
  // The browser is sent back to the gateway's machine, at the port the command forwards.
  const port = /-L (\d+):/.exec((await command.textContent()) ?? "")![1];
  expect(new URL(answered.redirectUrl).port).toBe(port);
  expect((await fetch(answered.redirectUrl)).status).toBe(200);
  await expect(settings.getByRole("heading", { name: "Connected to Acme" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(settings.getByTestId("landed")).toContainText("Every bot can use it");
  await settings.getByRole("textbox", { name: "Label" }).fill("Machine");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByRole("button", { name: /^Acme · Machine/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
});

test("F-474: OpenRouter's order of steps, on Clawtrate's connection: the page, then the address the browser landed on pasted back, kept from view", async () => {
  const settings = await startFromSettings(/^Acme \(scripted\), back to the gateway/);
  // The gateway offers its own callback only to a connection with a browser origin it accepts;
  // Clawtrate's host has none, so the model asks for the address pasted back, as OpenRouter does.
  const field = settings.getByTestId("paste");
  await expect(field).toBeVisible({ timeout: 20_000 });
  // The step is not marked secret, and carries the page: the field is a password field.
  await expect(field).toHaveAttribute("type", "password");
  await expect(settings.locator(".b-code")).toHaveCount(0);
  await expect(
    settings.getByText(/finishes on the gateway's machine|sends your browser back|by itself/),
  ).toHaveCount(0);
  await shots("signin-callback");
  const href = await settings.getByTestId("open-page").getAttribute("href");
  const answered = await scripted<{ redirectUrl: string }>("/scripted/signin/answer", {
    state: stateOf(href),
    outcome: "approve",
    account: "returned",
  });
  await field.fill(answered.redirectUrl);
  await settings.getByRole("button", { name: "Continue" }).click();
  await expect(settings.getByRole("heading", { name: "Connected to Acme" })).toBeVisible({
    timeout: 30_000,
  });
  await settings.getByRole("textbox", { name: "Label" }).fill("Returned");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByRole("button", { name: /^Acme · Returned/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
});

test("F-474: on the gateway's machine and back to the gateway, refused, expired and cancelled each say so, and what the gateway now has", async () => {
  test.setTimeout(180_000);
  for (const [method, outcome, heading] of [
    [/^Acme \(scripted\) on the gateway's machine/, "expire", "The sign-in expired"],
    [/^Acme \(scripted\), back to the gateway/, "refuse", "Couldn't connect"],
  ] as const) {
    const settings = await startFromSettings(method);
    const href = await settings.getByTestId("open-page").getAttribute("href", { timeout: 20_000 });
    const answered = await scripted<{ redirectUrl: string }>("/scripted/signin/answer", {
      state: stateOf(href),
      outcome,
      account: `no${outcome}`,
    });
    // On the gateway's machine the browser comes back to its listener; otherwise it is pasted.
    if (method.source.includes("back to the gateway")) {
      await settings.getByTestId("paste").fill(answered.redirectUrl, { timeout: 20_000 });
      await settings.getByRole("button", { name: "Continue" }).click();
    } else await fetch(answered.redirectUrl);
    await expect(settings.getByRole("heading", { name: heading })).toBeVisible({ timeout: 30_000 });
    await expect(settings.getByTestId("reread")).toHaveText(
      "Clawtrate checked the gateway's accounts: no new Acme account.",
      { timeout: 20_000 },
    );
    await page.keyboard.press("Escape");
  }
  // Cancelled while it waits for the browser: the gateway confirms it, and closes its listener.
  const settings = await startFromSettings(/^Acme \(scripted\) on the gateway's machine/);
  await expect(settings.getByTestId("command")).toBeVisible({ timeout: 20_000 });
  const port = /-L (\d+):/.exec((await settings.getByTestId("command").textContent()) ?? "")![1];
  await settings.getByRole("button", { name: "Cancel" }).click();
  await expect(settings.getByRole("heading", { name: "Sign-in cancelled" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(settings.getByTestId("reread")).toContainText("no new Acme account", {
    timeout: 20_000,
  });
  await expect
    .poll(
      () =>
        fetch(`http://127.0.0.1:${port}/callback`).then(
          () => "open",
          () => "closed",
        ),
      {
        timeout: 20_000,
      },
    )
    .toBe("closed");
  await page.keyboard.press("Escape");
});

test("F-474: saved, not confirmed: the gateway saved the sign-in and says it could not apply it; Continue names the account it now lists, still not confirmed", async () => {
  const settings = await startFromSettings(/^Acme \(scripted\) · a link and a code/);
  const code = settings.locator(".b-code code");
  await expect(code).toBeVisible({ timeout: 20_000 });
  await scripted("/scripted/signin/answer", {
    userCode: await code.textContent(),
    outcome: "unconfirmed",
    account: "unsure",
  });
  await expect(settings.getByRole("heading", { name: "Saved, not confirmed" })).toBeVisible({
    timeout: 30_000,
  });
  // The gateway's own words, as given.
  await expect(
    settings.getByText(/^Credentials saved, but provider settings could not be applied/),
  ).toBeVisible();
  await shots("signin-unconfirmed");
  expect((await view("main", "acme"))?.profiles.some((p) => p.profileId === "acme:unsure")).toBe(
    true,
  );
  // Nothing of the setting the gateway refused landed.
  expect(((await config()).models as Json | undefined)?.providers).toMatchObject({
    acme: { api: "openai-completions" },
  });
  await settings.getByRole("button", { name: "Continue" }).click();
  // The naming screen keeps the outcome: never a green "Connected to" the read didn't confirm.
  await expect(settings.getByRole("textbox", { name: "Label" })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Saved, not confirmed" })).toBeVisible();
  await expect(settings.getByRole("heading", { name: /^Connected to/ })).toHaveCount(0);
  await settings.getByRole("textbox", { name: "Label" }).fill("Unsure");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByRole("button", { name: /^Acme · Unsure/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
});

test("F-474: the gateway is busy with another sign-in: the screen says so, and starts again when it ends", async () => {
  const other = "accounts-e2e-busy";
  await admin.request("models.authLogin", {
    sessionId: other,
    authChoice: SIGNIN_CHOICES.deviceCode,
    agentId: "main",
  });
  try {
    const settings = await startFromSettings(/^Acme \(scripted\) · a link and a code/);
    await expect(settings.getByRole("heading", { name: "The gateway is busy" })).toBeVisible({
      timeout: 20_000,
    });
    await admin.request("wizard.cancel", { sessionId: other });
    await settings.getByRole("button", { name: "Try again" }).click();
    await expect(settings.locator(".b-code code")).toBeVisible({ timeout: 20_000 });
    await settings.getByRole("button", { name: "Cancel" }).click();
    await expect(settings.getByRole("heading", { name: "Sign-in cancelled" })).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await admin.request("wizard.cancel", { sessionId: other }).catch(() => undefined);
    await page.keyboard.press("Escape");
  }
});

test("F-474: the connection dropped mid sign-in: it ended with it, the accounts are read again, and an approval afterwards saves nothing", async () => {
  test.setTimeout(120_000);
  const settings = await startFromSettings(/^Acme \(scripted\) · a link and a code/);
  const code = settings.locator(".b-code code");
  await expect(code).toBeVisible({ timeout: 20_000 });
  const userCode = await code.textContent();
  // The host's connection to the gateway goes, and comes back.
  await hostCommand({ type: "suspend" });
  await expect(settings.getByRole("heading", { name: "The sign-in ended" })).toBeVisible({
    timeout: 30_000,
  });
  await hostCommand({ type: "retry" });
  await expect(settings.getByRole("heading", { name: "The sign-in ended" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(settings.getByTestId("reread")).toContainText("no new Acme account", {
    timeout: 30_000,
  });
  await shots("signin-ended");
  // The gateway ended it too: approving the code now saves no account.
  await scripted("/scripted/signin/answer", { userCode, outcome: "approve", account: "dropped" });
  await page.waitForTimeout(3000);
  expect((await view("main", "acme"))?.profiles.some((p) => p.profileId === "acme:dropped")).toBe(
    false,
  );
  await page.keyboard.press("Escape");
});

test("F-490: a bot whose model on the gateway lists fallbacks, or lost its account, is reported with the way to correct it", async () => {
  test.setTimeout(120_000);
  // Fallbacks written on the gateway, not by Clawtrate.
  await patchConfig({
    agents: { entries: { second: { model: { fallbacks: ["globex/dev-1"] } } } },
  });
  const settings = await accountPage();
  await settings.getByRole("button", { name: "Check now" }).click();
  const note = settings.getByTestId("fallbacks-note");
  await expect(note).toContainText(
    "Second can move to another model. Its model on the gateway lists fallbacks (globex/dev-1)",
    { timeout: 20_000 },
  );
  await note.getByRole("button", { name: "Remove fallbacks" }).click();
  await expect(note).toHaveCount(0, { timeout: 20_000 });
  expect(entry(await config(), "second")!.model).toEqual({
    primary: "acme/dev-1@acme:work",
    fallbacks: [],
  });
  // The account suffix removed on the gateway, where Clawtrate set one: reported as such,
  // not as "Gateway chooses".
  await patchConfig({ agents: { entries: { second: { model: { primary: "acme/dev-1" } } } } });
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(
    settings.getByText(
      "The gateway's model for Second has no account. It now uses the gateway's choice of Acme account.",
    ),
  ).toBeVisible({ timeout: 30_000 });
  await expect(settings.getByRole("button", { name: "Choose an account" })).toBeVisible();
  await patchConfig({
    agents: { entries: { second: { model: { primary: "acme/dev-1@acme:work" } } } },
  });
});

test("F-476 F-490: an order in the gateway's settings is named as that, never as a lock", async () => {
  test.setTimeout(120_000);
  // Second on Acme · Work; the gateway's owner orders Acme's accounts in the settings: that one alone.
  // A patch that changes nothing makes no new revision to wait for, so it is made only when needed.
  const onWork = { primary: "acme/dev-1@acme:work", fallbacks: [] };
  if (JSON.stringify(entry(await config(), "second")?.model) !== JSON.stringify(onWork))
    await patchConfig({ agents: { entries: { second: { model: onWork } } } });
  await patchConfig({ auth: { order: { acme: ["acme:work"] } } });
  try {
    const status = await view("second", "acme");
    expect(status?.profileOrder).toEqual(["acme:work"]);
    const settings = await accountPage();
    await settings.getByRole("button", { name: "Check now" }).click();
    await expect(settings.getByTestId("evidence")).toContainText(
      "The gateway's settings order Acme's accounts as Acme · Work. That order is the gateway's, not Second's own, so it is not a lock.",
      { timeout: 20_000 },
    );
    await expect(settings.getByTestId("locked-note")).toHaveCount(0);
    await expect(settings.getByTestId("bound-note")).toBeVisible();
    await page.getByRole("button", { name: "Back to settings" }).click();
    await expect(page.getByTestId("account-word")).toHaveText("Bound");
  } finally {
    await patchConfig({ auth: { order: { acme: null } } }, ["auth.order.acme"]);
  }
});

test("F-476 F-490: an account only another bot keeps is no account for this bot, and never a lock", async () => {
  test.setTimeout(120_000);
  // acme:studio is in Otto's own store: Otto's view lists it, Second's does not.
  expect((await view("otto", "acme"))?.profiles.some((p) => p.profileId === "acme:studio")).toBe(
    true,
  );
  expect((await view("second", "acme"))?.profiles.some((p) => p.profileId === "acme:studio")).toBe(
    false,
  );
  await patchConfig({
    agents: { entries: { second: { model: { primary: "acme/dev-1@acme:studio" } } } },
  });
  try {
    const settings = await accountPage();
    await settings.getByRole("button", { name: "Check now" }).click();
    await expect(
      settings.getByText(
        "No account. Second's account, Acme · Studio, is kept by Otto only, so Second can't use it.",
        { exact: false },
      ),
    ).toBeVisible({ timeout: 20_000 });
    await expect(settings.getByTestId("locked-note")).toHaveCount(0);
    await page.getByRole("button", { name: "Back to settings" }).click();
    await expect(page.getByTestId("account-word")).toHaveText("No account");
  } finally {
    await patchConfig({
      agents: { entries: { second: { model: { primary: "acme/dev-1@acme:work" } } } },
    });
  }
});

/** A merge patch of the gateway's config, as the gateway's owner might make it, applied. */
async function patchConfig(patch: Json, replacePaths?: string[]): Promise<void> {
  const before = await admin.request<{ hash: string; configRevisionHash?: string }>(
    "config.get",
    {},
  );
  await admin.request("config.patch", {
    raw: JSON.stringify(patch),
    baseHash: before.hash,
    ...(replacePaths ? { replacePaths } : {}),
  });
  await expect
    .poll(
      async () => {
        const now = await admin.request<{
          configRevisionHash?: string;
          appliedConfigHash?: string;
        }>("config.get", {});
        return (
          now.configRevisionHash !== before.configRevisionHash &&
          now.appliedConfigHash === now.configRevisionHash
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** An Acme account of its own, through the scripted API-key sign-in, for main (shared). */
async function signInKey(name: string): Promise<string> {
  const sessionId = `accounts-e2e-${name}`;
  await admin.request("models.authLogin", {
    sessionId,
    authChoice: SIGNIN_CHOICES.apiKey,
    agentId: "main",
  });
  let answer: { stepId: string; value: unknown } | undefined;
  for (let i = 0; i < 20; i += 1) {
    const next = await admin.request<{
      done: boolean;
      status?: string;
      step?: { id: string; type: string; sensitive?: boolean };
    }>("wizard.next", { sessionId, ...(answer ? { answer } : {}) });
    if (next.done) {
      expect(next.status).toBe("done");
      return `acme:${name}`;
    }
    const step = next.step!;
    answer =
      step.type === "text" && step.sensitive
        ? { stepId: step.id, value: `clawtrate-dev-key.acme.${name}` }
        : { stepId: step.id, value: true };
  }
  throw new Error(`the sign-in of acme:${name} did not finish`);
}

test("F-476 F-490: a locked bot whose account answers 401, 402 or 429 fails the run, and no request reaches another account", async () => {
  // A rate-limited account is retried ten times with growing pauses: minutes on a loaded machine.
  test.setTimeout(1_200_000);
  const created = await admin.request<{ agentId: string }>("agents.create", {
    name: "Fence",
    model: "acme/dev-1@acme:work",
  });
  const bot = created.agentId;
  for (const status of [401, 402, 429] as const) {
    // A fresh account for each failure: the gateway rests an account after one.
    const account = await signInKey(`fence${status}`);
    await patchConfig({
      agents: {
        entries: { [bot]: { model: { primary: `acme/dev-1@${account}`, fallbacks: [] } } },
      },
    });
    devGateway(INSTANCE, "lock", "--agent", bot, "--provider", "acme", account);
    expect((await view(bot, "acme"))?.profileOrder).toEqual([account]);
    await scripted("/scripted/accounts/fail", { account, status });
    const session = `agent:${bot}:fence-${status}`;
    const sent = await admin.send(session, "#text");
    const end = await admin.terminal(String(sent.runId), 300_000);
    expect(end.state, `the run on ${account} answering ${status}`).toBe("error");
    const requests = await requestsFor(session);
    expect(requests.length).toBeGreaterThan(0);
    // Every request went to the locked account; none reached another Acme account.
    expect(requests.map((each) => each.account)).toEqual(requests.map(() => account));
    await scripted("/scripted/accounts/clear", { account });
  }
  // The interface says what the gateway's order shows, once it reads the bots again: a bot
  // another client made appears with the next read of the gateway's bots.
  await hostCommand({ type: "retry" });
  await expect(botRow("Fence")).toBeVisible({ timeout: 30_000 });
  await botRow("Fence").click();
  if (!(await page.getByTestId("work-panel").isVisible()))
    await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Account: / }).click();
  // Its account has no label: it is named by its provider and its id on the gateway.
  await expect(page.getByTestId("locked-note")).toContainText(
    "Locked. Fence's ordinary runs use Acme acme:fence429 only",
    { timeout: 30_000 },
  );
  devGateway(INSTANCE, "unlock", "--agent", bot, "--provider", "acme");
});

/** The bot's runs on `session` and the accounts the scripted model saw them come from. */
async function runOn(session: string, since: number): Promise<string[]> {
  const sent = await admin.send(session, "#text");
  await admin.terminal(String(sent.runId), 120_000);
  return (await requestsSince(session, since)).map((each) => String(each.account));
}

test("F-475: a key for a provider the gateway already keys says it replaces that key; the gateway keeps the new one, runs use it, and Clawtrate keeps it nowhere", async () => {
  test.setTimeout(240_000);
  const first = "clawtrate-dev-key.globex.first";
  const second = "clawtrate-dev-key.globex.second";
  const out: string[] = [];
  host!.child.stdout!.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")));
  const keyPath = async () => {
    const settings = await connectFromSettings();
    await settings.getByRole("button", { name: "Connect an account" }).first().click();
    await settings.locator("details.b-disclosure summary").click();
    await settings.getByRole("combobox", { name: "Provider" }).selectOption("globex");
    return settings;
  };
  // Globex has a token and no key: nothing to replace.
  let settings = await keyPath();
  await expect(settings.getByText(/This replaces the Globex key/)).toHaveCount(0);
  await settings.getByTestId("api-key").fill(first);
  await settings.getByRole("button", { name: "Save key" }).click();
  await expect(settings.getByRole("heading", { name: "Key saved" })).toBeVisible({
    timeout: 30_000,
  });
  const keyed = (await view("main", "globex"))?.profiles.filter((p) => p.type === "api_key") ?? [];
  expect(keyed.map((p) => p.profileId)).toEqual(["globex:manual"]);
  await settings.getByRole("textbox", { name: "Label" }).fill("Direct");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByRole("button", { name: /^Globex · Direct, API key/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
  // A bot on that account: its run carries the key the gateway keeps.
  const created = await admin.request<{ agentId: string }>("agents.create", {
    name: "Keyed",
    model: "globex/dev-1@globex:manual",
  });
  const session = `agent:${created.agentId}:keyed`;
  expect(await runOn(session, await lastSeq())).toEqual(["globex:first"]);

  // Now the gateway has a Globex key: the form says the new one replaces it.
  settings = await keyPath();
  const note = settings.getByText(
    "This replaces the Globex key your gateway already has. Bots that use it switch to the new key. To keep both, add the second on the gateway's machine.",
  );
  await expect(note).toBeVisible();
  await shots("connect-key-replace");
  await settings.getByTestId("api-key").fill(second);
  await settings.getByRole("button", { name: "Save key" }).click();
  await expect(settings.getByRole("heading", { name: "Key saved" })).toBeVisible({
    timeout: 30_000,
  });
  // Replaced, not added: the same account, and the next run carries the new key.
  const after = (await view("main", "globex"))?.profiles.filter((p) => p.type === "api_key") ?? [];
  expect(after.map((p) => p.profileId)).toEqual(["globex:manual"]);
  expect(await runOn(session, await lastSeq())).toEqual(["globex:second"]);
  // The account keeps its label: Done writes nothing new.
  await expect(settings.getByRole("textbox", { name: "Label" })).toHaveValue("Direct");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByRole("button", { name: /^Globex · Direct, API key/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");

  // Sent once from the page, and never back; in none of the host's files, output or the page.
  for (const key of [first, second]) {
    expect(sentFrames.filter((frame) => frame.includes(key))).toHaveLength(1);
    expect(frames.some((frame) => frame.includes(key))).toBe(false);
    expect(hostFiles(host!.data).includes(key)).toBe(false);
    expect(out.join("").includes(key)).toBe(false);
    expect(await page.content()).not.toContain(key);
  }
});
