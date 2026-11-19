// Reactions never go backwards (parity F-283): a list or an answer from before a newer event or
// change does not replace it, and reactions leave with the history they belonged to.
import { describe, expect, it } from "vitest";
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
});
