// The "Started a task" card (F-587) and the Messaged card's "Sent to <task title>": what each says
// and offers in each state, drawn from the engine's own selection over recorded rows.

import {
  emptyActivity,
  initialConnectionState,
  mapHistory,
  mapSessionRow,
  RawTable,
  runsFromHistory,
  selectMessageCards,
  selectStartedTasks,
  type Bot,
  type ClawtrateBridge,
  type StartedTaskCard,
  type Task,
  type Transcript,
} from "@clawtrate/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { CardEnvContext, type CardEnv } from "../src/cards/context.tsx";
import { BotMessageCardView } from "../src/cards/MessagedCard.tsx";
import { StartedTaskCardView } from "../src/cards/StartedTaskCard.tsx";

// The "Show commands" switch reads the device's storage, which a markup render has none of: off,
// as by default, so a card's foot holds only its actions.
vi.mock("../src/preferences.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useShowCommands: () => [false, () => {}],
}));

const HERE = "agent:pip:main";
const CHILD = "agent:pip:dashboard:f52b9e03";
const CHILD_RUN = "78e0662c";
const T = 1_795_581_283_254;
const LABEL = "Compare trail maps";
const BRIEF = "Compare the lake loop and the ridge trail.\nSay which suits a relaxed Saturday.";

const bot = (id: string, name: string): Bot => ({
  id,
  name,
  emoji: null,
  avatarUrl: null,
  theme: null,
  model: null,
  isDefault: false,
});
const pip = bot("pip", "Pip");
const marlow = bot("marlow", "Marlow");

const user = (text: string, at: number, run: string) => ({
  role: "user",
  content: text,
  timestamp: at,
  __openclaw: { id: `u-${at}`, idempotencyKey: `${run}:user` },
});
const call = (run: string, at: number, id: string, name: string, args: unknown) => ({
  role: "assistant",
  timestamp: at,
  content: [{ type: "toolCall", id, name, arguments: args }],
  __openclaw: { id: `a-${at}`, runId: run },
});
const result = (
  run: string,
  at: number,
  id: string,
  name: string,
  body: unknown,
  isError = false,
) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  isError,
  timestamp: at,
  content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
  __openclaw: { id: `r-${at}`, runId: run },
});
const say = (run: string, at: number, text: string) => ({
  role: "assistant",
  timestamp: at,
  content: [{ type: "text", text }],
  __openclaw: { id: `s-${at}`, runId: run },
});

const START = { task: BRIEF, label: LABEL, visible: true };
const ACCEPTED = { status: "accepted", childSessionKey: CHILD, runId: CHILD_RUN, label: LABEL };

function listedTask(status: string, extra: Record<string, unknown> = {}): Task {
  return mapSessionRow({
    key: CHILD,
    agentId: "pip",
    createdVia: "spawn",
    spawnedBy: HERE,
    label: LABEL,
    status,
    ...extra,
  })!;
}

function transcriptOf(rows: unknown[], inFlight: string | null = null): Transcript {
  const raw = new RawTable();
  return {
    ...emptyActivity,
    runs: runsFromHistory(rows, inFlight, { sessionKey: HERE, now: T + 60_000, raw }),
    sessionKey: HERE,
    status: "ready",
    items: mapHistory(rows),
    error: null,
    hasMore: false,
    live: null,
    linkedRuns: {},
    interSession: [],
    mcpTools: {},
    loadedAt: null,
  };
}

function envOf(transcript: Transcript, openTask: CardEnv["openTask"], connected = true): CardEnv {
  return {
    taskKey: HERE,
    bot: pip,
    bots: [pip, marlow],
    transcript,
    connection: { ...initialConnectionState, status: connected ? "connected" : "reconnecting" },
    connected,
    invoke: () => Promise.reject(new Error("not in this test")),
    send: () => Promise.reject(new Error("not in this test")),
    runOf: (id) => transcript.runs.find((run) => run.id === id),
    transcripts: {},
    openTask,
  };
}

