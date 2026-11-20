// The update engine end to end against a feed server of the test's own on
// 127.0.0.1: a newer version found, downloaded, verified and ready, and each
// refusal with its state. Nothing is installed; docs/decisions.md, "Updates and
// release signing", says where this stops on each system.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUpdateRequired, UpdateEngine, type UpdateState } from "../../src/main/update/index.ts";
import {
  bytes,
  engineFor,
  feedFor,
  feedServer,
  json,
  payload,
  tempDir,
  type FeedServer,
  type Handler,
} from "./harness.ts";

let server: FeedServer;
let dir: { path: string; remove(): void };

beforeEach(async () => {
  server = await feedServer();
  dir = tempDir();
});
afterEach(async () => {
  await server.close();
  dir.remove();
});

const failed = (stage: "check" | "download", cause: string, status?: number): UpdateState =>
  status === undefined
    ? ({ kind: "failed", stage, cause } as UpdateState)
    : ({ kind: "failed", stage, cause, status } as UpdateState);

/** The download folder holds nothing: no file kept, no partial left. */
const downloads = () => (existsSync(dir.path) ? readdirSync(dir.path) : []);

describe("the update engine against a local feed", () => {
  it("finds a newer version, downloads it, verifies its size and hash and reports it ready", async () => {
    const file = payload(2_500_000);
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", bytes(file.body));
    const { engine, states } = engineFor(server, join(dir.path, "updates"));

    expect(await engine.check()).toEqual({
      kind: "available",
      version: "0.2.0",
      releaseDate: "2026-11-01T00:00:00.000Z",
    });
    expect(engine.newer).toEqual({ version: "0.2.0", releaseDate: "2026-11-01T00:00:00.000Z" });
    const ready = await engine.download();
    const path = join(dir.path, "updates", "Clawtrate-0.2.0-mac-arm64.zip");
    expect(ready).toEqual({
      kind: "ready",
      version: "0.2.0",
      releaseDate: "2026-11-01T00:00:00.000Z",
      path,
    });
    expect(readFileSync(path).equals(file.body)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir.path, "updates")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir.path, "updates"))).toEqual(["Clawtrate-0.2.0-mac-arm64.zip"]);

    const kinds = states.map((state) => state.kind);
    expect(kinds[0]).toBe("checking");
    expect(kinds[1]).toBe("available");
    expect(kinds.at(-1)).toBe("ready");
    const progress = states.filter((state) => state.kind === "downloading");
    expect(progress[0]).toMatchObject({ received: 0, total: file.body.length });
    expect(progress.at(-1)).toMatchObject({ received: file.body.length, total: file.body.length });
    expect(progress.length).toBeLessThanOrEqual(5);
    expect(server.requests).toEqual(["/feed.json", "/files/app.zip"]);
  });

  it("deletes a tampered download of the right size and reports hash-mismatch", async () => {
    const file = payload();
    const tampered = Buffer.from(file.body);
    tampered[1000] = tampered[1000]! ^ 0xff;
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", bytes(tampered));
    const { engine } = engineFor(server, dir.path);
    await engine.check();
    expect(await engine.download()).toEqual(failed("download", "hash-mismatch"));
    expect(downloads()).toEqual([]);
  });

  it("stops a download that runs past the feed's size, deletes it and reports size-mismatch", async () => {
    const file = payload();
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length - 10, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", bytes(file.body, { chunked: true }));
    const { engine } = engineFor(server, dir.path);
    await engine.check();
    expect(await engine.download()).toEqual(failed("download", "size-mismatch"));
    expect(downloads()).toEqual([]);
  });

  it("deletes a download that ends short of the feed's size and reports size-mismatch", async () => {
    const file = payload();
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length + 10, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", bytes(file.body, { chunked: true }));
    const { engine } = engineFor(server, dir.path);
    await engine.check();
    expect(await engine.download()).toEqual(failed("download", "size-mismatch"));
    expect(downloads()).toEqual([]);
  });

  it("refuses a download whose declared length is not the feed's before writing a byte", async () => {
    const file = payload();
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length + 1, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", bytes(file.body));
    const { engine } = engineFor(server, dir.path);
    await engine.check();
    expect(await engine.download()).toEqual(failed("download", "size-mismatch"));
    expect(downloads()).toEqual([]);
  });

  for (const version of ["0.0.9", "0.1.0"]) {
    it(`never downloads ${version === "0.1.0" ? "the same version" : "an older version"} (${version} against 0.1.0)`, async () => {
      const file = payload();
      server.route(
        "/feed.json",
        json(feedFor(server.origin, version, { size: file.body.length, sha512: file.sha512 })),
      );
      server.route("/files/app.zip", bytes(file.body));
      const { engine } = engineFor(server, dir.path);
      expect(await engine.check()).toEqual({ kind: "up-to-date", latest: version });
      expect(engine.newer).toBeNull();
      expect(await engine.download()).toEqual({ kind: "up-to-date", latest: version });
      expect(server.requests).toEqual(["/feed.json"]);
      expect(downloads()).toEqual([]);
    });
  }

  it("refuses a file larger than the download bound from the feed's own size, without requesting it", async () => {
    const file = payload(5000);
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", bytes(file.body));
    const { engine } = engineFor(server, dir.path, { limits: { maxDownloadBytes: 4096 } });
    expect(await engine.check()).toEqual(failed("check", "too-large"));
    expect(await engine.download()).toEqual(failed("check", "too-large"));
    expect(server.requests).toEqual(["/feed.json"]);
  });

  it("refuses a feed larger than its bound, declared or not", async () => {
    const file = payload(100);
    const big = feedFor(
      server.origin,
      "0.2.0",
      { size: 100, sha512: file.sha512 },
      { padding: "x".repeat(2000) },
    );
    server.route("/feed.json", json(big));
    server.route("/chunked.json", (_request, response) => {
      response.writeHead(200);
      response.write(JSON.stringify(big));
      response.end();
    });
    const declared = engineFor(server, dir.path, { limits: { maxFeedBytes: 1024 } }).engine;
    expect(await declared.check()).toEqual(failed("check", "too-large"));
    const chunked = engineFor(server, dir.path, {
      feedAddress: `${server.origin}/chunked.json`,
      limits: { maxFeedBytes: 1024 },
    }).engine;
    expect(await chunked.check()).toEqual(failed("check", "too-large"));
  });

  it("refuses a feed that declares more than its bound at once, without waiting for a body that never comes", async () => {
    server.route("/feed.json", (_request, response) => {
      response.writeHead(200, { "content-length": String(64 * 1024 + 1) });
      response.flushHeaders();
    });
    const { engine } = engineFor(server, dir.path, { limits: { feedTimeoutMs: 2000 } });
    expect(await engine.check()).toEqual(failed("check", "too-large"));
  });

  it("counts F-010 from the build's own date it was given, and only while a newer version is on offer", async () => {
    const file = payload();
    let body: unknown = feedFor(server.origin, "0.2.0", {
      size: file.body.length,
      sha512: file.sha512,
    });
    server.route("/feed.json", (request, response) => json(body)(request, response));
    const now = new Date("2026-11-19T00:00:00.000Z");
    const old = engineFor(server, dir.path, {
      buildReleaseDate: "2026-11-04T23:59:59.000Z",
    }).engine;
    const recent = engineFor(server, dir.path, {
      buildReleaseDate: "2026-11-05T00:00:00.000Z",
    }).engine;
    expect(old.updateRequired(now)).toBe(false);
    await old.check();
    await recent.check();
    expect(old.updateRequired(now)).toBe(true);
    expect(recent.updateRequired(now)).toBe(false);
    body = "{ not json";
    await old.check();
    expect(old.updateRequired(now)).toBe(false);
  });

  it("reports an unreachable feed as unreachable", async () => {
    const port = server.port;
    await server.close();
    const engine = new UpdateEngine({
      feedAddress: `http://127.0.0.1:${port}/feed.json`,
      currentVersion: "0.1.0",
      downloadDir: dir.path,
      platform: "darwin",
      arch: "arm64",
      loopbackHttpForTests: { port },
    });
    expect(await engine.check()).toEqual(failed("check", "unreachable"));
    server = await feedServer();
  });

  it("reads an https address: a closed loopback port is unreachable, not refused", async () => {
    const port = server.port;
    await server.close();
    const engine = new UpdateEngine({
      feedAddress: `https://127.0.0.1:${port}/feed.json`,
      currentVersion: "0.1.0",
      downloadDir: dir.path,
      platform: "darwin",
      arch: "arm64",
    });
    expect(await engine.check()).toEqual(failed("check", "unreachable"));
    server = await feedServer();
  });

  it("follows no redirect, to another host or to its own", async () => {
    server.route("/feed.json", (_request, response) => {
      response.writeHead(302, { location: "https://elsewhere.example/feed.json" }).end();
    });
    server.route("/same.json", (_request, response) => {
      response.writeHead(301, { location: "/feed2.json" }).end();
    });
    expect(await engineFor(server, dir.path).engine.check()).toEqual(
      failed("check", "redirect-refused", 302),
    );
    expect(
      await engineFor(server, dir.path, {
        feedAddress: `${server.origin}/same.json`,
      }).engine.check(),
    ).toEqual(failed("check", "redirect-refused", 301));

    const file = payload();
    server.route(
      "/feed3.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", (_request, response) => {
      response.writeHead(307, { location: "https://elsewhere.example/app.zip" }).end();
    });
    const { engine } = engineFor(server, dir.path, { feedAddress: `${server.origin}/feed3.json` });
    await engine.check();
    expect(await engine.download()).toEqual(failed("download", "redirect-refused", 307));
    expect(server.requests).toEqual(["/feed.json", "/same.json", "/feed3.json", "/files/app.zip"]);
    expect(downloads()).toEqual([]);
  });

  it("reports another status by its number", async () => {
    server.route("/feed.json", (_request, response) => response.writeHead(503).end());
    expect(await engineFor(server, dir.path).engine.check()).toEqual(
      failed("check", "http-status", 503),
    );
  });

  it("gives up on a feed that does not answer in time", async () => {
    server.route("/feed.json", () => undefined);
    const { engine } = engineFor(server, dir.path, { limits: { feedTimeoutMs: 300 } });
    const started = Date.now();
    expect(await engine.check()).toEqual(failed("check", "timed-out"));
    expect(Date.now() - started).toBeLessThan(5000);
  });

  /** Sends a byte every 20 ms until the client goes, never ending the response. */
  const trickle: Handler = (_request, response) => {
    response.writeHead(200);
    const timer = setInterval(() => response.write(" "), 20);
    response.on("close", () => clearInterval(timer));
  };

  it("gives up on a feed that keeps trickling past its overall time", async () => {
    server.route("/feed.json", trickle);
    const { engine } = engineFor(server, dir.path, { limits: { feedTimeoutMs: 400 } });
    expect(await engine.check()).toEqual(failed("check", "timed-out"));
  });

  it("gives up on a download that keeps trickling past its overall time, and deletes it", async () => {
    server.route("/feed.json", json(feedFor(server.origin, "0.2.0", payloadEntry())));
    server.route("/files/app.zip", trickle);
    const { engine } = engineFor(server, dir.path, {
      limits: { downloadTimeoutMs: 400 },
    });
    await engine.check();
    expect(await engine.download()).toEqual(failed("download", "timed-out"));
    expect(downloads()).toEqual([]);
  });

  it("stops a download the moment it passes the feed's size, not when the server stops", async () => {
    server.route("/feed.json", json(feedFor(server.origin, "0.2.0", payloadEntry())));
    server.route("/files/app.zip", (_request, response) => {
      response.writeHead(200);
      const timer = setInterval(() => response.write(Buffer.alloc(64)), 5);
      response.on("close", () => clearInterval(timer));
    });
    // Without the early stop this would run to the overall deadline.
    const { engine } = engineFor(server, dir.path, { limits: { downloadTimeoutMs: 3000 } });
    await engine.check();
    expect(await engine.download()).toEqual(failed("download", "size-mismatch"));
    expect(downloads()).toEqual([]);
  });

  it("gives up on a download that stops sending, and deletes what it wrote", async () => {
    const file = payload();
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", (_request, response) => {
      response.writeHead(200, { "content-length": String(file.body.length) });
      response.write(file.body.subarray(0, 1000));
    });
    const { engine } = engineFor(server, dir.path, { limits: { idleTimeoutMs: 300 } });
    await engine.check();
    expect(await engine.download()).toEqual(failed("download", "timed-out"));
    expect(downloads()).toEqual([]);
  });

  it("makes a malformed feed one typed failure, and checks again afterwards", async () => {
    const file = payload(100);
    const good = feedFor(server.origin, "0.2.0", { size: 100, sha512: file.sha512 });
    const entry = (good.files as Record<string, Record<string, unknown>>)["mac-arm64"]!;
    const bodies: unknown[] = [
      "not json",
      "alert(1)",
      "",
      "[]",
      "null",
      { ...good, format: 2 },
      { ...good, version: "0.2" },
      { ...good, version: "v0.2.0" },
      { ...good, version: "0.2.0-beta.1" },
      { ...good, version: "<img src=x onerror=alert(1)>" },
      { ...good, releaseDate: "yesterday" },
      { ...good, releaseDate: "2026-11-01T00:00:00Z<script>" },
      { ...good, files: [] },
      { ...good, files: { "mac-arm64": { ...entry, size: -1 } } },
      { ...good, files: { "mac-arm64": { ...entry, size: "100" } } },
      { ...good, files: { "mac-arm64": { ...entry, sha512: "abc" } } },
      { ...good, files: { "mac-arm64": { ...entry, url: "not a url" } } },
      { ...good, files: { "linux-x64": entry } },
    ];
    for (const [i, body] of bodies.entries()) {
      server.route(`/bad-${i}.json`, json(body));
      const { engine } = engineFor(server, dir.path, {
        feedAddress: `${server.origin}/bad-${i}.json`,
      });
      expect(await engine.check(), JSON.stringify(body)).toEqual(failed("check", "malformed-feed"));
    }
    server.route("/feed.json", json(good));
    expect((await engineFor(server, dir.path).engine.check()).kind).toBe("available");
  });

  it("reads plain http only from the test's own loopback port, and only with the test's option", async () => {
    server.route("/feed.json", json(feedFor(server.origin, "0.2.0", payloadEntry())));
    const without = new UpdateEngine({
      feedAddress: `${server.origin}/feed.json`,
      currentVersion: "0.1.0",
      downloadDir: dir.path,
      platform: "darwin",
      arch: "arm64",
    });
    expect(await without.check()).toEqual(failed("check", "address-refused"));
    const otherPort = engineFor(server, dir.path, {
      loopbackHttpForTests: { port: server.port + 1 },
    }).engine;
    expect(await otherPort.check()).toEqual(failed("check", "address-refused"));
    const otherHost = engineFor(server, dir.path, {
      feedAddress: `http://localhost:${server.port}/feed.json`,
    }).engine;
    expect(await otherHost.check()).toEqual(failed("check", "address-refused"));
    expect(server.requests).toEqual([]);
    expect((await engineFor(server, dir.path).engine.check()).kind).toBe("available");
  });

  it("refuses a file on another origin than the feed's", async () => {
    for (const url of [
      "https://elsewhere.example/app.zip",
      `http://127.0.0.1:${server.port + 1}/app.zip`,
    ]) {
      server.route(
        "/feed.json",
        json({
          ...feedFor(server.origin, "0.2.0", payloadEntry()),
          files: { "mac-arm64": { ...payloadEntry(), url } },
        }),
      );
      const { engine } = engineFor(server, dir.path);
      expect(await engine.check()).toEqual(failed("check", "address-refused"));
    }
  });

  it("passes on nothing from the feed but the checked version and the release date Date wrote", async () => {
    server.route(
      "/feed.json",
      json(
        feedFor(server.origin, "0.2.0", payloadEntry(), {
          releaseDate: "2026-11-01T00:00:00Z",
          releaseName: "<b>Name</b>",
          releaseNotes: "<script>alert(1)</script>",
          html: "<img src=x onerror=alert(1)>",
        }),
      ),
    );
    const { engine, states } = engineFor(server, dir.path);
    expect(await engine.check()).toEqual({
      kind: "available",
      version: "0.2.0",
      releaseDate: "2026-11-01T00:00:00.000Z",
    });
    const told = JSON.stringify([states, engine.newer]);
    expect(told).not.toMatch(/<|>|alert|Name|releaseNotes|releaseName/);
  });

  it("reports a feed with no file for this system as no-file-for-this-system", async () => {
    server.route("/feed.json", json(feedFor(server.origin, "0.2.0", payloadEntry())));
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["linux", "x64"],
      ["darwin", "x64"],
    ]) {
      const { engine } = engineFor(server, dir.path, { platform: platform!, arch: arch! });
      expect(await engine.check()).toEqual(failed("check", "no-file-for-this-system"));
      expect(await engine.download()).toEqual(failed("check", "no-file-for-this-system"));
    }
  });

  it("makes no request when the build has no feed", async () => {
    for (const feedAddress of [null, "", "https://updates.example/clawtrate/feed.json"]) {
      const { engine } = engineFor(server, dir.path, { feedAddress });
      expect(await engine.check()).toEqual({ kind: "not-configured" });
    }
    expect(server.requests).toEqual([]);
  });

  it("forgets the last check's offer when a check fails, so nothing is required or downloaded from it", async () => {
    const file = payload();
    const good = feedFor(server.origin, "0.2.0", { size: file.body.length, sha512: file.sha512 });
    let body: unknown = good;
    server.route("/feed.json", (request, response) => json(body)(request, response));
    server.route("/files/app.zip", bytes(file.body));
    const { engine } = engineFor(server, dir.path);
    const stale = "2026-01-01T00:00:00.000Z";
    const now = new Date("2026-11-19T00:00:00.000Z");

    expect((await engine.check()).kind).toBe("available");
    expect(isUpdateRequired(engine.newer, stale, now)).toBe(true);
    body = "{ not json";
    expect(await engine.check()).toEqual(failed("check", "malformed-feed"));
    expect(engine.newer).toBeNull();
    expect(isUpdateRequired(engine.newer, stale, now)).toBe(false);
    expect(await engine.download()).toEqual(failed("check", "malformed-feed"));
    expect(server.requests).toEqual(["/feed.json", "/feed.json"]);
    expect(downloads()).toEqual([]);
  });

  it("answers a second check while the first runs with the first's result", async () => {
    server.route("/feed.json", json(feedFor(server.origin, "0.2.0", payloadEntry())));
    const { engine } = engineFor(server, dir.path);
    const [first, second] = await Promise.all([engine.check(), engine.check()]);
    expect(second).toBe(first);
    expect(server.requests).toEqual(["/feed.json"]);
  });

  it("answers a check asked for from inside the checking state with the same one", async () => {
    server.route("/feed.json", json(feedFor(server.origin, "0.2.0", payloadEntry())));
    let asked = false;
    let inner: Promise<UpdateState> | undefined;
    const engine: UpdateEngine = engineFor(server, dir.path, {
      onState: (state) => {
        if (state.kind === "checking" && !asked) {
          asked = true;
          inner = engine.check();
        }
      },
    }).engine;
    const outer = engine.check();
    const result = await outer;
    expect(await inner).toBe(result);
    expect(inner).toBe(outer);
    expect(server.requests).toEqual(["/feed.json"]);
  });
});

function payloadEntry(): { size: number; sha512: string } {
  return { size: 100, sha512: `${"A".repeat(86)}==` };
}
