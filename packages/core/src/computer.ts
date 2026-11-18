// The Work pane's Computer tab (docs/design/work-pane.md, Part 3): the bot's
// browser through Clawtrate's computer plugin (plugins/clawtrate-computer),
// watched and taken over by one viewer at a time.
//
// What the engine keeps, and where:
//
// - In the state (`ClawtrateState.computer`, bounded in `state-bounds.ts`):
//   whether the gateway's hello lists the plugin, the latest control event of
//   each bot's tab (every reader receives them), and each viewer's pane: the
//   task it shows, what the plugin answered for that task's bot, its tabs, its
//   view and its control, as codes and plain facts.
// - In this class only, never in the state: a view's ticket (a bearer
//   capability: whoever presents it gets the stream), its stream socket, the
//   newest frame not yet drawn, the lease's generation, input waiting to be
//   sent and an answer waiting behind a release. None of it is logged.
//
// Frames travel from the plugin's stream, which this host opens with the
// ticket, to the viewer by its own request (`frame`): the host keeps only the
// newest frame of each view and answers a viewer's request with it once it is
// newer than the one the viewer drew last. A viewer that draws slowly gets
// fewer frames; nothing queues.

import { toBase64 } from "./bytes.ts";
import type { WebSocketLike } from "./host.ts";
import { asRecord, botIdFromSessionKey, type RawRecord } from "./mapping.ts";
import type { QuestionAnswer, QuestionCard } from "./runs.ts";

// What the plugin is and what it promises (plugins/clawtrate-computer/README.md) -----------

export const COMPUTER_PREFIX = "clawtrate-computer.";
/** The method whose presence in `hello-ok.features.methods` says the plugin is loaded. */
export const COMPUTER_TABS_METHOD = "clawtrate-computer.tabs";
export const CONTROL_EVENT = "plugin.clawtrate-computer.control";
export const STREAM_PATH = "/clawtrate-computer/stream";

// Bounds ---------------------------------------------------------------------------------------

/** Viewers with a Computer tab at once; also the plugin's views per connection (8). */
export const MAX_COMPUTER_PANES = 8;
/** Tabs of one bot's browser kept for a pane; the rest are counted in `tabsOmitted`. */
export const MAX_COMPUTER_TABS = 16;
/** Latest control event per bot tab, newest kept. */
export const MAX_CONTROL_RECORDS = 32;
/** The largest frame kept for a viewer: a bigger one is dropped and counted. */
export const MAX_FRAME_BYTES = 180_000;
/** Input calls waiting to go out, one at a time; past it new input is dropped. */
export const MAX_QUEUED_INPUTS = 32;
/** Characters of one text input call (the plugin takes 1 to 2000). */
export const MAX_INPUT_TEXT = 2000;
/** How often a view and a held tab are renewed, at most (the plugin asks for well within `renewWithinMs`). */
export const RENEW_EVERY_MS = 5_000;
/** A release with no answer within this is "not confirmed". */
export const RELEASE_DEADLINE_MS = 10_000;
/** A renewal or a check with no answer within this changes nothing. */
export const RENEW_DEADLINE_MS = 5_000;
/** A viewer's frame request waits at most this long, then answers with no frame. */
export const FRAME_WAIT_MS = 15_000;
/** Busy refusals for the same reason in a row before the tab offers to stop the task. */
export const STUCK_AFTER = 3;
/** Strings the pane keeps: titles, addresses, refusals. */
export const MAX_COMPUTER_TEXT = 1024;

// The state ------------------------------------------------------------------------------------

export type ComputerLease = {
  state: "draining" | "granted";
  /** Who holds it as this viewer can tell: this viewer, another window of this app, or another device. */
  holder: "this-viewer" | "this-device" | "elsewhere";
};

export type ComputerTab = {
  targetId: string;
  url: string;
  title: string;
  lease: ComputerLease | null;
};

/**
 * What the plugin answered for the task's bot: `ready` when it listed the
 * bot's browser; `absent` when the hello lists no plugin; `not-configured`
 * (`UNAVAILABLE bot_not_configured`); `not-allowed` (`FORBIDDEN
 * SESSION_RESOURCE_TOOL_POLICY`: the task's policy denies the browser);
 * `read-only` when this connection cannot send, so nothing is asked;
 * `error` for any other refusal, with its reason.
 */
export type ComputerAvailability =
  | "unknown"
  | "checking"
  | "ready"
  | "absent"
  | "not-configured"
  | "not-allowed"
  | "read-only"
  | "error";

export type ViewEnd =
  "stopped" | "tab-closed" | "browser-gone" | "gateway-ended" | "dropped" | "failed";

export type ComputerView = {
  /** This view's number on this device: every answer for it is matched to it. */
  n: number;
  targetId: string;
  status: "connecting" | "live" | "ended";
  end: ViewEnd | null;
  error: string | null;
  /** The page's address and title, from the stream's `ready` and `meta` and the tab list. */
  url: string | null;
  title: string | null;
  /** The newest frame's number; 0 before the first. */
  frame: number;
  /** The page's own size in CSS pixels, from the newest frame's header. */
  width: number | null;
  height: number | null;
  /** Frames dropped for being larger than `MAX_FRAME_BYTES`. */
  framesTooLarge: number;
};

export type BusyReason =
  "bot-still-acting" | "browser-not-quiet" | "download-in-progress" | "browser-not-watched";

/** Why a question closed while an answer or the person's control waited on it. */
export type ClosedCode = "answered" | "dismissed" | "cancelled" | "expired" | "run-ended";

export type ComputerOutcome =
  | "answered"
  | "answer-failed"
  | "already-answered"
  | "already-dismissed"
  | "already-cancelled"
  | "already-expired"
  | "answer-not-sent"
  | "dropped-answered"
  | "dropped-dismissed"
  | "dropped-cancelled"
  | "dropped-expired"
  | "dropped-run-ended";

export type ControlStatus =
  /** Nothing asked or held. */
  | "none"
  /** A take is waiting for the bot's call and the tab to be quiet. */
  | "draining"
  /** The gateway granted control, and each renewal confirms it. */
  | "granted"
  /** Refused: the bot is still acting (at the drain deadline). */
  | "busy"
  /** Refused: something the bot started has not settled. */
  | "unsettled"
  /** Refused: someone has, or is taking, control of the tab. */
  | "conflict"
  /** A control event for this lease, or a renewal, says it ended. */
  | "ended"
  /** `control.release` is on its way: input has stopped. */
  | "releasing"
  /** The release was refused or not answered: ownership is not confirmed. */
  | "unconfirmed"
  /** The connection dropped while control was held or being given back. */
  | "maybe-held"
  /** Reconnected after that: the question and the browser's leases are being read again. */
  | "checking"
  /** The release was confirmed and the queued answer is on its way. */
  | "answering";

