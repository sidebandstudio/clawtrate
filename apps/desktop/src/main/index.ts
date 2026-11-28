// Electron main process: hosts the core client and serves state to the renderer over IPC.

import {
  batchSnapshots,
  createBridgeSession,
  type BridgeSession,
  parseBridgeCommand,
  type ClawtrateState,
  type HostInfo,
  PendingSaves,
} from "@clawtrate/core";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  session,
  shell,
  type WebContents,
} from "electron";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_FILE } from "@clawtrate/core/node";
import { applyUnreadBadge, dotBitmap, parseBadgeCount } from "./badge.ts";
import { startDesktopUpdates } from "./update/build-info.ts";
import { createUpdatePreferenceStore } from "./update/preferences.ts";
import { windowsAppUserModelId } from "./identity.ts";
import { safeFileName, writeExactly, type SaveResult } from "./save.ts";
import {
  keychainCheckName,
  keepAside,
  KEYCHAIN_CHECK_SWITCH,
  MOCK_KEYCHAIN_SWITCH,
  RECOVERY_BUTTONS,
  safeStorageBox,
  SESSION_ONLY,
  startupFailure,
  usesSecureStorage,
} from "./secret-box.ts";
import {
  readDevConnection,
  selectInstance,
  startHostRuntime,
  type HostRuntime,
} from "../host/runtime.ts";
import { SetupController } from "../setup/controller.ts";
import { computerPlace, Installer, installSupported } from "../setup/install.ts";
import { installTarget, PINS } from "../setup/install-pins.ts";
import { InstallRunner } from "../setup/install-runner.ts";
import { quitGate } from "../setup/quit.ts";
import { localConnectFor, provedRouteFor, type Launchd } from "../setup/local-connect.ts";
import { ProgramRunner } from "../setup/programs.ts";
import { resolveSetupLaunch, sandboxOpener, type Opened } from "../setup/sandbox.ts";
import { startSyntheticGateway } from "../setup/synthetic-gateway.ts";
import { desktopStartup } from "../setup/startup.ts";
import { processIdentity } from "../../../../tools/dev-gateway/src/state-guard.ts";
import { accountHome, productionWorld, type SetupRefusedError } from "../setup/world.ts";

app.setName("Clawtrate");
// On Windows, the taskbar button belongs to the installer's shortcuts from the first window.
const appUserModelId = windowsAppUserModelId(process.platform, app.isPackaged);
if (appUserModelId) app.setAppUserModelId(appUserModelId);
// Every renderer is sandboxed, including any not created through createWindow.
app.enableSandbox();

const APP_ROOT = app.getAppPath();
const REPO_ROOT = join(APP_ROOT, "../..");
const RESOURCES = join(APP_ROOT, "resources");
const RENDERER_DIR = join(import.meta.dirname, "../renderer");
// Only a development build loads the renderer from the dev server; a packaged
// app never loads a URL taken from its environment.
const DEV_SERVER = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

/** The app's own content: its renderer folder, or the dev server in development. */
function isAppContent(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "file:") return url.href.startsWith(pathToFileURL(RENDERER_DIR).href + "/");
  if (DEV_SERVER === undefined) return false;
  const dev = new URL(DEV_SERVER);
  // The dev server's page, assets and its hot-reload socket.
  return url.hostname === dev.hostname && url.port === dev.port;
}

/** Links leave the app only for the web: http and https open in the system browser. */
function openExternally(raw: string): void {
  try {
    const { protocol } = new URL(raw);
    if (protocol === "http:" || protocol === "https:") void shell.openExternal(raw);
  } catch {
    // not a URL: ignored
  }
}

let runtime: HostRuntime | null = null;
let window: BrowserWindow | null = null;
/** The programs setup started, ended by PID when the app quits. */
const programs = new ProgramRunner();
let closeSetup: () => Promise<void> = async () => {};
/** The programs an install started, each in its own process group, ended and waited for when the app quits. */
const installPrograms = new InstallRunner();
/** Aborted when the app quits: an install downloads nothing more and starts no further step. */
const installStop = new AbortController();
/** How long the quit waits for setting OpenClaw up, its downloads and its programs to end. */
const INSTALL_QUIT_WAIT_MS = 5_000;
/** The setup controller's own close, once it exists: nothing new starts and its operation is waited for. */
let closeController: () => Promise<void> = async () => {};

