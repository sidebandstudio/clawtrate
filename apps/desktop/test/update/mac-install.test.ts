import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { chmod, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { holdMacArchive } from "../../src/main/mac-archive.ts";
import { macInstaller, serveMacArchive } from "../../src/main/mac-install.ts";
import { tempDir } from "./harness.ts";
vi.mock(import("node:child_process"), async (original) => {
  const cp = { ...(await original()) };
  vi.spyOn(cp, "spawn");
  return cp;
});
// Removing the checked copy can fail, as Electron's fs did on its app.asar (#383).
const removal = vi.hoisted(() => ({ fails: false, folder: ".inspect-" }));
function failingRemove<T extends (path: string, ...rest: never[]) => Promise<void>>(rm: T): T {
  return (async (path: string, ...rest: never[]) => {
    if (removal.fails && path.includes(removal.folder))
      throw Object.assign(Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
    return rm(path, ...rest);
  }) as T;
}
vi.mock(import("node:fs/promises"), async (original) => {
  const fs = await original();
  return { ...fs, rm: failingRemove(fs.rm) };
});
vi.mock(import("../../src/main/update-tree-fs.ts"), async (original) => {
  const fs = await original();
  return { ...fs, rm: failingRemove(fs.rm) };
});
const dirs: ReturnType<typeof tempDir>[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.remove();
});
async function candidate() {
  const dir = tempDir();
  dirs.push(dir);
  const path = join(dir.path, "test.zip");
  const bytes = Buffer.alloc(200000, 42);
  await writeFile(path, bytes);
  const stat = await lstat(path, { bigint: true });
  return {
    path,
    offerId: "one",
    version: "1.2.0",
    track: "stable" as const,
    size: bytes.length,
    identity: [stat.dev, stat.ino, stat.birthtimeNs].join("."),
    sha512: createHash("sha512").update(bytes).digest("base64"),
  };
}

it.skipIf(process.platform === "win32")(
  "keeps only a read-only, unlinked copy of the preflight bytes through the listener deadline",
  async () => {
    const proof = await candidate();
    const archive = await holdMacArchive(proof);
    try {
      expect((await archive.file.stat()).nlink).toBe(0);
      await expect(archive.file.write(Buffer.from("x"))).rejects.toThrow();
      await writeFile(proof.path, "changed");
      let address = "";
      await expect(
        serveMacArchive(
          archive,
          new AbortController().signal,
          async (url) => {
            address = url;
            const { url: artifact } = (await (await fetch(url)).json()) as { url: string };
            const bytes = Buffer.from(await (await fetch(artifact)).arrayBuffer());
            expect(createHash("sha512").update(bytes).digest("base64")).toBe(proof.sha512);
            return new Promise(() => {});
          },
          () => {},
          500,
        ),
      ).rejects.toThrow("Local handoff ended");
      await expect(fetch(address)).rejects.toThrow();
    } finally {
      await archive.file.close();
    }
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "mac-archive",
    "running-signature-untrusted",
    "mac-bundle-identifier",
    "mac-architecture",
    "installer-version",
    "mac-designated-requirement",
  ] as const)("closes the held archive when preflight reports %s", async (reason) => {
  let descriptor: Awaited<ReturnType<typeof holdMacArchive>> | undefined;
  const installer = macInstaller(
    "x64",
    async (held) => {
      descriptor = held;
      return reason;
    },
    async () => {
      throw Error("unexpected stage");
    },
  );
  const file = await candidate();
  expect(await installer.inspect(file)).toBe(reason);
  expect(descriptor!.file.fd).toBe(-1);
  expect(await installer.launch(file, new AbortController().signal, () => {})).toBe(
    "artifact-changed",
  );
});

it.skipIf(process.platform === "win32")(
  "submits the default feed before announcing handoff and requests restart only on the native ready event",
  async () => {
    const updater = Object.assign(new EventEmitter(), {
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(() => submitted.resolve()),
      quitAndInstall: vi.fn(),
    });
    vi.doMock("electron", () => ({ autoUpdater: updater }));
    const submitted = Promise.withResolvers<void>();
    const installer = macInstaller("arm64", async () => null);
    try {
      const file = await candidate();
      expect(await installer.inspect(file)).toBeNull();
      expect(updater.setFeedURL).not.toHaveBeenCalled();
      const handed = vi.fn();
      const pending = installer.launch(file, new AbortController().signal, handed);
      await submitted.promise;
      expect(updater.setFeedURL).toHaveBeenCalledExactlyOnceWith({
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/.+\/feed$/),
        serverType: "default",
      });
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
      expect(handed).not.toHaveBeenCalled();
      updater.emit("update-downloaded");
      expect(handed).toHaveBeenCalledTimes(1);
      expect(await pending).toBeNull();
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    } finally {
      installer.retire?.();
      vi.doUnmock("electron");
    }
  },
);

