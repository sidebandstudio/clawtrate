// Where a picture a bot sent with its message tool is drawn (F-535, #423): under
// the bubble of the message that carried it, not after what the bot did next.
// The rows are shaped as a development gateway recorded them (OpenClaw 2026.10.6).

import { groupFeed, mapHistory, type ChatPicture, type FeedEntry } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { placePictures, type FeedRef } from "../src/actions/feed.tsx";
import { pictureAlt } from "../src/Pictures.tsx";

const picture = (id: string, alt: string) => ({
  type: "image",
  artifactId: `artifact_managed_image_${id}`,
  url: `/api/chat/media/outgoing/agent%3Apip%3Aa/${id}/full`,
  alt,
  mimeType: "image/png",
  width: 240,
  height: 160,
  sizeBytes: 1133,
});
const SUN = picture("fbabd0fe-ab39-4db6-88ba-6bb4bb348ea3", "sun.png");
const MAP = picture("2d354dee-da5c-47a0-b77f-446b2752a304", "trail-map.png");

/** A run: the `message` call, the row the gateway delivered with `pictures`, and the bot's closing words. */
const rows = (
  pictures: unknown[],
  closing: unknown[] = [{ type: "text", text: "That is the route." }],
) => [
  { role: "user", content: "Send me the trail map", __openclaw: { id: "u1" } },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "raw-1",
        name: "message",
        arguments: {
          action: "send",
          message: "Here is the trail map.",
          media: "pictures/trail-map.png",
        },
      },
    ],
    __openclaw: { id: "call-row", runId: "run-1" },
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Here is the trail map." }, ...pictures],
    model: "delivery-mirror",
    __openclaw: { id: "delivered", runId: "run-1" },
  },
  {
    role: "toolResult",
    toolCallId: "raw-1",
    content: [
      {
        type: "text",
        text: "Sent visible reply to the current source conversation via internal-ui.",
      },
    ],
    __openclaw: { id: "result", runId: "run-1" },
  },
  { role: "assistant", content: closing, __openclaw: { id: "closing", runId: "run-1" } },
];

/** The item's bubbles as the feed builds them, one per text block with its row. */
function entries(item: ReturnType<typeof mapHistory>[number]): FeedEntry<FeedRef>[] {
  return item.blocks.flatMap((block, i) =>
    block.kind === "text"
      ? [
          {
            type: "bubble" as const,
            id: `b${i}`,
            ref: { t: "text" as const, text: block.text, messageId: block.messageId },
          },
        ]
      : [],
  );
}

/** Each bubble's text and the pictures drawn under it. */
const drawn = (list: FeedEntry<FeedRef>[]): Array<[string, Array<string | null>]> =>
  groupFeed<FeedRef>(list, {}).flatMap((group): Array<[string, Array<string | null>]> =>
    group.type === "bubble" && group.ref.t === "text"
      ? [[group.ref.text, (group.ref.pictures ?? []).map((p: ChatPicture) => p.alt)]]
      : [],
  );

describe("F-535: a picture sent with the message tool is drawn with its message", () => {
  it("under the bubble of the message that carried it, in their order, and not after the bot's later words", () => {
    const item = mapHistory(rows([SUN, MAP])).at(-1)!;
    const list = entries(item);
    const placed = placePictures(item, list);
    expect(drawn(list)).toEqual([
      ["Here is the trail map.", ["sun.png", "trail-map.png"]],
      ["That is the route.", []],
    ]);
    expect([...placed]).toEqual([SUN.artifactId, MAP.artifactId]);
    // Each one is read out on its own.
    for (const each of item.pictures!)
      expect(pictureAlt(each)).toBe("A picture the bot handed over");
  });

  it("once, even when the bot's closing message carries the same picture again", () => {
    const item = mapHistory(rows([MAP], [{ type: "text", text: "That is the route." }, MAP])).at(
      -1,
    )!;
    const list = entries(item);
    placePictures(item, list);
    expect(drawn(list).flatMap(([, pictures]) => pictures)).toEqual(["trail-map.png"]);
  });

  it("each picture under its own message, when two messages of one turn carry one each", () => {
    const [user, call, delivered, result] = rows([SUN]);
    const item = mapHistory([
      user,
      call,
      delivered,
      result,
      {
        role: "assistant",
        content: [{ type: "text", text: "And the map." }, MAP],
        model: "delivery-mirror",
        __openclaw: { id: "delivered-2", runId: "run-1" },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "That is the route." }],
        __openclaw: { id: "closing", runId: "run-1" },
      },
    ]).at(-1)!;
    const list = entries(item);
    placePictures(item, list);
    expect(drawn(list)).toEqual([
      ["Here is the trail map.", ["sun.png"]],
      ["And the map.", ["trail-map.png"]],
      ["That is the route.", []],
    ]);
  });

  it("a picture whose message draws no bubble stays for the turn to draw", () => {
    const item = mapHistory(rows([])).at(-1)!;
    item.pictures = [
      {
        artifactId: "a-1",
        alt: null,
        prompt: null,
        mimeType: null,
        width: null,
        height: null,
        sizeBytes: null,
      },
      {
        artifactId: "a-2",
        alt: null,
        prompt: null,
        mimeType: null,
        width: null,
        height: null,
        sizeBytes: null,
        messageId: "elsewhere",
      },
    ];
    const list = entries(item);
    expect(placePictures(item, list).size).toBe(0);
    expect(drawn(list).every(([, pictures]) => pictures.length === 0)).toBe(true);
  });
});
