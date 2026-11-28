// The main process's startup with Electron replaced by a recorder: a packaged
// Windows app gives itself the bundle id as its AppUserModelID before it
// creates any window, so its taskbar button is the installer's shortcuts'
// from the first window on. Other platforms and development builds do not.
// No build registers itself for Clawtrate links, and a link the app is given
// reaches only its window, as validated values or as invalid.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_ID } from "../src/main/identity.ts";
import type * as Sandbox from "../src/setup/sandbox.ts";

type Listener = (...args: unknown[]) => unknown;
/** A frame as the main process sees it: the page it shows, and whether it left the window. */
type FakeFrame = { url: string; detached: boolean };
type FakeContents = {
  mainFrame: FakeFrame;
  emit(name: string, ...args: unknown[]): void;
};
type FakeWindow = {
  webContents: FakeContents;
  minimized: boolean;
  closed: boolean;
  listeners: Map<string, Listener>;
};

const recorded = vi.hoisted(() => ({
  calls: [] as string[],
  packaged: true,
  /** The data folders a refused start under the test runner chose. */
  userData: [] as string[],
  /** What the app listens for, the IPC it answers, and the windows it made. */
  events: new Map<string, Listener[]>(),
  handlers: new Map<string, Listener>(),
  windows: [] as FakeWindow[],
  ready: Promise.resolve(),
  /** Each read and write of the host runtime, its client and its policy. */
  runtimeUse: [] as string[],
  /** The switches that mark a driven app which the launch gave setup, by the app's own check. */
  switchesGiven: [] as string[],
  /** The switches Chromium itself reports (`app.commandLine.hasSwitch`), in any of its forms. */
  chromiumSwitches: [] as string[],
  /** What each window was told to load, in order: `loadURL <url>` or `loadFile <path>`. */
  loads: [] as string[],
  /** Why the host runtime fails to start, when a test says it does. */
  startError: null as Error | null,
  /** The arguments of each relaunch asked for. */
  relaunches: [] as (string[] | undefined)[],
}));

vi.mock("../src/setup/sandbox.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Sandbox>();
  const { SANDBOX_SWITCHES } = await import("../src/setup/world.ts");
  return {
    ...actual,
    resolveSetupLaunch: (options: Parameters<typeof actual.resolveSetupLaunch>[0]) => {
      recorded.switchesGiven = SANDBOX_SWITCHES.filter((name) => options.switches(name));
      return actual.resolveSetupLaunch(options);
    },
  };
});

