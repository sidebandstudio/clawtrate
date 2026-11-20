import type { DesktopUpdateReply, DesktopUpdateSnapshot } from "@clawtrate/core";
import { createUpdatePreferenceStore } from "../../src/main/update/preferences.ts";
import { updateDefines } from "../../packaging/update-defines.ts";
import { checkFeedAddress } from "../../src/main/update/address.ts";
import { symlinkSync, statSync, readFileSync } from "node:fs";
import { existsSync, mkdirSync, writeFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdateEngine } from "../../src/main/update/engine.ts";
import { DesktopUpdateService } from "../../src/main/update/service.ts";
import { bytes, feedFor, feedServer, json, payload, tempDir, type FeedServer } from "./harness.ts";

let server: FeedServer;
let dir: ReturnType<typeof tempDir>;
let updates: string;
const snapshots: DesktopUpdateSnapshot[] = [];
const fixture = payload(4000);
const nightly = "1.1.0-nightly.20261101.9";
function document(version: string, track: string) {
  return feedFor(
    server.origin,
    version,
    { size: fixture.body.length, sha512: fixture.sha512 },
    { track },
  );
}
beforeEach(async () => {
  server = await feedServer();
  dir = tempDir();
  updates = join(dir.path, "updates");
  snapshots.length = 0;
  server.route("/stable", json(document("1.1.0", "stable")));
  server.route("/nightly", json(document(nightly, "nightly")));
  server.route("/files/app.zip", bytes(fixture.body));
});
afterEach(async () => {
  await server.close();
  dir.remove();
});
const store = () => createUpdatePreferenceStore(join(dir.path, "preferences.json"));
const start = (overrides: Partial<Parameters<typeof DesktopUpdateService.start>[0]> = {}) =>
  DesktopUpdateService.start({
    packaged: true,
    version: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    downloadDir: updates,
    releaseDate: null,
    store: store(),
    changed: (s) => snapshots.push(s),
    feeds: { stable: server.origin + "/stable", nightly: server.origin + "/nightly" },
    loopbackHttpForTests: { port: server.port },
    ...overrides,
  });