export type ComputerControl = {
  status: ControlStatus;
  /** The task and tab the control is about; it can outlive the pane's task (`outOfSight`). */
  key: string | null;
  botId: string | null;
  targetId: string | null;
  endCause: "expired" | "revoked" | null;
  busyReason: BusyReason | null;
  /** Busy refusals for `busyReason` in a row. */
  busyCount: number;
  renewWithinMs: number | null;
  /** The viewer left while ownership was not confirmed: renewals have stopped. */
  outOfSight: boolean;
  /** A check found the lease renewed: "You still have control." */
  stillHeld: boolean;
  /** How the answer that followed the release ended, or why it was not sent. */
  outcome: ComputerOutcome | null;
  /** The question closed while the person held control. */
  questionGone: ClosedCode | null;
  /** An answer waits behind the release. */
  answerQueued: boolean;
  /** Control was given back, confirmed, with no answer behind it: a pending question still waits. */
  released: boolean;
  /** A refusal the plugin gave that has no sentence of its own, with its reason. */
  refusal: string | null;
};

export type ComputerPane = {
  viewer: string;
  key: string;
  botId: string;
  availability: ComputerAvailability;
  /** The plugin's refusal, for `error`. */
  error: string | null;
  browser: "running" | "not-running" | null;
  tabs: ComputerTab[];
  tabsOmitted: number;
  /** When the tab list was read. */
  checkedAt: number | null;
  /** The tab shown in the tile. */
  shown: string | null;
  view: ComputerView | null;
  control: ComputerControl;
  /** "Stop <Bot> in this task" stopped its runs. */
  stopped: boolean;
};

export type ControlRecord = {
  agentId: string;
  profile: string;
  targetId: string;
  holder: "user" | "bot";
  state: string;
  generation: string;
  reason: string | null;
  at: number;
};

export type ComputerState = {
  /** Whether the hello lists the plugin's methods; null before a hello. */
  plugin: boolean | null;
  /** The latest control event of each bot's tab, newest last. */
  control: ControlRecord[];
  /** Each viewer's pane, by viewer id; a viewer's snapshot carries only its own. */
  panes: Record<string, ComputerPane>;
};

export const initialComputerState: ComputerState = { plugin: null, control: [], panes: {} };

const noControl: ComputerControl = {
  status: "none",
  key: null,
  botId: null,
  targetId: null,
  endCause: null,
  busyReason: null,
  busyCount: 0,
  renewWithinMs: null,
  outOfSight: false,
  stillHeld: false,
  outcome: null,
  questionGone: null,
  answerQueued: false,
  released: false,
  refusal: null,
};

// Reading the plugin's answers ------------------------------------------------------------------

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const cut = (value: string) =>
  value.length > MAX_COMPUTER_TEXT ? value.slice(0, MAX_COMPUTER_TEXT - 1) + "…" : value;
const GENERATION = /^[0-9a-f]{32}$/;
const TARGET = /^[A-Za-z0-9._-]{1,128}$/;

/** The gateway's code and the plugin's reason of a refused call. */
export function refusal(error: unknown): {
  code: string | null;
  reason: string | null;
  message: string;
} {
  const record = asRecord(error);
  const details = asRecord(record?.details);
  return {
    code: str(record?.gatewayCode) ?? str(record?.code),
    reason: str(details?.reason) ?? str(details?.code),
    message: cut(error instanceof Error ? error.message : (str(record?.message) ?? String(error))),
  };
}

/** The plugin's control event, or null for anything else. */
export function parseControlEvent(payload: unknown, at: number): ControlRecord | null {
  const p = asRecord(payload);
  const agentId = str(p?.agentId);
  const targetId = str(p?.targetId);
  const state = str(p?.state);
  const generation = str(p?.generation);
  if (!p || !agentId || !targetId || !TARGET.test(targetId) || !state || !generation) return null;
  if (!GENERATION.test(generation)) return null;
  return {
    agentId: cut(agentId),
    profile: cut(str(p.profile) ?? ""),
    targetId,
    holder: p.holder === "bot" ? "bot" : "user",
    state: cut(state),
    generation,
    reason: str(p.reason) ? cut(str(p.reason)!) : null,
    at,
  };
}

/** A stream frame: the 4-byte length, the JSON header, the JPEG. */
export function parseFrame(data: Uint8Array): {
  header: { url: string | null; cssWidth: number; cssHeight: number };
  jpeg: Uint8Array;
} | null {
  if (data.byteLength < 6) return null;
  const length = ((data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!) >>> 0;
  if (length === 0 || 4 + length >= data.byteLength) return null;
  let header: RawRecord | null;
  try {
    header = asRecord(JSON.parse(utf8Decode(data.subarray(4, 4 + length))));
  } catch {
    return null;
  }
  const width = header?.cssWidth;
  const height = header?.cssHeight;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0)
    return null;
  const jpeg = data.subarray(4 + length);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  return { header: { url: str(header?.url), cssWidth: width, cssHeight: height }, jpeg };
}

function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const a = bytes[i++]!;
    let code = a;
    if (a >= 0xf0)
      code =
        ((a & 7) << 18) |
        ((bytes[i++]! & 63) << 12) |
        ((bytes[i++]! & 63) << 6) |
        (bytes[i++]! & 63);
    else if (a >= 0xe0) code = ((a & 15) << 12) | ((bytes[i++]! & 63) << 6) | (bytes[i++]! & 63);
    else if (a >= 0xc0) code = ((a & 31) << 6) | (bytes[i++]! & 63);
    out += String.fromCodePoint(code);
  }
  return out;
}

/** Binary stream data as bytes, whatever the socket gives. */
function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * The stream's address: the gateway's own origin and the plugin's path,
 * nothing else. A path that would leave the gateway's origin is refused, so
 * the ticket goes nowhere but the gateway that issued it.
 */
export function streamUrl(gatewayUrl: string, wsPath: string): string | null {
  if (!wsPath.startsWith(`${STREAM_PATH}?ticket=`) || wsPath.includes("#")) return null;
  const base = new URL(gatewayUrl);
  if (base.protocol !== "ws:" && base.protocol !== "wss:") return null;
  const url = new URL(wsPath, gatewayUrl);
  return url.host === base.host && url.protocol === base.protocol ? url.toString() : null;
}

/** Whether a question can be answered from the control bar: one question, one answer, two to four options. */
export function barAnswerable(question: QuestionCard | null): boolean {
  if (!question || question.status !== "pending" || !question.ordinary) return false;
  if (question.questions.length !== 1) return false;
  const item = question.questions[0]!;
  return (
    !item.multiSelect &&
    item.optionsOmitted === 0 &&
    item.options.length >= 2 &&
    item.options.length <= 4
  );
}