const html = (element: ReactElement, env: CardEnv) =>
  renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge: {} as ClawtrateBridge,
      children: createElement(CardEnvContext.Provider, { value: env, children: element }),
    }),
  );
/** The words React's own markup reads as, for comparing; never markup to show. */
const text = (markup: string) =>
  markup
    .split(/<[^>]*>/)
    .join(" ")
    .split("&#x27;")
    .join("'");
const words = (markup: string) => text(markup).replace(/\s+/g, " ").trim();

const open = () => {};
const read = { state: "available" as const, raw: null, load: () => {} };

/** One start in Pip's main task, its card from the engine, and its markup. */
function drawn(
  rows: unknown[],
  tasks: Record<string, Task[]>,
  options: { inFlight?: string | null; openTask?: CardEnv["openTask"]; connected?: boolean } = {},
): { card: StartedTaskCard; markup: string } {
  const transcript = transcriptOf(rows, options.inFlight ?? null);
  const [card] = selectStartedTasks({
    runs: transcript.runs,
    items: transcript.items,
    taskKey: HERE,
    tasks,
  });
  const env = envOf(
    transcript,
    options.openTask === undefined ? open : options.openTask,
    options.connected,
  );
  return {
    card: card!,
    markup: html(createElement(StartedTaskCardView, { card: card!, read }), env),
  };
}

const started = (body: unknown = ACCEPTED, isError = false) => [
  user("#hand-off", T, "run-1"),
  call("run-1", T + 800, "call-1", "sessions_spawn", START),
  result("run-1", T + 1_000, "call-1", "sessions_spawn", body, isError),
  say("run-1", T + 1_040, "I started a task for it."),
];

