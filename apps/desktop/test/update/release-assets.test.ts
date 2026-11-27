// The one redirect the engine follows: a file the feed names at the project's
// own GitHub release download, sent on to GitHub's release-asset host. Every
// other redirect stays refused, and the file's size and SHA-512 are still the
// feed's. The engine half runs against a stand-in on 127.0.0.1 that plays both
// GitHub hosts; the address half checks the production rule itself.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GITHUB_RELEASE_ASSETS,
  isReleaseDownload,
  releaseAssetRedirect,
  type ReleaseAssets,
} from "../../src/main/update/address.ts";
import { parseFeed } from "../../src/main/update/feed.ts";
import { bytes, engineFor, feedFor, feedServer, json, payload, tempDir } from "./harness.ts";
import type { FeedServer, Handler } from "./harness.ts";

const RELEASE = "https://github.com/sidebandstudio/clawtrate/releases/download/";
const ASSET = "https://release-assets.githubusercontent.com/github-production-release-asset/1/2";
const FILE = `${RELEASE}v0.2.0-beta.20261120.1/Clawtrate-0.2.0-beta.20261120.1-mac-arm64.zip`;

describe("the production rule for release downloads", () => {
  it("names this repository's release downloads and GitHub's release-asset host", () => {
    expect(GITHUB_RELEASE_ASSETS).toEqual({
      downloadPrefix: RELEASE,
      assetOrigins: ["https://release-assets.githubusercontent.com"],
    });
  });

  it.each([
    [FILE, true],
    [`${RELEASE}v1/a.zip`, true],
    [`${RELEASE}v1/a.zip?x=1`, false],
    [`${RELEASE}v1/a.zip#x`, false],
    [`${RELEASE}a.zip`, false],
    [`${RELEASE}v1/sub/a.zip`, false],
    [`${RELEASE}v1/`, false],
    [`${RELEASE}v1/%2e%2e`, false],
    [`${RELEASE}v1/a%20b.zip`, false],
    ["https://user:pass@github.com/sidebandstudio/clawtrate/releases/download/v1/a.zip", false],
    ["https://github.com/sidebandstudio/other/releases/download/v1/a.zip", false],
    ["https://github.com/sidebandstudio/clawtrate/releases/latest/download/a.zip", false],
    ["https://github.com.evil.example/sidebandstudio/clawtrate/releases/download/v1/a.zip", false],
    ["http://github.com/sidebandstudio/clawtrate/releases/download/v1/a.zip", false],
    ["https://github.com:8443/sidebandstudio/clawtrate/releases/download/v1/a.zip", false],
  ])("%s is a release download: %s", (text, expected) => {
    expect(isReleaseDownload(new URL(text), GITHUB_RELEASE_ASSETS)).toBe(expected);
  });

  it("follows a release download to the asset host, and nothing else anywhere", () => {
    const from = new URL(FILE);
    const follow = (location: string | undefined, origin: URL = from) =>
      releaseAssetRedirect(origin, location, GITHUB_RELEASE_ASSETS)?.href ?? null;
    expect(follow(`${ASSET}?sp=r&sig=abc`)).toBe(`${ASSET}?sp=r&sig=abc`);
    expect(follow(undefined)).toBeNull();
    expect(follow("")).toBeNull();
    // The asset host before GitHub moved release files.
    expect(follow("https://objects.githubusercontent.com/x")).toBeNull();
    expect(follow("http://release-assets.githubusercontent.com/x")).toBeNull();
    expect(follow("https://release-assets.githubusercontent.com:444/x")).toBeNull();
    expect(follow("https://u:p@release-assets.githubusercontent.com/x")).toBeNull();
    expect(follow(`${ASSET}#part`)).toBeNull();
    // Relative to github.com, so not on the asset host.
    expect(follow("/sidebandstudio/clawtrate/x")).toBeNull();
    expect(follow("https://elsewhere.example/x")).toBeNull();
    // A redirect from anywhere but a release download is refused.
    expect(follow(ASSET, new URL("https://clawtrate.dev/updates/beta/a.zip"))).toBeNull();
    expect(follow(ASSET, new URL(`${RELEASE}v1/a.zip?x=1`))).toBeNull();
  });

  it("lets a feed on the site name files at this repository's release downloads", () => {
    const feedUrl = new URL("https://clawtrate.dev/updates/beta/feed.json");
    const sha512 = payload(10).sha512;
    const feed = (url: string) =>
      JSON.stringify({
        format: 1,
        track: "nightly",
        version: "0.2.0-beta.20261120.1",
        releaseDate: "2026-11-20T00:00:00.000Z",
        files: { "mac-arm64": { url, size: 10, sha512 }, "mac-x64": { url, size: 10, sha512 } },
      });
    const read = (url: string) => parseFeed(feed(url), feedUrl, "mac-arm64", undefined, "nightly");
    expect(read(FILE)).toMatchObject({ ok: true, feed: { file: { url: new URL(FILE) } } });
    expect(read("https://clawtrate.dev/updates/beta/a.zip").ok).toBe(true);
    for (const refused of [
      "https://github.com/sidebandstudio/other/releases/download/v1/a.zip",
      `${RELEASE}v1/a.zip?redirect=1`,
      `${ASSET}?sig=abc`,
      "https://example.org/a.zip",
    ]) {
      expect(read(refused), refused).toEqual({ ok: false, cause: "address-refused" });
    }
  });
});

