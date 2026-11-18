import { describe, expect, it } from "vitest";
import { openableUrl, parseMarkdown } from "../src/markdown.ts";

describe("the bot's markdown on iOS", () => {
  it("reads paragraphs, emphasis, strong, inline code and links", () => {
    expect(
      parseMarkdown(
        "Some *quiet* and **loud** words with `du -sh` and [a link](https://docs.example/a).",
      ),
    ).toEqual([
      {
        t: "p",
        children: [
          { t: "text", text: "Some " },
          { t: "em", children: [{ t: "text", text: "quiet" }] },
          { t: "text", text: " and " },
          { t: "strong", children: [{ t: "text", text: "loud" }] },
          { t: "text", text: " words with " },
          { t: "code", text: "du -sh" },
          { t: "text", text: " and " },
          { t: "link", url: "https://docs.example/a", children: [{ t: "text", text: "a link" }] },
          { t: "text", text: "." },
        ],
      },
    ]);
  });

  it("reads lists, numbered lists, headings, code blocks, quotes, rules and tables", () => {
    const blocks = parseMarkdown(
      [
        "## Plan",
        "",
        "- one",
        "- two",
        "",
        "3. third",
        "4. fourth",
        "",
        "```sh",
        "du -sh /media",
        "```",
        "",
        "> quoted",
        "",
        "---",
        "",
        "| Folder | Size |",
        "| --- | --- |",
        "| movies | 1.2 TB |",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.t)).toEqual([
      "h",
      "list",
      "list",
      "code",
      "quote",
      "rule",
      "table",
    ]);
    expect(blocks[1]).toMatchObject({ ordered: false, items: [[{ t: "p" }], [{ t: "p" }]] });
    expect(blocks[2]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[3]).toEqual({ t: "code", text: "du -sh /media" });
    expect(blocks[6]).toEqual({
      t: "table",
      header: [[{ t: "text", text: "Folder" }], [{ t: "text", text: "Size" }]],
      rows: [[[{ t: "text", text: "movies" }], [{ t: "text", text: "1.2 TB" }]]],
    });
  });

  it("opens only web and mail links, and shows raw HTML as text", () => {
    expect(openableUrl("https://a.example")).toBe("https://a.example");
    expect(openableUrl("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(openableUrl("javascript:alert(1)")).toBeNull();
    expect(openableUrl("file:///etc/hosts")).toBeNull();
    expect(parseMarkdown("[run](javascript:alert(1))")).toEqual([
      { t: "p", children: [{ t: "text", text: "run" }] },
    ]);
    const html = parseMarkdown("<b>bold</b>")[0]!;
    expect(
      html.t === "p" && html.children.map((c) => (c.t === "text" ? c.text : c.t)).join(""),
    ).toBe("<b>bold</b>");
    // Autolinks from GitHub's extension.
    expect(parseMarkdown("see https://b.example")[0]).toMatchObject({
      children: [
        { t: "text", text: "see " },
        { t: "link", url: "https://b.example" },
      ],
    });
  });
});