vi.mock("electron", () => {
  const { calls } = recorded;
  class BrowserWindow {
    static getAllWindows = () => [];
    static fromWebContents = () => null;
    minimized = false;
    closed = false;
    listeners = new Map<string, Listener>();
    webContents = {
      mainFrame: { url: "about:blank", detached: false },
      heard: new Map<string, Listener[]>(),
      send: (channel: string, ...data: unknown[]) =>
        calls.push(`send ${channel}${data.length > 0 ? " with data" : ""}`),
      on(name: string, listener: Listener) {
        this.heard.set(name, [...(this.heard.get(name) ?? []), listener]);
        return this;
      },
      setWindowOpenHandler() {},
      emit(name: string, ...args: unknown[]) {
        for (const listener of this.heard.get(name) ?? []) listener(...args);
      },
    };
    constructor() {
      calls.push("window");
      recorded.windows.push(this);
      // As Electron tells the app of each web contents it makes, the window's too.
      for (const listener of recorded.events.get("web-contents-created") ?? [])
        listener({}, this.webContents);
    }
    on(name: string, listener: Listener) {
      this.listeners.set(name, listener);
      return this;
    }
    once() {
      return this;
    }
    isDestroyed() {
      return this.closed;
    }
    isMinimized() {
      return this.minimized;
    }
    restore() {
      calls.push("restore");
    }
    show() {
      calls.push("show");
    }
    focus() {
      calls.push("focus");
    }
    loadFile(path: string) {
      recorded.loads.push(`loadFile ${path}`);
      return this.loadURL(pathToFileURL(path).href);
    }
    loadURL(url: string) {
      recorded.loads.push(`loadURL ${url}`);
      // An address that isn't a URL loads nothing: the frame stays blank, and nothing commits.
      const href = URL.parse(url)?.href;
      if (href === undefined) return Promise.resolve();
      this.webContents.mainFrame.url = href;
      this.webContents.emit("did-navigate", {}, href, -1, "");
      return Promise.resolve();
    }
  }
  const app = {
    get isPackaged() {
      return recorded.packaged;
    },
    setName: () => calls.push("setName"),
    enableSandbox: () => calls.push("enableSandbox"),
    setAppUserModelId: (id: string) => calls.push(`setAppUserModelId ${id}`),
    setAsDefaultProtocolClient: (scheme: string) =>
      calls.push(`setAsDefaultProtocolClient ${scheme}`),
    getAppPath: () => "/app",
    getVersion: () => "1.0.0",
    getPath: () => dataDir,
    setPath: (_name: string, path: string) => recorded.userData.push(path),
    whenReady: () => recorded.ready,
    on(name: string, listener: Listener) {
      recorded.events.set(name, [...(recorded.events.get(name) ?? []), listener]);
      return app;
    },
    requestSingleInstanceLock: () => true,
    quit() {},
    exit: (code: number) => calls.push(`exit ${code}`),
    relaunch: (options?: { args?: string[] }) => recorded.relaunches.push(options?.args),
    setBadgeCount() {},
    commandLine: {
      hasSwitch: (name: string) => recorded.chromiumSwitches.includes(name),
      getSwitchValue: () => "",
    },
  };
  return {
    app,
    BrowserWindow,
    // The recovery dialog's first button: start fresh, keeping the old files.
    dialog: { showMessageBoxSync: () => 0, showErrorBox() {} },
    ipcMain: {
      handle: (channel: string, handler: Listener) => recorded.handlers.set(channel, handler),
      on() {},
    },
    nativeImage: { createFromBitmap: () => ({}) },
    nativeTheme: { shouldUseDarkColors: false },
    session: {
      defaultSession: {
        setSpellCheckerLanguages() {},
        webRequest: { onBeforeRequest() {} },
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
      },
    },
    shell: {},
  };
});

