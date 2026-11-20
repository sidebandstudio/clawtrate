// F-319: a download saves exactly the bytes the reader supplied, and a failed
// write is read back before anything is said about the file that was there.
// The main process's own `save` handler runs here as the app registers it,
// with Electron's modules replaced: what a page hands it is written exactly,
// and it holds no more than a reader sends, for one dialog at a time.
import { MAX_SAVE_BYTES } from "@clawtrate/core";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  diskFolderFs,
  safeFileName,
  writeExactly,
  writeInFolder,
  type FolderFs,
  type SaveFs,
} from "../src/main/save.ts";

type Chosen = { canceled: boolean; filePath?: string };
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
  dialogs: [] as Array<{ options: { defaultPath: string }; answer: (chosen: Chosen) => void }>,
  folderDialogs: [] as Array<{
    options: { defaultPath: string; properties: string[] };
    answer: (chosen: { canceled: boolean; filePaths: string[] }) => void;
  }>,
  appDir: "",
}));
vi.mock("electron", () => {
  const app = {
    setName() {},
    enableSandbox() {},
    getVersion: () => "1.0.0",
    getAppPath: () => electron.appDir,
    getPath: () => electron.appDir,
    whenReady: async () => {},
    isPackaged: true,
    on() {},
    quit() {},
    requestSingleInstanceLock: () => true,
    setBadgeCount() {},
  };
  class BrowserWindow {
    static getAllWindows = () => [];
    static fromWebContents = () => null;
    webContents = { send() {}, isDestroyed: () => false };
    on() {}
    once() {}
    loadFile() {}
    loadURL() {}
    isDestroyed = () => false;
  }
  return {
    app,
    BrowserWindow,
    dialog: {
      showSaveDialog: (options: { defaultPath: string }) =>
        new Promise<Chosen>((answer) => electron.dialogs.push({ options, answer })),
      showOpenDialog: (options: { defaultPath: string; properties: string[] }) =>
        new Promise<{ canceled: boolean; filePaths: string[] }>((answer) =>
          electron.folderDialogs.push({ options, answer }),
        ),
    },
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) =>
        electron.handlers.set(channel, fn),
      on() {},
    },
    nativeImage: { createFromBitmap: () => ({}) },
    nativeTheme: { shouldUseDarkColors: false },
    session: {
      defaultSession: {
        webRequest: { onBeforeRequest() {} },
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
      },
    },
    shell: { openExternal() {} },
  };
});
vi.mock("../src/host/runtime.ts", () => ({
  readDevConnection: () => null,
  selectInstance: () => undefined,
  startHostRuntime: async () => ({
    client: { state: {}, store: { subscribe: () => () => {} }, stop() {} },
    info: {},
    policy: {},
  }),
}));

const real: SaveFs = { readFile, writeFile, rename, rm, stat };
const dirs: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-save-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 37 + 11) & 255);

describe("saving a file the Work pane holds", () => {
  it("F-319: writes exactly the bytes, under the chosen name, over an earlier file too", async () => {
    const dir = folder();
    const target = join(dir, "usage.png");
    writeFileSync(target, "older bytes");
    expect(await writeExactly(real, target, bytes)).toEqual({ status: "saved", name: "usage.png" });
    expect(new Uint8Array(readFileSync(target))).toEqual(bytes);
  });

  it("F-319: a failed write that left the earlier file says it is unchanged only after reading it back", async () => {
    const dir = folder();
    const target = join(dir, "notes.md");
    writeFileSync(target, "earlier");
    const failing: SaveFs = { ...real, rename: async () => Promise.reject(new Error("disk full")) };
    expect(await writeExactly(failing, target, bytes)).toEqual({
      status: "failed",
      message: "disk full",
      target: "unchanged",
    });
    expect(readFileSync(target, "utf8")).toBe("earlier");
  });

  it("F-319: a write that failed and left something else says it may be incomplete", async () => {
    const dir = folder();
    const target = join(dir, "notes.md");
    writeFileSync(target, "earlier");
    const partial: SaveFs = {
      ...real,
      rename: async () => {
        writeFileSync(target, "half");
        throw new Error("interrupted");
      },
    };
    expect(await writeExactly(partial, target, bytes)).toMatchObject({
      status: "failed",
      target: "unknown",
    });
  });

  it("F-319: nothing there before and nothing after is said as nothing saved", async () => {
    const dir = folder();
    const failing: SaveFs = {
      ...real,
      writeFile: async () => Promise.reject(new Error("read-only")),
    };
    expect(await writeExactly(failing, join(dir, "a.md"), bytes)).toMatchObject({
      status: "failed",
      target: "absent",
    });
  });

  it("offers a plain file name, never a folder", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a\u0000b:c.md")).toBe("a_b_c.md");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName(42)).toBe("file");
  });
});