/** Whether a command-line switch was given, to Chromium or to the app. */
function hasSwitch(name: string): boolean {
  return (
    app.commandLine?.hasSwitch(name) === true ||
    process.argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
  );
}

/** A switch's value, given to Chromium or to the app; empty when it has none. */
function switchValue(name: string): string {
  return app.commandLine?.getSwitchValue(name) ?? "";
}

/**
 * How this launch sets up on this computer (docs/development/setup.md),
 * resolved before the single-instance lock and the host runtime: the real
 * computer for a packaged app nothing automates; otherwise only the sandbox
 * the launch names, checked now, or a refusal.
 */
const SETUP = resolveSetupLaunch({
  packaged: app.isPackaged,
  env: process.env,
  switches: hasSwitch,
  switchValue,
  context: { platform: process.platform, home: accountHome(), uid: process.getuid?.() ?? null },
});

/**
 * What the host starts on, from that launch, also before the lock: a sandbox's
 * checked `app-data` or, for a refused or automated Windows start, the folder named with
 * `--user-data-dir` or else a fresh private temporary folder as its data
 * folder, and then no development gateway and no saved gateway reopened.
 * Only a person's packaged app keeps the ordinary data folder and resumes.
 */
const STARTUP = desktopStartup(SETUP, {
  packaged: app.isPackaged,
  devConnection: () =>
    readDevConnection(REPO_ROOT, { instance: selectInstance(undefined, process.env) }),
  autoConnectDev: () => process.env.CLAWTRATE_AUTOCONNECT_DEV === "1",
  launchData: () => switchValue("user-data-dir") || null,
  privateData: () => mkdtempSync(join(tmpdir(), "clawtrate-refused-")),
});
if (STARTUP.userData) app.setPath("userData", STARTUP.userData);
/** A packaged launch check's own app name, set before safeStorage reads it for its Keychain item. */
const KEYCHAIN_CHECK = keychainCheckName(
  SETUP,
  app.isPackaged,
  process.platform,
  switchValue(KEYCHAIN_CHECK_SWITCH),
  hasSwitch(MOCK_KEYCHAIN_SWITCH),
);
if (KEYCHAIN_CHECK) app.setName(KEYCHAIN_CHECK);

/** Run a fixed system tool with a deadline. The caller uses only its label or exit status. */
function launchAgentTool(program: "/usr/bin/plutil" | "/bin/launchctl", args: string[]) {
  return new Promise<string | null>((resolve) => {
    execFile(
      program,
      args,
      { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 8192 },
      (error, stdout) => resolve(error ? null : stdout.trim()),
    );
  });
}

const macLaunchd: Launchd = {
  labelAt: (plist) => launchAgentTool("/usr/bin/plutil", ["-extract", "Label", "raw", plist]),
  run: async (args) => ((await launchAgentTool("/bin/launchctl", args)) === null ? 1 : 0),
};

/**
 * Local connect (docs/design/setup-effortless.md §3): a person's packaged Mac app only, with its
 * Keychain, its native helper in Contents/Helpers and the account's own home. Off in every other
 * launch: a development build, an automated run and a launch check have no default home
 * (`localConnectFor`), and a launch without the Keychain couldn't keep a full grant.
 */
const LOCAL_CONNECT =
  SETUP.kind === "production" &&
  process.platform === "darwin" &&
  usesSecureStorage(SETUP, process.platform, KEYCHAIN_CHECK, hasSwitch(MOCK_KEYCHAIN_SWITCH))
    ? localConnectFor(
        { packaged: app.isPackaged, env: process.env, switches: hasSwitch },
        {
          // packaging/config.ts `LOCAL_GATEWAY_HELPER`, built and signed with the app.
          helper: join(process.resourcesPath, "..", "Helpers", "ClawtrateLocalGateway"),
          platform: process.platform,
          launchd: macLaunchd,
        },
      )
    : null;

/**
 * The checkout whose run records prove a sandbox's run: this development
 * build's own; a packaged app is told by its launch check.
 */