async function offer(service: DesktopUpdateService) {
  const {
    snapshot: { state },
  } = await service.check(service.get().selectedTrack);
  if (state.kind !== "offered") throw Error(JSON.stringify(state));
  return state.offerId;
}
it("removes old files and makes zero requests at launch, on get, and on choosing a track", async () => {
  mkdirSync(updates);
  writeFileSync(join(updates, "old.partial"), "old");
  const service = await start();
  expect(existsSync(updates)).toBe(false);
  expect(service.get()).toMatchObject({
    runningTrack: "stable",
    selectedTrack: "stable",
    lastCheck: null,
    state: { kind: "not-checked" },
  });
  await service.chooseTrack("nightly");
  expect(server.requests).toEqual([]);
  const id = await offer(service);
  expect((await service.download(id)).snapshot).toMatchObject({
    state: { kind: "verified", offerId: id, version: nightly, size: fixture.body.length },
  });
  expect(readdirSync(updates)).toHaveLength(1);
  expect(server.requests).toEqual(["/nightly", "/files/app.zip"]);
  const checked = service.get().lastCheck;
  expect(checked).toMatchObject({ track: "nightly", readAt: expect.stringMatching(/Z$/) });
  expect(JSON.stringify(snapshots)).not.toMatch(/https?:|app\.zip|\.partial|sha512|"path"/);
  expect(service.get().tracks).toEqual(
    ["stable", "nightly"].map((track) => ({ track, source: "127.0.0.1" })),
  );
  expect((await start()).get()).toMatchObject({
    runningTrack: "stable",
    selectedTrack: "nightly",
    lastCheck: checked,
    state: { kind: "not-checked" },
  });
  expect(existsSync(updates)).toBe(false);
});
it("drops the old identity and verified bytes when switching tracks", async () => {
  const service = await start();
  const old = await offer(service);
  await service.chooseTrack("nightly");
  const current = await offer(service);
  await service.download(old);
  expect(service.get().state).toMatchObject({ kind: "offered", offerId: current });
  await service.download(current);
  await service.chooseTrack("stable");
  expect(existsSync(updates)).toBe(false);
  expect(server.requests).toEqual(["/stable", "/nightly", "/files/app.zip"]);
});
it.each(["check", "download"] as const)(
  "discards an outstanding %s and refuses overlapping requests",
  async (stage) => {
    const service = await start();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    server.route(stage === "check" ? "/stable" : "/files/app.zip", async (req, res) => {
      entered.resolve();
      await resume.promise;
      (stage === "check" ? json(document("1.1.0", "stable")) : bytes(fixture.body))(req, res);
    });
    const id = stage === "download" ? await offer(service) : "old";
    const pending =
      stage === "check" ? service.check(service.get().selectedTrack) : service.download(id);
    await entered.promise;
    const replies = await Promise.all([
      service.check(service.get().selectedTrack),
      service.download(id),
    ]);
    expect(replies.map((r) => r.outcome)).toEqual(["busy", "busy"]);
    expect(service.get()).not.toHaveProperty("outcome");
    await service.chooseTrack("nightly");
    resume.resolve();
    expect((await pending).outcome).toBe("superseded");
    expect(service.get()).toMatchObject({
      selectedTrack: "nightly",
      state: { kind: "not-checked" },
    });
    expect(existsSync(updates)).toBe(false);
    expect(server.requests).toEqual(
      stage === "check" ? ["/stable"] : ["/stable", "/files/app.zip"],
    );
  },
);
it("refuses a feed for another track and records only completed reads", async () => {
  const service = await start();
  server.route("/stable", (_req, res) => res.destroy());
  expect((await service.check(service.get().selectedTrack)).snapshot.lastCheck).toBeNull();
  for (const [version, track] of [
    [nightly, "nightly"],
    [nightly, "stable"],
  ] as const) {
    server.route("/stable", json(document(version, track)));
    expect((await service.check(service.get().selectedTrack)).snapshot).toMatchObject({
      lastCheck: { track: "stable", readAt: expect.stringMatching(/Z$/) },
      state: { kind: "failed", reason: "wrong-track" },
    });
  }
});
it("keeps the previous track when saving fails and checks it next", async () => {
  const prefs = store();
  vi.spyOn(prefs, "set").mockRejectedValueOnce(Error("disk full"));
  const service = await start({ store: prefs });
  expect((await service.chooseTrack("nightly")).snapshot).toMatchObject({
    selectedTrack: "stable",
    state: { kind: "failed", stage: "preferences", reason: "write-failed" },
  });
  expect(server.requests).toEqual([]);
  await offer(service);
  expect(server.requests).toEqual(["/stable"]);
});
it("reports the running version when the selected track offers an older build", async () => {
  const service = await start({ version: "2.0.0-nightly.20261102.1" });
  expect(service.get().selectedTrack).toBe("nightly");
  await service.chooseTrack("stable");
  expect((await service.check(service.get().selectedTrack)).snapshot).toMatchObject({
    runningVersion: "2.0.0-nightly.20261102.1",
    state: { kind: "nothing-newer" },
  });
});
it("describes a single source, development copies and invalid running versions", async () => {
  const single = await start({ feeds: { stable: server.origin + "/stable", nightly: null } });
  expect(single.get().tracks).toHaveLength(1);
  expect((await single.chooseTrack("nightly")).snapshot.selectedTrack).toBe("stable");
  expect((await (await start({ packaged: false })).check("stable")).snapshot.state).toMatchObject({
    reason: "development-build",
  });
  expect((await (await start({ version: "bad" })).check("stable")).snapshot).toMatchObject({
    runningTrack: null,
    runningVersion: null,
    state: { reason: "invalid-version" },
  });
  expect(server.requests).toEqual([]);
});

it.each(["check", "download"] as const)(
  "ignores a completed %s whose result arrives after a switch",
  async (operation) => {
    const service = await start();
    const id = operation === "download" ? await offer(service) : null;
    const completed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = UpdateEngine.prototype[operation];
    const delayed = vi
      .spyOn(UpdateEngine.prototype, operation)
      .mockImplementationOnce(async function (this: UpdateEngine) {
        const result = await original.call(this);
        completed.resolve();
        await release.promise;
        return result;
      });
    try {
      const pending = id ? service.download(id) : service.check(service.get().selectedTrack);
      await completed.promise;
      if (id) expect(readdirSync(updates)).toHaveLength(1);
      const change = service.chooseTrack("nightly");
      expect(service.get().pendingTrack).toBe("nightly");
      expect((await service.chooseTrack("stable")).outcome).toBe("busy");
      release.resolve();
      await Promise.all([pending, change]);
      expect(service.get().state.kind).toBe("not-checked");
      expect(existsSync(updates)).toBe(false);
    } finally {
      release.resolve();
      delayed.mockRestore();
    }
  },
);

