// A message refused because its task was deleted or archived elsewhere (F-278, F-277). What it says
// and offers comes from the engine's record of it, so a view mounted again after the person started
// a new task with its words does not offer that again, and a queued one on the shelf has the same
// choice as a bubble.
import {
  TASK_ARCHIVED_ELSEWHERE,
  TASK_DELETED_ELSEWHERE,
  type ClawtrateBridge,
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

/** Markup as a fresh mount draws it, with apostrophes as typed. */
const render = (element: ReactElement) =>
  renderToStaticMarkup(
    createElement(BridgeProvider, { bridge: {} as ClawtrateBridge, children: element }),
  ).replaceAll("&#x27;", "'");

const bubble = (message: OutgoingMessage) =>
  render(
    createElement(OutgoingBubble, {
      message,
      taskKey: KEY,
      connected: true,
      announce: () => undefined,
    }),
  );

const shelf = (message: OutgoingMessage) =>
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
});
