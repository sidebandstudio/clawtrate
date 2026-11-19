// The action cards (docs/design/conversation.md, sections 7 to 9): a single
// card, a fold and its rows, the "Thought" line and the run line. What each
// says is the engine's reading (`@clawtrate/core`, `actions.ts`); these
// components only draw it and keep what the reader opened (`view-state.ts`).

import { StepFileLinks } from "../work/links.tsx";
import {
  actionWords,
  foldLineOf,
  isOpenOutcome,
  lineOf,
  readableOf,
  tookOf,
  type ActionCall,
  type ActionLine,
  type FoldLine,
  type FeedMember,
  type ReadingContext,
  type RunLine,
  type Step,
  type StepRaw,
  type Thought,
} from "@clawtrate/core";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CardFoot,
  CodeBlock,
  CopyButton,
  Fields,
  Glyph,
  RawView,
  formatJson,
  timeOf,
  tookOf as tookText,
  useRawDisclosure,
} from "../cards/parts.tsx";
import type { RawContent } from "../cards/raw.ts";
import type { StepRawState } from "../cards/useCards.ts";
import { useStepHandover } from "../cards/context.tsx";
import { ChevronIcon, FileIcon } from "../icons.tsx";
import { useNow } from "../StatusLine.tsx";
import { KindIcon } from "./icons.tsx";
import { readView, useView, viewKeys, writeView } from "./view-state.ts";
import "./actions.css";

const { tookWords, elapsedWords, thoughtFor, durationWords } = actionWords;

/** What every action card in one task shares. */
export type ActionEnv = {
  taskKey: string;
  sessionKey: string;
  ctx: ReadingContext;
  /** The engine's step for a call, and its run's id, when it has one. */
  stepOf: (callId: string) => { step: Step; runId: string } | undefined;
  /** A step's raw payload, read whole when needed. */
  rawState: (stepId: string) => StepRawState;
  /** The connection is down: what was running is last seen. */
  lost: boolean;
  /** Approvals are not sent on this connection. */
  readOnly: boolean;
  /** The reasoning effort the task asks for, when its row records one. */
  effort: string | null;
  /** The feed has been drawn once: a card or row drawn now arrived live, and rises in (7.4). */
  arriving: () => boolean;
};

/** A card or row that arrived after the feed was first drawn: it rises 4 px over 200 ms. */
function useArrived(env: ActionEnv): true | undefined {
  const [fresh] = useState(() => env.arriving());
  return fresh || undefined;
}

/** A fold's row, rising in when it arrived live. */
function FoldItem({ children }: { children: ReactNode }) {
  const fresh = useArrived(useActionEnv());
  return <li data-fresh={fresh}>{children}</li>;
}

export const ActionEnvContext = createContext<ActionEnv | null>(null);

export function useActionEnv(): ActionEnv {
  const env = useContext(ActionEnvContext);
  if (!env) throw new Error("action cards need an ActionEnvContext");
  return env;
}

/** The DOM id of a call's card or row, so the status line and "Show in chat" can find it. */
export const actionDomId = (callId: string) => `action-${callId.replace(/[^\w-]/g, "_")}`;

/** The call as this connection sees it: last seen while the connection is lost, the read tier's waiting words. */
function seen(call: ActionCall, env: ActionEnv): ActionCall {
  return { ...call, lastSeen: env.lost, readOnly: env.readOnly };
}

// The line --------------------------------------------------------------------------

/** "0:42" once something has run for more than 2 seconds. */
function Elapsed({ since }: { since: number | null }) {
  const now = useNow(since !== null);
  if (since === null || now - since < 2000) return null;
  return <span className="action-elapsed">{elapsedWords(now - since)}</span>;
}

function StateOf({ line, call }: { line: ActionLine; call: ActionCall }) {
  const s = line.state;
  if (s.type === "time") {
    const took = tookOf(call);
    return took !== null ? <time className="action-time">{tookWords(took)}</time> : null;
  }
  if (s.type === "elapsed") return <Elapsed since={call.startedAt} />;
  return (
    <>
      <Glyph state={s.glyph} />
      {s.word}
    </>
  );
}

