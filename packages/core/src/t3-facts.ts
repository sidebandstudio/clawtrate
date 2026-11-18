// What the engine keeps of a T3 Code call (docs/design/conversation.md,
// section 11): the few fields of its arguments and of T3 Code's structured
// result that the cards read, projected to fit `MAX_T3_FACTS_CHARS`. The
// engine keeps a step's details only as `projectDetails` does, and a history
// row's result only as a short text, so these facts are taken once, from the
// whole value, when the call or its result arrives: live from the result's
// `details.structuredContent`, from history from the gateway's rendering of
// it in the result's text (`structuredContent:` and its JSON with sorted
// keys). Nothing here decides that a call is T3 Code's; the reading does
// (`t3-code.ts`). Pure, with no imports.

type Rec = Record<string, unknown>;

/** The most a call's T3 Code facts take, in JSON characters. */
export const MAX_T3_FACTS_CHARS = 2_048;
/** The most of a read's reply text kept for the card; the whole is in the raw payload. */
const MAX_REPLY_CHARS = 900;

export type T3Facts = {
  /** The `threadId` and `environmentId` the call's arguments give. */
  argThread?: string;
  argEnvironment?: string;
  /** The result's structured content was read. */
  read?: true;
  threadId?: string;
  runId?: string;
  /** The status the result reports: a run's, or for a read the thread's. */
  status?: string;
  /** How a follow-up was taken: `started`, `queued`, `steered` or `restarted`. */
  delivery?: string;
  timedOut?: boolean;
  resultRun?: { runId: string | null; status: string | null };
  /** The `link` the result carries, as sent. */
  link?: string;
  title?: string;
  projectId?: string;
  model?: string;
  /** A listing's number of projects or threads on the page, and its `total` when it gives one. */
  count?: number;
  total?: number;
  /**
   * A read's two dimensions (11.1): `hasMore` for its pages of items, and for
   * the run it read (the thread's latest), whether an assistant item's text was
   * cut (`replyCut`) and whether another of that run's items was (`otherCut`).
   */
  hasMore?: boolean;
  readRun?: string;
  replyCut?: boolean;
  otherCut?: boolean;
  /** That run's assistant text on the page, as received, shortened here (`replyShort`) to fit. */
  reply?: string;
  replyShort?: true;
  /** T3 Code's failure: `{code, message}`. */
  code?: string;
  message?: string;
};

const rec = (value: unknown): Rec | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * The structured content in a result's text, as the gateway renders it
 * (`projectMcpCallToolResultContent` in OpenClaw 2026.10.6):
 * `structuredContent:\n` and the value's JSON, sorted, two spaces, on the
 * first text item. Only that form is read; anything else, or a rendering the
 * gateway's history cut, gives null.
 */
export function structuredFromText(text: string | null | undefined): Rec | null {
  if (typeof text !== "string" || !text.startsWith("structuredContent:\n{")) return null;
  const body = text.slice("structuredContent:\n".length);
  // The top-level object ends at the first line that is exactly "}": nested lines are indented.
  const end = body.indexOf("\n}");
  const json = end === -1 ? body : body.slice(0, end + 2);
  try {
    return rec(JSON.parse(json));
  } catch {
    return null;
  }
}

/** The thread and environment a call's arguments name. */
export function t3ArgFacts(args: unknown): T3Facts | null {
  const a = rec(args);
  const thread = str(a?.threadId);
  const environment = str(a?.environmentId);
  if (!thread && !environment) return null;
  return {
    ...(thread ? { argThread: thread } : {}),
    ...(environment ? { argEnvironment: environment } : {}),
  };
}

