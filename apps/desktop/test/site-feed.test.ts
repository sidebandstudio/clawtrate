// The site takes its Beta feed from the newest published beta release, and
// only after checking the feed and latest-mac.json against each other and the
// release's tag. GitHub's API and downloads are stand-ins here.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBetaFiles, makeLatestMac, releaseFolder } from "../packaging/beta-files.ts";
import {
  assembleSite,
  newestBeta,
  writeSiteFeed,
  type Get,
  type ReleaseRow,
} from "../packaging/site-feed.ts";

const SHA512 = Buffer.alloc(64, 1).toString("base64");
const SHA256 = "ab".repeat(32);

function files(version: string) {
  const tag = `v${version}`;
  const url = (key: string) => `${releaseFolder(tag)}Clawtrate-${version}-${key}.zip`;
  const feed = JSON.stringify({
    format: 1,
    track: "nightly",
    version,
    releaseDate: "2026-11-20T18:00:00.000Z",
    files: {
      "mac-arm64": { url: url("mac-arm64"), size: 100, sha512: SHA512 },
      "mac-x64": { url: url("mac-x64"), size: 100, sha512: SHA512 },
    },
  });
  const latest = JSON.stringify(
    makeLatestMac(version, "TEAMID1234", {
      "mac-arm64": { url: url("mac-arm64"), sha256: SHA256 },
      "mac-x64": { url: url("mac-x64"), sha256: SHA256 },
      "win-x64": undefined,
    }),
  );
  return { tag, feed, latest };
}

function row(version: string, extra: Partial<ReleaseRow> = {}): ReleaseRow {
  const tag = `v${version}`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: true,
    assets: [
      "feed.json",
      "latest-mac.json",
      `Clawtrate-${version}-mac-arm64.zip`,
      `Clawtrate-${version}-mac-x64.zip`,
    ].map((name) => ({
      name,
      size: 100,
      digest: `sha256:${SHA256}`,
      browser_download_url: `${releaseFolder(tag)}${name}`,
    })),
    ...extra,
  };
}

describe("which release the site takes", () => {
  it("takes the newest published beta that carries both files", () => {
    const rows = [
      row("0.1.1-beta.20261120.1"),
      row("0.1.1-beta.20261120.10"),
      row("0.1.1-beta.20261121.1", { draft: true }),
      row("0.1.1-beta.20261121.2", { prerelease: false }),
      row("0.1.1-beta.20261122.1", { assets: [] }),
      // Only the Apple silicon zip: not a complete beta.
      row("0.1.1-beta.20261122.2", {
        assets: row("0.1.1-beta.20261122.2").assets.filter((asset) => !asset.name.includes("x64")),
      }),
      row("0.1.1"),
      { ...row("0.1.2-beta.20261123.1"), tag_name: "0.1.2-beta.20261123.1" },
    ];
    expect(newestBeta(rows)?.tag_name).toBe("v0.1.1-beta.20261120.10");
    expect(newestBeta([row("0.1.1-beta.20261121.1", { draft: true })])).toBeNull();
  });
});

describe("what the site checks before it serves a beta's files", () => {
  const version = "0.1.1-beta.20261120.2";
  const good = files(version);

  it("accepts a beta's own feed and latest-mac.json, unchanged", () => {
    expect(checkBetaFiles(good.tag, good.feed, good.latest)).toEqual({
      feed: good.feed,
      latest: good.latest,
    });
  });

  it.each([
    ["the feed of another version", files("0.1.1-beta.20261120.1").feed, good.latest],
    ["latest-mac.json of another version", good.feed, files("0.1.1-beta.20261120.1").latest],
    ["a feed that is not JSON", "{", good.latest],
    ["latest-mac.json that is not JSON", good.feed, "{"],
    [
      "latest-mac.json without a team",
      good.feed,
      JSON.stringify({ ...JSON.parse(good.latest), teamIdentifier: "" }),
    ],
    [
      "a file in another release",
      good.feed.replaceAll(`/download/${good.tag}/`, "/download/v0.1.0/"),
      good.latest,
    ],
    [
      "a feed without the Intel file",
      JSON.stringify({
        ...JSON.parse(good.feed),
        files: { "mac-arm64": JSON.parse(good.feed).files["mac-arm64"] },
      }),
      good.latest,
    ],
    ["a feed for the Stable track", good.feed.replace('"nightly"', '"stable"'), good.latest],
    [
      "both architectures naming the Apple silicon zip",
      good.feed.replace(`${version}-mac-x64.zip`, `${version}-mac-arm64.zip`),
      good.latest.replace(`${version}-mac-x64.zip`, `${version}-mac-arm64.zip`),
    ],
  ])("refuses %s", (_name, feed, latest) => {
    expect(() => checkBetaFiles(good.tag, feed, latest)).toThrow();
  });
});

