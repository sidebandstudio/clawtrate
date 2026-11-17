// The Files tab's words and change parsing (work-pane.md, sections 4, 7 and 8).
import {
  FileTransfers,
  fromBase64,
  MAX_TRANSFER_BYTES,
  type ClawtrateBridge,
  type FileRead,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { collect, isShown } from "../src/work/content.ts";
import { formatSize, limitSentence, nameParts } from "../src/work/files-format.ts";
import { parseNumberedDiff, parsePatch, patchCounts } from "../src/work/patch.ts";

describe("sizes and names", () => {
  it("writes sizes in binary units with one decimal below 10", () => {
    expect(formatSize(820)).toBe("820 B");
    expect(formatSize(2_458)).toBe("2.4 KB");
    expect(formatSize(1_363_149)).toBe("1.3 MB");
    expect(formatSize(14_680_064)).toBe("14 MB");
    expect(formatSize(3_565_158)).toBe("3.4 MB");
    expect(formatSize(262_144)).toBe("256 KB");
    expect(formatSize(1_048_576)).toBe("1 MB");
    expect(formatSize(null)).toBe("");
  });

  it("cuts a long name in the middle so its end and extension stay", () => {
    expect(nameParts("notes.md")).toEqual({ start: "notes.md", end: "" });
    const { start, end } = nameParts("disk-report-for-the-media-box-final.md");
    expect(start + end).toBe("disk-report-for-the-media-box-final.md");
    expect(end.endsWith(".md")).toBe(true);
  });

  it("F-449: names the limit the file met", () => {
    expect(
      limitSentence(
        "bundle.js",
        { code: "script-too-large", size: 2_411_725, limit: 1_048_576 },
        "Otto",
      ),
    ).toBe(
      "bundle.js is 2.3 MB. The gateway sends stylesheets and scripts from a task's folder up to 1 MB.",
    );
    expect(
      limitSentence(
        "photo.png",
        { code: "picture-too-large", size: 3_250_586, limit: 1_048_576, where: "task" },
        "Otto",
      ),
    ).toBe("photo.png is 3.1 MB. From this task's folder the gateway sends pictures up to 1 MB.");
    expect(
      limitSentence(
        "photo.heic",
        { code: "picture-too-large", size: 7_549_747, limit: 5_242_880, where: "workspace" },
        "Otto",
      ),
    ).toBe("photo.heic is 7.2 MB. The gateway sends pictures from the workspace up to 5 MB.");
    expect(
      limitSentence(
        "tiny.bmp",
        { code: "picture-type-not-sent", mimeType: "image/bmp", where: "repository" },
        "Otto",
      ),
    ).toBe(
      "tiny.bmp is a picture of a type (image/bmp) the gateway doesn't send from a repository it keeps, so it can't be shown or downloaded here.",
    );
    expect(limitSentence("memo.m4a", { code: "media-outside-task", media: "audio" }, "Otto")).toBe(
      "This recording is in Otto's workspace, outside this task's folder. The gateway sends recordings only from a task's folder, so it can't be played here.",
    );
  });
});

describe("changes", () => {
  it("reads a unified patch into hunks, with old and new line numbers", () => {
    const hunks = parsePatch(
      "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,2 @@\n # A\n-old\n+new\n",
    );
    expect(hunks).toHaveLength(1);
    expect(
      hunks[0]!.lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text]),
    ).toEqual([
      ["same", 1, 1, "# A"],
      ["del", 2, null, "old"],
      ["add", null, 2, "new"],
    ]);
    expect(patchCounts(hunks)).toEqual({ added: 1, removed: 1 });
  });

  it("F-152: reads the numbered diff the gateway's history keeps, part by part", () => {
    const hunks = parseNumberedDiff(
      "      ...\n 2347 line 2347\n 2348 line 2348\n+2349 line 2349\n+2350 line 2350\n      ...\n-9 gone\n+9 here",
    );
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.newStart).toBe(2347);
    expect(hunks[0]!.newEnd).toBe(2350);
    expect(patchCounts(hunks)).toEqual({ added: 3, removed: 1 });
    expect(parseNumberedDiff("+1 Leave at 9:00.")[0]!.lines).toEqual([
      { kind: "add", text: "Leave at 9:00.", oldLine: null, newLine: 1 },
    ]);
  });
});

describe("content put together from its chunks", () => {
  // The desktop host's policy sets no `maxResultChars`, so its viewer reads in the largest chunks.
  const DESKTOP_MAX_CHARS = undefined;

  it("F-319: content over 1 MiB and up to the picture limit reaches the desktop whole, in the desktop's chunks", async () => {
    for (const size of [1_048_577, 3_145_730, MAX_TRANSFER_BYTES]) {
      const transfers = new FileTransfers(() => 0);
      const owner = {};
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 29 + 5) & 255);
      const transfer = transfers.start(owner, bytes, DESKTOP_MAX_CHARS);
      expect(transfer.chunks).toBeGreaterThan(1);
      const bridge = {
        invoke: async (command: { type: string; id: string; index: number }) =>
          transfers.chunk(owner, command.id, command.index),
        send: async () => {},
      } as unknown as ClawtrateBridge;
      const read: FileRead = {
        status: "content",
        facts: { name: "summit.png", path: "summit.png", size, updatedAt: null, mimeType: null },
        reader: "agents.workspace.get",
        kind: "image",
        mimeType: "image/png",
        bytes: size,
        hash: "",
        transfer,
      };
      const shown = await collect(bridge, read);
      expect(isShown(shown), `${size} bytes`).toBe(true);
      const data = isShown(shown) ? shown.data : new Uint8Array();
      expect(data.length).toBe(size);
      expect(data.findIndex((byte, i) => byte !== bytes[i])).toBe(-1);
      expect(fromBase64(transfer.data)).not.toBeNull();
      expect(transfers.size).toBe(0);
    }
  }, 60_000);
});
