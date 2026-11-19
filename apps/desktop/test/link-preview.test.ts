// A link's preview as the device fetches it (work-pane.md, section 12, F-116):
// only public web addresses, every redirect checked again, bounded reads, and
// what a page's head says about itself.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createLinkPreviewer,
  isPrivateAddress,
  pinnedGet,
  PREVIEW_IMAGE_BYTES,
  readPreviewMeta,
  type PreviewGet,
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

type FakePage = { status?: number; headers?: Record<string, string>; body?: Uint8Array | string };

/** Pages a fake GET answers, recording each URL asked and the address it was pinned to. */
function web(pages: Record<string, FakePage>) {
  const asked: string[] = [];
  const pinned: string[] = [];
  const fetch: PreviewGet = async (target) => {
    const url = target.url.toString();
    asked.push(url);
    pinned.push(target.address);
    const page = pages[url] ?? { status: 404 };
    const data =
      typeof page.body === "string" ? Buffer.from(page.body) : (page.body ?? new Uint8Array(0));
    return {
      status: page.status ?? 200,
      header: (name) => page.headers?.[name.toLowerCase()] ?? null,
      body: (async function* () {
        yield data;
      })(),
      close: () => {},
    };
  };
  return { fetch, asked, pinned };
}

const html = (body: string): FakePage => ({
  body,
  headers: { "content-type": "text/html; charset=utf-8" },
});

describe("a link's preview", () => {
  it("F-116: the title, description and picture a page names in its head", async () => {
    const { fetch, asked } = web({
      "https://library.example/ebooks": html(
        '<html><head><title>Library</title><meta property="og:title" content="Library e-books"><meta name="description" content="Borrow e-books &amp; audiobooks."><meta property="og:image" content="/cover.png"></head></html>',
      ),
      "https://library.example/cover.png": {
        body: new Uint8Array([137, 80, 78, 71]),
        headers: { "content-type": "image/png" },
      },
    });
    const preview = createLinkPreviewer({ get: fetch, lookup: async () => PUBLIC });
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
      "https://jump.example/": { status: 302, headers: { location: `http://${ROUTER}/admin` } },
    });
    const preview = createLinkPreviewer({
      get: fetch,
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

  it("F-116: an inward address is refused however it is written: inside an IPv6 one, in another IPv4 spelling, with a zone or a trailing dot", async () => {
    const { fetch, asked } = web({});
    const loop = join4(127, 0, 0, 1);
    const answers: Record<string, string> = {
      "mapped.example": join6("", "", "ffff", join4(10, 0, 0, 1)),
      "zoned.example": `${join6("fe80", "", "1")}%eth0`,
      "garbled.example": "not-an-address",
    };
    const preview = createLinkPreviewer({
      get: fetch,
      lookup: async (host) => (host in answers ? [{ address: answers[host]!, family: 6 }] : PUBLIC),
    });
    const inward = [
      `http://[${join6("", "", "ffff", loop)}]/`,
      `http://[${join6("", "", "ffff", INSIDE)}]/`,
      `http://[${join6("", "", loop)}]/`,
      `http://[${join6("", "", "ffff", "0", loop)}]/`,
      `http://[${join6("64", "ff9b", "", ROUTER)}]/`,
      `http://[${join6("2002", "a00", "8", "", "1")}]/`,
      `http://[${join6("", "")}]/`,
      `http://[${join6("fe80", "", "1")}%25eth0]/`,
      `http://${["0x7f", "1"].join(".")}/`,
      `http://${String(127 * 2 ** 24 + 1)}/`,
      `http://${["0177", "0", "0", "1"].join(".")}/`,
      `http://${join4(0, 0, 0, 0)}/`,
      "http://localhost./",
      "http://printer.local./",
      "http://mapped.example/",
      "http://zoned.example/",
      "http://garbled.example/",
    ];
    for (const url of inward) expect(await preview(url), url).toEqual({ status: "none", url });
    expect(asked).toEqual([]);
    // The same check, on the parsed address.
    expect(isPrivateAddress(join6("", "", "ffff", loop))).toBe(true);
    expect(isPrivateAddress(`[${join6("fe80", "", "1")}%eth0]`)).toBe(true);
    expect(isPrivateAddress(join6("", "", "ffff", "203.0.113.7"))).toBe(false);
  });

  it("F-116: a name is looked up once, and the connection goes to the address that was checked", async () => {
    // A name that answers a public address the first time and an inward one after.
    const lookups: string[] = [];
    const lookup = async (host: string) => {
      lookups.push(host);
      const first = lookups.filter((name) => name === host).length === 1;
      return host === "rebind.example" && !first ? [{ address: INSIDE, family: 4 }] : PUBLIC;
    };
    const { fetch, asked, pinned } = web({
      "http://rebind.example/": html("<title>Rebind</title>"),
      "http://hop.example/": { status: 302, headers: { location: "http://rebind.example/" } },
    });
    const preview = createLinkPreviewer({ get: fetch, lookup });
    expect(await preview("http://rebind.example/")).toMatchObject({
      status: "ok",
      title: "Rebind",
    });
    expect(lookups).toEqual(["rebind.example"]);
    expect(pinned).toEqual(["203.0.113.7"]);
    // A redirect's destination is looked up and checked before it is followed: now it answers inward.
    expect(await preview("http://hop.example/")).toEqual({
      status: "none",
      url: "http://hop.example/",
    });
    expect(lookups).toEqual(["rebind.example", "hop.example", "rebind.example"]);
    expect(asked).toEqual(["http://rebind.example/", "http://hop.example/"]);
  });

  it("F-116: the default GET connects to the checked address and keeps the name in the Host header", async () => {
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(String(request.headers.host));
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Pinned</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      // The name resolves nowhere: only the pinned address can reach the server.
      const url = new URL(`http://pinned.example:${port}/page`);
      const got = await pinnedGet()(
        { url, address: "127.0.0.1", family: 4 },
        "text/html",
        new AbortController().signal,
      );
      const parts: Uint8Array[] = [];
      for await (const chunk of got.body) parts.push(chunk);
      expect([got.status, Buffer.concat(parts).toString()]).toEqual([200, "<title>Pinned</title>"]);
      expect(seen).toEqual([`pinned.example:${port}`]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("F-116: a picture over 512 KB, or of another type, is left out; a page that isn't HTML has no preview", async () => {
    const { fetch } = web({
      "https://a.example/": html(
        '<title>A</title><meta property="og:image" content="https://a.example/big.png">',
      ),
      "https://a.example/big.png": {
        body: new Uint8Array(PREVIEW_IMAGE_BYTES + 1),
        headers: { "content-type": "image/png" },
      },
      "https://b.example/": html(
        '<title>B</title><meta property="og:image" content="https://b.example/x.svg">',
      ),
      "https://b.example/x.svg": { body: "<svg/>", headers: { "content-type": "image/svg+xml" } },
      "https://c.example/file.zip": { body: "PK", headers: { "content-type": "application/zip" } },
    });
    const preview = createLinkPreviewer({ get: fetch, lookup: async () => PUBLIC });
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
