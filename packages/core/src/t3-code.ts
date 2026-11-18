// The reading of T3 Code calls and the thread cards they make
// (docs/design/conversation.md, section 11). Pure functions over the action
// calls the engine supplies (`ActionCall`, with the facts `t3-facts.ts` kept):
//
// - `t3CallOf` recognizes a call per call, never per server: one of T3 Code's
//   seven tools, by its result's `details.mcpTool` on whatever server, or
//   before its result by the gateway's name map, which the result overrules.
// - `placeT3` decides, over a task's ordered record, which call is a thread's
//   card, which joins it directly and which keeps a line of its own.
// - `threadStateOf` works out a thread's state from its calls (11.2), and
//   `readDimensions` what a read read (11.1, 11.3).
//
// A thread is its server, its environment and its thread id together, and
// nothing else: never a project, a title, a link or nearness.

import { outcomeOf, toolServerOf, type ActionCall, type ReadingContext } from "./actions.ts";
import { T3_WORDS } from "./action-words.ts";
import { T3_CODE_TOOLS } from "./cards.ts";
import type { T3Facts } from "./t3-facts.ts";

export type T3Tool =
  | "t3_project_list"
  | "t3_thread_launch"
  | "t3_thread_send"
  | "t3_thread_read"
  | "t3_thread_wait"
  | "t3_thread_list"
  | "t3_thread_interrupt";

export type T3Role = "launch" | "send" | "read" | "wait" | "interrupt" | "listing";

const ROLES: Record<T3Tool, T3Role> = {
  t3_project_list: "listing",
  t3_thread_list: "listing",
  t3_thread_launch: "launch",
  t3_thread_send: "send",
  t3_thread_read: "read",
  t3_thread_wait: "wait",
  t3_thread_interrupt: "interrupt",
};

/** Each call's own state (11, "Each call's state"): the call's, not the work's. */
export type T3CallState = "started" | "waiting" | "made" | "unknown" | "failed" | "not-sent";

/** A thread: its server, its environment (when the call names one) and its id, together. */
export type T3Thread = {
  key: string;
  server: string;
  environmentId: string | null;
  threadId: string;
};

export type T3Call = {
  /** The gateway's tool call id. */
  id: string;
  tool: T3Tool;
  role: T3Role;
  server: string;
  /** Known only from the gateway's name map: no result has named its tool. */
  mapped: boolean;
  /** Null when the thread cannot be known: a listing, a launch without a result, a failed launch. */
  thread: T3Thread | null;
  state: T3CallState;
  /** T3 Code's status in the call's returned, non-error result, as sent; null without one. */
  reported: string | null;
  /** What was sent: a launch's `message` (else its `title`), a follow-up's `message`. */
  sent: string | null;
  error: { code: string | null; message: string | null } | null;
  facts: T3Facts | null;
  call: ActionCall;
};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** The key a thread is known by: its server, environment and id together. */
export function threadKey(server: string, environmentId: string | null, threadId: string): string {
  return JSON.stringify([server, environmentId, threadId]);
}

function stateOf(call: ActionCall, ctx: ReadingContext): T3CallState {
  switch (outcomeOf(call, ctx).outcome) {
    case "running":
    case "review":
      return "started";
    case "waiting":
      return "waiting";
    case "failed":
    case "unavailable":
      return "failed";
    case "blocked":
    case "denied":
    case "refused":
    case "suppressed":
      return "not-sent";
    case "unknown":
    case "stopped":
      return "unknown";
    default:
      return "made";
  }
}

/**
 * A call as T3 Code's, or null when it is not (11.1). It is T3 Code's when its
 * result names one of the seven tools, whatever the server is called. Before
 * a result, the gateway's map is the evidence, and a result that names another
 * tool overrules it. A result that names no tool (history keeps no `details`
 * for a tool server) leaves the map's word only where something else says it
 * is T3 Code's: T3 Code's structured content as the gateway rendered it, an
 * error, or a refusal. The map alone never makes a call Call made.
 */