function launcherCheckout(): string | null {
  const path = app.isPackaged ? switchValue("clawtrate-setup-checkout") : REPO_ROOT;
  try {
    return path ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

/** What each look and Connect opens: the real computer, the sandbox, or the refusal. */
function setupOpener(): {
  open: () => Promise<Opened | SetupRefusedError>;
  close: () => Promise<void>;
} {
  const close = async () => {};
  if (SETUP.kind === "refused") return { open: async () => SETUP.error, close };
  if (SETUP.kind === "sandbox") {
    return sandboxOpener({
      file: SETUP.file,
      sandbox: SETUP.sandbox,
      platform: process.platform,
      context: {
        platform: process.platform,
        home: accountHome(),
        uid: process.getuid?.() ?? null,
        checkout: launcherCheckout(),
      },
      startGateway: startSyntheticGateway,
      log: (line) => console.log(line),
    });
  }
  // The real computer; on Windows the look starts nothing.
  const home = accountHome();
  return {
    open: async () => ({
      world: productionWorld({
        home: home ?? "",
        appData: app.getPath("userData"),
        platform: process.platform,
        lang: process.env.LANG,
      }),
      run: programs.run,
      identify: processIdentity,
    }),
    close,
  };
}

/**
 * A new installer for each attempt (docs/design/setup.md §10), offered only where local
 * connect is on: a person's packaged Mac app that nothing automates. Every development build
 * and automated run gets none: it never downloads or runs OpenClaw's installer.
 */
function setupInstaller(): (() => Installer) | null {
  if (SETUP.kind !== "production" || !LOCAL_CONNECT || process.platform !== "darwin") return null;
  const target = installTarget(process.platform, process.arch, false);
  const home = LOCAL_CONNECT.home;
  if (!target || !installSupported(home, app.getPath("userData"))) return null;
  return () =>
    new Installer({
      place: computerPlace({
        home,
        appData: app.getPath("userData"),
        platform: "darwin",
        target,
        env: process.env,
      }),
      pins: PINS,
      run: (request, check) => installPrograms.run(request, check),
      signal: installStop.signal,
      trashSetup: (path) => shell.trashItem(path),
      personsApp: true,
      accountHome: home,
      log: (line) => console.log(line),
    });
}

/** The host's own confirmation (docs/design/setup.md §2): a native dialog, never the page. */
async function confirmNatively(confirmation: {
  message: string;
  detail: string;
  confirm: string;
}): Promise<boolean> {
  const options = {
    type: "question" as const,
    message: confirmation.message,
    detail: confirmation.detail,
    buttons: [confirmation.confirm, "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const owner = window && !window.isDestroyed() ? window : null;
  const answer = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  return answer.response === 0;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: "Clawtrate",
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    show: false,
    // The dark theme's ground: the app opens dark until a person chooses otherwise.
    backgroundColor: "#101112",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // The window controls, centred in the 40 px title row (docs/design/titlebar.md). Measured in
    // a capture of this window: the buttons' circles start 1 px right of this point and their
    // centre line is 7.75 px below it, so y 12 centres them at 19.75 (the row's centre is 20) and
    // x 13 starts them 14 px in, as far as they sit from the top, 14.5 px clear of the mark at
    // 80. hiddenInset's own placement put the centre line at 18.75.
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 13, y: 12 } } : {}),
    ...(process.platform === "darwin" ? {} : { icon: join(RESOURCES, "icon.png") }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.on("closed", () => {
    if (window === win) window = null;
  });
  win.once("ready-to-show", () => {
    if (!process.env.CLAWTRATE_SCREENSHOT) win.show();
  });

  if (DEV_SERVER) void win.loadURL(DEV_SERVER);
  else void win.loadFile(join(RENDERER_DIR, "index.html"));
  return win;
}

/**
 * Verification aid: with CLAWTRATE_SCREENSHOT=<path>, wait for the shell to render,
 * save the window as a PNG, and quit. The window is never shown.
 */
async function captureAndQuit(win: BrowserWindow, path: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = (await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="transcript-turn"]').length > 0`,
    )) as boolean;
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  const image = await win.webContents.capturePage();
  writeFileSync(path, image.toPNG());
  app.quit();
}

