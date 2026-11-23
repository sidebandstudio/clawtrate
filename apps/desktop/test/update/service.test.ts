import { spawn, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { fstatSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { linkSync, watch } from "node:fs";
import { macInstaller } from "../../src/main/mac-install.ts";
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

vi.mock(import("node:child_process"), async (original) => {
  const cp = { ...(await original()) };
  vi.spyOn(cp, "spawn");
  return cp;
});
vi.mock(import("node:fs"), async (original) => {
  const fs = { ...(await original()) };
  vi.spyOn(fs, "watch");
  return fs;
});

import type * as FileSystem from "node:fs/promises";
import { open, rename } from "node:fs/promises";
vi.mock(import("node:fs/promises"), async (original) => {
  const actual = await original();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});
let server: FeedServer;
let dir: ReturnType<typeof tempDir>;
let updates: string;
const snapshots: DesktopUpdateSnapshot[] = [];
const fixture = payload(4000);
const nightly = "1.1.0-beta.20261101.9";
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
  } = await service.check(service.get().selectedTrack, service.get().revision);
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
      stage === "check"
        ? service.check(service.get().selectedTrack, service.get().revision)
        : service.download(id);
    await entered.promise;
    const replies = await Promise.all([
      service.check(service.get().selectedTrack, service.get().revision),
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
  expect(
    (await service.check(service.get().selectedTrack, service.get().revision)).snapshot.lastCheck,
  ).toBeNull();
  for (const [version, track] of [
    [nightly, "nightly"],
    [nightly, "stable"],
  ] as const) {
    server.route("/stable", json(document(version, track)));
    expect(
      (await service.check(service.get().selectedTrack, service.get().revision)).snapshot,
    ).toMatchObject({
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
  const service = await start({ version: "2.0.0-beta.20261102.1" });
  expect(service.get().selectedTrack).toBe("nightly");
  await service.chooseTrack("stable");
  expect(
    (await service.check(service.get().selectedTrack, service.get().revision)).snapshot,
  ).toMatchObject({
    runningVersion: "2.0.0-beta.20261102.1",
    state: { kind: "nothing-newer" },
  });
});
it("describes a single source, development copies and invalid running versions", async () => {
  const single = await start({ feeds: { stable: server.origin + "/stable", nightly: null } });
  expect(single.get().tracks).toHaveLength(1);
  expect((await single.chooseTrack("nightly")).snapshot.selectedTrack).toBe("stable");
  const development = await start({ packaged: false });
  expect(
    (await development.check("stable", development.get().revision)).snapshot.state,
  ).toMatchObject({
    reason: "development-build",
  });
  const invalidVersion = await start({ version: "bad" });
  expect(
    (await invalidVersion.check("stable", invalidVersion.get().revision)).snapshot,
  ).toMatchObject({
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
      const pending = id
        ? service.download(id)
        : service.check(service.get().selectedTrack, service.get().revision);
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
  await service.check(service.get().selectedTrack, service.get().revision);
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
  const check = service.check("stable", service.get().revision);
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
      if (s.state.kind === "downloading")
        replies.push(service.check(service.get().selectedTrack, service.get().revision));
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
  expect((await service.check("stable", service.get().revision)).outcome).toBe("stale");
  expect((await service.check({}, service.get().revision)).outcome).toBe("invalid");
  expect(server.requests).toEqual([]);
  expect((await service.check("nightly", service.get().revision)).outcome).toBe("accepted");
  expect(server.requests).toEqual(["/nightly"]);
});

it("reports check eligibility at launch and stops unsupported checks before transport", async () => {
  for (const version of ["0.1.0", "1.1.0"]) {
    const service = await start({ version, platform: "linux" });
    expect(service.get().state).toMatchObject({ reason: "unsupported-system" });
    expect((await service.check(service.get().selectedTrack, service.get().revision)).outcome).toBe(
      "invalid",
    );
    await service.chooseTrack("nightly");
    expect(service.get().state).toMatchObject({ reason: "unsupported-system" });
  }
  const empty = await start({ feeds: { stable: null, nightly: null } });
  for (const track of ["stable", "nightly", undefined])
    expect(await empty.check(track, empty.get().revision)).toEqual({
      outcome: "invalid",
      snapshot: empty.get(),
    });
  const single = await start({ feeds: { stable: server.origin + "/stable", nightly: null } });
  expect((await single.check("nightly", single.get().revision)).outcome).toBe("stale");
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
  const reply = await service.check("stable", service.get().revision);
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
  await service.check("stable", service.get().revision);
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
    const old =
      operation === "check"
        ? service.check("stable", service.get().revision)
        : service.download(id);
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
      service.check("stable", service.get().revision),
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
  const check = service.check("stable", service.get().revision);
  await saving.promise;
  const lastCheck = service.get().lastCheck;
  expect(lastCheck?.track).toBe("stable");
  const choice = service.chooseTrack("nightly");
  finish.resolve();
  await Promise.all([check, choice]);
  expect(service.get()).toMatchObject({ selectedTrack: "nightly", lastCheck });
  expect((await start()).get().lastCheck).toEqual(lastCheck);
});

const refused = (code: string) => Object.assign(Error(code), { code });
const steps = () =>
  snapshots.flatMap((s) => (s.state.kind === "downloading" && s.state.step) || []);

it("verifies a download whose rename a scanner refuses twice", async () => {
  const service = await start();
  const id = await offer(service);
  vi.mocked(rename)
    .mockClear()
    .mockRejectedValueOnce(refused("EBUSY"))
    .mockRejectedValueOnce(refused("EPERM"));
  expect((await service.download(id)).snapshot.state).toMatchObject({ kind: "verified" });
  expect(vi.mocked(rename)).toHaveBeenCalledTimes(3);
  expect(steps()).toEqual(["moving", "verifying"]);
});

it("fails a download whose rename stays refused, naming the step it stopped in", async () => {
  const service = await start();
  const id = await offer(service);
  const real = vi.mocked(rename).getMockImplementation()!;
  vi.mocked(rename).mockClear().mockRejectedValue(refused("EACCES"));
  try {
    expect((await service.download(id)).snapshot.state).toMatchObject({
      kind: "failed",
      stage: "download",
      reason: "write-failed",
    });
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(6);
  } finally {
    vi.mocked(rename).mockImplementation(real);
  }
  expect(steps()).toEqual(["moving"]);
  expect(readdirSync(join(updates, id))).toEqual([]);
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
    if (event === "check") await service.check("stable", service.get().revision);
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

it("retires the watch and the held archive when the verified file cannot be read again", async () => {
  const installer = { ...installStandIn(), retire: vi.fn() };
  const service = await start({ installer });
  const id = await offer(service);
  await service.download(id);
  expect(service.get().install).toEqual({ kind: "restart-available", offerId: id });
  installer.retire.mockClear();
  // The read fails while the watch still sees the same file.
  vi.spyOn(UpdateEngine.prototype, "recheckFile").mockResolvedValueOnce(false);
  expect(await service.recheckVerified(id)).toBe(false);
  expect(installer.retire).toHaveBeenCalledTimes(1);
  expect(service.get()).toMatchObject({
    state: { kind: "failed", reason: "artifact-changed" },
    install: { kind: "unavailable-in-this-build", reason: "artifact-changed" },
  });
});

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
    expect((await service.check("stable", service.get().revision)).snapshot.state).toMatchObject(
      expected,
    );
  }
});

it("bounds preference reads and recovers when the file is repaired", async () => {
  const path = join(dir.path, "preferences.json");
  const prefs = store();
  for (const bad of [" ".repeat(1024) + "{}", "[]"]) {
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
  const checked = await service.check("nightly", service.get().revision);
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
  const check = service.check("stable", service.get().revision);
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
  vi.spyOn(prefs, "readPreferences").mockRejectedValueOnce(Error("fixture read"));
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
      service.check(undefined, service.get().revision),
      service.chooseTrack(undefined),
      service.download(undefined),
    ]);
  expect((await malformed()).map((r) => r.outcome)).toEqual(["invalid", "invalid", "invalid"]);
  const choice = service.chooseTrack("nightly");
  expect((await malformed()).map((r) => r.outcome)).toEqual(["busy", "busy", "busy"]);
  await choice;
  expect((await service.check("stable", service.get().revision)).outcome).toBe("stale");
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
  "running-signature-untrusted",
  "mac-archive",
  "mac-designated-requirement",
  "installer-version",
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

// A file symbolic link on Windows needs Developer Mode or the symbolic link privilege.
it.each(
  ["changed", "replaced", "truncated", "hardlink"].concat(
    process.platform === "win32" ? [] : ["symlink"],
  ),
)("refuses a %s file between offering Restart and acting on it", async (change) => {
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
  expect(await service.restart(id)).toMatchObject({
    outcome: "stale",
    snapshot: {
      state: { kind: "failed", stage: "download", reason: "artifact-changed" },
      install: { kind: "unavailable-in-this-build", reason: "artifact-changed" },
    },
  });
  expect(installer.launch).not.toHaveBeenCalled();
  expect(await store().get("attempt")).toBeNull();
});

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
  const checking = service.check("stable", service.get().revision);
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
  let launched: { file: unknown; attempt: string | null } | undefined;
  // Assertions stay in the test body: the service would turn a throw here into a launch failure.
  installer.launch = vi.fn(async (file) => {
    launched = { file, attempt: await store().get("attempt") };
    entered.resolve();
    await resume.promise;
    return null;
  });
  const service = await start({ installer, quitAfterLaunch });
  const id = await offer(service);
  await service.download(id);
  expect(installer.launch).not.toHaveBeenCalled();
  const pending = service.restart(id);
  try {
    expect(service.get().state.kind).toBe("preparing");
    expect((await service.restart(id)).outcome).toBe("busy");
    await Promise.race([entered.promise, pending]);
    expect(launched?.file).toMatchObject({
      track: "stable",
      version: "1.1.0",
      sha512: fixture.sha512,
      size: fixture.body.length,
    });
    expect(JSON.parse(launched!.attempt!)).toMatchObject({
      target: "1.1.0",
      from: "1.0.0",
      track: "stable",
      phase: "handoff",
      time: expect.stringMatching(/Z$/),
    });
    expect(service.get().state.kind).toBe("handing-off");
    for (const command of [
      service.check("stable", service.get().revision),
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
  } finally {
    resume.resolve();
    try {
      await pending;
    } finally {
      service.shutdown();
    }
  }
  for (const [version, kind] of [
    ["1.1.0", "target-running"],
    ["1.0.0", "old-version-running"],
    ["1.0.1", "unconfirmed"],
    ["invalid", "unconfirmed"],
  ] as const) {
    const prefs = store();
    if (version === "1.1.0") {
      const read = prefs.readPreferences;
      vi.spyOn(prefs, "readPreferences").mockImplementation(async () => {
        expect(existsSync(updates)).toBe(true);
        return read();
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
  "mac-designated-requirement",
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
  if (reason === "mac-designated-requirement") installer.inspect = async () => reason;
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

it.skipIf(process.platform === "win32").each(["success", "failure", "quit"])(
  "one confirmed Mac handoff serves the preflight archive once (%s)",
  async (action) => {
    type Feed = { url: string; size: number; sha256: string };
    let url: string | undefined;
    let seen:
      | {
          state: string;
          attempt: string | null;
          feed: Feed;
          repeatedFeed: number;
          length: string | null;
          body: Buffer;
          repeatedArchive: number;
          unrelated: number;
        }
      | undefined;
    const inspected = vi.fn(async () => null);
    // The service keeps handed-to-system whatever the stage throws, so only record here.
    const installer = macInstaller("arm64", inspected, async (address, _signal, handed) => {
      url = address;
      handed();
      const state = service.get().state.kind;
      const attempt = await store().get("attempt");
      const feed = (await (await fetch(address)).json()) as Feed;
      const repeatedFeed = (await fetch(address)).status;
      const archive = await fetch(feed.url);
      const length = archive.headers.get("content-length");
      const body = Buffer.from(await archive.arrayBuffer());
      seen = {
        state,
        attempt,
        feed,
        repeatedFeed,
        length,
        body,
        repeatedArchive: (await fetch(feed.url)).status,
        unrelated: (await fetch(new URL("/unrelated", address))).status,
      };
      if (action === "failure") throw Error("Staging response lost");
    });
    const service = await start({ installer });
    const id = await offer(service);
    await service.download(id);
    expect(inspected).toHaveBeenCalledTimes(1);
    expect(service.get().install).toEqual({
      kind: "restart-available",
      offerId: id,
      completesOnQuit: true,
    });
    expect(url).toBeUndefined();
    if (action === "quit") {
      service.shutdown();
      expect(url).toBeUndefined();
      expect(await store().get("attempt")).toBeNull();
      return;
    }
    expect((await service.restart(id)).snapshot.state.kind).toBe("handed-to-system");
    expect((await service.restart(id)).outcome).toBe("busy");
    expect(seen).toMatchObject({
      state: "handed-to-system",
      attempt: expect.any(String),
      feed: {
        size: fixture.body.length,
        sha256: createHash("sha256").update(fixture.body).digest("hex"),
      },
      repeatedFeed: 404,
      length: String(fixture.body.length),
      repeatedArchive: 404,
      unrelated: 404,
    });
    expect(seen!.body).toEqual(fixture.body);
    expect(url).toBeDefined();
    await expect(fetch(url!)).rejects.toThrow();
    service.shutdown();
  },
);

it("retains the selected track and last check when an authorized write replaces a corrupt attempt", async () => {
  const path = join(dir.path, "preferences.json");
  const lastCheck = { track: "nightly", readAt: "2026-11-12T10:00:00.000Z" };
  const prefs = store();
  writeFileSync(
    path,
    JSON.stringify({ selectedTrack: "nightly", lastCheck, attempt: { phase: "unknown" } }),
  );
  const read = vi.spyOn(prefs, "readPreferences");
  const service = await start({ store: prefs });
  expect(read).toHaveBeenCalledTimes(1);
  expect(service.get()).toMatchObject({
    selectedTrack: "nightly",
    lastCheck,
    lastAttempt: null,
    preferenceIssue: "attempt-not-read",
  });
  const attempt = {
    from: "1.0.0",
    target: "1.2.0",
    track: "stable",
    time: lastCheck.readAt,
    phase: "handoff",
  };
  await prefs.set("attempt", JSON.stringify(attempt));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    selectedTrack: "nightly",
    lastCheck,
    attempt,
  });
  for (const [version, kind] of [
    ["1.2.0", "target-running"],
    ["1.0.0", "old-version-running"],
  ] as const) {
    const next = await start({ version, store: prefs });
    expect(next.get().lastAttempt).toMatchObject({ kind, running: version });
  }
});

it.each([{ selectedTrack: 42 }, { lastCheck: false }])(
  "reports and repairs an invalid preference field %o",
  async (bad) => {
    writeFileSync(join(dir.path, "preferences.json"), JSON.stringify(bad));
    const service = await start();
    expect(service.get().preferenceIssue).toBe("preferences-not-read");
    expect((await service.chooseTrack("nightly")).snapshot.selectedTrack).toBe("nightly");
  },
);

it("reads a valid attempt from a store without a projection when its last check is bad", async () => {
  const saved: Record<string, string> = {
    lastCheck: "{",
    attempt: JSON.stringify({
      target: "1.1.0",
      from: "1.0.0",
      track: "stable",
      time: "2026-11-12T10:00:00.000Z",
      phase: "handoff",
    }),
  };
  const service = await start({
    version: "1.1.0",
    store: { get: async (key) => saved[key] ?? null, set: async () => {} },
  });
  expect(service.get()).toMatchObject({
    preferenceIssue: "preferences-not-read",
    lastCheck: null,
    lastAttempt: { kind: "target-running", target: "1.1.0", running: "1.1.0" },
  });
});

it("keeps the handoff visible through actual exit after a definite launch failure", async () => {
  const installer = installStandIn();
  installer.launch = async () => "installer-failed";
  const service = await start({ installer });
  const id = await offer(service);
  await service.download(id);
  expect((await service.restart(id)).snapshot.state).toMatchObject({
    kind: "handoff-failed",
    reason: "installer-failed",
  });
  const next = await offer(service);
  await service.download(next);
  installer.launch = async () => {
    service.shutdown();
    return null;
  };
  expect((await service.restart(next)).snapshot.state.kind).toBe("handing-off");
});

it("retires a changed file before publishing the first eligible snapshot", async () => {
  const installer = installStandIn();
  installer.inspect = async (file) => {
    writeFileSync(file.path, Buffer.alloc(file.size, 7));
    return null;
  };
  const service = await start({ installer });
  const id = await offer(service);
  expect((await service.download(id)).snapshot.state).toMatchObject({
    kind: "failed",
    reason: "artifact-changed",
  });
  expect(snapshots.some((s) => s.install.kind === "restart-available")).toBe(false);
  expect((await service.restart(id)).outcome).toBe("stale");
  expect(installer.launch).not.toHaveBeenCalled();
});
it("withdraws Restart when the already inspected download is replaced", async () => {
  const service = await start({ installer: installStandIn() });
  const id = await offer(service);
  await service.download(id);
  const folder = join(updates, id),
    path = join(folder, readdirSync(folder)[0]!);
  renameSync(path, path + ".old");
  writeFileSync(path, fixture.body);
  expect(service.get().install).toMatchObject({ reason: "artifact-changed" });
  expect((await service.restart(id)).outcome).toBe("stale");
});

it("refuses an old same-track revision or a malformed revision without replacing the result", async () => {
  const service = await start();
  const old = service.get();
  await service.chooseTrack("nightly");
  await service.chooseTrack("stable");
  const current = service.get();
  expect(await service.check("stable", old.revision)).toEqual({
    outcome: "stale",
    snapshot: current,
  });
  for (const revision of [undefined, "1", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(await service.check("stable", revision)).toEqual({
      outcome: "invalid",
      snapshot: current,
    });
  }
  expect(service.get()).toEqual(current);
  expect(server.requests).toEqual([]);
});

it("records a storage-blocked check separately from a startup storage notice", async () => {
  const parent = join(dir.path, "profile");
  const downloadDir = join(parent, "updates");
  const startup = await start({ downloadDir });
  expect(startup.get()).toMatchObject({
    state: { kind: "not-checked" },
    preferenceIssue: "update-folder-unavailable",
  });
  mkdirSync(parent, { mode: 0o700 });
  const service = await start({ downloadDir });
  await offer(service);
  const before = service.get();
  expect(before.lastCheck?.track).toBe("stable");
  rmSync(parent, { recursive: true });
  const reply = await service.check("stable", before.revision);
  expect(reply.snapshot).toMatchObject({
    state: { kind: "failed", stage: "check", reason: "write-failed" },
    preferenceIssue: "update-folder-unavailable",
    lastCheck: before.lastCheck,
  });
  expect(server.requests).toEqual(["/stable"]);
});
it.skipIf(process.platform === "win32")(
  "a native refusal cannot publish handed-to-system before update-downloaded",
  async () => {
    const updater = Object.assign(new EventEmitter(), {
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
    });
    vi.doMock("electron", () => ({ autoUpdater: updater }));
    // The stand-in updater reads what Squirrel would: the feed, then perhaps the archive.
    async function read(feed: string, archive: boolean) {
      const { url } = (await (await fetch(feed)).json()) as { url: string };
      if (archive) await (await fetch(url)).arrayBuffer();
    }
    try {
      for (const scenario of [
        "feed-error",
        "throw",
        "error-after-feed",
        "deadline",
        "error-after-archive",
        "deadline-after-archive",
        "ready",
      ] as const) {
        let feed = "";
        updater.setFeedURL.mockImplementation(({ url }: { url: string }) => {
          feed = url;
          if (scenario === "feed-error") updater.emit("error", Error("refused"));
        });
        updater.checkForUpdates.mockClear().mockImplementation(() => {
          if (scenario === "throw") throw Error("refused");
          if (scenario === "ready") updater.emit("update-downloaded");
          if (scenario === "error-after-feed" || scenario === "error-after-archive")
            void read(feed, scenario === "error-after-archive").then(() =>
              // Squirrel's read-only volume check fails here, before the archive request.
              updater.emit("error", Error("refused")),
            );
          if (scenario === "deadline-after-archive") void read(feed, true);
        });
        updater.quitAndInstall.mockImplementation(() => {
          updater.emit("error", Error("late"));
        });
        const installer = macInstaller("arm64", async () => null, undefined, 1000);
        const states: string[] = [];
        const service = await start({ installer, changed: (s) => states.push(s.state.kind) });
        const id = await offer(service);
        await service.download(id);
        const result = (await service.restart(id)).snapshot.state;
        if (scenario === "feed-error") expect(updater.checkForUpdates).not.toHaveBeenCalled();
        if (
          scenario === "feed-error" ||
          scenario === "throw" ||
          scenario === "error-after-feed" ||
          scenario === "deadline"
        ) {
          // No archive was served, so nothing can have been staged: the person can check again.
          expect(result).toEqual({
            kind: "handoff-failed",
            version: "1.1.0",
            reason: scenario === "deadline" ? "installer-failed" : "mac-updater-refused",
          });
          expect((await service.restart(id)).outcome).toBe("stale");
          expect((await service.chooseTrack("nightly")).outcome).toBe("accepted");
          expect((await service.chooseTrack("stable")).outcome).toBe("accepted");
          const again = await offer(service);
          expect((await service.download(again)).snapshot.state).toMatchObject({
            kind: "verified",
            offerId: again,
          });
        } else {
          expect(result).toEqual({
            kind: scenario === "ready" ? "handed-to-system" : "handoff-unconfirmed",
            offerId: id,
            version: "1.1.0",
          });
          expect((await service.restart(id)).outcome).toBe("busy");
          expect((await service.check("stable", service.get().revision)).outcome).toBe("busy");
          expect((await service.chooseTrack("nightly")).outcome).toBe("busy");
          expect((await service.download(id)).outcome).toBe("busy");
        }
        expect(states.includes("handed-to-system")).toBe(scenario === "ready");
        expect(updater.listenerCount("error")).toBe(1);
        service.shutdown();
      }
    } finally {
      vi.doUnmock("electron");
    }
  },
);

it("a watch error during inspection prevents the first eligible event", async () => {
  const installer = installStandIn();
  installer.inspect = async () => {
    const watcher = vi.mocked(watch).mock.results.at(-1)!.value;
    watcher.emit("error", Error("watch stopped"));
    return null;
  };
  const service = await start({ installer });
  const id = await offer(service);
  expect((await service.download(id)).snapshot.state).toMatchObject({
    kind: "failed",
    reason: "artifact-changed",
  });
  expect(snapshots.some((s) => s.install.kind === "restart-available")).toBe(false);
  expect((await service.restart(id)).outcome).toBe("stale");
});

it.skipIf(process.platform === "win32")(
  "quit during Mac Download aborts native inspection and closes its archive and scratch",
  async () => {
    const old = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", {
      value: "/fixture/Contents/Resources",
      configurable: true,
    });
    const child = () =>
      Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
    const inspector = child();
    const entered = Promise.withResolvers<{ scratch: string; fd: number; signal: AbortSignal }>();
    vi.mocked(spawn)
      .mockImplementationOnce(() => {
        const classification = child();
        queueMicrotask(() => {
          classification.stdout.end("ok\n");
          classification.emit("close", 0);
        });
        return classification as unknown as ReturnType<typeof spawn>;
      })
      .mockImplementationOnce((_command, args, options) => {
        const controls = options as SpawnOptions;
        entered.resolve({
          scratch: args[0]!,
          fd: (controls.stdio as number[])[3]!,
          signal: controls.signal!,
        });
        return inspector as unknown as ReturnType<typeof spawn>;
      });
    try {
      const service = await start({ installer: macInstaller("arm64") });
      const id = await offer(service);
      const pending = service.download(id);
      const { scratch, fd, signal } = await entered.promise;
      try {
        service.shutdown();
        expect(signal.aborted).toBe(true);
        inspector.emit("error", Error("aborted"));
        await new Promise((resolve) => setImmediate(resolve));
        expect(existsSync(scratch)).toBe(true);
        expect(fstatSync(fd).isFile()).toBe(true);
      } finally {
        inspector.emit("close", null, "SIGKILL");
        await pending;
      }
      expect(existsSync(scratch)).toBe(false);
      expect(() => fstatSync(fd)).toThrow();
      expect((await pending).outcome).toBe("superseded");
    } finally {
      if (old) Object.defineProperty(process, "resourcesPath", old);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  },
);

it.skipIf(process.platform === "win32")(
  "a full scratch disk leaves the download verified and refuses Restart with inspection-failed",
  async () => {
    const fs = await vi.importActual<typeof FileSystem>("node:fs/promises");
    const full = vi.fn(async () => {
      throw Object.assign(Error("full"), { code: "ENOSPC" });
    });
    vi.mocked(open).mockImplementation(async (...args) => {
      const fd = await fs.open(...args);
      if (String(args[0]).includes("/.hold-") && args[1] === "wx") fd.writeFile = full;
      return fd;
    });
    try {
      const inspect = vi.fn(async () => null);
      const service = await start({
        installer: macInstaller("arm64", inspect, undefined, undefined, "macOS 99.1"),
      });
      const id = await offer(service);
      expect((await service.download(id)).snapshot).toMatchObject({
        state: { kind: "verified", offerId: id },
        install: {
          kind: "unavailable-in-this-build",
          reason: "inspection-failed",
          failure: {
            stage: "hold-archive",
            errorCode: "ENOSPC",
            exitCode: null,
            signal: null,
            output: null,
            system: "macOS 99.1",
          },
        },
      });
      expect(full).toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      const files = readdirSync(join(updates, id));
      expect(files).toHaveLength(1);
      expect(
        createHash("sha512")
          .update(readFileSync(join(updates, id, files[0]!)))
          .digest("base64"),
      ).toBe(fixture.sha512);
      expect((await service.restart(id)).outcome).toBe("invalid");
      service.shutdown();
    } finally {
      vi.mocked(open).mockImplementation(fs.open);
    }
  },
);

it("a Restart whose inspection fails carries the installer's record of why", async () => {
  const failure = {
    stage: "running-signature",
    exitCode: 0,
    signal: null,
    output: "reported",
    helperStep: "parent-code -67065",
    errorCode: null,
    durationMs: 12,
    system: "macOS 99.1",
  } as const;
  const inspect = vi
    .fn<UpdateInstaller["inspect"]>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce("inspection-failed");
  const installer: UpdateInstaller = {
    unavailable: null,
    completesOnQuit: true,
    inspectionFailure: failure,
    inspect,
    launch: async () => null,
  };
  const service = await start({ installer });
  const id = await offer(service);
  expect((await service.download(id)).snapshot.install).toEqual({
    kind: "restart-available",
    offerId: id,
    completesOnQuit: true,
  });
  expect((await service.restart(id)).snapshot).toMatchObject({
    state: { kind: "handoff-failed", reason: "inspection-failed", failure },
    install: { kind: "unavailable-in-this-build", reason: "inspection-failed", failure },
  });
  service.shutdown();
});

it("records no failure with a refusal other than inspection-failed", async () => {
  const installer: UpdateInstaller = {
    unavailable: null,
    inspectionFailure: {
      stage: "archive",
      exitCode: 1,
      signal: null,
      output: "empty",
      helperStep: null,
      errorCode: null,
      durationMs: 1,
      system: "macOS 99.1",
    },
    inspect: async () => "mac-archive",
    launch: async () => null,
  };
  const service = await start({ installer });
  const id = await offer(service);
  expect((await service.download(id)).snapshot.install).toEqual({
    kind: "unavailable-in-this-build",
    reason: "mac-archive",
  });
  service.shutdown();
});
