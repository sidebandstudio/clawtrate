import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { FULL_SCOPES } from "../../packages/core/src/scopes.ts";
import { appEnv } from "../desktop-driver.ts";
import {
  FIRST_MESSAGE,
  SCRIPTED_REPLY,
  scriptedProvider,
  successfulScriptedRequests,
} from "./provider.ts";
import { observeMac } from "./system-observation.ts";
import { forbiddenScreen, STEPS, verdict, type Element, type StepResult } from "./verdict.ts";

const [app, out] = process.argv.slice(2);
const event = process.env.GITHUB_EVENT_NAME;
if (
  process.platform !== "darwin" ||
  process.arch !== "arm64" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  !["pull_request", "workflow_dispatch"].includes(event ?? "") ||
  !process.env.RUNNER_TEMP ||
  !app ||
  !out
) {
  throw new Error("This check requires a GitHub-hosted Apple silicon Mac.");
}

const home = userInfo().homedir;
const profile = join(home, ".openclaw-clawtrate");
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const run = promisify(execFile);
const show = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stepResults: StepResult[] = STEPS.map((step) => ({
  step,
  status: "not-reached",
  seconds: 0,
  text: null,
  screenshot: null,
  screenScreenshot: null,
}));
type PressPurpose = "person" | "inspection" | "fixture";
type TraceEntry =
  | { kind: "press"; text: string; purpose: PressPurpose; performed: boolean }
  | { kind: "screen" | "type" | "fixture" | "inspection"; text: string };
type Event = TraceEntry & { seconds: number; step: string };
type AccountSheetResult = {
  outcome: "advanced-without-press" | "closed-without-press" | "still-open" | "gateway-unavailable";
  observedReconnect: boolean;
  secondsSinceAccountSaved: number;
  secondsAvailable: number;
};
const trace: Event[] = [];
const pressCounts: Record<PressPurpose, number> = { person: 0, inspection: 0, fixture: 0 };
const start = performance.now();
let active = stepResults[0]!;
let latest: Element[] = [];
let screenKey = "";
let child: ChildProcess | undefined;
let appData: string | undefined;
let launchError: Error | undefined;
let developerTools:
  { activeDirectory: string | null; git: string; otherGitPaths: string[] } | undefined;
let systemPromptVisible = false;
let connectedAt: number | undefined;
let provider: Server | undefined;
let accountSavedAt: number | undefined;
let accountSheet: AccountSheetResult | null = null;
let accountProbe: { checkingScreenObserved: boolean; scriptedResponses: number } | null = null;
let notFoundAdvancedCount: number | null = null;
const timing = process.env.FIRST_RUN_ACCOUNT_TIMING;
if (timing !== "before" && timing !== "at-return" && timing !== "late") {
  throw new Error("Select a hosted account timing case.");
}
const accountTiming = {
  case: timing,
  configAt: null as number | null,
  saveInputAt: null as number | null,
  savedAt: null as number | null,
  reconnectNoticeAt: null as number | null,
  connectedAt: null as number | null,
  sheetAdvancedAt: null as number | null,
};

mkdirSync(out, { recursive: true });
const system = observeMac(out);

const seconds = (duration: number) => Math.round(duration / 100) / 10;

function record(entry: TraceEntry, at = performance.now()) {
  trace.push({
    ...entry,
    seconds: seconds(at - start),
    step: active.step,
  });
  if (entry.kind === "press" && entry.performed) pressCounts[entry.purpose] += 1;
}

async function ax(mode: string, target = ""): Promise<string> {
  if (launchError) throw launchError;
  if (mode !== "read" && (child?.exitCode != null || child?.signalCode != null))
    throw new Error("Clawtrate quit before the check finished.");
  if (!child?.pid) return "";
  try {
    const { stdout } = await run(
      "/usr/bin/osascript",
      [join(import.meta.dirname, "window.applescript"), String(child.pid), mode, target],
      { timeout: 12_000 },
    );
    return stdout.trimEnd();
  } catch (error) {
    // AppleScript's diagnostic is useful when the runner denies Accessibility.
    const message = show(error).split("\n").at(-2)?.trim() || "System Events did not answer.";
    throw new Error(`Could not ${mode} the Clawtrate window. ${message}`, { cause: error });
  }
}