/**
 * Every web contents, the window's and any other: no new windows (links from
 * transcripts open in the system browser), no navigation, no webviews.
 */
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

/**
 * Nothing but the app's own files is loaded. The one exception is a bot's
 * picture, an https image the gateway names (the page's policy allows it as
 * `img-src https:`). The renderer is granted no permissions except writing
 * text to the clipboard for the copy buttons.
 */
function lockDownSession(): void {
  const ses = session.defaultSession;
  // For a language Windows has no spell checker for, Chromium downloads a
  // dictionary from Google's servers, and the filter below never sees that
  // request. Until the person can choose such a download (F-393), Windows
  // checks no spelling: with no languages, Chromium loads no checker and asks
  // for no dictionary. macOS downloads none. Linux, where Hunspell is the only
  // checker, keeps Chromium's download.
  if (process.platform === "win32") ses.setSpellCheckerLanguages([]);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      isAppContent(details.url) ||
      details.url.startsWith("devtools:") ||
      details.url.startsWith("data:") ||
      (details.resourceType === "image" && details.url.startsWith("https://"));
    callback({ cancel: !allowed });
  });
  const allowedPermission = (permission: string) => permission === "clipboard-sanitized-write";
  ses.setPermissionRequestHandler((_contents, permission, grant) =>
    grant(allowedPermission(permission)),
  );
  ses.setPermissionCheckHandler((_contents, permission) => allowedPermission(permission));
}

/**
 * Show the save dialog for the bytes `saves` holds under `ticket` and
 * write exactly those bytes where the person chooses. They are released when
 * the dialog is cancelled, when the write ends either way, and when the
 * window or its page goes; a page that went has nothing written for it.
 */
async function saveHeld(
  saves: PendingSaves,
  ticket: number,
  contents: WebContents,
  name: string,
): Promise<SaveResult> {
  const drop = () => saves.release(ticket);
  const navigated = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) drop();
  };
  contents.once("destroyed", drop);
  contents.on("render-process-gone", drop);
  contents.on("did-start-navigation", navigated);
  try {
    const owner = BrowserWindow.fromWebContents(contents);
    const options = {
      defaultPath: join(app.getPath("downloads"), name),
      properties: ["createDirectory", "showOverwriteConfirmation"] as Array<
        "createDirectory" | "showOverwriteConfirmation"
      >,
    };
    const chosen = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    const data = saves.get(ticket);
    if (chosen.canceled || !chosen.filePath || !data) return { status: "cancelled" };
    return await writeExactly(
      { readFile, writeFile, rename, rm, stat },
      chosen.filePath,
      new Uint8Array(data),
    );
  } finally {
    contents.removeListener("destroyed", drop);
    contents.removeListener("render-process-gone", drop);
    contents.removeListener("did-start-navigation", navigated);
    drop();
  }
}

/** The device key and tokens live here, readable by this user only. */
function privateDataDir(): string {
  // Only a person's app takes its folder from the environment; every other run keeps its own.
  const chosen = SETUP.kind === "production" ? process.env.CLAWTRATE_DATA_DIR : undefined;
  const dir = chosen ?? join(app.getPath("userData"), "gateway");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  return dir;
}

