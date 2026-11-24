import {
  noDesktopUpdates,
  type DesktopUpdateSnapshot,
  type DesktopUpdates,
  type DesktopUpdateReply,
} from "@clawtrate/core";
import { it, expect, vi } from "vitest";
import { UpdateReading } from "../src/update-reading.ts";

const base: DesktopUpdateSnapshot = {
  revision: 3,
  runningVersion: "1.0.0",
  runningTrack: "stable",
  tracks: [
    { track: "stable", source: "stable.example" },
    { track: "nightly", source: "beta.example" },
  ],
  selectedTrack: "stable",
  pendingTrack: null,
  preferenceIssue: null,
  lastCheck: null,
  lastAttempt: null,
  install: { kind: "unavailable-in-this-build", reason: "no-verified-download" },
  state: { kind: "not-checked" },
};
function harness() {
  const first = Promise.withResolvers<DesktopUpdateSnapshot>();
  const reply = Promise.withResolvers<DesktopUpdateReply>();
  let event = (s: DesktopUpdateSnapshot) => {
    void s;
  };
  const stop = vi.fn();
  const host = {
    ...noDesktopUpdates,
    get: vi.fn(() => first.promise),
    subscribe: vi.fn((fn) => {
      event = fn;
      return stop;
    }),
    check: vi.fn(() => reply.promise),
    restart: vi.fn((_id: string) => reply.promise),
    download: vi.fn(() => reply.promise),
    chooseTrack: vi.fn(() => reply.promise),
  } satisfies DesktopUpdates;
  const reader = new UpdateReading(host);
  const disconnect = reader.connect();
  return {
    reader,
    host,
    first,
    reply,
    stop,
    disconnect,
    event: (s: DesktopUpdateSnapshot) => event(s),
  };
}
it("F-231: a newer offer survives an old check reply and an older initial read", async () => {
  const h = harness();
  h.event({ ...base, revision: 2 });
  const check = h.reader.check("stable", 2);
  void h.reader.check("stable", 2);
  const newest: DesktopUpdateSnapshot = {
    ...base,
    revision: 5,
    state: { kind: "offered", version: "1.1.0", releaseDate: "2026-11-01", offerId: "offer-B" },
  };
  h.event(newest);
  h.reply.resolve({ outcome: "stale", snapshot: { ...base, revision: 4 } });
  await check;
  h.first.resolve(base);
  await h.first.promise;
  expect(h.reader.get()).toMatchObject({ snapshot: newest, message: null, working: false });
  expect(h.host.check.mock.calls).toEqual([["stable", 2]]);
  expect(h.host.subscribe).toHaveBeenCalledTimes(1);
  h.disconnect();
  expect(h.stop).toHaveBeenCalledOnce();
});
it("F-231: a stale download carries only the displayed identity and accepts its replacement", async () => {
  const h = harness();
  h.event(base);
  const done = h.reader.download("A");
  h.reply.resolve({
    outcome: "stale",
    snapshot: {
      ...base,
      revision: 4,
      state: { kind: "offered", version: "2.0.0", releaseDate: "2026-11-01", offerId: "B" },
    },
  });
  await done;
  expect(h.host.download.mock.calls).toEqual([["A"]]);
  expect(h.reader.get().snapshot?.state).toMatchObject({ offerId: "B" });
  expect(h.reader.get().message).toBeNull();
});
it.each(["busy", "superseded", "stale", "invalid"] as const)(
  "F-231: handles %s once at the same revision",
  async (outcome) => {
    const h = harness();
    h.event(base);
    const done = h.reader.check("stable", base.revision);
    h.reply.resolve({ snapshot: base, outcome });
    await done;
    expect(h.reader.get().message).toBe(
      outcome === "busy"
        ? null
        : outcome === "invalid"
          ? "Couldn't start the update check."
          : "The update result changed. Review it before checking again.",
    );
    expect(h.host.check).toHaveBeenCalledOnce();
  },
);
it("F-231: rejected reads and commands release the action without replay", async () => {
  const h = harness();
  h.first.reject(Error());
  await vi.waitFor(() => expect(h.reader.get().message).toBe("Couldn't read update settings."));
  h.event(base);
  h.host.check.mockRejectedValueOnce(Error());
  await h.reader.check("stable", base.revision);
  expect(h.reader.get().message).toBe("Couldn't get a reply to the update check.");
  expect(h.host.check.mock.calls).toEqual([["stable", base.revision]]);
  expect(h.reader.get().working).toBe(false);
  h.reply.resolve({ outcome: "busy", snapshot: base });
  await h.reader.check("stable", base.revision);
  expect(h.host.check).toHaveBeenCalledTimes(2);
});

