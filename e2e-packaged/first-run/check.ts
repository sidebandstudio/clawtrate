import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { FULL_SCOPES } from "../../packages/core/src/scopes.ts";
import { appEnv } from "../desktop-driver.ts";
import { FIRST_MESSAGE, SCRIPTED_REPLY, scriptedProvider } from "./provider.ts";
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
const run = promisify(execFile);
const show = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stepResults: StepResult[] = STEPS.map((step) => ({
  step,
  status: "not-reached",
  seconds: 0,
  text: null,
  screenshot: null,
}));
type Event = { seconds: number; step: string; kind: "screen" | "press" | "type"; text: string };
const trace: Event[] = [];
const start = performance.now();
let active = stepResults[0]!;
let latest: Element[] = [];
let screenKey = "";
let child: ChildProcess | undefined;
let launchError: Error | undefined;
let provider: Server | undefined;

mkdirSync(out, { recursive: true });

function record(kind: Event["kind"], text: string) {
  trace.push({
    seconds: Math.round((performance.now() - start) / 100) / 10,
    step: active.step,
    kind,
    text,
  });
}

async function ax(mode: string, target = ""): Promise<string> {
  if (launchError) throw launchError;
  if (child?.exitCode != null || child?.signalCode != null)
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
  latest.filter(({ role, text }) => role === "AXHeading" && text !== "Clawtrate").at(-1)?.text ??
  null;

async function readWindow() {
  const snapshot = await ax("read");
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
    record("screen", text);
    screenKey = text;
  }
  const forbidden = forbiddenScreen(latest);
  if (forbidden) throw new Error(`The app asks for a step outside first run: ${forbidden}`);
}

async function waitFor(label: string, ready: () => boolean, seconds = 30) {
  const until = performance.now() + seconds * 1000;
  do {
    await readWindow();
    if (ready()) return;
    const retry = latest.find(({ role, text }) => role === "AXButton" && text === "Try again");
    if (retry) throw new Error(`${heading() ?? label} offers Try again.`);
    await sleep(600);
  } while (performance.now() < until);
  const roles = [...new Set(latest.map(({ role }) => role))].join(", ");
  throw new Error(
    `${label} did not appear. Last heading: ${heading() ?? "(none)"}. Window roles: ${roles || "(none)"}.`,
  );
}

async function press(name: string) {
  record("press", name);
  if ((await ax("press", name)) !== "ok") throw new Error(`Could not press "${name}".`);
}

async function screenshot(file: string) {
  const path = join(out!, file);
  // Capture the window's screen rectangle so the native sheet is also in the picture.
  // Before the app has a window, show the desktop.
  const bounds = await ax("bounds").catch(() => "");
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
    await screenshot(file);
    active.screenshot = file;
  } catch (error) {
    active.text += ` Screenshot failed. ${show(error)}`;
    active.status = "failed";
  }
  console.log(`${active.step} ${active.status} (${active.seconds}s) ${active.text}`);
  if (active.status === "failed") throw new Error(active.text);
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
  const data = mkdtempSync(join(process.env.RUNNER_TEMP!, "first-run-data-"));
  const env = appEnv();
  // CI and debugger switches classify an app launch as sandboxed. Drive its
  // production window via the OS, with no debugging port and no setup stand-ins.
  delete env.CI;
  delete env.VITEST;
  child = spawn(
    join(app!, "Contents/MacOS/Clawtrate"),
    [`--user-data-dir=${data}`, "--force-renderer-accessibility"],
    { env, stdio: "ignore" },
  );
  child.once("error", (error) => (launchError = error));
}

const shellVisible = () =>
  latest.some(({ role, text }) => role === "AXLandmarkNavigation" && text === "Bots") ||
  hasButton("Settings") ||
  hasText(/^Make your first bot$|^Connect an account$/i);

try {
  await step(0, async () => {
    cleanMac();
    return "No OpenClaw profile, executable on PATH or service.";
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
    if (notFound()) return "Clawtrate didn't find OpenClaw here (opened automatically)";
    await screenshot("02-where-openclaw-runs.png");
    await press("This computer");
    await waitFor("the card for a Mac without OpenClaw", notFound);
    return 'Clawtrate didn\'t find OpenClaw here (after pressing "This computer")';
  });
  await step(2, async () => {
    if (!hasButton("Set up OpenClaw here")) {
      throw new Error(
        `"${heading() ?? "OpenClaw not found"}" has no "Set up OpenClaw here" button.`,
      );
    }
    await press("Set up OpenClaw here");
    await waitFor(
      "the Mac's install confirmation",
      () =>
        nativeDialog() &&
        hasText(/^Set up OpenClaw on this computer\?$/i) &&
        hasButton("Set up OpenClaw") &&
        hasButton("Cancel"),
    );
    await screenshot("03-mac-install-confirmation.png");
    await press("Set up OpenClaw");
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
    await waitFor("the automatically connected app", shellVisible, 90);
    await press("Settings");
    await waitFor("Gateway settings", () => hasButton("Gateway") || hasText(/^Granted scopes$/));
    if (!hasText(/^Granted scopes$/)) await press("Gateway");
    await waitFor("the six granted scopes", () =>
      FULL_SCOPES.every((scope) => latest.some(({ text }) => text.split(/[, ]+/).includes(scope))),
    );
    await screenshot("04-granted-scopes.png");
    await press("Close settings");
    return "OpenClaw granted all six operator scopes.";
  });
  await step(4, async () => {
    provider = await scriptedProvider(profile);
    await readWindow();
    return heading() ?? "The scripted model is configured on loopback.";
  });
  await step(5, async () => {
    const composer = () =>
      latest.some(
        ({ role, text }) => /^AXText(?:Area|Field)$/.test(role) && /^Message /.test(text),
      );
    const firstBotAction = () =>
      buttons().find(
        ({ role, text }) =>
          role === "AXButton" && /^(?:Make|Create|Start) (?:your )?first bot[.…]?$/i.test(text),
      );
    await waitFor(
      "a first conversation or a first-bot button",
      () => composer() || !!firstBotAction(),
      60,
    );
    const action = firstBotAction();
    if (action) {
      await press(action.text);
      await waitFor("the first conversation's composer", composer);
    }
    if ((await ax("compose")) !== "ok")
      throw new Error("Could not focus the first conversation's composer.");
    const replies = () => latest.filter(({ text }) => text.includes(SCRIPTED_REPLY)).length;
    const beforeSending = replies();
    record("type", FIRST_MESSAGE);
    await ax("type", FIRST_MESSAGE);
    record("press", "Return");
    await ax("enter");
    await waitFor("the scripted reply", () => replies() > beforeSending, 120);
    return SCRIPTED_REPLY;
  });
} catch {
  // The first failing step retains the error and all later steps stay not reached.
} finally {
  const answer = { verdict: verdict(stepResults), steps: stepResults, trace };
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