async function main(): Promise<void> {
  await app.whenReady();
  lockDownSession();
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(join(RESOURCES, "icon-mac.png"));
  }

  const devInstance = STARTUP.devGateway ? selectInstance(undefined, process.env) : null;
  try {
    runtime = await startHostRuntime({
      kind: "desktop",
      displayName: "Clawtrate Desktop",
      dataDir: privateDataDir(),
      // This device's credentials in the Keychain: a person's app on macOS, or a launch check's.
      ...(usesSecureStorage(
        SETUP,
        process.platform,
        KEYCHAIN_CHECK,
        hasSwitch(MOCK_KEYCHAIN_SWITCH),
      )
        ? // With the Keychain, a first pairing over a protected address asks for full control.
          { secretBox: safeStorageBox(safeStorage, process.platform) }
        : {}),
      // A sandboxed or refused start (every development build and automated run) has no
      // development gateway, doesn't auto-connect and never resumes a saved gateway.
      devGateway: STARTUP.devGateway,
      recheckDevGateway: () => readDevConnection(REPO_ROOT, { instance: devInstance }),
      autoConnectDev: STARTUP.autoConnectDev,
      resume: STARTUP.resume,
      // A gateway set up through local connect reopens only on sockets proved the same way.
      ...(LOCAL_CONNECT
        ? {
            localConnect: provedRouteFor(LOCAL_CONNECT, (why) =>
              console.log(`[setup] couldn't verify what is listening (${why})`),
            ),
          }
        : {}),
    });
  } catch (error) {
    // Nothing has connected and no window is open: say so in fixed words, and leave.
    const { title, message, recover } = startupFailure(error);
    if (!recover) {
      dialog.showErrorBox(title, message);
      app.exit(1);
      return;
    }
    // A damaged record or unreadable settings: start fresh, keeping those files, or quit.
    const choice = dialog.showMessageBoxSync({
      type: "error",
      title,
      message: title,
      detail: message,
      buttons: [...RECOVERY_BUTTONS],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) {
      try {
        const dir = privateDataDir();
        await keepAside(recover === "settings" ? join(dir, STATE_FILE) : dir, new Date());
        app.relaunch();
        app.exit(0);
      } catch {
        dialog.showErrorBox(
          title,
          "Clawtrate couldn't set the old files aside. Nothing was changed.",
        );
        app.exit(1);
      }
      return;
    }
    app.exit(1);
    return;
  }
  if ((await runtime.credentialStatus?.()) === "session")
    void dialog.showMessageBox({ type: "warning", ...SESSION_ONLY });
  const { client, info, policy } = runtime;
  const userDir = app.getPath("userData");
  const updates = await startDesktopUpdates({
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    downloadDir: join(userDir, "updates"),
    store: createUpdatePreferenceStore(join(userDir, "update-preferences.json")),
    changed(snapshot) {
      if (window && !window.isDestroyed())
        window.webContents.send("clawtrate:update:changed", snapshot);
    },
  });
  app.on("will-quit", () => updates.quitting());
  app.on("quit", () => updates.shutdown());
  ipcMain.handle("clawtrate:update:restart", (_event, id: unknown) => updates.restart(id));
  ipcMain.handle("clawtrate:update:get", () => updates.get());
  ipcMain.handle("clawtrate:update:check", (_event, track: unknown, revision: unknown) =>
    updates.check(track, revision),
  );
  ipcMain.handle("clawtrate:update:track", (_event, track: unknown) => updates.chooseTrack(track));
  ipcMain.handle("clawtrate:update:download", (_event, id: unknown) => updates.download(id));
  // Setup on this computer. A development build and every automated run look only in a sandbox.
  const opener = setupOpener();
  closeSetup = opener.close;
  const installer = setupInstaller();
  const setup = new SetupController({
    client,
    installer,
    open: opener.open,
    stopPrograms: () => programs.stopAll(),
    confirm: confirmNatively,
    log: (line) => console.log(line),
    // The settings reader's parse worker is an entry of the main bundle (electron.vite.config.ts).
    ...(LOCAL_CONNECT
      ? {
          localConnect: {
            ...LOCAL_CONNECT,
            worker: new URL("./settings-parse.js", import.meta.url),
          },
        }
      : {}),
  });
  policy.setup = setup;
  closeController = () => setup.close();
  info.setup = {
    look: true,
    pair: true,
    platform: process.platform,
    local: !!LOCAL_CONNECT,
    install: installer !== null,
  };
  // With local connect, the look only reads files and proves a socket, so it runs before the
  // person is asked anything: a gateway found here is offered on the first screen.
  if (LOCAL_CONNECT && client.state.connection.gatewayUrl === null) void setup.lookAtStart();

  ipcMain.handle("clawtrate:hello", (): { info: HostInfo; state: ClawtrateState } => ({
    info,
    state: client.state,
  }));
  // One bridge session per window, so a closed window releases its transcripts.
  const sessions = new Map<number, BridgeSession>();
  ipcMain.handle("clawtrate:command", async (event, raw: unknown) => {
    const contents = event.sender;
    let session = sessions.get(contents.id);
    if (!session) {
      const created = createBridgeSession(client, policy);
      sessions.set(contents.id, created);
      contents.once("destroyed", () => {
        created.dispose();
        sessions.delete(contents.id);
      });
      session = created;
    }
    // Only the command's plain-data answer crosses back to the renderer.
    return session.apply(parseBridgeCommand(raw));
  });
  // Files arrive as bytes, never as paths: a renderer cannot make this process read a file of its choosing.
  ipcMain.handle("clawtrate:attach", (_event, raw: unknown) => {
    const file = raw as { name?: unknown; type?: unknown; data?: unknown } | null;
    const data = file?.data;
    if (!(data instanceof ArrayBuffer)) throw new Error("invalid file");
    const store = policy.attachments!;
    const meta = { fileName: file?.name, mimeType: file?.type };
    store.check(meta, data.byteLength);
    return store.add(meta, data.byteLength, () => Buffer.from(data).toString("base64"));
  });
  // Saving a file the Work pane holds: its bytes arrive, never a path; the person picks
  // where in the system's save dialog, starting in Downloads, and only that file is written.
  // No more than the largest content a reader sends, and one dialog at a time: a page cannot
  // make this process hold more (`PendingSaves`, counted as `saves` in docs/decisions.md).
  const saves = new PendingSaves();
  ipcMain.handle("clawtrate:save", (event, raw: unknown): Promise<SaveResult> => {
    const file = raw as { name?: unknown; data?: unknown } | null;
    const data = file?.data;
    if (!(data instanceof ArrayBuffer)) throw new Error("invalid file");
    // The bytes move out of the request, which Electron keeps until the answer: one copy, here.
    const ticket = saves.hold(event.sender.id, data);
    return saveHeld(saves, ticket, event.sender, safeFileName(file?.name));
  });
  // Unread activity on the dock (macOS, Linux) or the taskbar button (Windows).
  const dot = nativeImage.createFromBitmap(Buffer.from(dotBitmap(16, [10, 110, 92])), {
    width: 16,
    height: 16,
  });
  ipcMain.on("clawtrate:badge", (_event, raw: unknown) => {
    const count = parseBadgeCount(raw);
    if (count === null) return;
    applyUnreadBadge(
      {
        platform: process.platform,
        setBadgeCount: (value) => app.setBadgeCount(value),
        setOverlay: (icon, description) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.setOverlayIcon(icon ? dot : null, description);
          }
        },
      },
      count,
    );
  });
  batchSnapshots(client.store.subscribe, (state) => {
    // A snapshot can fire after the window closed, during quit for one.
    if (window && !window.isDestroyed()) window.webContents.send("clawtrate:state", state);
  });

  window = createWindow();
  if (process.env.CLAWTRATE_SCREENSHOT)
    void captureAndQuit(window, process.env.CLAWTRATE_SCREENSHOT);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || process.env.CLAWTRATE_SCREENSHOT) app.quit();
});

