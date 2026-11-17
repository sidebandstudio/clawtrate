// Electron main process: hosts the core client and serves state to the renderer over IPC.

import {
  batchSnapshots,
  createBridgeSession,
  type BridgeSession,
  parseBridgeCommand,
  type ClawtrateState,
  type HostInfo,
} from "@clawtrate/core";
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDevConnection, startHostRuntime, type HostRuntime } from "../host/runtime.ts";

app.setName("Clawtrate");

const APP_ROOT = app.getAppPath();
const REPO_ROOT = join(APP_ROOT, "../..");
const RESOURCES = join(APP_ROOT, "resources");

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

  // Links from transcripts open in the system browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => {
    if (!process.env.CLAWTRATE_SCREENSHOT) win.show();
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
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

async function main(): Promise<void> {
  await app.whenReady();
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(join(RESOURCES, "icon-mac.png"));
  }

  runtime = await startHostRuntime({
    kind: "desktop",
    displayName: "Clawtrate Desktop",
    dataDir: process.env.CLAWTRATE_DATA_DIR ?? join(app.getPath("userData"), "gateway"),
    // Only development builds look for the local development gateway.
    devGateway: app.isPackaged ? null : readDevConnection(REPO_ROOT),
    autoConnectDev: process.env.CLAWTRATE_AUTOCONNECT_DEV === "1",
  });
  const { client, info, policy } = runtime;

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
  batchSnapshots(client.store.subscribe, (state) => {
    window?.webContents.send("clawtrate:state", state);
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

void main();
