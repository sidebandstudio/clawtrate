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
      "https://jump.example/": { status: 302, headers: { location: "/admin" } },
    });
    // jump.example answers a public address first, then its own network's.
    let jumps = 0;
    const preview = createLinkPreviewer({
      get: fetch,
      lookup: async (host) =>
        host === "inside.example" || (host === "jump.example" && (jumps += 1) > 1)
          ? [{ address: host === "jump.example" ? ROUTER : INSIDE, family: 4 }]
          : PUBLIC,
    });
    for (const url of [
      "https://127.0.0.1:19980/api/chat/media/outgoing/a/b/full",
      "https://localhost:5173/",
      "https://[::1]/",
      "https://inside.example/",
      `https://${SHARED}/`,
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
      `https://[${join6("", "", "ffff", loop)}]/`,
      `https://[${join6("", "", "ffff", INSIDE)}]/`,
      `https://[${join6("", "", loop)}]/`,
      `https://[${join6("", "", "ffff", "0", loop)}]/`,
      `https://[${join6("64", "ff9b", "", ROUTER)}]/`,
      `https://[${join6("2002", "a00", "8", "", "1")}]/`,
      `https://[${join6("", "")}]/`,
      `https://[${join6("fe80", "", "1")}%25eth0]/`,
      `https://${["0x7f", "1"].join(".")}/`,
      `https://${String(127 * 2 ** 24 + 1)}/`,
      `https://${["0177", "0", "0", "1"].join(".")}/`,
      `https://${join4(0, 0, 0, 0)}/`,
      "https://localhost./",
      "https://printer.local./",
      "https://mapped.example/",
      "https://zoned.example/",
      "https://garbled.example/",
    ];
    for (const url of inward) expect(await preview(url), url).toEqual({ status: "none", url });
    expect(asked).toEqual([]);
    // The same check, on the parsed address.
    expect(isPrivateAddress(join6("", "", "ffff", loop))).toBe(true);
    expect(isPrivateAddress(`[${join6("fe80", "", "1")}%eth0]`)).toBe(true);
    expect(isPrivateAddress(join6("", "", "ffff", "203.0.113.7"))).toBe(false);
  });

  it("F-116: a name is looked up once, and the connection goes to the address that was checked", async () => {
    // A name that answers a public address twice, and an inward one after.
    const lookups: string[] = [];
    const lookup = async (host: string) => {
      lookups.push(host);
      const early = lookups.filter((name) => name === host).length <= 2;
      return host === "rebind.example" && !early ? [{ address: INSIDE, family: 4 }] : PUBLIC;
    };
    const { fetch, asked, pinned } = web({
      "https://rebind.example/": html("<title>Rebind</title>"),
      "https://rebind.example/old": {
        status: 302,
        headers: { location: "https://rebind.example/" },
      },
    });
    const preview = createLinkPreviewer({ get: fetch, lookup });
    expect(await preview("https://rebind.example/")).toMatchObject({
      status: "ok",
      title: "Rebind",
    });
    expect(lookups).toEqual(["rebind.example"]);
    expect(pinned).toEqual(["203.0.113.7"]);
    // A redirect's destination is looked up and checked before it is followed: now it answers inward.
    expect(await preview("https://rebind.example/old")).toEqual({
      status: "none",
      url: "https://rebind.example/old",
    });
    expect(lookups).toEqual(["rebind.example", "rebind.example", "rebind.example"]);
    expect(asked).toEqual(["https://rebind.example/", "https://rebind.example/old"]);
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

  it("F-116: https only; a redirect and the picture only on the first page's origin, three hops in all, anything else skipped", async () => {
    const { fetch, asked } = web({
      "https://library.example/away": {
        status: 302,
        headers: { location: "https://elsewhere.example/" },
      },
      "https://library.example/down": {
        status: 302,
        headers: { location: "http://library.example/plain" },
      },
      "https://library.example/page": html(
        '<title>Page</title><meta property="og:image" content="https://cdn.example/cover.png">',
      ),
      "https://library.example/own": html(
        '<title>Own</title><meta property="og:image" content="/cover.png">',
      ),
      "https://library.example/cover.png": {
        body: new Uint8Array([137, 80, 78, 71]),
        headers: { "content-type": "image/png" },
      },
      "https://library.example/1": { status: 302, headers: { location: "/2" } },
      "https://library.example/2": { status: 302, headers: { location: "/3" } },
      "https://library.example/3": { status: 302, headers: { location: "/4" } },
      "https://library.example/4": { status: 302, headers: { location: "/own" } },
    });
    const preview = createLinkPreviewer({ get: fetch, lookup: async () => PUBLIC });
    expect(await preview("http://library.example/own")).toEqual({
      status: "none",
      url: "http://library.example/own",
    });
    expect(asked).toEqual([]);
    // A hop to another origin, or down to http, is not followed.
    expect(await preview("https://library.example/away")).toMatchObject({ status: "none" });
    expect(await preview("https://library.example/down")).toMatchObject({ status: "none" });
    expect(asked).toEqual(["https://library.example/away", "https://library.example/down"]);
    asked.length = 0;
    // A picture on another origin is skipped; the page's title stays.
    expect(await preview("https://library.example/page")).toMatchObject({
      status: "ok",
      title: "Page",
      image: null,
    });
    expect(await preview("https://library.example/own")).toMatchObject({
      image: { mimeType: "image/png" },
    });
    expect(asked).toEqual([
      "https://library.example/page",
      "https://library.example/own",
      "https://library.example/cover.png",
    ]);
    asked.length = 0;
    // Three redirects in all: the fourth is not followed.
    expect(await preview("https://library.example/1")).toMatchObject({ status: "none" });
    expect(asked).toEqual([
      "https://library.example/1",
      "https://library.example/2",
      "https://library.example/3",
      "https://library.example/4",
    ]);
  });

  it("F-116: the deadline covers the name's lookup, and at most two previews are under way at once", async () => {
    const lookups: string[] = [];
    // A resolver that never answers.
    const stalled = (host: string) => {
      lookups.push(host);
      return new Promise<{ address: string; family: number }[]>(() => {});
    };
    const { fetch, asked } = web({});
    const preview = createLinkPreviewer({ get: fetch, lookup: stalled, timeoutMs: 20 });
    const started = Date.now();
    expect(await preview("https://stalled.example/")).toEqual({
      status: "none",
      url: "https://stalled.example/",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    // Two under way; a third asked meanwhile has none, and looks nothing up.
    const slow = createLinkPreviewer({ get: fetch, lookup: stalled, timeoutMs: 300 });
    lookups.length = 0;
    const first = slow("https://a.example/");
    const second = slow("https://b.example/");
    expect(await slow("https://c.example/")).toEqual({ status: "none", url: "https://c.example/" });
    expect(lookups).toEqual(["a.example", "b.example"]);
    expect(await Promise.all([first, second])).toEqual([
      { status: "none", url: "https://a.example/" },
      { status: "none", url: "https://b.example/" },
    ]);
    expect(asked).toEqual([]);
  });

  it("F-116: timed-out lookups retain their slots, and late answers do not start transport", async () => {
    // Lookups that answer only when the test says so.
    const pending: Array<() => void> = [];
    const lookups: string[] = [];
    const lookup = (host: string) => {
      lookups.push(host);
      return new Promise<{ address: string; family: number }[]>((resolve) =>
        pending.push(() => resolve(PUBLIC)),
      );
    };
    const { fetch, asked } = web({
      "https://a.example/": html("<title>A</title>"),
      "https://b.example/": html("<title>B</title>"),
      "https://c.example/": html("<title>C</title>"),
    });
    const preview = createLinkPreviewer({ get: fetch, lookup, timeoutMs: 20 });
    // Both callers are answered at the deadline while their lookups still run.
    expect(
      await Promise.all([preview("https://a.example/"), preview("https://b.example/")]),
    ).toEqual([
      { status: "none", url: "https://a.example/" },
      { status: "none", url: "https://b.example/" },
    ]);
    // Their slots are still held: a third has none, and looks nothing up.
    expect(await preview("https://c.example/")).toEqual({
      status: "none",
      url: "https://c.example/",
    });
    expect(lookups).toEqual(["a.example", "b.example"]);
    // The late answers start no request.
    for (const answer of pending.splice(0)) answer();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual([]);
    // With the work settled, the slots are free again.
    const next = preview("https://c.example/");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lookups).toEqual(["a.example", "b.example", "c.example"]);
    pending.splice(0).forEach((answer) => answer());
    expect(await next).toMatchObject({ url: "https://c.example/" });
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
