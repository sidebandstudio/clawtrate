// The Work pane's Computer tab on fixed data, for the fixture and the visual
// checks: the engine's own `ComputerViews`, answered by a scripted computer
// plugin instead of a gateway, and a page drawn here as the stream's frames.
// Everything is invented. The address picks how the scripted plugin answers:
//
//   &computer=noplugin|unconfigured|unused|closed|ended|tabclosed|browsergone|
//             draining|control|busy|unsettled|conflict|stuck|active|elsewhere|
//             releasefail|releaseunknown|complexquestion|offline|nodeunknown|desktop|watching
//   &firstwatch=1     the one-time note before the first watch
//   &takerace=grant   a grant that arrives after the take was cancelled
//   &access=read      a read-only connection
//
// The scenes themselves (watching, the full view, control) are reached by
// clicking, as a person would; the address only decides the plugin's answers.

import {
  ComputerViews,
  newRun,
  type ClawtrateState,
  type ComputerState,
  type QuestionCard,
  type Run,
  type Step,
  type Transcript,
  type WebSocketLike,
} from "@clawtrate/core";
import { OPEN_TASK } from "./data.ts";

export const COMPUTER_STATES = [
  "noplugin",
  "unconfigured",
  "unused",
  "closed",
  "watching",
  "ended",
  "tabclosed",
  "browsergone",
  "draining",
  "control",
  "busy",
  "unsettled",
  "conflict",
  "stuck",
  "active",
  "elsewhere",
  "elsewhere-taking",
  "releasefail",
  "releaseunknown",
  "complexquestion",
  "offline",
  "nodeunknown",
  "desktop",
] as const;
export type ComputerMode = (typeof COMPUTER_STATES)[number];

export type ComputerParams = {
  mode: ComputerMode | null;
  firstWatch: boolean;
  takeRace: boolean;
  readOnly: boolean;
};

export function computerParams(params: URLSearchParams): ComputerParams {
  const mode = params.get("computer");
  return {
    mode: (COMPUTER_STATES as readonly string[]).includes(mode ?? "")
      ? (mode as ComputerMode)
      : null,
    firstWatch: params.get("firstwatch") === "1",
    takeRace: params.get("takerace") === "grant",
    readOnly: params.get("access") === "read",
  };
}

/** Juniper's research task, whose run uses the browser and waits on the person. */
export const COMPUTER_TASK = "agent:main:ebook-apps";
export const FIXTURE_VIEWER = "fixture-viewer";
const MINUTE = 60_000;
const TABS = [
  {
    targetId: "T1A2B3C4D5E6F708192A3B4C5D6E7F80",
    title: "Your account",
    url: "https://library.example/account",
  },
  {
    targetId: "T9F8E7D6C5B4A39281706F5E4D3C2B1A",
    title: "Lending apps",
    url: "https://shelfwise.example/apps",
  },
];

function step(
  callId: string,
  toolName: string,
  title: string,
  at: number,
  status: Step["status"],
  args: Record<string, unknown>,
  details: Record<string, unknown> | null,
): Step {
  return {
    id: `tool:${callId}`,
    kind: "tool",
    title,
    toolName,
    toolCallId: callId,
    status,
    startedAt: at,
    endedAt: status === "running" ? null : at + 1200,
    argsText: null,
    output: null,
    result: null,
    error: null,
    approvalId: null,
    failureKind: null,
    truncated: false,
    replaceable: false,
    correction: 0,
    continuation: null,
    raw: null,
    rawSize: null,
    args,
    ...(details ? { details } : {}),
    ...(toolName === "exec" ? { commandBearing: true } : {}),
  };
}

function question(now: number, runId: string, complex: boolean): QuestionCard {
  const options = [
    { index: 0, label: "I'm done", description: "I signed in. Carry on.", value: null },
    { index: 1, label: "Skip", description: "Check the holds another way.", value: null },
  ];
  return {
    id: "ask_library_sign_in",
    runId,
    status: "pending",
    questions: [
      {
        id: "q1",
        header: "Sign in",
        question: "Sign in to your library account, then hand the browser back.",
        options,
        optionsOmitted: 0,
        multiSelect: complex,
        allowsOther: true,
      },
    ],
    createdAt: now - MINUTE,
    expiresAt: now + 14 * MINUTE,
    answers: null,
    submitting: false,
    error: null,
    raw: null,
    ordinary: true,
    sent: null,
    settledBy: [],
  };
}

