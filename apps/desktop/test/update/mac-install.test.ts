import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { holdMacArchive } from "../../src/main/mac-archive.ts";
import { macInstaller, serveMacArchive } from "../../src/main/mac-install.ts";
import { tempDir } from "./harness.ts";
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
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
    });
    vi.doMock("electron", () => ({ autoUpdater: updater }));
    const submitted = Promise.withResolvers<void>();
    const installer = macInstaller("arm64", async () => null);
    try {
      const file = await candidate();
      expect(await installer.inspect(file)).toBeNull();
      expect(updater.setFeedURL).not.toHaveBeenCalled();
      const pending = installer.launch(file, new AbortController().signal, () => {
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
        submitted.resolve();
      });
      await submitted.promise;
      expect(updater.setFeedURL).toHaveBeenCalledExactlyOnceWith({
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/.+\/feed$/),
        serverType: "default",
      });
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
      updater.emit("update-downloaded");
      expect(await pending).toBeNull();
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    } finally {
      installer.retire?.();
      vi.doUnmock("electron");
    }
  },
);