const buttons = () =>
  latest.filter(({ role }) => ["AXButton", "AXLink", "AXMenuItem"].includes(role));
const hasButton = (name: string) => buttons().some(({ text }) => text === name);
const hasText = (pattern: RegExp) => latest.some(({ text }) => pattern.test(text));
const nativeDialog = () => latest.some(({ role }) => role === "AXSheet" || role === "AXDialog");
const heading = () =>
  latest.findLast(({ role, text }) => role === "AXHeading" && text && !/^\d+$/.test(text))?.text ??
  null;

function refuseForbidden(elements: Element[]) {
  const forbidden = forbiddenScreen(elements);
  if (!forbidden) return;
  systemPromptVisible = elements.some(
    ({ role, text }) =>
      (role === "AXSystemDialog" || role === "SystemPermissionWindow") && text === forbidden,
  );
  if (systemPromptVisible) system.notePrompt(forbidden);
  throw new Error(
    `${systemPromptVisible ? "macOS" : "The app"} asks for a step outside first run: ${forbidden}`,
  );
}

async function readWindow() {
  const [snapshot, systemWindows] = await Promise.all([
    ax("read"),
    system.sample(active.step, child?.pid),
  ]);
  latest = snapshot.split("\n").flatMap((line) => {
    const tab = line.indexOf("\t");
    if (tab < 0) return [];
    return [{ role: line.slice(0, tab), text: line.slice(tab + 1).trim() }];
  });
  // Record changes to the visible screen and its actions. Timers alone do not make a new screen.
  const text = latest
    .filter(({ text }) => text)
    .map(({ text }) => text.replace(/\b\d+\s*(?:s|seconds)\b/g, "<elapsed>"))
    .filter((text, index, all) => all.indexOf(text) === index)
    .join("\n");
  if (text && text !== screenKey) {
    record({ kind: "screen", text });
    screenKey = text;
  }
  if (accountTiming.configAt !== null && (firstBotAction() || composer())) {
    accountTiming.sheetAdvancedAt ??= seconds(performance.now() - start);
  }
  refuseForbidden([...systemWindows, ...latest]);
  if (child?.exitCode != null || child?.signalCode != null)
    throw new Error("Clawtrate quit before the check finished.");
}

