// The site takes its Beta feed from the newest published beta release, and
// only after checking the feed and latest-mac.json against each other and the
// release's tag. GitHub's API and downloads are stand-ins here.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BETA_FEED_URL,
  BETA_FOLDER,
  BETA_LATEST_MAC_URL,
  checkBetaFiles,
  LEGACY_BETA_FEED_URL,
  LEGACY_BETA_FOLDER,
  LEGACY_BETA_PIN,
  makeLatestMac,
  releaseFolder,
} from "../packaging/beta-files.ts";
import {
  assembleSite,
  betaNotes,
  whatsNewFile,
  main,
  newestBeta,
  whatsNew,
  whatsNewHtml,
  writeSiteFeed,
  type Get,
  type ReleaseRow,
} from "../packaging/site-feed.ts";
import { MAX_WHATS_NEW_BYTES, parseWhatsNew } from "../src/main/update/whats-new.ts";
import { engineFor, feedServer, json, type FeedServer } from "./update/harness.ts";

/** Each zip as GitHub serves it here: 100 bytes. */
const ZIP = "z".repeat(100);
const SHA512 = createHash("sha512").update(ZIP).digest("base64");
const SHA256 = createHash("sha256").update(ZIP).digest("hex");

/** A beta's two files; `buildFeed` is the address its release records its build reads, if any. */
function files(version: string, buildFeed?: string) {
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
    ...(buildFeed && { buildFeed }),
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

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** GitHub's row for a beta: each zip's digest is the 100 bytes', each JSON file's its own text's. */
function row(
  version: string,
  extra: Partial<ReleaseRow> = {},
  json: { feed?: string; latest?: string } = {},
): ReleaseRow {
  const tag = `v${version}`;
  const own = files(version);
  const digests: Record<string, string> = {
    "feed.json": sha256(json.feed ?? own.feed),
    "latest-mac.json": sha256(json.latest ?? own.latest),
  };
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
      digest: `sha256:${digests[name] ?? SHA256}`,
      state: "uploaded",
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

describe("what a beta's release page says it adds", () => {
  const body = (list: string) =>
    `Clawtrate 0.1.1-beta.20261120.2, a beta for macOS.\n\nSHA-256:\n\n- \`a.zip\`: \`00\`\n\n${list}`;

  it('reads the lines under "What\'s new:" and nothing else on the page', () => {
    expect(
      whatsNew(body("What's new:\n\n- A new task shows no context line (#368)\n- Second\n")),
    ).toEqual(["A new task shows no context line (#368)", "Second"]);
    // The checksum list above it is not the list, and neither is what follows a blank line.
    expect(whatsNew(body("What's new:\r\n- One\r\n\r\n- Not this\r\n"))).toEqual(["One"]);
    expect(whatsNew(body("What's new:\n- One\nA paragraph.\n- Not this\n"))).toEqual(["One"]);
  });

  it("has no list without the heading, on an empty page, or for a line that is no change", () => {
    expect(whatsNew(body("- A stray list item"))).toEqual([]);
    expect(whatsNew(null)).toEqual([]);
    expect(whatsNew(undefined)).toEqual([]);
    expect(whatsNew("What's new:\n\nNothing listed.")).toEqual([]);
    expect(whatsNew(`What's new:\n- ${"x".repeat(201)}\n- Short\n- With\u0007a bell`)).toEqual([
      "Short",
    ]);
    expect(whatsNew(`What's new:\n${"- One\n".repeat(40)}`)).toHaveLength(30);
  });

  it("takes the last heading's list, and no indented, invisible or oddly separated line", () => {
    // The tooling writes the list last, so an earlier heading, in an example or not, is passed over.
    const example =
      "Format:\n\n```\nWhat's new:\n\n- An example\n```\n\nWhat's new:\n\n- The real one";
    expect(whatsNew(example)).toEqual(["The real one"]);
    expect(whatsNew("<!--\nWhat's new:\n- Hidden\n-->\n\nWhat's new:\n- Shown")).toEqual(["Shown"]);
    expect(whatsNew("What's new:\n\nSoon.\n\nWhat's new:\n- Later")).toEqual(["Later"]);
    expect(whatsNew("What's new:\n- Earlier\n\nWhat's new:\n\nNothing this time.")).toEqual([]);
    // An indented line belongs to the one above; it ends the list.
    expect(whatsNew("What's new:\n- Top\n  - Child\n- After")).toEqual(["Top"]);
    expect(whatsNew("What's new:\n  - Indented from the start")).toEqual([]);
    // A title with a character that isn't text is left out, and the list goes on past it.
    const odd = [
      "Zero\u200bwidth",
      "Right\u202eto left",
      "Arabic\u061cmark",
      "Soft\u00adhyphen",
      "Line\u2028separator",
      "No\u00a0break space",
      "Byte\ufeffmark",
      "A\ttab",
    ];
    expect(whatsNew(`What's new:\n${odd.map((item) => `- ${item}`).join("\n")}\n- Plain`)).toEqual([
      "Plain",
    ]);
    // Ordinary titles keep their punctuation, symbols, accents and other scripts.
    const fine = [
      "Costs $5 & up (#12)",
      "`code` → done, 100% ✓",
      "Café déjà vu",
      "日本語のタイトル",
    ];
    expect(whatsNew(`What's new:\n${fine.map((item) => `- ${item}`).join("\n")}`)).toEqual(fine);
    expect(whatsNew("What's new:\n* A star")).toEqual([]);
    expect(whatsNew("what's new:\n- Other casing")).toEqual([]);
  });

  it("lists the newest published betas that have a list, newest first", () => {
    const listed = (version: string, item: string, extra: Partial<ReleaseRow> = {}) =>
      row(version, { body: `What's new:\n\n- ${item}`, ...extra });
    const rows = [
      listed("0.1.1-beta.20261120.2", "Second"),
      listed("0.1.1-beta.20261120.10", "Tenth"),
      row("0.1.1-beta.20261120.9", { body: "No list here." }),
      listed("0.1.1-beta.20261120.11", "A draft", { draft: true }),
      listed("0.1.1-beta.20261120.12", "Not a beta", { prerelease: false }),
      listed("0.1.1", "A Stable build"),
      listed("0.1.1-beta.20261120.1", "First"),
    ];
    expect(betaNotes(rows)).toEqual([
      { version: "0.1.1-beta.20261120.10", items: ["Tenth"] },
      { version: "0.1.1-beta.20261120.2", items: ["Second"] },
      { version: "0.1.1-beta.20261120.1", items: ["First"] },
    ]);
    expect(betaNotes(rows, 1)).toEqual([{ version: "0.1.1-beta.20261120.10", items: ["Tenth"] }]);
    // Five at most unless asked otherwise, and a tag that is no beta's is left out.
    const many = Array.from({ length: 7 }, (_, index) =>
      listed(`0.1.1-beta.20261121.${index + 1}`, `Change ${index + 1}`),
    );
    expect(betaNotes(many).map((note) => note.version)).toEqual(
      [7, 6, 5, 4, 3].map((run) => `0.1.1-beta.20261121.${run}`),
    );
    expect(
      betaNotes([
        { ...listed("0.1.1-beta.20261121.1", "No v"), tag_name: "0.1.1-beta.20261121.1" },
        { ...listed("0.1.1-beta.20261121.2", "Not a version"), tag_name: "vnext" },
      ]),
    ).toEqual([]);
  });

  it("writes the section as text, with a change's number linked to its pull request", () => {
    const html = whatsNewHtml(
      [
        { version: "0.1.1-beta.20261120.2", items: ['<b>Bold</b> & "quoted" (#12)', "No number"] },
        { version: "0.1.1-beta.20261120.1", items: ["Earlier (#7) in the middle"] },
      ],
      "0.1.1-beta.20261120.2",
    );
    expect(html).toContain(
      '<li>&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quoted&quot; (<a href="https://github.com/sidebandstudio/clawtrate/pull/12">#12</a>)</li>',
    );
    expect(html).toContain("<li>No number</li>");
    // Only a closing number is a link.
    expect(html).toContain("<li>Earlier (#7) in the middle</li>");
    expect(html).toContain(
      '<h3>0.1.1-beta.20261120.2 <span class="whats-new-current">This beta</span></h3>',
    );
    expect(html).toContain("<h3>0.1.1-beta.20261120.1</h3>");
    expect(html).not.toContain("<b>");
    // Closed until it is opened: a details element with no `open`.
    expect(
      html.startsWith('<details class="whats-new"><summary><h2>What\'s new</h2></summary>'),
    ).toBe(true);
    expect(whatsNewHtml([], "0.1.1-beta.20261120.2")).toBe("");
    // A title that names a template token shows it, without holding one.
    const token = whatsNewHtml(
      [{ version: "0.1.1-beta.20261120.2", items: ["Document __CLAWTRATE_BETA_VERSION__"] }],
      "",
    );
    expect(token).toContain("<li>Document &#95;&#95;CLAWTRATE_BETA_VERSION&#95;&#95;</li>");
    expect(token).not.toMatch(/__CLAWTRATE_/);
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
    redirects: Record<string, string> = {},
  ): { get: Get; asked: string[] } {
    const asked: string[] = [];
    const get: Get = async (url, headers) => {
      asked.push(url);
      if (url.startsWith("https://api.github.com/")) {
        expect(headers.authorization).toBe("Bearer made-up-token");
        return new Response(JSON.stringify(rows));
      }
      if (redirects[url])
        return new Response(null, { status: 302, headers: { location: redirects[url] } });
      // Every zip serves the same 100 bytes unless `bodies` says otherwise.
      const body = bodies[url] ?? (url.endsWith(".zip") ? ZIP : undefined);
      return body === undefined ? new Response("", { status: 404 }) : new Response(body);
    };
    return { get, asked };
  }

  it("writes the newest beta's feed and latest-mac.json under both Beta feed folders", async () => {
    const version = "0.1.1-beta.20261120.2";
    const { tag, feed, latest } = files(version);
    const { get, asked } = github([row("0.1.1-beta.20261120.1"), row(version)], {
      [`${releaseFolder(tag)}feed.json`]: feed,
      [`${releaseFolder(tag)}latest-mac.json`]: latest,
    });
    expect(await writeSiteFeed(site, get, "made-up-token")).toBe(tag);
    for (const folder of ["updates/channel/beta", "updates/beta"]) {
      expect(readFileSync(join(site, folder, "feed.json"), "utf8")).toBe(feed);
      expect(readFileSync(join(site, folder, "latest-mac.json"), "utf8")).toBe(latest);
    }
    expect(asked).toEqual([
      "https://api.github.com/repos/sidebandstudio/clawtrate/releases?per_page=100&page=1",
      `${releaseFolder(tag)}feed.json`,
      `${releaseFolder(tag)}latest-mac.json`,
      `${releaseFolder(tag)}Clawtrate-${version}-mac-arm64.zip`,
      `${releaseFolder(tag)}Clawtrate-${version}-mac-x64.zip`,
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
    const other = files("0.1.1-beta.20261120.1").latest;
    const { get } = github([row(version, {}, { latest: other })], {
      [`${releaseFolder(tag)}feed.json`]: feed,
      [`${releaseFolder(tag)}latest-mac.json`]: other,
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

  it.each<[string, (beta: ReleaseRow, bodies: Record<string, string>, tag: string) => string]>([
    ["the feed names another SHA-512 though GitHub's SHA-256 matches", () => "feed"],
    [
      "GitHub serves other bytes for the Intel zip",
      (_beta, bodies, tag) => {
        bodies[`${releaseFolder(tag)}Clawtrate-${tag.slice(1)}-mac-x64.zip`] = "y".repeat(100);
        return "";
      },
    ],
    [
      "the Intel zip is not fully uploaded",
      (beta) => {
        beta.assets.find((asset) => asset.name.endsWith("x64.zip"))!.state = "starter";
        return "";
      },
    ],
    [
      "the Intel zip's address is not its release address",
      (beta) => {
        beta.assets.find((asset) => asset.name.endsWith("x64.zip"))!.browser_download_url =
          "https://example.com/Clawtrate.zip";
        return "";
      },
    ],
  ])("fails the deploy, writing neither file, when %s", async (_name, change) => {
    const version = "0.1.1-beta.20261120.2";
    const { tag, latest } = files(version);
    let { feed } = files(version);
    let beta = row(version);
    const bodies: Record<string, string> = {};
    if (change(beta, bodies, tag) === "feed") {
      const wrong = JSON.parse(feed);
      wrong.files["mac-x64"].sha512 = Buffer.alloc(64, 1).toString("base64");
      feed = JSON.stringify(wrong);
      beta = row(version, {}, { feed });
    }
    bodies[`${releaseFolder(tag)}feed.json`] = feed;
    bodies[`${releaseFolder(tag)}latest-mac.json`] = latest;
    const { get } = github([beta], bodies);
    await expect(writeSiteFeed(site, get, "made-up-token")).rejects.toThrow(
      `Clawtrate-${version}-mac-x64.zip on ${tag} is not the file its feed and latest-mac.json name.`,
    );
    expect(existsSync(join(site, "updates"))).toBe(false);
  });

  it("fails the deploy when the served zip matches the feed's SHA-512 but not latest-mac.json's SHA-256", async () => {
    const version = "0.1.1-beta.20261120.2";
    const { tag, latest } = files(version);
    const zip = `${releaseFolder(tag)}Clawtrate-${version}-mac-x64.zip`;
    // GitHub's digest and latest-mac.json name the 100 bytes of ZIP; the feed and
    // the download are another 100 bytes, so the app and install.sh cannot both verify it.
    const other = "y".repeat(100);
    const changed = JSON.parse(files(version).feed);
    changed.files["mac-x64"].sha512 = createHash("sha512").update(other).digest("base64");
    const feed = JSON.stringify(changed);
    const { get } = github([row(version, {}, { feed })], {
      [`${releaseFolder(tag)}feed.json`]: feed,
      [`${releaseFolder(tag)}latest-mac.json`]: latest,
      [zip]: other,
    });
    await expect(writeSiteFeed(site, get, "made-up-token")).rejects.toThrow(
      `Clawtrate-${version}-mac-x64.zip on ${tag} is not the file its feed and latest-mac.json name.`,
    );
    expect(existsSync(join(site, "updates"))).toBe(false);
  });

  it.each(["feed.json", "latest-mac.json"])(
    "fails the deploy, writing nothing, when the downloaded %s is not the file GitHub's digest names",
    async (name) => {
      const version = "0.1.1-beta.20261120.2";
      const { tag, feed, latest } = files(version);
      // GitHub's row names the current file; the download still answers with an earlier one.
      const current = { feed: `${feed}\n`, latest: `${latest}\n` };
      const { get } = github(
        [
          row(
            version,
            {},
            name === "feed.json" ? { feed: current.feed } : { latest: current.latest },
          ),
        ],
        {
          [`${releaseFolder(tag)}feed.json`]: feed,
          [`${releaseFolder(tag)}latest-mac.json`]: latest,
        },
      );
      await expect(writeSiteFeed(site, get, "made-up-token")).rejects.toThrow(
        `${name} on ${tag} is not the file GitHub's digest names.`,
      );
      expect(existsSync(join(site, "updates"))).toBe(false);
    },
  );

  describe("following GitHub's redirect as the app does", () => {
    const version = "0.1.1-beta.20261120.2";
    const { tag, feed, latest } = files(version);
    const zip = `${releaseFolder(tag)}Clawtrate-${version}-mac-x64.zip`;
    const asset = "https://release-assets.githubusercontent.com/github-production-release-asset/1";
    const bodies = {
      [`${releaseFolder(tag)}feed.json`]: feed,
      [`${releaseFolder(tag)}latest-mac.json`]: latest,
    };

    it("follows the one redirect to GitHub's asset host", async () => {
      const { get, asked } = github([row(version)], { ...bodies, [asset]: ZIP }, { [zip]: asset });
      expect(await writeSiteFeed(site, get, "made-up-token")).toBe(tag);
      expect(asked).toContain(asset);
    });

    it.each<[string, Record<string, string>, string]>([
      [
        "a second redirect after the asset host",
        { [zip]: asset, [asset]: `${asset}/again` },
        `${zip} redirects more than once.`,
      ],
      [
        "a redirect to another host",
        { [zip]: "https://example.com/Clawtrate.zip" },
        `${zip} redirects elsewhere than GitHub's asset host.`,
      ],
    ])("refuses, writing nothing, %s", async (_name, redirects, message) => {
      const { get } = github([row(version)], { ...bodies, [`${asset}/again`]: ZIP }, redirects);
      await expect(writeSiteFeed(site, get, "made-up-token")).rejects.toThrow(message);
      expect(existsSync(join(site, "updates"))).toBe(false);
    });
  });

  it.each(["updates/beta", "updates/channel/beta"])(
    "refuses a site that has its own %s, even with no beta to write",
    async (folder) => {
      mkdirSync(join(site, folder), { recursive: true });
      writeFileSync(join(site, folder, "feed.json"), "an old feed");
      const { get } = github([], {});
      await expect(writeSiteFeed(site, get, "made-up-token")).rejects.toThrow(
        `${folder}/ is a generated Beta feed's folder`,
      );
    },
  );
});

describe("assembling the site", () => {
  let root: string;
  let source: string;
  let output: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clawtrate-site-"));
    source = join(root, "site");
    output = join(root, "_site");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const none: Get = async () => new Response("[]");
  const version = "0.1.1-beta.20261120.2";
  const tag = `v${version}`;

  /** The website's own shape, in miniature: the home page, the download template and install.sh. */
  function fixture(team = "TEAMID1234") {
    mkdirSync(join(source, "download/mac"), { recursive: true });
    writeFileSync(join(source, "index.html"), "<!doctype html><title>Clawtrate</title>");
    writeFileSync(
      join(source, "download/mac/index.html"),
      [
        "<!-- __CLAWTRATE_BETA_VERSION__ __CLAWTRATE_ARM64_ZIP__ __CLAWTRATE_X64_ZIP__ __CLAWTRATE_RELEASE_PAGE__ -->",
        "<p>Beta __CLAWTRATE_BETA_VERSION__</p>",
        '<a href="__CLAWTRATE_ARM64_ZIP__">Apple silicon</a>',
        '<a href="__CLAWTRATE_X64_ZIP__">Intel</a>',
        '<a href="__CLAWTRATE_RELEASE_PAGE__">This beta on GitHub</a>',
        "<main>__CLAWTRATE_WHATS_NEW__</main>",
      ].join("\n"),
    );
    writeFileSync(
      join(source, "install.sh"),
      `#!/bin/sh\nCLAWTRATE_TEAM_ID="${team}"\nmain() { :; }\nmain "$@"\n`,
    );
  }

  /** GitHub with one published beta, signed by TEAMID1234, and its zips. */
  const oneBeta: Get = async (url) => {
    const { feed, latest } = files(version);
    if (url.startsWith("https://api.github.com/"))
      return new Response(JSON.stringify([row(version)]));
    if (url === `${releaseFolder(tag)}feed.json`) return new Response(feed);
    if (url === `${releaseFolder(tag)}latest-mac.json`) return new Response(latest);
    if (url.endsWith(".zip")) return new Response(ZIP);
    return new Response("", { status: 404 });
  };

  it("refuses, deploying nothing, when there is no site source", async () => {
    await expect(assembleSite(source, output, none, undefined)).rejects.toThrow(
      "index.html does not exist: there is no site to deploy.",
    );
    mkdirSync(source);
    await expect(assembleSite(source, output, none, undefined)).rejects.toThrow(
      "there is no site to deploy",
    );
    expect(existsSync(output)).toBe(false);
  });

  it.each(["updates/beta", "updates/channel/beta"])(
    "refuses a site source with its own %s",
    async (folder) => {
      fixture();
      mkdirSync(join(source, folder), { recursive: true });
      await expect(assembleSite(source, output, oneBeta, undefined)).rejects.toThrow(
        `${folder}/ is reserved for a generated Beta feed.`,
      );
      expect(existsSync(output)).toBe(false);
    },
  );

  it.each([join("download", "mac", "index.html"), "install.sh"])(
    "refuses a site source without %s",
    async (missing) => {
      fixture();
      rmSync(join(source, missing));
      await expect(assembleSite(source, output, oneBeta, undefined)).rejects.toThrow(
        `${missing} does not exist: there is no site to deploy.`,
      );
      expect(existsSync(output)).toBe(false);
    },
  );

  it("refuses non-empty output without changing its contents", async () => {
    fixture();
    mkdirSync(output);
    writeFileSync(join(output, "removed.html"), "old page");
    await expect(assembleSite(source, output, oneBeta, undefined)).rejects.toThrow("not empty");
    expect(readFileSync(join(output, "removed.html"), "utf8")).toBe("old page");
    expect(existsSync(join(output, "index.html"))).toBe(false);
  });

  it("fills the download page from the beta it serves, and copies the rest", async () => {
    fixture();
    expect(await assembleSite(source, output, oneBeta, undefined)).toBe(tag);
    const page = readFileSync(join(output, "download/mac/index.html"), "utf8");
    const zip = (key: string) => `${releaseFolder(tag)}Clawtrate-${version}-${key}.zip`;
    expect(page).toContain(`<p>Beta ${version}</p>`);
    expect(page).toContain(`<a href="${zip("mac-arm64")}">Apple silicon</a>`);
    expect(page).toContain(`<a href="${zip("mac-x64")}">Intel</a>`);
    expect(page).toContain(
      `<a href="https://github.com/sidebandstudio/clawtrate/releases/tag/${tag}">This beta on GitHub</a>`,
    );
    expect(page).not.toMatch(/__CLAWTRATE_/);
    // This beta's release page lists nothing, so the page has no "What's new" section.
    expect(page).toContain("<main></main>");
    expect(readFileSync(join(output, "install.sh"), "utf8")).toContain(
      'CLAWTRATE_TEAM_ID="TEAMID1234"',
    );
    expect(readFileSync(join(output, "updates/beta/latest-mac.json"), "utf8")).toBe(
      files(version).latest,
    );
    // The source is left a template.
    expect(readFileSync(join(source, "download/mac/index.html"), "utf8")).toContain(
      "__CLAWTRATE_ARM64_ZIP__",
    );
  });

  it("fills the download page's What's new section from the newest betas' release pages", async () => {
    fixture();
    const earlier = "0.1.1-beta.20261120.1";
    const listed: Get = async (url, headers) => {
      if (url.startsWith("https://api.github.com/"))
        return new Response(
          JSON.stringify([
            row(earlier, { body: "What's new:\n\n- An earlier change (#7)" }),
            row(version, { body: "Notes.\n\nWhat's new:\n\n- A <new> change (#12)\n- Another" }),
          ]),
        );
      return oneBeta(url, headers);
    };
    expect(await assembleSite(source, output, listed, undefined)).toBe(tag);
    const page = readFileSync(join(output, "download/mac/index.html"), "utf8");
    expect(page).toContain(
      `<h3>${version} <span class="whats-new-current">This beta</span></h3>` +
        '<ul><li>A &lt;new&gt; change (<a href="https://github.com/sidebandstudio/clawtrate/pull/12">#12</a>)</li>' +
        "<li>Another</li></ul>",
    );
    // The earlier beta's list follows the newest one's.
    expect(page.indexOf(`<h3>${earlier}</h3>`)).toBeGreaterThan(page.indexOf(`<h3>${version} `));
    expect(page).not.toMatch(/__CLAWTRATE_/);
  });

  /** GitHub with the beta above as newest, and older betas whose pages hold `bodies`. */
  const withBodies =
    (bodies: Record<string, string | null>): Get =>
    async (url, headers) => {
      if (url.startsWith("https://api.github.com/"))
        return new Response(
          JSON.stringify(
            Object.entries(bodies).map(([each, body]) =>
              each === version ? row(version, { body }) : { ...row(each, { body }), assets: [] },
            ),
          ),
        );
      return oneBeta(url, headers);
    };

  it("F-554: serves the newest betas' lists as whats-new.json beside the feed, newest first", async () => {
    fixture();
    await assembleSite(
      source,
      output,
      withBodies({
        "0.1.1-beta.20261118.1": "What's new:\n\n- An older change (#1)\n",
        [version]: "Notes.\n\nWhat's new:\n\n- Settings shows what an update adds (#457)\n",
        "0.1.1-beta.20261119.1": "Nothing listed here.",
        "0.1.1-beta.20261120.1":
          "What's new:\n\n- A change in between (#2)\n- A\u200bhidden mark (#3)\n",
      }),
      undefined,
    );
    const text = readFileSync(join(output, "updates/beta/whats-new.json"), "utf8");
    expect(JSON.parse(text)).toEqual({
      format: 1,
      builds: [
        { version, items: ["Settings shows what an update adds (#457)"] },
        { version: "0.1.1-beta.20261120.1", items: ["A change in between (#2)"] },
        { version: "0.1.1-beta.20261118.1", items: ["An older change (#1)"] },
      ],
    });
    // The app reads it as the site wrote it.
    expect(parseWhatsNew(text)).toEqual(JSON.parse(text).builds);
  });

  it("F-554: writes whats-new.json with no builds when no page lists anything, and the feed's files exactly as before", async () => {
    fixture();
    await assembleSite(source, output, oneBeta, undefined);
    expect(JSON.parse(readFileSync(join(output, "updates/beta/whats-new.json"), "utf8"))).toEqual({
      format: 1,
      builds: [],
    });
    const { feed, latest } = files(version);
    expect(readFileSync(join(output, "updates/beta/feed.json"), "utf8")).toBe(feed);
    expect(readFileSync(join(output, "updates/beta/latest-mac.json"), "utf8")).toBe(latest);
    expect(readdirSync(join(output, "updates/beta")).sort()).toEqual([
      "feed.json",
      "latest-mac.json",
      "whats-new.json",
    ]);
  });

  it("F-554: the largest lists the rule allows serialize under the app's reading cap", () => {
    const worst = (n: number) =>
      row(`0.1.1-beta.20261120.${n}`, {
        body: `What's new:\n\n${Array.from({ length: 30 }, () => `- ${"_".repeat(200)}`).join("\n")}\n`,
      });
    const rows = Array.from({ length: 12 }, (_, n) => worst(n + 1));
    const text = whatsNewFile(rows);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_WHATS_NEW_BYTES);
    expect(text).not.toMatch(/__/);
    expect(parseWhatsNew(text)).toEqual(betaNotes(rows));
  });

  it("F-554: the page leaves out a title of blank fillers alone, and keeps accented ones, as the app does", () => {
    expect(whatsNew("What's new:\n\n- \u3164\n- \u2800\n- \uffa0\n- Café ouvre (#1)\n")).toEqual([
      "Café ouvre (#1)",
    ]);
  });

  it("F-554: the page leaves out a title of invisible marks alone, as the app does", () => {
    expect(whatsNew("What's new:\n\n- \u034f\n- \ufe0f\n- Cafe\u0301 opens (#1)\n")).toEqual([
      "Cafe\u0301 opens (#1)",
    ]);
  });

  it("F-554: a title naming a template token is served as written, without holding the token", async () => {
    fixture();
    await assembleSite(
      source,
      output,
      withBodies({ [version]: "What's new:\n\n- Document __CLAWTRATE_BETA_VERSION__ (#3)\n" }),
      undefined,
    );
    const text = readFileSync(join(output, "updates/beta/whats-new.json"), "utf8");
    expect(text).not.toMatch(/__CLAWTRATE_/);
    expect(parseWhatsNew(text)).toEqual([
      { version, items: ["Document __CLAWTRATE_BETA_VERSION__ (#3)"] },
    ]);
  });

  it("puts a title in as written, whatever it holds, and still asks GitHub once", async () => {
    fixture();
    const asked: string[] = [];
    const awkward: Get = async (url, headers) => {
      asked.push(url);
      if (url.startsWith("https://api.github.com/"))
        return new Response(
          JSON.stringify([
            row(version, {
              body: [
                "What's new:",
                "",
                "- Costs $& and $` and $' and $$ and $1",
                "- Document __CLAWTRATE_BETA_VERSION__ (#3)",
              ].join("\n"),
            }),
          ]),
        );
      return oneBeta(url, headers);
    };
    expect(await assembleSite(source, output, awkward, undefined)).toBe(tag);
    const page = readFileSync(join(output, "download/mac/index.html"), "utf8");
    // In a replacement string these would be read as patterns, and the token as one left unfilled.
    expect(page).toContain("<li>Costs $&amp; and $` and $&#39; and $$ and $1</li>");
    expect(page).toContain(
      '<li>Document &#95;&#95;CLAWTRATE_BETA_VERSION&#95;&#95; (<a href="https://github.com/sidebandstudio/clawtrate/pull/3">#3</a>)</li>',
    );
    expect(page.match(/<main>/g)).toHaveLength(1);
    expect(asked.filter((url) => url.startsWith("https://api.github.com/"))).toHaveLength(1);
  });

  it("still refuses a token the page itself leaves unfilled", async () => {
    fixture();
    writeFileSync(
      join(source, "download/mac/index.html"),
      "<p>__CLAWTRATE_BETA_VERSION__ __CLAWTRATE_NOT_A_TOKEN__</p>__CLAWTRATE_WHATS_NEW__",
    );
    await expect(assembleSite(source, output, oneBeta, undefined)).rejects.toThrow(
      "still holds __CLAWTRATE_NOT_A_TOKEN__",
    );
  });

  it("refuses when no beta is published, since the download page cannot be filled", async () => {
    fixture();
    await expect(assembleSite(source, output, none, undefined)).rejects.toThrow(
      "No published beta: the download page cannot be filled, so nothing deploys.",
    );
  });

  it.each([
    [join("download", "mac", "index.html"), "<p>__CLAWTRATE_CHANNEL__</p>"],
    ["index.html", '<a href="__CLAWTRATE_ARM64_ZIP__">Download</a>'],
  ])("refuses while %s holds a token the assembly does not fill", async (file, extra) => {
    fixture();
    writeFileSync(join(source, file), `${readFileSync(join(source, file), "utf8")}\n${extra}`);
    await expect(assembleSite(source, output, oneBeta, undefined)).rejects.toThrow(
      `${file} still holds __CLAWTRATE_`,
    );
  });

  it("refuses while install.sh pins the placeholder team", async () => {
    fixture("APPLE_CLAWTRATE_TEAM_ID");
    await expect(assembleSite(source, output, oneBeta, undefined)).rejects.toThrow(
      "install.sh still pins the placeholder APPLE_CLAWTRATE_TEAM_ID, so nothing deploys.",
    );
  });

  it("refuses while install.sh pins another team than the beta's", async () => {
    fixture("OTHERTEAM1");
    await expect(assembleSite(source, output, oneBeta, undefined)).rejects.toThrow(
      `install.sh pins team OTHERTEAM1, but ${tag} is signed by TEAMID1234, so nothing deploys.`,
    );
  });

  it("passes the assembled beta's tag on to the deploy job, which rechecks it", async () => {
    fixture();
    const outputs = join(root, "github-output");
    writeFileSync(outputs, "earlier=1\n");
    expect(await main([source, output], { GITHUB_OUTPUT: outputs }, oneBeta)).toBe(0);
    expect(readFileSync(outputs, "utf8")).toBe(`earlier=1\ntag=${tag}\npinned=\n`);
  });

  it("leaves the output as it was when it refuses, so a rerun into it works", async () => {
    fixture("OTHERTEAM1");
    await expect(assembleSite(source, output, oneBeta, undefined)).rejects.toThrow(
      "install.sh pins team OTHERTEAM1",
    );
    expect(existsSync(output)).toBe(false);
    fixture();
    expect(await assembleSite(source, output, oneBeta, undefined)).toBe(tag);
    expect(readFileSync(join(output, "updates/beta/feed.json"), "utf8")).toBe(files(version).feed);
  });

  it.each([
    ["no pin", (text: string) => text.replace(/^CLAWTRATE_TEAM_ID=.*$/m, "")],
    ["a second pin", (text: string) => `${text}CLAWTRATE_TEAM_ID="TEAMID1234"\n`],
  ])("refuses an install.sh with %s", async (_name, change) => {
    fixture();
    writeFileSync(
      join(source, "install.sh"),
      change(readFileSync(join(source, "install.sh"), "utf8")),
    );
    await expect(assembleSite(source, output, oneBeta, undefined)).rejects.toThrow(
      "install.sh must pin CLAWTRATE_TEAM_ID exactly once, so nothing deploys.",
    );
  });
});

// Betas published before the new folder read the legacy one, and it stays
// served (docs/decisions.md, "Moving betas to three numbers"). Until the switch
// both folders carry the newest beta; after it the legacy one carries the
// pinned beta, which reads the new folder.
describe("F-559: the two Beta feed folders", () => {
  let root: string;
  let source: string;
  let output: string;
  let server: FeedServer;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "clawtrate-site-"));
    source = join(root, "site");
    output = join(root, "_site");
    mkdirSync(join(source, "download/mac"), { recursive: true });
    writeFileSync(join(source, "index.html"), "<!doctype html><title>Clawtrate</title>");
    writeFileSync(join(source, "download/mac/index.html"), "<p>__CLAWTRATE_BETA_VERSION__</p>");
    writeFileSync(
      join(source, "install.sh"),
      '#!/bin/sh\nCLAWTRATE_TEAM_ID="TEAMID1234"\nmain() { :; }\nmain "$@"\n',
    );
    server = await feedServer();
  });
  afterEach(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const OLD = "0.1.1-beta.20261119.1";
  const PINNED = "0.1.1-beta.20261120.1";
  const NEWEST = "0.1.1-beta.20261120.2";
  /**
   * GitHub with three published betas, each listing what it adds, and their
   * files. The pinned candidate's feed records `recorded` as the address its
   * build reads; the others record none, as betas from before the new folder.
   */
  const github =
    (
      change: (row: ReleaseRow) => ReleaseRow | null = (each) => each,
      recorded: string | null = BETA_FEED_URL,
    ): Get =>
    async (url) => {
      const versions = [OLD, PINNED, NEWEST];
      const own = (version: string) =>
        files(version, version === PINNED ? (recorded ?? undefined) : undefined);
      if (url.startsWith("https://api.github.com/"))
        return new Response(
          JSON.stringify(
            versions.flatMap(
              (version) =>
                change(
                  row(
                    version,
                    { body: `What's new:\n\n- In ${version}\n` },
                    { feed: own(version).feed },
                  ),
                ) ?? [],
            ),
          ),
        );
      for (const version of versions) {
        const { tag, feed, latest } = own(version);
        if (url === `${releaseFolder(tag)}feed.json`) return new Response(feed);
        if (url === `${releaseFolder(tag)}latest-mac.json`) return new Response(latest);
      }
      if (url.endsWith(".zip")) return new Response(ZIP);
      return new Response("", { status: 404 });
    };
  const read = (folder: string, name: string) => readFileSync(join(output, folder, name), "utf8");
  /** The update engine of a build running `version`, reading the assembled `folder`. */
  const check = (folder: string, version: string) => {
    for (const name of ["feed.json", "whats-new.json"])
      server.route(`/${folder}/${name}`, json(JSON.parse(read(folder, name))));
    return engineFor(server, join(root, "updates"), {
      feedAddress: `${server.origin}/${folder}/feed.json`,
      currentVersion: version,
      track: "nightly",
    }).engine.check();
  };

  it("the app reads the new folder, and the install script reads its latest-mac.json", () => {
    expect(BETA_FEED_URL).toBe(`https://clawtrate.dev/${BETA_FOLDER}/feed.json`);
    expect(BETA_FOLDER).toBe("updates/channel/beta");
    expect(LEGACY_BETA_FEED_URL).toBe("https://clawtrate.dev/updates/beta/feed.json");
    const script = readFileSync(join(import.meta.dirname, "../../../site/install.sh"), "utf8");
    expect(script).toContain(`\nFEED_URL="${BETA_LATEST_MAC_URL}"\n`);
    // Off until betas move to three numbers.
    expect(LEGACY_BETA_PIN).toBeNull();
  });

  it("until the switch, both folders hold the same bytes, made from one read of the releases", async () => {
    const asked: string[] = [];
    const get = github();
    await assembleSite(
      source,
      output,
      (url, headers) => (asked.push(url), get(url, headers)),
      "t",
      null,
    );
    const names = ["feed.json", "latest-mac.json", "whats-new.json"];
    for (const folder of [BETA_FOLDER, LEGACY_BETA_FOLDER])
      expect(readdirSync(join(output, folder)).sort()).toEqual(names);
    for (const name of names) expect(read(LEGACY_BETA_FOLDER, name)).toBe(read(BETA_FOLDER, name));
    expect(read(BETA_FOLDER, "feed.json")).toBe(files(NEWEST).feed);
    // GitHub's list once, and the newest beta's two files and two zips once each.
    expect(asked.filter((url) => url.startsWith("https://api.github.com/"))).toHaveLength(1);
    expect(asked.filter((url) => url.startsWith(releaseFolder(`v${NEWEST}`)))).toHaveLength(4);
    // A reader of either folder is offered the newest beta.
    for (const folder of [BETA_FOLDER, LEGACY_BETA_FOLDER])
      expect(await check(folder, OLD)).toMatchObject({ kind: "available", version: NEWEST });
  });

  it("pinned, the legacy folder offers the pinned beta and nothing newer; the new one offers every beta", async () => {
    const outputs = join(root, "github-output");
    expect(await main([source, output], { GITHUB_OUTPUT: outputs }, github(), PINNED)).toBe(0);
    // The deploy job rechecks both betas.
    expect(readFileSync(outputs, "utf8")).toBe(`tag=v${NEWEST}\npinned=v${PINNED}\n`);
    expect(read(LEGACY_BETA_FOLDER, "feed.json")).toBe(files(PINNED, BETA_FEED_URL).feed);
    expect(read(LEGACY_BETA_FOLDER, "latest-mac.json")).toBe(files(PINNED).latest);
    expect(read(BETA_FOLDER, "feed.json")).toBe(files(NEWEST).feed);
    // Fresh installs and the download page take the newest beta.
    expect(read(BETA_FOLDER, "latest-mac.json")).toBe(files(NEWEST).latest);
    expect(read("download/mac", "index.html")).toBe(`<p>${NEWEST}</p>`);
    // Each folder's lists stop at the beta it serves.
    const listed = (folder: string) =>
      parseWhatsNew(read(folder, "whats-new.json"))!.map((build) => build.version);
    expect(listed(LEGACY_BETA_FOLDER)).toEqual([PINNED, OLD]);
    expect(listed(BETA_FOLDER)).toEqual([NEWEST, PINNED, OLD]);
    // An old copy reaches the pinned beta, and from there, reading the new folder, the newest.
    expect(await check(LEGACY_BETA_FOLDER, OLD)).toMatchObject({
      kind: "available",
      version: PINNED,
    });
    expect(await check(LEGACY_BETA_FOLDER, PINNED)).toEqual({ kind: "up-to-date", latest: PINNED });
    expect(await check(LEGACY_BETA_FOLDER, NEWEST)).toEqual({ kind: "up-to-date", latest: PINNED });
    expect(await check(BETA_FOLDER, PINNED)).toMatchObject({ kind: "available", version: NEWEST });
    expect(await check(BETA_FOLDER, OLD)).toMatchObject({ kind: "available", version: NEWEST });
  });

  const pinned = (change: (row: ReleaseRow) => ReleaseRow | null) => (each: ReleaseRow) =>
    each.tag_name === `v${PINNED}` ? change(each) : each;
  const unusable = `The legacy Beta feed is pinned to ${PINNED}, which is not a published beta with its files, so nothing deploys.`;
  it.each([
    ["withdrawn", pinned((each) => ({ ...each, draft: true })), unusable],
    ["without its files", pinned((each) => ({ ...each, assets: each.assets.slice(2) })), unusable],
    [
      "not listed",
      pinned(() => null),
      `The legacy Beta feed is pinned to ${PINNED}, but GitHub lists no release v${PINNED}, so nothing deploys.`,
    ],
  ])("refuses to deploy while the pinned beta is %s", async (_state, change, message) => {
    await expect(assembleSite(source, output, github(change), "t", PINNED)).rejects.toThrow(
      message,
    );
    expect(existsSync(output)).toBe(false);
  });

  /**
   * GitHub listing `listed` 100 a page, newest first, and the files of the betas
   * in `github()`; `pages` records each page asked for.
   */
  const paged = (listed: () => ReleaseRow[], pages: number[]): Get => {
    const base = github();
    return async (url, headers) => {
      const page = /[?&]page=(\d+)/.exec(url);
      if (!url.startsWith("https://api.github.com/") || !page) return base(url, headers);
      pages.push(Number(page[1]));
      const start = (Number(page[1]) - 1) * 100;
      return new Response(JSON.stringify(listed().slice(start, start + 100)));
    };
  };
  const withdrawn = (day: number, count: number) =>
    Array.from({ length: count }, (_, index) =>
      row(`0.1.1-beta.202611${day}.${index + 1}`, { draft: true }),
    );
  /** Published betas older than the pin, each listing what it adds. */
  const listing = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      row(`0.1.1-beta.20261115.${index + 1}`, { body: `What's new:\n\n- Older ${index + 1}\n` }),
    );
  const pinnedRow = row(
    PINNED,
    { body: "What's new:\n\n- The pin\n" },
    { feed: files(PINNED, BETA_FEED_URL).feed },
  );
  const pages = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

  it("finds a pinned beta older than the newest 1,000 releases, and reads no further", async () => {
    // 1,150 withdrawn releases newer than the pin, then the pin and four older betas with
    // lists on page 12, then 300 more, so the pin and its five lists sit on page 12 of 15.
    let listed = [
      row(NEWEST),
      ...withdrawn(29, 1150),
      pinnedRow,
      ...listing(4),
      ...withdrawn(10, 300),
      row(OLD),
    ];
    const asked: number[] = [];
    const get = paged(() => listed, asked);
    await assembleSite(source, output, get, "t", PINNED);
    expect(read(LEGACY_BETA_FOLDER, "feed.json")).toBe(files(PINNED, BETA_FEED_URL).feed);
    // Pages 13 to 15 are never asked for once the pin and its lists are found.
    expect(asked).toEqual(pages(12));
    // A pin the whole list doesn't name fails plainly once the list ends.
    asked.length = 0;
    listed = listed.filter((each) => each !== pinnedRow);
    rmSync(output, { recursive: true, force: true });
    await expect(assembleSite(source, output, get, "t", PINNED)).rejects.toThrow(
      `The legacy Beta feed is pinned to ${PINNED}, but GitHub lists no release v${PINNED}, so nothing deploys.`,
    );
    expect(asked).toEqual(pages(15));
    // Unpinned, the newest 1,000 are enough, as before, and the site assembles.
    asked.length = 0;
    rmSync(output, { recursive: true, force: true });
    expect(await assembleSite(source, output, get, "t", null)).toBe(`v${NEWEST}`);
    expect(asked).toEqual(pages(10));
  });

  it("#535: reads past the pin's page for the lists below it, up to the five the legacy feed serves", async () => {
    // The pin is the last release on page 12; the betas below it, with their lists, on page 13.
    const listed = [
      row(NEWEST),
      ...withdrawn(29, 1198),
      pinnedRow,
      ...listing(6),
      ...withdrawn(10, 300),
    ];
    expect(listed.indexOf(pinnedRow)).toBe(1199);
    const asked: number[] = [];
    await assembleSite(
      source,
      output,
      paged(() => listed, asked),
      "t",
      PINNED,
    );
    expect(
      parseWhatsNew(read(LEGACY_BETA_FOLDER, "whats-new.json"))!.map((b) => b.version),
    ).toEqual([PINNED, ...[6, 5, 4, 3].map((run) => `0.1.1-beta.20261115.${run}`)]);
    expect(asked).toEqual(pages(13));
  });

  it("#535: checks the zips once when the pinned beta is also the newest", async () => {
    const asked: string[] = [];
    // The pinned beta is the newest one published.
    const base = github((each) => (each.tag_name === `v${NEWEST}` ? null : each));
    await assembleSite(
      source,
      output,
      (url, headers) => (asked.push(url), base(url, headers)),
      "t",
      PINNED,
    );
    expect(read(LEGACY_BETA_FOLDER, "feed.json")).toBe(read(BETA_FOLDER, "feed.json"));
    const zips = asked.filter((url) => url.endsWith(".zip"));
    expect(zips.sort()).toEqual(
      ["mac-arm64", "mac-x64"].map(
        (key) => `${releaseFolder(`v${PINNED}`)}Clawtrate-${PINNED}-${key}.zip`,
      ),
    );
  });

  it.each([
    ["records no address, as every beta from before the new folder", null],
    ["records the legacy address", LEGACY_BETA_FEED_URL],
  ])("refuses to deploy a pin whose release %s", async (_case, recorded) => {
    await expect(
      assembleSite(source, output, github(undefined, recorded), "t", PINNED),
    ).rejects.toThrow(
      `The legacy Beta feed is pinned to ${PINNED}, whose release does not record that its build reads ${BETA_FEED_URL}, so nothing deploys.`,
    );
    expect(existsSync(output)).toBe(false);
  });
});
