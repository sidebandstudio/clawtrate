// The web host's upload path: the access cookie and same origin, as for the
// bridge, and the gateway's size ceilings checked before the body is read.

import {
  AttachmentStore,
  createStore,
  initialState,
  MAX_IMAGE_BYTES,
  type ClawtrateClient,
} from "@clawtrate/core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostRuntime } from "../src/host/runtime.ts";
import { ACCESS_COOKIE, startWebHost } from "../src/web-host/server.ts";

const TOKEN = "test-access-token";
let host: ReturnType<typeof startWebHost>;
let base: string;
let store: AttachmentStore;
const cookie = `${ACCESS_COOKIE}=${TOKEN}`;

beforeAll(async () => {
  const staticDir = mkdtempSync(join(tmpdir(), "clawtrate-static-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Clawtrate</title>");
  const state = createStore(initialState);
  let id = 0;
  store = new AttachmentStore({ newId: () => `up-${(id += 1)}` });
  const runtime: HostRuntime = {
    client: {
      store: state,
      get state() {
        return state.get();
      },
    } as unknown as ClawtrateClient,
    info: { kind: "web", version: "test", devGateway: null },
    policy: { attachments: store },
  };
  host = startWebHost({ runtime, staticDir, host: "127.0.0.1", port: 0, accessToken: TOKEN });
  await new Promise((resolve) => host.server.once("listening", resolve));
  base = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
});

afterAll(() => host.close());

/** A raw request, so the declared length can differ from what is sent. */
function upload(
  query: string,
  headers: Record<string, string>,
  body: Buffer | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/attachments?${query}`, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
        }),
      );
    });
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}

describe("web host file uploads (F-074, F-285)", () => {
  it("keeps a file sent with the access cookie and returns its id", async () => {
    const data = Buffer.from("hello");
    const result = await upload(
      "name=note.txt&type=text%2Fplain",
      { cookie, origin: base, "content-length": "5" },
      data,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      fileName: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    expect(store.get([result.body.id as string])[0]).toMatchObject({
      content: data.toString("base64"),
    });
  });

  it("refuses without the cookie or from another origin", async () => {
    const data = Buffer.from("x");
    expect(
      (await upload("name=a.txt&type=text%2Fplain", { "content-length": "1" }, data)).status,
    ).toBe(401);
    expect(
      (
        await upload(
          "name=a.txt&type=text%2Fplain",
          { cookie, origin: "http://evil.example", "content-length": "1" },
          data,
        )
      ).status,
    ).toBe(401);
  });

  it("refuses an oversized image from its declared length, before reading the body", async () => {
    const result = await upload(
      "name=big.png&type=image%2Fpng",
      { cookie, origin: base, "content-length": String(MAX_IMAGE_BYTES + 1) },
      null,
    );
    expect(result.status).toBe(413);
    expect(String(result.body.error)).toMatch(/at most 6291456/);
  });

  it("requires a declared length", async () => {
    const result = await upload(
      "name=a.txt&type=text%2Fplain",
      { cookie, origin: base, "transfer-encoding": "chunked" },
      Buffer.from("x"),
    );
    expect(result.status).toBe(411);
  });

  it("rejects a malformed file name", async () => {
    const result = await upload(
      "name=..%2Fa&type=text%2Fplain",
      { cookie, origin: base, "content-length": "1" },
      Buffer.from("x"),
    );
    expect(result.status).toBe(400);
  });
});
