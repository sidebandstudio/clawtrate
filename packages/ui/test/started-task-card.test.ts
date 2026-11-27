// The "Started a task" card (F-587) and the Messaged card's "Sent to <task title>": what each says
// and offers in each state, drawn from the engine's own selection over recorded rows.

import {
  emptyActivity,
  initialConnectionState,
  initialState,
  mapHistory,
  mapSessionRow,
  RawTable,
  runsFromHistory,
  selectStartedTasks,
  type Bot,
  type ClawtrateBridge,
  type ClawtrateState,
  type StartedTaskCard,
  type Task,
  type Transcript,
} from "@clawtrate/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { CardEnvContext, OpenTaskContext, type CardEnv } from "../src/cards/context.tsx";
import { StartedTaskCardView } from "../src/cards/StartedTaskCard.tsx";
import { CardScope, RunCardList } from "../src/cards/TranscriptCards.tsx";
import { isCardCall } from "../src/cards/useCards.ts";

// The "Show commands" switch reads the device's storage, which a markup render has none of: off,
// as by default, so a card's foot holds only its actions.
vi.mock("../src/preferences.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useShowCommands: () => [false, () => {}],
}));

// The state a card scope reads, set by each test that draws one: a markup render has no store to
// subscribe to.
const shown = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("../src/bridge.tsx", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useClawtrateState: () => shown.state,
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

function envOf(
  transcript: Transcript,
  openTask: CardEnv["openTask"],
  connected = true,
  bots: Bot[] = [pip, marlow],
): CardEnv {
  return {
    taskKey: HERE,
    bot: pip,
    bots,
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
  options: {
    inFlight?: string | null;
    openTask?: CardEnv["openTask"];
    connected?: boolean;
    /** The bots this connection lists; the conversation's own is Pip whatever it holds. */
    bots?: Bot[];
  } = {},
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
    options.bots,
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

  it("F-587 #799: a start refused for its model says which model, in plain words, never the gateway's own", () => {
    for (const error of [
      "model not allowed: scripted/dev-1",
      'sessions_spawn model "scripted/dev-1" is not usable: model not allowed: scripted/dev-1. Rejected by agents.defaults.modelPolicy.allow. Add the model or its provider wildcard to agents.defaults.modelPolicy.allow, or choose an allowed model.',
    ]) {
      const { markup } = drawn(started({ status: "error", tool: "sessions_spawn", error }, true), {
        pip: [listedTask("running")],
      });
      expect(words(markup)).toContain(
        "Couldn't start a task Pip Compare trail maps Couldn't start Compare the lake loop and the ridge trail. This gateway doesn't allow tasks on Scripted's dev-1.",
      );
      expect(words(markup)).not.toContain("The gateway says");
      expect(words(markup)).not.toContain("model not allowed");
      expect(markup).not.toContain("Open task");
    }
  });

  it("F-587 #799: a task made with sessions_create (OpenClaw 2026.11.10) is the same card, and opens", () => {
    const ask = { label: LABEL, message: BRIEF };
    const made = { sessionKey: CHILD, sessionId: "69ffa710", runStarted: true, runId: CHILD_RUN };
    const rows = [
      user("#create-task", T, "run-1"),
      call("run-1", T + 800, "call-1", "sessions_create", ask),
      {
        ...result("run-1", T + 1_000, "call-1", "sessions_create", made),
        details: { sessionKey: CHILD },
      },
      say("run-1", T + 1_040, "I started a task for it."),
    ];
    const { markup } = drawn(rows, { pip: [listedTask("running")] });
    expect(words(markup)).toContain(
      "Started a task Pip Compare trail maps Working Compare the lake loop and the ridge trail.",
    );
    expect(markup).toContain('aria-label="Open Compare trail maps"');
    // Refused for its model, the same words as a sessions_spawn start's.
    const refused = [
      user("#create-task", T, "run-1"),
      call("run-1", T + 800, "call-1", "sessions_create", ask),
      result(
        "run-1",
        T + 1_000,
        "call-1",
        "sessions_create",
        { status: "error", tool: "sessions_create", error: "model not allowed: scripted/dev-1" },
        true,
      ),
    ];
    expect(words(drawn(refused, {}).markup)).toContain(
      "Couldn't start a task Pip Compare trail maps Couldn't start Compare the lake loop and the ridge trail. This gateway doesn't allow tasks on Scripted's dev-1.",
    );
  });

  it("F-587 #799: a task sessions_create made whose first message didn't run opens, and says why", () => {
    const ask = { label: LABEL, message: BRIEF };
    const made = {
      sessionKey: CHILD,
      sessionId: "69ffa710",
      runStarted: false,
      runError: "Visible session run failed: provider \u202Eunavailable",
    };
    const rows = [
      user("#create-task", T, "run-1"),
      call("run-1", T + 800, "call-1", "sessions_create", ask),
      result("run-1", T + 1_000, "call-1", "sessions_create", made),
      say("run-1", T + 1_040, "The task's first message didn't run."),
    ];
    const { markup } = drawn(rows, { pip: [listedTask("idle")] });
    expect(words(markup)).toContain(
      "Started a task Pip Compare trail maps Failed Compare the lake loop and the ridge trail. The task was made, but its first message didn't run. The gateway says: Visible session run failed: provider unavailable",
    );
    expect(markup).not.toContain("\u202E");
    expect(markup).toContain('aria-label="Open Compare trail maps"');
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

describe("F-587: the bot doing the work, and what the card shows of the bot's words", () => {
  const refusedFor = (agentId: string) => [
    user("#hand-off", T, "run-1"),
    call("run-1", T + 800, "call-1", "sessions_spawn", { ...START, agentId }),
    result(
      "run-1",
      T + 1_000,
      "call-1",
      "sessions_spawn",
      { status: "forbidden", error: "agentId is not allowed for sessions_spawn (allowed: pip)" },
      true,
    ),
  ];

  it("F-587: a bot's agentId is never shown as a name: an unlisted one is another bot", () => {
    const rlo = String.fromCodePoint(0x202e);
    const { markup } = drawn(refusedFor(`Done · Open task${rlo}${"z".repeat(3_000)}`), {});
    expect(words(markup)).toContain("Couldn't start a task another bot Compare trail maps");
    expect(markup).not.toContain("zzzz");
    expect(markup).not.toContain("Done · Open task");
    // Still open: the same, before any result.
    const open = [
      user("#hand-off", T, "run-1"),
      call("run-1", T + 800, "call-1", "sessions_spawn", { ...START, agentId: "Jo Smith" }),
    ];
    const starting = drawn(open, {}, { inFlight: "run-1" });
    expect(words(starting.markup)).toContain(
      "Started a task another bot Compare trail maps Starting",
    );
    expect(starting.markup).not.toContain("Jo Smith");
  });

  it("F-587: a listed bot's id is that bot's name, and a start for itself is the starter", () => {
    expect(words(drawn(refusedFor("marlow"), {}).markup)).toContain(
      "Couldn't start a task Marlow Compare trail maps",
    );
    expect(words(drawn(started(), {}).markup)).toContain("Started a task Pip Compare trail maps");
  });

  it("F-587: a start for itself names the starter even when the list doesn't hold the starter", () => {
    // The conversation's bot is Pip; this connection lists only Marlow.
    const only = { bots: [marlow] };
    expect(words(drawn(refusedFor("pip"), {}, only).markup)).toContain(
      "Couldn't start a task Pip Compare trail maps",
    );
    expect(words(drawn(started(), {}, only).markup)).toContain(
      "Started a task Pip Compare trail maps",
    );
  });

  it("F-587: invisible formatting never reaches the card's title, its group, Open's name or the announcement", () => {
    const rlo = String.fromCodePoint(0x202e);
    const task = listedTask("running", { label: `${rlo}ksat nepO · enoD` });
    const { markup } = drawn(started(), { pip: [task] });
    expect(markup).toContain('aria-label="Started a task: ksat nepO · enoD"');
    expect(markup).toContain('aria-label="Open ksat nepO · enoD"');
    expect(markup).not.toContain(rlo);
  });

  it("F-587: a listed task whose row says nothing of a run is Started, with Open, as the sidebar shows no state", () => {
    const { markup } = drawn(started(), { pip: [listedTask("")] });
    expect(words(markup)).toContain("Compare trail maps Started");
    expect(markup).toContain('aria-label="Open Compare trail maps"');
    expect(markup).not.toContain("not in the task list");
  });
});

describe("F-587: a follow-up to the bot's own task on the Messaged card", () => {
  const followUp = (result_: Record<string, unknown>) => [
    user("#follow-up", T, "run-2"),
    call("run-2", T + 500, "call-2", "sessions_send", {
      sessionKey: CHILD,
      message: "Also say which route has more shade.",
      timeoutSeconds: 0,
    }),
    result("run-2", T + 700, "call-2", "sessions_send", result_),
  ];
  const accepted = {
    runId: "34fc6031",
    status: "accepted",
    sessionKey: CHILD,
    targetDisposition: "queued",
    delivery: { status: "pending" },
  };
  /** The follow-up's card, drawn by the conversation's own card scope, against this list. */
  const messaged = (tasks: Task[], rows = followUp(accepted)) => {
    const transcript = transcriptOf(rows);
    shown.state = {
      ...initialState,
      bots: [pip, marlow],
      tasksByBot: { pip: tasks },
      connection: { ...initialState.connection, status: "connected" },
    } satisfies ClawtrateState;
    const bridge = {
      invoke: () => Promise.reject(new Error("not in this test")),
      send: () => Promise.reject(new Error("not in this test")),
    } as unknown as ClawtrateBridge;
    return renderToStaticMarkup(
      createElement(BridgeProvider, {
        bridge,
        children: createElement(OpenTaskContext.Provider, {
          value: open,
          children: createElement(CardScope, {
            taskKey: HERE,
            transcript,
            children: createElement(RunCardList, { runId: "run-2" }),
          }),
        }),
      }),
    );
  };

  it('F-587: reads "Sent to <task title>" and opens that task', () => {
    const markup = messaged([listedTask("running")]);
    expect(markup).toContain(
      'aria-label="Sent to Compare trail maps: Also say which route has more shade. Sent."',
    );
    expect(words(markup)).toContain("Sent to Compare trail maps");
    expect(markup).toContain('aria-label="Open Compare trail maps"');
    expect(markup).toContain(">Open Compare trail maps</button>");
  });

  it("F-587: a task started from another conversation stays Messaged <bot>", () => {
    const markup = messaged([listedTask("running", { spawnedBy: "agent:pip:elsewhere" })]);
    expect(markup).toContain(
      'aria-label="Messaged Pip: Also say which route has more shade. Sent."',
    );
    expect(markup).toContain(">Open in Pip</button>");
  });

  it("F-587: a key only the call names, not the result, stays Messaged <bot>", () => {
    const rows = followUp({ runId: "34fc6031", status: "accepted" });
    const markup = messaged([listedTask("running")], rows);
    expect(markup).toContain(
      'aria-label="Messaged Pip: Also say which route has more shade. Sent."',
    );
    expect(markup).not.toContain("Sent to");
  });

  it("F-587: the task's title is cleaned as the card cleans it", () => {
    const rlo = String.fromCodePoint(0x202e);
    const markup = messaged([listedTask("running", { label: `${rlo}ksat nepO` })]);
    expect(markup).toContain('aria-label="Open ksat nepO"');
    expect(markup).not.toContain(rlo);
  });
});

describe("F-587: what the view reads whole", () => {
  it("F-587: a task start's payload is never read whole: the card draws from what the step keeps", () => {
    const steps = transcriptOf([
      ...started(),
      call("run-1", T + 1_100, "call-h", "sessions_spawn", { task: "Check.", label: "Hidden" }),
      call("run-1", T + 1_200, "call-s", "sessions_send", { sessionKey: CHILD, message: "Hi" }),
    ]).runs.flatMap((run) => run.steps);
    const read = steps.filter(isCardCall).map((step) => step.toolName);
    expect(read).toEqual(["sessions_send"]);
  });
});
