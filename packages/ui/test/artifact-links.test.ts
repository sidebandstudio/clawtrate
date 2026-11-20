// The link a message ends with, as its card names it (work-pane.md, section 12).
import { describe, expect, it } from "vitest";
import { trailingLink } from "../src/artifacts/words.ts";

describe("a link card's address", () => {
  it("F-116: a link's Preview names the exact host, a written www. included", () => {
    expect(trailingLink("The site is https://www.library.example/ebooks")).toEqual({
      url: "https://www.library.example/ebooks",
      text: "www.library.example/ebooks",
      host: "www.library.example",
    });
    expect(trailingLink("See [the site](https://library.example/).")?.host).toBe("library.example");
  });
});