async function waitFor(label: string, ready: () => boolean, seconds = 30) {
  const until = performance.now() + seconds * 1000;
  do {
    await readWindow();
    if (ready()) return;
    if (hasText(/^Clawtrate couldn't tell what is on this computer$/)) {
      const reason = latest.find(({ text }) =>
        text.includes("Clawtrate can't use OpenClaw's settings"),
      );
      throw new Error(reason?.text ?? "Clawtrate couldn't tell what is on this computer.");
    }
    const privateAccount = latest.find(({ text }) =>
      text.includes("This gateway keeps the sign-in for its own bot"),
    );
    if (privateAccount) throw new Error(privateAccount.text);
    const failedAccount = latest.find(({ text }) =>
      /^(?:This account can['’]t run a model here|Clawtrate couldn['’]t check this account)\./i.test(
        text,
      ),
    );
    if (failedAccount) throw new Error(failedAccount.text);
    const retry = latest.find(({ role, text }) => role === "AXButton" && text === "Try again");
    if (retry) throw new Error(`${heading() ?? label} offers Try again.`);
    await sleep(600);
  } while (performance.now() < until);
  const roles = [...new Set(latest.map(({ role }) => role))].join(", ");
  throw new Error(
    `${label} did not appear. Last heading: ${heading() ?? "(none)"}. Window roles: ${roles || "(none)"}.`,
  );
}

async function press(
  name: string,
  purpose: PressPurpose = "person",
  mode: "press" | "enter" = "press",
) {
  const at = performance.now();
  let performed = false;
  try {
    performed = (await ax(mode, name)) === "ok";
    if (!performed) throw new Error(`Could not press "${name}".`);
  } finally {
    record({ kind: "press", text: name, purpose, performed }, at);
  }
}

async function screenshot(file: string, wholeDisplay = false, directory = out!) {
  const path = join(directory, file);
  // Capture the window's screen rectangle so the native sheet is also in the picture.
  // Before the app has a window, show the desktop.
  const bounds = wholeDisplay ? "" : await ax("bounds").catch(() => "");
  const region = /^-?\d+,-?\d+,\d+,\d+$/.test(bounds) ? ["-R", bounds] : [];
  await run("/usr/sbin/screencapture", ["-x", ...region, path], { timeout: 10_000 });
  if (!existsSync(path)) throw new Error("macOS did not save the screenshot.");
}

async function step(index: number, action: () => Promise<string>) {
  active = stepResults[index]!;
  const began = performance.now();
  const file = `0${index + 1}-${active.step}.png`;
  try {
    active.text = await action();
    active.status = "passed";
  } catch (error) {
    active.text = show(error);
    active.status = "failed";
  }
  active.seconds = Math.round((performance.now() - began) / 100) / 10;
  try {
    refuseForbidden(await system.sample(active.step, child?.pid, true));
  } catch (error) {
    if (systemPromptVisible || active.status === "passed") active.text = show(error);
    active.status = "failed";
  }
  try {
    await screenshot(file);
    active.screenshot = file;
  } catch (error) {
    active.text += ` Window screenshot failed. ${show(error)}`;
    active.status = "failed";
  }
  try {
    const screen = file.replace(/\.png$/, "-screen.png");
    await screenshot(screen, true);
    active.screenScreenshot = screen;
  } catch (error) {
    active.text += ` Full-screen screenshot failed. ${show(error)}`;
    active.status = "failed";
  }
  console.log(`${active.step} ${active.status} (${active.seconds}s) ${active.text}`);
  if (active.status === "failed") throw new Error(active.text);
}

function noDeveloperTools() {
  const env = { PATH: SYSTEM_PATH, LC_ALL: "C" };
  const git = execFileSync("/bin/sh", ["-c", "command -v git || true"], {
    encoding: "utf8",
    env,
  }).trim();
  const selection = spawnSync("/usr/bin/xcode-select", ["--print-path"], {
    encoding: "utf8",
    env,
  });
  const otherGitPaths = ["/opt/homebrew/bin/git", "/usr/local/bin/git"].filter((path) =>
    existsSync(path),
  );
  developerTools = { activeDirectory: selection.stdout?.trim() || null, git, otherGitPaths };
  if (
    selection.error ||
    selection.status === null ||
    selection.status === 0 ||
    !/unable to get active developer directory/i.test(selection.stderr) ||
    existsSync("/Library/Developer/CommandLineTools") ||
    readdirSync("/Applications").some((name) => /^Xcode.*\.app$/.test(name)) ||
    git !== "/usr/bin/git" ||
    otherGitPaths.length > 0
  ) {
    throw new Error("The runner does not have a clean developer-tools state.");
  }
}

function cleanMac() {
  const dirs = [
    join(home, "Library/LaunchAgents"),
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
  ];
  if (readdirSync(home).some((name) => name.startsWith(".openclaw"))) {
    throw new Error("The runner already has an OpenClaw profile.");
  }
  const lookup = execFileSync("/bin/sh", ["-c", "command -v openclaw || true"], {
    encoding: "utf8",
  });
  if (lookup.trim()) throw new Error("OpenClaw is already on the runner's PATH.");
  const services = execFileSync("/bin/launchctl", ["list"], { encoding: "utf8" });
  if (
    /openclaw/i.test(services) ||
    dirs.some((dir) => existsSync(dir) && readdirSync(dir).some((name) => /openclaw/i.test(name)))
  ) {
    throw new Error("The runner already has an OpenClaw service.");
  }
}

function launch() {
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP!, "first-run-data-"));
  const data = join(scratch, "Clawtrate App Data");
  mkdirSync(data, { mode: 0o700 });
  appData = data;
  const env = appEnv();
  // CI and debugger switches classify an app launch as sandboxed. Drive its
  // production window via the OS, with no debugging port and no setup stand-ins.
  delete env.CI;
  delete env.VITEST;
  delete env.DEVELOPER_DIR;
  delete env.SDKROOT;
  env.PATH = SYSTEM_PATH;
  const log = openSync(join(out!, "app-output.txt"), "wx");
  try {
    child = spawn(
      join(app!, "Contents/MacOS/Clawtrate"),
      [`--user-data-dir=${data}`, "--force-renderer-accessibility"],
      { env, stdio: ["ignore", log, log] },
    );
    child.once("error", (error) => (launchError = error));
  } finally {
    closeSync(log);
  }
}

