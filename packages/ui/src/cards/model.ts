// What each card says, decided from the engine's state alone. These functions
// take the engine's records (`ApprovalCard`, `QuestionCard`, `BotMessageCard`,
// `McpCallCard`) and return words and flags; the components only draw them.
// Nothing here infers more than a record establishes (conversation.md
// sections 10 to 13).

import type {
  ApprovalCard,
  ApprovalDecision,
  Bot,
  BotMessageCard,
  McpCallCard,
  QuestionCard,
  QuestionItem,
  Run,
  RunState,
  StartedTaskState,
} from "@clawtrate/core";

// Names ---------------------------------------------------------------------------

/** A bot's name by id, or the id itself when the gateway listed no such bot. */
export function nameOf(bots: Bot[], id: string | null, fallback: string): string {
  if (!id) return fallback;
  return bots.find((bot) => bot.id === id)?.name ?? id;
}

/** The bot id in a session key, `agent:<id>:…`. */
export function agentOfKey(key: string | null): string | null {
  return key ? (/^agent:([^:]+):/.exec(key)?.[1] ?? null) : null;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Approvals -------------------------------------------------------------------------

export type Row = {
  label: string;
  value: string;
  mono?: boolean;
  /** Separate values that must keep their boundaries, such as a command's arguments. */
  list?: string[];
};

/**
 * A routine's standing grant, as the request's `scope` names it, with the
 * gateway's default lifetime (`expiresInDays`, whole days from 1 to 3650)
 * when it sets one; absent, the grant lasts until it is revoked.
 */
function standingGrant(
  card: ApprovalCard,
): { routine: string | null; defaultDays: number | null } | null {
  const scope = record(card.scope);
  if (scope?.kind !== "standing-grant") return null;
  const automation = record(scope.automation);
  const days = scope.expiresInDays;
  return {
    routine:
      str(automation?.name) ??
      str(automation?.cronJobName) ??
      str(automation?.jobName) ??
      str(scope.automation),
    defaultDays:
      typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 3650 ? days : null,
  };
}

/** Where an exec command runs, in the words the request gives. */
function machineOf(card: ApprovalCard): string | null {
  const exec = card.exec;
  if (!exec) return null;
  if (exec.nodeId) return exec.nodeId;
  if (exec.host === "gateway") return "the gateway's machine";
  if (exec.host === "node") return null;
  return exec.host;
}

/** The warnings the request carries: its analysis's warning lines, as sent. */
export function approvalWarnings(card: ApprovalCard): string[] {
  const analysis = record(card.exec?.commandAnalysis);
  const lines = Array.isArray(analysis?.warningLines) ? analysis.warningLines : [];
  return lines.filter((line): line is string => typeof line === "string" && line.trim() !== "");
}

export type ApprovalView = {
  /** "Otto wants to run a command". */
  title: string;
  /** One sentence: what will happen, the machine in bold. */
  summary: {
    lead: string;
    /** A compact form of the command: its first line, shortened; the whole is in the full request. */
    code: string | null;
    /** The command in full, for a tooltip, when `code` shows less of it. */
    codeFull: string | null;
    middle: string;
    machine: string | null;
  };
  /** Who is asking, when it is not the task's own bot. */
  askerLine: string | null;
  warnings: string[];
  /** The exact text decided on, and its label. */
  exact: { label: string; text: string } | null;
  /** The command's arguments, one by one, when the request gives them. */
  argv: string[] | null;
  rows: Row[];
  /** Decisions the request offers, in the card's order. */
  once: boolean;
  always: boolean;
  /**
   * The form: the request's own fields and what the gateway keeps, in words.
   * `defaultDays` is the lifetime the gateway gives the grant unless told otherwise.
   */
  form: { rows: Row[]; sentence: string; days: boolean; defaultDays: number | null };
  /** Whether the thing decided on is a command, for the outcome sentences. */
  noun: "command" | "action";
};

export function approvalView(
  card: ApprovalCard,
  bots: Bot[],
  taskBot: Bot | undefined,
): ApprovalView {
  const own = taskBot?.name ?? "The bot";
  const asker = nameOf(bots, card.agentId, own);
  const asking = card.relation === "helper" ? `A helper of ${own}` : asker;
  // A plugin's request names its action in the plugin's own words, shown as sent in the summary.
  const title =
    card.kind === "plugin" ? `${asking} asks for approval` : `${asking} wants to ${what(card)}`;
  const askerLine =
    card.relation === "helper"
      ? `Asked by a helper ${own} started for this task.`
      : card.relation === "messaged"
        ? `${asker} is working on a message from ${own}.`
        : null;
  const machine = machineOf(card);
  const grant = standingGrant(card);
  let summary: ApprovalView["summary"];
  let exact: ApprovalView["exact"] = null;
  const argv = card.exec?.commandArgv?.length ? card.exec.commandArgv : null;
  const rows: Row[] = [];
  if (card.exec) {
    // The command as the request gives it; its arguments are never joined into a stand-in for it.
    const command = card.exec.command;
    const shown = command ?? argv?.[0] ?? null;
    const code = shown ? compact(shown) : null;
    summary = {
      lead: "Run ",
      code,
      codeFull: shown && code !== shown ? shown : null,
      middle: machine ? " on " : "",
      machine,
    };
    if (command) exact = { label: "Command", text: command };
    if (argv) rows.push({ label: "Arguments", value: argv.join(" "), list: argv });
    if (machine) rows.push({ label: "Runs on", value: machine });
    if (card.exec.cwd) rows.push({ label: "Folder", value: card.exec.cwd, mono: true });
    if (card.agentId) rows.push({ label: "Asked by", value: asker });
    if (card.exec.warningText) rows.push({ label: "Warning", value: card.exec.warningText });
  } else if (card.plugin) {
    summary = {
      lead:
        [card.plugin.title, card.plugin.description].filter(Boolean).join(". ") ||
        "A plugin asks for approval.",
      code: null,
      codeFull: null,
      middle: "",
      machine: null,
    };
    if (card.plugin.detail) exact = { label: "Detail", text: card.plugin.detail };
    if (card.plugin.pluginId) rows.push({ label: "Plugin", value: card.plugin.pluginId });
    if (card.plugin.toolName) rows.push({ label: "Tool", value: card.plugin.toolName, mono: true });
    if (card.plugin.severity) rows.push({ label: "Severity", value: card.plugin.severity });
    if (card.agentId) rows.push({ label: "Asked by", value: asker });
  } else {
    const change = card.systemAgent;
    summary = {
      lead: change?.description ?? change?.title ?? "A change to the gateway asks for approval.",
      code: null,
      codeFull: null,
      middle: "",
      machine: null,
    };
    if (change?.command) exact = { label: "Change", text: change.command };
    if (card.agentId) rows.push({ label: "Asked by", value: asker });
  }

  const formRows: Row[] = [];
  if (card.exec) {
    if (card.exec.command)
      formRows.push({ label: "Command", value: card.exec.command, mono: true });
    if (argv) formRows.push({ label: "Arguments", value: argv.join(" "), list: argv, mono: true });
    if (card.exec.cwd) formRows.push({ label: "Folder", value: card.exec.cwd, mono: true });
    if (machine) formRows.push({ label: "Runs on", value: machine });
  }
  if (card.agentId) formRows.push({ label: "Bot", value: asker });
  if (grant) {
    formRows.push({
      label: "For",
      value: grant.routine ? `The routine ${grant.routine}` : "The routine that asked",
    });
  }
  const sentence = grant
    ? `${grant.routine ? `The routine ${grant.routine}` : "The routine"} may run this command without asking.`
    : card.kind === "exec"
      ? `The gateway will add this to ${machine ? `${possessive(machine)} allowlist` : "the host's allowlist"}, so ${asker} is not asked again for commands it matches. The gateway decides what that covers; it can be wider than this exact command.`
      : "The gateway will remember this decision for requests it treats as the same.";

  return {
    title,
    summary,
    askerLine,
    warnings: approvalWarnings(card),
    exact,
    argv,
    rows,
    once: card.allowedDecisions.includes("allow-once"),
    always: card.allowedDecisions.includes("allow-always"),
    // A lifetime only where the gateway mints a dated grant, and never for a plugin request.
    form: {
      rows: formRows,
      sentence,
      days: grant !== null && card.kind !== "plugin",
      defaultDays: card.kind === "plugin" ? null : (grant?.defaultDays ?? null),
    },
    noun: card.kind === "exec" ? "command" : "action",
  };
}

function what(card: ApprovalCard): string {
  return card.kind === "exec" ? "run a command" : "change the gateway";
}

/** "media-box's"; the gateway's own machine keeps "the gateway's" list. */
function possessive(name: string): string {
  return name === "the gateway's machine" ? "the gateway's" : `${name}'s`;
}

/** Characters of a command the summary shows; the full request holds the rest. */
export const SUMMARY_COMMAND_CHARS = 72;

/** The first line of a command, shortened to the summary's length, marked when anything is left out. */
function compact(text: string): string {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const cut = first.length > SUMMARY_COMMAND_CHARS;
  return cut || lines.length > 1 ? `${first.slice(0, SUMMARY_COMMAND_CHARS).trimEnd()}…` : first;
}

/** The decision buttons' words: "Allow" when there is no reusable rule to offer. */
export function allowLabel(view: Pick<ApprovalView, "always">): string {
  return view.always ? "Allow once" : "Allow";
}

/** "Expires in 28 minutes; the command is not run if it does." */
export function expiryLine(card: ApprovalCard, now: number): string | null {
  if (card.expiresAt === null || card.status !== "pending") return null;
  const minutes = Math.max(1, Math.round((card.expiresAt - now) / 60_000));
  const noun = card.kind === "exec" ? "the command is" : "the action is";
  const span =
    minutes >= 120
      ? `${Math.round(minutes / 60)} hours`
      : minutes === 1
        ? "1 minute"
        : `${minutes} minutes`;
  return `Expires in ${span}; ${noun} not run if it does.`;
}

export type ResolvedView = {
  tag: string;
  tone: "accent" | null;
  sentence: string;
  /** What was saved, in the form's words. */
  saved: string | null;
  /** The line when another decision won. */
  winner: string | null;
};

/**
 * A settled approval: what the gateway reported and no more. Allowing is not
 * proof that a command ran; an outcome this client only inferred, or one the
 * gateway gave without saying how, is not stated as more.
 */
export function resolvedView(
  card: ApprovalCard,
  bots: Bot[],
  taskBot: Bot | undefined,
  run: Pick<Run, "state" | "stopRequestedAt"> | undefined,
): ResolvedView {
  const name = nameOf(bots, card.agentId, taskBot?.name ?? "The bot");
  const noun = card.kind === "exec" ? "command" : "action";
  const can = card.kind === "exec" ? "The command can run now." : "It can go ahead now.";
  const notRun = card.kind === "exec" ? "The command was not run." : "Nothing was done.";
  const winner =
    card.error && /already been settled/.test(card.error)
      ? `${card.resolvedBy ? `Decided by ${card.resolvedBy}${card.resolvedAt ? ` at ${clock(card.resolvedAt)}` : ""}. ` : ""}Your decision was not applied.`
      : null;
  const grant = standingGrant(card);
  const machine = machineOf(card);
  switch (card.status) {
    case "allowed":
      if (card.decision === "allow-always") {
        return {
          tag: "Always allowed",
          tone: "accent",
          sentence: `Allowed, and saved. ${can}`,
          saved: grant
            ? `${grant.routine ? `The routine ${grant.routine}` : "The routine"} may run this command without asking.`
            : card.kind === "exec"
              ? `Added to ${machine ? possessive(machine) : "the host's"} allowlist. The gateway decides what it covers. Seeing that list needs admin access.`
              : "The gateway will remember this decision for requests it treats as the same.",
          winner,
        };
      }
      if (card.decision === "allow-once") {
        return {
          tag: "Allowed once",
          tone: "accent",
          sentence: `Allowed once. ${can} ${name} will ask again next time.`,
          saved: null,
          winner,
        };
      }
      return { tag: "Allowed", tone: "accent", sentence: `Allowed. ${can}`, saved: null, winner };
    case "denied":
      return {
        tag: "Denied",
        tone: null,
        sentence: `Denied. ${notRun}`,
        saved: null,
        winner,
      };
    case "expired": {
      const at = card.resolvedAt ?? card.expiresAt;
      return {
        tag: "Expired",
        tone: null,
        sentence: `Expired${at ? ` at ${clock(at)}` : ""} without an answer. ${notRun}`,
        saved: null,
        winner: null,
      };
    }
    case "cancelled":
      return {
        tag: "Cancelled",
        tone: null,
        sentence:
          run?.stopRequestedAt !== null && run?.stopRequestedAt !== undefined
            ? `You stopped the run before answering. ${notRun}`
            : `The gateway cancelled this request before it was answered. ${notRun}`,
        saved: null,
        winner: null,
      };
    case "closed":
    case "pending": {
      // Closed: the gateway settled it without saying how (`outcomeUnknown`, a
      // settlement that allows nothing), or a reload no longer listed it
      // (`inferred`, which says nothing about how it ended).
      const ended = run && isEnded(run.state);
      const failed = run?.state === "failed";
      if (card.outcomeUnknown && !card.inferred) {
        return {
          tag: ended ? (failed ? "Closed: the run failed" : "Closed: the run ended") : "Closed",
          tone: null,
          sentence: ended
            ? `The run ${failed ? "failed" : "ended"} before this was answered. The ${noun} was not ${card.kind === "exec" ? "run" : "done"}.`
            : `The gateway closed this request without allowing it. ${notRun}`,
          saved: null,
          winner,
        };
      }
      return {
        tag: ended ? (failed ? "Closed: the run failed" : "Closed: the run ended") : "Closed",
        tone: null,
        sentence: ended
          ? `${name}'s run has ended and this request is closed. The gateway did not say how it was settled.`
          : "This request was settled while this app was not watching. The gateway did not say how.",
        saved: null,
        winner,
      };
    }
  }
}

function isEnded(state: RunState): boolean {
  return (
    state === "completed" || state === "failed" || state === "stopped" || state === "cancelled"
  );
}

/** The one-line summary on a folded resolved card. */
export function approvalLine(card: ApprovalCard, view: ApprovalView): string {
  if (view.summary.code) {
    return `${view.summary.lead}${view.summary.code}${view.summary.machine ? ` on ${view.summary.machine}` : ""}`;
  }
  return view.summary.lead;
}

export type DecisionPhase =
  /** Nothing sent, or the last attempt never left this client. */
  | "choose"
  | "sending"
  /** The gateway answered with an error; whether the request is open is said only once read back. */
  | "refused"
  /** No answer came: only deny, and "Check again", until the request is read back. */
  | "unknown";

export function decisionPhase(card: ApprovalCard): DecisionPhase {
  if (card.submitting) return "sending";
  if (card.decisionError === "unknown") return "unknown";
  if (card.decisionError === "refused") return "refused";
  return "choose";
}

/** Which decisions may be sent now. Deny always; nothing else while the outcome is unknown or the text was cut. */
export function sendableDecisions(
  card: ApprovalCard,
  wholeTextRead: boolean,
): Set<ApprovalDecision> {
  const out = new Set<ApprovalDecision>(["deny"]);
  if (card.status !== "pending" || card.decisionError === "unknown") return out;
  if (card.decisionCut && !wholeTextRead) return out;
  for (const each of card.allowedDecisions) out.add(each);
  return out;
}

// Questions -------------------------------------------------------------------------

export const LETTERS = ["A", "B", "C", "D"] as const;

/** An answered row: the chosen option's letter, or none for a typed answer. */
export type AnsweredRow = { letter: string | null; text: string };

/** The rows an answered question shows: options matched by their label or value, typed text as typed. */
export function answeredRows(item: QuestionItem, answers: string[] | undefined): AnsweredRow[] {
  return (answers ?? []).map((answer) => {
    const index = item.options.findIndex(
      (option) => option.label === answer || (option.value !== null && option.value === answer),
    );
    const option = index === -1 ? undefined : item.options[index];
    return option
      ? { letter: LETTERS[index] ?? null, text: option.label }
      : { letter: null, text: answer };
  });
}

/** What a settled question says under each title. */
export function questionNote(card: QuestionCard, run: Pick<Run, "state"> | undefined): string {
  switch (card.status) {
    case "dismissed":
      return "Dismissed";
    case "expired":
      return "Expired without an answer";
    case "cancelled":
      return "Cancelled: you stopped the run";
    case "closed":
      return run?.state === "failed" ? "Closed: the run failed" : "Closed: the run ended";
    default:
      return "";
  }
}

/** The card's accessible name. */
export function questionName(card: QuestionCard, botName: string): string {
  const first = card.questions[0];
  return `${botName} asks: ${first?.question || first?.header || "a question"}`;
}

// Messaged cards --------------------------------------------------------------------

/** The states the Messaged card shows, by their keys in the design. */
export type MessagedKey =
  | "call-started"
  | "approval"
  | "sent"
  | "working"
  | "recipient-waiting"
  | "no-reply"
  | "replied"
  | "recipient-stopped"
  | "recipient-failed"
  | "failed"
  | "blocked"
  | "not-sent"
  | "unknown"
  | "call-made"
  | "delivery-unknown";

/** [mark, word, tone] for each state. */
export const MESSAGED_STATES: Record<
  MessagedKey,
  [string, string, "accent" | "warn" | "danger" | null]
> = {
  "call-started": ["sending", "Call started", null],
  approval: ["waiting", "Waiting for approval", "warn"],
  sent: ["check", "Sent", null],
  working: ["working", "Working", "accent"],
  "recipient-waiting": ["waiting", "Recipient waiting", "warn"],
  "no-reply": ["queued", "No reply yet", null],
  replied: ["check", "Replied", "accent"],
  "recipient-stopped": ["stopped", "Recipient stopped", null],
  "recipient-failed": ["failed", "Recipient failed", "danger"],
  failed: ["failed", "Failed", "danger"],
  blocked: ["failed", "Blocked by policy", "danger"],
  "not-sent": ["stopped", "Not sent", null],
  unknown: ["queued", "Unknown", null],
  "call-made": ["check", "Call made", null],
  "delivery-unknown": ["queued", "Delivery unknown", null],
};

/**
 * States in which an event established that the message went: the call
 * returned and its result says the recipient took it, or that it went before
 * an error. Only these call the outgoing row "sent"; in every other state the
 * bot only asked to send it (the time is when the call began).
 */
const DELIVERED: ReadonlySet<MessagedKey> = new Set([
  "sent",
  "working",
  "recipient-waiting",
  "no-reply",
  "replied",
  "recipient-stopped",
  "recipient-failed",
  "call-made",
]);

/** The verb of the outgoing row on a Messaged card. */
export function sentVerb(key: MessagedKey): string {
  return DELIVERED.has(key) ? "sent" : "asked to send";
}

/** States that the connection's loss turns into "Last seen …": they stand for work under way. */
export const LIVE_STATES: ReadonlySet<MessagedKey> = new Set(["call-started", "working"]);

function approvalOf(id: string | null, approvals: ApprovalCard[]): ApprovalCard | undefined {
  return id ? approvals.find((each) => each.id === id) : undefined;
}

/** The design's state for a "Messaged <bot>" card, from the engine's. */
export function botMessageKey(card: BotMessageCard): MessagedKey {
  switch (card.state) {
    case "started":
      return "call-started";
    case "waiting-for-approval":
      return "approval";
    case "sent":
      // A timeout that says the message was sent before the error: it went, and no reply came in time.
      return card.resultStatus === "timeout" ? "no-reply" : "sent";
    case "working":
      return "working";
    case "recipient-waiting":
      return "recipient-waiting";
    case "no-reply-yet":
    case "recipient-outcome-unknown":
      return "no-reply";
    case "replied":
      return "replied";
    case "recipient-stopped":
      return "recipient-stopped";
    case "failed":
      // The send was accepted and the recipient's own run then failed: the failure is the recipient's.
      return card.recipientRunState === "failed" &&
        card.resultStatus !== null &&
        card.resultStatus !== "error"
        ? "recipient-failed"
        : "failed";
    case "blocked-by-policy":
      return "blocked";
    case "not-sent":
      return "not-sent";
    case "unknown":
      return "unknown";
  }
}

/** The design's state for a "Messaged T3 Code" card, from the engine's. */
export function mcpKey(
  card: McpCallCard,
  approvals: ApprovalCard[],
  waiting: boolean,
): MessagedKey {
  switch (card.state) {
    case "started":
      return waiting && approvalOf(card.approvalId, approvals)?.status === "pending"
        ? "approval"
        : "call-started";
    case "returned":
      return "call-made";
    case "unknown":
      return "delivery-unknown";
    case "failed":
      return "failed";
    case "not-sent":
      return "not-sent";
  }
}

function senderStopped(run: Pick<Run, "state"> | undefined): boolean {
  return run?.state === "stopped" || run?.state === "stopping" || run?.state === "cancelled";
}

/** Why a card is Not sent, from the approval it waited on. */
function notSentLine(
  approval: ApprovalCard | undefined,
  sender: string,
  run: Pick<Run, "state"> | undefined,
): string {
  if (approval?.status === "denied") return "You denied the approval. Nothing was sent.";
  if (approval?.status === "expired") return "The approval expired. Nothing was sent.";
  if (senderStopped(run))
    return `${sender} was stopped before the call was made. Nothing was sent.`;
  return `${sender} moved on before making this call. Nothing was sent.`;
}

/** What the open card says came back from the recipient, for every state but Working and Replied. */
export function botMessageNote(
  key: MessagedKey,
  card: BotMessageCard,
  names: { sender: string; recipient: string },
  approvals: ApprovalCard[],
  run: Pick<Run, "state"> | undefined,
): string {
  const { sender: s, recipient: r } = names;
  switch (key) {
    case "approval":
      return "This message waits for your approval. Nothing has been sent.";
    case "call-started":
      return `${s} began this call. Nothing yet shows that it was made.`;
    case "sent":
      return `${r} received it. No reply yet.`;
    case "recipient-waiting":
      return `${r} is waiting on its user in its own task: it asked a question, or it needs an approval.`;
    case "no-reply":
      return `${card.resultStatus === "timeout" ? "The message was sent, and no reply came in time." : `${r}'s run finished without a reply.`} A reply that names this message appears here; any other arrives as a message from ${r}.`;
    case "recipient-stopped":
      return `${r}'s run for this message was stopped before it replied.`;
    case "recipient-failed":
      return `${r} received it, and its run for this message then failed.`;
    case "failed":
      return "The call failed.";
    case "blocked":
      return `A messaging rule stopped this${card.error ? `: ${card.error}` : ""}. Nothing was sent.`;
    case "not-sent":
      return notSentLine(approvalOf(card.approvalId, approvals), s, run);
    case "unknown":
      return senderStopped(run)
        ? `${s} was stopped before the call returned. The gateway cannot say whether ${r} received it.`
        : `The call ended without a result that says whether ${r} received it.`;
    default:
      return "";
  }
}

/** What the open T3 Code card says came back. */
export function mcpNote(
  key: MessagedKey,
  card: McpCallCard,
  sender: string,
  approvals: ApprovalCard[],
  run: Pick<Run, "state"> | undefined,
): string {
  switch (key) {
    case "call-started":
      return `${sender} began this call. Nothing yet shows that it was made, and nothing more is reported until it returns.`;
    case "approval":
      return "This call waits for your approval. Nothing has been sent.";
    case "delivery-unknown":
      return senderStopped(run)
        ? `${sender} was stopped before the call returned. The gateway cannot say whether T3 Code received it.`
        : "The call ended without a result that says whether T3 Code received it.";
    case "failed":
      return "The call failed.";
    case "not-sent":
      return notSentLine(approvalOf(card.approvalId, approvals), sender, run);
    default:
      return "";
  }
}

/** Target fields a T3 Code call's arguments carry, as chips: only those present. */
export function targetChips(args: unknown): Row[] {
  const a = record(args);
  if (!a) return [];
  const out: Row[] = [];
  const pick = (label: string, ...keys: string[]) => {
    for (const key of keys) {
      const value = a[key];
      if (typeof value === "string" && value.trim()) return out.push({ label, value });
      if (typeof value === "number") return out.push({ label, value: String(value) });
    }
    return undefined;
  };
  pick("Project", "project", "projectId", "projectName");
  pick("Thread", "thread", "threadId", "threadTitle");
  if (!pick("Branch", "branch")) {
    // T3 Code takes the branch inside `workspaceStrategy`.
    const strategy = record(a.workspaceStrategy);
    const branch = strategy?.branch;
    if (typeof branch === "string" && branch.trim()) out.push({ label: "Branch", value: branch });
  }
  return out;
}

/**
 * The link a T3 Code call's result carries: a `resource_link` in its content,
 * or the `link` its structured result names. Never fetched; opened only when chosen.
 */
export function resultLink(card: McpCallCard): { uri: string; title: string | null } | null {
  if (card.links[0]) return card.links[0];
  const link = record(card.structuredContent)?.link;
  return typeof link === "string" && /^https?:\/\//.test(link) ? { uri: link, title: null } : null;
}

/** A T3 Code call's sent text: its `message`, or the first text argument it carries. */
export function sentText(card: McpCallCard): string | null {
  if (card.text) return card.text;
  const a = record(card.args);
  for (const key of ["text", "prompt", "instructions", "task"]) {
    const value = a?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Who a "Messaged <bot>" card names, from the recipient the call or its result gave. */
export function recipientName(
  card: BotMessageCard,
  bots: Bot[],
): { id: string | null; name: string } {
  const id = card.recipient.agentId;
  if (id) return { id, name: nameOf(bots, id, id) };
  return { id: null, name: card.recipient.label ?? "another bot" };
}

/**
 * A "Started a task" card's state: its mark, its word and its tone. A listed task's state reads
 * as its row in the task list says it (F-587).
 */
export const STARTED_STATES: Record<
  StartedTaskState,
  [string, string, "accent" | "warn" | "danger" | null]
> = {
  starting: ["sending", "Starting", null],
  started: ["check", "Started", null],
  queued: ["queued", "Queued", null],
  working: ["working", "Working", "accent"],
  waiting: ["waiting", "Waiting for you", "warn"],
  blocked: ["blocked", "Blocked", "warn"],
  done: ["done", "Done", null],
  "done-with-failures": ["failed", "Done with failures", "danger"],
  failed: ["failed", "Failed", "danger"],
  stopped: ["stopped", "Stopped", null],
  "couldnt-start": ["failed", "Couldn't start", "danger"],
  unknown: ["queued", "Unknown", null],
};

/** The first line of a message, for the folded card. */
export function firstLineOf(text: string | null): string {
  return text ? (text.split("\n").find((line) => line.trim()) ?? "").trim() : "";
}

/**
 * Whether a card may send this command on this connection. Deciding on an
 * approval needs approval access, answering a question needs question
 * access; checked where the command is sent, whatever control asked for it.
 */
export function mayDispatch(
  command: { type: string },
  connection: { canApprove: boolean; canAnswer: boolean },
): boolean {
  switch (command.type) {
    case "resolveApproval":
      return connection.canApprove;
    case "answerQuestion":
    case "dismissQuestion":
      return connection.canAnswer;
    default:
      return true;
  }
}