function Detail({
  text,
  mono,
  exit,
  tone,
}: {
  text: string;
  mono: boolean;
  exit?: string;
  tone?: string | null;
}) {
  return (
    <span className="action-detail" data-tone={tone ?? undefined}>
      {text ? <span className={mono ? "mono" : undefined}>{text}</span> : null}
      {exit ? <span className="action-exit">{exit}</span> : null}
    </span>
  );
}

/**
 * A card's line, single or folded: the verb, the icon and what it acted on as
 * one sentence; the detail; the state (7.2). One component for both, so the
 * line keeps its element when a card becomes a fold.
 */
function LineSummary({
  verb,
  object,
  icon,
  working,
  detail,
  mono,
  exit,
  detailTone,
  stateTone,
  state,
  spoken,
  title,
}: {
  verb: string;
  object: string;
  icon: ActionLine["icon"];
  working: boolean;
  detail: string;
  mono: boolean;
  exit?: string;
  detailTone?: string | null;
  stateTone?: string | undefined;
  state: ReactNode;
  spoken: string;
  title: string;
}) {
  return (
    <summary aria-label={spoken} title={title}>
      <span className="action-sentence">
        <span className="action-verb">{verb}</span>{" "}
        <span className="action-what">
          {working ? <Glyph state="working" /> : <KindIcon icon={icon} />}
          {object ? <span className="action-object">{object}</span> : null}
        </span>
      </span>
      <Detail text={detail} mono={mono} {...(exit ? { exit } : {})} tone={detailTone ?? null} />
      <span className="action-state" data-tone={stateTone}>
        {state}
      </span>
      <ChevronIcon className="chevron" />
    </summary>
  );
}

// Opened: Readable and Raw ------------------------------------------------------------

const rec = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** What the gateway sent for one call, as section 9 lays it out. */
function rawContentOf(call: ActionCall, env: ActionEnv): { content: RawContent; load: () => void } {
  const found = env.stepOf(call.id);
  const open = call.status === "running" || call.status === "waiting" || call.status === "review";
  const timing = [
    { label: "Started", value: timeOf(call.startedAt) },
    { label: "Ended", value: open ? "not reported" : timeOf(call.endedAt) },
    { label: "Took", value: open ? "not reported" : tookText(call.startedAt, call.endedAt) },
  ];
  const ids = [
    { label: "Tool call", value: call.id },
    ...(found ? [{ label: "Run", value: found.runId }] : []),
    { label: "Session", value: env.sessionKey },
  ];
  // Only what was received, each part under its own heading; a part that was not received or
  // not kept says so in words, and nothing is drawn from an absent value (section 9).
  const missing: Array<{ label: string; text: string }> = [];
  const parts: Partial<Pick<Loaded, "args" | "argsLabel" | "result" | "error" | "resultLabel">> =
    {};
  if (!found) {
    // Only the history item's row is here: its arguments and result text as the page kept them,
    // an explicit null as null, and no arguments where the row had none.
    const row = call.rowArgs;
    if (row && !row.kept) missing.push({ label: "Arguments", text: "Arguments weren't kept." });
    else {
      parts.args = row ? row.value : call.args;
      parts.argsLabel = "Arguments, from the history the gateway returned";
    }
    if (call.text !== null) {
      if (call.isError) parts.error = call.text;
      else parts.result = call.text;
      parts.resultLabel = call.isError
        ? "Error text, from the history the gateway returned"
        : "Result text, from the history the gateway returned";
    } else if (!open)
      missing.push({
        label: "Result",
        text: "The gateway's history holds no result for this call.",
      });
    return {
      load: () => {},
      content: {
        state: "loaded",
        tool: call.name,
        ...parts,
        ...(missing.length ? { missing } : {}),
        running: open,
        timing,
        ids,
        notes: ["From the history the gateway returned; this app keeps no more of this call."],
      },
    };
  }
  const state = env.rawState(found.step.id);
  if (state.state === "pending") return { content: state.content, load: state.load };
  const raw: StepRaw | null = state.raw;
  const notes: string[] = [];
  if (state.cut) notes.push(state.cut);
  if (raw) {
    // The call's start as received: its arguments under the key the gateway sent them in.
    const callRec = rec(raw.call);
    const argsKey =
      raw.source === "live"
        ? callRec && "args" in callRec
          ? "args"
          : null
        : callRec && "arguments" in callRec
          ? "arguments"
          : callRec && "input" in callRec
            ? "input"
            : null;
    if (argsKey) parts.args = callRec![argsKey];
    else
      missing.push({
        label: "Arguments",
        text: callRec
          ? "The call's start as received names no arguments."
          : "This app received no start for this call, so its arguments are not here.",
      });
    // Its result as received, if one was.
    const resultRec = rec(raw.result);
    const received =
      raw.result === null || raw.result === undefined
        ? undefined
        : raw.source === "live" && resultRec && "result" in resultRec
          ? resultRec.result
          : raw.result;
    if (received !== undefined) {
      if (call.isError) parts.error = formatJson(received);
      else parts.result = received;
    } else if (!open)
      missing.push({
        label: "Result",
        text:
          raw.source === "history"
            ? "The gateway's history holds no result for this call."
            : "No result for this call was received.",
      });
  } else {
    notes.push(
      "This app no longer holds what the gateway sent; only the texts it keeps of the call are here.",
    );
    const argsText = found.step.argsText?.text;
    if (argsText !== undefined) {
      parts.args = argsText;
      parts.argsLabel = "Arguments, as this app keeps them";
    } else missing.push({ label: "Arguments", text: "This app keeps no arguments for this call." });
    if (call.text !== null && !open) {
      if (call.isError) parts.error = call.text;
      else parts.result = call.text;
      parts.resultLabel = call.isError
        ? "Error text, as this app keeps it"
        : "Result text, as this app keeps it";
    } else if (!open)
      missing.push({ label: "Result", text: "This app keeps no result for this call." });
  }
  if (!("args" in parts) && !("result" in parts) && !("error" in parts) && !open)
    return {
      load: state.load,
      content: {
        state: "unavailable",
        reason: "Neither this call's arguments nor its result were received or kept.",
      },
    };
  return {
    load: state.load,
    content: {
      state: "loaded",
      tool: call.name,
      ...parts,
      ...(missing.length ? { missing } : {}),
      running: open,
      truncated: found.step.truncated || Boolean(state.cut),
      timing,
      ids,
      ...(notes.length ? { notes } : {}),
    },
  };
}