it("a failed file-store write cannot slip into a later successful save", async () => {
  const prefs = store();
  const service = await start({ store: prefs });
  await service.chooseTrack("nightly");
  const path = join(dir.path, "preferences.json");
  renameSync(path, path + ".saved");
  mkdirSync(path);
  expect((await service.chooseTrack("stable")).snapshot).toMatchObject({
    selectedTrack: "nightly",
    state: { reason: "write-failed" },
  });
  await expect(prefs.get("selectedTrack")).rejects.toThrow();
  rmSync(path, { recursive: true });
  renameSync(path + ".saved", path);
  await service.check(service.get().selectedTrack);
  expect((await start()).get().selectedTrack).toBe("nightly");
});

it("checks ancestry before cleanup and refuses a linked destination before opening a file", async () => {
  const outside = join(dir.path, "other");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "keep");
  const service = await start();
  const id = await offer(service);
  symlinkSync(outside, updates, "junction");
  expect((await service.download(id)).snapshot).toMatchObject({
    state: {
      kind: "failed",
      reason: "write-failed",
      retry: "check",
      lastOffer: { version: "1.1.0" },
    },
  });
  expect(readdirSync(outside)).toEqual(["keep"]);
  const nested = await start({ downloadDir: join(updates, "keep") });
  expect(nested.get().state.kind).toBe("failed");
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep");
  expect(server.requests).toEqual(["/stable"]);
});

it("gives same-version offers separate private destinations and removes the older bytes", async () => {
  const service = await start();
  const first = await offer(service);
  await service.download(first);
  const old = join(updates, first);
  expect(readdirSync(old)).toHaveLength(1);
  if (process.platform !== "win32") expect(statSync(old).mode & 0o777).toBe(0o700);
  const other = payload(6500);
  server.route(
    "/stable",
    json(feedFor(server.origin, "1.1.0", { size: other.body.length, sha512: other.sha512 })),
  );
  server.route("/files/app.zip", bytes(other.body));
  const second = await offer(service);
  expect(second).not.toBe(first);
  expect((await service.download(first)).snapshot.state).toMatchObject({
    kind: "offered",
    offerId: second,
  });
  expect(server.requests).toEqual(["/stable", "/files/app.zip", "/stable"]);
  expect(existsSync(old)).toBe(false);
  await service.download(second);
  const fresh = join(updates, second);
  expect(readFileSync(join(fresh, readdirSync(fresh)[0]!))).toEqual(other.body);
});

it("marks the command busy before notifying a throwing observer", async () => {
  const replies: Promise<DesktopUpdateReply>[] = [];
  const service = await start({
    changed: (s) => {
      if (s.state.kind === "checking") replies.push(service.download("stale"));
      if (s.state.kind === "downloading") replies.push(service.check(service.get().selectedTrack));
      throw Error("renderer gone");
    },
  });
  const id = await offer(service);
  expect((await service.download(id)).snapshot).toMatchObject({ state: { kind: "verified" } });
  expect(replies.length).toBeGreaterThan(1);
  for (const reply of await Promise.all(replies)) expect(reply.outcome).toBe("busy");
  expect(server.requests).toEqual(["/stable", "/files/app.zip"]);
});

