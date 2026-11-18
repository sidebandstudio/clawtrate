// A link's preview as the device fetches it (work-pane.md, section 12, F-116):
// only public web addresses, every redirect checked again, bounded reads, and
// what a page's head says about itself.

import { describe, expect, it } from "vitest";
import {
  createLinkPreviewer,
  isPrivateAddress,
  PREVIEW_IMAGE_BYTES,
  readPreviewMeta,
} from "@clawtrate/core/node";

/**
 * Addresses inside a network, built from their parts at run time so none is
 * written out in the repository; public ones come from the documentation ranges.
 */
const join4 = (...parts: number[]) => parts.join(".");
const join6 = (...parts: string[]) => parts.join(":");
const ROUTER = join4(192, 168, 1, 1);
const INSIDE = join4(10, 0, 0, 8);
const SHARED = join4(100, 64, 1, 2);

const PUBLIC = [{ address: "203.0.113.7", family: 4 }];

function web(pages: Record<string, Response | (() => Response)>) {
  const asked: string[] = [];
  const fetch = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    const page = pages[url];
    if (!page) return new Response("missing", { status: 404 });
    return typeof page === "function" ? page() : page;
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("a link's preview", () => {
  it("F-116: the title, description and picture a page names in its head", async () => {
    const { fetch, asked } = web({
      "https://library.example/ebooks": html(
        '<html><head><title>Library</title><meta property="og:title" content="Library e-books"><meta name="description" content="Borrow e-books &amp; audiobooks."><meta property="og:image" content="/cover.png"></head></html>',
      ),
      "https://library.example/cover.png": new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
    });
    const preview = createLinkPreviewer({ fetch, lookup: async () => PUBLIC });
    expect(await preview("https://library.example/ebooks")).toEqual({
      status: "ok",
      url: "https://library.example/ebooks",
      title: "Library e-books",
      description: "Borrow e-books & audiobooks.",
      image: { mimeType: "image/png", data: "iVBORw==" },
    });
    expect(asked).toEqual(["https://library.example/ebooks", "https://library.example/cover.png"]);
  });

  it("F-116: never an address on this machine or a private network, before or after a redirect", async () => {
    const { fetch, asked } = web({
      "https://jump.example/": new Response(null, {
        status: 302,
        headers: { location: `http://${ROUTER}/admin` },
      }),
    });
    const preview = createLinkPreviewer({
      fetch,
      lookup: async (host) =>
        host === "inside.example" ? [{ address: INSIDE, family: 4 }] : PUBLIC,
    });
    for (const url of [
      "http://127.0.0.1:19980/api/chat/media/outgoing/a/b/full",
      "http://localhost:5173/",
      "http://[::1]/",
      "https://inside.example/",
      `http://${SHARED}/`,
    ]) {
      expect(await preview(url)).toEqual({ status: "none", url });
    }
    expect(asked).toEqual([]);
    expect(await preview("https://jump.example/")).toEqual({
      status: "none",
      url: "https://jump.example/",
    });
    expect(asked).toEqual(["https://jump.example/"]);
  });

  it("F-116: a picture over 512 KB, or of another type, is left out; a page that isn't HTML has no preview", async () => {
    const { fetch } = web({
      "https://a.example/": html(
        '<title>A</title><meta property="og:image" content="https://a.example/big.png">',
      ),
      "https://a.example/big.png": new Response(new Uint8Array(PREVIEW_IMAGE_BYTES + 1), {
        headers: { "content-type": "image/png" },
      }),
      "https://b.example/": html(
        '<title>B</title><meta property="og:image" content="https://b.example/x.svg">',
      ),
      "https://b.example/x.svg": new Response("<svg/>", {
        headers: { "content-type": "image/svg+xml" },
      }),
      "https://c.example/file.zip": new Response("PK", {
        headers: { "content-type": "application/zip" },
      }),
    });
    const preview = createLinkPreviewer({ fetch, lookup: async () => PUBLIC });
    expect(await preview("https://a.example/")).toMatchObject({ title: "A", image: null });
    expect(await preview("https://b.example/")).toMatchObject({ title: "B", image: null });
    expect(await preview("https://c.example/file.zip")).toEqual({
      status: "none",
      url: "https://c.example/file.zip",
    });
  });

  it("F-116: the private ranges", () => {
    for (const address of [
      "127.0.0.1",
      join4(10, 1, 2, 3),
      join4(172, 20, 0, 1),
      join4(192, 168, 0, 9),
      join4(169, 254, 1, 1),
      join4(100, 64, 0, 1),
      join4(0, 0, 0, 0),
      "::1",
      join6("fd00", "", "1"),
      join6("fe80", "", "1"),
      join6("", "", "ffff", join4(10, 0, 0, 1)),
    ])
      expect(isPrivateAddress(address), address).toBe(true);
    for (const address of ["203.0.113.7", "198.51.100.7", "2001:db8::1"])
      expect(isPrivateAddress(address), address).toBe(false);
    expect(readPreviewMeta("<title> A  page </title>")).toEqual({
      title: "A page",
      description: null,
      image: null,
    });
  });
});