/** The runs and the question the Computer scenes add to Juniper's research task and Otto's disk task. */
export function withComputerRuns(
  transcripts: Record<string, Transcript>,
  now: number,
  params: ComputerParams,
): Record<string, Transcript> {
  if (params.mode === null) return transcripts;
  const out = { ...transcripts };
  const research = out[COMPUTER_TASK];
  if (research && params.mode !== "unused") {
    const active = params.mode === "active";
    const run = newRun(
      "fixture-computer-1",
      { state: active ? "running" : "waiting", origin: "gateway", bound: true },
      now - 3 * MINUTE,
    );
    run.steps = [
      step(
        "b1",
        "browser",
        "Browser",
        now - 2 * MINUTE,
        "done",
        { action: "open", url: TABS[0]!.url },
        { ok: true },
      ),
      step(
        "b2",
        "browser",
        "Browser",
        now - 100_000,
        "done",
        { action: "act", kind: "type", ref: "search" },
        { ok: true },
      ),
      ...(active
        ? [
            step(
              "b3",
              "browser",
              "Browser",
              now - 10_000,
              "running",
              { action: "open", url: TABS[1]!.url },
              null,
            ),
          ]
        : []),
    ];
    const asking = active ? [] : [question(now, run.id, params.mode === "complexquestion")];
    out[COMPUTER_TASK] = {
      ...research,
      runs: [...research.runs, run],
      questions: [...research.questions, ...asking],
      live: { runId: run.id, text: "" },
    };
  }
  const disk = out[OPEN_TASK];
  if (disk) {
    const run: Run = newRun(
      "fixture-computer-2",
      { state: "completed", origin: "history", bound: true },
      now - 20 * MINUTE,
    );
    run.steps = [
      step(
        "x1",
        "exec",
        "Run a command",
        now - 19 * MINUTE,
        "done",
        { command: "du -sh /var/lib/*" },
        { exitCode: 0, durationMs: 6200, nodeId: "media-box" },
      ),
      step(
        "x2",
        "exec",
        "Run a command",
        now - 14 * MINUTE,
        "done",
        { command: "mv /var/lib/transcode-cache /var/lib/transcode-cache.old" },
        { exitCode: 0, durationMs: 400, nodeId: "media-box" },
      ),
    ];
    out[OPEN_TASK] = { ...disk, runs: [...disk.runs, run] };
  }
  return out;
}

// The page the bot's browser shows ----------------------------------------------------------

const PAGE = { width: 1280, height: 720 };

/** A frame as the plugin sends it: the 4-byte length, the JSON header, the JPEG. */
async function drawPage(tab: number, typed: string): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(PAGE.width, PAGE.height);
  const c = canvas.getContext("2d")!;
  const font = (size: number, weight = 400) => `${weight} ${size}px "Figtree Variable", sans-serif`;
  if (tab === 1) {
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, 1280, 720);
    c.fillStyle = "#1f3b2c";
    c.fillRect(0, 0, 1280, 72);
    c.fillStyle = "#ffffff";
    c.font = font(26, 600);
    c.fillText("Shelfwise", 48, 46);
    for (let i = 0; i < 3; i++) {
      c.fillStyle = "#f0f0ee";
      c.beginPath();
      c.roundRect(48, 120 + i * 170, 1184, 140, 16);
      c.fill();
      c.fillStyle = "#c9cbc6";
      c.fillRect(80, 150 + i * 170, 380 - i * 60, 22);
      c.fillStyle = "#dedfdb";
      c.fillRect(80, 190 + i * 170, 620, 14);
    }
  } else {
    c.fillStyle = "#f7f5f0";
    c.fillRect(0, 0, 1280, 720);
    c.fillStyle = "#24425f";
    c.fillRect(0, 0, 1280, 80);
    c.fillStyle = "#ffffff";
    c.font = font(28, 600);
    c.fillText("Riverbend Library", 48, 50);
    c.fillStyle = "#cfd8e3";
    c.font = font(18);
    c.fillText("Catalog   Events   Account", 900, 50);
    c.fillStyle = "#ffffff";
    c.strokeStyle = "#e1ddd3";
    c.beginPath();
    c.roundRect(440, 150, 400, 430, 18);
    c.fill();
    c.stroke();
    c.fillStyle = "#1d1f22";
    c.font = font(26, 600);
    c.fillText("Sign in to your account", 480, 210);
    c.fillStyle = "#55575b";
    c.font = font(16);
    c.fillText("Library card number", 480, 262);
    c.fillText("PIN", 480, 356);
    c.lineWidth = 2;
    c.strokeStyle = typed ? "#24425f" : "#c8c3b6";
    c.strokeRect(480, 274, 320, 48);
    c.strokeStyle = "#c8c3b6";
    c.strokeRect(480, 368, 320, 48);
    c.fillStyle = "#1d1f22";
    c.font = `18px "JetBrains Mono Variable", monospace`;
    c.fillText(typed, 496, 305);
    c.fillStyle = "#24425f";
    c.beginPath();
    c.roundRect(480, 448, 320, 52, 26);
    c.fill();
    c.fillStyle = "#ffffff";
    c.font = font(18, 600);
    c.fillText("Sign in", 606, 481);
  }
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  const header = new TextEncoder().encode(
    JSON.stringify({
      url: TABS[tab]!.url,
      cssWidth: PAGE.width,
      cssHeight: PAGE.height,
      scrollX: 0,
      scrollY: 0,
      ts: Date.now() / 1000,
    }),
  );
  const out = new Uint8Array(4 + header.length + jpeg.length);
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  out.set(jpeg, 4 + header.length);
  return out;
}

