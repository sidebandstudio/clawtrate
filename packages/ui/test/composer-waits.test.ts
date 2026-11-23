// A message goes only to the session the screen shows (F-278). Until the view shows the task's
// session, from its list row, its creation or its history, the composer keeps the draft with Send
// disabled and says why, so a read that arrives later never decides where the words go.
import type { ClawtrateBridge, ClawtrateState, Transcript } from "@clawtrate/core";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { Composer } from "../src/Composer.tsx";
import { sendWaits } from "../src/live.ts";

const KEY = "agent:otto:disk-space";

const transcript = (change: Partial<Transcript>): Transcript =>
  ({
    sessionKey: KEY,
    status: "loading",
    items: [],
    runs: [],
    outbox: [],
    questions: [],
    approvals: [],
    ...change,
  }) as unknown as Transcript;

/** The composer as drawn with a draft of the person's words. */
const composer = (shown: Transcript | undefined) => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => "Is this still running?",
    setItem: () => undefined,
    removeItem: () => undefined,
  } as unknown as Storage;
  const state = { bots: [], tasksByBot: {}, transcripts: {} } as unknown as ClawtrateState;
  const bridge = { getState: () => state, subscribe: () => () => undefined };
  try {
    return renderToStaticMarkup(
      createElement(BridgeProvider, {
        bridge: bridge as unknown as ClawtrateBridge,
        children: createElement(Composer, {
          bot: { id: "otto", name: "Otto" } as never,
          // A gateway of its own, so no other test's draft is read.
          gateway: `ws://composer-waits-${Math.random()}`,
          taskKey: KEY,
          transcript: shown,
          connected: true,
          notices: [],
          needsYou: null,
          onReview: () => undefined,
          onNotice: () => undefined,
          onDismissNotice: () => undefined,
          onClearNotices: () => undefined,
          onAnnounce: () => undefined,
          focusRef: createRef<HTMLTextAreaElement>(),
          limits: null,
        }),
      }),
    ).replaceAll("&#x27;", "'");
  } finally {
    globalThis.localStorage = saved;
  }
};

/** The Send button's tag. */
const send = (html: string) => /<button[^>]*data-testid="send"[^>]*>/.exec(html)?.[0] ?? "";

describe("F-278: a draft written before the view shows the task's session", () => {
  it("while the task loads: the words stay, Send is disabled, and the composer says it waits", () => {
    const html = composer(transcript({ status: "loading" }));
    expect(html).toContain("Is this still running?");
    expect(html).toContain("Sending waits until this task loads.");
    expect(send(html)).toContain("disabled");
  });

  it("read, with no session under the key: the words stay, and it says the task isn't there", () => {
    const html = composer(transcript({ status: "ready" }));
    expect(html).toContain("This task isn't on the gateway.");
    expect(send(html)).toContain("disabled");
  });

  it("once the view shows the session, from its row or its history: Send takes the words", () => {
    const html = composer(transcript({ status: "loading", sessionId: "s-1" }));
    expect(html).not.toContain("Sending waits");
    expect(send(html)).not.toContain("disabled");
    expect(sendWaits(transcript({ status: "ready", sessionId: "s-1" }))).toBeNull();
  });
});
