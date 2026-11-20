import { createHash } from "node:crypto";
import { linkSync } from "node:fs";
import { stageAtLoopback } from "./mac-handoff-stand-in.ts";
import type { UpdateInstaller } from "../../src/main/update/install.ts";
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

import { rename } from "node:fs/promises";
vi.mock(import("node:fs/promises"), async (original) => {
  const actual = await original();
  return { ...actual, rename: vi.fn(actual.rename) };
});
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
    preferenceIssue: "track-not-saved",
    state: { kind: "not-checked" },
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

it("keeps the old preference file until an atomic replacement and on a commit failure", async () => {
  const prefs = store(),
    path = join(dir.path, "preferences.json");
  await prefs.set("selectedTrack", "stable");
  const old = readFileSync(path);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  vi.mocked(rename).mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    throw Error("rename refused");
  });
  const saving = prefs.set("selectedTrack", "nightly");
  try {
    expect(
      await Promise.race([entered.promise.then(() => "rename"), saving.then(() => "complete")]),
    ).toBe("rename");
    expect(readFileSync(path)).toEqual(old);
    expect(JSON.parse(readFileSync(path + ".next", "utf8"))).toEqual({ selectedTrack: "nightly" });
  } finally {
    release.resolve();
  }
  await expect(saving).rejects.toThrow("rename refused");
  expect(readFileSync(path)).toEqual(old);
  expect(existsSync(path + ".next")).toBe(false);
  await prefs.set("selectedTrack", "nightly");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ selectedTrack: "nightly" });
});
it("a failed file-store write cannot slip into a later successful save", async () => {
  const prefs = store();
  const service = await start({ store: prefs });
  await service.chooseTrack("nightly");
  const path = join(dir.path, "preferences.json");
  renameSync(path, path + ".saved");
  mkdirSync(path);
  expect((await service.chooseTrack("stable")).snapshot).toMatchObject({
    selectedTrack: "nightly",
    preferenceIssue: "track-not-saved",
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
  expect(nested.get().preferenceIssue).toBe("update-folder-unavailable");
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

it("accepts a download as soon as an observer sees the offer", async () => {
  const prefs = store();
  const saving = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  vi.spyOn(prefs, "set").mockImplementationOnce(async () => {
    saving.resolve();
    await finish.promise;
  });
  let download: Promise<DesktopUpdateReply> | undefined;
  const service = await start({
    store: prefs,
    changed: ({ state }) => {
      if (state.kind === "offered") download = service.download(state.offerId);
    },
  });
  const check = service.check("stable");
  await saving.promise;
  const stateWhileSaving = service.get().state.kind;
  finish.resolve();
  await check;
  expect(await download).toMatchObject({
    outcome: "accepted",
    snapshot: { state: { kind: "verified" } },
  });
  expect(stateWhileSaving).toBe("checking");
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
  for (const track of ["stable", "nightly", undefined])
    expect(await empty.check(track)).toEqual({ outcome: "invalid", snapshot: empty.get() });
  const single = await start({ feeds: { stable: server.origin + "/stable", nightly: null } });
  expect((await single.check("nightly")).outcome).toBe("stale");
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
    preferenceIssue: "update-folder-unavailable",
  });
});
it.each(["check", "download"] as const)(
  "retires %s throughout a delayed track save",
  async (operation) => {
    const prefs = store();
    const secondSubscriber: DesktopUpdateSnapshot[] = [];
    const service = await start({
      store: prefs,
      changed(snapshot) {
        snapshots.push(snapshot);
        secondSubscriber.push(snapshot);
      },
    });
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
    expect(secondSubscriber.slice(boundary)).toEqual(snapshots.slice(boundary));
    expect(
      secondSubscriber.slice(boundary).map((s) => [s.pendingTrack, s.selectedTrack, s.state.kind]),
    ).toEqual([
      ["nightly", "stable", "not-checked"],
      [null, "nightly", "not-checked"],
    ]);
    expect(server.requests).toEqual(
      operation === "check" ? ["/stable", "/stable"] : ["/stable", "/files/app.zip"],
    );
    const revisions = snapshots.map((s) => s.revision);
    expect(revisions.every((r, i) => i === 0 || revisions[i - 1]! < r)).toBe(true);
  },
);
it.each(["before save", "during successful save", "during failed save"])(
  "retires a track choice at shutdown %s",
  async (phase) => {
    const prefs = store(),
      service = await start({ store: prefs });
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const set = prefs.set;
    const spy = vi.spyOn(prefs, "set").mockImplementationOnce(async (key, value) => {
      entered.resolve();
      await release.promise;
      if (phase === "during failed save") throw Error("write refused");
      await set(key, value);
    });
    const choice = service.chooseTrack("nightly");
    if (phase !== "before save") await entered.promise;
    const count = snapshots.length;
    expect(snapshots.at(-1)?.pendingTrack).toBe("nightly");
    service.shutdown();
    const closed = service.get();
    expect(closed).toMatchObject({ selectedTrack: "stable", pendingTrack: null });
    release.resolve();
    expect(await choice).toEqual({ outcome: "superseded", snapshot: closed });
    expect(spy).toHaveBeenCalledTimes(phase === "before save" ? 0 : 1);
    for (const reply of await Promise.all([
      service.chooseTrack("nightly"),
      service.check("stable"),
      service.download("id"),
    ]))
      expect(reply).toEqual({ outcome: "invalid", snapshot: closed });
    expect(snapshots).toHaveLength(count);
    expect(service.get()).toBe(closed);
    expect((await start()).get().selectedTrack).toBe(
      phase === "during successful save" ? "nightly" : "stable",
    );
  },
);
it("an unsuccessful track choice still retires the file and its offer", async () => {
  const prefs = store(),
    service = await start({ store: prefs });
  const id = await offer(service);
  await service.download(id);
  vi.spyOn(prefs, "set").mockRejectedValueOnce(Error("read only"));
  expect(await service.chooseTrack("nightly")).toMatchObject({
    snapshot: {
      selectedTrack: "stable",
      pendingTrack: null,
      preferenceIssue: "track-not-saved",
      state: { kind: "not-checked" },
    },
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
    if (event === "quit") {
      service.shutdown();
      const revision = service.get().revision;
      service.shutdown();
      expect(service.get().revision).toBe(revision);
    }
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
    expect(service.get()).toMatchObject({
      preferenceIssue: "preferences-not-read",
      state: { kind: "not-checked" },
    });
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
  const checked = await service.check("nightly");
  expect(checked).toMatchObject({
    outcome: "accepted",
    snapshot: {
      runningTrack: "stable",
      selectedTrack: "nightly",
      lastCheck: { track: "nightly", readAt: expect.stringMatching(/Z$/) },
      state: { kind: "offered" },
    },
  });
  const again = await start({ feeds: { stable: null, nightly: server.origin + "/nightly" } });
  expect(again.get().lastCheck).toEqual(checked.snapshot.lastCheck);
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

it("distinguishes folder preparation from a settings read even with no source", async () => {
  const feeds = { stable: null, nightly: null };
  const broken = await start({ feeds, downloadDir: join(dir.path, "absent", "updates") });
  expect(broken.get()).toMatchObject({
    selectedTrack: null,
    preferenceIssue: "update-folder-unavailable",
    state: { reason: "not-configured" },
  });
  const prefs = store();
  vi.spyOn(prefs, "get").mockRejectedValueOnce(Error("fixture read"));
  const unreadable = await start({ feeds, store: prefs });
  expect(unreadable.get()).toMatchObject({
    selectedTrack: null,
    preferenceIssue: "preferences-not-read",
    state: { reason: "not-configured" },
  });
  expect((await start({ feeds })).get().preferenceIssue).toBeNull();
  expect(server.requests).toEqual([]);
});

it("returns invalid for missing idle arguments and busy during a choice", async () => {
  const service = await start();
  const malformed = () =>
    Promise.all([
      service.check(undefined),
      service.chooseTrack(undefined),
      service.download(undefined),
    ]);
  expect((await malformed()).map((r) => r.outcome)).toEqual(["invalid", "invalid", "invalid"]);
  const choice = service.chooseTrack("nightly");
  expect((await malformed()).map((r) => r.outcome)).toEqual(["busy", "busy", "busy"]);
  await choice;
  expect((await service.check("stable")).outcome).toBe("stale");
  expect(server.requests).toEqual([]);
});

it("defaults an invalid version to Stable and preserves the saved choice when folder cleanup fails", async () => {
  const service = await start({ version: "invalid" });
  expect(service.get()).toMatchObject({
    tracks: [{ track: "stable" }, { track: "nightly" }],
    runningTrack: null,
    selectedTrack: "stable",
  });
  const prefs = store();
  await prefs.set("selectedTrack", "stable");
  const path = join(dir.path, "preferences.json"),
    old = readFileSync(path);
  const broken = await start({ store: prefs, downloadDir: join(dir.path, "missing", "updates") });
  expect(await broken.chooseTrack("nightly")).toMatchObject({
    outcome: "accepted",
    snapshot: {
      preferenceIssue: "update-folder-unavailable",
      selectedTrack: "stable",
      pendingTrack: null,
    },
  });
  expect(readFileSync(path)).toEqual(old);
  expect(server.requests).toEqual([]);
});

function installStandIn(): UpdateInstaller {
  return { unavailable: null, inspect: vi.fn(async () => null), launch: vi.fn(async () => null) };
}

it.each(["build-not-signed", "no-installer-path"] as const)(
  "never asks the adapter to inspect or launch when the build says %s",
  async (reason) => {
    const installer = { ...installStandIn(), unavailable: reason };
    const service = await start({ installer });
    const id = await offer(service);
    await service.download(id);
    expect(service.get().install).toEqual({ kind: "unavailable-in-this-build", reason });
    expect((await service.restart(id)).outcome).toBe("invalid");
    service.shutdown();
    expect(installer.inspect).not.toHaveBeenCalled();
    expect(installer.launch).not.toHaveBeenCalled();
    expect(await store().get("attempt")).toBeNull();
  },
);

it.each([
  "authenticode-trust",
  "publisher-mismatch",
  "mac-designated-requirement",
  "installation-context",
] as const)(
  "matching bytes alone cannot offer Restart when inspection reports %s",
  async (reason) => {
    const installer = installStandIn();
    installer.inspect = async () => reason;
    const service = await start({ installer });
    const id = await offer(service);
    expect((await service.download(id)).snapshot).toMatchObject({
      state: { kind: "verified", offerId: id },
      install: { kind: "unavailable-in-this-build", reason },
    });
    expect((await service.restart(id)).outcome).toBe("invalid");
    expect(installer.launch).not.toHaveBeenCalled();
  },
);

it.each(["changed", "replaced", "truncated", "symlink", "hardlink"])(
  "refuses a %s file between offering Restart and acting on it",
  async (change) => {
    const installer = installStandIn();
    const service = await start({ installer });
    const id = await offer(service);
    await service.download(id);
    const folder = join(updates, id);
    const path = join(folder, readdirSync(folder)[0]!);
    if (change === "truncated") writeFileSync(path, fixture.body.subarray(0, 1));
    if (change === "changed") writeFileSync(path, Buffer.alloc(fixture.body.length, 7));
    if (change === "hardlink") linkSync(path, path + ".other");
    if (change === "replaced" || change === "symlink") {
      renameSync(path, path + ".old");
      if (change === "symlink") symlinkSync(path + ".old", path);
      else writeFileSync(path, fixture.body);
    }
    expect((await service.restart(id)).snapshot).toMatchObject({
      state: { kind: "handoff-failed", reason: "artifact-changed" },
      install: { kind: "unavailable-in-this-build", reason: "artifact-changed" },
    });
    expect(installer.launch).not.toHaveBeenCalled();
    expect(await store().get("attempt")).toBeNull();
  },
);

it("accepts Restart from the first eligible verified snapshot after inspection", async () => {
  const installer = installStandIn();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  installer.inspect = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return null;
  });
  let restart: Promise<DesktopUpdateReply> | undefined;
  const service = await start({
    installer,
    changed: ({ state, install }) => {
      if (state.kind === "verified" && install.kind === "restart-available")
        restart = service.restart(install.offerId);
    },
  });
  const id = await offer(service);
  const download = service.download(id);
  await entered.promise;
  const during = service.get();
  const early = await service.restart(id);
  release.resolve();
  await download;
  expect(during.state.kind).toBe("downloading");
  expect(during.install.kind).toBe("unavailable-in-this-build");
  expect(early.outcome).toBe("busy");
  expect(await restart).toMatchObject({
    outcome: "accepted",
    snapshot: { state: { kind: "handing-off" } },
  });
  expect(installer.launch).toHaveBeenCalledTimes(1);
});

it("pins Restart to the displayed verified offer across a new check of the same track", async () => {
  const installer = installStandIn();
  const service = await start({ installer });
  const old = await offer(service);
  await service.download(old);
  const checking = service.check("stable");
  expect((await service.restart(old)).outcome).toBe("busy");
  await checking;
  const state = service.get().state;
  if (state.kind !== "offered") throw Error("Expected new offer");
  await service.download(state.offerId);
  expect((await service.restart(old)).outcome).toBe("stale");
  expect((await service.restart({ path: "foreign" })).outcome).toBe("invalid");
  expect(service.get().install).toEqual({ kind: "restart-available", offerId: state.offerId });
  expect(installer.launch).not.toHaveBeenCalled();
});

it("F-231: one explicit Restart records the attempt before one stand-in handoff and quit", async () => {
  const installer = installStandIn();
  const quitAfterLaunch = vi.fn();
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  installer.launch = vi.fn(async (file) => {
    expect(file).toMatchObject({
      track: "stable",
      version: "1.1.0",
      sha512: fixture.sha512,
      size: fixture.body.length,
    });
    expect(JSON.parse((await store().get("attempt"))!)).toMatchObject({
      target: "1.1.0",
      from: "1.0.0",
      track: "stable",
      phase: "handoff",
      time: expect.stringMatching(/Z$/),
    });
    entered.resolve();
    await resume.promise;
    return null;
  });
  const service = await start({ installer, quitAfterLaunch });
  const id = await offer(service);
  await service.download(id);
  expect(installer.launch).not.toHaveBeenCalled();
  const pending = service.restart(id);
  expect(service.get().state.kind).toBe("preparing");
  expect((await service.restart(id)).outcome).toBe("busy");
  await entered.promise;
  expect(service.get().state.kind).toBe("handing-off");
  for (const command of [
    service.check("stable"),
    service.chooseTrack("nightly"),
    service.download(id),
    service.restart(id),
  ])
    expect((await command).outcome).toBe("busy");
  expect(quitAfterLaunch).not.toHaveBeenCalled();
  resume.resolve();
  expect((await pending).snapshot.lastAttempt).toBeNull();
  expect(quitAfterLaunch).toHaveBeenCalledTimes(1);
  expect(installer.launch).toHaveBeenCalledTimes(1);
  expect(server.requests).toEqual(["/stable", "/files/app.zip"]);
  service.shutdown();
  for (const [version, kind] of [
    ["1.1.0", "target-running"],
    ["1.0.0", "old-version-running"],
    ["1.0.1", "unconfirmed"],
    ["invalid", "unconfirmed"],
  ] as const) {
    const prefs = store();
    if (version === "1.1.0") {
      const get = prefs.get;
      vi.spyOn(prefs, "get").mockImplementation(async (key) => {
        if (key === "attempt") expect(existsSync(updates)).toBe(true);
        return get(key);
      });
    }
    const next = await start({ version, store: prefs });
    expect(next.get().lastAttempt).toEqual({
      kind,
      target: "1.1.0",
      from: "1.0.0",
      track: "stable",
      running: version === "invalid" ? null : version,
    });
    expect(existsSync(updates)).toBe(false);
  }
  expect(server.requests).toEqual(["/stable", "/files/app.zip"]);
});

it.each([
  "attempt-not-saved",
  "publisher-mismatch",
  "installer-failed",
  "artifact-changed",
] as const)("reports %s without quitting or retrying", async (reason) => {
  const installer = installStandIn(),
    prefs = store(),
    quitAfterLaunch = vi.fn();
  const service = await start({ installer, store: prefs, quitAfterLaunch });
  const id = await offer(service);
  await service.download(id);
  if (reason === "attempt-not-saved") vi.spyOn(prefs, "set").mockRejectedValueOnce(Error("write"));
  if (reason === "publisher-mismatch") installer.inspect = async () => reason;
  if (reason === "installer-failed" || reason === "artifact-changed")
    installer.launch = vi.fn(async () => reason);
  expect((await service.restart(id)).snapshot).toMatchObject({
    lastAttempt: null,
    state: { kind: "handoff-failed", reason },
  });
  expect((await service.restart(id)).outcome).toBe("stale");
  expect(quitAfterLaunch).not.toHaveBeenCalled();
  expect(installer.launch).toHaveBeenCalledTimes(
    reason === "installer-failed" || reason === "artifact-changed" ? 1 : 0,
  );
});

it("quit during signature inspection retires Restart without a handoff", async () => {
  const installer = installStandIn(),
    service = await start({ installer });
  const id = await offer(service);
  await service.download(id);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  installer.inspect = async () => {
    entered.resolve();
    await release.promise;
    return null;
  };
  const pending = service.restart(id);
  await entered.promise;
  service.shutdown();
  release.resolve();
  expect((await pending).outcome).toBe("superseded");
  expect(installer.launch).not.toHaveBeenCalled();
  expect(await store().get("attempt")).toBeNull();
});

it.each(["success", "failure", "quit"])(
  "the macOS stand-in's loopback listener on %s",
  async (action) => {
    const installer = installStandIn();
    let url: string | undefined;
    installer.launch = async (file) => {
      await stageAtLoopback(file, async (address) => {
        url = address;
        const feed = (await (await fetch(address)).json()) as {
          url: string;
          size: number;
          sha256: string;
        };
        const body = Buffer.from(await (await fetch(feed.url)).arrayBuffer());
        expect(body).toEqual(fixture.body);
        expect(feed.size).toBe(body.length);
        expect(feed.sha256).toBe(createHash("sha256").update(body).digest("hex"));
        expect((await fetch(new URL("/unrelated", address))).status).toBe(404);
        if (action === "failure") throw Error("staging refused");
      });
      return null;
    };
    const service = await start({ installer });
    const id = await offer(service);
    await service.download(id);
    expect(url).toBeUndefined();
    if (action === "quit") {
      service.shutdown();
      expect(url).toBeUndefined();
      return;
    }
    const reply = await service.restart(id);
    expect(reply.snapshot.state.kind).toBe(action === "failure" ? "handoff-failed" : "handing-off");
    expect(url).toBeDefined();
    await expect(fetch(url!)).rejects.toThrow();
  },
);
