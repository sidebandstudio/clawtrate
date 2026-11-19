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
  /**
   * The thread the call belongs to: while it runs, the one its arguments name;
   * once it has ended, only the one its own result names. Null for a listing, a
   * launch without a result, and a call that ended without a result naming a
   * thread (aborted, refused, failed, or one whose result cannot be read).
   */
  thread: T3Thread | null;
  /** The thread the call's arguments asked for, whether or not anything named it after. */
  asked: T3Thread | null;
  state: T3CallState;
  /** T3 Code's status in the call's returned, non-error result, as sent; null without one. */
  reported: string | null;
  /** What was sent: a launch's `message` (else its `title`), a follow-up's `message`. */
  sent: string | null;
  /** The sent text here is shorter than what was sent: Raw has all of it. */
  sentShort: boolean;
  /** The call returned, but its result could not be read here: what it reported is not known. */
  unread: boolean;
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

/** The result shape each tool returns (B.2), for a result whose tool the gateway did not name. */
const SHAPES: Record<T3Tool, T3Facts["shape"]> = {
  t3_project_list: "projects",
  t3_thread_list: "threads",
  t3_thread_launch: "launch",
  t3_thread_send: "send",
  t3_thread_read: "read",
  t3_thread_wait: "wait",
  t3_thread_interrupt: "interrupt",
};

/** The gateway's reason a failed call gives: T3 Code's `{code, message}`, else its text's first line. */
function reasonOf(call: ActionCall, facts: T3Facts | null): T3Call["error"] {
  const code = facts?.code ?? null;
  const message = facts?.message ?? null;
  if (code || message) return { code, message };
  const text = (call.text ?? "").trim();
  const first = text.startsWith("structuredContent:") ? "" : (text.split("\n")[0] ?? "");
  return { code: null, message: first || null };
}

/**
 * A call as T3 Code's, or null when it is not (11.1). It is T3 Code's when its
 * result names one of the seven tools, whatever the server is called. Before
 * a result, the gateway's map is the evidence, and a result that names another
 * tool overrules it. Where the gateway did not name the tool (history keeps no
 * `details` for a tool server), a structured result is evidence only when it
 * has the shape of the mapped tool's result: one of another shape is another
 * tool's, and never re-attributed by the current map. Live, a result that names
 * no tool and carries nothing of T3 Code's leaves the call ordinary; from
 * history, where nothing named it, the map stands and the call is known less
 * well: its result could not be read.
 */