type Loaded = Extract<RawContent, { state: "loaded" }>;

function Readable({ call, env }: { call: ActionCall; env: ActionEnv }) {
  const view = readableOf(call, env.ctx);
  const truncated = env.stepOf(call.id)?.step.truncated ? "text" : undefined;
  return (
    <>
      <Fields
        rows={view.rows.map((row) => ({
          label: row.label,
          value: row.value,
          ...(row.mono ? { mono: true } : {}),
        }))}
      />
      {view.sentence && <p className="action-note">{view.sentence}</p>}
      {view.note && (
        <p className="action-note" data-tone="warn">
          {view.note}
        </p>
      )}
      {view.links.length > 0 && (
        <ul className="action-links">
          {view.links.map((link) => (
            <li key={link.url}>
              <a href={link.url} target="_blank" rel="noreferrer noopener">
                {link.title}
              </a>
              <span>{link.host}</span>
            </li>
          ))}
        </ul>
      )}
      {view.plan.length > 0 && (
        <ul className="action-plan">
          {view.plan.map((step, i) => (
            <li key={i} data-status={step.status}>
              {step.status === "completed" ? (
                <Glyph state="check" />
              ) : step.status === "in_progress" ? (
                <Glyph state="working" />
              ) : (
                <span className="plan-dot" aria-hidden="true" />
              )}
              {step.step}
              <span className="visually-hidden">, {step.status.replace("_", " ")}</span>
            </li>
          ))}
        </ul>
      )}
      {view.files.length > 0 && (
        <div className="chips">
          {view.files.map((file) => (
            <span className="chip" key={file}>
              <FileIcon />
              <span>{file.split("/").at(-1)}</span>
            </span>
          ))}
        </div>
      )}
      {view.block && (
        <CodeBlock
          label={view.block.label}
          text={view.block.text}
          copy={view.block.live ? "output" : view.block.label.toLowerCase()}
          {...(view.block.error ? { tone: "danger" as const } : {})}
          {...(truncated && !view.block.live ? { truncated } : {})}
        />
      )}
      {view.empty && <p className="action-note">{view.empty}</p>}
      {view.exitCode !== null && (
        <Fields rows={[{ label: "Exit code", value: String(view.exitCode) }]} />
      )}
    </>
  );
}

