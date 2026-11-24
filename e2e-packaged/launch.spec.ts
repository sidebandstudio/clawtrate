// The packaged app launches, shows its window and connect screen, and pairs
// with a development gateway instance of this run's own.
import type { DesktopUpdates } from "../packages/core/src/desktop-updates.ts";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { devGateway } from "../e2e/global-setup.ts";
import { approve, openInstance } from "../tools/dev-gateway/src/cli.ts";
import { hostedWindows, windowsIdentity, windowsInstance } from "./windows-gateway.ts";
import { provenEndpoint } from "../tools/dev-gateway/src/endpoint.ts";
import { gatedSpawn, parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { runDirFor } from "../tools/dev-gateway/src/instance.ts";
import { fuseMismatches } from "../apps/desktop/packaging/fuse-check.ts";
import { newerCopy, packagedManifest } from "../apps/desktop/packaging/newer-copy.ts";
import { parseVersion } from "../apps/desktop/src/main/update/version.ts";
import { macSigningRequested, windowsSigningRequested } from "../apps/desktop/packaging/signing.ts";
import { APP_ID } from "../apps/desktop/src/main/identity.ts";
import { recordSuccessor } from "../e2e/run-record.ts";
import { writeSandbox } from "../e2e/setup-sandbox.ts";
import { processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import { debuggingPort } from "./desktop-driver.ts";
import { quitWithin } from "./quit.ts";
import { dictionaryRequests, requestsSoFar } from "./net-log.ts";
import {
  CHECKOUT,
  bundleIdentifier,
  launchArgs,
  launchPlace,
  packagedExecutable,
  processesUsing,
} from "./global-setup.ts";
import {
  askToClose,
  integrityLevels,
  mainWindowTitle,
  taskbarOverlayDescription,
  windowsProcesses,
  type OverlayRead,
} from "./windows.ts";

const ROOT = join(import.meta.dirname, "..");
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const APP = process.env.CLAWTRATE_PACKAGED_APP!;
const USER_DATA = process.env.CLAWTRATE_PACKAGED_USER_DATA!;
const APP_PID = Number(process.env.CLAWTRATE_PACKAGED_PID);
const APP_LOG = process.env.CLAWTRATE_PACKAGED_LOG ?? "";
const SANDBOX = process.env.CLAWTRATE_PACKAGED_SANDBOX!;
const RECORD = process.env.CLAWTRATE_PACKAGED_RECORD ?? "";
/** Where the runner writes the first app's exit status once it has reaped it. */
const APP_EXIT = process.env.CLAWTRATE_PACKAGED_EXIT ?? "";
/** A made-up key for the scripted API-key sign-in: its account is `acme:packaged`. */
const TYPED_KEY = "clawtrate-dev-key.acme.packaged";

/** Whether a file, or any file under a folder, holds the value, as UTF-8 or UTF-16 text. */
function holds(path: string, value: string): string[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (stat.isDirectory())
    return readdirSync(path).flatMap((name) => holds(join(path, name), value));
  // Sockets and links (the single-instance lock's) hold no text of their own.
  if (!stat.isFile()) return [];
  const bytes = readFileSync(path);
  return bytes.includes(Buffer.from(value, "utf8")) || bytes.includes(Buffer.from(value, "utf16le"))
    ? [path]
    : [];
}
const WINDOWS = process.platform === "win32";

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

// No retries: the relaunch test quits the app global setup started, which a
// retry's beforeAll would connect to again. A failed run is rerun whole.
test.describe.configure({ mode: "serial", retries: 0 });

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
  expect(USER_DATA).toBe(realpathSync.native(USER_DATA));
  // The renderer is the one inside the app's archive, not the source tree.
  const bundled = WINDOWS
    ? decodeURI(
        pathToFileURL(join(realpathSync(APP), "resources/app.asar/out/renderer/index.html")).href,
      )
    : `file://${realpathSync(APP)}/Contents/Resources/app.asar/out/renderer/index.html`;
  expect(decodeURI(page.url())).toBe(bundled);
  await expect(page).toHaveTitle("Clawtrate");
  await expect(page.getByRole("heading", { name: "Clawtrate" })).toBeVisible();
  // The first screen asks where OpenClaw runs; the address-and-token form is under Advanced.
  await expect(page.getByRole("heading", { name: "Where does OpenClaw run?" })).toBeVisible();
  await page.getByRole("button", { name: "Advanced" }).click();
  await expect(page.getByPlaceholder("Gateway address")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
  // This checks the packaged build capability before a verified offer exists.
  const updates = await page.evaluate(() =>
    (
      window as unknown as { clawtrateHost: { desktopUpdates: DesktopUpdates } }
    ).clawtrateHost.desktopUpdates.get(),
  );
  // The signing variables that configured the build, as in apps/desktop/packaging/update-defines.ts.
  const signed = WINDOWS ? windowsSigningRequested(process.env) : macSigningRequested(process.env);
  expect(updates).toMatchObject({
    install: {
      kind: "unavailable-in-this-build",
      reason: !signed
        ? "build-not-signed"
        : WINDOWS
          ? "windows-install-pending-trial"
          : "no-verified-download",
    },
    lastAttempt: null,
  });
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { clawtrateHost: { desktopUpdates: DesktopUpdates } }
      ).clawtrateHost.desktopUpdates.restart("absent"),
    ),
  ).toMatchObject({ outcome: "stale", snapshot: { lastAttempt: null } });
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
  // The whole bridge: six functions and the platform name. `attach` hands a file's
  // bytes to the main process for a later message, `save` hands it the bytes of a file
  // the Work pane holds to save where the person chooses, and `setBadge` gives it the
  // number of unread tasks for the dock badge; anything else here is a regression.
  expect(page_.host).toEqual([
    "attach",
    "desktopUpdates",
    "hello",
    "onState",
    "platform",
    "save",
    "send",
    "setBadge",
  ]);
  expect(page_.csp).toContain("default-src 'self'");
  expect(page_.csp).toContain("script-src 'self'");
});

