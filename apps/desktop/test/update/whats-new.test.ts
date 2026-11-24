// What an update adds (F-554): the lists the site serves beside the feed, as the
// app parses, reads and shows them. Every title is invented.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWhatsNew, whatsNewAddress, whatsNewView } from "../../src/main/update/whats-new.ts";
import { readWhatsNew } from "../../src/main/update/whats-new-read.ts";
import { feedServer, json, type FeedServer } from "./harness.ts";

const file = (builds: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 1, builds, ...extra });

describe("F-554: whats-new.json as the app parses it", () => {
  it("takes each build's titles, leaving out those outside the rule and builds left with none", () => {
    expect(
      parseWhatsNew(
        file([
          {
            version: "0.1.1-beta.20261120.2",
            items: ["Settings shows what an update adds (#457)"],
          },
          {
            version: "0.1.1-beta.20261120.1",
            items: [
              "Kept (#1)",
              "a​zero-width",
              "tab\there",
              " padded",
              "x".repeat(201),
              7,
              "x".repeat(200),
            ],
          },
          { version: "0.1.1-beta.20261119.1", items: ["line\nbreak"] },
        ]),
      ),
    ).toEqual([
      { version: "0.1.1-beta.20261120.2", items: ["Settings shows what an update adds (#457)"] },
      { version: "0.1.1-beta.20261120.1", items: ["Kept (#1)", "x".repeat(200)] },
    ]);
    expect(parseWhatsNew(file([]))).toEqual([]);
  });

  it("leaves out a title of invisible marks alone, and keeps marks inside a visible one", () => {
    expect(
      parseWhatsNew(
        file([
          {
            version: "0.1.1-beta.20261120.2",
            items: [
              "\u034f",
              "\ufe0f",
              "\u034f\ufe0f",
              "Cafe\u0301 opens (#1)",
              "Ready \u2705\ufe0f (#2)",
            ],
          },
        ]),
      ),
    ).toEqual([
      {
        version: "0.1.1-beta.20261120.2",
        items: ["Cafe\u0301 opens (#1)", "Ready \u2705\ufe0f (#2)"],
      },
    ]);
  });

  it("leaves out a title of blank characters, fillers included, and keeps accented ones", () => {
    expect(
      parseWhatsNew(
        file([
          {
            version: "0.1.1-beta.20261120.2",
            items: [
              "\u3164",
              "\u2800",
              "\u115f\u1160",
              "\uffa0 \u2800",
              "Café ouvre (#1)",
              "Ünïcödé títlé (#2)",
              "\u3164 Filled (#3)",
            ],
          },
        ]),
      ),
    ).toEqual([
      {
        version: "0.1.1-beta.20261120.2",
        items: ["Café ouvre (#1)", "Ünïcödé títlé (#2)", "\u3164 Filled (#3)"],
      },
    ]);
  });

  it("refuses a file that is not the one the site writes", () => {
    const build = { version: "0.1.1-beta.20261120.2", items: ["One (#1)"] };
    for (const text of [
      "not json",
      "[]",
      JSON.stringify({ format: 2, builds: [] }),
      JSON.stringify({ builds: [] }),
      file([], { extra: true }),
      file([{ ...build, extra: true }]),
      file([{ version: "0.1.1-beta.20261120.02", items: ["One"] }]),
      file([{ version: "v0.1.1", items: ["One"] }]),
      file([build, build]),
      file([{ version: build.version, items: "One" }]),
      file([{ version: build.version, items: Array.from({ length: 31 }, () => "One") }]),
      file(Array.from({ length: 11 }, (_, i) => ({ version: `0.1.${i}`, items: ["One"] }))),
    ])
      expect(parseWhatsNew(text), text).toBeNull();
  });

  it("is read from the feed's own folder", () => {
    expect(whatsNewAddress(new URL("https://clawtrate.dev/updates/beta/feed.json")).href).toBe(
      "https://clawtrate.dev/updates/beta/whats-new.json",
    );
  });
});

describe("F-554: what the Updates pane shows from the lists", () => {
  const builds = [
    { version: "0.1.1-beta.20261122.1", items: ["Newer than the offer (#9)"] },
    { version: "0.1.1-beta.20261121.1", items: ["The offer (#8)"] },
    { version: "0.1.1-beta.20261120.3", items: ["Skipped (#7)"] },
    { version: "0.1.1-beta.20261120.1", items: ["Running (#6)"] },
    { version: "0.1.1-beta.20261119.1", items: ["Older (#5)"] },
  ];
  const running = "0.1.1-beta.20261120.1";

  it("an offer shows its own list and those of the builds skipped to reach it, newest first, and the running build's", () => {
    expect(whatsNewView(builds, running, "0.1.1-beta.20261121.1")).toEqual({
      coming: [builds[1], builds[2]],
      running: ["Running (#6)"],
    });
  });

  it("a file that doesn't list the offered version exactly is stale: nothing shows for the update, skipped builds included", () => {
    expect(whatsNewView(builds, running, "0.1.1-beta.20261121.2")).toEqual({
      coming: [],
      running: ["Running (#6)"],
    });
    expect(whatsNewView(builds.slice(1, 3), running, "0.1.1-beta.20261121.2")).toBeUndefined();
  });

  it("skipped builds lie strictly between the running build and the offer; the running build's list is only its own", () => {
    const view = whatsNewView(builds, "0.1.1-beta.20261120.3", "0.1.1-beta.20261121.1");
    expect(view).toEqual({ coming: [builds[1]], running: ["Skipped (#7)"] });
    expect(whatsNewView(builds, "0.1.1-beta.20261120.2", null)).toBeUndefined();
  });

  it("a skipped build is on the offered build's track: a Stable release between is not listed", () => {
    const view = whatsNewView(
      [
        { version: "1.2.0-beta.20261120.1", items: ["The offer (#3)"] },
        { version: "1.1.0", items: ["A Stable release (#2)"] },
        { version: "1.1.1-beta.20261110.1", items: ["A Beta between (#4)"] },
      ],
      "1.0.0",
      "1.2.0-beta.20261120.1",
    );
    expect(view?.coming.map((build) => build.version)).toEqual([
      "1.2.0-beta.20261120.1",
      "1.1.1-beta.20261110.1",
    ]);
  });

  it("with nothing newer, only the running build's list; with no list for it, nothing", () => {
    expect(whatsNewView(builds, running, null)).toEqual({ coming: [], running: ["Running (#6)"] });
    expect(whatsNewView(builds, running, running)).toEqual({
      coming: [],
      running: ["Running (#6)"],
    });
    expect(whatsNewView(builds, "0.1.1-beta.20261118.1", null)).toBeUndefined();
    expect(whatsNewView(builds, null, "0.1.1-beta.20261121.1")).toBeUndefined();
    expect(whatsNewView([], running, "0.1.1-beta.20261121.1")).toBeUndefined();
  });
});