/** The Readable and Raw tabs of one call (8.6). One tab stop; the arrows move between them. */
function ActionDetail({ call }: { call: ActionCall }) {
  const env = useActionEnv();
  const [view, setView] = useView<string>(env.taskKey, viewKeys.view(call.id), "readable");
  const id = actionDomId(call.id);
  const raw = rawContentOf(call, env);
  const loaded = useRef(false);
  useEffect(() => {
    if (view === "raw" && !loaded.current) {
      loaded.current = true;
      raw.load();
    }
  }, [view, raw]);
  const choose = (next: string, focus: boolean) => {
    setView(next);
    if (focus) requestAnimationFrame(() => document.getElementById(`${id}-tab-${next}`)?.focus());
  };
  const onKey = (event: KeyboardEvent) => {
    const order = ["readable", "raw"];
    const at = order.indexOf(view);
    const next =
      event.key === "ArrowRight"
        ? order[(at + 1) % 2]
        : event.key === "ArrowLeft"
          ? order[(at + 1) % 2]
          : event.key === "Home"
            ? "readable"
            : event.key === "End"
              ? "raw"
              : null;
    if (!next) return;
    event.preventDefault();
    choose(next, true);
  };
  const tab = (key: string, label: string) => (
    <button
      type="button"
      role="tab"
      id={`${id}-tab-${key}`}
      aria-controls={`${id}-${key}`}
      aria-selected={view === key}
      tabIndex={view === key ? 0 : -1}
      data-view-button={key}
      onClick={() => choose(key, false)}
    >
      {label}
    </button>
  );
  return (
    <div className="step-body">
      <div className="step-tools">
        <div className="seg" role="tablist" aria-label="Detail view" onKeyDown={onKey}>
          {tab("readable", "Readable")}
          {tab("raw", "Raw")}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-readable`}
        aria-labelledby={`${id}-tab-readable`}
        data-view="readable"
        hidden={view !== "readable"}
      >
        {/* The files this action named, linked to the Work pane's Files tab, and back to them. */}
        <StepFileLinks callId={call.id} />
        <Readable call={call} env={env} />
      </div>
      <div
        role="tabpanel"
        id={`${id}-raw`}
        aria-labelledby={`${id}-tab-raw`}
        data-view="raw"
        hidden={view !== "raw"}
      >
        {view === "raw" && (
          <div className="raw-panel" role="region" aria-label="What the gateway sent">
            <RawView raw={raw.content} />
          </div>
        )}
      </div>
    </div>
  );
}

function ActionBody({
  call,
  thought,
  revision,
}: {
  call: ActionCall;
  thought: Thought | null;
  revision: number;
}) {
  return (
    <div className="action-body">
      {thought && (
        <div className="action-thought">
          <ThoughtLine thought={thought} place="card" revision={revision} />
        </div>
      )}
      <ActionDetail call={call} />
    </div>
  );
}

// A fold -----------------------------------------------------------------------------

const ROW_STATUS: Record<string, string> = {
  running: "running",
  review: "running",
  waiting: "waiting",
  failed: "failed",
  blocked: "failed",
  unavailable: "failed",
  notfound: "skipped",
  refused: "skipped",
  denied: "skipped",
  suppressed: "skipped",
  stopped: "skipped",
  unknown: "skipped",
};

/** A row inside an opened fold: the action in the singular (7.4). */
function FoldRow({ member, revision }: { member: FeedMember; revision: number }) {
  const env = useActionEnv();
  const call = seen(member.call, env);
  const line = lineOf(call, env.ctx);
  const [open, setOpen] = useView<boolean>(env.taskKey, viewKeys.call(call.id), false);
  const working = (line.outcome === "running" || line.outcome === "review") && !line.leaves;
  return (
    <details
      className="step"
      data-testid="tool-call"
      data-call={call.id}
      id={actionDomId(call.id)}
      data-status={ROW_STATUS[line.outcome] ?? "done"}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label={line.spoken} title={line.title}>
        <span className="step-node">
          {working ? <Glyph state="working" /> : <KindIcon icon={line.icon} />}
        </span>
        <span className="step-title">{[line.verb, line.object].filter(Boolean).join(" ")}</span>
        <span className="step-detail">
          {line.detail ? (
            <span className={line.mono ? "mono" : undefined}>{line.detail}</span>
          ) : null}
        </span>
        <span className="step-status">
          <StateOf line={line} call={call} />
        </span>
        <ChevronIcon className="chevron" />
      </summary>
      {/* Its readable view is drawn, and formatted, only once the row is opened. */}
      {open && member.thought && (
        <div className="action-thought">
          <ThoughtLine thought={member.thought} place="card" revision={revision} />
        </div>
      )}
      {open && <ActionDetail call={call} />}
    </details>
  );
}

function FoldState({ fold }: { fold: FoldLine }) {
  const s = fold.state;
  switch (s.type) {
    case "waiting":
      return (
        <>
          <Glyph state="waiting" />
          {s.readOnly ? "Waiting for approval" : "Waiting for you"}
        </>
      );
    case "running":
      return s.lastSeen ? (
        <>
          <Glyph state="working" />
          Last seen running
        </>
      ) : (
        <Elapsed since={s.since} />
      );
    case "counts":
      return (
        <>
          <Glyph state={s.glyph} />
          {s.words}
        </>
      );
    case "time":
      return s.ms !== null ? <time className="action-time">{tookWords(s.ms)}</time> : null;
  }
}

/**
 * One card for one call (7.2), or one card for several calls with one key in a
 * row (7.4). One component draws both, so that when a card becomes a fold its
 * line, the same element, keeps its place and its focus.
 */
export function ActionGroup({ members, revision }: { members: FeedMember[]; revision: number }) {
  const env = useActionEnv();
  const calls = members.map((m) => seen(m.call, env));
  const first = calls[0]!.id;
  const single = calls.length === 1;
  const line = single ? lineOf(calls[0]!, env.ctx) : null;
  const fold = single ? null : foldLineOf(calls, env.ctx);
  // A card that was open becomes a fold that is open, with that card as its open first row.
  const [cardOpen, setCardOpen] = useView<boolean>(env.taskKey, viewKeys.call(first), false);
  // A fold split by a reconciliation: the part after it opens if the fold it came from was open.
  // Taken once, when this group first becomes a fold: later its members name it as their own fold.
  const opensAsFold = () => {
    const from = readView(env.taskKey, viewKeys.member(first));
    return (
      readView(env.taskKey, viewKeys.call(first)) === true ||
      (typeof from === "string" && readView(env.taskKey, viewKeys.fold(from)) === true)
    );
  };
  const [startsOpen, setStartsOpen] = useState<boolean | null>(() =>
    single ? null : opensAsFold(),
  );
  if (!single && startsOpen === null) setStartsOpen(opensAsFold());
  const [foldOpen, setFoldOpen] = useView<boolean>(
    env.taskKey,
    viewKeys.fold(first),
    startsOpen ?? (!single && opensAsFold()),
  );
  // Remember which fold each member is in, once drawn.
  const memberKey = calls.map((c) => c.id).join("|");
  useEffect(() => {
    if (single) return;
    for (const id of memberKey.split("|")) writeView(env.taskKey, viewKeys.member(id), first);
  }, [env.taskKey, first, memberKey, single]);
  const open = single ? cardOpen : foldOpen;
  const setOpen = single ? setCardOpen : setFoldOpen;
  // A call that becomes the T3 Code card once its result names it hands that
  // card how the reader left it: open or closed, and whether focus was in it.
  const handover = useStepHandover();
  const note = (element: HTMLDetailsElement, focused: boolean) => {
    if (single) handover?.note(first, { open: element.open, focused, from: "step" });
  };
  // Drawn again after its T3 Code card, when the result named another tool: as the card was.
  const element = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (!single) return;
    const state = handover?.stateOf(first);
    const details = element.current;
    if (state?.from !== "card" || !(state.open || state.focused) || !details) return;
    if (state.open) {
      writeView(env.taskKey, viewKeys.call(first), true);
      // The card's Raw view becomes the action's Raw tab.
      if (state.raw) writeView(env.taskKey, viewKeys.view(first), "raw");
      details.open = true;
    }
    if (!state.focused) return;
    // Focus goes to the same control as on the card, once the view it is in is drawn.
    const control = state.control ?? null;
    const focus = () => {
      const named = control
        ? [...details.querySelectorAll<HTMLElement>("button, [role=tab], a, summary")].find(
            (each) =>
              each.offsetParent !== null &&
              (each.getAttribute("aria-label") ?? each.textContent?.trim()) === control,
          )
        : undefined;
      (named ?? details.querySelector<HTMLElement>(":scope > summary"))?.focus({
        preventScroll: true,
      });
    };
    if (control) requestAnimationFrame(() => requestAnimationFrame(focus));
    else focus();
    // Once, as it is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fresh = useArrived(env);
  const common = {
    ref: element,
    className: "card action",
    "data-fresh": fresh,
    open,
    onToggle: (event: { currentTarget: HTMLDetailsElement }) => {
      if (event.currentTarget.open !== open) setOpen(event.currentTarget.open);
      note(event.currentTarget, event.currentTarget.contains(document.activeElement));
    },
    onFocus: (event: { currentTarget: HTMLDetailsElement }) => note(event.currentTarget, true),
    onBlur: (event: { currentTarget: HTMLDetailsElement; relatedTarget: EventTarget | null }) =>
      note(event.currentTarget, event.currentTarget.contains(event.relatedTarget as Node | null)),
  };
  if (line) {
    const member = members[0]!;
    return (
      <details
        {...common}
        data-kind={line.kind}
        data-status={line.outcome}
        data-problem={line.problem ?? undefined}
        data-call={first}
        id={actionDomId(first)}
        data-testid="tool-call"
      >
        <LineSummary
          verb={line.verb}
          object={line.object}
          icon={line.icon}
          working={isOpenOutcome(line.outcome) && line.outcome !== "waiting" && !line.leaves}
          detail={line.detail}
          mono={line.mono}
          exit={line.exit}
          stateTone={line.state.type === "word" ? line.state.tone : undefined}
          state={<StateOf line={line} call={calls[0]!} />}
          spoken={line.spoken}
          title={line.title}
        />
        {/* Its readable view is drawn, and formatted, only once the card is opened. */}
        {open && <ActionBody call={calls[0]!} thought={member.thought} revision={revision} />}
      </details>
    );
  }
  const f = fold!;
  const label = `${f.verb} ${f.object}`.trim();
  const working =
    f.state.type === "running" && f.running !== null && !f.running.leaves && f.tone === null;
  return (
    <details
      {...common}
      data-fold={calls.length}
      data-kind={f.kind}
      data-status={f.status}
      data-first={first}
      id={`fold-${actionDomId(first)}`}
    >
      <LineSummary
        verb={f.verb}
        object={f.object}
        icon={f.icon}
        working={working}
        detail={f.detail}
        mono={false}
        detailTone={f.tone}
        stateTone={
          f.state.type === "waiting"
            ? "warn"
            : f.state.type === "counts" && f.state.danger
              ? "danger"
              : undefined
        }
        state={<FoldState fold={f} />}
        spoken={f.spoken}
        title={f.title}
      />
      <div className="action-body">
        <ol className="fold-rows" aria-label={label}>
          {members.map((member) => (
            <FoldItem key={member.call.id}>
              <FoldRow member={member} revision={revision} />
            </FoldItem>
          ))}
        </ol>
      </div>
    </details>
  );
}

// Reasoning ----------------------------------------------------------------------------

/** What the gateway sent for reasoning: each segment's event as received. */
function thoughtRaw(thought: Thought, env: ActionEnv): { content: RawContent; load: () => void } {
  const states = thought.segments.map((segment) => env.rawState(segment.id));
  const pending = states.find((s) => s.state === "pending");
  const load = () => states.forEach((s) => s.load());
  if (pending && pending.state === "pending") return { content: pending.content, load };
  const events: Array<[string, unknown]> = [];
  states.forEach((s, i) => {
    if (s.state !== "available" || !s.raw) return;
    const label =
      s.raw.source === "live"
        ? `Reasoning event as received${states.length > 1 ? ` (${i + 1})` : ""}`
        : `Reasoning as the gateway's history returned it${states.length > 1 ? ` (${i + 1})` : ""}`;
    events.push([label, s.raw.call]);
  });
  return {
    load,
    content: {
      state: "loaded",
      events,
      ids: [
        { label: "Reasoning", value: thought.id },
        { label: "Session", value: env.sessionKey },
      ],
      ...(events.length ? {} : { notes: ["The gateway did not keep this event."] }),
    },
  };
}