const firstBotWelcome = () => hasText(/^Set up your first bot$/) && hasButton("Get started");
const accountPicker = () => hasText(/^Connect an account$/) && hasButton("Close");
const composer = () =>
  latest.some(({ role, text }) => /^AXText(?:Area|Field)$/.test(role) && /^Message /.test(text));
const firstBotAction = () =>
  buttons().find(
    ({ role, text }) =>
      role === "AXButton" &&
      /^(?:Create bot|(?:Make|Create|Start) (?:your )?first bot)[.…]?$/i.test(text),
  );
const reconnecting = () =>
  hasText(/^(?:Waiting for your gateway to reconnect|Reconnecting\b|Restarting OpenClaw)/i);

async function waitForGatewayReturn() {
  const deadline = performance.now() + 150_000;
  const directory = process.env.RUNNER_TEMP!;
  const name = "first-run-connection-sample.png";
  const frame = join(directory, name);
  const reader = join(directory, "first-run-connection-label");
  while (performance.now() < deadline) {
    await readWindow();
    if (reconnecting()) accountTiming.reconnectNoticeAt ??= seconds(performance.now() - start);
    if (accountTiming.reconnectNoticeAt !== null) {
      const sampledAt = performance.now();
      // The modal hides the rest of the window from Accessibility. Read the
      // rendered connection label without dismissing or clicking the sheet.
      await screenshot(name, false, directory);
      const { stdout } = await run(reader, [frame], { timeout: 8000 });
      if (hasText(/^Connected$/) || stdout.trim() === "Connected") {
        accountTiming.connectedAt = seconds(sampledAt - start);
        copyFileSync(frame, join(out!, "05-gateway-connected.png"));
        return sampledAt;
      }
    }
    await sleep(350);
  }
  throw new Error("The check did not observe Connected after the gateway restart.");
}

async function configureAccount(profile: string, appData: string) {
  const fixture = await scriptedProvider(profile, appData, (text) =>
    record({ kind: "fixture", text }),
  );
  provider = fixture.server;
  fixture.applyConfig();
  accountTiming.configAt = seconds(performance.now() - start);
  const [returned, restarted] = await Promise.allSettled([
    waitForGatewayReturn(),
    fixture.restart(),
  ]);
  if (restarted.status === "rejected") throw restarted.reason;
  if (returned.status === "rejected") throw returned.reason;
  if (timing === "late") {
    while (performance.now() - returned.value < 24_000) {
      await readWindow();
      await sleep(350);
    }
  }
  const writer = fixture.prepareAccountSave(true);
  try {
    accountTiming.saveInputAt = seconds(performance.now() - start);
    await writer.save();
    accountSavedAt = performance.now();
    accountTiming.savedAt = seconds(accountSavedAt - start);
    const delta = accountTiming.savedAt! - accountTiming.connectedAt!;
    if (
      (timing === "at-return" && Math.abs(delta) > 5) ||
      (timing === "late" && (delta < 20 || delta > 30))
    ) {
      throw new Error(`The ${timing} save landed ${delta.toFixed(1)}s relative to Connected.`);
    }
  } finally {
    writer.cancel();
  }
}

const shellVisible = () =>
  latest.some(({ role, text }) => role === "AXLandmarkNavigation" && text === "Bots") ||
  hasButton("Settings") ||
  hasText(/^Make your first bot$|^Connect an account$/i);

async function observeAccountSheet(savedAt: number): Promise<AccountSheetResult> {
  const wait = 120_000;
  const deadline = savedAt + 2 * wait;
  let observedReconnect = reconnecting();
  let availableSince: number | undefined;
  function result(outcome: AccountSheetResult["outcome"], at: number): AccountSheetResult {
    return {
      outcome,
      observedReconnect,
      secondsSinceAccountSaved: seconds(at - savedAt),
      secondsAvailable: availableSince === undefined ? 0 : seconds(at - availableSince),
    };
  }
  while (true) {
    await readWindow();
    const now = performance.now();
    const waiting = reconnecting();
    const sheetOpen = accountPicker();
    const advanced = !!firstBotAction() || composer();
    if (waiting || !(sheetOpen || advanced || firstBotWelcome())) {
      observedReconnect ||= waiting;
      availableSince = undefined;
    } else {
      availableSince ??= now;
      if (advanced) return result("advanced-without-press", now);
      if (!sheetOpen) return result("closed-without-press", now);
      if (now - availableSince >= wait) return result("still-open", now);
    }
    if (now >= deadline) return result("gateway-unavailable", now);
    await sleep(600);
  }
}

