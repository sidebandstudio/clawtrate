// Setting up on this computer (docs/design/setup.md §3 to §7) in the
// desktop app, against a real gateway: this run's own instance, started
// with --default-local-pairing, seen through a sandbox (a temporary home, the
// `openclaw` program and that instance's profile). The app is the
// development build, driven by Playwright; its native dialog is answered in
// its main process. The look never sees this computer's own OpenClaw: every
// launch here is automated, and the guard refuses a look without a sandbox.
//
// Electron must be installed: CI's Linux e2e job skips its download, and
// these checks with it.
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { devGateway } from "./global-setup.ts";
import { openInstance, readDevConnection } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { stateDirFor } from "../tools/dev-gateway/src/instance.ts";

const ROOT = join(import.meta.dirname, "..");
const DESKTOP = join(ROOT, "apps/desktop");
const SETUP = process.env.CLAWTRATE_E2E_SETUP!;
const DIR = process.env.CLAWTRATE_E2E_SETUP_DIR!;
const PROFILE = `clawtrate-dev-${SETUP}`;

/** Electron's binary, or null where it was never downloaded. */
function electronBinary(): string | null {
  try {
    const path = createRequire(join(DESKTOP, "package.json"))("electron") as string;
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}
const ELECTRON = electronBinary();

test.describe.configure({ mode: "serial" });
test.skip(ELECTRON === null, "Electron is not installed here (CI's Linux e2e job skips it)");

/** The `openclaw` this machine runs, found on PATH as the dev-gateway tool finds it. */
const OPENCLAW = (() => {
  try {
    return execFileSync("/usr/bin/which", ["openclaw"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();

let count = 0;
/** A fresh folder of this run's, for one launch. */
const folder = (name: string) => {
  const dir = join(DIR, `${(count += 1)}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

type Sandbox = { home: string; openclaw: string; instance: string; stateDir: string };

function writeSandbox(dir: string, change: Partial<Sandbox> = {}): string {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const sandbox: Sandbox = {
    home,
    openclaw: OPENCLAW,
    instance: SETUP,
    stateDir: stateDirFor(SETUP, homedir()),
    ...change,
  };
  const path = join(dir, "sandbox.json");
  writeFileSync(path, JSON.stringify(sandbox));
  return path;
}

/** The environment the app gets: nothing that points it at a development gateway or changes Electron. */
function appEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(CLAWTRATE_|ELECTRON_|NODE_OPTIONS$|OPENCLAW_)/.test(entry[0]),
    ),
  );
}

type Launched = { app: ElectronApplication; page: Page; log: () => string; data: string };

/**
 * Launches the development build with its own data folder and, unless told
 * not to, a sandbox. `answer` is the native dialog's answer: 0 confirms, 1 cancels.
 */
async function launch(
  options: { sandbox?: string | null; answer?: number } = {},
): Promise<Launched> {
  const dir = folder("app");
  const data = join(dir, "user-data");
  const args = [DESKTOP, `--user-data-dir=${data}`];
  if (options.sandbox !== null)
    args.push(`--clawtrate-setup-sandbox=${options.sandbox ?? writeSandbox(dir)}`);
  const app = await _electron.launch({ executablePath: ELECTRON!, args, env: appEnv(), cwd: dir });
  let output = "";
  app.process().stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  app.process().stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const answer = options.answer ?? 0;
  // The host's own dialog, answered as the person would; the questions it asked are kept.
  await app.evaluate(({ dialog }, response) => {
    const asked: string[] = [];
    (globalThis as { asked?: string[] }).asked = asked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail: string };
      asked.push(`${options.message} ${options.detail}`);
      return { response, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, answer);
  const page = await app.firstWindow();
  await page
    .getByRole("heading", { name: "Where does OpenClaw run?" })
    .waitFor({ timeout: 30_000 });
  return { app, page, log: () => output, data };
}

async function close(launched: Launched): Promise<void> {
  const pid = launched.app.process().pid;
  await launched.app.close();
  // The app and every helper it started are gone.
  if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
}

const asked = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { asked?: string[] }).asked ?? []);

/** The gateway's own list of devices, read with the dev-gateway tool's runner. */
function devices(): {
  paired: Array<{ deviceId: string; scopes?: string[]; approvedVia?: string; roles?: string[] }>;
  pending: unknown[];
} {
  const result = openInstance(SETUP).runner.runSync(["devices", "list", "--json"]);
  if (result.status !== 0) throw new Error(`devices list exited ${result.status}`);
  return parseJsonOutput(`${result.stdout}`);
}

const thisComputer = (page: Page) =>
  page
    .getByRole("list", { name: "Where does OpenClaw run?" })
    .getByRole("button", { name: /This computer/ });

test.beforeAll(() => {
  test.skip(ELECTRON === null, "Electron is not installed here");
  expect(OPENCLAW).not.toBe("");
  // The development build of the desktop app, into its own output folder.
  execFileSync("pnpm", ["--filter", "@clawtrate/desktop", "exec", "electron-vite", "build"], {
    cwd: ROOT,
    stdio: "ignore",
  });
});

test("an automated launch without a sandbox refuses the look, loudly, and runs no program", async () => {
  const launched = await launch({ sandbox: null });
  await thisComputer(launched.page).click();
  await expect(
    launched.page.getByRole("heading", { name: "Looking on this computer is off here" }),
  ).toBeVisible();
  await expect.poll(launched.log).toContain("The look on this computer refused to start");
  await close(launched);
});

test("F-492 F-494: the consent declined pairs nothing, as the gateway itself says", async () => {
  const before = devices();
  const launched = await launch({ answer: 1 });
  await thisComputer(launched.page).click();
  await expect(launched.page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible({
    timeout: 60_000,
  });
  await launched.page.getByRole("button", { name: "Connect" }).click();
  await expect.poll(() => asked(launched.app)).toHaveLength(1);
  await expect(launched.page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible();
  await expect(launched.page.getByRole("button", { name: "Connect" })).toBeVisible();
  // Nothing was minted or registered: the gateway's devices are as they were.
  expect(devices()).toEqual(before);
  expect(existsSync(join(launched.data, "gateway"))).toBe(true);
  expect(readStore(launched.data)).not.toContain("deviceToken:");
  await close(launched);
});

/** What the app stored: its key-value file, `state.json` in its data folder, as text. */
function readStore(data: string): string {
  const path = join(data, "gateway/state.json");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

test("F-492 F-494: the gateway on this computer is found and connected read-only with nothing typed", async () => {
  const before = devices().paired.map((device) => device.deviceId);
  const launched = await launch();
  const { page } = launched;
  await thisComputer(page).click();
  await expect(page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("setup-found").locator("dl > div")).toHaveText([
    "Version2026.10.6",
    `Profile${PROFILE}`,
    "ListensOn this computer only",
    "ServiceNone, started by hand",
  ]);
  await expect(page.locator("input")).toHaveCount(0);
  await page.getByRole("button", { name: "Connect" }).click();
  // The app opens, read-only, with nothing typed.
  await expect(page.locator(".shell")).toBeVisible({ timeout: 60_000 });
  expect(await asked(launched.app)).toEqual([
    `Pair this device read-only with the ${PROFILE} gateway on this computer? The gateway saves this device.`,
  ]);
  // The gateway itself: one new device, an operator, with exactly read, approved silently.
  const added = devices().paired.filter((device) => !before.includes(device.deviceId));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    scopes: ["operator.read"],
    approvedVia: "silent",
    roles: ["operator"],
  });
  // The shared token was never typed, never asked for, and is in none of the app's data or output.
  const shared = readDevConnection(openInstance(SETUP).connectionFile)!.token;
  expect(readStore(launched.data)).toContain("deviceToken:");
  expect(readStore(launched.data)).not.toContain(shared);
  expect(launched.log()).not.toContain(shared);
  await close(launched);
});

test("F-515: another version is named, offers Advanced, and runs nothing for the person", async () => {
  const dir = folder("other-version");
  // A stand-in program that reports another version for everything the real one prints.
  const wrapper = join(dir, "bin/openclaw");
  mkdirSync(join(dir, "bin"));
  writeFileSync(
    wrapper,
    `#!/bin/sh\nout=$("${OPENCLAW}" "$@")\ncode=$?\nprintf '%s\\n' "$out" | /usr/bin/sed 's/2026\\.10\\.6/2026.9.37/g'\nexit $code\n`,
  );
  chmodSync(wrapper, 0o755);
  const launched = await launch({ sandbox: writeSandbox(dir, { openclaw: wrapper }) });
  await thisComputer(launched.page).click();
  await expect(launched.page.getByRole("status").filter({ hasText: "2026.9.37" })).toHaveText(
    "OpenClaw 2026.9.37 isn't the version this Clawtrate is tested with (2026.10.6). Use Advanced to connect to it.",
    { timeout: 60_000 },
  );
  await expect(launched.page.getByRole("button", { name: "Connect" })).toHaveCount(0);
  await expect(launched.page.getByRole("button", { name: "Use Advanced" })).toBeVisible();
  expect(await asked(launched.app)).toEqual([]);
  await close(launched);
});

test("F-516: another profile and another service are named and not connected to", async () => {
  const dir = folder("others");
  const sandbox = writeSandbox(dir);
  const home = join(dir, "home");
  mkdirSync(join(home, ".openclaw-work"));
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(
    join(home, "Library/LaunchAgents/com.example.openclaw-gateway.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.example.openclaw-gateway</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw</string><string>--profile</string><string>work</string><string>gateway</string><string>run</string></array>
</dict></plist>
`,
  );
  const launched = await launch({ sandbox });
  await thisComputer(launched.page).click();
  await expect(launched.page.getByRole("status").filter({ hasText: "also saw" })).toHaveText(
    "Clawtrate also saw other OpenClaw services here (service com.example.openclaw-gateway, profile work). It connects only to the default gateway and its own; use Advanced for others.",
    { timeout: 60_000 },
  );
  // What the card offers to connect to is this run's instance, by its profile.
  await expect(launched.page.getByTestId("setup-found").locator("dl > div").nth(1)).toHaveText(
    `Profile${PROFILE}`,
  );
  await close(launched);
});

test("F-493: Advanced is the address-and-token form, and it still connects", async () => {
  const before = devices().paired.map((device) => device.deviceId);
  const launched = await launch();
  const { page } = launched;
  await page.getByRole("button", { name: "Advanced" }).click();
  const connection = readDevConnection(openInstance(SETUP).connectionFile)!;
  await page.getByPlaceholder("Gateway address").fill(connection.url);
  await page.getByPlaceholder("Token, for the first pairing only").fill(connection.token);
  await page.getByRole("button", { name: "Connect a gateway" }).click();
  await expect(page.locator(".shell")).toBeVisible({ timeout: 60_000 });
  const added = devices().paired.filter((device) => !before.includes(device.deviceId));
  expect(added).toHaveLength(1);
  expect(added[0]!.scopes).toEqual(["operator.read"]);
  expect(await asked(launched.app)).toEqual([]);
  await close(launched);
});

test("a gateway that is stopped is installed but not running, with nothing listening on its port", async () => {
  devGateway(SETUP, "stop");
  const launched = await launch();
  await thisComputer(launched.page).click();
  await expect(
    launched.page.getByRole("heading", { name: "OpenClaw is installed but not running" }),
  ).toBeVisible({
    timeout: 60_000,
  });
  const facts = launched.page.getByTestId("setup-found").locator("dl > div");
  await expect(facts.nth(0)).toHaveText("Version2026.10.6");
  await expect(facts.nth(1)).toHaveText("ServiceNone, started by hand");
  await expect(facts.nth(2)).toHaveText(/^PortNothing listening on 19\d\d\d$/);
  await expect(launched.page.getByRole("button", { name: "Connect" })).toHaveCount(0);
  await close(launched);
});
