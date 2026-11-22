// F-248 on the desktop app built from this checkout (docs/design/links.md). The
// app runs against an in-memory gateway on 127.0.0.1 and is driven over the
// DevTools protocol, as the update check does. A link reaches it the way Windows
// delivers one, with the command the installer registers, `"<app>" -- "%1"`: as
// the argument of a second launch with the same data folder, which hands it to
// the running app and exits, or of the launch that starts the app. macOS sends
// `open-url` instead, which only the system can.

import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_ID, linkGateway } from "../apps/desktop/test/link-gateway.ts";
import { appEnv, debuggingPort } from "../e2e-packaged/desktop-driver.ts";
import { askToClose, forceEnd } from "../e2e-packaged/windows.ts";

const DESKTOP = join(import.meta.dirname, "../apps/desktop");
const WINDOWS = process.platform === "win32";
const ADDED = "Link text added to your draft. Nothing was sent.";
/** Wide enough for the rail beside the conversation, too narrow to dock Work: a drawer. */
const DRAWER = { width: 900, height: 800 };

const link = (bot: string, text: string, gateway = GATEWAY_ID) =>
  `clawtrate://chat?bot=${bot}&gateway=${gateway}&text=${encodeURIComponent(text)}`;

async function stopElectron(child: ChildProcess) {
  const { pid } = child;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(25_000) });
  const force = () => (WINDOWS ? forceEnd(pid) : child.kill("SIGKILL"));
  const timer = setTimeout(force, 15_000);
  try {
    if (WINDOWS) {
      if (askToClose(pid)) force();
    } else child.kill("SIGTERM");
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolved in beforeAll: listing the checks must not look for, or fetch, Electron. */
let electron: string;
let dir: string;
let profile: string;
let served: Awaited<ReturnType<typeof linkGateway>>;
let app: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;
/** Everything this file started and has not seen exit, stopped by PID at the end. */
const started = new Set<ChildProcess>();
const cleanup = new AsyncDisposableStack();

function start(args: string[]): ChildProcess {
  const child = spawn(electron, [dir, `--user-data-dir=${profile}`, ...args], {
    cwd: dir,
    env: appEnv(),
    stdio: "ignore",
  });
  started.add(child);
  child.once("exit", () => started.delete(child));
  return child;
}

/** Start the app on the test's data folder, with `extra` arguments, and find its page. */
async function launch(...extra: string[]): Promise<Page> {
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
  const child = start(["--remote-debugging-port=0", ...extra]);
  app = child;
  await once(child, "spawn");
  const port = await debuggingPort(profile, child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0]!;
  const found = context.pages()[0] ?? (await context.waitForEvent("page"));
  await found.locator(".app").waitFor();
  return found;
}

async function quit() {
  await browser?.close();
  browser = undefined;
  if (app) await stopElectron(app);
  app = undefined;
}

/** Open a link as Windows does while the app runs: a second launch that hands it over. */
async function deliver(...given: string[]) {
  const second = start(["--", ...given]);
  try {
    const [code] = (await once(second, "exit", { signal: AbortSignal.timeout(30_000) })) as [
      number | null,
    ];
    expect(code, "the second launch hands over and exits").toBe(0);
  } finally {
    await stopElectron(second);
  }
}

const field = () => page.getByTestId("composer-input");
const note = () => page.getByTestId("link-note");
const shell = () => page.locator(".shell");
const botButton = (name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name},`) });
const choice = () => page.getByRole("alertdialog", { name: "Replace your draft?" });
const refusal = () => page.getByRole("alertdialog", { name: "Can't open link" });

async function expectCaretAtEnd(locator: Locator) {
  const [start, end, length] = await locator.evaluate((element: HTMLTextAreaElement) => [
    element.selectionStart,
    element.selectionEnd,
    element.value.length,
  ]);
  expect([start, end]).toEqual([length, length]);
}

async function expectCantOpen(reason: string) {
  const card = refusal();
  await expect(card).toBeVisible();
  await expect(card).toHaveAccessibleDescription(reason);
  await expect(card.getByRole("button")).toHaveText(["Close"]);
  await expect(card.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(0);
}

/** Two frames: what a key press changed has rendered. */
const frames = () =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );

/** The gateway calls that would mark this chat read. */
const reads = (key: string) =>
  served.gateway
    .calls("sessions.patch")
    .filter((params) => (params as { key?: string }).key === key);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  electron = createRequire(join(DESKTOP, "package.json"))("electron") as string;
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-link-app-")));
  cleanup.defer(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  );
  profile = join(dir, "profile");
  execFileSync(
    process.execPath,
    [
      join(DESKTOP, "node_modules/electron-vite/bin/electron-vite.js"),
      "build",
      "--outDir",
      join(dir, "out"),
    ],
    { cwd: DESKTOP, env: appEnv(), stdio: "ignore", timeout: 120_000, killSignal: "SIGKILL" },
  );
  cpSync(join(DESKTOP, "resources"), join(dir, "resources"), { recursive: true });
  symlinkSync(
    join(DESKTOP, "node_modules"),
    join(dir, "node_modules"),
    WINDOWS ? "junction" : "dir",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "link-check",
      version: "0.1.0",
      type: "module",
      main: "out/main/index.js",
    }),
  );
  served = await linkGateway();
  cleanup.defer(() => served.close());
  // First at the end: every app this file started, before the gateway and the folder go.
  cleanup.defer(async () => {
    await browser?.close().catch(() => {});
    for (const child of [...started]) await stopElectron(child);
  });
  page = await launch();
  await page.getByPlaceholder("Gateway address").fill(served.url);
  await page.getByRole("button", { name: "Connect a gateway", exact: true }).click();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
});

test.afterAll(async () => {
  await cleanup.disposeAsync();
});

test("F-248: a link handed over by a second launch opens the bot's chat with its text, unsent", async () => {
  // The app shows another bot's chat when the link comes.
  await botButton("Otto").click();
  await expect(field()).toHaveAttribute("aria-label", "Message Otto");

  await deliver(link("marlow", "Review the intro.\nKeep it short."));
  await expect(field()).toHaveAttribute("aria-label", "Message Marlow");
  await expect(field()).toHaveValue("Review the intro.\nKeep it short.");
  await expect(note()).toHaveText(ADDED);
  await expect(note()).toHaveAttribute("role", "status");
  await expect(field()).toBeFocused();
  await expectCaretAtEnd(field());
  expect(served.gateway.calls("chat.send")).toEqual([]);
  // Editing the draft drops the notice.
  await page.keyboard.type(" Thanks.");
  await expect(note()).toHaveText("");
  await expect(field()).toHaveValue("Review the intro.\nKeep it short. Thanks.");
  expect(served.gateway.calls("chat.send")).toEqual([]);
});

test("F-248: a link into a chat with a draft asks before replacing it", async () => {
  const draft = "Review the intro.\nKeep it short. Thanks.";
  const keep = choice().getByRole("button", { name: "Keep draft" });
  const replace = choice().getByRole("button", { name: "Replace draft" });

  await deliver(link("marlow", "Start over."));
  await expect(choice()).toBeVisible();
  await expect(choice()).toHaveAccessibleDescription(
    "You already have a draft in this chat with Marlow. Replacing it discards that draft.",
  );
  await expect(keep).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(replace).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(keep).toBeFocused();
  // Escape keeps the draft, as Keep draft does.
  await page.keyboard.press("Escape");
  await expect(choice()).toHaveCount(0);
  await expect(field()).toHaveValue(draft);
  await expect(field()).toBeFocused();
  await expect(note()).toHaveText("");

  await deliver(link("marlow", "Start over."));
  await keep.click();
  await expect(choice()).toHaveCount(0);
  await expect(field()).toHaveValue(draft);
  await expect(field()).toBeFocused();

  await deliver(link("marlow", "Start over."));
  await replace.click();
  await expect(choice()).toHaveCount(0);
  await expect(field()).toHaveValue("Start over.");
  await expect(note()).toHaveText(ADDED);
  await expect(field()).toBeFocused();
  await expectCaretAtEnd(field());
  expect(served.gateway.calls("chat.send")).toEqual([]);
});

test("F-248: while a link asks about a draft, the composer's shortcuts behind it do nothing", async () => {
  await deliver(link("marlow", "Other words."));
  await expect(choice()).toBeVisible();
  // ⌘↵ or Ctrl+Enter would send the draft from anywhere else in the window.
  await page.keyboard.press("ControlOrMeta+Enter");
  await frames();
  await expect(field()).toHaveValue("Start over.");
  expect(served.gateway.calls("chat.send")).toEqual([]);
  await expect(choice()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(choice()).toHaveCount(0);
  await expect(field()).toHaveValue("Start over.");
});

test("F-248: a link that cannot open says why, and leaves the chat and its draft as they were", async () => {
  for (const [raw, reason] of [
    [`${link("marlow", "Hi")}&send=1`, "This Clawtrate link is invalid. Ask for a new link."],
    [
      link("marlow", "Hi", "0".repeat(64)),
      "This link is for a different gateway. Connect to that gateway, then open the link again.",
    ],
    [
      link("nobody", "Hi"),
      "This bot isn't on the connected gateway. Check the link or ask for a new one.",
    ],
    [link("quill", "Hi"), "This bot has no chat to open."],
  ] as const) {
    await field().focus();
    await deliver(raw);
    await expectCantOpen(reason);
    await expect(field()).toBeFocused();
    await expect(field()).toHaveAttribute("aria-label", "Message Marlow");
    await expect(field()).toHaveValue("Start over.");
  }

  served.refuse(true);
  await expect(page.locator(".app")).toHaveAttribute("data-connection", "lost");
  await deliver(link("otto", "Hi"));
  await expectCantOpen(
    "Clawtrate isn't connected to a gateway. Connect to the right gateway, then open the link again.",
  );
  served.refuse(false);
  await expect(page.locator(".app")).not.toHaveAttribute("data-connection", "lost", {
    timeout: 30_000,
  });
  expect(served.gateway.calls("chat.send")).toEqual([]);
});

test("F-248: a link reads no chat on the gateway and saves no layout", async () => {
  await page.setViewportSize(DRAWER);
  const saved = () => page.evaluate(() => localStorage.getItem("clawtrate.panel"));
  await field().focus();
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(shell()).toHaveAttribute("data-panel", "open");
  expect(await saved()).toBe("open");

  // The newest of Wren's chats is unread on the gateway.
  await deliver(link("wren", "Look at the review."));
  await expect(field()).toHaveAttribute("aria-label", "Message Wren");
  await expect(field()).toHaveValue("Look at the review.");
  await expect(shell()).toHaveAttribute("data-panel", "closed");
  // The drawer closed for now; the place the person chose for it stays.
  expect(await saved()).toBe("open");
  // A read made on opening it would have reached the gateway by now.
  await page.waitForTimeout(500);
  expect(reads("agent:wren:review")).toEqual([]);

  // Leaving it does not read it either; opening it again by hand does.
  await botButton("Marlow").click();
  await expect(field()).toHaveAttribute("aria-label", "Message Marlow");
  await page.waitForTimeout(500);
  expect(reads("agent:wren:review")).toEqual([]);
  await botButton("Wren").click();
  await expect(field()).toHaveValue("Look at the review.");
  await expect.poll(() => reads("agent:wren:review").length).toBeGreaterThan(0);
  expect(served.gateway.calls("chat.send")).toEqual([]);
});

test("F-248: Escape on a link's card closes the card and leaves the Work drawer open", async () => {
  await field().focus();
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(shell()).toHaveAttribute("data-panel", "open");
  await deliver(`${link("wren", "Hi")}&send=1`);
  await expect(refusal()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(refusal()).toHaveCount(0);
  await expect(shell()).toHaveAttribute("data-panel", "open");
  // With no card over it, Escape closes the drawer.
  await page.keyboard.press("Escape");
  await expect(shell()).toHaveAttribute("data-panel", "closed");
});

test("F-248: a link Windows split in two is invalid, and its second half is no switch", async () => {
  // Read as a switch, the second half would start a second app on another data folder.
  await deliver(link("marlow", "Hi"), `--user-data-dir=${join(dir, "other")}`);
  await expectCantOpen("This Clawtrate link is invalid. Ask for a new link.");
  expect(served.gateway.calls("chat.send")).toEqual([]);
});

test("F-248: a link that starts the app waits for its connection, then opens the chat", async () => {
  await quit();
  page = await launch("--", link("otto", "Check the release notes."));
  await expect(field()).toHaveAttribute("aria-label", "Message Otto", { timeout: 30_000 });
  await expect(field()).toHaveValue("Check the release notes.");
  await expect(note()).toHaveText(ADDED);
  await expect(field()).toBeFocused();
  // The other chat kept its draft.
  await botButton("Marlow").click();
  await expect(field()).toHaveValue("Start over.");
  expect(served.gateway.calls("chat.send")).toEqual([]);
});