export function t3CallOf(call: ActionCall, ctx: ReadingContext = {}): T3Call | null {
  const identity = toolServerOf(call, ctx);
  if (!identity || !T3_CODE_TOOLS.includes(identity.tool)) return null;
  const tool = identity.tool as T3Tool;
  const role = ROLES[tool];
  const facts = call.t3 ?? null;
  const state = stateOf(call, ctx);
  if (identity.mapped && state === "made" && !facts?.read) return null;
  const a = call.args;
  const environmentId = facts?.argEnvironment ?? str(a.environmentId);
  const threadId =
    role === "listing"
      ? null
      : role === "launch"
        ? state === "made"
          ? (facts?.threadId ?? null)
          : null
        : (facts?.argThread ?? str(a.threadId) ?? facts?.threadId ?? null);
  const thread = threadId
    ? {
        key: threadKey(identity.server, environmentId, threadId),
        server: identity.server,
        environmentId,
        threadId,
      }
    : null;
  return {
    id: call.id,
    tool,
    role,
    server: identity.server,
    mapped: identity.mapped,
    thread,
    state,
    reported: state === "made" ? (facts?.status ?? null) : null,
    sent:
      role === "launch"
        ? (str(a.message) ?? str(a.title))
        : role === "send"
          ? str(a.message)
          : null,
    error: state === "failed" ? { code: facts?.code ?? null, message: facts?.message ?? null } : null,
    facts,
    call,
  };
}

// Where each call goes -------------------------------------------------------------

/** One shown thing of a task's ordered record, in order (reasoning is not shown). */
export type T3Sequence = Array<
  | { type: "t3"; call: T3Call }
  /** Anything else shown: an action, a bubble, a request card, a note. */
  | { type: "other" }
  /** The end of one record (a history item, a run): nothing joins across it. */
  | { type: "boundary" }
>;

export type T3Placement =
  /** The thread's card, at its first call in the record; or a call with no known thread, on its own. */
  | { type: "card"; thread: T3Thread | null; head: string }
  /** Joined the card directly: its line closed up and it is an item of the card (11.4). */
  | { type: "joined"; thread: T3Thread; head: string }
  /** A line of its own where it happened, and an item of the card too. */
  | { type: "line"; thread: T3Thread; head: string }
  /** A listing: an ordinary line in T3 Code's family, never a thread's (11.2). */
  | { type: "listing" };

/**
 * Where each T3 Code call of a task's record goes (11.2, 11.4). The first call
 * of a thread in the record is its card. A later call joins it directly only
 * once its result names the tool and the thread, when the card is the item
 * just above it in the same column (the card itself, or a call that already
 * joined it), with nothing shown between, and when the reader did not hold
 * its line (`keptLine`: the line was open or focused, or the reader was not
 * following the end, when its result came). Every other later call keeps a
 * line of its own. A call whose thread cannot be known is a card on its own.
 */
export function placeT3(
  sequence: T3Sequence,
  keptLine: (callId: string) => boolean = () => false,
): Map<string, T3Placement> {
  const out = new Map<string, T3Placement>();
  const heads = new Map<string, string>();
  // The thread whose card (or a call joined to it) is the item just above.
  let above: string | null = null;
  for (const item of sequence) {
    if (item.type !== "t3") {
      above = null;
      continue;
    }
    const c = item.call;
    if (c.role === "listing") {
      out.set(c.id, { type: "listing" });
      above = null;
      continue;
    }
    if (!c.thread) {
      out.set(c.id, { type: "card", thread: null, head: c.id });
      above = null;
      continue;
    }
    const key = c.thread.key;
    const head = heads.get(key);
    if (head === undefined) {
      heads.set(key, c.id);
      out.set(c.id, { type: "card", thread: c.thread, head: c.id });
      above = key;
      continue;
    }
    const settled = c.state !== "started" && c.state !== "waiting";
    if (settled && above === key && !keptLine(c.id)) {
      out.set(c.id, { type: "joined", thread: c.thread, head });
      continue;
    }
    out.set(c.id, { type: "line", thread: c.thread, head });
    above = null;
  }
  return out;
}

// A thread's state ----------------------------------------------------------------