it("an inspector result without its line ending is inspection-failed, even after exit 0", async () => {
  const old = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", {
    value: "/fixture/Contents/Resources",
    configurable: true,
  });
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.end("ok");
      child.emit("close", 0);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  try {
    const file = await candidate();
    expect(
      await macInstaller("arm64").inspect({ ...file, path: join(file.path, "absent", "archive") }),
    ).toBe("inspection-failed");
  } finally {
    if (old) Object.defineProperty(process, "resourcesPath", old);
    else Reflect.deleteProperty(process, "resourcesPath");
  }
});

it("a flagged ad hoc bundle reports build-not-signed before opening the archive or creating scratch", async () => {
  const old = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", {
    value: "/fixture/Contents/Resources",
    configurable: true,
  });
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockImplementationOnce((...args) => {
    expect(args[1]).toEqual(["--running-signature", "dev.clawtrate.desktop"]);
    expect(args[2]).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
    queueMicrotask(() => {
      child.stdout.end("build-not-signed\n");
      child.emit("close", 0);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  try {
    const file = await candidate();
    const installer = macInstaller("arm64");
    expect(await installer.inspect({ ...file, path: join(file.path, "absent", "archive") })).toBe(
      "build-not-signed",
    );
    expect(installer.unavailable).toBe("build-not-signed");
  } finally {
    if (old) Object.defineProperty(process, "resourcesPath", old);
    else Reflect.deleteProperty(process, "resourcesPath");
  }
});

it.skipIf(process.platform === "win32")(
  "a checked copy that can't be removed leaves the helper's ok standing",
  async () => {
    const old = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", {
      value: "/fixture/Contents/Resources",
      configurable: true,
    });
    const ok = () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.end("ok\n");
        child.emit("close", 0);
      });
      return child as unknown as ReturnType<typeof spawn>;
    };
    vi.mocked(spawn).mockImplementationOnce(ok).mockImplementationOnce(ok);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    removal.fails = true;
    try {
      const installer = macInstaller("arm64");
      expect(await installer.inspect(await candidate())).toBeNull();
      expect(error).toHaveBeenCalledWith(
        "Couldn't remove the checked copy of the update (ENOTEMPTY)",
      );
      expect(installer.cleanupFailure).toEqual({ copy: "checked-copy", errorCode: "ENOTEMPTY" });
      installer.retire?.();
    } finally {
      removal.fails = false;
      error.mockRestore();
      if (old) Object.defineProperty(process, "resourcesPath", old);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  },
);

type Helper = { out?: string; err?: string; code?: number | null; signal?: string; error?: string };

/** A helper process that writes `out` and `err`, then ends as described. */
function helper({ out = "", err = "", code = 0, signal, error }: Helper) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    pid: error ? undefined : 4242,
  });
  queueMicrotask(() => {
    if (error) child.emit("error", Object.assign(Error("spawn failed"), { code: error }));
    child.stderr.end(err);
    child.stdout.end(out);
    setImmediate(() => child.emit("close", code, signal ?? null));
  });
  return child as unknown as ReturnType<typeof spawn>;
}

async function withHelpers(runs: Helper[], body: () => Promise<void>) {
  const old = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", {
    value: "/fixture/Contents/Resources",
    configurable: true,
  });
  for (const run of runs) vi.mocked(spawn).mockImplementationOnce(() => helper(run));
  try {
    await body();
  } finally {
    vi.mocked(spawn).mockReset();
    if (old) Object.defineProperty(process, "resourcesPath", old);
    else Reflect.deleteProperty(process, "resourcesPath");
  }
}

const recorded = { system: "macOS 99.1", durationMs: expect.any(Number) };

it.skipIf(process.platform === "win32").each([
  [
    "no line ending",
    { out: "ok" },
    { exitCode: 0, signal: null, output: "no-line-ending", helperStep: null, errorCode: null },
  ],
  [
    "no output and a failed exit",
    { code: 1 },
    { exitCode: 1, signal: null, output: "empty", helperStep: null, errorCode: null },
  ],
  [
    "a signal",
    { code: null, signal: "SIGKILL" },
    { exitCode: null, signal: "SIGKILL", output: "empty", helperStep: null, errorCode: null },
  ],
  [
    "an answer over 128 bytes",
    { out: "x".repeat(200) + "\n" },
    { exitCode: 0, output: "too-long", helperStep: null, errorCode: null },
  ],
  ["an answer no result names", { out: "maybe\n" }, { exitCode: 0, output: "unrecognized" }],
  ["a result refused for its exit", { out: "ok\n", code: 3 }, { exitCode: 3, output: "complete" }],
  [
    "inspection-failed with the helper's step",
    { out: "inspection-failed\n", err: "parent-code -67065\n/private/secret\n" },
    { exitCode: 0, output: "reported", helperStep: "parent-code -67065" },
  ],
  [
    "anything else on standard error",
    { out: "inspection-failed\n", err: "/Users/someone/Library/x token=abc\n" },
    { exitCode: 0, output: "reported", helperStep: null },
  ],
] as const)("records the signature-only call's failure from %s", async (_, run, failure) => {
  await withHelpers([run], async () => {
    const file = await candidate();
    const installer = macInstaller("arm64", undefined, undefined, undefined, "macOS 99.1");
    expect(await installer.inspect(file)).toBe("inspection-failed");
    expect(installer.inspectionFailure).toEqual({
      stage: "running-signature",
      signal: null,
      helperStep: null,
      errorCode: null,
      ...recorded,
      ...failure,
    });
  });
});

