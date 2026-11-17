// The packaged app launches, shows its window and connect screen, and pairs
// with a development gateway instance of this run's own. On Windows, where no
// development gateway runs, the tests that need one are skipped.
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { devGateway } from "../e2e/global-setup.ts";
import { provenEndpoint } from "../tools/dev-gateway/src/endpoint.ts";
import { runDirFor } from "../tools/dev-gateway/src/instance.ts";
import { appEnv, packagedExecutable } from "./global-setup.ts";
import {
  integrityLevels,
  mainWindowTitle,
  taskbarOverlayDescription,
  windowsProcesses,
} from "./windows.ts";

const ROOT = join(import.meta.dirname, "..");
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const APP = process.env.CLAWTRATE_PACKAGED_APP!;
const USER_DATA = process.env.CLAWTRATE_PACKAGED_USER_DATA!;
const APP_PID = Number(process.env.CLAWTRATE_PACKAGED_PID);
const WINDOWS = process.platform === "win32";
const NO_GATEWAY = "no development gateway runs on Windows";

/** The app's direct children, as the system reports them: PID and full command line. */
function helpers(): { pid: number; command: string }[] {
  if (WINDOWS) return windowsProcesses().filter(({ ppid }) => ppid === APP_PID);
  const out = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  return out.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && Number(match[2]) === APP_PID
      ? [{ pid: Number(match[1]), command: match[3]! }]
      : [];
  });
}

/**
 * The kernel's answer to whether a process is confined by a sandbox:
 * `sandbox_check(pid, NULL, 0)` from libSystem returns 1 for a process that
 * has entered a Seatbelt profile and 0 for one that has not. Node has no way
 * to call it, so Apple's Python (part of the command line tools that git on
 * macOS already needs) calls it through ctypes.
 */
function kernelSaysSandboxed(pid: number): number {
  const script = [
    "import ctypes, sys",
    "lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
    "lib.sandbox_check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]",
    "print(lib.sandbox_check(int(sys.argv[1]), None, 0))",
  ].join("\n");
  return Number(
    execFileSync("/usr/bin/python3", ["-I", "-c", script, String(pid)], {
      encoding: "utf8",
    }).trim(),
  );
}

let browser: Browser;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  browser = await chromium.connectOverCDP(process.env.CLAWTRATE_PACKAGED_CDP!);
  await expect
    .poll(() => browser.contexts().flatMap((context) => context.pages()).length)
    .toBeGreaterThan(0);
  page = browser.contexts().flatMap((context) => context.pages())[0]!;
});

test.afterAll(async () => {
  // Disconnects; the teardown quits the app.
  await browser?.close();
});

test("opens its window from the packaged app on the connect screen", async () => {
  // The renderer is the one inside the app's archive, not the source tree.
  const bundled = WINDOWS
    ? decodeURI(
        pathToFileURL(join(realpathSync(APP), "resources/app.asar/out/renderer/index.html")).href,
      )
    : `file://${realpathSync(APP)}/Contents/Resources/app.asar/out/renderer/index.html`;
  expect(decodeURI(page.url())).toBe(bundled);
  await expect(page).toHaveTitle("Clawtrate");
  await expect(page.getByRole("heading", { name: "Clawtrate" })).toBeVisible();
  await expect(page.getByPlaceholder("Gateway address")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
  // A packaged app does not look for the development gateway.
  await expect(page.getByRole("button", { name: "Use the development gateway" })).toHaveCount(0);

  // No Node in the page, only the preload's narrow bridge, and the page's policy is in force.
  const page_ = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    host: Object.keys((window as unknown as { clawtrateHost: object }).clawtrateHost).sort(),
    csp:
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") ?? "",
  }));
  expect(page_.require).toBe("undefined");
  expect(page_.process).toBe("undefined");
  // The whole bridge: five functions and the platform name. `attach` hands a file's
  // bytes to the main process for a later message, and `setBadge` gives it the number
  // of unread tasks for the dock badge; anything else here is a regression.
  expect(page_.host).toEqual(["attach", "hello", "onState", "platform", "send", "setBadge"]);
  expect(page_.csp).toContain("default-src 'self'");
  expect(page_.csp).toContain("script-src 'self'");
});