describe("F-554: reading whats-new.json", () => {
  let server: FeedServer;
  beforeEach(async () => {
    server = await feedServer();
  });
  afterEach(() => server.close());
  const feed = () => new URL(`${server.origin}/updates/beta/feed.json`);
  const good = file([{ version: "0.1.1-beta.20261120.2", items: ["One (#1)"] }]);

  it("reads the file beside the feed", async () => {
    server.route("/updates/beta/whats-new.json", json(good));
    expect(await readWhatsNew(feed(), "Clawtrate/test")).toEqual([
      { version: "0.1.1-beta.20261120.2", items: ["One (#1)"] },
    ]);
    expect(server.requests).toEqual(["/updates/beta/whats-new.json"]);
  });

  it("gives no list for a file that is not valid UTF-8", async () => {
    server.route("/updates/beta/whats-new.json", (_request, response) => {
      response.writeHead(200);
      response.end(
        Buffer.concat([
          Buffer.from('{"format":1,"builds":[{"version":"0.1.1-beta.20261120.2","items":["Bad '),
          Buffer.from([0xff]),
          Buffer.from(' byte (#1)"]}]}'),
        ]),
      );
    });
    expect(await readWhatsNew(feed(), "Clawtrate/test")).toBeNull();
  });

  it("gives no list for a missing, malformed, oversized, slow or redirected file", async () => {
    const answers: Record<string, Parameters<FeedServer["route"]>[1] | null> = {
      missing: null,
      malformed: json("{"),
      oversized: (_request, response) => {
        response.writeHead(200, { "content-length": String(200 * 1024) });
        response.end("x".repeat(200 * 1024));
      },
      "too long once read": (_request, response) => {
        response.writeHead(200);
        response.end(" ".repeat(64) + good);
      },
      slow: () => {},
      redirected: (_request, response) => {
        response.writeHead(302, { location: "https://elsewhere.example/whats-new.json" });
        response.end();
      },
    };
    for (const [name, answer] of Object.entries(answers)) {
      const path = `/${name.replaceAll(" ", "-")}/whats-new.json`;
      if (answer) server.route(path, answer);
      const started = Date.now();
      const read = await readWhatsNew(
        new URL(`${server.origin}/${name.replaceAll(" ", "-")}/feed.json`),
        "Clawtrate/test",
        name === "too long once read"
          ? { timeoutMs: 300, maxBytes: good.length }
          : { timeoutMs: 300 },
      );
      expect(read, name).toBeNull();
      expect(Date.now() - started, name).toBeLessThan(3_000);
    }
  });
});

describe("F-554: the fixture shows what the app would", () => {
  it("places its lists as whatsNewView does for its versions", async () => {
    const { FIXTURE_BETA_NOTES, fixtureUpdates } = await import("../../src/fixture/updates.ts");
    const read = (query: string) => fixtureUpdates(new URLSearchParams(query)).get();
    const beta = "buildTrack=nightly&track=nightly";
    expect((await read(`updates=offered&${beta}`)).whatsNew).toEqual(
      whatsNewView(FIXTURE_BETA_NOTES, "0.1.0-beta.20261115.1", "0.2.0-beta.20261116.1"),
    );
    expect((await read(`updates=nothing-newer&${beta}`)).whatsNew).toEqual(
      whatsNewView(FIXTURE_BETA_NOTES, "0.1.0-beta.20261115.1", null),
    );
    // After an update, the running build is the one installed, and its list is the one shown.
    expect((await read(`updates=nothing-newer&${beta}&after=target-running`)).whatsNew).toEqual(
      whatsNewView(FIXTURE_BETA_NOTES, "0.2.0-beta.20261116.1", null),
    );
    // After a failed download the check had read its lists, so this build's shows; after a
    // failed check there were none.
    expect((await read(`updates=faildl&${beta}`)).whatsNew).toEqual(
      whatsNewView(FIXTURE_BETA_NOTES, "0.1.0-beta.20261115.1", null),
    );
    for (const query of [
      `updates=failcheck&${beta}`,
      `updates=not-checked&${beta}`,
      `updates=offered&${beta}&whatsNew=none`,
      "updates=offered&buildTrack=nightly&track=stable",
    ])
      expect("whatsNew" in (await read(query)), query).toBe(false);
  });
});