export type T3ThreadState =
  /** A call on the thread is open (11.2, step 1). */
  | { type: "open"; word: "waiting" | "call-started" | "checking" }
  /** What T3 Code last reported (step 2), with the call that reported it and when. */
  | { type: "reported"; status: string; callId: string; at: number | null }
  /** The latest sending call's own state (step 3). */
  | { type: "call"; state: T3CallState; callId: string };

const SENDING: Record<T3Role, boolean> = {
  launch: true,
  send: true,
  interrupt: true,
  read: false,
  wait: false,
  listing: false,
};

/**
 * A thread's state, worked out from its calls in their order (11.2): a call
 * that is open first; else the status in the latest returned, non-error
 * result of any call on the thread; else the latest sending call's state. A
 * failed check or a refused follow-up shows on its own item and does not
 * change the thread's word. Null for a thread with no calls.
 */
export function threadStateOf(calls: readonly T3Call[]): T3ThreadState | null {
  if (calls.length === 0) return null;
  const open = calls.filter((c) => c.state === "started" || c.state === "waiting");
  if (open.some((c) => c.state === "waiting")) return { type: "open", word: "waiting" };
  if (open.some((c) => SENDING[c.role])) return { type: "open", word: "call-started" };
  if (open.length > 0) return { type: "open", word: "checking" };
  const reported = [...calls].reverse().find((c) => c.state === "made" && c.reported !== null);
  if (reported)
    return {
      type: "reported",
      status: reported.reported!,
      callId: reported.id,
      at: reported.call.endedAt,
    };
  const sending = [...calls].reverse().find((c) => SENDING[c.role]) ?? calls.at(-1)!;
  return { type: "call", state: sending.state, callId: sending.id };
}

/** T3 Code's status in plain words (11.2, step 2); a status this design does not name, as received. */
export function statusWords(status: string): string {
  return T3_WORDS.status[status] ?? status.replace(/_/g, " ");
}

/** The first line of the latest message sent on a thread, for its folded line (11.2). */
export function latestSent(calls: readonly T3Call[]): string {
  const sent = [...calls].reverse().find((c) => c.sent !== null)?.sent ?? "";
  return (sent.split("\n").find((line) => line.trim()) ?? "").trim();
}

/** Whether the bot's stop came after a sending call on the thread was made (11, F-137). */
export function workMayContinue(calls: readonly T3Call[]): boolean {
  const sending = [...calls].reverse().find((c) => SENDING[c.role]);
  return sending?.state === "made" && sending.call.runStopped === true;
}

// What a read read ------------------------------------------------------------------

export type ReadDimensions = {
  /** No more pages and no item of the run read cut: only then "Read to the end". */
  toEnd: boolean;
  /** More pages of items remain (`hasMore`). */
  morePages: boolean;
  /** An assistant item of the run read was cut (`textTruncated`). */
  replyCut: boolean;
  /** Another item of that run (a user message, a tool item) was cut. */
  otherCut: boolean;
  /** The structured content could not be read: how much was read is not known. */
  unknown: boolean;
};

/**
 * A read's two dimensions (11.1, 11.3): the pages of items, and the text of
 * each item of the run it read. It says it read to the end only when both are
 * complete: no more pages, and no item of that run cut, whatever its type.
 */
export function readDimensions(facts: T3Facts | null): ReadDimensions {
  if (!facts?.read || facts.hasMore === undefined)
    return { toEnd: false, morePages: false, replyCut: false, otherCut: false, unknown: true };
  const morePages = facts.hasMore === true;
  const replyCut = facts.replyCut === true;
  const otherCut = facts.otherCut === true;
  return {
    toEnd: !morePages && !replyCut && !otherCut,
    morePages,
    replyCut,
    otherCut,
    unknown: false,
  };
}

/** The lines a read's item shows on how much it read, together (11.3). */
export function readLines(d: ReadDimensions): string[] {
  if (d.unknown) return [T3_WORDS.storedCut];
  if (d.toEnd) return [T3_WORDS.readToEnd];
  return [
    ...(d.morePages ? [T3_WORDS.firstPage] : []),
    ...(d.replyCut ? [T3_WORDS.replyCut] : []),
    ...(!d.replyCut && d.otherCut ? [T3_WORDS.otherCut] : []),
  ];
}