test("names its window Clawtrate, as Windows sees it", async () => {
  test.skip(!WINDOWS, "on macOS the page's title above is the window's title");
  // The window is shown once its page has painted; until then Windows reports no title.
  await expect.poll(() => mainWindowTitle(APP_PID), { timeout: 20_000 }).toBe("Clawtrate");
});

test("shows unread tasks as an overlay on its taskbar button, and clears it at zero", async () => {
  test.skip(!WINDOWS, "the macOS dock badge is not read from outside yet");
  // The page reports the count through the bridge, as the renderer does for
  // unread tasks; the main process sets the overlay icon, whose description
  // Windows gives as the taskbar button's help text.
  const exe = packagedExecutable(APP);
  const setBadge = (count: number) =>
    page.evaluate((value) => {
      (
        window as unknown as { clawtrateHost: { setBadge(n: number): void } }
      ).clawtrateHost.setBadge(value);
    }, count);
  await setBadge(3);
  await expect.poll(() => taskbarOverlayDescription(exe), { timeout: 15_000 }).toBe("3 unread");
  await setBadge(0);
  await expect.poll(() => taskbarOverlayDescription(exe), { timeout: 15_000 }).toBe("");
});

test("hands a second launch to the running app instead of starting another", async () => {
  // The same data folder, so the same single-instance lock. The second process
  // must exit by itself, successfully, and leave the first one and its one window.
  const second = spawn(packagedExecutable(APP), [`--user-data-dir=${USER_DATA}`], {
    env: appEnv(),
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => second.once("exit", resolve));
  const code = await Promise.race([
    exited,
    new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 15_000)),
  ]);
  if (code === "running") second.kill();
  expect(code, "the second launch's exit code").toBe(0);
  expect(() => process.kill(APP_PID, 0), "the first app is still running").not.toThrow();
  await page.waitForTimeout(500);
  expect(browser.contexts().flatMap((context) => context.pages())).toHaveLength(1);
});

test("runs its renderer in the operating system's sandbox", () => {
  expect(Number.isInteger(APP_PID) && APP_PID > 1).toBe(true);
  if (WINDOWS) {
    // Room for PowerShell's first compile of the token reader (see integrityLevels).
    test.setTimeout(150_000);
    // Chromium starts a sandboxed renderer on Windows with a restricted token at
    // untrusted integrity, and the main process keeps the user's own level. The
    // integrity level is read from each process's token, from outside.
    // This assertion has never been seen to fail: the packaged Windows app,
    // started with the sandbox turned off (--no-sandbox or
    // ELECTRON_DISABLE_SANDBOX=1), crashes at once with an access violation
    // (0xC0000005) before any renderer exists, so no unsandboxed renderer could
    // be produced to read.
    const renderers = helpers().filter(({ command }) => /\s--type=renderer(\s|$)/.test(command));
    expect(renderers.length, "the app's renderer processes").toBeGreaterThan(0);
    const levels = integrityLevels([APP_PID, ...renderers.map(({ pid }) => pid)]);
    for (const { pid, command } of renderers) {
      expect(command, `renderer ${pid}`).not.toMatch(/\s--no-sandbox(\s|$)/);
      expect(levels.get(pid), `integrity level of renderer ${pid}`).toBe(0);
    }
    expect(levels.get(APP_PID), "integrity level of the main process").toBeGreaterThan(0);
    return;
  }
  // The page having no Node globals says nothing about the sandbox; context
  // isolation alone gives that. So the evidence is the renderer process
  // itself, from outside it. Its launch arguments show how Chromium started
  // it: a sandboxed renderer gets --seatbelt-client, the pipe over which it
  // receives its Seatbelt profile and enters it before running any page code,
  // and an unsandboxed one gets --no-sandbox and no seatbelt client. The
  // kernel then confirms the process is actually confined. Neither can be
  // satisfied when `sandbox: false` or a missing app.enableSandbox() lets the
  // renderer run unsandboxed, which is what this test exists to catch.
  const renderers = helpers().filter(({ command }) => /\s--type=renderer(\s|$)/.test(command));
  expect(renderers.length, "the app's renderer processes").toBeGreaterThan(0);
  for (const { pid, command } of renderers) {
    expect(command, `renderer ${pid}`).toMatch(/\s--seatbelt-client=\d+(\s|$)/);
    expect(command, `renderer ${pid}`).not.toMatch(/\s--no-sandbox(\s|$)/);
    expect(kernelSaysSandboxed(pid), `sandbox_check for renderer ${pid}`).toBe(1);
  }
  // The same query tells an unsandboxed process apart: the main process is not sandboxed.
  expect(kernelSaysSandboxed(APP_PID), "sandbox_check for the main process").toBe(0);
});

