// The host's key/value file: a write that does not reach the disk is not reported as kept.

import { createFileStore } from "@clawtrate/core/node";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

/** A folder holding `state.json` with `contents`, then made read-only, so no write can land. */
function readOnlyStore(contents: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-file-store-"));
  dirs.push(dir);
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
