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
import { ACCESS_COOKIE, startWebHost, UPLOAD_DEADLINE_MS } from "../src/web-host/server.ts";

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
      withdraw: () => {},
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

  it("refuses, and keeps nothing, without the cookie, without an origin, from https, or with only the link's token", async () => {
    const data = Buffer.from("x");
    const before = store.available();
    const port = new URL(base).port;
    const cases: Array<[string, Record<string, string>, string]> = [
      ["cookie, no origin", { cookie, "content-length": "1" }, ""],
      [
        "cookie, https origin on the http listener",
        { cookie, origin: `https://127.0.0.1:${port}`, "content-length": "1" },
        "",
      ],
      [
        "link token, right origin, no cookie",
        { origin: base, "content-length": "1" },
        `&token=${TOKEN}`,
      ],
      [
        "cookie, origin with a path",
        { cookie, origin: `${base}/attachments`, "content-length": "1" },
        "",
      ],
      [
        "cookie, same host on another port",
        { cookie, origin: `http://127.0.0.1:${Number(port) + 1}`, "content-length": "1" },
        "",
      ],
    ];
    for (const [name, headers, query] of cases) {
      const result = await upload(`name=a.txt&type=text%2Fplain${query}`, headers, data);
      expect([name, result.status]).toEqual([name, 401]);
    }
    expect(store.available()).toBe(before);
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

describe(`an upload must arrive within its deadline (UPLOAD_DEADLINE_MS = ${UPLOAD_DEADLINE_MS})`, () => {
  const DEADLINE = 400;
  let slowHost: ReturnType<typeof startWebHost>;
  let slowBase: string;
  let slowStore: AttachmentStore;

  beforeAll(async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "clawtrate-static-"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Clawtrate</title>");
    const state = createStore(initialState);
    let id = 0;
    slowStore = new AttachmentStore({ newId: () => `slow-${(id += 1)}` });
    slowHost = startWebHost({
      runtime: {
        client: {
          store: state,
          get state() {
            return state.get();
          },
          withdraw: () => {},
        } as unknown as ClawtrateClient,
        info: { kind: "web", version: "test", devGateway: null },
        policy: { attachments: slowStore },
      },
      staticDir,
      host: "127.0.0.1",
      port: 0,
      accessToken: TOKEN,
      uploadDeadlineMs: DEADLINE,
    });
    await new Promise((resolve) => slowHost.server.once("listening", resolve));
    slowBase = `http://127.0.0.1:${(slowHost.server.address() as AddressInfo).port}`;
  });

  afterAll(() => slowHost.close());

  /** Send half the body, then the rest after `restAfterMs`, or never. */
  function slowUpload(restAfterMs: number | null): Promise<number> {
    return new Promise((resolve) => {
      const req = request(
        `${slowBase}/attachments?name=slow.txt&type=text%2Fplain`,
        { method: "POST", headers: { cookie, origin: slowBase, "content-length": "10" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", () => resolve(0));
      req.write("12345");
      if (restAfterMs !== null) setTimeout(() => req.end("67890"), restAfterMs);
    });
  }

  it("keeps a file whose body finishes before the deadline", async () => {
    expect(await slowUpload(DEADLINE / 4)).toBe(200);
  });

  it("answers 408 at the deadline for a body that never ends, keeps nothing and gives its room back", async () => {
    const before = slowStore.available();
    const started = Date.now();
    expect(await slowUpload(null)).toBe(408);
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEADLINE - 20);
    expect(slowStore.available()).toBe(before);
    const health = await fetch(`${slowBase}/healthz`);
    expect(health.status).toBe(200);
  });
});
