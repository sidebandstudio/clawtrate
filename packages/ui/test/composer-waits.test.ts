// A message goes only to the session the screen showed when its words were written (F-278). Until
// the view shows the task's session, from its list row, its creation or its history, the composer
// keeps the draft with Send disabled and says why, so a read that arrives later never decides where
// the words go. A draft keeps the session it was started in: once the view shows another, nothing
// is sent until the person starts a new task with its words or deletes it. A draft is kept across
// reloads as one record, its words with its session; words found without one, kept by an earlier
// version, wait for the person's choice of a new task or the task shown.
import {
  newRun,
  type ClawtrateBridge,
  type ClawtrateState,
  type Transcript,
} from "@clawtrate/core";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { Composer } from "../src/Composer.tsx";
import { DRAFT_MOVED, DRAFT_UNBOUND, sendWaits } from "../src/live.ts";
import { RunEnding } from "../src/LiveTurn.tsx";

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

/**
 * The composer as drawn with a draft of the person's words kept from an earlier page: started in
 * `started` when given, or, as `"earlier"`, kept by an earlier version with no session at all.
 */
const composer = (shown: Transcript | undefined, started?: string) => {
  const saved = globalThis.localStorage;
  const words = "Is this still running?";
  globalThis.localStorage = {
    getItem: (key: string) =>
      started === "earlier"
        ? key.startsWith("clawtrate.draft.")
          ? words
          : null
        : key.startsWith("clawtrate.composerDraft.")
          ? JSON.stringify({ text: words, ...(started ? { sessionId: started } : {}) })
          : null,
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
  it("while the task loads: the words stay, Send is disabled, and the composer says it waits, with Start as new task in reach", () => {
    const html = composer(transcript({ status: "loading" }));
    expect(html).toContain("Is this still running?");
    expect(html).toContain("Sending waits until this task loads.");
    expect(send(html)).toContain("disabled");
    // Send can't open its menu while disabled: the way to a new task is its own control.
    expect(html).toMatch(/<button[^>]*>Start as new task<\/button>/);
  });

  it("read, with no session under the key: the words stay, and it says the task isn't there", () => {
    const html = composer(transcript({ status: "ready" }));
    expect(html).toContain("This task isn't on the gateway.");
    expect(send(html)).toContain("disabled");
  });

  it("once the view shows the session, from its row or its history: Send takes words bound to it", () => {
    const html = composer(transcript({ status: "loading", sessionId: "s-1" }), "s-1");
    expect(html).not.toContain("Sending waits");
    expect(send(html)).not.toContain("disabled");
    expect(sendWaits(transcript({ status: "ready", sessionId: "s-1" }))).toBeNull();
  });
});

describe("F-278: a draft keeps the session it was started in", () => {
  it("started while the view showed one session, which shows another now: Send is disabled, it says it was not sent, and offers a new task with its words and Delete", () => {
    const html = composer(transcript({ status: "ready", sessionId: "s-2" }), "s-1");
    expect(html).toContain("Is this still running?");
    expect(html).toContain(DRAFT_MOVED);
    expect(send(html)).toContain("disabled");
    expect(html).toMatch(/<button[^>]*>Start a new task with this message<\/button>/);
    expect(html).toMatch(/<button[^>]*>Delete<\/button>/);
  });

  it("the view still shows the session it was started in: Send takes the words", () => {
    const html = composer(transcript({ status: "ready", sessionId: "s-1" }), "s-1");
    expect(html).not.toContain(DRAFT_MOVED);
    expect(send(html)).not.toContain("disabled");
  });
});

describe("F-278: words kept with no session they were written for", () => {
  it("kept by an earlier version, words alone: Send is disabled, and only a new task or the task shown, named as such, takes them", () => {
    const html = composer(transcript({ status: "ready", sessionId: "s-2" }), "earlier");
    expect(html).toContain("Is this still running?");
    expect(html).toContain(DRAFT_UNBOUND);
    expect(send(html)).toContain("disabled");
    expect(html).toMatch(/<button[^>]*>Start a new task with this message<\/button>/);
    expect(html).toMatch(/<button[^>]*>Send to the task shown<\/button>/);
  });

  it("kept before the view showed a session: the same choice, never the session the view shows now", () => {
    const html = composer(transcript({ status: "ready", sessionId: "s-2" }));
    expect(html).toContain(DRAFT_UNBOUND);
    expect(send(html)).toContain("disabled");
  });

  it("while the task loads: the words wait, with Start as new task, and no session to send them to", () => {
    const html = composer(transcript({ status: "loading" }), "earlier");
    expect(html).toContain("Sending waits until this task loads.");
    expect(html).not.toContain("Send to the task shown");
    expect(send(html)).toContain("disabled");
  });
});

describe("F-278: Try again on a failed turn whose words only history holds", () => {
  const failed = newRun(
    "run-1",
    {
      state: "failed",
      origin: "gateway",
      anchorItemId: "row-1",
      error: { message: "The model provider is down.", kind: "gateway" },
    },
    1,
  );
  const row = {
    id: "row-1",
    role: "user",
    timestamp: 1,
    blocks: [{ kind: "text", text: "Back up the photos." }],
    model: null,
  };
  const ending = (shown: Transcript) => {
    const state = { bots: [], tasksByBot: {}, transcripts: {} } as unknown as ClawtrateState;
    const bridge = { getState: () => state, subscribe: () => () => undefined };
    return renderToStaticMarkup(
      createElement(BridgeProvider, {
        bridge: bridge as unknown as ClawtrateBridge,
        children: createElement(RunEnding, {
          run: failed,
          bot: { id: "otto", name: "Otto" } as never,
          transcript: shown,
          taskKey: KEY,
        }),
      }),
    ).replaceAll("&#x27;", "'");
  };
  const retry = (html: string) => /<button[^>]*>Try again<\/button>/.exec(html)?.[0] ?? "";

  it("before the view shows the task's session: disabled, with the reason shown up front", () => {
    const html = ending(transcript({ status: "ready", items: [row] as never }));
    expect(retry(html)).toContain("disabled");
    expect(html).toContain("This task isn't on the gateway.");
  });

  it("once the view shows it: it can go, to that session", () => {
    const html = ending(transcript({ status: "ready", sessionId: "s-1", items: [row] as never }));
    expect(retry(html)).not.toContain("disabled");
    expect(html).not.toContain("This task isn't on the gateway.");
  });
});