// The engine ----------------------------------------------------------------------------------

export type ComputerContext = {
  request(method: string, params: unknown): Promise<unknown>;
  /** A socket to the gateway's stream: binary frames as bytes. */
  openStream(url: string): WebSocketLike;
  gatewayUrl(): string | null;
  /** The connection is up and holds `operator.write`. */
  canWrite(): boolean;
  online(): boolean;
  now(): number;
  get(): ComputerState;
  set(next: ComputerState): void;
  /** The open task's pending question, if any. */
  pendingQuestion(key: string): QuestionCard | null;
  /** How a question of the task ended, if it did. */
  questionStatus(key: string, questionId: string): QuestionCard["status"] | null;
  answer(key: string, questionId: string, answers: Record<string, QuestionAnswer[]>): Promise<void>;
  stopTask(key: string): Promise<void>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
};

type Timer = ReturnType<typeof setTimeout>;
type Input =
  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number | null; y: number | null; deltaX: number; deltaY: number }
  | { kind: "text"; text: string };

/** A view as the host keeps it: its ticket, its socket and its newest frame stay here. */
type LiveView = {
  n: number;
  targetId: string;
  streamId: string | null;
  /** The bearer ticket, from `view.open` until the stream opens with it; never in the state. */
  ticket: string | null;
  socket: WebSocketLike | null;
  latest: { seq: number; width: number; height: number; jpeg: Uint8Array } | null;
  waiter: { after: number; resolve: (frame: ComputerFrame | null) => void; timer: Timer } | null;
  ended: boolean;
};

/** A lease this viewer holds or is giving back; its generation stays here. */
type LiveLease = {
  key: string;
  botId: string;
  targetId: string;
  generation: string;
  renewWithinMs: number;
  /** The hand-back's number: a lost connection retires it as a whole. */
  sequence: number;
  inputs: Input[];
  sending: boolean;
  answer: { questionId: string; itemId: string; option: number } | null;
};

type LiveTake = {
  n: number;
  key: string;
  botId: string;
  targetId: string;
  /** From the `draining` event: what a withdrawal releases. */
  generation: string | null;
  abandoned: boolean;
};

type Live = {
  viewer: string;
  view: LiveView | null;
  lease: LiveLease | null;
  take: LiveTake | null;
  renewTimer: Timer | null;
  /** The tab list read this pane asked for last; an older answer changes nothing. */
  tabsAsked: number;
};

export type ComputerFrame = { n: number; seq: number; width: number; height: number; jpeg: string };

/** The engine of every viewer's Computer tab. One per client. */
export class ComputerViews {
  /** Each viewer's live part, by viewer id (`MAX_COMPUTER_PANES`). */
  private readonly lives = new Map<string, Live>();
  private nextView = 0;
  private nextTake = 0;
  private nextSequence = 0;
  private nextViewer = 0;
  private readonly ctx: ComputerContext;

  constructor(ctx: ComputerContext) {
    this.ctx = ctx;
  }

  /** A new viewer id, for a bridge session. */
  newViewer(): string {
    this.nextViewer += 1;
    return `v${this.nextViewer}`;
  }

  // The shared part ---------------------------------------------------------------------------

  private write(change: (state: ComputerState) => ComputerState): void {
    this.ctx.set(change(this.ctx.get()));
  }

  private pane(viewer: string): ComputerPane | null {
    return this.ctx.get().panes[viewer] ?? null;
  }

  private patch(viewer: string, change: (pane: ComputerPane) => ComputerPane): void {
    this.write((state) => {
      const pane = state.panes[viewer];
      return pane ? { ...state, panes: { ...state.panes, [viewer]: change(pane) } } : state;
    });
  }

  private patchControl(viewer: string, change: Partial<ComputerControl>): void {
    this.patch(viewer, (pane) => ({ ...pane, control: { ...pane.control, ...change } }));
  }

  private patchView(viewer: string, n: number, change: Partial<ComputerView>): void {
    this.patch(viewer, (pane) =>
      pane.view && pane.view.n === n ? { ...pane, view: { ...pane.view, ...change } } : pane,
    );
  }

  /** The hello's methods: whether the plugin is loaded on this gateway. */
  hello(methods: readonly string[] | null): void {
    const plugin = methods === null ? null : methods.includes(COMPUTER_TABS_METHOD);
    this.write((state) => ({ ...state, plugin }));
    for (const live of this.lives.values()) void this.readTabs(live.viewer);
  }

  /** A control event, which every reader receives. */
  controlEvent(payload: unknown): void {
    const record = parseControlEvent(payload, this.ctx.now());
    if (!record) return;
    this.write((state) => {
      const rest = state.control.filter(
        (each) => !(each.agentId === record.agentId && each.targetId === record.targetId),
      );
      return { ...state, control: [...rest, record].slice(-MAX_CONTROL_RECORDS) };
    });
    for (const live of this.lives.values()) this.applyControl(live, record);
  }

  private applyControl(live: Live, record: ControlRecord): void {
    const pane = this.pane(live.viewer);
    if (!pane) return;
    const take = live.take;
    if (
      take &&
      take.generation === null &&
      record.state === "draining" &&
      record.agentId === take.botId &&
      record.targetId === take.targetId
    ) {
      take.generation = record.generation;
      if (take.abandoned) this.withdraw(take);
    }
    const lease = live.lease;
    if (lease && record.generation === lease.generation) {
      if (record.state === "released") {
        // A released event with this lease's generation confirms the hand-back.
        if (pane.control.status === "releasing" || pane.control.status === "unconfirmed")
          this.confirmed(live, lease.sequence);
        else if (pane.control.status !== "answering") this.leaseEnded(live, null);
      } else if (
        record.state === "expired" ||
        record.state === "revoked" ||
        record.state === "tab-closed"
      ) {
        this.leaseEnded(
          live,
          record.state === "expired" ? "expired" : record.state === "revoked" ? "revoked" : null,
        );
      }
    }
    // Tabs' leases change with every event: the pane's tab list follows.
    if (pane.botId === record.agentId) void this.readTabs(live.viewer);
  }

  // A viewer's pane ----------------------------------------------------------------------------