describe("saving several items into one folder", () => {
  const into = diskFolderFs;

  it("F-304: writes each item's exact bytes as a new file in the folder, and never over a file that is there", async () => {
    const dir = folder();
    writeFileSync(join(dir, "usage.png"), "the person's own file");
    const picture = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
    const note = new TextEncoder().encode("# Note\n");
    expect(await writeInFolder(into, dir, "usage.png", picture)).toEqual({
      status: "saved",
      name: "usage (2).png",
    });
    expect(await writeInFolder(into, dir, "note.md", note)).toEqual({
      status: "saved",
      name: "note.md",
    });
    expect(readFileSync(join(dir, "usage.png"), "utf8")).toBe("the person's own file");
    expect(new Uint8Array(readFileSync(join(dir, "usage (2).png")))).toEqual(picture);
    expect(new Uint8Array(readFileSync(join(dir, "note.md")))).toEqual(note);
  });

  it("F-304: a name a bot supplied never writes outside the chosen folder", async () => {
    const parent = folder();
    const dir = join(parent, "chosen");
    mkdirSync(dir);
    for (const name of [
      "../escape.md",
      "../../escape.md",
      "/tmp/escape.md",
      "sub/escape.md",
      "..\\escape.md",
      "..",
    ])
      expect(await writeInFolder(into, dir, name, Uint8Array.from([1]))).toMatchObject({
        status: "saved",
      });
    expect(readdirSync(parent)).toEqual(["chosen"]);
    expect(readdirSync(dir).sort()).toEqual(
      [
        "escape (2).md",
        "escape (3).md",
        "escape (4).md",
        "escape (5).md",
        "escape.md",
        "file",
      ].sort(),
    );
  });

  it("F-304: a write that fails, or reads back different bytes, is said as failed and leaves nothing", async () => {
    const dir = folder();
    /** The disk's operations, with the file this save opened changed by `change`. */
    const opened = (change: (file: Awaited<ReturnType<FolderFs["open"]>>) => object): FolderFs => ({
      ...into,
      open: async (...args) => {
        const file = await into.open(...args);
        return { ...file, ...change(file) };
      },
    });
    const full = opened(() => ({ write: async () => Promise.reject(new Error("disk full")) }));
    expect(await writeInFolder(full, dir, "a.md", Uint8Array.from([1]))).toEqual({
      status: "failed",
      name: "a.md",
      message: "disk full",
    });
    const changed = opened(() => ({ read: async () => Uint8Array.from([9]) }));
    expect(await writeInFolder(changed, dir, "b.md", Uint8Array.from([1]))).toEqual({
      status: "failed",
      name: "b.md",
      message: "The saved file does not hold the same bytes.",
    });
    expect(readdirSync(dir)).toEqual([]);
    // A file that took the name after this save created its own is left where it is.
    const replaced = opened(() => ({
      read: async () => {
        rmSync(join(dir, "c.md"));
        writeFileSync(join(dir, "c.md"), "someone else's");
        return Uint8Array.from([9]);
      },
    }));
    expect(await writeInFolder(replaced, dir, "c.md", Uint8Array.from([1]))).toMatchObject({
      status: "failed",
    });
    expect(readFileSync(join(dir, "c.md"), "utf8")).toBe("someone else's");
  });

  it("F-304: an exclusive open that fails leaves the existing file alone", async () => {
    const dir = folder();
    writeFileSync(join(dir, "report.md"), "the person's own report");
    const removed: string[] = [];
    const denied: FolderFs = {
      ...into,
      open: async () =>
        Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" })),
      rm: async (path, options) => {
        removed.push(path);
        await into.rm(path, options);
      },
    };
    expect(await writeInFolder(denied, dir, "report.md", Uint8Array.from([1]))).toEqual({
      status: "failed",
      name: "report.md",
      message: "permission denied",
    });
    expect(removed).toEqual([]);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("the person's own report");
    expect(readdirSync(dir)).toEqual(["report.md"]);
  });
});