it.skipIf(process.platform === "win32")(
  "records a helper that never started, by its error code",
  async () => {
    await withHelpers([{ error: "ENOENT", code: -2 }], async () => {
      const installer = macInstaller("arm64", undefined, undefined, undefined, "macOS 99.1");
      expect(await installer.inspect(await candidate())).toBe("inspection-failed");
      expect(installer.inspectionFailure).toEqual({
        stage: "start-helper",
        exitCode: null,
        signal: null,
        output: null,
        helperStep: null,
        errorCode: "ENOENT",
        ...recorded,
      });
    });
  },
);

it.skipIf(process.platform === "win32")(
  "records the full call's failure as the archive stage, and a later pass clears it",
  async () => {
    await withHelpers(
      [{ out: "ok\n" }, { code: 1, err: "unpack 0\n" }, { out: "ok\n" }, { out: "ok\n" }],
      async () => {
        const installer = macInstaller("arm64", undefined, undefined, undefined, "macOS 99.1");
        const file = await candidate();
        expect(await installer.inspect(file)).toBe("inspection-failed");
        expect(installer.inspectionFailure).toEqual({
          stage: "archive",
          exitCode: 1,
          signal: null,
          output: "empty",
          helperStep: "unpack 0",
          errorCode: null,
          ...recorded,
        });
        expect(await installer.inspect({ ...file, offerId: "two" })).toBeNull();
        expect(installer.inspectionFailure).toBeNull();
        installer.retire?.();
      },
    );
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "records a download it could not hold, by its error code",
  async () => {
    const file = await candidate();
    await chmod(file.path, 0);
    const installer = macInstaller("arm64", async () => null, undefined, undefined, "macOS 99.1");
    expect(await installer.inspect(file)).toBe("inspection-failed");
    expect(installer.inspectionFailure).toEqual({
      stage: "hold-archive",
      exitCode: null,
      signal: null,
      output: null,
      helperStep: null,
      errorCode: "EACCES",
      ...recorded,
    });
  },
);

it.skipIf(process.platform === "win32")(
  "records a full call that could not run, by its error code",
  async () => {
    const installer = macInstaller(
      "arm64",
      async () => {
        throw Object.assign(Error("no space"), { code: "ENOSPC" });
      },
      undefined,
      undefined,
      "macOS 99.1",
    );
    expect(await installer.inspect(await candidate())).toBe("inspection-failed");
    expect(installer.inspectionFailure).toMatchObject({ stage: "archive", errorCode: "ENOSPC" });
  },
);

it.skipIf(process.platform === "win32")(
  "a private copy whose folder can't be removed is logged and recorded, and the answer stands",
  async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    removal.fails = true;
    removal.folder = ".hold-";
    try {
      const installer = macInstaller("arm64", async () => null);
      expect(await installer.inspect(await candidate())).toBeNull();
      expect(error).toHaveBeenCalledWith(
        "Couldn't remove the private copy of the update (ENOTEMPTY)",
      );
      expect(installer.cleanupFailure).toEqual({ copy: "held-copy", errorCode: "ENOTEMPTY" });
      installer.retire?.();
    } finally {
      removal.fails = false;
      removal.folder = ".inspect-";
      error.mockRestore();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "a superseded inspection's late records don't land on the next one",
  async () => {
    let calls = 0;
    const installer = macInstaller("arm64", async (_held, _arch, signal, record, cleanupFailed) => {
      if (calls++ > 0) return null;
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      record?.("archive", {
        exitCode: null,
        signal: "SIGKILL",
        output: "empty",
        helperStep: null,
        errorCode: null,
        durationMs: 1,
      });
      cleanupFailed?.("EBUSY");
      return "inspection-failed";
    });
    const file = await candidate();
    const first = installer.inspect(file);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await installer.inspect({ ...file, offerId: "two" })).toBeNull();
    await first;
    expect(installer.inspectionFailure).toBeNull();
    expect(installer.cleanupFailure).toBeNull();
    installer.retire?.();
  },
);