  /** The viewer shows the Computer tab for a task. Leaving another task first gives control back. */
  show(viewer: string, key: string): void {
    const botId = botIdFromSessionKey(key);
    if (!botId) throw new Error("This task's bot is not known.");
    const current = this.pane(viewer);
    if (current && current.key === key) {
      void this.readTabs(viewer);
      return;
    }
    if (!this.lives.has(viewer) && this.lives.size >= MAX_COMPUTER_PANES)
      throw new Error(`At most ${MAX_COMPUTER_PANES} views can show a computer at once.`);
    if (current) this.leave(viewer);
    const live = this.lives.get(viewer) ?? {
      viewer,
      view: null,
      lease: null,
      take: null,
      renewTimer: null,
      tabsAsked: 0,
    };
    this.lives.set(viewer, live);
    const kept = current?.control.outOfSight ? current.control : noControl;
    this.write((state) => ({
      ...state,
      panes: {
        ...state.panes,
        [viewer]: {
          viewer,
          key,
          botId,
          availability: "unknown",
          error: null,
          browser: null,
          tabs: [],
          tabsOmitted: 0,
          checkedAt: null,
          shown: null,
          view: null,
          control: kept,
          stopped: false,
        },
      },
    }));
    void this.readTabs(viewer);
  }

  /**
   * The viewer left the Computer tab, closed the pane, switched task or bot,
   * or its window was hidden: control is given back first, a waiting take is
   * withdrawn, and the view ends at once. A hand-back that is not confirmed
   * stays on the tab (`outOfSight`).
   */
  leave(viewer: string): void {
    const live = this.lives.get(viewer);
    if (!live) return;
    this.abandonTake(live);
    const pane = this.pane(viewer);
    if (live.lease && pane?.control.status === "granted") this.release(viewer, { leaving: true });
    else if (
      live.lease &&
      (pane?.control.status === "releasing" || pane?.control.status === "unconfirmed")
    )
      this.patchControl(viewer, { outOfSight: true });
    this.endView(live, "stopped", null);
    this.reschedule(live);
  }

  /** The viewer went away: everything it held goes, control given back as on leaving. */
  dispose(viewer: string): void {
    const live = this.lives.get(viewer);
    if (!live) return;
    this.leave(viewer);
    if (live.renewTimer) clearTimeout(live.renewTimer);
    live.renewTimer = null;
    this.lives.delete(viewer);
    this.write((state) => {
      const panes = { ...state.panes };
      delete panes[viewer];
      return { ...state, panes };
    });
  }

  /** Read the bot's tabs again (`clawtrate-computer.tabs`). */
  async readTabs(viewer: string): Promise<void> {
    const live = this.lives.get(viewer);
    const pane = this.pane(viewer);
    if (!live || !pane) return;
    const state = this.ctx.get();
    if (state.plugin === false) {
      this.patch(viewer, (p) => ({ ...p, availability: "absent" }));
      return;
    }
    if (!this.ctx.online()) return;
    if (!this.ctx.canWrite()) {
      // A read-only connection asks for none of the plugin's methods.
      this.patch(viewer, (p) => ({ ...p, availability: "read-only", tabs: [], shown: null }));
      return;
    }
    if (state.plugin === null) return;
    const asked = ++live.tabsAsked;
    const key = pane.key;
    if (pane.availability === "unknown")
      this.patch(viewer, (p) => ({ ...p, availability: "checking" }));
    let answer: RawRecord | null;
    try {
      answer = asRecord(await this.ctx.request("clawtrate-computer.tabs", { sessionKey: key }));
    } catch (error) {
      if (asked !== live.tabsAsked || this.pane(viewer)?.key !== key) return;
      const why = refusal(error);
      const availability: ComputerAvailability =
        why.code === "UNAVAILABLE" && why.reason === "bot_not_configured"
          ? "not-configured"
          : why.code === "FORBIDDEN" && why.reason === "SESSION_RESOURCE_TOOL_POLICY"
            ? "not-allowed"
            : why.reason === "MISSING_SCOPE"
              ? "read-only"
              : "error";
      this.patch(viewer, (p) => ({
        ...p,
        availability,
        error: availability === "error" ? why.message : null,
        checkedAt: this.ctx.now(),
      }));
      return;
    }
    if (asked !== live.tabsAsked || this.pane(viewer)?.key !== key) return;
    const raw = Array.isArray(answer?.tabs) ? answer.tabs : [];
    const tabs: ComputerTab[] = [];
    for (const each of raw) {
      const t = asRecord(each);
      const targetId = str(t?.targetId);
      if (!t || !targetId || !TARGET.test(targetId)) continue;
      const lease = asRecord(t.lease);
      tabs.push({
        targetId,
        url: cut(str(t.url) ?? ""),
        title: cut(str(t.title) ?? ""),
        lease:
          lease && (lease.state === "draining" || lease.state === "granted")
            ? {
                state: lease.state,
                holder:
                  lease.mine !== true
                    ? "elsewhere"
                    : live.lease?.targetId === targetId || live.take?.targetId === targetId
                      ? "this-viewer"
                      : "this-device",
              }
            : null,
      });
    }
    const kept = tabs.slice(0, MAX_COMPUTER_TABS);
    this.patch(viewer, (p) => {
      const shown =
        p.shown && kept.some((tab) => tab.targetId === p.shown)
          ? p.shown
          : (kept.find((tab) => !tab.url.startsWith("chrome://"))?.targetId ??
            kept[0]?.targetId ??
            null);
      const view = p.view;
      const tab = view ? kept.find((each) => each.targetId === view.targetId) : undefined;
      return {
        ...p,
        availability: "ready",
        error: null,
        browser: answer?.browser === "running" ? "running" : "not-running",
        tabs: kept,
        tabsOmitted: tabs.length - kept.length,
        checkedAt: this.ctx.now(),
        shown,
        view: view && tab ? { ...view, title: tab.title || view.title } : view,
      };
    });
    this.afterTabs(live);
  }

  /** After a reconnect, leases are read before anything is offered again. */
  private afterTabs(live: Live): void {
    const pane = this.pane(live.viewer);
    // Read while connected: what the list says of the old lease settles a drop's "maybe held".
    if (!pane || (pane.control.status !== "checking" && pane.control.status !== "maybe-held"))
      return;
    const tab = pane.tabs.find((each) => each.targetId === pane.control.targetId);
    // A new connection never holds the old one's lease: none listed means it ended.
    if (!tab?.lease) {
      live.lease = null;
      this.patchControl(live.viewer, { ...noControl, status: "ended" });
    } else this.patchControl(live.viewer, { status: "maybe-held" });
  }

  /** Show another tab of the bot's browser in the tile: the view of the old one ends first. */
  choose(viewer: string, targetId: string): void {
    const pane = this.pane(viewer);
    if (!pane || !pane.tabs.some((tab) => tab.targetId === targetId)) return;
    const watching = pane.view && pane.view.status !== "ended";
    if (pane.view && pane.view.targetId !== targetId) this.leave(viewer);
    this.patch(viewer, (p) => ({ ...p, shown: targetId }));
    if (watching) void this.watch(viewer);
  }

