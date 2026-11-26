import { describe, expect, it } from "vitest";
import {
  besideLink,
  columnWidths,
  COLUMN_WIDTH,
  linkPlace,
  openableUrl,
  parseMarkdown,
  type Inline,
} from "../src/markdown.ts";

// Private and link-local addresses are built from their parts, so no tracked file writes one
// out (test/addresses.test.ts).
const join4 = (...parts: number[]) => parts.join(".");
const join6 = (...groups: string[]) => groups.join(":");

/** The links of a one-paragraph message, in order. */
function links(markdown: string): Extract<Inline, { t: "link" }>[] {
  const [block] = parseMarkdown(markdown);
  if (block?.t !== "p") throw new Error("not a paragraph");
  return block.children.filter((node) => node.t === "link");
}

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
          {
            t: "link",
            url: "https://docs.example/a",
            host: "docs.example",
            plain: false,
            place: null,
            children: [{ t: "text", text: "a link" }],
          },
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

  it("opens only http and https addresses that parse, and keeps any other as its text", () => {
    expect(openableUrl("https://a.example")?.href).toBe("https://a.example/");
    expect(openableUrl("http://127.0.0.1:9/x")?.host).toBe("127.0.0.1:9");
    for (const url of [
      "mailto:someone@example.com",
      "javascript:alert(1)",
      "file:///etc/hosts",
      "http://",
      "https://[oops",
      "tel:123",
    ])
      expect(openableUrl(url), url).toBeNull();
    expect(parseMarkdown("[run](javascript:alert(1))")).toEqual([
      { t: "p", children: [{ t: "text", text: "run" }] },
    ]);
    expect(parseMarkdown("Write [me](mailto:someone@example.com).")).toEqual([
      {
        t: "p",
        children: [
          { t: "text", text: "Write " },
          { t: "text", text: "me" },
          { t: "text", text: "." },
        ],
      },
    ]);
  });

  it("marks a link whose text is not its address, so the screen shows the host beside it", () => {
    const [hidden] = parseMarkdown("[the notes](https://elsewhere.example/n)");
    expect(hidden).toMatchObject({
      children: [{ t: "link", host: "elsewhere.example", plain: false }],
    });
    const [shown] = parseMarkdown(
      "[https://docs.example/a](https://docs.example/a) and https://b.example",
    );
    expect(shown).toMatchObject({
      children: [
        { t: "link", plain: true },
        { t: "text" },
        { t: "link", plain: true, host: "b.example" },
      ],
    });
    // Text that names another address is not its address.
    const [lying] = parseMarkdown("[https://bank.example](https://elsewhere.example)");
    expect(lying).toMatchObject({
      children: [{ t: "link", plain: false, host: "elsewhere.example" }],
    });
  });

  it("shows the host when the text differs from its address only in a path's case, a trailing slash or a query's case", () => {
    for (const [shown, target] of [
      ["http://127.0.0.1:47000/Notes", "http://127.0.0.1:47000/notes"],
      ["http://127.0.0.1:47000/notes", "http://127.0.0.1:47000/notes/"],
      ["http://127.0.0.1:47000/view?id=ABC", "http://127.0.0.1:47000/view?id=abc"],
    ]) {
      expect(parseMarkdown(`[${shown}](${target})`)[0]).toMatchObject({
        children: [{ t: "link", plain: false }],
      });
    }
  });

  it("shows nothing beside a link whose text is its address, and the host beside one whose text isn't", () => {
    const [plain, hidden, upper] = links(
      "See https://b.example/a, [the notes](https://elsewhere.example/n) and [HTTPS://B.EXAMPLE/](https://b.example/).",
    );
    expect(plain).toMatchObject({ plain: true, place: null });
    expect(besideLink(plain!)).toBeNull();
    expect(besideLink(hidden!)).toBe("elsewhere.example");
    // The same address in capitals is still its address.
    expect(besideLink(upper!)).toBeNull();
  });

  it("names this iPhone beside a loopback link and your network beside a local one, even when the text is the address", () => {
    const [loopback, preview, network] = links(
      `At http://127.0.0.1:8080/x, [the preview](http://localhost:8081/) and [the router](http://${join4(192, 168, 1, 1)}/).`,
    );
    expect(besideLink(loopback!)).toBe("this iPhone");
    expect(besideLink(preview!)).toBe("localhost:8081, this iPhone");
    expect(besideLink(network!)).toBe(`${join4(192, 168, 1, 1)}, your network`);
    expect(besideLink(links("At https://studio.local/x.")[0]!)).toBe("your network");
  });

  it("knows a loopback host in any spelling, IPv6 included", () => {
    for (const url of [
      "http://127.0.0.1/",
      `http://${join4(127, 8, 9, 10)}:1/`,
      "http://localhost/",
      "http://LOCALHOST./",
      "http://app.localhost/",
      "http://0.0.0.0:3000/",
      "http://0x7f.1/",
      "http://[::1]:3000/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
    ])
      expect(linkPlace(new URL(url)), url).toBe("device");
  });

  it("knows the person's own network: private, shared and link-local ranges, IPv6 local ranges, .local and a name without a dot", () => {
    for (const url of [
      `http://${join4(10, 0, 0, 5)}/`,
      `http://${join4(172, 16, 0, 1)}/`,
      `http://${join4(172, 31, 255, 1)}/`,
      `http://${join4(192, 168, 1, 20)}:8080/`,
      `http://${join4(169, 254, 3, 4)}/`,
      `http://${join4(100, 64, 0, 1)}/`,
      `http://${join4(100, 127, 255, 1)}/`,
      `http://[::ffff:${join4(192, 168, 1, 20)}]/`,
      `http://[${join6("fd12", "", "1")}]/`,
      `http://[${join6("fe80", "", "1")}]/`,
      "http://studio.local/",
      "http://studio.local./",
      "http://nas:5000/",
      "http://nas./",
    ])
      expect(linkPlace(new URL(url)), url).toBe("network");
    for (const url of [
      "https://docs.example/",
      // Just past the private 172.16/12 range and the shared 100.64/10 one.
      `http://${join4(172, 32, 0, 1)}/`,
      `http://${join4(100, 128, 0, 1)}/`,
      // A name that starts like an address is a name.
      "https://100.64.example/",
      "https://local.example/",
    ])
      expect(linkPlace(new URL(url)), url).toBeNull();
  });

  it("shows a look-alike host in ASCII, so it shows as one, even when the text is the address", () => {
    // A Cyrillic letter in place of a Latin "a".
    const lookalike = "b\u0430nk.example";
    const [written, hidden] = links(
      `Sign in at https://${lookalike}/login or [your bank](https://${lookalike}/).`,
    );
    expect(written).toMatchObject({
      url: "https://xn--bnk-6cd.example/login",
      host: "xn--bnk-6cd.example",
      plain: false,
    });
    expect(besideLink(written!)).toBe("xn--bnk-6cd.example");
    expect(besideLink(hidden!)).toBe("xn--bnk-6cd.example");
    // Another spelling of an address is not its address either.
    expect(besideLink(links("[http://0x7f.1/](http://0x7f.1/)")[0]!)).toBe(
      "127.0.0.1, this iPhone",
    );
  });

  it("shows raw HTML as text", () => {
    const html = parseMarkdown("<b>bold</b>")[0]!;
    expect(
      html.t === "p" && html.children.map((c) => (c.t === "text" ? c.text : c.t)).join(""),
    ).toBe("<b>bold</b>");
    // Autolinks from GitHub's extension.
    expect(parseMarkdown("see https://b.example")[0]).toMatchObject({
      children: [
        { t: "text", text: "see " },
        { t: "link", url: "https://b.example/", plain: true },
      ],
    });
  });

  it("gives each table column one width in every row, from its longest cell, within the bounds", () => {
    const [table] = parseMarkdown(
      [
        "| A | Medium heading | x |",
        "| --- | --- | --- |",
        `| short | b | ${"wide ".repeat(40)} |`,
      ].join("\n"),
    );
    if (table?.t !== "table") throw new Error("not a table");
    // 15-point text: "short" is narrow, "Medium heading" is 14 × 15 × 0.55 + 16, and 200 characters are capped.
    expect(columnWidths(table, 15)).toEqual([COLUMN_WIDTH.min, 132, COLUMN_WIDTH.max]);
  });
});