export function t3CallOf(call: ActionCall, ctx: ReadingContext = {}): T3Call | null {
  const identity = toolServerOf(call, ctx);
  if (!identity || !T3_CODE_TOOLS.includes(identity.tool)) return null;
  const tool = identity.tool as T3Tool;
  const role = ROLES[tool];
  const facts = call.t3 ?? null;
  const state = stateOf(call, ctx);
  const ended = state !== "started" && state !== "waiting";
  if (identity.mapped && ended && facts?.read) {
    const shape = facts.shape ?? null;
    if (shape !== SHAPES[tool] && !(shape === "failure" && state === "failed")) return null;
  }
  if (identity.mapped && state === "made" && !facts?.read && !call.fromHistory) return null;
  const unread = state === "made" && !facts?.read;
  const environmentId = facts?.argEnvironment ?? null;
  const key = (threadId: string) => ({
    key: threadKey(identity.server, environmentId, threadId),
    server: identity.server,
    environmentId,
    threadId,
  });
  // The arguments' ids, kept whole as they arrived; never a cut copy of them.
  const askedId = facts?.argTooLong ? null : (facts?.argThread ?? null);
  const asked = role === "listing" || !askedId ? null : key(askedId);
  // Its own result names the thread once it has ended; in flight, its arguments do.
  const namedId = state === "made" && !facts?.argTooLong ? (facts?.threadId ?? null) : null;
  const thread = role === "listing" ? null : !ended ? asked : namedId ? key(namedId) : null;
  const sentText =
    role === "launch" || role === "send" ? (facts?.argMessage ?? str(call.args.message)) : null;
  return {
    id: call.id,
    tool,
    role,
    server: identity.server,
    mapped: identity.mapped,
    thread,
    asked,
    state,
    reported: state === "made" ? (facts?.status ?? null) : null,
    sent: role === "launch" ? (sentText ?? facts?.argTitle ?? str(call.args.title)) : sentText,
    sentShort: facts?.argMessageShort === true,
    unread,
    error: state === "failed" ? reasonOf(call, facts) : null,
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
  /** The thread's card, at its first call in the record; or a launch still running, on its own. */
  | { type: "card"; thread: T3Thread | null; head: string }
  /** Joined the card directly: its line closed up and it is an item of the card (11.4). */
  | { type: "joined"; thread: T3Thread; head: string }
  /** A line of its own where it happened, and an item of the card too. */
  | { type: "line"; thread: T3Thread; head: string }
  /**
   * A card of its own, in no thread: a call that ended without a result naming
   * one. `head` is the card of the thread its arguments asked for, when shown.
   */
  | { type: "own"; asked: T3Thread | null; head: string | null }
  /** A listing: an ordinary line in T3 Code's family, never a thread's (11.2). */
  | { type: "listing" };

/**
 * Where each T3 Code call of a task's record goes (11.2, 11.4). The first call
 * of a thread in the record is its card. A later call joins it directly only
 * once its own result names the thread, when the card is the item just above
 * it in the same column (the card itself, or a call that already joined it),
 * with nothing shown between, and when the reader did not hold its line
 * (`keptLine`: the line was open or focused, or the reader was not following
 * the end, when its result came; that is a fact of one view, so a view rebuilt
 * from the record never has it). A call still running shows with the thread
 * its arguments name, on a line of its own. A call that ended without a result
 * naming a thread is a card of its own.
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
      const ended = c.state !== "started" && c.state !== "waiting";
      if (!ended) out.set(c.id, { type: "card", thread: null, head: c.id });
      else
        out.set(c.id, {
          type: "own",
          asked: c.asked,
          head: null,
        });
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
  // A call of its own finds its asked thread's card wherever that card is in the column.
  for (const [id, at] of out) {
    if (at.type !== "own" || !at.asked) continue;
    const head = heads.get(at.asked.key);
    if (head) out.set(id, { ...at, head });
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
 * A thread's state, worked out from its calls (11.2): a call that is open
 * first; else, when exactly one returned, non-error result reports a status,
 * that status; when several do, Call made, each status on its own item; else
 * the latest sending call's state. A failed check or a refused follow-up shows
 * on its own item and does not change the thread's word. Null for a thread
 * with no calls.
 */
export function threadStateOf(calls: readonly T3Call[]): T3ThreadState | null {
  if (calls.length === 0) return null;
  const open = calls.filter((c) => c.state === "started" || c.state === "waiting");
  if (open.some((c) => c.state === "waiting")) return { type: "open", word: "waiting" };
  if (open.some((c) => SENDING[c.role])) return { type: "open", word: "call-started" };
  if (open.length > 0) return { type: "open", word: "checking" };
  const reports = calls.filter((c) => c.state === "made" && c.reported !== null);
  const report = reports[0];
  if (report && reports.length > 1) return { type: "call", state: "made", callId: report.id };
  if (report)
    return {
      type: "reported",
      status: report.reported!,
      callId: report.id,
      at: report.call.endedAt,
    };
  const sending = [...calls].reverse().find((c) => SENDING[c.role]) ?? calls.at(-1)!;
  return { type: "call", state: sending.state, callId: sending.id };
}

/** T3 Code's status in plain words (11.2, step 2); a status this design does not name, as received. */
export function statusWords(status: string): string {
  return T3_WORDS.status[status] ?? status.replace(/_/g, " ");
}

const firstLine = (text: string | null | undefined) =>
  ((text ?? "").split("\n").find((line) => line.trim()) ?? "").trim();

/**
 * The first line of the latest message T3 Code took on a thread: a launch's or
 * a follow-up's whose call was made. A refused or failed follow-up is not one.
 */
export function latestSent(calls: readonly T3Call[]): string {
  const sent = [...calls].reverse().find((c) => c.sent !== null && c.state === "made")?.sent;
  return firstLine(sent);
}

/**
 * What a thread is for, for its folded line (11.2): its title when the record
 * has one (the launch's `title`, or the title a later result reports), else
 * the first line of the launch's message, else that of the latest message sent.
 */
export function threadTitle(calls: readonly T3Call[]): string {
  const launch = calls.find((c) => c.role === "launch");
  const title =
    launch?.facts?.argTitle ??
    str(launch?.call.args.title) ??
    [...calls].reverse().find((c) => c.facts?.title)?.facts?.title ??
    null;
  if (title) return firstLine(title);
  const message = launch?.facts?.argMessage ?? str(launch?.call.args.message);
  return firstLine(message) || latestSent(calls);
}

/**
 * Whether the run that made the thread's latest sending call was stopped after
 * that call was made (11, F-137): that run reads as stopped, or a later call of
 * the same gateway run was cut short by the stop, as the gateway's own
 * "Aborted" says. An abort in another run says nothing of this handoff.
 */
export function workMayContinue(calls: readonly T3Call[]): boolean {
  const at = calls.findLastIndex((c) => SENDING[c.role]);
  const sending = calls[at];
  if (sending?.state !== "made") return false;
  const run = sending.call.runId ?? null;
  const abortedAfter =
    run !== null &&
    calls
      .slice(at + 1)
      .some(
        (c) =>
          c.call.runId === run &&
          c.state === "unknown" &&
          /^aborted\.?$/i.test((c.call.text ?? "").trim()),
      );
  return sending.call.runStopped === true || abortedAfter;
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
  /** The result's fields could not be read: how much was read is not known. */
  unknown: boolean;
  /** The result as stored was cut (the gateway's own mark): the reason it could not be read. */
  storedCut?: boolean;
  /** The read asked for a later page, or the rest of one item: not the thread's first page. */
  continuation?: boolean;
};

/**
 * A read's two dimensions (11.1, 11.3): the pages of items, and the text of
 * each item of the run it read. It says it read to the end only when both are
 * complete: no more pages, and no item of that run cut, whatever its type.
 * `storedCut` is the call's own mark that what is kept of its result was cut.
 */
export function readDimensions(facts: T3Facts | null, storedCut = false): ReadDimensions {
  const continuation = facts?.argAfter === true || facts?.argItem === true;
  if (!facts?.read || facts.hasMore === undefined)
    return {
      toEnd: false,
      morePages: false,
      replyCut: false,
      otherCut: false,
      unknown: true,
      ...(storedCut ? { storedCut: true } : {}),
      ...(continuation ? { continuation: true } : {}),
    };
  const morePages = facts.hasMore === true;
  const replyCut = facts.replyCut === true;
  const otherCut = facts.otherCut === true;
  return {
    toEnd: !morePages && !replyCut && !otherCut,
    morePages,
    replyCut,
    otherCut,
    unknown: false,
    ...(continuation ? { continuation: true } : {}),
  };
}

/** The lines a read's item shows on how much it read, together (11.3). */
export function readLines(d: ReadDimensions): string[] {
  if (d.unknown) return [d.storedCut ? T3_WORDS.storedCut : T3_WORDS.unreadable];
  if (d.toEnd) return [T3_WORDS.readToEnd];
  return [
    ...(d.morePages ? [d.continuation ? T3_WORDS.laterPage : T3_WORDS.firstPage] : []),
    ...(d.replyCut ? [T3_WORDS.replyCut] : []),
    ...(!d.replyCut && d.otherCut ? [T3_WORDS.otherCut] : []),
  ];
}

/**
 * The thread's link, for "Open thread" (11.3): the one distinct address the
 * record's results carry, none when they carry several in no proven order,
 * offered only for an `http:` or `https:` address, with its host to show
 * beside it. Loopback is an address like any other: a thread can live on the
 * person's own machine. Any other scheme, or a value that is not an address,
 * gives no link.
 */
export function threadLink(calls: readonly T3Call[]): { href: string; host: string } | null {
  const links = new Set(calls.flatMap((c) => (c.facts?.link ? [c.facts.link] : [])));
  if (links.size !== 1) return null;
  const link = links.values().next().value!;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return { href: url.toString(), host: url.host };
}
