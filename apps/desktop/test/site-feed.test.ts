// The site takes its Beta feed from the newest published beta release, and
// only after checking the feed and latest-mac.json against each other and the
// release's tag. GitHub's API and downloads are stand-ins here.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBetaFiles, makeLatestMac, releaseFolder } from "../packaging/beta-files.ts";
import {
  assembleSite,
  betaNotes,
  main,
  newestBeta,
  whatsNew,
  whatsNewHtml,
  writeSiteFeed,
  type Get,
  type ReleaseRow,
} from "../packaging/site-feed.ts";

/** Each zip as GitHub serves it here: 100 bytes. */
const ZIP = "z".repeat(100);
const SHA512 = createHash("sha512").update(ZIP).digest("base64");
const SHA256 = createHash("sha256").update(ZIP).digest("hex");

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

  it("refuses a site source with its own updates/beta", async () => {
    fixture();
    mkdirSync(join(source, "updates/beta"), { recursive: true });
    await expect(assembleSite(source, output, oneBeta, undefined)).rejects.toThrow(
      "updates/beta/ is reserved for the generated Beta feed.",
    );
    expect(existsSync(output)).toBe(false);
  });

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
    expect(readFileSync(outputs, "utf8")).toBe(`earlier=1\ntag=${tag}\n`);
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