/**
 * "Thought for 4s": inside the card it led to, over the reply, or at the end
 * of a run. Folded always until opened; its open state lasts only while its
 * run's reasoning revision is unchanged (7.5).
 */
export function ThoughtLine({
  thought,
  place,
  revision,
}: {
  thought: Thought;
  place: "card" | "reply" | "end";
  revision: number;
}) {
  const env = useActionEnv();
  const [open, setOpen] = useView<boolean>(
    env.taskKey,
    viewKeys.thought(thought.id, revision),
    false,
  );
  const raw = thoughtRaw(thought, env);
  const disclosure = useRawDisclosure(raw.load);
  return (
    <details
      className="thought"
      data-place={place}
      data-thought={thought.id}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="event-line">
        {thoughtFor(thought.ms !== null ? durationWords(thought.ms) : null)}
        <ChevronIcon className="chevron" />
      </summary>
      <div className="thought-body">
        {thought.segments.map((segment) => (
          <p className="step-thought" key={segment.id}>
            {segment.text}
          </p>
        ))}
        <CardFoot disclosure={disclosure} raw={raw.content} />
      </div>
    </details>
  );
}

// The run line -------------------------------------------------------------------------

/** "Worked for 1m 12s · 14 actions", after everything the run put in the transcript (7.7). */
export function RunLineView({
  runId,
  line,
  model,
  provider = null,
  modelFrom = null,
  effort = null,
}: {
  runId: string;
  line: RunLine;
  model: string | null;
  /** The provider the gateway reported with the model. */
  provider?: string | null;
  /** Which report the model comes from: the run's `model` event, or its history row. */
  modelFrom?: "lifecycle" | "history" | null;
  /** The effort the task asked for when this app started the turn, as its row named it (25.5). */
  effort?: { effort: string; from: "thinkingLevel" | "thinkingDefault" } | null;
}) {
  const env = useActionEnv();
  const [open, setOpen] = useView<boolean>(env.taskKey, viewKeys.run(runId), false);
  const named = model ? (provider ? `${provider}/${model}` : model) : null;
  const record = `${named ?? actionWords.RUN_LINE.modelNotReported} · ${actionWords.RUN_LINE.effort(effort?.effort ?? null)}`;
  const disclosure = useRawDisclosure();
  // What the record is made of, each part labelled; a part with nothing behind it is absent.
  const events: Array<[string, unknown]> = [];
  if (model)
    events.push(
      modelFrom === "history"
        ? ["Model, from the history row", provider ? { provider, model } : { model }]
        : [
            "Model, as the gateway sends it",
            provider ? { phase: "model", provider, model } : { phase: "model", model },
          ],
    );
  if (effort)
    events.push([
      "The task's effort when this turn was sent, from its row",
      { [effort.from]: effort.effort },
    ]);
  const raw: RawContent = {
    state: "loaded",
    events,
    ids: [
      { label: "Run", value: runId },
      { label: "Session", value: env.sessionKey },
    ],
    ...(events.length ? {} : { notes: ["The gateway reported no model for this turn."] }),
  };
  return (
    <details
      className="run-line"
      data-testid="run-line"
      data-run={runId}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="event-line" title={record} aria-label={line.text}>
        <span className="run-label">{line.label}</span>
        <span aria-hidden="true">·</span>
        <span className="run-count">
          {line.actions} {line.actions === 1 ? "action" : "actions"}
        </span>
        {line.shown < line.actions && (
          <>
            <span aria-hidden="true">·</span>
            <span className="run-shown">{line.shown} shown</span>
          </>
        )}
        {line.failed > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="run-failed">{line.failed} failed</span>
          </>
        )}
        {line.problems.map((problem) => (
          <span key={problem}>
            <span aria-hidden="true">· </span>
            <span className="run-problem">{problem}</span>
          </span>
        ))}
        <ChevronIcon className="chevron" />
      </summary>
      <p className="run-record">
        <span>{record}</span>
        <span aria-hidden="true">·</span>
        <span className="mono">{runId}</span>
        <CopyButton what="run id" text={runId} />
      </p>
      {/* Raw takes the card's own styles, on the stage rather than on a card's surface. */}
      <div className="card run-raw">
        <CardFoot disclosure={disclosure} raw={raw} />
      </div>
    </details>
  );
}