it("neither startup nor track selection schedules a later check", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
  try {
    const service = await start();
    expect(vi.getTimerCount()).toBe(0);
    await service.chooseTrack("nightly");
    expect(vi.getTimerCount()).toBe(0);
    expect(server.requests).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("refuses a check for a selection another caller has changed", async () => {
  const service = await start();
  await service.chooseTrack("nightly");
  expect((await service.check("stable")).outcome).toBe("stale");
  expect((await service.check({})).outcome).toBe("invalid");
  expect(server.requests).toEqual([]);
  expect((await service.check("nightly")).outcome).toBe("accepted");
  expect(server.requests).toEqual(["/nightly"]);
});

it("reports check eligibility at launch and stops unsupported checks before transport", async () => {
  for (const version of ["0.1.0", "1.1.0"]) {
    const service = await start({ version, platform: "linux" });
    expect(service.get().state).toMatchObject({ reason: "unsupported-system" });
    expect((await service.check(service.get().selectedTrack)).outcome).toBe("invalid");
    await service.chooseTrack("nightly");
    expect(service.get().state).toMatchObject({ reason: "unsupported-system" });
  }
  const empty = await start({ feeds: { stable: null, nightly: null } });
  expect(empty.get()).toMatchObject({ selectedTrack: null, state: { reason: "not-configured" } });
  expect((await start({ version: "invalid" })).get().state).toMatchObject({
    reason: "invalid-version",
  });
  expect(server.requests).toEqual([]);
});
it("keeps the accepted comparison and its time when history cannot be saved", async () => {
  const prefs = store();
  vi.spyOn(prefs, "set").mockRejectedValueOnce(Error("unwritable"));
  const service = await start({ store: prefs });
  const reply = await service.check("stable");
  expect(reply).toMatchObject({
    outcome: "accepted",
    snapshot: {
      lastCheck: { track: "stable", readAt: expect.stringMatching(/Z$/) },
      preferenceIssue: "last-check-not-saved",
      state: { kind: "offered" },
    },
  });
});
it("reads saved preferences even when the download folder cannot be cleaned", async () => {
  const service = await start();
  await service.check("stable");
  await service.chooseTrack("nightly");
  const broken = await start({ downloadDir: join(dir.path, "missing", "updates") });
  expect(broken.get()).toMatchObject({
    selectedTrack: "nightly",
    lastCheck: { track: "stable" },
    state: { reason: "write-failed" },
  });
});
it.each(["check", "download"] as const)(
  "retires %s throughout a delayed track save",
  async (operation) => {
    const prefs = store(),
      service = await start({ store: prefs });
    const id = await offer(service);
    const reached = Promise.withResolvers<void>(),
      hold = Promise.withResolvers<void>();
    server.route(operation === "check" ? "/stable" : "/files/app.zip", async (req, res) => {
      reached.resolve();
      await hold.promise;
      (operation === "check" ? json(document("1.1.0", "stable")) : bytes(fixture.body))(req, res);
    });
    const writing = Promise.withResolvers<void>(),
      saved = Promise.withResolvers<void>();
    vi.spyOn(prefs, "set").mockImplementationOnce(async () => {
      writing.resolve();
      await saved.promise;
    });
    const old = operation === "check" ? service.check("stable") : service.download(id);
    await reached.promise;
    const boundary = snapshots.length;
    const choice = service.chooseTrack("nightly");
    expect(service.get()).toMatchObject({
      selectedTrack: "stable",
      pendingTrack: "nightly",
      state: { kind: "not-checked" },
    });
    await writing.promise;
    hold.resolve();
    expect((await old).outcome).toBe("superseded");
    expect((await service.chooseTrack("stable")).outcome).toBe("busy");
    expect(snapshots.slice(boundary).every((s) => s.state.kind === "not-checked")).toBe(true);
    saved.resolve();
    expect(await choice).toMatchObject({
      outcome: "accepted",
      snapshot: { selectedTrack: "nightly", pendingTrack: null },
    });
    expect(existsSync(updates)).toBe(false);
    const revisions = snapshots.map((s) => s.revision);
    expect(revisions.every((r, i) => i === 0 || revisions[i - 1]! < r)).toBe(true);
  },
);
it("an unsuccessful track choice still retires the file and its offer", async () => {
  const prefs = store(),
    service = await start({ store: prefs });
  const id = await offer(service);
  await service.download(id);
  vi.spyOn(prefs, "set").mockRejectedValueOnce(Error("read only"));
  expect(await service.chooseTrack("nightly")).toMatchObject({
    snapshot: { selectedTrack: "stable", pendingTrack: null, state: { stage: "preferences" } },
  });
  expect((await service.download(id)).outcome).toBe("stale");
  expect(existsSync(updates)).toBe(false);
});
it("attributes a completed read across a switch while its history write drains", async () => {
  const prefs = store(),
    service = await start({ store: prefs });
  const write = prefs.set,
    saving = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  vi.spyOn(prefs, "set").mockImplementationOnce(async (key, value) => {
    saving.resolve();
    await finish.promise;
    await write(key, value);
  });
  const check = service.check("stable");
  await saving.promise;
  const lastCheck = service.get().lastCheck;
  expect(lastCheck?.track).toBe("stable");
  const choice = service.chooseTrack("nightly");
  finish.resolve();
  await Promise.all([check, choice]);
  expect(service.get()).toMatchObject({ selectedTrack: "nightly", lastCheck });
  expect((await start()).get().lastCheck).toEqual(lastCheck);
});

it("checks the kept bytes after the final download progress event", async () => {
  let id = "";
  const service = await start({
    changed: (snapshot) => {
      snapshots.push(snapshot);
      if (
        snapshot.state.kind === "downloading" &&
        snapshot.state.received === fixture.body.length
      ) {
        const folder = join(updates, id);
        writeFileSync(join(folder, readdirSync(folder)[0]!), Buffer.alloc(fixture.body.length, 42));
      }
    },
  });
  id = await offer(service);
  expect((await service.download(id)).snapshot.state).toMatchObject({ reason: "hash-mismatch" });
  expect(snapshots.some((s) => s.state.kind === "verified")).toBe(false);
  expect(readdirSync(join(updates, id))).toEqual([]);
});

it.each(["missing", "changed", "replaced", "check", "choice", "quit"])(
  "retires the verified record on %s",
  async (event) => {
    const service = await start();
    const id = await offer(service);
    await service.download(id);
    expect(await service.recheckVerified("another-offer")).toBe(false);
    expect(await service.recheckVerified(id)).toBe(true);
    const folder = join(updates, id);
    const path = join(folder, readdirSync(folder)[0]!);
    if (event === "missing") rmSync(path);
    if (event === "changed") writeFileSync(path, Buffer.alloc(fixture.body.length, 7));
    if (event === "replaced") {
      renameSync(path, path + ".old");
      writeFileSync(path, fixture.body);
    }
    if (event === "check") await service.check("stable");
    if (event === "choice") await service.chooseTrack("nightly");
    if (event === "quit") service.shutdown();
    expect(await service.recheckVerified(id)).toBe(false);
    if (["missing", "changed", "replaced"].includes(event))
      expect(service.get().state).toMatchObject({ reason: "artifact-changed" });
  },
);

it("reads the last JSON value for a repeated track", async () => {
  const service = await start();
  const feed = JSON.stringify(document("1.1.0", "stable"));
  for (const [first, last, expected] of [
    ["nightly", "stable", { kind: "offered" }],
    ["stable", "nightly", { kind: "failed", reason: "wrong-track" }],
  ] as const) {
    server.route("/stable", (_req, res) =>
      res.end(feed.replace('"track":"stable"', `"track":"${first}","track":"${last}"`)),
    );
    expect((await service.check("stable")).snapshot.state).toMatchObject(expected);
  }
});

it("bounds preference reads and recovers when the file is repaired", async () => {
  const path = join(dir.path, "preferences.json");
  const prefs = store();
  for (const bad of [
    " ".repeat(1024) + "{}",
    "[]",
    '{"selectedTrack":42}',
    '{"lastCheck":false}',
  ]) {
    writeFileSync(path, bad);
    const service = await start({ store: prefs });
    expect(service.get().state).toMatchObject({ reason: "write-failed" });
    expect((await service.chooseTrack("nightly")).snapshot.selectedTrack).toBe("stable");
    expect(readFileSync(path, "utf8")).toBe(bad);
  }
  const history = { track: "nightly", readAt: "2026-11-01T00:00:00.000Z" };
  writeFileSync(
    path,
    JSON.stringify({
      other: "discard",
      lastCheckedAt: history.readAt,
      lastCheck: JSON.stringify({ ...history, extra: true }),
    }),
  );
  await prefs.set("selectedTrack", "nightly");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    selectedTrack: "nightly",
    lastCheck: history,
  });
  expect(readdirSync(dir.path)).toEqual(["preferences.json"]);
});
it("bounds the packaged and displayed hostname to 253 characters", async () => {
  const host = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
  for (const suffix of ["", "x"]) {
    const name = host + suffix,
      url = "https://" + name + "/feed";
    const defines = () => updateDefines({ CLAWTRATE_UPDATE_FEED_URL: url }, new Date());
    if (suffix) expect(defines).toThrow(/253/);
    else expect(defines).not.toThrow();
    expect(checkFeedAddress(url).ok).toBe(!suffix);
    const service = await start({ feeds: { stable: url, nightly: null } });
    expect(service.get().tracks).toEqual(suffix ? [] : [{ track: "stable", source: name }]);
  }
  expect(server.requests).toEqual([]);
});