test("pairs with its own development gateway instance and shows the seeded bots", async () => {
  test.skip(WINDOWS, NO_GATEWAY);
  expect(INSTANCE).toMatch(/^e2e-[0-9a-f]{8}$/);
  const endpoint = provenEndpoint({
    instance: INSTANCE,
    home: homedir(),
    runDir: runDirFor(INSTANCE, join(ROOT, "tools/dev-gateway/.run")),
    checkout: realpathSync(ROOT),
  });
  if ("refusal" in endpoint) throw new Error(endpoint.refusal);
  expect(endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:(19[2-9]\d\d)$/);

  await page.getByPlaceholder("Gateway address").fill(endpoint.url);
  await page.getByPlaceholder("Token, for the first pairing only").fill(endpoint.token);
  await page.getByRole("button", { name: "Connect" }).click();

  // A fresh device identity must be approved on the gateway, over the real protocol.
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  devGateway(INSTANCE, "approve");

  const bots = page.getByTestId("bot");
  await expect(bots).toHaveCount(4, { timeout: 20_000 });
  // The rail orders bots by recent activity (F-031), so the names are compared as a set.
  expect((await bots.locator(".bot-name").allTextContents()).sort()).toEqual([
    "Juniper",
    "Marlow",
    "Otto",
    "Pip",
  ]);
  await page.getByRole("button", { name: /^Otto, \d+ tasks?/ }).click();
  await page
    .getByRole("list", { name: "Otto's tasks" })
    .getByTestId("task")
    .filter({ hasText: "Disk almost full on the media box" })
    .click();
  await expect(page.getByTestId("transcript-turn")).toHaveCount(4);
});

test("keeps the device key and tokens in its own data folder, readable by the user only", () => {
  test.skip(WINDOWS, `${NO_GATEWAY}, so the app has paired with none and written no key`);
  const dir = join(USER_DATA, "gateway");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const files = readdirSync(dir);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(statSync(join(dir, file)).mode & 0o077, file).toBe(0);
  }
});

test("stays on its own content", async () => {
  // A navigation the page starts is refused, and so is a window for anything
  // but the web. Checked from inside the page: the refused navigation leaves
  // Playwright waiting for one to finish.
  const result = await page.evaluate(async () => {
    const before = location.href;
    const win = window.open("file:///etc/hosts");
    location.href = "https://example.invalid/";
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return {
      windowRefused: win === null,
      stayed: location.href === before,
      bots: document.querySelectorAll('[data-testid="bot"]').length,
    };
  });
  // Paired on macOS, so the seeded bots are still shown; on Windows the connect screen is.
  expect(result).toEqual({ windowRefused: true, stayed: true, bots: WINDOWS ? 0 : 4 });
  expect(browser.contexts().flatMap((context) => context.pages())).toHaveLength(1);
});
