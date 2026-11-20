// The engine stays in main. Its address, release date and bounds come from the build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_FEED_ADDRESS,
  BUILD_RELEASE_DATE,
  DEFAULT_LIMITS,
  isUpdateRequired,
  MAX_FEED_BYTES,
  startDesktopUpdates,
} from "../../src/main/update/index.ts";
import { buildAddressProblem, checkFeedAddress } from "../../src/main/update/address.ts";
import { parseReleaseDate } from "../../src/main/update/feed.ts";
import { formatVersion, isNewer, parseVersion, type Version } from "../../src/main/update/version.ts";
import { feedServer, tempDir } from "./harness.ts";

const APP = join(import.meta.dirname, "../..");
const UPDATE = join(APP, "src/main/update");

/** The files a module reaches through its relative imports, itself included. */
function reached(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const specifiers = text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g);
    for (const [, specifier] of specifiers) {
      if (specifier!.startsWith(".")) queue.push(resolve(dirname(file), specifier!));
    }
  }
  return seen;
}

describe("only the desktop main process can reach the engine", () => {
  // The workspace packages the entries import cannot import the app: they do
  // not depend on it. So the relative imports from each entry are the whole
  // question.
  const entries = [
    "src/preload/index.ts",
    "src/renderer/main.tsx",
    "src/web-host/main.ts",
    "src/fixture/main.tsx",
  ].map((path) => join(APP, path));

  it("no renderer, preload or web host entry imports the update module", () => {
    for (const entry of entries) {
      expect(existsSync(entry), entry).toBe(true);
      const into = [...reached(entry)].filter((file) => file.startsWith(`${UPDATE}${sep}`));
      expect(
        into.map((file) => relative(APP, file)),
        relative(APP, entry),
      ).toEqual([]);
    }
  });

  it("follows the entries' imports, so it would see one", () => {
    const main = reached(join(APP, "src/main/index.ts"));
    expect(main.has(join(UPDATE, "service.ts"))).toBe(true);
    expect(main.has(join(APP, "src/host/runtime.ts"))).toBe(true);
  });
});

describe("the feed's address is the build's", () => {
  const saved = process.env.CLAWTRATE_UPDATE_FEED_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAWTRATE_UPDATE_FEED_URL;
    else process.env.CLAWTRATE_UPDATE_FEED_URL = saved;
  });

  it("a variable set in the app's environment, or an address passed in, does not reach the production engine", async () => {
    const server = await feedServer();
    const dir = tempDir();
    try {
      process.env.CLAWTRATE_UPDATE_FEED_URL = `${server.origin}/feed.json`;
      const service = await startDesktopUpdates({
        version: "0.1.0",
        packaged: true,
        changed: () => {},
        store: { get: async () => null, set: async () => {} },
        downloadDir: join(dir.path, "updates"),
        platform: "darwin",
        arch: "arm64",
        // What a caller holding a gateway's, a link's or a file's address might try.
        ...({
          feeds: { stable: server.origin + "/feed.json", nightly: null },
          feedAddress: `${server.origin}/feed.json`,
          loopbackHttpForTests: { port: server.port },
        } as object),
      });
      expect(BUILD_FEED_ADDRESS).toBeNull();
      expect((await service.check("stable")).snapshot.state).toMatchObject({
        reason: "not-configured",
      });
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
      dir.remove();
    }
  });

  it("the module reads no environment, file of its own choosing or process, and evaluates and marks up nothing", () => {
    for (const name of readdirSync(UPDATE)) {
      const text = readFileSync(join(UPDATE, name), "utf8");
      expect(text, name).not.toMatch(/process\.env|process\.argv/);
      // Starting a process needs one of these modules.
      expect(text, name).not.toMatch(/child_process|worker_threads|utilityProcess|from "electron"/);
      expect(text, name).not.toMatch(/\beval\(|new Function|innerHTML|dangerouslySetInnerHTML/);
      expect(text, name).not.toMatch(/readFile|createReadStream/);
    }
  });

  it("the build checks the scheme, credentials and parsed hostname without resolving it", () => {
    expect(buildAddressProblem("https://updates.example/clawtrate/feed.json")).toBeNull();
    expect(buildAddressProblem("http://updates.example/feed.json")).toBe("must use https");
    expect(buildAddressProblem("https://user:pass@updates.example/feed.json")).toMatch(/user name/);
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "[::1]", "a.localhost"]) {
      expect(buildAddressProblem(`https://${host}/feed.json`), host).toMatch(/loopback/);
    }
    for (const host of ["localhost.", "[::ffff:127.0.0.1]"]) {
      expect(buildAddressProblem(`https://${host}/feed.json`)).toBeNull();
    }
    expect(buildAddressProblem("updates.example/feed.json")).toBe("is not an address");
  });

  it("at run time only https is read, and a placeholder host is no feed", () => {
    expect(checkFeedAddress("https://203.0.113.5/feed.json").ok).toBe(true);
    expect(checkFeedAddress("http://203.0.113.5/feed.json")).toEqual({
      ok: false,
      cause: "address-refused",
    });
    expect(checkFeedAddress("file:///tmp/feed.json")).toEqual({
      ok: false,
      cause: "address-refused",
    });
    expect(checkFeedAddress("https://u:p@203.0.113.5/feed.json")).toEqual({
      ok: false,
      cause: "address-refused",
    });
    expect(checkFeedAddress("http://127.0.0.1:8080/feed.json")).toEqual({
      ok: false,
      cause: "address-refused",
    });
    expect(checkFeedAddress("http://127.0.0.1:8080/feed.json", { port: 8080 }).ok).toBe(true);
    expect(checkFeedAddress("https://updates.example/feed.json")).toEqual({
      ok: false,
      cause: "not-configured",
    });
    expect(checkFeedAddress(null)).toEqual({ ok: false, cause: "not-configured" });
  });
});