/**
 * Setting OpenClaw up is closed first, so that no dialog's answer or queued step starts
 * anything; then its downloads are aborted and every program it started, descendants too, is
 * ended. The quit waits, within one bound, for the operation and the install's groups, and
 * every quit asked while it waits is held too.
 */
const mayQuit = quitGate(
  () => {
    const operation = closeController();
    installStop.abort();
    const deadline = new Promise<void>((done) => setTimeout(done, INSTALL_QUIT_WAIT_MS));
    return Promise.race([
      Promise.all([operation, installPrograms.close(INSTALL_QUIT_WAIT_MS)]).then(() => {}),
      deadline,
    ]);
  },
  () => app.quit(),
);

/** Set once setup's programs and their workers are gone: quitting then goes ahead. */
let programsEnded = false;
app.on("before-quit", (event) => {
  if (!mayQuit(event)) return;
  // The programs setup started, and the workers in their groups, end before the app does:
  // quitting waits for them (killed after their grace), then quits again.
  if (!programsEnded && programs.running().length + programs.groupsLeft() > 0) {
    event.preventDefault();
    void programs.stopAllAndWait().finally(() => {
      programsEnded = true;
      app.quit();
    });
    return;
  }
  void closeSetup();
  runtime?.client.stop();
});

// One app per data folder: a second launch focuses the running window and exits.
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  void main();
} else {
  app.quit();
}