  // Watching ----------------------------------------------------------------------------------

  /** Watch: a new view with its own number. */
  async watch(viewer: string): Promise<void> {
    const live = this.lives.get(viewer);
    const pane = this.pane(viewer);
    if (!live || !pane || pane.availability !== "ready" || !pane.shown) return;
    if (!this.ctx.canWrite()) return;
    if (live.view && !live.view.ended && live.view.targetId === pane.shown) return;
    this.endView(live, "stopped", null);
    const n = ++this.nextView;
    const view: LiveView = {
      n,
      targetId: pane.shown,
      streamId: null,
      ticket: null,
      socket: null,
      latest: null,
      waiter: null,
      ended: false,
    };
    live.view = view;
    const tab = pane.tabs.find((each) => each.targetId === view.targetId);
    this.patch(viewer, (p) => ({
      ...p,
      view: {
        n,
        targetId: view.targetId,
        status: "connecting",
        end: null,
        error: null,
        url: tab?.url ?? null,
        title: tab?.title ?? null,
        frame: 0,
        width: null,
        height: null,
        framesTooLarge: 0,
      },
    }));
    let answer: RawRecord | null;
    try {
      answer = asRecord(
        await this.ctx.request("clawtrate-computer.view.open", {
          sessionKey: pane.key,
          targetId: view.targetId,
        }),
      );
    } catch (error) {
      if (live.view !== view || view.ended) return;
      const why = refusal(error);
      this.endView(
        live,
        why.reason === "tab_not_in_bots_browser" ? "tab-closed" : "failed",
        why.reason === "tab_not_in_bots_browser" ? null : why.message,
      );
      if (why.reason === "tab_not_in_bots_browser") void this.readTabs(viewer);
      return;
    }
    const wsPath = str(answer?.wsPath);
    const streamId = str(answer?.streamId);
    // An answer for a view that has ended is disposed of: its ticket is never used.
    if (live.view !== view || view.ended) return;
    const gateway = this.ctx.gatewayUrl();
    const url = wsPath && gateway ? streamUrl(gateway, wsPath) : null;
    if (!url || !streamId) {
      this.endView(live, "failed", "The plugin's answer gave no stream on this gateway.");
      return;
    }
    view.streamId = streamId;
    view.ticket = wsPath!.slice(wsPath!.indexOf("=") + 1);
    const renew = Number(answer?.renewWithinMs);
    this.openSocket(live, view, url);
    this.reschedule(live, Number.isFinite(renew) && renew > 0 ? renew : undefined);
  }

  private openSocket(live: Live, view: LiveView, url: string): void {
    let socket: WebSocketLike;
    try {
      socket = this.ctx.openStream(url);
    } catch {
      this.endView(live, "failed", "The stream could not be opened.");
      return;
    }
    view.socket = socket;
    // The ticket opens one stream once: it is dropped as soon as it has been presented.
    view.ticket = null;
    socket.onmessage = (event) => {
      if (live.view !== view || view.ended) return;
      const data = event.data;
      if (typeof data === "string") {
        let message: RawRecord | null;
        try {
          message = asRecord(JSON.parse(data));
        } catch {
          return;
        }
        if (message?.type === "ready" || message?.type === "meta") {
          const url = str(message.url);
          const title = str(message.title);
          this.patchView(live.viewer, view.n, {
            ...(url !== null ? { url: cut(url) } : {}),
            ...(title !== null ? { title: cut(title) } : {}),
          });
          // `meta` carries the address only: the title comes from the tab list.
          if (message.type === "meta") void this.readTabs(live.viewer);
        }
        return;
      }
      const bytes = bytesOf(data);
      const frame = bytes ? parseFrame(bytes) : null;
      if (!frame) return;
      const pane = this.pane(live.viewer);
      const current = pane?.view?.n === view.n ? pane.view : null;
      if (!current) return;
      if (frame.jpeg.byteLength > MAX_FRAME_BYTES) {
        this.patchView(live.viewer, view.n, { framesTooLarge: current.framesTooLarge + 1 });
        return;
      }
      const seq = current.frame + 1;
      // Only the newest frame is kept; one not yet drawn gives way to it.
      view.latest = {
        seq,
        width: frame.header.cssWidth,
        height: frame.header.cssHeight,
        jpeg: frame.jpeg.slice(),
      };
      this.patchView(live.viewer, view.n, {
        status: "live",
        frame: seq,
        width: frame.header.cssWidth,
        height: frame.header.cssHeight,
        ...(frame.header.url ? { url: cut(frame.header.url) } : {}),
      });
      this.giveFrame(view);
    };
    socket.onclose = (event) => {
      if (live.view !== view || view.ended) return;
      const end: ViewEnd =
        event.code === 4004 ? "tab-closed" : event.code === 1011 ? "browser-gone" : "gateway-ended";
      this.endView(live, end, null);
      if (end === "tab-closed") void this.readTabs(live.viewer);
    };
    socket.onerror = () => {};
  }

  /** Stop watching: the view ends, and nothing of the picture remains. */
  stopWatching(viewer: string): void {
    const live = this.lives.get(viewer);
    if (!live) return;
    const pane = this.pane(viewer);
    if (pane?.control.status === "draining") this.abandonTake(live);
    if (live.lease && pane?.control.status === "granted") this.release(viewer, { leaving: true });
    this.endView(live, "stopped", null);
    this.reschedule(live);
  }

  private endView(live: Live, end: ViewEnd, error: string | null): void {
    const view = live.view;
    if (!view || view.ended) return;
    view.ended = true;
    view.ticket = null;
    view.latest = null;
    if (view.waiter) {
      clearTimeout(view.waiter.timer);
      view.waiter.resolve(null);
      view.waiter = null;
    }
    if (view.socket) {
      const socket = view.socket;
      view.socket = null;
      socket.onmessage = null;
      socket.onclose = null;
      try {
        socket.close(1000);
      } catch {
        // Already closed.
      }
    }
    this.patch(live.viewer, (p) =>
      p.view && p.view.n === view.n
        ? end === "stopped"
          ? { ...p, view: null }
          : { ...p, view: { ...p.view, status: "ended", end, error, frame: 0 } }
        : p,
    );
  }