describe("writing the site's feed", () => {
  let site: string;
  beforeEach(() => {
    site = mkdtempSync(join(tmpdir(), "clawtrate-site-"));
  });
  afterEach(() => rmSync(site, { recursive: true, force: true }));

  function github(
    rows: ReleaseRow[],
    bodies: Record<string, string>,
  ): { get: Get; asked: string[] } {
    const asked: string[] = [];
    const get: Get = async (url, headers) => {
      asked.push(url);
      if (url.startsWith("https://api.github.com/")) {
        expect(headers.authorization).toBe("Bearer made-up-token");
        return new Response(JSON.stringify(rows));
      }
      return bodies[url] === undefined
        ? new Response("", { status: 404 })
        : new Response(bodies[url]);
    };
    return { get, asked };
  }

  it("writes the newest beta's feed and latest-mac.json under updates/beta", async () => {
    const version = "0.1.1-beta.20261120.2";
    const { tag, feed, latest } = files(version);
    const { get, asked } = github([row("0.1.1-beta.20261120.1"), row(version)], {
      [`${releaseFolder(tag)}feed.json`]: feed,
      [`${releaseFolder(tag)}latest-mac.json`]: latest,
    });
    expect(await writeSiteFeed(site, get, "made-up-token")).toBe(tag);
    expect(readFileSync(join(site, "updates/beta/feed.json"), "utf8")).toBe(feed);
    expect(readFileSync(join(site, "updates/beta/latest-mac.json"), "utf8")).toBe(latest);
    expect(asked).toEqual([
      "https://api.github.com/repos/sidebandstudio/clawtrate/releases?per_page=100&page=1",
      `${releaseFolder(tag)}feed.json`,
      `${releaseFolder(tag)}latest-mac.json`,
    ]);
  });

  it("writes nothing when no beta is published, as after the first one is withdrawn", async () => {
    const { get } = github([row("0.1.1-beta.20261120.1", { draft: true })], {});
    expect(await writeSiteFeed(site, get, "made-up-token")).toBeNull();
    expect(existsSync(join(site, "updates"))).toBe(false);
  });

  it("fails the deploy, writing nothing, when the newest beta's files do not agree", async () => {
    const version = "0.1.1-beta.20261120.2";
    const { tag, feed } = files(version);
    const { get } = github([row(version)], {
      [`${releaseFolder(tag)}feed.json`]: feed,
      [`${releaseFolder(tag)}latest-mac.json`]: files("0.1.1-beta.20261120.1").latest,
    });
    await expect(writeSiteFeed(site, get, "made-up-token")).rejects.toThrow("does not match");
    expect(existsSync(join(site, "updates"))).toBe(false);
  });

  it.each<[string, (row: ReleaseRow) => void]>([
    [
      "GitHub's digest of the Intel zip",
      (beta) => (beta.assets.find((asset) => asset.name.endsWith("x64.zip"))!.digest = "sha256:00"),
    ],
    [
      "GitHub's size of the Apple silicon zip",
      (beta) => (beta.assets.find((asset) => asset.name.endsWith("arm64.zip"))!.size = 99),
    ],
  ])("fails the deploy when %s is not the one the files name", async (_name, change) => {
    const version = "0.1.1-beta.20261120.2";
    const { tag, feed, latest } = files(version);
    const beta = row(version);
    change(beta);
    const { get } = github([beta], {
      [`${releaseFolder(tag)}feed.json`]: feed,
      [`${releaseFolder(tag)}latest-mac.json`]: latest,
    });
    await expect(writeSiteFeed(site, get, "made-up-token")).rejects.toThrow(
      "is not the file its feed and latest-mac.json name",
    );
    expect(existsSync(join(site, "updates"))).toBe(false);
  });

  it("refuses a site that has its own updates/beta, even with no beta to write", async () => {
    mkdirSync(join(site, "updates/beta"), { recursive: true });
    writeFileSync(join(site, "updates/beta/feed.json"), "an old feed");
    const { get } = github([], {});
    await expect(writeSiteFeed(site, get, "made-up-token")).rejects.toThrow(
      "updates/beta/ is the generated Beta feed's folder",
    );
  });
});

describe("assembling the site", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clawtrate-site-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const none: Get = async () => new Response("[]");

  it("refuses, deploying nothing, when there is no site source", async () => {
    await expect(
      assembleSite(join(root, "site"), join(root, "_site"), none, undefined),
    ).rejects.toThrow("index.html does not exist: there is no site to deploy.");
    mkdirSync(join(root, "site"));
    await expect(
      assembleSite(join(root, "site"), join(root, "_site"), none, undefined),
    ).rejects.toThrow("there is no site to deploy");
    expect(existsSync(join(root, "_site"))).toBe(false);
  });

  it("refuses a site source with its own updates/beta", async () => {
    mkdirSync(join(root, "site/updates/beta"), { recursive: true });
    writeFileSync(join(root, "site/index.html"), "<!doctype html>");
    await expect(
      assembleSite(join(root, "site"), join(root, "_site"), none, undefined),
    ).rejects.toThrow("updates/beta/ is reserved for the generated Beta feed.");
    expect(existsSync(join(root, "_site"))).toBe(false);
  });

  it("copies the site and adds no feed when no beta is published", async () => {
    mkdirSync(join(root, "site/install"), { recursive: true });
    writeFileSync(join(root, "site/index.html"), "<!doctype html>");
    writeFileSync(join(root, "site/install/mac.sh"), "#!/bin/sh");
    expect(await assembleSite(join(root, "site"), join(root, "_site"), none, undefined)).toBeNull();
    expect(readFileSync(join(root, "_site/index.html"), "utf8")).toBe("<!doctype html>");
    expect(readFileSync(join(root, "_site/install/mac.sh"), "utf8")).toBe("#!/bin/sh");
    expect(existsSync(join(root, "_site/updates"))).toBe(false);
  });
});
