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
  nativeTheme,
  session,
  shell,
  type WebContents,
} from "electron";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyUnreadBadge, dotBitmap, parseBadgeCount } from "./badge.ts";
import { startDesktopUpdates } from "./update/build-info.ts";
import { createUpdatePreferenceStore } from "./update/preferences.ts";
import { windowsAppUserModelId } from "./identity.ts";
import {
  safeFileName,
  writeExactly,
  writeInFolder,
  type FolderSaveResult,
  type SaveResult,
} from "./save.ts";
import {
  readDevConnection,
  selectInstance,
  startHostRuntime,
  type HostRuntime,
} from "../host/runtime.ts";

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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: "Clawtrate",
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0e14" : "#f4f5f2",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
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
  const dir = process.env.CLAWTRATE_DATA_DIR ?? join(app.getPath("userData"), "gateway");
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

  const devInstance = selectInstance(undefined, process.env);
  runtime = await startHostRuntime({
    kind: "desktop",
    displayName: "Clawtrate Desktop",
    dataDir: privateDataDir(),
    // Only development builds look for the local development gateway.
    // CLAWTRATE_DEV_INSTANCE selects a named development instance. Its address
    // is opened only while this checkout can still prove it, before every attempt.
    devGateway: app.isPackaged ? null : readDevConnection(REPO_ROOT, { instance: devInstance }),
    recheckDevGateway: () => readDevConnection(REPO_ROOT, { instance: devInstance }),
    autoConnectDev: process.env.CLAWTRATE_AUTOCONNECT_DEV === "1",
  });
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
  app.on("before-quit", () => updates.shutdown());
  ipcMain.handle("clawtrate:update:get", () => updates.get());
  ipcMain.handle("clawtrate:update:check", (_event, track: unknown, revision: unknown) =>
    updates.check(track, revision),
  );
  ipcMain.handle("clawtrate:update:track", (_event, track: unknown) => updates.chooseTrack(track));
  ipcMain.handle("clawtrate:update:download", (_event, id: unknown) => updates.download(id));

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
  // Download all (work-pane.md, section 12): one folder, chosen once in the system's folder
  // dialog, starting in Downloads, and each item written there as a new file. The folder's path
  // stays here; the page gets a number for it, one per window, which the next choice replaces.
  const folders = new Map<number, { ticket: number; path: string }>();
  let nextFolder = 0;
  ipcMain.handle("clawtrate:chooseFolder", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      defaultPath: app.getPath("downloads"),
      buttonLabel: "Save here",
      properties: ["openDirectory", "createDirectory"] as Array<
        "openDirectory" | "createDirectory"
      >,
    };
    const chosen = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const path = chosen.filePaths[0];
    if (chosen.canceled || !path) return { status: "cancelled" };
    nextFolder += 1;
    folders.set(event.sender.id, { ticket: nextFolder, path });
    event.sender.once("destroyed", () => folders.delete(event.sender.id));
    return { status: "chosen", folder: nextFolder, name: basename(path) };
  });
  ipcMain.handle(
    "clawtrate:saveInFolder",
    async (event, raw: unknown): Promise<FolderSaveResult> => {
      const file = raw as { folder?: unknown; name?: unknown; data?: unknown } | null;
      const data = file?.data;
      const chosen = folders.get(event.sender.id);
      if (!(data instanceof ArrayBuffer)) throw new Error("invalid file");
      if (!chosen || chosen.ticket !== file?.folder)
        throw new Error("No folder was chosen for this.");
      // The same bound as a dialog's save: no more than a reader sends, one at a time.
      const ticket = saves.hold(event.sender.id, data);
      try {
        return await writeInFolder(
          { readFile, writeFile, rm },
          chosen.path,
          file?.name,
          new Uint8Array(saves.get(ticket)!),
        );
      } finally {
        saves.release(ticket);
      }
    },
  );
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

app.on("before-quit", () => runtime?.client.stop());

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