describe("F-010's age is the build's own", () => {
  const newer = { version: "0.2.0", releaseDate: "2026-11-18T00:00:00.000Z" };
  const now = new Date("2026-11-19T00:00:00.000Z");

  it("is required when a newer version exists and the build's own date is more than 14 days old, whatever the feed's date", () => {
    expect(isUpdateRequired(newer, "2026-11-04T23:59:59.000Z", now)).toBe(true);
    expect(isUpdateRequired(newer, "2026-11-05T00:00:00.000Z", now)).toBe(false);
    // A feed dated long ago does not make a recent build stale, nor a new feed date a stale one fresh.
    expect(
      isUpdateRequired(
        { ...newer, releaseDate: "2020-01-01T00:00:00.000Z" },
        "2026-11-18T00:00:00.000Z",
        now,
      ),
    ).toBe(false);
    expect(
      isUpdateRequired(
        { ...newer, releaseDate: "2026-11-19T00:00:00.000Z" },
        "2026-10-01T00:00:00.000Z",
        now,
      ),
    ).toBe(true);
  });

  it("is never required without a newer version or without the build's date", () => {
    expect(isUpdateRequired(null, "2026-01-01T00:00:00.000Z", now)).toBe(false);
    expect(isUpdateRequired(newer, null, now)).toBe(false);
    expect(BUILD_RELEASE_DATE).toBeNull();
  });
});

describe("the production engine's bounds", () => {
  it("are the documented ones, written out", () => {
    expect(MAX_FEED_BYTES).toBe(65_536);
    expect(DEFAULT_LIMITS).toEqual({
      maxFeedBytes: 65_536,
      feedTimeoutMs: 15_000,
      maxDownloadBytes: 536_870_912,
      downloadTimeoutMs: 1_800_000,
      idleTimeoutMs: 60_000,
    });
  });
});

describe("versions", () => {
  const v = (text: string) => parseVersion(text) as Version;

  it("only a strictly greater version is newer", () => {
    expect(isNewer(v("0.2.0"), v("0.1.0"))).toBe(true);
    expect(isNewer(v("0.1.1"), v("0.1.0"))).toBe(true);
    expect(isNewer(v("1.0.0"), v("0.99.99"))).toBe(true);
    expect(isNewer(v("0.10.0"), v("0.9.0"))).toBe(true);
    expect(isNewer(v("0.1.0"), v("0.1.0"))).toBe(false);
    expect(isNewer(v("0.0.9"), v("0.1.0"))).toBe(false);
    expect(isNewer(v("0.9.0"), v("0.10.0"))).toBe(false);
  });

  it.each([
    ["1.10.0", "1.9.0", true],
    ["1.0.0-nightly.20261102.1", "1.0.0-nightly.20261101.11", true],
    ["1.0.0-nightly.20261101.10", "1.0.0-nightly.20261101.2", true],
    ["1.0.0", "1.0.0-nightly.20261101.1", true],
    ["1.0.1-nightly.20261101.1", "1.0.0", true],
    ["1.0.0-nightly.20261101.1", "1.0.0", false],
    ["1.0.0", "1.0.0", false],
    ["1.0.0-nightly.20261101.1", "1.0.0-nightly.20261101.1", false],
    ["0.9.0", "1.0.0", false],
  ] as const)("%s against %s is newer: %s", (a, b, expected) => {
    expect(isNewer(v(a), v(b))).toBe(expected);
  });

  it("round trips the maximum nightly and the first supported year", () => {
    const max = "999999.999999.999999-nightly.99991231.999999999999";
    expect(max.length).toBe(50);
    for (const version of [max, "0.0.0-nightly.10000101.0"])
      expect(formatVersion(parseVersion(version)!)).toBe(version);
    expect(parseVersion("0.0.0-nightly.09991231.0")).toBeNull();
  });

  it("refuses versions outside the stable and nightly grammar", () => {
    for (const text of [
      "1",
      "1.0",
      "01.0.0",
      "1.0.0-beta",
      "1.0.0+1",
      " 1.0.0",
      "v1.0.0",
      "1.0.0.0",
      "1.0.0-nightly.20260230.1",
      "1.0.0-nightly.20261101.01",
      "1.0.0-nightly.20261101.1234567890123",
      "1.0.0-nightly.20261101.2\n",
      "9999999.0.0",
    ]) {
      expect(parseVersion(text), text).toBeNull();
    }
    expect(parseVersion(1)).toBeNull();
  });
});

describe("release dates", () => {
  it("requires a calendar date and preserves optional fractional seconds", () => {
    for (const date of ["2026-02-30", "2025-02-29", "2026-04-31"]) {
      expect(parseReleaseDate(`${date}T00:00:00Z`)).toBeNull();
    }
    for (const fraction of ["", ".1", ".12", ".123"]) {
      expect(parseReleaseDate(`2024-02-29T00:00:00${fraction}Z`)).toBe(
        `2024-02-29T00:00:00.${fraction.slice(1).padEnd(3, "0")}Z`,
      );
    }
  });
});