/** The facts of a result's structured content; for a failure, its `code` and `message`. */
export function t3ResultFacts(structured: unknown, isError: boolean): T3Facts | null {
  const s = rec(structured);
  if (!s) return null;
  const out: T3Facts = { read: true };
  const put = <K extends keyof T3Facts>(key: K, value: T3Facts[K] | null | undefined) => {
    if (value !== null && value !== undefined) out[key] = value;
  };
  if (isError || s._tag === "OrchestratorMcpFailure") {
    put("code", str(s.code));
    put("message", str(s.message));
    return out;
  }
  const thread = rec(s.thread);
  put("threadId", str(s.threadId) ?? str(thread?.threadId));
  put("runId", str(s.runId));
  put("status", str(s.status) ?? str(thread?.status));
  put("delivery", str(s.delivery));
  if (typeof s.timedOut === "boolean") out.timedOut = s.timedOut;
  const resultRun = rec(s.resultRun);
  if (resultRun) out.resultRun = { runId: str(resultRun.runId), status: str(resultRun.status) };
  put("link", str(s.link) ?? str(thread?.link));
  put("title", str(thread?.title));
  put("projectId", str(s.projectId) ?? str(thread?.projectId));
  put("model", str(rec(s.modelSelection)?.model));
  if (Array.isArray(s.projects)) put("count", s.projects.length);
  if (Array.isArray(s.threads)) put("count", s.threads.length);
  if (typeof s.total === "number") put("total", s.total);
  if (Array.isArray(s.items)) {
    if (typeof s.hasMore === "boolean") out.hasMore = s.hasMore;
    const items = s.items.map(rec).filter((each): each is Rec => each !== null);
    const run = str(thread?.latestRunId) ?? str(items.at(-1)?.runId);
    if (run) out.readRun = run;
    const ofRun = items.filter((each) => str(each.runId) === run);
    const assistant = (each: Rec) => /assistant/.test(str(each.type) ?? "");
    out.replyCut = ofRun.some((each) => assistant(each) && each.textTruncated === true);
    out.otherCut = ofRun.some((each) => !assistant(each) && each.textTruncated === true);
    const reply = ofRun
      .filter(assistant)
      .map((each) => (typeof each.text === "string" ? each.text : ""))
      .join("\n\n");
    if (reply) {
      out.reply = reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS) : reply;
      if (reply.length > MAX_REPLY_CHARS) out.replyShort = true;
    }
  }
  return out;
}

/** The facts of one call: its arguments' and its result's, the result's winning. */
export function mergeT3Facts(...parts: Array<T3Facts | null | undefined>): T3Facts | null {
  const out: T3Facts = {};
  for (const part of parts) if (part) Object.assign(out, part);
  return fitT3Facts(out);
}

/**
 * Facts cut to `MAX_T3_FACTS_CHARS`: the reply's text first, then each long
 * value, never an id. A value that would not fit whole is dropped, so no id,
 * link or status is ever kept cut. Null when nothing is left.
 */
export function fitT3Facts(facts: T3Facts): T3Facts | null {
  const out: T3Facts = { ...facts };
  const size = () => JSON.stringify(out).length;
  if (size() > MAX_T3_FACTS_CHARS && out.reply) {
    const over = size() - MAX_T3_FACTS_CHARS;
    out.reply = out.reply.slice(0, Math.max(0, out.reply.length - over - 16));
    out.replyShort = true;
    if (!out.reply) delete out.reply;
  }
  for (const key of ["message", "title", "model", "link", "projectId"] as const) {
    if (size() <= MAX_T3_FACTS_CHARS) break;
    delete out[key];
  }
  if (size() > MAX_T3_FACTS_CHARS) return null;
  return Object.keys(out).length ? out : null;
}

/** The facts of a tool-server result, live: from its `details.structuredContent`. */
export function liveT3Facts(args: unknown, details: unknown, isError: boolean): T3Facts | null {
  const d = rec(details);
  if (!str(d?.mcpServer)) return null;
  return mergeT3Facts(t3ArgFacts(args), t3ResultFacts(d?.structuredContent, isError));
}

/** The facts of a tool-server result from history: from the gateway's rendering in its text. */
export function historyT3Facts(args: unknown, text: string, isError: boolean): T3Facts | null {
  return mergeT3Facts(t3ArgFacts(args), t3ResultFacts(structuredFromText(text), isError));
}
