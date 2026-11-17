import type { Task } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { isUnread, markSeen } from "../src/unread.ts";

const task = (updatedAt: number, unread = true): Task => ({
  key: "agent:otto:backup-check",
  botId: "otto",
  sessionId: "s",
  title: "Weekly backup check",
  preview: null,
  updatedAt,
  status: "done",
  unread,
});

describe("unread dots (C7)", () => {
  it("stays cleared after the viewer reads a task", () => {
    const seen = markSeen({}, task(100));
    expect(isUnread(task(100), {})).toBe(true);
    expect(isUnread(task(100), seen)).toBe(false);
  });

  it("returns only for newer activity", () => {
    const seen = markSeen({}, task(100));
    expect(isUnread(task(150), seen)).toBe(true);
  });

  it("never shows a dot the gateway does not report", () => {
    expect(isUnread(task(100, false), {})).toBe(false);
  });

  it("does not create a new map when nothing changed", () => {
    const seen = markSeen({}, task(100));
    expect(markSeen(seen, task(100))).toBe(seen);
  });
});
