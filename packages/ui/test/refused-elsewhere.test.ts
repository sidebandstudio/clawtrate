// A message refused because its task was deleted, archived or reset elsewhere (F-278, F-277). What
// it says and offers comes from the engine's record of it, so a view mounted again after the person
// started a new task with its words does not offer that again, and a queued one on the shelf has
// the same choice as a bubble. Resend comes back only once the gateway shows the task live again.
import {
  TASK_ARCHIVED_ELSEWHERE,
  TASK_DELETED_ELSEWHERE,
  TASK_RESET_ELSEWHERE,
  type ClawtrateBridge,
  type ClawtrateState,
  type OutgoingMessage,
} from "@clawtrate/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { ShelfRow } from "../src/Composer.tsx";
import { OutgoingBubble } from "../src/LiveTurn.tsx";

const KEY = "agent:otto:disk-space";

const refused = (change: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  id: "msg-1",
  text: "Are you still there?",
  mode: "new",
  status: "failed",
  runId: null,
  messageSeq: null,
  leftAt: null,
  createdAt: 1,
  error: TASK_ARCHIVED_ELSEWHERE,
  attachments: [],
  ...change,
});

/** What the gateway shows of the task: listed or not, and the session its history names. */
type Shown = { listed: boolean; sessionId?: string };
const GONE: Shown = { listed: false };

/** Markup as a fresh mount draws it, with apostrophes as typed. */
const render = (element: ReactElement, shown: Shown) => {
  const state = {
    tasksByBot: shown.listed ? { otto: [{ key: KEY, botId: "otto" }] } : {},
    transcripts: { [KEY]: { sessionId: shown.sessionId } },
  } as unknown as ClawtrateState;
  const bridge = { getState: () => state, subscribe: () => () => undefined };
  return renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge: bridge as unknown as ClawtrateBridge,
      children: element,
    }),
  ).replaceAll("&#x27;", "'");
};

const bubble = (message: OutgoingMessage, shown = GONE) =>
  render(
    createElement(OutgoingBubble, {
      message,
      taskKey: KEY,
      connected: true,
      announce: () => undefined,
    }),
    shown,
  );

const shelf = (message: OutgoingMessage, shown = GONE) =>
  render(
    createElement(ShelfRow, {
      message,
      taskKey: KEY,
      stopping: false,
      asking: false,
      act: () => undefined,
      onTakenBack: () => undefined,
      onNotice: () => undefined,
      onAnnounce: () => undefined,
    }),
    shown,
  );

describe("F-277 F-278: a message refused because its task is gone elsewhere", () => {
  const withFiles = {
    attachments: [{ fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 10 }],
    replyToId: "row-2",
  };

  it("says what a new task leaves behind before the choice, and offers no Resend", () => {
    const html = bubble(refused(withFiles));
    expect(html).toContain("Not sent. This task was archived elsewhere.");
    expect(html).toContain("A new task can't take files yet, so they stay here.");
    expect(html).toContain("The new task won't show it as a reply.");
    expect(html).toContain("Start a new task with this message");
    expect(html).not.toContain("Resend");
  });

  it("mounted again after its words went to a new task: says so, keeps its files, and offers it no more", () => {
    const html = bubble(refused({ ...withFiles, startedTask: "agent:otto:fresh" }));
    expect(html).toContain("Its words went to a new task, and its files stay here.");
    expect(html).toContain("notes.txt");
    expect(html).not.toContain("Start a new task with this message");
  });

  it("queued, on the shelf: the same choice and Delete, never Try again", () => {
    const html = shelf(refused({ mode: "queue", error: TASK_DELETED_ELSEWHERE }));
    expect(html).toContain("Couldn't start");
    expect(html).toContain("This task was deleted elsewhere.");
    expect(html).toContain("Start a new task with this message");
    expect(html).toContain(">Delete<");
    expect(html).not.toContain("Try again");
  });

  it("queued and refused for another reason: Try again and Delete, as before", () => {
    const html = shelf(refused({ mode: "queue", error: "budget exhausted" }));
    expect(html).toContain("Try again");
    expect(html).not.toContain("Start a new task with this message");
  });

  it("archived, then restored: listed again under the session it was written for, it offers Resend", () => {
    const message = refused({ sessionId: "s-1" });
    expect(bubble(message, { listed: true, sessionId: "s-1" })).toContain(">Resend<");
    expect(shelf({ ...message, mode: "queue" }, { listed: true, sessionId: "s-1" })).toContain(
      "Try again",
    );
    // Still archived, so not listed: nothing it could go to.
    expect(bubble(message, { listed: false, sessionId: "s-1" })).not.toContain("Resend");
    // Listed under another session: a different task, never a silent retarget.
    expect(bubble(message, { listed: true, sessionId: "s-2" })).not.toContain("Resend");
  });

  it("reset: once the screen shows the session that followed, it offers Resend to that one", () => {
    const message = refused({ sessionId: "s-1", error: TASK_RESET_ELSEWHERE });
    const html = bubble(message, { listed: true, sessionId: "s-2" });
    expect(html).toContain("Not sent. This task was reset elsewhere.");
    expect(html).toContain(">Resend<");
    // Before the history of the session that followed arrives, there is nothing to send it to.
    expect(bubble(message, { listed: true, sessionId: "s-1" })).not.toContain("Resend");
  });

  it("deleted: never Resend, even with a task listed under the key again", () => {
    const message = refused({ sessionId: "s-1", error: TASK_DELETED_ELSEWHERE });
    expect(bubble(message, { listed: true, sessionId: "s-2" })).not.toContain("Resend");
    expect(shelf({ ...message, mode: "queue" }, { listed: true, sessionId: "s-2" })).not.toContain(
      "Try again",
    );
  });
});