  /**
   * The newest frame of a view, once newer than `after`; null when the view
   * has ended, is not this viewer's, or nothing newer came within `FRAME_WAIT_MS`.
   */
  frame(viewer: string, n: number, after: number): Promise<ComputerFrame | null> {
    const view = this.lives.get(viewer)?.view;
    if (!view || view.n !== n || view.ended) return Promise.resolve(null);
    if (view.latest && view.latest.seq > after) return Promise.resolve(this.frameOf(view));
    if (view.waiter) {
      clearTimeout(view.waiter.timer);
      view.waiter.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (view.waiter?.resolve === resolve) view.waiter = null;
        resolve(null);
      }, FRAME_WAIT_MS);
      view.waiter = { after, resolve, timer };
    });
  }

  private frameOf(view: LiveView): ComputerFrame | null {
    const latest = view.latest;
    if (!latest) return null;
    // Handed over once: the host keeps no frame that has been drawn.
    view.latest = null;
    return {
      n: view.n,
      seq: latest.seq,
      width: latest.width,
      height: latest.height,
      jpeg: toBase64(latest.jpeg),
    };
  }

  private giveFrame(view: LiveView): void {
    const waiter = view.waiter;
    if (!waiter || !view.latest || view.latest.seq <= waiter.after) return;
    view.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(this.frameOf(view));
  }

  // Renewing ----------------------------------------------------------------------------------

  /** One timer per viewer renews its view and its lease together, while either is held. */
  private reschedule(live: Live, renewWithinMs?: number): void {
    if (live.renewTimer) clearTimeout(live.renewTimer);
    live.renewTimer = null;
    const pane = this.pane(live.viewer);
    const viewing = live.view && !live.view.ended && live.view.streamId;
    const holding = live.lease && pane?.control.status === "granted";
    if (!viewing && !holding) return;
    const within =
      renewWithinMs ?? live.lease?.renewWithinMs ?? pane?.control.renewWithinMs ?? 20_000;
    const every = Math.max(1000, Math.min(RENEW_EVERY_MS, Math.floor(within / 4)));
    live.renewTimer = setTimeout(() => void this.renew(live), every);
  }

  private async renew(live: Live): Promise<void> {
    live.renewTimer = null;
    const pane = this.pane(live.viewer);
    if (!pane || !this.ctx.online()) return;
    const view = live.view && !live.view.ended && live.view.streamId ? live.view : null;
    const lease = live.lease && pane.control.status === "granted" ? live.lease : null;
    if (!view && !lease) return;
    const targetId = lease?.targetId ?? view!.targetId;
    const key = lease?.key ?? pane.key;
    const useView = view && view.targetId === targetId ? view : null;
    try {
      const answer = asRecord(
        await deadline(
          this.ctx.request("clawtrate-computer.view.renew", {
            sessionKey: key,
            targetId,
            ...(useView ? { streamId: useView.streamId } : {}),
            ...(lease ? { generation: lease.generation } : {}),
          }),
          RENEW_DEADLINE_MS,
        ),
      );
      if (useView && live.view === useView && !useView.ended && answer?.streamRenewed !== true)
        this.endView(live, "gateway-ended", null);
      // "You have control" holds only while each renewal confirms the lease.
      if (
        lease &&
        live.lease === lease &&
        this.pane(live.viewer)?.control.status === "granted" &&
        answer?.leaseRenewed !== true
      )
        this.leaseEnded(live, null);
    } catch (error) {
      const why = refusal(error);
      if (why.reason === "tab_not_in_bots_browser") {
        if (useView && live.view === useView) this.endView(live, "tab-closed", null);
        if (lease && live.lease === lease) this.leaseEnded(live, null);
        void this.readTabs(live.viewer);
      }
    }
    this.reschedule(live);
  }

  // Taking control ----------------------------------------------------------------------------

  /** Take control of the shown tab; the view opens first if it was not open. */
  async take(viewer: string): Promise<void> {
    const live = this.lives.get(viewer);
    const pane = this.pane(viewer);
    if (!live || !pane || !pane.shown || !this.ctx.canWrite()) return;
    if (live.lease || live.take) return;
    if (!live.view || live.view.ended) void this.watch(viewer);
    const n = ++this.nextTake;
    const take: LiveTake = {
      n,
      key: pane.key,
      botId: pane.botId,
      targetId: pane.shown,
      generation: null,
      abandoned: false,
    };
    live.take = take;
    const before = pane.control;
    this.patchControl(viewer, {
      ...noControl,
      status: "draining",
      key: pane.key,
      botId: pane.botId,
      targetId: pane.shown,
      busyReason: before.busyReason,
      busyCount: before.busyCount,
    });
    let answer: RawRecord | null;
    try {
      answer = asRecord(
        await this.ctx.request("clawtrate-computer.control.take", {
          sessionKey: take.key,
          targetId: take.targetId,
        }),
      );
    } catch (error) {
      if (live.take === take) live.take = null;
      if (take.abandoned || this.pane(viewer)?.control.status !== "draining") return;
      const why = refusal(error);
      if (why.reason === "control_held") this.patchControl(viewer, { status: "conflict" });
      else if (why.reason === "control_request_ended")
        this.patchControl(viewer, { status: "none" });
      else if (why.reason === "tab_not_in_bots_browser") {
        this.patchControl(viewer, { status: "none" });
        if (live.view) this.endView(live, "tab-closed", null);
        void this.readTabs(viewer);
      } else this.patchControl(viewer, { status: "none", refusal: why.message });
      return;
    }
    if (live.take === take) live.take = null;
    const generation = str(answer?.generation);
    if (answer?.state === "granted" && generation && GENERATION.test(generation)) {
      const renewWithinMs = Number(answer.renewWithinMs);
      if (take.abandoned || this.pane(viewer)?.control.status !== "draining") {
        // The grant won the race against a withdrawal: given back at once, no input, nothing shown.
        void this.ctx
          .request("clawtrate-computer.control.release", {
            sessionKey: take.key,
            targetId: take.targetId,
            generation,
          })
          .catch(() => {});
        return;
      }
      live.lease = {
        key: take.key,
        botId: take.botId,
        targetId: take.targetId,
        generation,
        renewWithinMs: Number.isFinite(renewWithinMs) && renewWithinMs > 0 ? renewWithinMs : 20_000,
        sequence: 0,
        inputs: [],
        sending: false,
        answer: null,
      };
      this.patchControl(viewer, {
        status: "granted",
        busyReason: null,
        busyCount: 0,
        renewWithinMs: live.lease.renewWithinMs,
      });
      this.reschedule(live);
      void this.readTabs(viewer);
      return;
    }
    if (take.abandoned || this.pane(viewer)?.control.status !== "draining") return;
    const reason = str(answer?.reason) as BusyReason | null;
    const known: BusyReason =
      reason === "browser-not-quiet" ||
      reason === "download-in-progress" ||
      reason === "browser-not-watched"
        ? reason
        : "bot-still-acting";
    const previous = this.pane(viewer)?.control;
    const count = previous?.busyReason === known ? previous.busyCount + 1 : 1;
    this.patchControl(viewer, {
      status: known === "bot-still-acting" ? "busy" : "unsettled",
      busyReason: known,
      busyCount: count,
    });
  }

  /** Cancel a waiting take: withdrawn with the `draining` generation. */
  cancelTake(viewer: string): void {
    const live = this.lives.get(viewer);
    if (!live) return;
    this.abandonTake(live);
  }

  private abandonTake(live: Live): void {
    const take = live.take;
    if (!take || take.abandoned) return;
    take.abandoned = true;
    if (this.pane(live.viewer)?.control.status === "draining")
      this.patchControl(live.viewer, { status: "none" });
    this.withdraw(take);
  }

  private withdraw(take: LiveTake): void {
    if (!take.generation) return;
    void this.ctx
      .request("clawtrate-computer.control.release", {
        sessionKey: take.key,
        targetId: take.targetId,
        generation: take.generation,
      })
      .catch(() => {});
  }

  // Input --------------------------------------------------------------------------------------

  /**
   * Input from the person, for the held tab only, while this viewer holds the
   * lease. Sent one call at a time, in order; dropped, never sent, once
   * control is being given back or is not confirmed. Nothing of it is logged.
   */
  input(viewer: string, input: Input): boolean {
    const live = this.lives.get(viewer);
    const pane = this.pane(viewer);
    const lease = live?.lease;
    if (!live || !lease || pane?.control.status !== "granted") return false;
    const last = lease.inputs.at(-1);
    if (
      input.kind === "text" &&
      last?.kind === "text" &&
      last.text.length + input.text.length <= MAX_INPUT_TEXT
    ) {
      last.text += input.text;
    } else {
      if (lease.inputs.length >= MAX_QUEUED_INPUTS) return false;
      // A copy: text typed next is added to it, never to the caller's own object.
      lease.inputs.push({ ...input });
    }
    void this.pump(live, lease);
    return true;
  }

  private async pump(live: Live, lease: LiveLease): Promise<void> {
    if (lease.sending) return;
    lease.sending = true;
    try {
      while (
        lease.inputs.length > 0 &&
        live.lease === lease &&
        this.pane(live.viewer)?.control.status === "granted"
      ) {
        const next = lease.inputs.shift()!;
        try {
          await this.ctx.request("clawtrate-computer.input", {
            sessionKey: lease.key,
            targetId: lease.targetId,
            generation: lease.generation,
            ...inputParams(next),
          });
        } catch (error) {
          lease.inputs.length = 0;
          if (refusal(error).reason === "not_holder" && live.lease === lease)
            this.leaseEnded(live, null);
          return;
        }
      }
    } finally {
      lease.sending = false;
    }
  }

  // Handing back ------------------------------------------------------------------------------

  /**
   * Give control back (`control.release` with the generation). With `answer`,
   * the question's option goes only once the release is confirmed.
   */
  release(
    viewer: string,
    options: {
      leaving?: boolean;
      answer?: { questionId: string; itemId: string; option: number };
    } = {},
  ): void {
    const live = this.lives.get(viewer);
    const pane = this.pane(viewer);
    const lease = live?.lease;
    if (!live || !lease || !pane) return;
    const status = pane.control.status;
    if (
      status !== "granted" &&
      status !== "unconfirmed" &&
      !(status === "releasing" && pane.control.outOfSight)
    )
      return;
    // Input stops at once and stays stopped until control is confirmed either way.
    lease.inputs.length = 0;
    lease.sequence = ++this.nextSequence;
    lease.answer = options.answer ?? null;
    const sequence = lease.sequence;
    this.patchControl(viewer, {
      status: "releasing",
      stillHeld: false,
      outcome: null,
      answerQueued: lease.answer !== null,
      outOfSight: options.leaving === true || pane.control.outOfSight,
    });
    if (live.renewTimer) clearTimeout(live.renewTimer);
    live.renewTimer = null;
    void (async () => {
      try {
        await deadline(
          this.ctx.request("clawtrate-computer.control.release", {
            sessionKey: lease.key,
            targetId: lease.targetId,
            generation: lease.generation,
          }),
          RELEASE_DEADLINE_MS,
        );
      } catch {
        if (live.lease !== lease || lease.sequence !== sequence) return;
        // A refusal does not prove the device still holds control: ownership is not confirmed.
        const queued = lease.answer !== null;
        lease.answer = null;
        this.patchControl(viewer, {
          status: "unconfirmed",
          answerQueued: false,
          outcome: queued ? "answer-not-sent" : (this.pane(viewer)?.control.outcome ?? null),
        });
        this.reschedule(live);
        return;
      }
      this.confirmed(live, sequence);
    })();
  }

  /** The release was confirmed: by the call's success or a `released` event with this generation. */
  private confirmed(live: Live, sequence: number): void {
    const lease = live.lease;
    if (!lease || lease.sequence !== sequence) return;
    live.lease = null;
    const answer = lease.answer;
    const pane = this.pane(live.viewer);
    const outcome = pane?.control.outcome ?? null;
    if (!answer) {
      this.patchControl(live.viewer, {
        ...noControl,
        released: true,
        outcome: outcome && outcome.startsWith("dropped-") ? outcome : null,
      });
      this.reschedule(live);
      void this.readTabs(live.viewer);
      return;
    }
    const status = this.ctx.questionStatus(lease.key, answer.questionId);
    if (status !== "pending") {
      this.patchControl(live.viewer, { ...noControl, outcome: alreadyOutcome(status) });
      return;
    }
    this.patchControl(live.viewer, { ...noControl, status: "answering" });
    void this.ctx
      .answer(lease.key, answer.questionId, { [answer.itemId]: [{ option: answer.option }] })
      .then(
        () => this.patchControl(live.viewer, { ...noControl, outcome: "answered" }),
        () => {
          const now = this.ctx.questionStatus(lease.key, answer.questionId);
          this.patchControl(live.viewer, {
            ...noControl,
            outcome: now && now !== "pending" ? alreadyOutcome(now) : "answer-failed",
          });
        },
      );
    this.reschedule(live);
  }

  /** "Check": renew with the generation. Renewed: still held. Not renewed: ended. */
  async check(viewer: string): Promise<void> {
    const live = this.lives.get(viewer);
    const lease = live?.lease;
    if (!live || !lease || this.pane(viewer)?.control.status !== "unconfirmed") return;
    try {
      const answer = asRecord(
        await deadline(
          this.ctx.request("clawtrate-computer.view.renew", {
            sessionKey: lease.key,
            targetId: lease.targetId,
            generation: lease.generation,
          }),
          RENEW_DEADLINE_MS,
        ),
      );
      if (live.lease !== lease || this.pane(viewer)?.control.status !== "unconfirmed") return;
      if (answer?.leaseRenewed === true) {
        this.patchControl(viewer, { status: "granted", stillHeld: true, outOfSight: false });
        this.reschedule(live);
      } else this.leaseEnded(live, null);
    } catch (error) {
      if (refusal(error).reason === "tab_not_in_bots_browser" && live.lease === lease)
        this.leaseEnded(live, null);
      // Otherwise nothing is established: the line stays as it is.
    }
  }

  /** The lease ended, by an event for it or a renewal that did not renew it. */
  private leaseEnded(live: Live, cause: "expired" | "revoked" | null): void {
    const lease = live.lease;
    live.lease = null;
    if (lease) {
      lease.inputs.length = 0;
      lease.answer = null;
    }
    const pane = this.pane(live.viewer);
    if (!pane) return;
    this.patchControl(live.viewer, {
      ...noControl,
      status: "ended",
      key: lease?.key ?? pane.control.key,
      botId: lease?.botId ?? pane.control.botId,
      targetId: lease?.targetId ?? pane.control.targetId,
      endCause: cause,
      outcome: pane.control.answerQueued ? "answer-not-sent" : null,
    });
    this.reschedule(live);
  }

  /** Clear an ended control's line, or an outcome, once the person has seen it. */
  dismiss(viewer: string): void {
    const pane = this.pane(viewer);
    if (!pane) return;
    const s = pane.control.status;
    if (s === "ended" || s === "busy" || s === "unsettled" || s === "conflict" || s === "none")
      this.patchControl(viewer, {
        ...noControl,
        busyReason: pane.control.busyReason,
        busyCount: pane.control.busyCount,
      });
  }

  // The question behind the control ---------------------------------------------------------

  /** A question of a task closed, or its run ended: a queued answer is removed, the release goes on. */
  questionClosed(key: string, code: ClosedCode): void {
    for (const live of this.lives.values()) {
      const pane = this.pane(live.viewer);
      const lease = live.lease;
      if (!pane || !lease || lease.key !== key) continue;
      if (lease.answer) {
        lease.answer = null;
        this.patchControl(live.viewer, {
          answerQueued: false,
          outcome: `dropped-${code}` as ComputerOutcome,
        });
      } else if (pane.control.status === "granted") {
        this.patchControl(live.viewer, { questionGone: code });
      }
    }
  }

  // Recovery ----------------------------------------------------------------------------------

  /**
   * The connection dropped: every view ends, input stops, every queued step of
   * a hand-back is retired, and control held or being given back is "maybe held".
   */
  connectionLost(): void {
    for (const live of this.lives.values()) {
      if (live.take) live.take.abandoned = true;
      live.take = null;
      const pane = this.pane(live.viewer);
      const lease = live.lease;
      if (lease) {
        lease.inputs.length = 0;
        lease.answer = null;
        lease.sequence = ++this.nextSequence;
      }
      if (pane) {
        const s = pane.control.status;
        if (
          lease &&
          (s === "granted" || s === "releasing" || s === "unconfirmed" || s === "answering")
        )
          this.patchControl(live.viewer, {
            status: "maybe-held",
            outOfSight: false,
            answerQueued: false,
          });
        else if (s === "draining") this.patchControl(live.viewer, { status: "none" });
      }
      if (live.view && !live.view.ended) this.endView(live, "dropped", null);
      if (live.renewTimer) clearTimeout(live.renewTimer);
      live.renewTimer = null;
    }
  }

  /** Connected again: before offering anything, read the browser's leases again. */
  reconnected(): void {
    for (const live of this.lives.values()) {
      if (this.pane(live.viewer)?.control.status === "maybe-held")
        this.patchControl(live.viewer, { status: "checking" });
    }
  }

  /** Switching gateways: nothing of the old one carries over. */
  reset(): void {
    for (const live of this.lives.values()) {
      if (live.take) live.take.abandoned = true;
      live.take = null;
      live.lease = null;
      this.endView(live, "stopped", null);
      if (live.renewTimer) clearTimeout(live.renewTimer);
      live.renewTimer = null;
    }
    this.write((state) => ({
      plugin: null,
      control: [],
      panes: Object.fromEntries(
        Object.entries(state.panes).map(([id, pane]) => [
          id,
          {
            ...pane,
            availability: "unknown" as const,
            tabs: [],
            view: null,
            control: noControl,
            shown: null,
          },
        ]),
      ),
    }));
  }

  // Stuck ---------------------------------------------------------------------------------------

  /** "Stop <Bot> in this task", after its confirmation: the conversation's Stop. */
  async stopTask(viewer: string): Promise<void> {
    const pane = this.pane(viewer);
    if (!pane) return;
    await this.ctx.stopTask(pane.key);
    this.patch(viewer, (p) => ({ ...p, stopped: true }));
  }
}

