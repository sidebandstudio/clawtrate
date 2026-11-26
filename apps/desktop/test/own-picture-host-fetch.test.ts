// A person's own picture read back through the desktop host's own fetch
// (`createNodeHost`), against a stand-in of the gateway's media route on
// loopback (#469). The address the product sees is `wss://gateway.example`,
// which qualifies; the test delivers its requests to the stand-in. The token
// arrives as a header on the ticket request only, and a redirect isn't followed.

import { fetchInboundPicture, INBOUND_MEDIA_ROUTE, type HttpFetch } from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://gateway.example";
const KEY = "agent:otto:disk-space";
const SOURCE = "media://inbound/shot---73854bc7-ae01-4c53-8af5-f02e678613b1.png";
const TOKEN = "device-token";
/** A ticket in the gateway's form: `v1`, a payload and a signature, each base64url. Made up. */
const TICKET = ["v1", "c2NvcGU", "c2lnbmF0dXJl"].join(".");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("F-557: your picture read back through the desktop host's fetch", () => {
  let server: Server;
  let port = 0;
  let mode: "picture" | "redirect" = "picture";
  const seen: Array<{ url: string; authorization: string | undefined }> = [];
  const data = mkdtempSync(join(tmpdir(), "clawtrate-host-fetch-"));
  const host = createNodeHost({
    dataDir: data,
    client: { displayName: "Clawtrate Test", version: "0.0.0", platform: "test" },
  });

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push({ url: request.url!, authorization: request.headers.authorization });
      const url = new URL(request.url!, "http://stand-in");
      if (mode === "redirect") response.writeHead(302, { location: "/elsewhere" }).end();
      else if (url.searchParams.get("meta") === "1")
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(
          JSON.stringify({
            available: true,
            mimeType: "image/png",
            sizeBytes: PNG.length,
            mediaTicket: TICKET,
            mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
        );
      else response.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(PNG));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(data, { recursive: true, force: true });
  });

  const viaStandIn: HttpFetch = (url, init) =>
    host.fetch!(url.replace(ORIGIN, `http://127.0.0.1:${port}`), init);
  const ctx = {
    fetch: viaStandIn,
    gatewayUrl: "wss://gateway.example",
    token: TOKEN,
    now: () => Date.now(),
  };

  it("F-557: the token arrives as a header on the ticket request only, and the bytes are the gateway's", async () => {
    mode = "picture";
    seen.length = 0;
    expect(await fetchInboundPicture(ctx, KEY, SOURCE)).toEqual({
      status: "bytes",
      mimeType: "image/png",
      bytes: PNG,
    });
    expect(seen.map((each) => each.authorization)).toEqual([`Bearer ${TOKEN}`, undefined]);
    expect(seen.every((each) => !each.url.includes(TOKEN))).toBe(true);
    expect(
      seen.map((each) => new URL(each.url, "http://x").searchParams.get("sessionKey")),
    ).toEqual([KEY, KEY]);
  });

  it("F-557: a redirect is not followed, and the picture is one this connection can't load", async () => {
    mode = "redirect";
    seen.length = 0;
    expect(await fetchInboundPicture(ctx, KEY, SOURCE)).toEqual({ status: "cannot-load" });
    expect(seen.map((each) => new URL(each.url, "http://x").pathname)).toEqual([
      INBOUND_MEDIA_ROUTE,
    ]);
  });
});