try {
  await step(0, async () => {
    noDeveloperTools();
    cleanMac();
    await system.confirmAudit();
    return "No OpenClaw profile, executable or service. No Apple developer tools. The app can only find Apple's git stub.";
  });
  await step(1, async () => {
    launch();
    const notFound = () => hasText(/^Clawtrate didn't find OpenClaw here$/);
    const chooseLocation = () => hasText(/^Where does OpenClaw run\?$/);
    await waitFor(
      "the not-found card or location choice",
      () => notFound() || chooseLocation(),
      60,
    );
    await ax("focus");
    const openedAutomatically = notFound();
    if (!openedAutomatically) {
      await screenshot("02-where-openclaw-runs.png");
      await press("This computer");
      await waitFor("the card for a Mac without OpenClaw", notFound);
    }
    notFoundAdvancedCount = buttons().filter(({ text }) => text === "Advanced").length;
    if (notFoundAdvancedCount !== 1) {
      throw new Error(
        `The OpenClaw not-found card exposes ${notFoundAdvancedCount} Advanced controls in Accessibility. Expected one.`,
      );
    }
    const path = openedAutomatically ? "opened automatically" : 'after pressing "This computer"';
    return `Clawtrate didn't find OpenClaw here (${path}). Accessibility exposes one Advanced control.`;
  });
  await step(2, async () => {
    if (!hasButton("Set up OpenClaw here")) {
      throw new Error(
        `"${heading() ?? "OpenClaw not found"}" has no "Set up OpenClaw here" button.`,
      );
    }
    await press("Set up OpenClaw here");
    const confirmation = () =>
      buttons().find(({ role, text }) => role === "AXButton" && /^Set up OpenClaw$/i.test(text));
    await waitFor(
      "the Mac's install confirmation",
      () =>
        nativeDialog() &&
        hasText(/^Set up OpenClaw on this computer\?$/i) &&
        !!confirmation() &&
        hasButton("Cancel"),
    );
    await screenshot("03-mac-install-confirmation.png");
    await press(confirmation()!.text);
    await waitFor("installation progress", () => hasText(/^Setting up OpenClaw/i), 45);
    await screenshot("03-install-progress.png");
    await waitFor(
      "the end of installation",
      () => hasText(/^OpenClaw is running$|^Connecting to OpenClaw/i) || shellVisible(),
      420,
    );
    return heading() ?? "OpenClaw installed";
  });
  await step(3, async () => {
    await waitFor("the automatically opened account picker", accountPicker, 90);
    connectedAt = performance.now();
    return "Connect an account opened automatically. Scopes will be inspected after the first reply.";
  });
  await step(4, async () => {
    if (!appData) throw new Error("The packaged app has no data folder for this run.");
    await waitFor("the untouched account picker", accountPicker);
    await screenshot("05-account-picker.png");
    await configureAccount(profile, appData);
    await readWindow();
    await screenshot("05-after-scripted-account.png");
    return heading() ?? "The scripted model is configured on loopback.";
  });
  await step(5, async () => {
    if (accountSavedAt !== undefined) {
      accountSheet = await observeAccountSheet(accountSavedAt);
      await screenshot("06-account-sheet-after-observation.png");
      if (accountSheet.outcome === "gateway-unavailable") {
        throw new Error(
          "The account sheet did not reach two minutes of available gateway connection.",
        );
      }
      if (accountSheet.outcome === "still-open") {
        throw new Error(
          "Connect an account stayed open for two minutes after the gateway was available.",
        );
      }
      if (accountSheet.outcome === "closed-without-press") {
        throw new Error("The account picker closed without opening the first-bot screen.");
      }
    }
    await waitFor(
      "a first conversation or a first-bot button",
      () => composer() || !!firstBotAction(),
      60,
    );
    const action = firstBotAction();
    if (action) {
      if (!provider) throw new Error("The scripted provider was not started.");
      await screenshot("06-first-bot-setup.png");
      const requestsBeforeCreate = await successfulScriptedRequests(provider);
      await press(action.text);
      const checking = () => hasText(/^Checking this account/i);
      await waitFor(
        "the account check or the first conversation",
        () => checking() || composer(),
        60,
      );
      const checkingScreenObserved = checking();
      if (checkingScreenObserved) {
        await screenshot("06-checking-account.png");
        await waitFor("the first conversation's composer", composer, 60);
      }
      accountProbe = {
        checkingScreenObserved,
        scriptedResponses: (await successfulScriptedRequests(provider)) - requestsBeforeCreate,
      };
      if (accountProbe.scriptedResponses < 1) {
        throw new Error(
          "Create bot did not complete a request through the selected scripted account.",
        );
      }
    }
    if ((await ax("compose")) !== "ok")
      throw new Error("Could not focus the first conversation's composer.");
    const replies = () => latest.filter(({ text }) => text.includes(SCRIPTED_REPLY)).length;
    const beforeSending = replies();
    record({ kind: "type", text: FIRST_MESSAGE });
    await ax("type", FIRST_MESSAGE);
    await press("Return", "person", "enter");
    await waitFor("the scripted reply", () => replies() > beforeSending, 120);
    await screenshot("06-reply-before-scopes.png");
    await press("Settings", "inspection");
    await waitFor("Gateway settings", () => hasButton("Gateway") || hasText(/^Granted scopes$/));
    if (!hasText(/^Granted scopes$/)) await press("Gateway", "inspection");
    await waitFor("the six granted scopes", () =>
      FULL_SCOPES.every((scope) => latest.some(({ text }) => text.split(/[, ]+/).includes(scope))),
    );
    await screenshot("06-granted-scopes.png");
    await press("Close settings", "inspection");
    await waitFor("the conversation after the scope inspection", () => replies() > beforeSending);
    return SCRIPTED_REPLY;
  });
} catch {
  // The first failing step retains the error and all later steps stay not reached.
} finally {
  let afterConnectionSeconds: number | null = null;
  if (connectedAt !== undefined && !systemPromptVisible) {
    const until = connectedAt + 60_000;
    try {
      while (performance.now() < until) {
        refuseForbidden(await system.sample(active.step, child?.pid));
        await sleep(1000);
      }
      refuseForbidden(await system.sample(active.step, child?.pid, true));
      afterConnectionSeconds = Math.floor((performance.now() - connectedAt) / 1000);
      await screenshot("after-connect-observation-screen.png", true);
    } catch (error) {
      active.status = "failed";
      active.text = show(error);
      await screenshot("after-connect-observation-screen.png", true).catch(() => undefined);
    }
  }
  const homeInfo = lstatSync(home, { throwIfNoEntry: false });
  const observed = await system.finish();
  const diagnostics = {
    developerTools: { ...developerTools, ...observed },
    notFoundAdvancedCount,
    afterConnectionSeconds,
    accountHomeMode: homeInfo && (homeInfo.mode & 0o777).toString(8),
    accountHomeOwnedByAppUser: homeInfo?.uid === process.geteuid?.(),
    accountHomeIsDirectory: homeInfo?.isDirectory() === true,
    accountHomeListing: await run("/bin/ls", ["-lde@", home], { timeout: 3000 }).then(
      ({ stdout }) => stdout.trim(),
      () => null,
    ),
    localGatewayHelper: existsSync(join(app, "Contents/Helpers/ClawtrateLocalGateway"))
      ? process.env.FIRST_RUN_HELPER_SOURCE === "added-by-check"
        ? "added-by-check"
        : "bundled"
      : "missing",
  };
  const answer = {
    verdict: verdict(stepResults),
    steps: stepResults,
    pressCounts,
    accountSheet,
    accountProbe,
    accountTiming,
    trace,
    diagnostics,
  };
  writeFileSync(join(out, "result.json"), JSON.stringify(answer, null, 2) + "\n");
  provider?.closeAllConnections();
  provider?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await sleep(1000);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (answer.verdict === "failed") process.exitCode = 1;
}