it("F-231: retrying an unreadable Settings page reads once without contacting the update source", async () => {
  const h = harness();
  h.first.reject(Error());
  await vi.waitFor(() => expect(h.reader.get().message).toBe("Couldn't read update settings."));
  const retry = Promise.withResolvers<DesktopUpdateSnapshot>();
  h.host.get.mockReturnValueOnce(retry.promise);
  const done = h.reader.retryRead();
  void h.reader.retryRead();
  expect(h.reader.get().working).toBe(true);
  expect(h.host.get).toHaveBeenCalledTimes(2);
  retry.resolve(base);
  await done;
  expect(h.reader.get()).toMatchObject({ snapshot: base, message: null, working: false });
  expect(h.host.check).not.toHaveBeenCalled();
  expect(h.host.download).not.toHaveBeenCalled();
});

it("F-231: a track choice masks the old offer immediately and rejects overlapping local commands", async () => {
  const h = harness();
  h.event(base);
  const saving = h.reader.chooseTrack("nightly");
  expect(h.reader.get().localChoice).toBe("nightly");
  await h.reader.check("stable", base.revision);
  await h.reader.download("retired");
  await h.reader.chooseTrack("nightly");
  expect(h.host.check).not.toHaveBeenCalled();
  expect(h.host.download).not.toHaveBeenCalled();
  expect(h.host.chooseTrack).toHaveBeenCalledOnce();
  h.event({ ...base, revision: 4, pendingTrack: "nightly" });
  h.reply.resolve({
    outcome: "accepted",
    snapshot: { ...base, revision: 5, preferenceIssue: "track-not-saved" },
  });
  await saving;
  expect(h.reader.get()).toMatchObject({
    localChoice: null,
    snapshot: {
      selectedTrack: "stable",
      state: { kind: "not-checked" },
      preferenceIssue: "track-not-saved",
    },
  });
});

it("F-231: explains a refused offer when its snapshot has no new result", async () => {
  const h = harness();
  const offer: DesktopUpdateSnapshot = {
    ...base,
    state: { kind: "offered", version: "2.0.0", releaseDate: "2026-11-01", offerId: "stale" },
  };
  h.event(offer);
  const pending = h.reader.download("stale");
  h.reply.resolve({ outcome: "stale", snapshot: offer });
  await pending;
  expect(h.reader.get().message).toBe("This offer is no longer current.");
  h.event({ ...offer, revision: 4 });
  expect(h.reader.get().message).toBeNull();
});

it.each(["check", "download", "choose"] as const)(
  "F-231: explains an idle stale %s beside an unrelated settings notice",
  async (action) => {
    const h = harness();
    const previous: DesktopUpdateSnapshot = { ...base, preferenceIssue: "preferences-not-read" };
    h.event(previous);
    const pending =
      action === "check"
        ? h.reader.check("stable", previous.revision)
        : action === "download"
          ? h.reader.download("A")
          : h.reader.chooseTrack("nightly");
    const current: DesktopUpdateSnapshot = {
      ...previous,
      revision: 4,
      selectedTrack: action === "choose" ? "stable" : "nightly",
    };
    h.reply.resolve({ outcome: "stale", snapshot: current });
    await pending;
    expect(h.reader.get()).toMatchObject({
      snapshot: current,
      message: {
        check: "The update track changed. Check the selected source again.",
        download: "This offer is no longer current.",
        choose: "This update track choice is no longer current.",
      }[action],
    });
  },
);