describe("the main process's save handler", () => {
  let id = 0;
  /** A window's page, as the handler sees its sender. */
  const page = () => Object.assign(new EventEmitter(), { id: (id += 1) });
  const save = (sender: EventEmitter, name: string, data: unknown) =>
    Promise.resolve().then(
      () =>
        electron.handlers.get("clawtrate:save")!({ sender }, { name, data }) as Promise<unknown>,
    );
  const dialogOpened = () => vi.waitFor(() => expect(electron.dialogs.length).toBe(1));
  const answer = (chosen: Chosen) => electron.dialogs.shift()!.answer(chosen);
  /** A byte of every value, a byte-order mark and a long pattern: what a reader may supply. */
  const supplied = () =>
    Uint8Array.from([
      ...Array.from({ length: 256 }, (_, i) => i),
      239,
      187,
      191,
      ...Array.from({ length: 70_000 }, (_, i) => (i * 37 + 11) & 255),
    ]);

  beforeAll(async () => {
    electron.appDir = folder();
    process.env.CLAWTRATE_DATA_DIR = join(electron.appDir, "gateway");
    await import("../src/main/index.ts");
    await vi.waitFor(() => expect(electron.handlers.has("clawtrate:save")).toBe(true));
  });
  afterEach(() => {
    while (electron.dialogs.length) answer({ canceled: true });
    while (electron.folderDialogs.length)
      electron.folderDialogs.shift()!.answer({ canceled: true, filePaths: [] });
  });

  it("F-304: Download all asks for one folder once, writes each item there with its bytes, and says each as it is on disk", async () => {
    const sender = page();
    const call = (channel: string, raw?: unknown) =>
      Promise.resolve().then(
        () => electron.handlers.get(channel)!({ sender }, raw) as Promise<unknown>,
      );
    const dir = folder();
    writeFileSync(join(dir, "b.bin"), "already here");
    const chosen = call("clawtrate:chooseFolder");
    await vi.waitFor(() => expect(electron.folderDialogs).toHaveLength(1));
    expect(electron.folderDialogs[0]!.options.properties).toContain("openDirectory");
    expect(electron.folderDialogs[0]!.options.defaultPath).toBe(electron.appDir);
    electron.folderDialogs.shift()!.answer({ canceled: false, filePaths: [dir] });
    const choice = (await chosen) as { status: string; folder: number; name: string };
    expect(choice).toMatchObject({ status: "chosen", name: basename(dir) });
    const items = [
      { name: "a.bin", data: Uint8Array.from([1, 2, 3]) },
      { name: "b.bin", data: Uint8Array.from([4, 5]) },
      { name: "../c.bin", data: supplied() },
    ];
    const results = [];
    for (const item of items)
      results.push(
        await call("clawtrate:saveInFolder", {
          folder: choice.folder,
          name: item.name,
          data: item.data.slice().buffer,
        }),
      );
    // One dialog for all of them, and none of the save dialog's.
    expect(electron.folderDialogs).toHaveLength(0);
    expect(electron.dialogs).toHaveLength(0);
    expect(results).toEqual([
      { status: "saved", name: "a.bin" },
      { status: "saved", name: "b (2).bin" },
      { status: "saved", name: "c.bin" },
    ]);
    expect(new Uint8Array(readFileSync(join(dir, "a.bin")))).toEqual(items[0]!.data);
    expect(readFileSync(join(dir, "b.bin"), "utf8")).toBe("already here");
    expect(new Uint8Array(readFileSync(join(dir, "b (2).bin")))).toEqual(items[1]!.data);
    expect(readFileSync(join(dir, "c.bin")).equals(supplied())).toBe(true);
    // Another window has no folder, and a folder number it did not get writes nothing.
    await expect(
      Promise.resolve().then(() =>
        electron.handlers.get("clawtrate:saveInFolder")!(
          { sender: page() },
          { folder: choice.folder, name: "d.bin", data: new ArrayBuffer(1) },
        ),
      ),
    ).rejects.toThrow(/No folder was chosen/);
    expect(existsSync(join(dir, "d.bin"))).toBe(false);
  });

  it("F-304: a mixed native batch reports each file it wrote and the failure", async () => {
    const sender = page();
    const call = (channel: string, raw?: unknown) =>
      Promise.resolve().then(
        () => electron.handlers.get(channel)!({ sender }, raw) as Promise<unknown>,
      );
    const dir = folder();
    // Every name the chime could take is the person's already.
    const taken = ["chime.wav", ...Array.from({ length: 98 }, (_, i) => `chime (${i + 2}).wav`)];
    for (const name of taken) writeFileSync(join(dir, name), `kept ${name}`);
    const chosen = call("clawtrate:chooseFolder");
    await vi.waitFor(() => expect(electron.folderDialogs).toHaveLength(1));
    electron.folderDialogs.shift()!.answer({ canceled: false, filePaths: [dir] });
    const choice = (await chosen) as { folder: number };
    const items = [
      { name: "photo.png", data: Uint8Array.from([137, 80, 78, 71, 9]) },
      { name: "chime.wav", data: Uint8Array.from([82, 73, 70, 70]) },
      { name: "notes/report.md", data: new TextEncoder().encode("# Report\n") },
    ];
    const results = [];
    for (const item of items)
      results.push(
        await call("clawtrate:saveInFolder", {
          folder: choice.folder,
          name: item.name,
          data: item.data.slice().buffer,
        }),
      );
    expect(results).toEqual([
      { status: "saved", name: "photo.png" },
      {
        status: "failed",
        name: "chime.wav",
        message: "Every name like it is taken in this folder.",
      },
      { status: "saved", name: "report.md" },
    ]);
    expect(new Uint8Array(readFileSync(join(dir, "photo.png")))).toEqual(items[0]!.data);
    expect(new Uint8Array(readFileSync(join(dir, "report.md")))).toEqual(items[2]!.data);
    for (const name of taken) expect(readFileSync(join(dir, name), "utf8")).toBe(`kept ${name}`);
    expect(readdirSync(dir)).toHaveLength(taken.length + 2);
  });

  it("F-304: a cancelled folder dialog writes nothing", async () => {
    const sender = page();
    const chosen = Promise.resolve().then(() =>
      electron.handlers.get("clawtrate:chooseFolder")!({ sender }, undefined),
    );
    await vi.waitFor(() => expect(electron.folderDialogs).toHaveLength(1));
    electron.folderDialogs.shift()!.answer({ canceled: true, filePaths: [] });
    expect(await chosen).toEqual({ status: "cancelled" });
  });

  it("F-319: writes exactly the bytes the page handed over, where the dialog chose", async () => {
    const dir = folder();
    const bytes = supplied();
    const pending = save(page(), "../usage.png", bytes.slice().buffer);
    await dialogOpened();
    expect(electron.dialogs[0]!.options.defaultPath).toBe(join(electron.appDir, "usage.png"));
    answer({ canceled: false, filePath: join(dir, "chosen.png") });
    expect(await pending).toEqual({ status: "saved", name: "chosen.png" });
    expect(readFileSync(join(dir, "chosen.png")).equals(bytes)).toBe(true);
  });

  it("F-319: refuses more than the largest content a reader sends, before any dialog", async () => {
    await expect(save(page(), "big.bin", new ArrayBuffer(MAX_SAVE_BYTES + 1))).rejects.toThrow(
      /more than any of the gateway's readers sends/,
    );
    expect(electron.dialogs).toHaveLength(0);
  });

  it("F-319: holds the bytes once, for one dialog at a time; a cancelled dialog releases them", async () => {
    const one = page();
    const handed = new ArrayBuffer(MAX_SAVE_BYTES);
    const first = save(one, "a.bin", handed);
    await dialogOpened();
    // Moved out of the request: the handler's copy is the only one.
    expect(handed.byteLength).toBe(0);
    await expect(save(one, "b.bin", new ArrayBuffer(1))).rejects.toThrow(/waiting to be saved/);
    await expect(save(page(), "c.bin", new ArrayBuffer(1))).rejects.toThrow(/waiting to be saved/);
    expect(electron.dialogs).toHaveLength(1);
    answer({ canceled: true });
    expect(await first).toEqual({ status: "cancelled" });
    const again = save(one, "d.bin", new ArrayBuffer(1));
    await dialogOpened();
    answer({ canceled: true });
    expect(await again).toEqual({ status: "cancelled" });
  });

  it("F-319: a failed write releases the bytes", async () => {
    const one = page();
    const failed = save(one, "a.bin", new ArrayBuffer(3));
    await dialogOpened();
    answer({ canceled: false, filePath: join(folder(), "missing", "a.bin") });
    expect(await failed).toMatchObject({ status: "failed", target: "absent" });
    const again = save(one, "b.bin", new ArrayBuffer(1));
    await dialogOpened();
    answer({ canceled: true });
    await again;
  });

  it("F-319: a page reloaded while its dialog is open never has the next page's bytes written there", async () => {
    const sender = page();
    const before = save(sender, "old.bin", Uint8Array.from([1, 1, 1]).buffer);
    await dialogOpened();
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    // The same window's next page saves while the old dialog is still open.
    const after = save(sender, "new.bin", Uint8Array.from([2, 2]).buffer);
    await vi.waitFor(() => expect(electron.dialogs).toHaveLength(2));
    const dir = folder();
    answer({ canceled: false, filePath: join(dir, "old.bin") });
    expect(await before).toEqual({ status: "cancelled" });
    expect(existsSync(join(dir, "old.bin"))).toBe(false);
    answer({ canceled: false, filePath: join(dir, "new.bin") });
    expect(await after).toEqual({ status: "saved", name: "new.bin" });
    expect([...readFileSync(join(dir, "new.bin"))]).toEqual([2, 2]);
  });

  it("F-319: a window or page that goes while its dialog is open has its bytes dropped and nothing written", async () => {
    for (const goes of [
      (sender: EventEmitter) => sender.emit("destroyed"),
      (sender: EventEmitter) => sender.emit("render-process-gone"),
      (sender: EventEmitter) =>
        sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }),
    ]) {
      const sender = page();
      const pending = save(sender, "a.bin", new ArrayBuffer(8));
      await dialogOpened();
      goes(sender);
      // Released at once: another page may save while that dialog is still open.
      const other = save(page(), "b.bin", new ArrayBuffer(1));
      await vi.waitFor(() => expect(electron.dialogs).toHaveLength(2));
      const target = join(folder(), "a.bin");
      answer({ canceled: false, filePath: target });
      expect(await pending).toEqual({ status: "cancelled" });
      expect(existsSync(target)).toBe(false);
      answer({ canceled: true });
      await other;
    }
  });
});
