// The host's key/value file: a write that does not reach the disk is not reported as kept.

import { createFileStore } from "@clawtrate/core/node";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Lets a test hold the next file read's result after the read itself has happened.
const readGate = vi.hoisted(() => ({
  hold: null as null | ((read: Promise<string>) => Promise<string>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  const readFile = (...args: Parameters<typeof actual.readFile>) => {
    const read = actual.readFile(...args) as Promise<string>;
    const hold = readGate.hold;
    readGate.hold = null;
    return hold ? hold(read) : read;
  };
  return { ...actual, readFile };
});

const dirs: string[] = [];

/** An empty temporary folder of this test's own. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-file-store-"));
  dirs.push(dir);
  return dir;
}

/** Holds the next file read's result, settled or failed, until `release` is called. */
function holdNextRead() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let read!: Promise<string>;
  readGate.hold = (pending) => {
    read = pending;
    return released.then(() => pending);
  };
  return {
    release,
    /** Resolves once the held read has itself finished. */
    finished: async () => {
      await vi.waitFor(() => expect(read).toBeDefined());
      await read.catch(() => {});
    },
  };
}

/** A folder holding `state.json` with `contents`, then made read-only, so no write can land. */
function readOnlyStore(contents: Record<string, string>) {
  const dir = tempDir();
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify(contents));
  chmodSync(dir, 0o500);
  return { path, onDisk: () => JSON.parse(readFileSync(path, "utf8")) as Record<string, string> };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A read-only folder stops writes only for a user other than root, and not on Windows.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a write the file store cannot make",
  () => {
    it("a set that fails rejects, and get still returns what the file holds", async () => {
      const { path, onDisk } = readOnlyStore({ connection: "saved" });
      const store = createFileStore(path);
      await expect(store.set("connection", "unsaved")).rejects.toThrow();
      await expect(store.set("deviceToken", "unsaved")).rejects.toThrow();
      expect(await store.get("connection")).toBe("saved");
      expect(await store.get("deviceToken")).toBe(null);
      expect(onDisk()).toEqual({ connection: "saved" });
      // After a restart the store reads the same.
      expect(await createFileStore(path).get("connection")).toBe("saved");
    });

    it("a delete that fails rejects, and get still returns what the file holds", async () => {
      const { path, onDisk } = readOnlyStore({ connection: "saved" });
      const store = createFileStore(path);
      expect(await store.get("connection")).toBe("saved");
      await expect(store.delete("connection")).rejects.toThrow();
      expect(await store.get("connection")).toBe("saved");
      expect(onDisk()).toEqual({ connection: "saved" });
      expect(await createFileStore(path).get("connection")).toBe("saved");
    });

    it("a write after a failed one still lands once the folder can be written", async () => {
      const { path, onDisk } = readOnlyStore({ connection: "saved" });
      const store = createFileStore(path);
      await expect(store.set("connection", "unsaved")).rejects.toThrow();
      chmodSync(join(path, ".."), 0o700);
      await store.set("turn-limit-minutes", "20");
      expect(onDisk()).toEqual({ connection: "saved", "turn-limit-minutes": "20" });
      expect(await store.get("connection")).toBe("saved");
    });
  },
);

describe("a first read that finishes after a write", () => {
  it("does not bring back the old value over a write that landed", async () => {
    const path = join(tempDir(), "state.json");
    writeFileSync(path, JSON.stringify({ connection: "old" }));
    const store = createFileStore(path);
    const gate = holdNextRead();
    const firstGet = store.get("connection");
    await gate.finished();
    await store.set("connection", "new");
    gate.release();
    expect(await firstGet).toBe("new");
    expect(await store.get("connection")).toBe("new");
    await store.set("turn-limit-minutes", "20");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    expect(onDisk).toEqual({ connection: "new", "turn-limit-minutes": "20" });
  });

  it("does not empty a new file over a write that landed", async () => {
    const path = join(tempDir(), "state.json");
    const store = createFileStore(path);
    const gate = holdNextRead();
    const firstGet = store.get("connection");
    await gate.finished();
    await store.set("connection", "new");
    gate.release();
    expect(await firstGet).toBe("new");
    expect(await store.get("connection")).toBe("new");
    await store.set("turn-limit-minutes", "20");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    expect(onDisk).toEqual({ connection: "new", "turn-limit-minutes": "20" });
  });
});
