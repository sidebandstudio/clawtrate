// What Download all says after writing into a chosen folder (work-pane.md, section 12).
import { describe, expect, it } from "vitest";
import { folderSaveWords } from "../src/artifacts/words.ts";

describe("a folder save's words", () => {
  it("F-304: names changed by folder sanitization are reported without inventing a collision", () => {
    // A bot's name the file system can't take, written under a plain one, with nothing there.
    expect(
      folderSaveWords("Trail", 2, ["report_1.md", "chime.wav"], [], ["report:1.md as report_1.md"]),
    ).toBe("Saved 2 items in Trail. Saved under adjusted names: report:1.md as report_1.md.");
    expect(
      folderSaveWords("Trail", 3, ["a (2).png"], ["b.wav", "c.jpg"], ["a.png as a (2).png"]),
    ).toBe(
      "Saved 1 of 3 in Trail. Not saved: b.wav, c.jpg. Saved under adjusted names: a.png as a (2).png.",
    );
    expect(folderSaveWords("Trail", 1, ["a.png"], [], [])).toBe("Saved 1 item in Trail.");
    for (const words of [
      folderSaveWords("Trail", 1, ["x_.md"], [], ["x?.md as x_.md"]),
      folderSaveWords("Trail", 1, ["x (2).md"], [], ["x.md as x (2).md"]),
    ])
      expect(words).not.toMatch(/was there|already|collision/i);
  });
});