// The gateway client is not what this test is about: a runtime that holds nothing,
// and records each use of itself, its client and its policy.
vi.mock("../src/host/runtime.ts", () => {
  const watched = <T extends object>(name: string, target: T): T =>
    new Proxy(target, {
      get(object, key, receiver) {
        recorded.runtimeUse.push(`${name}.${String(key)}`);
        return Reflect.get(object, key, receiver);
      },
      set(object, key, value, receiver) {
        recorded.runtimeUse.push(`${name}.${String(key)} =`);
        return Reflect.set(object, key, value, receiver);
      },
    });
  return {
    selectInstance: () => null,
    readDevConnection: () => null,
    startHostRuntime: () =>
      recorded.startError
        ? Promise.reject(recorded.startError)
        : Promise.resolve(
            watched("runtime", {
              client: watched("client", {
                state: {},
                store: { subscribe: () => () => {} },
                stop() {},
                setSetup() {},
              }),
              info: {},
              policy: watched("policy", {}),
            }),
          ),
  };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let dataDir: string;

beforeEach(() => {
  recorded.calls.length = 0;
  recorded.events.clear();
  recorded.handlers.clear();
  recorded.windows.length = 0;
  recorded.ready = Promise.resolve();
  recorded.runtimeUse.length = 0;
  recorded.chromiumSwitches.length = 0;
  recorded.loads.length = 0;
  recorded.startError = null;
  recorded.relaunches.length = 0;
  dataDir = mkdtempSync(join(tmpdir(), "clawtrate-startup-"));
  vi.stubEnv("CLAWTRATE_DATA_DIR", dataDir);
  vi.stubEnv("CLAWTRATE_SCREENSHOT", "");
  vi.resetModules();
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
  for (const dir of recorded.userData.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the main process's startup as `os`, packaged or not, until it has created its window. */
async function startUp(os: NodeJS.Platform, packaged: boolean): Promise<string[]> {
  Object.defineProperty(process, "platform", { ...platform, value: os });
  recorded.packaged = packaged;
  await import("../src/main/index.ts");
  await vi.waitFor(() => expect(recorded.calls).toContain("window"));
  return [...recorded.calls];
}

describe("the AppUserModelID at startup", () => {
  it("is the bundle id in a packaged Windows app, set before any window is created", async () => {
    const calls = await startUp("win32", true);
    const set = calls.indexOf(`setAppUserModelId ${APP_ID}`);
    expect(set).toBeGreaterThanOrEqual(0);
    expect(set).toBeLessThan(calls.indexOf("window"));
    expect(calls.filter((call) => call.startsWith("setAppUserModelId"))).toHaveLength(1);
  });

  it("is left to Electron in a development build on Windows", async () => {
    const calls = await startUp("win32", false);
    expect(calls.some((call) => call.startsWith("setAppUserModelId"))).toBe(false);
  });

  it("is not set on macOS or Linux", async () => {
    for (const os of ["darwin", "linux"] as const) {
      recorded.calls.length = 0;
      vi.resetModules();
      const calls = await startUp(os, true);
      expect(calls.some((call) => call.startsWith("setAppUserModelId"))).toBe(false);
    }
  });
});

const GATEWAY = "ab".repeat(32);
const link = (text: string) => `clawtrate://chat?bot=marlow&gateway=${GATEWAY}&text=${text}`;
const valid = (id: number, text: string) => ({
  id,
  status: "valid",
  link: { bot: "marlow", gateway: GATEWAY, text },
});

/** Each listener the app gave for `name`, called with these arguments. */
function emit(name: string, ...args: unknown[]): void {
  for (const listener of recorded.events.get(name) ?? []) listener(...args);
}

/** What a caller gets when it asks the main process for the waiting link, from these contents and frame. */
function take(sender: object, senderFrame: FakeFrame | null): unknown {
  return recorded.handlers.get("clawtrate:link:take")!({ sender, senderFrame });
}

/** The ask of the page in this window's top frame. */
const fromPage = (window: FakeWindow) => take(window.webContents, window.webContents.mainFrame);

/**
 * The window's top frame commits a new document at `url`, as a navigation does: in the same
 * frame, or in a new one that takes its place while the old one is left `detached` or not.
 */
function commit(window: FakeWindow, url: string, frame?: { detachOld: boolean }): FakeFrame {
  const old = window.webContents.mainFrame;
  if (frame) {
    old.detached = frame.detachOld;
    window.webContents.mainFrame = { url, detached: false };
  }
  window.webContents.mainFrame.url = url;
  window.webContents.emit("did-navigate", {}, url, -1, "");
  return old;
}

/** The page changes its own address, as `history.pushState` does: no new document commits. */
function moveWithin(window: FakeWindow, url: string): void {
  window.webContents.mainFrame.url = url;
  window.webContents.emit("did-navigate-in-page", {}, url, true, 1, 1);
}

/** The renderer's page, as the main process names it: `apps/desktop/src/renderer/index.html`. */
const PAGE = pathToFileURL(join(import.meta.dirname, "../src/renderer/index.html")).href;

/** The ask of this window's top frame while it shows `url`, which it then leaves again. */
function fromUrl(window: FakeWindow, url: string): unknown {
  const frame = window.webContents.mainFrame;
  const page = frame.url;
  frame.url = url;
  try {
    return fromPage(window);
  } finally {
    frame.url = page;
  }
}

/** A start as `os`, packaged unless said, launched with these arguments, until its window exists. */
async function startWith(
  os: NodeJS.Platform,
  args: string[],
  packaged = true,
): Promise<FakeWindow> {
  const argv = process.argv;
  process.argv = ["C:/app/Clawtrate.exe", ...args];
  try {
    await startUp(os, packaged);
  } finally {
    process.argv = argv;
  }
  return recorded.windows[0]!;
}

describe("Clawtrate links at startup", () => {
  it("F-248: no build registers itself for them", async () => {
    for (const [os, packaged] of [
      ["win32", true],
      ["linux", true],
      ["darwin", true],
      ["darwin", false],
      ["win32", false],
      ["linux", false],
    ] as const) {
      recorded.calls.length = 0;
      vi.resetModules();
      const calls = await startUp(os, packaged);
      expect(
        calls.some((call) => call.startsWith("setAsDefaultProtocolClient")),
        `${os}, packaged: ${packaged}`,
      ).toBe(false);
    }
  });

  it("F-248: what follows `--` gives the app no switch, so a split link can't make a launch automated", async () => {
    const split = ["--use-mock-keychain", "--remote-debugging-port=0", "--inspect"];
    await startWith("win32", ["--", link("Hi"), ...split, "--clawtrate-setup-sandbox=C:/x"]);
    expect(recorded.switchesGiven).toEqual([]);
    recorded.calls.length = 0;
    vi.resetModules();
    await startWith("win32", ["--use-mock-keychain", "--", link("Hi")]);
    expect(recorded.switchesGiven, "a switch before `--` still counts").toEqual([
      "use-mock-keychain",
    ]);
  });

  it("F-248: a switch Chromium reads in another form, such as one hyphen on Windows, still counts", async () => {
    // Only Chromium knows the forms it reads: the arguments give it no `--` form to find.
    await startWith("win32", ["-use-mock-keychain", "--", link("Hi")]);
    expect(recorded.switchesGiven, "nothing reports it").toEqual([]);
    recorded.calls.length = 0;
    vi.resetModules();
    recorded.chromiumSwitches.push("use-mock-keychain");
    await startWith("win32", ["-use-mock-keychain", "--", link("Hi")]);
    expect(recorded.switchesGiven, "Chromium reports it").toEqual(["use-mock-keychain"]);
  });

  it("F-248: the link a launch was given waits for the window, which alone takes it, once", async () => {
    const window = await startWith("win32", ["--allow-file-access-from-files", "--", link("Hi")]);
    expect(recorded.calls).not.toContain("send clawtrate:link");
    expect(fromPage(window)).toEqual(valid(1, "Hi"));
    expect(fromPage(window)).toBeNull();
  });

  it("F-248: only the window's current top frame on the page it loaded takes a link; any other caller leaves it", async () => {
    const window = await startWith("win32", ["--", link("Hi")]);
    const top = window.webContents.mainFrame;
    const page = top.url;
    expect(page.startsWith("file:") && page.endsWith("/renderer/index.html"), page).toBe(true);
    const refused: [string, unknown][] = [
      ["other contents", take({ mainFrame: top }, top)],
      ["a frame that navigated or closed", take(window.webContents, null)],
      ["another frame on the page", take(window.webContents, { url: page, detached: false })],
      ["another file beside the page", fromUrl(window, page.replace("index.html", "other.html"))],
      [
        "a file under the page's folder",
        fromUrl(window, page.replace("index.html", "x/index.html")),
      ],
      ["the page with a query", fromUrl(window, `${page}?theme=dark`)],
      ["a web page", fromUrl(window, "https://example.invalid/renderer/index.html")],
      ["no URL", fromUrl(window, "")],
    ];
    top.detached = true;
    refused.push(["a top frame no longer in the window", fromPage(window)]);
    top.detached = false;
    for (const [caller, answer] of refused) expect(answer, caller).toBeNull();
    // None of them took it: the page still does, also once it moved to a fragment of itself.
    expect(fromPage(window)).toEqual(valid(1, "Hi"));
    emit("second-instance", {}, ["C:/app/Clawtrate.exe", "--", link("Again")], "C:/");
    expect(fromUrl(window, `${page}#composer`)).toEqual(valid(2, "Again"));
    expect(fromPage(window)).toBeNull();
  });

  it("F-248: in development the page is the dev server's own, not another one it serves", async () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5199");
    const window = await startWith("win32", ["--", link("Dev")], false);
    const page = window.webContents.mainFrame.url;
    expect(page).toBe("http://localhost:5199/");
    for (const other of [
      "http://localhost:5199/other.html",
      "http://localhost:5199/?motion=reduce",
      "http://localhost:5200/",
      "http://127.0.0.1:5199/",
    ])
      expect(fromUrl(window, other), other).toBeNull();
    expect(fromPage(window)).toEqual(valid(1, "Dev"));
  });

  it("F-248: the page expected is the one the window loads, with the dev server address unset, empty or ignored", async () => {
    const cases: [string, string | undefined, boolean][] = [
      ["development, unset", undefined, false],
      ["development, empty", "", false],
      ["packaged, a dev server named", "http://localhost:5199", true],
    ];
    for (const [name, address, packaged] of cases) {
      recorded.calls.length = 0;
      recorded.windows.length = 0;
      vi.resetModules();
      vi.unstubAllEnvs();
      vi.stubEnv("CLAWTRATE_DATA_DIR", dataDir);
      vi.stubEnv("CLAWTRATE_SCREENSHOT", "");
      vi.stubEnv("ELECTRON_RENDERER_URL", address);
      const window = await startWith("win32", ["--", link("Here")], packaged);
      const page = window.webContents.mainFrame.url;
      expect(page.startsWith("file:") && page.endsWith("/renderer/index.html"), name).toBe(true);
      expect(fromUrl(window, "http://localhost:5199/"), name).toBeNull();
      expect(fromPage(window), name).toEqual(valid(1, "Here"));
    }
  });

  it("F-248: a dev server address that isn't a URL starts the app, and no page takes the link", async () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "not a url");
    const window = await startWith("win32", ["--", link("Kept")], false);
    expect(window.webContents.mainFrame.url).toBe("about:blank");
    expect(fromPage(window)).toBeNull();
    expect(fromUrl(window, "not a url")).toBeNull();
  });

  it("F-248: the page is loaded from the one file URL it is checked against, never by its path", async () => {
    for (const [name, address, packaged] of [
      ["packaged", undefined, true],
      ["development, the dev server address empty", "", false],
    ] as const) {
      recorded.calls.length = 0;
      recorded.windows.length = 0;
      recorded.loads.length = 0;
      vi.resetModules();
      vi.stubEnv("ELECTRON_RENDERER_URL", address);
      const window = await startWith("win32", ["--", link("Here")], packaged);
      expect(recorded.loads, name).toEqual([`loadURL ${PAGE}`]);
      expect(fromPage(window), name).toEqual(valid(1, "Here"));
    }
  });

  it("F-248: the app's page is the document its top frame committed: an address changed within a document makes none", async () => {
    const window = await startWith("win32", ["--", link("Hi")]);
    // Another document commits in the frame, then gives itself the page's address.
    commit(window, PAGE.replace("index.html", "other.html"));
    moveWithin(window, PAGE);
    expect(fromPage(window), "a document moved to the page's address").toBeNull();
    moveWithin(window, `${PAGE}#composer`);
    expect(fromPage(window)).toBeNull();
    // The page commits again. Moved elsewhere within itself, it takes nothing until it is back.
    commit(window, PAGE);
    moveWithin(window, `${PAGE}?theme=dark`);
    expect(fromPage(window), "the page at another address").toBeNull();
    moveWithin(window, PAGE.replace("index.html", "index.html/x"));
    expect(fromPage(window)).toBeNull();
    // None of those took the link: the page, back at its own address, a fragment aside, does.
    moveWithin(window, `${PAGE}#composer`);
    expect(fromPage(window)).toEqual(valid(1, "Hi"));
  });

  it("F-248: a frame the page left, or an error page in its place, takes nothing, and the link waits", async () => {
    const window = await startWith("win32", ["--", link("Hi")]);
    // The page commits again in a new frame; the frame it left asks, attached or not.
    const old = commit(window, PAGE, { detachOld: false });
    expect(take(window.webContents, old), "the frame the page left").toBeNull();
    old.detached = true;
    expect(take(window.webContents, old)).toBeNull();
    // An error page shown in the page's place commits no document of the app's.
    window.webContents.mainFrame.url = "chrome-error://chromewebdata/";
    expect(fromPage(window), "an error page").toBeNull();
    commit(window, PAGE);
    expect(fromPage(window)).toEqual(valid(1, "Hi"));
  });

  it("F-248: starting fresh relaunches with the launch's switches and app path, never its link or what was split off it", async () => {
    const cases: [string, string[], boolean, string[]][] = [
      [
        "packaged, a link Windows split",
        ["--allow-file-access-from-files", "-f248-one=1", "--", link("Hi"), "--use-mock-keychain"],
        true,
        ["--allow-file-access-from-files", "-f248-one=1"],
      ],
      [
        "development, the app's path",
        ["C:/repo/apps/desktop", "--f248-dev", "--", link("Hi"), "-x"],
        false,
        ["C:/repo/apps/desktop", "--f248-dev"],
      ],
      [
        "no link",
        ["--f248-only", "C:/repo/apps/desktop"],
        false,
        ["--f248-only", "C:/repo/apps/desktop"],
      ],
    ];
    for (const [name, args, packaged, kept] of cases) {
      recorded.calls.length = 0;
      recorded.events.clear();
      recorded.relaunches.length = 0;
      recorded.startError = Object.assign(new Error("A damaged record."), {
        name: "CredentialRecordInvalidError",
      });
      vi.resetModules();
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      recorded.packaged = packaged;
      const argv = process.argv;
      process.argv = ["C:/app/Clawtrate.exe", ...args];
      try {
        await import("../src/main/index.ts");
        await vi.waitFor(() => expect(recorded.relaunches).toHaveLength(1));
      } finally {
        process.argv = argv;
      }
      expect(recorded.relaunches[0], name).toEqual(kept);
      expect(recorded.calls, name).toContain("exit 0");
      expect(recorded.calls, name).not.toContain("window");
    }
  });

  it("F-248: a second launch brings the window forward and hands over its link, the latest only", async () => {
    const window = await startWith("win32", []);
    window.minimized = true;
    recorded.calls.length = 0;
    recorded.runtimeUse.length = 0;
    emit("second-instance", {}, ["C:/app/Clawtrate.exe"], "C:/");
    expect(recorded.calls, "without a link it only comes forward").toEqual([
      "restore",
      "show",
      "focus",
    ]);
    recorded.calls.length = 0;
    emit("second-instance", {}, ["C:/app/Clawtrate.exe", "--", link("First")], "C:/");
    emit("second-instance", {}, ["C:/app/Clawtrate.exe", "--", link("Second")], "C:/");
    // The window is told a link waits, and nothing more.
    expect(recorded.calls).toEqual([
      ...["send clawtrate:link", "restore", "show", "focus"],
      ...["send clawtrate:link", "restore", "show", "focus"],
    ]);
    expect(fromPage(window)).toEqual(valid(2, "Second"));
    expect(fromPage(window)).toBeNull();
    expect(recorded.windows).toHaveLength(1);
    // A link touches nothing of the gateway client, its access or the credentials.
    expect(recorded.runtimeUse).toEqual([]);
  });

  it("F-248: a refused link reaches the window as invalid, and no log or call holds it", async () => {
    const logged = (["debug", "error", "info", "log", "trace", "warn"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    );
    try {
      const window = await startWith("win32", ["--", `${link("Zq7secret")}&send=1`]);
      expect(fromPage(window)).toEqual({ id: 1, status: "invalid" });
      // A link Windows split at a quote, with a piece that looks like a switch.
      const split = ["C:/app/Clawtrate.exe", "--", link("Zq7secret"), "--use-mock-keychain"];
      emit("second-instance", {}, split, "C:/");
      expect(fromPage(window)).toEqual({ id: 2, status: "invalid" });
      emit("open-url", { preventDefault() {} }, "clawtrate://chat?text=Zq7secret");
      expect(fromPage(window)).toEqual({ id: 3, status: "invalid" });
      const said = [...logged.flatMap((spy) => spy.mock.calls), recorded.calls].map((call) =>
        inspect(call),
      );
      for (const words of said) {
        expect(words).not.toContain("Zq7secret");
        expect(words).not.toContain("clawtrate://");
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("F-248: on macOS a link can come before the window, and one with no window open opens one", async () => {
    let ready!: () => void;
    recorded.ready = new Promise<void>((resolve) => (ready = resolve));
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    recorded.packaged = true;
    await import("../src/main/index.ts");
    const prevented = vi.fn();
    emit("open-url", { preventDefault: prevented }, link("Early"));
    expect(prevented).toHaveBeenCalledOnce();
    expect(recorded.windows, "no window before the app is ready").toHaveLength(0);
    ready();
    await vi.waitFor(() => expect(recorded.windows).toHaveLength(1));
    const first = recorded.windows[0]!;
    expect(fromPage(first)).toEqual(valid(1, "Early"));
    // The window closes and the app stays open, as on macOS.
    first.closed = true;
    first.listeners.get("closed")!();
    emit("open-url", { preventDefault: prevented }, link("Later"));
    expect(recorded.windows).toHaveLength(2);
    const second = recorded.windows[1]!;
    expect(fromPage(first), "the closed window").toBeNull();
    expect(fromPage(second)).toEqual(valid(2, "Later"));
  });
});
