// Reactions never go backwards (parity F-283): a list or an answer from before a newer event or
// change does not replace it, and reactions leave with the history they belonged to.
import { describe, expect, it } from "vitest";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { grantingGateway, KEY, openTask } from "./client-harness.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";

const history = (ids: string[]) => () => ({
  messages: ids.map((id) => ({ role: "user", content: `Message ${id}`, __openclaw: { id } })),
  hasMore: false,
});
const summary = (emoji: string, who = "someone") => [
  { emoji, count: 1, identities: [{ id: who }] },
];
const reacted = (messageId: string, emoji: string, who = "someone") => ({
  sessionKey: KEY,
  messageId,
  action: "added",
  reactions: summary(emoji, who),
});

describe("reactions (F-283)", () => {
  it("F-283: a list asked for before a newer reaction event does not replace it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = history(["m1"]);
    gateway.handlers["users.self"] = () => ({ profile: { id: "me" } });
    const stale = deferred<unknown>();
    let lists = 0;
    gateway.handlers["session.reactions.list"] = () =>
      (lists += 1) === 1 ? stale.promise : { reactions: { m1: summary("👍") } };
    const { client, transcript } = await openTask({ gateway });
    await until(() => lists === 1);
    gateway.emit("session.reaction", reacted("m1", "👍"));
    await until(() => transcript().reactions?.m1?.[0]?.emoji === "👍");
    // The list from before the event says there were none: it does not take the badge away.
    stale.resolve({ reactions: {} });
    await until(() => lists === 2);
    await sleep(30);
    expect(transcript().reactions?.m1).toEqual([{ emoji: "👍", count: 1, mine: false }]);
    client.stop();
  });

  it("F-283: this person's change, answered after a newer event about the message, does not replace it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = history(["m1"]);
    gateway.handlers["users.self"] = () => ({ profile: { id: "me" } });
    gateway.handlers["session.reactions.list"] = () => ({ reactions: {} });
    const answer = deferred<unknown>();
    gateway.handlers["session.reactions.set"] = () => answer.promise;
    const { client, transcript } = await openTask({ gateway });
    const set = client.setReaction(KEY, "m1", "🎉", false);
    await until(() => gateway.calls("session.reactions.set").length === 1);
    // Someone else's reaction lands after the request; the answer then carries an older count.
    gateway.emit("session.reaction", {
      ...reacted("m1", "🎉"),
      reactions: [{ emoji: "🎉", count: 2, identities: [{ id: "me" }, { id: "someone" }] }],
    });
    await until(() => transcript().reactions?.m1?.[0]?.count === 2);
    answer.resolve({ reactions: summary("🎉", "me") });
    await set;
    expect(transcript().reactions?.m1).toEqual([{ emoji: "🎉", count: 2, mine: true }]);
    client.stop();
  });

  it("F-283: reactions leave with the history they belonged to", async () => {
    const gateway = grantingGateway();
    let rows = ["m1", "m2"];
    gateway.handlers["chat.history"] = () => history(rows)();
    gateway.handlers["users.self"] = () => ({ profile: { id: "me" } });
    const later = deferred<unknown>();
    let lists = 0;
    gateway.handlers["session.reactions.list"] = () =>
      (lists += 1) === 1 ? { reactions: { m1: summary("👍"), m2: summary("👀") } } : later.promise;
    const { client, transcript } = await openTask({ gateway });
    await until(() => Object.keys(transcript().reactions ?? {}).length === 2);
    // A new page that no longer shows m1: its badge goes with it at once, before any list.
    rows = ["m2", "m3"];
    gateway.dropAll();
    await until(() => transcript().items.some((item) => item.messageId === "m3"));
    expect(Object.keys(transcript().reactions ?? {})).toEqual(["m2"]);
    client.stop();
  });

  it("F-283: late set cannot restore a badge removed by a newer event", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = history(["m1"]);
    gateway.handlers["users.self"] = () => ({ profile: { id: "me" } });
    gateway.handlers["session.reactions.list"] = () => ({ reactions: {} });
    const answer = deferred<unknown>();
    gateway.handlers["session.reactions.set"] = () => answer.promise;
    const { client, transcript } = await openTask({ gateway });
    const set = client.setReaction(KEY, "m1", "👍", false);
    await until(() => gateway.calls("session.reactions.set").length === 1);
    // Newer events: the reaction added, then removed again; the badge is absent once more.
    gateway.emit("session.reaction", reacted("m1", "👍", "me"));
    await until(() => transcript().reactions?.m1 !== undefined);
    gateway.emit("session.reaction", {
      ...reacted("m1", "👍", "me"),
      action: "removed",
      reactions: [],
    });
    await until(() => transcript().reactions?.m1 === undefined);
    // The older answer arrives last, saying the reaction is there.
    answer.resolve({ reactions: summary("👍", "me") });
    await set;
    await sleep(30);
    expect(transcript().reactions?.m1).toBeUndefined();
    await until(() => gateway.calls("session.reactions.list").length >= 2);
    await sleep(30);
    expect(transcript().reactions?.m1).toBeUndefined();
    client.stop();
  });

  it("F-283: a reaction waiting for identity ends when its connection closes", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = history(["m1"]);
    gateway.handlers["session.reactions.list"] = () => ({ reactions: {} });
    const self = deferred<unknown>();
    gateway.handlers["users.self"] = () => self.promise;
    const { client } = await openTask({ gateway });
    try {
      const reads = gateway.calls("users.self").length;
      const reacting = client.setReaction(KEY, "m1", "👍", false);
      await until(() => gateway.calls("users.self").length > reads);
      gateway.dropAll();
      await expect(reacting).rejects.toThrow("That message is no longer shown here.");
      expect(gateway.calls("session.reactions.set")).toEqual([]);
    } finally {
      self.resolve({ profile: { id: "me" } });
      client.stop();
    }
  });

  it("F-283: a viewer gone while its identity was being read sends no reaction", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = history(["m1"]);
    gateway.handlers["session.reactions.list"] = () => ({ reactions: {} });
    const self = deferred<unknown>();
    gateway.handlers["users.self"] = () => self.promise;
    gateway.handlers["session.reactions.set"] = () => ({ reactions: summary("👍", "me") });
    const { client } = await openTask({ gateway });
    const owner = {};
    const reacting = client.setReaction(KEY, "m1", "👍", false, { owner });
    await until(() => gateway.calls("users.self").length > 0);
    client.withdraw(owner);
    self.resolve({ profile: { id: "me" } });
    await expect(reacting).rejects.toThrow();
    expect(gateway.calls("session.reactions.set")).toEqual([]);
    client.stop();
  });

  it("F-283: a task reopened while a reaction waited, no longer showing its message, gets no reaction", async () => {
    const gateway = grantingGateway();
    let rows = ["m1"];
    gateway.handlers["chat.history"] = () => history(rows)();
    gateway.handlers["session.reactions.list"] = () => ({ reactions: {} });
    const self = deferred<unknown>();
    gateway.handlers["users.self"] = () => self.promise;
    gateway.handlers["session.reactions.set"] = () => ({ reactions: summary("👍", "me") });
    const { client } = await openTask({ gateway });
    const reacting = client.setReaction(KEY, "m1", "👍", false);
    await until(() => gateway.calls("users.self").length > 0);
    // The task is closed and opened again; its history now holds other rows.
    rows = ["m2"];
    client.closeSession(KEY);
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    self.resolve({ profile: { id: "me" } });
    await expect(reacting).rejects.toThrow("That message is no longer shown here.");
    expect(gateway.calls("session.reactions.set")).toEqual([]);
    client.stop();
  });

  it("F-283: a reaction that waited for write access is sent once the gateway approves it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = history(["m1"]);
    gateway.handlers["users.self"] = () => ({ profile: { id: "me" } });
    gateway.handlers["session.reactions.list"] = () => ({ reactions: {} });
    gateway.handlers["session.reactions.set"] = () => ({ reactions: summary("👍", "me") });
    const approval = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => approval.promise;
    const { client, transcript } = await openTask({ gateway, held: READ_SCOPES });
    const reacting = client.setReaction(KEY, "m1", "👍", false);
    await until(() => client.pendingAccessWaiters === 1);
    // The approval rotates the token, and the client reconnects with it to the same gateway.
    approval.resolve({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: [...INTERACTIVE_SCOPES],
    });
    await reacting;
    expect(gateway.calls("session.reactions.set")).toEqual([
      { sessionKey: KEY, messageId: "m1", emoji: "👍" },
    ]);
    expect(transcript().reactions?.m1).toEqual([{ emoji: "👍", count: 1, mine: true }]);
    client.stop();
  });
});