describe("the engine follows one release-asset redirect", () => {
  let server: FeedServer;
  let dir: { path: string; remove(): void };
  let releases: ReleaseAssets;
  beforeEach(async () => {
    server = await feedServer();
    dir = tempDir();
    releases = {
      downloadPrefix: `${server.origin}/releases/download/`,
      assetOrigins: [server.origin],
    };
  });
  afterEach(async () => {
    try {
      dir.remove();
    } finally {
      await server.close();
    }
  });

  const downloads = () => (existsSync(dir.path) ? readdirSync(dir.path) : []);
  const redirect =
    (location: string | undefined, status = 302): Handler =>
    (_request, response) => {
      response.writeHead(status, location === undefined ? {} : { location }).end();
    };
  const RELEASE_PATH = "/releases/download/v0.2.0/app.zip";

  async function offer(body: Buffer, sha512: string, path = RELEASE_PATH) {
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: body.length, sha512, path })),
    );
    const { engine } = engineFor(server, dir.path, { releaseAssetsForTests: releases });
    expect((await engine.check()).kind).toBe("available");
    return engine;
  }

  it("downloads through the redirect and keeps the file whose hash is the feed's", async () => {
    const file = payload(1_200_000);
    server.route(RELEASE_PATH, redirect(`${server.origin}/asset/1?sig=a`));
    server.route("/asset/1?sig=a", bytes(file.body));
    const engine = await offer(file.body, file.sha512);
    const ready = await engine.download();
    expect(ready.kind).toBe("ready");
    if (ready.kind === "ready") expect(readFileSync(ready.path).equals(file.body)).toBe(true);
    expect(server.requests).toEqual(["/feed.json", RELEASE_PATH, "/asset/1?sig=a"]);
  });

  it.each([301, 303, 307, 308])("follows a %i the same way", async (status) => {
    const file = payload();
    server.route(RELEASE_PATH, redirect("/asset/2", status));
    server.route("/asset/2", bytes(file.body));
    const engine = await offer(file.body, file.sha512);
    expect((await engine.download()).kind).toBe("ready");
  });

  it("still refuses bytes that do not match the feed after the redirect", async () => {
    const file = payload();
    const tampered = Buffer.from(file.body);
    tampered[7] = tampered[7]! ^ 0xff;
    server.route(RELEASE_PATH, redirect("/asset/3"));
    server.route("/asset/3", bytes(tampered));
    const engine = await offer(file.body, file.sha512);
    expect(await engine.download()).toEqual({
      kind: "failed",
      stage: "download",
      cause: "hash-mismatch",
    });
    expect(downloads()).toEqual([]);
  });

  it("refuses a second redirect from the asset host", async () => {
    const file = payload();
    server.route(RELEASE_PATH, redirect("/asset/4"));
    server.route("/asset/4", redirect("/asset/5", 307));
    server.route("/asset/5", bytes(file.body));
    const engine = await offer(file.body, file.sha512);
    expect(await engine.download()).toEqual({
      kind: "failed",
      stage: "download",
      cause: "redirect-refused",
      status: 307,
    });
    expect(server.requests).toEqual(["/feed.json", RELEASE_PATH, "/asset/4"]);
    expect(downloads()).toEqual([]);
  });

  it.each([
    ["another host", "https://elsewhere.example/asset"],
    ["another port", "http://127.0.0.1:1/asset"],
    ["no location", undefined],
  ])("refuses a redirect to %s without requesting it", async (_name, location) => {
    const file = payload();
    server.route(RELEASE_PATH, redirect(location));
    const engine = await offer(file.body, file.sha512);
    expect(await engine.download()).toEqual({
      kind: "failed",
      stage: "download",
      cause: "redirect-refused",
      status: 302,
    });
    expect(server.requests).toEqual(["/feed.json", RELEASE_PATH]);
  });

  it("refuses a redirect from a file outside the release downloads", async () => {
    const file = payload();
    server.route("/files/app.zip", redirect("/asset/6"));
    server.route("/asset/6", bytes(file.body));
    const engine = await offer(file.body, file.sha512, "/files/app.zip");
    expect(await engine.download()).toMatchObject({ cause: "redirect-refused", status: 302 });
    expect(server.requests).toEqual(["/feed.json", "/files/app.zip"]);
  });

  it("follows no redirect for the feed, even from a release download", async () => {
    server.route("/releases/download/v1/feed.json", redirect("/asset/feed.json"));
    server.route("/asset/feed.json", json({}));
    const { engine } = engineFor(server, dir.path, {
      feedAddress: `${server.origin}/releases/download/v1/feed.json`,
      releaseAssetsForTests: releases,
    });
    expect(await engine.check()).toEqual({
      kind: "failed",
      stage: "check",
      cause: "redirect-refused",
      status: 302,
    });
    expect(server.requests).toEqual(["/releases/download/v1/feed.json"]);
  });
});