test("opens dark, with no theme chosen yet", async () => {
  // A fresh data folder holds no theme, so the window and the page are the dark default.
  const theme = await page.evaluate(() => ({
    stored: localStorage.getItem("clawtrate.theme"),
    attribute: document.documentElement.dataset.theme,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    ground: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
  }));
  expect(theme).toEqual({ stored: null, attribute: "dark", scheme: "dark", ground: "#101112" });
});

test("looks on this computer only in the sandbox the launch check gave it", async () => {
  await page.getByRole("button", { name: "Back" }).click();
  await page
    .getByRole("list", { name: "Where does OpenClaw run?" })
    .getByRole("button", { name: /This computer/ })
    .click();
  if (WINDOWS) {
    await expect(page.getByRole("heading", { name: "Use Advanced on Windows" })).toBeVisible();
  } else {
    // The run's own instance, by its profile: the only one the sandbox lets the look see.
    await expect(page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("setup-found").locator("dl > div").nth(1)).toHaveText(
      `Profileclawtrate-dev-${INSTANCE}`,
    );
  }
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Advanced" }).click();
  await expect(page.getByPlaceholder("Gateway address")).toBeVisible();
});

test("starts with the update tracks compiled into the packaged app", async () => {
  const updates = await page.evaluate(() =>
    (
      window as unknown as { clawtrateHost: { desktopUpdates: DesktopUpdates } }
    ).clawtrateHost.desktopUpdates.get(),
  );
  expect(updates).toMatchObject({
    revision: 0,
    preferenceIssue: null,
    lastCheck: null,
    pendingTrack: null,
  });
  const tracks = updates.tracks.map(({ track }) => track);
  const supported = ["stable", "nightly"] as const;
  expect(tracks).toEqual(supported.filter((track) => tracks.includes(track)));
  if (tracks.length) {
    for (const { source } of updates.tracks)
      expect(new URL(`https://${source}`).hostname).toBe(source);
    expect(updates.selectedTrack).toBe(
      tracks.find((track) => track === updates.runningTrack) ?? tracks[0],
    );
    expect(updates.state).toEqual({ kind: "not-checked" });
    return;
  }
  expect(updates).toMatchObject({
    state: { kind: "failed", stage: "check", reason: "not-configured" },
    selectedTrack: null,
  });
  const reply = await page.evaluate(
    (revision) =>
      (
        window as unknown as { clawtrateHost: { desktopUpdates: DesktopUpdates } }
      ).clawtrateHost.desktopUpdates.check("stable", revision),
    updates.revision,
  );
  expect(reply).toEqual({ outcome: "invalid", snapshot: updates });
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
  // Windows gives as the taskbar button's help text. The button is the one
  // with the app's own id, the bundle id its installer gives its shortcuts,
  // from the first launch on: not the executable's path.
  const setBadge = (count: number) =>
    page.evaluate((value) => {
      (
        window as unknown as { clawtrateHost: { setBadge(n: number): void } }
      ).clawtrateHost.setBadge(value);
    }, count);
  const reads: OverlayRead[] = [];
  let step = { phase: "set", expected: "3 unread" };
  try {
    await setBadge(3);
    await expect
      .poll(() => taskbarOverlayDescription(APP_ID, reads), { timeout: 15_000 })
      .toBe(step.expected);
    step = { phase: "clear", expected: "" };
    await setBadge(0);
    await expect
      .poll(() => taskbarOverlayDescription(APP_ID, reads), { timeout: 15_000 })
      .toBe(step.expected);
  } catch (error) {
    await test.info().attach("taskbar-overlay", {
      body: JSON.stringify({ ...step, lastReads: reads.slice(-5) }, null, 2),
      contentType: "application/json",
    });
    throw error;
  }
});

