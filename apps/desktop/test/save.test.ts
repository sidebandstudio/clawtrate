// F-319: a download saves exactly the bytes the reader supplied, and a failed
// write is read back before anything is said about the file that was there.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeFileName, writeExactly, type SaveFs } from "../src/main/save.ts";

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