it("a nightly-only build stays idle and checks only its one configured source", async () => {
  const service = await start({ feeds: { stable: null, nightly: server.origin + "/nightly" } });
  expect(service.get()).toMatchObject({
    runningTrack: "stable",
    selectedTrack: "nightly",
    tracks: [{ track: "nightly", source: "127.0.0.1" }],
  });
  expect((await service.chooseTrack("stable")).outcome).toBe("invalid");
  expect(server.requests).toEqual([]);
  expect((await service.check("nightly")).snapshot.state.kind).toBe("offered");
  expect(server.requests).toEqual(["/nightly"]);
});

it("keeps a history save error visible when a track choice is draining it", async () => {
  const prefs = store();
  const saving = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  vi.spyOn(prefs, "set").mockImplementationOnce(async () => {
    saving.resolve();
    await resume.promise;
    throw Error("disk write failed");
  });
  const service = await start({ store: prefs });
  const check = service.check("stable");
  await saving.promise;
  const choice = service.chooseTrack("nightly");
  resume.resolve();
  expect((await check).outcome).toBe("superseded");
  expect((await choice).snapshot).toMatchObject({
    selectedTrack: "nightly",
    state: { kind: "not-checked" },
    lastCheck: { track: "stable" },
    preferenceIssue: "last-check-not-saved",
  });
});