it("F-231: releases unanswered download and track requests without replaying them", async () => {
  const h = harness();
  h.event(base);
  h.host.download.mockRejectedValueOnce(Error());
  await h.reader.download("A");
  expect(h.host.download.mock.calls).toEqual([["A"]]);
  expect(h.reader.get()).toMatchObject({
    working: false,
    message: "Couldn't get a reply to the download request.",
  });
  h.host.chooseTrack.mockRejectedValueOnce(Error());
  await h.reader.chooseTrack("nightly");
  expect(h.host.chooseTrack.mock.calls).toEqual([["nightly"]]);
  expect(h.reader.get()).toMatchObject({
    localChoice: null,
    message: "Couldn't get a reply to the track change.",
  });
});

it.each([
  ["busy", "Another update action is in progress."],
  ["stale", "This offer is no longer current."],
  ["invalid", "Couldn't start the restart."],
  ["superseded", "This offer is no longer current."],
  ["rejected", "Couldn't get a reply to the restart request."],
  ["accepted", null],
] as const)(
  "F-231: consumes one %s restart reply for the confirmed offer",
  async (outcome, message) => {
    const h = harness();
    const snapshot = {
      ...base,
      state: { kind: "verified", version: "1.1.0", offerId: "shown", size: 10 },
      install: { kind: "restart-available", offerId: "shown" },
    } as const;
    h.event(snapshot);
    await h.reader.restart("retired");
    expect(h.host.restart).not.toHaveBeenCalled();
    const pending = h.reader.restart("shown");
    await h.reader.restart("shown");
    await h.reader.chooseTrack("nightly");
    expect(h.host.chooseTrack).not.toHaveBeenCalled();
    expect(h.host.restart.mock.calls).toEqual([["shown"]]);
    if (outcome === "rejected") h.reply.reject(Error());
    else h.reply.resolve({ outcome, snapshot });
    await pending;
    expect(h.reader.get()).toMatchObject({ message, working: false });
  },
);
it("F-231: a stale restart reply cannot replace or contradict a newer handoff", async () => {
  const h = harness();
  const snapshot = {
    ...base,
    state: { kind: "verified", version: "1.1.0", offerId: "shown", size: 10 },
    install: { kind: "restart-available", offerId: "shown" },
  } as const;
  h.event(snapshot);
  const pending = h.reader.restart("shown");
  h.event({
    ...snapshot,
    revision: 5,
    state: { kind: "handed-to-system", version: "1.1.0", offerId: "shown" },
  });
  h.reply.resolve({ outcome: "stale", snapshot });
  await pending;
  expect(h.reader.get()).toMatchObject({ snapshot: { revision: 5 }, message: null });
});

it("F-554: the lists arriving at the same revision are shown, and older ones never replace them", async () => {
  const h = harness();
  h.first.resolve(base);
  await vi.waitFor(() => expect(h.reader.get().snapshot?.revision).toBe(3));
  const lists = { coming: [], running: ["This build (#1)"] };
  h.event({ ...base, listsRevision: 1, whatsNew: lists });
  expect(h.reader.get().snapshot?.whatsNew).toEqual(lists);
  h.event({ ...base, listsRevision: 1 });
  h.event(base);
  expect(h.reader.get().snapshot?.whatsNew).toEqual(lists);
  // A newer revision still replaces it, whatever its lists.
  h.event({ ...base, revision: 4 });
  expect(h.reader.get().snapshot?.whatsNew).toBeUndefined();
});

it("F-554: lists arriving keep a command's feedback on the screen", async () => {
  const h = harness();
  h.first.resolve(base);
  await vi.waitFor(() => expect(h.reader.get().snapshot?.revision).toBe(3));
  const check = h.reader.check("stable", 3);
  h.reply.reject(new Error("no reply"));
  await check;
  expect(h.reader.get().message).toBe("Couldn't get a reply to the update check.");
  h.event({ ...base, listsRevision: 1, whatsNew: { coming: [], running: ["This build (#1)"] } });
  expect(h.reader.get().snapshot?.whatsNew?.running).toEqual(["This build (#1)"]);
  expect(h.reader.get().message).toBe("Couldn't get a reply to the update check.");
});