function alreadyOutcome(status: QuestionCard["status"] | null): ComputerOutcome {
  return status === "dismissed"
    ? "already-dismissed"
    : status === "cancelled"
      ? "already-cancelled"
      : status === "expired"
        ? "already-expired"
        : "already-answered";
}

/** A request that gives up locally after `ms`; the gateway may still act on it. */
function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no answer")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** An input as the plugin takes it: coordinates it was not given are left out. */
function inputParams(input: Input): RawRecord {
  if (input.kind !== "scroll") return input;
  return {
    kind: "scroll",
    ...(input.x !== null ? { x: input.x } : {}),
    ...(input.y !== null ? { y: input.y } : {}),
    deltaX: input.deltaX,
    deltaY: input.deltaY,
  };
}

/** Bounds for an input command from a viewer. */
export function parseInput(value: unknown): Input {
  const v = asRecord(value);
  const num = (x: unknown, min: number, max: number) => {
    if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max)
      throw new Error("invalid input");
    return Math.round(x * 100) / 100;
  };
  switch (v?.kind) {
    case "click":
      return { kind: "click", x: num(v.x, 0, 100_000), y: num(v.y, 0, 100_000) };
    case "scroll":
      return {
        kind: "scroll",
        x: v.x === null || v.x === undefined ? null : num(v.x, 0, 100_000),
        y: v.y === null || v.y === undefined ? null : num(v.y, 0, 100_000),
        deltaX: v.deltaX === undefined ? 0 : num(v.deltaX, -100_000, 100_000),
        deltaY: num(v.deltaY, -100_000, 100_000),
      };
    case "text":
      if (typeof v.text !== "string" || v.text.length === 0 || v.text.length > MAX_INPUT_TEXT)
        throw new Error("invalid input");
      return { kind: "text", text: v.text };
    default:
      throw new Error("invalid input");
  }
}

export type ComputerInput = Input;