// The scripted plugin ---------------------------------------------------------------------------

type Refusal = Error & { gatewayCode: string; details: { reason: string } };
const refuse = (code: string, reason: string): Refusal =>
  Object.assign(new Error(reason.replace(/_/g, " ")), { gatewayCode: code, details: { reason } });
const forever = new Promise<never>(() => {});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GEN = (n: number) => n.toString(16).padStart(32, "0");

/**
 * The engine on the fixture's state, answered by the scripted plugin. `get`
 * and `set` are the fixture's state; `commands` answers the Computer tab's
 * bridge commands as a viewer's session would.
 */
export function computerFixture(
  params: ComputerParams,
  now: number,
  get: () => ClawtrateState,
  set: (state: ClawtrateState) => void,
) {
  const mode = params.mode;
  let typed = "";
  let takes = 0;
  let releases = 0;
  let shownTab = 0;
  let prepared = false;
  const sockets = new Set<FakeStream>();
  const generation = { current: "" };

  const engine: ComputerViews = new ComputerViews({
    request: (method, p) => answer(method, (p ?? {}) as Record<string, unknown>),
    openStream: () => {
      const socket = new FakeStream();
      sockets.add(socket);
      void socket.run();
      return socket;
    },
    gatewayUrl: () => get().connection.gatewayUrl,
    canWrite: () => get().connection.canWrite,
    online: () => get().connection.status === "connected",
    now: () => Date.now(),
    get: () => get().computer ?? { plugin: null, control: [], panes: {} },
    set: (computer: ComputerState) => set({ ...get(), computer }),
    pendingQuestion: (key) =>
      get().transcripts[key]?.questions.find((q) => q.status === "pending") ?? null,
    questionStatus: (key, id) =>
      get().transcripts[key]?.questions.find((q) => q.id === id)?.status ?? null,
    answer: async (key, id) => {
      await wait(300);
      const t = get().transcripts[key];
      if (!t) throw new Error("gone");
      set({
        ...get(),
        transcripts: {
          ...get().transcripts,
          [key]: {
            ...t,
            questions: t.questions.map((q) =>
              q.id === id
                ? { ...q, status: "answered" as const, answers: { q1: ["I'm done"] } }
                : q,
            ),
          },
        },
      });
    },
    stopTask: async () => {
      await wait(200);
    },
    log: () => {},
  });

  const event = (state: string, gen: string, reason?: string) =>
    engine.controlEvent({
      agentId: "main",
      profile: "bot-juniper",
      targetId: TABS[shownTab]!.targetId,
      holder: state === "draining" || state === "granted" ? "user" : "bot",
      state,
      generation: gen,
      ...(reason ? { reason } : {}),
    });

  async function answer(method: string, p: Record<string, unknown>): Promise<unknown> {
    await wait(120);
    switch (method) {
      case "clawtrate-computer.tabs": {
        if (mode === "unconfigured") throw refuse("UNAVAILABLE", "bot_not_configured");
        const key = String(p.sessionKey ?? "");
        if (!key.startsWith("agent:main:"))
          throw Object.assign(new Error("policy"), {
            gatewayCode: "FORBIDDEN",
            details: { code: "SESSION_RESOURCE_TOOL_POLICY" },
          });
        if (mode === "closed")
          return { agentId: "main", profile: "bot-juniper", browser: "running", tabs: [] };
        return {
          agentId: "main",
          profile: "bot-juniper",
          browser: "running",
          tabs: TABS.map((tab, i) => ({
            ...tab,
            lease:
              mode === "elsewhere" && i === 0
                ? { state: "granted", mine: false }
                : mode === "elsewhere-taking" && i === 0
                  ? { state: "draining", mine: false }
                  : generation.current && i === shownTab
                    ? { state: "granted", mine: true }
                    : null,
          })),
        };
      }
      case "clawtrate-computer.view.open": {
        shownTab = TABS.findIndex((tab) => tab.targetId === p.targetId);
        return {
          streamId: "fixture-stream",
          wsPath: "/clawtrate-computer/stream?ticket=fixture-ticket-never-shown",
          expiresAtMs: Date.now() + 60_000,
          renewWithinMs: 20_000,
          targetId: p.targetId,
        };
      }
      case "clawtrate-computer.view.renew":
        return {
          ok: true,
          renewWithinMs: 20_000,
          streamRenewed: true,
          leaseRenewed: generation.current !== "" && p.generation === generation.current,
        };
      case "clawtrate-computer.control.take": {
        if (mode === "conflict") throw refuse("UNAVAILABLE", "control_held");
        takes += 1;
        const gen = GEN(takes);
        event("draining", gen);
        if (mode === "draining") return forever;
        await wait(params.takeRace ? 1500 : 700);
        if (mode === "busy" || mode === "stuck")
          return { state: "busy", reason: "bot-still-acting", runningCalls: 1, generation: gen };
        if (mode === "unsettled")
          return { state: "busy", reason: "browser-not-quiet", runningCalls: 0, generation: gen };
        generation.current = gen;
        event("granted", gen);
        return {
          state: "granted",
          generation: gen,
          renewWithinMs: 20_000,
          targetId: p.targetId,
          guarantee: [
            "Input from the person reaches the page.",
            "New browser calls from this bot are refused while control is held.",
            "Work the bot had already started can still affect the page.",
          ],
        };
      }
      case "clawtrate-computer.control.release": {
        releases += 1;
        if (mode === "releasefail" && releases === 1) throw refuse("FORBIDDEN", "not_holder");
        if (mode === "releaseunknown" && releases === 1) return forever;
        const gen = String(p.generation);
        if (gen === generation.current) generation.current = "";
        event("released", gen);
        return { state: "released", generation: gen, targetId: p.targetId };
      }
      case "clawtrate-computer.input": {
        if (p.kind === "text") {
          typed += String(p.text);
          for (const socket of sockets) void socket.frame();
        }
        return { ok: true };
      }
      default:
        throw new Error(`${method} is not scripted`);
    }
  }

  /** The plugin's stream, as the engine's socket sees it. */
  class FakeStream implements WebSocketLike {
    readyState = 1;
    binaryType = "arraybuffer";
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    send(): void {}
    close(): void {
      this.readyState = 3;
      sockets.delete(this);
    }
    async run(): Promise<void> {
      await wait(250);
      if (this.readyState !== 1) return;
      const tab = TABS[shownTab]!;
      this.onmessage?.({
        data: JSON.stringify({
          type: "ready",
          targetId: tab.targetId,
          url: tab.url,
          title: tab.title,
        }),
      });
      await this.frame();
      if (mode === "ended" || mode === "tabclosed" || mode === "browsergone") {
        await wait(700);
        if (this.readyState !== 1) return;
        this.readyState = 3;
        sockets.delete(this);
        this.onclose?.({
          code: mode === "tabclosed" ? 4004 : mode === "browsergone" ? 1011 : 4006,
          reason: "",
        });
      }
    }
    async frame(): Promise<void> {
      const bytes = await drawPage(shownTab, typed);
      if (this.readyState === 1) this.onmessage?.({ data: bytes.buffer });
    }
  }

  engine.hello(mode === "noplugin" ? [] : ["clawtrate-computer.tabs"]);
  void now;

  return {
    engine,
    /** Machine facts the scripted gateway gives for `readMachine`; `probe` prepares its desktop. */
    machine: (key: string, probe: boolean) => {
      if (probe) prepared = true;
      const otto = key.startsWith("agent:otto:");
      return {
        setting: otto
          ? { host: "node", node: "media-box", inherited: false }
          : { host: null, node: null, inherited: true },
        nodes: otto
          ? {
              "media-box":
                mode === "nodeunknown"
                  ? ("unknown" as const)
                  : {
                      nodeId: "media-box",
                      name: "media-box",
                      connected: mode !== "offline",
                      lastSeenAtMs:
                        mode === "offline" ? Date.now() - 30 * MINUTE : Date.now() - 40_000,
                      lastSeenReason: mode === "offline" ? "while going to sleep" : null,
                      stats:
                        mode === "offline"
                          ? null
                          : {
                              cpuCount: 4,
                              loadAverage: 0.6,
                              memoryTotalBytes: 8 * 1024 ** 3,
                              memoryFreeBytes: 3.1 * 1024 ** 3,
                              diskTotalBytes: 2 * 1024 ** 4,
                              diskAvailableBytes: 780 * 1024 ** 3,
                              updatedAtMs: Date.now() - 2 * MINUTE,
                            },
                    },
            }
          : {},
        sharedWith: otto ? { "media-box": ["Pip"] } : {},
        desktop:
          mode === "desktop"
            ? { available: prepared, error: prepared ? null : "No display is attached." }
            : null,
        readAt: Date.now(),
      };
    },
  };
}