describe("F-587: the Started a task card", () => {
  it("F-587: Working: the bot doing the work, the title, the brief's first line, the state as text, and Open named for the task", () => {
    const { markup } = drawn(started(), { pip: [listedTask("running")] });
    expect(markup).toContain('role="group" aria-label="Started a task: Compare trail maps"');
    expect(words(markup)).toContain(
      "Started a task Pip Compare trail maps Working Compare the lake loop and the ridge trail.",
    );
    expect(words(markup)).not.toContain("Say which suits");
    expect(markup).toContain('data-state="working"');
    expect(markup).toContain('aria-label="Open Compare trail maps"');
    expect(markup).toMatch(/data-testid="open-started-task"[^>]*>Open task<\/button>/);
  });

  it("F-587: Waiting for you, Done, and Failed say the task list's state in words", () => {
    for (const [status, word] of [
      ["waiting", "Waiting for you"],
      ["done", "Done"],
      ["failed", "Failed"],
    ] as const) {
      const task = { ...listedTask("done"), status } as Task;
      const { markup } = drawn(started(), { pip: [task] });
      expect(words(markup)).toContain(`Compare trail maps ${word}`);
      expect(markup).toContain('aria-label="Open Compare trail maps"');
    }
  });

  it("F-587: Starting while the call is open, with nothing to open", () => {
    const rows = [
      user("#hand-off", T, "run-1"),
      call("run-1", T + 800, "call-1", "sessions_spawn", START),
    ];
    const { markup } = drawn(rows, { pip: [listedTask("running")] }, { inFlight: "run-1" });
    expect(words(markup)).toContain("Started a task Pip Compare trail maps Starting");
    expect(words(markup)).toContain("Pip is starting this task.");
    expect(markup).not.toContain("Open task");
  });

  it("F-587: Done with the bot's report: says it reported back, and goes to that reply", () => {
    const rows = [
      ...started(),
      say(`announce:v1:${CHILD}:${CHILD_RUN}`, T + 3_000, "Compare trail maps finished."),
    ];
    const { card, markup } = drawn(rows, { pip: [listedTask("done")] });
    expect(card.reportedBack).not.toBeNull();
    expect(words(markup)).toContain("Pip reported back.");
    expect(markup).toContain('aria-label="Show Pip&#x27;s report on Compare trail maps"');
  });

  it("F-587: Couldn't start shows the gateway's reason as the gateway's words, and no Open", () => {
    const { markup } = drawn(
      started(
        {
          status: "error",
          tool: "sessions_spawn",
          error: "label already in use: Compare trail maps",
        },
        true,
      ),
      { pip: [listedTask("running")] },
    );
    expect(markup).toContain('aria-label="Couldn&#x27;t start a task: Compare trail maps"');
    expect(words(markup)).toContain("Couldn't start a task Pip Compare trail maps Couldn't start");
    expect(words(markup)).toContain("The gateway says: label already in use: Compare trail maps");
    expect(markup).not.toContain("Open task");
  });

  it("F-587: a task the list does not hold as started from here is text only", () => {
    const { markup } = drawn(started(), {});
    expect(words(markup)).toContain("Compare trail maps Started");
    expect(words(markup)).toContain("This task is not in the task list here");
    expect(markup).not.toContain("<button");
    // Nor without a way to move between tasks.
    const none = drawn(started(), { pip: [listedTask("running")] }, { openTask: null });
    expect(none.markup).not.toContain("Open task");
  });

  it("F-587: a task under another bot shows that bot", () => {
    const partner = "agent:marlow:dashboard:344e";
    const task = mapSessionRow({
      key: partner,
      agentId: "marlow",
      createdVia: "spawn",
      spawnedBy: HERE,
      label: "Review the route",
      status: "running",
    })!;
    const { markup } = drawn(started({ ...ACCEPTED, childSessionKey: partner }), {
      marlow: [task],
    });
    expect(words(markup)).toContain("Started a task Marlow Review the route Working");
    expect(markup).toContain('aria-label="Open Review the route"');
  });

  it("F-587: the bot's words are text, never markup", () => {
    const rows = [
      user("#hand-off", T, "run-1"),
      call("run-1", T + 800, "call-1", "sessions_spawn", {
        ...START,
        label: '<img src=x onerror="alert(1)">',
        task: "<script>alert(1)</script>",
      }),
      result("run-1", T + 1_000, "call-1", "sessions_spawn", ACCEPTED),
    ];
    const { markup } = drawn(rows, {});
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("F-587: while the connection is lost, a live state says what was last seen", () => {
    const { markup } = drawn(started(), { pip: [listedTask("running")] }, { connected: false });
    expect(words(markup)).toContain("Last seen working");
  });
});

describe("F-587: a follow-up to the bot's own task on the Messaged card", () => {
  const rows = [
    user("#follow-up", T, "run-2"),
    call("run-2", T + 500, "call-2", "sessions_send", {
      sessionKey: CHILD,
      message: "Also say which route has more shade.",
      timeoutSeconds: 0,
    }),
    result("run-2", T + 700, "call-2", "sessions_send", {
      runId: "34fc6031",
      status: "accepted",
      sessionKey: CHILD,
      targetDisposition: "queued",
      delivery: { status: "pending" },
    }),
  ];
  const messaged = (task: Task | null) => {
    const transcript = transcriptOf(rows);
    const [card] = selectMessageCards(transcript, {}).botMessages;
    return html(
      createElement(BotMessageCardView, { card: card!, task, read, related: [], partial: false }),
      envOf(transcript, open),
    );
  };

  it('F-587: reads "Sent to <task title>" and opens that task', () => {
    const markup = messaged(listedTask("running"));
    expect(markup).toContain(
      'aria-label="Sent to Compare trail maps: Also say which route has more shade. Sent."',
    );
    expect(words(markup)).toContain("Sent to Compare trail maps");
    expect(markup).toContain(">Open Compare trail maps</button>");
    expect(markup).toContain('aria-label="Open Compare trail maps"');
  });

  it("F-587: a message to a task the list does not hold as started from here stays Messaged <bot>", () => {
    const markup = messaged(null);
    expect(markup).toContain(
      'aria-label="Messaged Pip: Also say which route has more shade. Sent."',
    );
    expect(markup).toContain(">Open in Pip</button>");
  });
});