test("hands a second launch to the running app instead of starting another", async () => {
  // The same data folder, so the same single-instance lock. The second process
  // must exit by itself, successfully, and leave the first one and its one window.
  // Never a packaged app without a sandbox, even one that only hands over to the running app.
  // The run's temporary home, temporary folder and working folder, as the first launch had.
  const place = launchPlace(process.env.CLAWTRATE_PACKAGED_PLACE!);
  const second = spawn(
    packagedExecutable(APP),
    [`--user-data-dir=${USER_DATA}`, `--clawtrate-setup-sandbox=${SANDBOX}`],
    {
      cwd: place.cwd,
      env: place.env,
      stdio: "ignore",
    },
  );
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

test("keeps the fuses it was packaged with", async () => {
  // Read from the binary as it was built or installed: Node's own entry points
  // off, and only its archive loaded, checked against its hash.
  expect(await fuseMismatches(packagedExecutable(APP), process.platform)).toEqual([]);
});

function runEndpoint() {
  expect(INSTANCE).toMatch(/^e2e-[0-9a-f]{8}$/);
  const endpoint = provenEndpoint({
    instance: INSTANCE,
    home: homedir(),
    runDir: runDirFor(INSTANCE, join(ROOT, "tools/dev-gateway/.run")),
    checkout: realpathSync(ROOT),
    ...(WINDOWS ? { identify: windowsIdentity } : {}),
  });
  if ("refusal" in endpoint) throw new Error(endpoint.refusal);
  expect(endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:(19[2-9]\d\d)$/);
  return endpoint;
}

/** Pairs the app global setup started with the run's instance, from its connect screen. */
async function pair(): Promise<void> {
  const endpoint = runEndpoint();
  // The address-and-token form is under Advanced, which the first test opens; run alone, nothing has.
  const address = page.getByPlaceholder("Gateway address");
  if (!(await address.isVisible())) await page.getByRole("button", { name: "Advanced" }).click();

  await address.fill(endpoint.url);
  await page.getByPlaceholder("Gateway token, for pairing").fill(endpoint.token);
  await page.getByRole("button", { name: "Connect" }).click();

  // A fresh device identity must be approved on the gateway, over the real protocol.
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  if (WINDOWS) await approve(windowsInstance(INSTANCE));
  else devGateway(INSTANCE, "approve");

  const bots = page.getByTestId("bot");
  await expect(bots).toHaveCount(4, { timeout: 20_000 });
  // The rail orders bots by recent activity (F-031), so the names are compared as a set.
  expect((await bots.locator(".bot-name").allTextContents()).sort()).toEqual([
    "Juniper",
    "Marlow",
    "Otto",
    "Pip",
  ]);
}

test("pairs with its own development gateway instance and shows the seeded bots", async () => {
  test.skip(WINDOWS && !hostedWindows, "Windows pairing needs a disposable hosted runner");
  await pair();
  await page.getByRole("button", { name: /^Otto, \d+ tasks?/ }).click();
  await page
    .getByRole("list", { name: "Otto's tasks" })
    .getByTestId("task")
    .filter({ hasText: "Disk almost full on the media box" })
    .click();
  await expect(page.getByTestId("transcript-turn")).toHaveCount(4);
});

test("sends a key typed into it to the gateway, and keeps it in none of its logs or data", async () => {
  test.skip(WINDOWS, "needs the Windows app log and settings shortcut");
  // Admin access first: only admin connections start a sign-in.
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await settings.getByRole("button", { name: "Request admin access" }).click();
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  const connect = settings.getByRole("button", { name: "Connect an account" }).first();
  await expect(connect).toBeVisible({ timeout: 30_000 });
  await connect.click();
  await settings.locator("details.b-disclosure summary").click();
  await settings.getByRole("combobox", { name: "Provider" }).selectOption("acme");
  const field = settings.getByTestId("api-key");
  await field.fill(TYPED_KEY);
  await settings.getByRole("button", { name: "Save key" }).click();
  await expect(settings.getByRole("heading", { name: "Key saved" })).toBeVisible({
    timeout: 30_000,
  });
  await settings.getByRole("textbox", { name: "Label" }).fill("Packaged");
  await settings.getByRole("button", { name: "Done" }).click();
  // On the gateway: the account its key made, as the app reads it back.
  await expect(settings.getByRole("button", { name: /^Acme · Packaged, API key/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
  // Nowhere the app writes: its output (its log), every file in its data folder,
  // and its logs folder, which `CFFIXED_USER_HOME` puts in the run's home.
  expect(APP_LOG, "the app's log").not.toBe("");
  expect(readFileSync(APP_LOG, "utf8").length, "the app's log has its output").toBeGreaterThan(0);
  expect(holds(APP_LOG, TYPED_KEY)).toEqual([]);
  expect(holds(USER_DATA, TYPED_KEY)).toEqual([]);
  expect(
    holds(join(process.env.CLAWTRATE_PACKAGED_PLACE!, "home/Library/Logs/Clawtrate"), TYPED_KEY),
  ).toEqual([]);
  expect(await page.content()).not.toContain(TYPED_KEY);
});

test("F-561: carries the build's date and commit, and shows them under Settings → Updates", async () => {
  const updates = await page.evaluate(() =>
    (
      window as unknown as { clawtrateHost: { desktopUpdates: DesktopUpdates } }
    ).clawtrateHost.desktopUpdates.get(),
  );
  // The commit this checkout's build was made from, and the build's own date.
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  expect(updates.build).toEqual({
    releaseDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    commit,
  });
  // Settings opens once the app is paired, which needs the development gateway.
  if (WINDOWS) return;
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Updates", exact: true }).click();
  const details = settings.getByTestId("build-details");
  await details.locator("summary").click();
  await expect(details).toContainText(commit);
  await expect(details).toContainText(
    `${updates.build!.releaseDate!.slice(0, 16).replace("T", " ")} UTC`,
  );
  await page.keyboard.press("Escape");
});

/** The label macOS shows on the app's dock icon, as Launch Services reports it; null for none. */
function dockBadge(pid: number): string | null {
  const out = execFileSync("lsappinfo", ["info", "-only", "StatusLabel", String(pid)], {
    encoding: "utf8",
  });
  return /"label"="([^"]*)"/.exec(out)?.[1] ?? null;
}

/** A gateway method with this run's instance's own operator credentials. */
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

test("F-023: the dock badge counts the unread tasks, and follows what the gateway says of them", async () => {
  test.skip(WINDOWS, "reads the macOS Dock badge");
  // macOS shows an app's badge only while it may post notifications (Electron's
  // setBadgeCount), a permission kept by bundle id that a check build never has.
  test.skip(true, "a check build's bundle id has never been allowed notifications");
  const unread = async () =>
    (
      await gatewayCall<{ sessions: Array<{ key: string; unread?: boolean }> }>("sessions.list", {
        limit: 200,
        excludeCron: true,
        excludeSubagents: true,
      })
    ).sessions.filter((row) => row.unread === true);
  // A count is shown, no more than the gateway's unread tasks: those this device has read
  // (the one on screen, and those it opened on the way) are not counted again.
  const listed = await unread();
  await expect.poll(() => Number(dockBadge(APP_PID) ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
  const shown = Number(dockBadge(APP_PID));
  expect(shown).toBeLessThanOrEqual(listed.length);
  // A task of Pip's, which this device never opened: read by another client, the badge takes
  // one away; unread again, it comes back.
  const pip = listed.find((row) => row.key.startsWith("agent:pip:"));
  expect(pip, "an unread task of Pip's").toBeTruthy();
  await gatewayCall("sessions.patch", { key: pip!.key, unread: false });
  await expect.poll(() => dockBadge(APP_PID), { timeout: 20_000 }).toBe(String(shown - 1));
  await gatewayCall("sessions.patch", { key: pip!.key, unread: true });
  await expect.poll(() => dockBadge(APP_PID), { timeout: 20_000 }).toBe(String(shown));
});

test("keeps the device key and tokens in its own data folder, readable by the user only", () => {
  test.skip(WINDOWS, "Windows device keys need an ACL check");
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
  expect(result).toEqual({
    windowRefused: true,
    stayed: true,
    bots: WINDOWS && !hostedWindows ? 0 : 4,
  });
  expect(browser.contexts().flatMap((context) => context.pages())).toHaveLength(1);
});

test("F-393: checking spelling asks for no dictionary", async () => {
  // Windows checks spelling with its own checker. For a language it has no
  // checker for, Chromium falls back to a Hunspell dictionary and downloads it
  // the first time, in a request the browser process makes outside the
  // session's request filter. Faroese has a Hunspell dictionary, and a
  // Windows without Faroese installed has no checker for it, so a second copy
  // of the app with Faroese as its spelling language would take that path as
  // it starts. Its network log, complete once it has quit, shows every
  // request, and none may be for a dictionary, from a host or from a file.
  // macOS builds no Hunspell fallback, so nothing asks for one there either.
  test.setTimeout(120_000);
  // A new folder each time: one that already holds a dictionary never asks for it.
  const spelling = realpathSync.native(
    mkdtempSync(join(process.env.CLAWTRATE_PACKAGED_PLACE!, "spelling-")),
  );
  const netLog = join(spelling, "net-log.json");
  // macOS keeps a sandboxed app's data in its sandbox's folder, so the copy gets
  // a sandbox of its own, as the Keychain check's launches do. Windows reads no
  // sandbox and keeps its data in the folder the launch names, so the copy names
  // a new one and passes the run's sandbox, as the second launch does.
  let data = join(spelling, "data");
  let sandbox = SANDBOX;
  if (WINDOWS) mkdirSync(data);
  else {
    const own = writeSandbox({ instance: INSTANCE, parent: spelling });
    data = realpathSync.native(own.appData);
    sandbox = own.file;
  }
  writeFileSync(
    join(data, "Preferences"),
    JSON.stringify({ spellcheck: { dictionaries: ["fo"] } }),
  );
  // A home, temporary folder and working folder of its own, as every packaged launch has.
  const place = launchPlace(spelling);
  // Straight to the pictures' port: a proxy the system names could be asked for them.
  const copyFlags = [`--log-net-log=${netLog}`, "--no-proxy-server"];
  let copy: ChildProcess;
  if (WINDOWS) {
    // Windows keeps no run record. Node puts the copy in a job object that
    // Windows closes when this worker exits, so the copy ends with it.
    copy = spawn(packagedExecutable(APP), [...launchArgs(data, sandbox, CHECKOUT), ...copyFlags], {
      cwd: place.cwd,
      env: place.env,
      stdio: "ignore",
    });
  } else {
    // Gated until the run record names it, so the run's cleanup stops it even if this test cannot.
    const gated = gatedSpawn(
      spawn,
      packagedExecutable(APP),
      [...launchArgs(data, sandbox, CHECKOUT), ...copyFlags],
      { cwd: place.cwd, env: place.env, stdio: "ignore" },
    );
    copy = gated.child;
    // Until the record names it, a failure aborts the gate, so the copy never starts.
    try {
      const found = processIdentity(copy.pid!);
      if (found.state !== "alive") throw new Error("could not record the copy's process");
      recordSuccessor(RECORD, { pid: copy.pid!, identity: found.identity });
    } catch (error) {
      gated.abort();
      throw error;
    }
    gated.release();
  }
  // A copy that cannot start emits `error` and may never emit `exit`: either ends the wait.
  const exited = new Promise((resolve) => {
    copy.once("exit", resolve);
    copy.once("error", resolve);
  });
  // Pictures for the copy's page to ask for, from a port on this machine that refuses them.
  const pictures = createServer((socket) => socket.destroy());
  const soFar = () => {
    try {
      return requestsSoFar(readFileSync(netLog, "utf8"));
    } catch (error) {
      // Chromium may not have created the file yet, or may hold it on Windows.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EBUSY") throw error;
      return [];
    }
  };
  let view: Browser | undefined;
  let left: number[];
  try {
    await once(pictures.listen(0, "127.0.0.1"), "listening");
    const picturesAt = `https://127.0.0.1:${(pictures.address() as AddressInfo).port}/`;
    view = await chromium.connectOverCDP(`http://127.0.0.1:${await debuggingPort(data, copy)}`);
    await expect
      .poll(() => view!.contexts().flatMap((context) => context.pages()).length)
      .toBeGreaterThan(0);
    const shown = view.contexts().flatMap((context) => context.pages())[0]!;
    await expect(shown.getByRole("heading", { name: "Where does OpenClaw run?" })).toBeVisible();
    // Chromium writes events only once 15 are waiting, and an idle app logs
    // none, so a request can sit unwritten until the app quits. Each picture
    // the page asks for adds events, and events are written in the order they
    // happen, so asking for one more picture until one shows brings every
    // earlier event to disk, a dictionary request at startup included, and
    // shows the log is being written.
    let picture = 0;
    await expect
      .poll(
        async () => {
          await shown.evaluate((url) => {
            new Image().src = url;
          }, `${picturesAt}${picture++}.png`);
          return soFar().some((url) => url.startsWith(picturesAt));
        },
        { timeout: 30_000, message: "the log on disk shows a picture's request" },
      )
      .toBe(true);
    // Windows refuses the close message until the window is shown.
    if (WINDOWS)
      await expect.poll(() => mainWindowTitle(copy.pid!), { timeout: 20_000 }).toBe("Clawtrate");
    const quit = await quitWithin(
      () => {
        if (WINDOWS) expect(askToClose(copy.pid!), "asking the copy to close").toBeNull();
        else copy.kill("SIGTERM");
      },
      () => exited,
      async () => view?.close(),
      15_000,
    );
    expect(quit, "the copy quits within 15 seconds").toBe(true);
    expect(copy.exitCode, "the copy's exit code").toBe(0);
  } finally {
    pictures.close();
    // Whatever is left is ended by PID: nothing outlives the test.
    if (copy.exitCode === null && copy.signalCode === null) {
      // Only the copy: on Windows this ends its process alone, not its tree.
      copy.kill("SIGKILL");
      // Bounded: a copy that could not be ended never exits. The list below names it.
      await Promise.race([exited, sleep(10_000)]);
    }
    // Its helpers end by themselves once it has. Any left fail the test, listed
    // but not ended: only the copy was started here.
    for (let i = 0; i < 50 && processesUsing(data).length > 0; i += 1) await sleep(200);
    left = processesUsing(data);
  }
  expect(left, "the copy's processes end within 10 seconds of it").toEqual([]);
  expect(
    dictionaryRequests(readFileSync(netLog, "utf8")),
    "the dictionaries the network log shows requests for",
  ).toEqual([]);
});

test("opens with the same pairing and tasks after a newer build takes its place", async () => {
  // An update in place quits the app and starts a newer build of the same
  // bundle id, name and data folder. Here the newer build is a copy of this
  // one with only its version raised and an ad hoc signature, so this shows
  // the paths a signed update keeps, not Squirrel's handoff itself.
  test.skip(WINDOWS, "needs a Windows installer upgrade");
  test.setTimeout(300_000);
  const gateway = join(USER_DATA, "gateway");
  const state = () =>
    JSON.parse(readFileSync(join(gateway, "state.json"), "utf8")) as Record<string, string>;
  const paired = () =>
    existsSync(join(gateway, "state.json")) &&
    Object.keys(state()).some((name) => name.startsWith("deviceToken:"));
  // Run alone (`--grep`), no earlier test has paired the app.
  if (!paired()) await pair();
  const key = readFileSync(join(gateway, "device-key.pem"));
  const before = state();
  expect(before.connection).toBeTruthy();
  expect(Object.keys(before).some((name) => name.startsWith("deviceToken:"))).toBe(true);

  const running = packagedManifest(APP);
  const [major, minor, patch] = parseVersion(running.version as string)!;
  const newer = `${major}.${minor}.${patch + 1}`;
  const run = process.env.CLAWTRATE_PACKAGED_PLACE!;
  const place = launchPlace(run);
  const updated = join(run, "updated", "Clawtrate.app");
  mkdirSync(dirname(updated));
  await newerCopy(APP, updated, newer, join(run, "newer-scratch"));
  // Only the version differs, so the name the data folder is derived from does not.
  expect({ ...packagedManifest(updated), version: running.version }).toEqual(running);
  expect(bundleIdentifier(updated)).toBe(process.env.CLAWTRATE_PACKAGED_BUNDLE_ID);

  // Quit the running app as an update does, and wait for it and its helpers,
  // with the teardown's own bounds: 15 seconds for the app, 10 for its helpers.
  // Asked while the debugging client is attached, as the teardown asks; the
  // 15 seconds start at SIGTERM, and closing that client runs alongside.
  // Gone once the runner that started the app has reaped it and written how it ended.
  const firstGone = async () => {
    for (const end = Date.now() + 20_000; Date.now() < end; await sleep(100)) {
      if (existsSync(APP_EXIT)) return;
    }
    await new Promise(() => undefined);
  };
  const firstQuit = await quitWithin(
    () => process.kill(APP_PID, "SIGTERM"),
    firstGone,
    () => browser.close(),
    15_000,
  );
  expect(firstQuit, "the app quits within 15 seconds, as an update asks it").toBe(true);
  // A crash on the way out (SIGSEGV, another code) is not the quit an update asks for.
  expect(
    JSON.parse(readFileSync(APP_EXIT, "utf8")),
    "the app quits cleanly, as an update asks it",
  ).toEqual({ code: 0, signal: null });
  // From the app's exit: its helpers' own 10 seconds.
  await expect
    .poll(() => processesUsing(USER_DATA), {
      timeout: 10_000,
      message: "the app's helpers end within 10 seconds of it",
    })
    .toEqual([]);

  rmSync(join(USER_DATA, "DevToolsActivePort"), { force: true });
  const logFd = openSync(join(run, "updated.log"), "a", 0o600);
  // Gated until the run record names it, so the run's cleanup stops it even if this test cannot.
  const gated = gatedSpawn(
    spawn,
    packagedExecutable(updated),
    launchArgs(USER_DATA, SANDBOX, CHECKOUT),
    { cwd: place.cwd, env: place.env, stdio: ["ignore", logFd, logFd] },
  );
  const next = gated.child;
  // A shell that cannot start emits `error` and may never emit `exit`: either ends the wait.
  let spawnError: Error | undefined;
  const exited = new Promise((resolve) => {
    next.once("exit", resolve);
    next.once("error", (error) => {
      spawnError = error;
      resolve(undefined);
    });
  });
  // Until the record names it, a failure aborts the gate, so the app never starts.
  try {
    const found = processIdentity(next.pid!);
    if (found.state !== "alive")
      throw new Error(
        `could not record the newer build's process${spawnError ? ` (${spawnError.message})` : ""}`,
      );
    recordSuccessor(RECORD, { pid: next.pid!, identity: found.identity });
  } catch (error) {
    gated.abort();
    closeSync(logFd);
    throw error;
  }
  gated.release();
  let second: Browser | undefined;
  try {
    const port = await debuggingPort(USER_DATA, next);
    second = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await expect
      .poll(() => second!.contexts().flatMap((context) => context.pages()).length)
      .toBeGreaterThan(0);
    const view = second.contexts().flatMap((context) => context.pages())[0]!;

    // The sandbox requires an explicit connection. Check the saved settings before Connect
    // can write them, then use the saved pairing with only this run's proven address.
    await expect(view.getByRole("heading", { name: "Where does OpenClaw run?" })).toBeVisible();
    expect(state().connection).toBe(before.connection);
    await view.getByRole("button", { name: "Advanced" }).click();
    await view.getByPlaceholder("Gateway address").fill(runEndpoint().url);
    await expect(view.getByPlaceholder("Gateway token, for pairing")).toHaveValue("");
    await view.getByRole("button", { name: "Connect" }).click();
    const bots = view.getByTestId("bot");
    await expect(bots).toHaveCount(4, { timeout: 30_000 });
    await expect(view.getByPlaceholder("Gateway address")).toHaveCount(0);
    await expect(view.getByRole("heading", { name: "Approve this device" })).toHaveCount(0);
    // The rail may remember Otto open from before the update; open it only if not.
    const otto = view.getByRole("button", { name: /^Otto, \d+ tasks?/ });
    if ((await otto.getAttribute("aria-expanded")) !== "true") await otto.click();
    await expect(
      view
        .getByRole("list", { name: "Otto's tasks" })
        .getByTestId("task")
        .filter({ hasText: "Disk almost full on the media box" }),
    ).toHaveCount(1);
    const updates = await view.evaluate(() =>
      (
        window as unknown as { clawtrateHost: { desktopUpdates: DesktopUpdates } }
      ).clawtrateHost.desktopUpdates.get(),
    );
    expect(updates.runningVersion).toBe(newer);

    // The same device key and saved connection, and a device token still saved for each
    // gateway: the gateway may reissue the token on connect, so its value is not compared.
    expect(readFileSync(join(gateway, "device-key.pem")).equals(key)).toBe(true);
    const after = state();
    expect(after.connection).toBe(before.connection);
    for (const name of Object.keys(before).filter((each) => each.startsWith("deviceToken:")))
      expect(after[name], name).toBeTruthy();
  } finally {
    // Asked to quit while the debugging client is still attached, as the first
    // app was: a SIGTERM right after that client leaves was seen to go unanswered.
    // The 15 seconds start at SIGTERM; closing the client runs alongside.
    const quit =
      next.exitCode !== null || next.signalCode !== null
        ? (await second?.close(), true)
        : await quitWithin(
            () => next.kill("SIGTERM"),
            () => exited,
            async () => second?.close(),
            15_000,
          );
    const outcome = quit ? "exited" : "running";
    if (outcome === "running") {
      // Ended by its PID, and its helpers by theirs: nothing outlives the test.
      next.kill("SIGKILL");
      await exited;
    }
    // The quit asked for ends with code 0, as the run's teardown requires of the
    // first app; a crash on the way out (SIGSEGV, another code) does not.
    const status = { code: next.exitCode, signal: next.signalCode };
    let left: number[];
    const unsignalled: string[] = [];
    try {
      for (let i = 0; i < 50 && processesUsing(USER_DATA).length > 0; i += 1) await sleep(200);
      left = processesUsing(USER_DATA);
      for (const pid of left) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          // Gone since the listing: nothing to end.
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ESRCH") unsignalled.push(`${pid}: ${code ?? String(error)}`);
        }
      }
    } finally {
      closeSync(logFd);
    }
    expect(outcome, "the newer build quits within 15 seconds").not.toBe("running");
    expect(
      status.code === 0,
      `the newer build quits cleanly, not with ${JSON.stringify(status)}`,
    ).toBe(true);
    // First, so a helper that could not be ended names why it is still listed.
    expect(unsignalled, "every helper left could be ended").toEqual([]);
    expect(left, "the newer build's helpers end within 10 seconds of it").toEqual([]);
  }
});

/** The Keychain check runs where the release check asks for it, in a desktop session with the login keychain. */
const KEYCHAIN_CHECK = process.env.CLAWTRATE_CHECK_KEYCHAIN === "1";
/** The disposable default login keychain of the test account the Keychain check runs as. */
const KEYCHAIN_PATH = process.env.CLAWTRATE_CHECK_KEYCHAIN_PATH ?? "";

/**
 * Whether the item is in that keychain, from its metadata only: `security` exits 44 when
 * there is no such item, and anything else but 0 is a failure, never taken as absent.
 */
function keychainHolds(service: string, account: string): boolean {
  const found = spawnSync("security", [
    "find-generic-password",
    "-s",
    service,
    "-a",
    account,
    KEYCHAIN_PATH,
  ]);
  if (found.status === 0) return true;
  if (found.status === 44) return false;
  throw new Error(`security find-generic-password failed with ${found.status ?? found.signal}`);
}

/**
 * Launches the packaged app on a data folder under its own Keychain name, reads the
 * device id the host loaded, and quits it, with its helpers, within the teardown's bounds.
 */
async function deviceIdUnderKeychainCheck(
  userData: string,
  sandbox: string,
  hex: string,
  dir: string,
  act: (view: Page) => Promise<void> = async () => {},
): Promise<string | null> {
  const place = launchPlace(dir);
  // The account's own home for the Security framework, so the app finds the default keychain,
  // which the test requires to be the disposable one. Under the run's home it finds none and
  // macOS stops the app with a "Keychain Not Found" dialog (seen on CI).
  delete place.env.CFFIXED_USER_HOME;
  place.env.HOME = homedir();
  // An earlier launch's port file would name a port no app listens on now.
  rmSync(join(userData, "DevToolsActivePort"), { force: true });
  const logFd = openSync(join(dir, "app.log"), "a", 0o600);
  const gated = gatedSpawn(
    spawn,
    packagedExecutable(APP),
    [...launchArgs(userData, sandbox, CHECKOUT), `--clawtrate-keychain-check=${hex}`],
    { cwd: place.cwd, env: place.env, stdio: ["ignore", logFd, logFd] },
  );
  const child = gated.child;
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  try {
    const found = processIdentity(child.pid!);
    if (found.state !== "alive") throw new Error("could not record the app's process");
    recordSuccessor(RECORD, { pid: child.pid!, identity: found.identity });
  } catch (error) {
    gated.abort();
    closeSync(logFd);
    throw error;
  }
  gated.release();
  let cdp: Browser | undefined;
  let shown = "";
  let failure: unknown = null;
  try {
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${await debuggingPort(userData, child)}`);
    await expect.poll(() => cdp!.contexts().flatMap((context) => context.pages()).length).toBe(1);
    const view = cdp.contexts().flatMap((context) => context.pages())[0]!;
    const read = () =>
      view.evaluate(async () => {
        const host = (window as unknown as { clawtrateHost: { hello(): Promise<unknown> } })
          .clawtrateHost;
        const { state } = (await host.hello()) as { state: { connection: { deviceId: string } } };
        return state.connection.deviceId ?? null;
      });
    try {
      await expect.poll(read, { timeout: 30_000 }).not.toBe(null);
      const deviceId = await read();
      await act(view);
      return deviceId;
    } catch (error) {
      failure = error;
      shown = await view
        .locator("body")
        .innerText({ timeout: 2_000 })
        .catch(() => "");
      throw error;
    }
  } catch (error) {
    failure ??= error;
    throw error;
  } finally {
    // On a discarded CI runner only: the screen and the app's stacks, to show what holds a
    // launch that never opened its window.
    if (failure && process.env.CI) {
      const out = test.info().outputPath();
      mkdirSync(out, { recursive: true });
      spawnSync("screencapture", ["-x", join(out, `${basename(dir)}-screen.png`)]);
      spawnSync("sample", [
        String(child.pid),
        "3",
        "-file",
        join(out, `${basename(dir)}-sample.txt`),
      ]);
    }
    const quit = await quitWithin(
      () => child.kill("SIGTERM"),
      () => exited,
      async () => cdp?.close(),
      15_000,
    );
    if (!quit) {
      child.kill("SIGKILL");
      await exited;
    }
    for (let i = 0; i < 50 && processesUsing(userData).length > 0; i += 1) await sleep(200);
    closeSync(logFd);
    // What the run saw, for a failure: the app's own lines and the page's words, which hold no
    // credential (the test checks the log for them), and the first error.
    if (failure || !quit)
      console.log(
        [
          `--- ${dir}: ${failure ? String(failure).slice(0, 600) : "no error before the quit"}`,
          `--- page: ${shown.slice(0, 600)}`,
          `--- app log:`,
          readFileSync(join(dir, "app.log"), "utf8").slice(-4_000),
        ].join("\n"),
      );
    expect(quit, "the app quits within 15 seconds").toBe(true);
    expect(processesUsing(userData), "the app's helpers end with it").toEqual([]);
  }
}

test("keeps this device's credentials in the Keychain: a fresh build moves them out of its files once, and a relaunch reads them back and reconnects", async () => {
  test.skip(WINDOWS, "Windows keeps credentials in its files until DPAPI is turned on");
  test.skip(
    !KEYCHAIN_CHECK || !KEYCHAIN_PATH,
    "run by hand with CLAWTRATE_CHECK_KEYCHAIN=1 and CLAWTRATE_CHECK_KEYCHAIN_PATH, as a test account whose default login keychain is that disposable one",
  );
  test.setTimeout(300_000);
  // Only ever a disposable keychain: the account's default must be the one named.
  const defaultKeychain = spawnSync("security", ["default-keychain"], { encoding: "utf8" });
  expect(defaultKeychain.status).toBe(0);
  expect(defaultKeychain.stdout.trim().replace(/^"|"$/g, "")).toBe(KEYCHAIN_PATH);
  // The app's name for this run alone: safeStorage keeps its key in the item with service
  // "<name> Safe Storage" and account "<name> Key" (Electron 45's async provider, seen on CI).
  const hex = randomBytes(8).toString("hex");
  const name = `Clawtrate Check ${hex}`;
  const service = `${name} Safe Storage`;
  const account = `${name} Key`;
  expect(keychainHolds(service, account), "no item of this run's exists before it").toBe(false);
  const run = process.env.CLAWTRATE_PACKAGED_PLACE!;
  const parent = join(run, "keychain");
  mkdirSync(parent);
  const sandbox = writeSandbox({ instance: INSTANCE, parent });
  const userData = realpathSync.native(sandbox.appData);
  const folder = join(userData, "gateway");
  mkdirSync(folder, { mode: 0o700 });
  // An earlier build's files with a pairing that works: the app this run paired, in clear text.
  for (const file of ["device-key.pem", "state.json"])
    writeFileSync(join(folder, file), readFileSync(join(USER_DATA, "gateway", file)), {
      mode: 0o600,
    });
  const before = JSON.parse(readFileSync(join(folder, "state.json"), "utf8")) as Record<
    string,
    string
  >;
  const tokens = Object.entries(before)
    .filter(([key]) => key.startsWith("deviceToken:"))
    .map(([, value]) => (JSON.parse(value) as { token: string }).token);
  expect(tokens.length).toBeGreaterThan(0);
  const pem = readFileSync(join(folder, "device-key.pem"), "utf8");
  const raw = createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32);
  const deviceId = createHash("sha256").update(raw).digest("hex");
  const state = () =>
    JSON.parse(readFileSync(join(folder, "state.json"), "utf8")) as Record<string, string>;
  const secrets = [...tokens, "PRIVATE KEY"];

  try {
    // With the Keychain, the Mac app's host pairs with full control (docs/decisions.md, "On in
    // the packaged Mac app, for a protected address"); its interface is told so.
    const fullControl = async (view: Page) => {
      const info = await view.evaluate(async () => {
        const host = (window as unknown as { clawtrateHost: { hello(): Promise<unknown> } })
          .clawtrateHost;
        return ((await host.hello()) as { info: { fullControl?: boolean } }).info;
      });
      expect(info.fullControl).toBe(true);
    };
    expect(
      await deviceIdUnderKeychainCheck(userData, sandbox.file, hex, join(run, "kc-1"), fullControl),
    ).toBe(deviceId);
    // Moved: the sealed record, and the files without a credential or the key.
    expect(readdirSync(folder).sort()).toEqual(["credentials.bin", "state.json"]);
    expect(Object.keys(state()).some((key) => key.startsWith("deviceToken:"))).toBe(false);
    for (const secret of secrets) expect(holds(folder, secret)).toEqual([]);
    expect(keychainHolds(service, account), `safeStorage keeps its key in "${service}"`).toBe(true);

    // Relaunched: the same identity read back, and the saved pairing reconnects with no approval.
    const reconnect = async (view: Page) => {
      await view.getByRole("button", { name: "Advanced" }).click();
      await view.getByPlaceholder("Gateway address").fill(runEndpoint().url);
      await view.getByRole("button", { name: "Connect" }).click();
      await expect(view.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
      await expect(view.getByRole("heading", { name: "Approve this device" })).toHaveCount(0);
    };
    expect(
      await deviceIdUnderKeychainCheck(userData, sandbox.file, hex, join(run, "kc-2"), reconnect),
    ).toBe(deviceId);
    for (const secret of secrets) {
      expect(holds(folder, secret)).toEqual([]);
      for (const log of ["kc-1", "kc-2"])
        expect(holds(join(run, log, "app.log"), secret)).toEqual([]);
    }
  } finally {
    // This run's own item, by its exact name, account and keychain, and checked gone.
    const removed = spawnSync("security", [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      account,
      KEYCHAIN_PATH,
    ]);
    expect(
      removed.status === 0 || removed.status === 44,
      `security delete-generic-password ended with ${removed.status ?? removed.signal}`,
    ).toBe(true);
    expect(keychainHolds(service, account), "this run's item is gone after it").toBe(false);
  }
});
