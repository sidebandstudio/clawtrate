// F-590: the gateway's own "OpenClaw updated" notice, drawn as Clawtrate's quiet line for an update
// this device saw succeed: the line, its disclosure with the gateway's sentence as text, and no
// bot's message parts; and in the rail, the bot's last words before it. The mounted conversation
// is checked in visual/update-notice.visual.spec.ts. The row is the shape recorded from real
// update runs; no update runs here.

import {
  emptyActivity,
  mapHistory,
  seenThroughUpdateNotice,
  tasksWithoutUpdateNotices,
  updateNoticeLine,
  type Task,
  type Transcript,
  type UpdatedRun,
  type UpdateNoticeScope,
} from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { summarize, unreadSeenOf } from "../src/selection.ts";
import { UpdateLine } from "../src/UpdateLine.tsx";

const KEY = "agent:pip:main";
/** The gateway's clock: rows, the run's finish and the list are its times. */
const T = 1_790_000_000_000;
const RUN = "3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e";
const TEXT =
  "✅ OpenClaw updated.\nFor details, open Settings → Updates in the OpenClaw app or run `openclaw update status` in your terminal.";
const notice = (text = TEXT, at = T + 3_000) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openclaw-transcript",
  provider: "openclaw",
  model: "delivery-mirror",
  usage: { input: 0, output: 0, totalTokens: 0 },
  stopReason: "stop",
  timestamp: at,
  idempotencyKey: `update-run-finished:${RUN}`,
  __openclaw: { id: "n1", idempotencyKey: `update-run-finished:${RUN}`, seq: 3 },
});
const reply = (text: string, at: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "scripted",
  model: "dev-1",
  timestamp: at,
  __openclaw: { id: "a1", runId: "r1" },
});
const UPDATED: UpdatedRun[] = [
  { gatewayId: "gw-a", runId: RUN, to: "2026.11.10", at: 1, succeededAt: T + 2_900 },
];
const SCOPE: UpdateNoticeScope = { updated: UPDATED, gatewayId: "gw-a", mainKey: KEY };
const history = (rows: unknown[]): Transcript => ({
  ...emptyActivity,
  linkedRuns: {},
  interSession: [],
  mcpTools: {},
  sessionKey: KEY,
  status: "ready",
  items: mapHistory(rows),
  error: null,
  hasMore: false,
  live: null,
  loadedAt: 3_200,
});
const listed: Task = {
  key: KEY,
  botId: "pip",
  sessionId: "s1",
  title: "Main",
  preview:
    "✅ OpenClaw updated. For details, open Settings → Updates in the OpenClaw app or run openclaw update status in your terminal.",
  updatedAt: T + 3_100,
  status: "done",
  unread: true,
  isMain: true,
};
const markupOf = (text = TEXT) => {
  const [item] = mapHistory([notice(text)]);
  return renderToStaticMarkup(
    createElement(UpdateLine, { line: updateNoticeLine(item, KEY, SCOPE)! }),
  );
};

describe("F-590: the update line", () => {
  it("F-590: says OpenClaw updated to the version this device saw, once, with the row's text behind a disclosure that names no author", () => {
    const markup = markupOf();
    expect(markup.match(/OpenClaw updated to 2026\.11\.10/g)).toHaveLength(1);
    expect(markup).toMatch(
      /<details class="event-details"><summary class="event-line" data-side="center">Message text<svg[^>]*aria-hidden="true"/,
    );
    expect(markup).toContain(
      '<p class="update-line-text">✅ OpenClaw updated. For details, open Settings → Updates in the OpenClaw app or run `openclaw update status` in your terminal.</p>',
    );
  });

  it("F-590: has none of a bot's message parts: no avatar, bubble, name or actions, and no button but the disclosure", () => {
    const markup = markupOf();
    for (const part of ["avatar", "bubble", "msg", "msg-actions", "<button", "Pip"])
      expect(markup).not.toContain(part);
  });

  it("F-590: shows the gateway's sentence as text, never as markup", () => {
    const markup = markupOf("<img src=x onerror=alert(1)> **bold** [link](https://example.com)");
    expect(markup).not.toContain("<img");
    expect(markup).toContain(
      "&lt;img src=x onerror=alert(1)&gt; **bold** [link](https://example.com)",
    );
  });
});

describe("F-590: the rail", () => {
  it("F-590: the bot's preview is its last words before the line, and the notice alone doesn't make the task unread for a viewer who read it", () => {
    const transcript = history([reply("The trail is open.", T + 2_000), notice()]);
    const quiet = tasksWithoutUpdateNotices({ pip: [listed] }, { [KEY]: transcript }, SCOPE);
    expect(summarize(quiet.pip!, {}, null).latest?.preview).toBe("The trail is open.");
    // Read at 2,050, after the bot's reply and before the notice moved the row's time.
    const seen = { [KEY]: seenThroughUpdateNotice(listed, T + 2_050, transcript, SCOPE)! };
    expect(summarize(quiet.pip!, seen, null, seen).unread).toBe(false);
    // Without this device's record of the run, it is the bot's message, preview and all.
    const plain = tasksWithoutUpdateNotices(
      { pip: [listed] },
      { [KEY]: transcript },
      { ...SCOPE, updated: [] },
    );
    expect(summarize(plain.pip!, {}, null).latest?.preview).toBe(listed.preview);
    expect(seenThroughUpdateNotice(listed, T + 2_050, transcript, { ...SCOPE, updated: [] })).toBe(
      T + 2_050,
    );
  });

  it("F-590: on a read-only connection the viewer's own memory goes past the notice; on one that writes, unread is the gateway's", () => {
    const transcript = history([reply("The trail is open.", T + 2_000), notice()]);
    const state = {
      bots: [
        {
          id: "pip",
          name: "Pip",
          emoji: null,
          avatarUrl: null,
          theme: null,
          model: null,
          isDefault: true,
        },
      ],
      tasksByBot: { pip: [listed] },
      transcripts: { [KEY]: transcript },
      connection: { gatewayId: "gw-a" },
      openclawUpdating: { updated: UPDATED },
    } as unknown as Parameters<typeof unreadSeenOf>[2];
    const seen = { [KEY]: T + 2_050 };
    const readOnly = unreadSeenOf(seen, false, state);
    expect(readOnly).toEqual({ [KEY]: T + 3_100 });
    expect(summarize([listed], readOnly, null, readOnly).unread).toBe(false);
    // Without this device's record of the run, the viewer's memory as it was: unread.
    const plain = unreadSeenOf(seen, false, {
      ...state,
      openclawUpdating: { ...state.openclawUpdating!, updated: [] },
    });
    expect(plain).toBe(seen);
    expect(summarize([listed], plain, null, plain).unread).toBe(true);
    // A connection that writes reads none of it.
    expect(unreadSeenOf(seen, true, state)).toEqual({});
  });
});
