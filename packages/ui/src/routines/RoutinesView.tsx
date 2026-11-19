// The Routines view (automation.md sections 3 to 7): every routine on the
// gateway by bot, or one bot's; the calendar; a routine's page with its runs;
// and a run's conversation. It takes the conversation's place in the main
// pane. Everything here reads; the gateway's scheduled jobs are changed in the
// editor and the row and page actions, which come with admin access later.

import type { Bot, ClawtrateState, Routine, RoutineRun } from "@clawtrate/core";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "../Avatar.tsx";
import { useBridge } from "../bridge.tsx";
import { BackIcon, ChevronIcon, ClockIcon } from "../icons.tsx";
import { Markdown } from "../Markdown.tsx";
import { Note } from "../bots/parts.tsx";
import { Calendar } from "./Calendar.tsx";
import { useKeyedRead } from "./read.ts";
import {
  fullWhen,
  ownerOf,
  routineZone,
  runKey,
  runOutcome,
  scheduleWords,
  triggerWords,
  viewerZone,
  when,
  zoneCity,
  zoneWords,
} from "./schedule.ts";
import "./routines.css";

export type RoutinesMode = "list" | "day" | "3day" | "week";

/** Where the view is: its mode and bot, and the routine and run open in it. */
export type RoutinesNav = {
  mode: RoutinesMode;
  bot: string | null;
  routine: string | null;
  /**
   * A run of the open routine: the one chosen on its page, or the one a row in
   * the rail names by its start, until its read finds it and it is bound.
   */
  run: RoutineRun | { runAt: number } | null;
};

const isRun = (run: RoutinesNav["run"]): run is RoutineRun => run !== null && "jobId" in run;

const capital = (text: string) => text[0]!.toUpperCase() + text.slice(1);

export const ROUTINES_HOME: RoutinesNav = { mode: "list", bot: null, routine: null, run: null };

const MODES: Array<[RoutinesMode, string]> = [
  ["list", "List"],
  ["day", "Day"],
  ["3day", "3 days"],
  ["week", "Week"],
];

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Enabled routines by next run, then paused ones by name (automation.md section 3). */
export function ordered(routines: Routine[]): Routine[] {
  return [...routines].sort((a, b) =>
    a.enabled !== b.enabled
      ? a.enabled
        ? -1
        : 1
      : a.enabled
        ? (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name),
  );
}

/** The schedule as a row and the page say it, with its zone: "Weekdays at 8:00 AM, New York". */
export function scheduleLine(routine: Routine): { text: string; written: boolean } {
  const words = scheduleWords(routine.schedule);
  const zone = zoneWords(routine.schedule);
  return { text: zone ? `${words.text}, ${zone}` : words.text, written: words.written };
}

/** The zone a routine's times are said in: its own, else the viewer's. */
const zoneOf = (routine: Routine) => routineZone(routine.schedule) ?? viewerZone();

function lastWords(routine: Routine, now: number): { text: string; failed: boolean } {
  if (routine.lastRunAt === null) return { text: "No runs yet", failed: false };
  const day = when(routine.lastRunAt, now, zoneOf(routine)).replace(/ \d+:\d+\s[AP]M$/u, "");
  const outcome =
    routine.lastStatus === "error"
      ? "failed"
      : routine.lastStatus === "skipped"
        ? "skipped"
        : "succeeded";
  return { text: `Last ${day}, ${outcome}`, failed: routine.lastStatus === "error" };
}

/** Line two of a row: running, paused, or schedule, next and last (section 5). */
function RowLine({ routine, now }: { routine: Routine; now: number }) {
  const words = scheduleWords(routine.schedule);
  const zone = zoneWords(routine.schedule);
  const sched = words.written ? (
    <>
      <code className="r-mono">{words.text}</code>
      {zone && `, ${zone}`}
    </>
  ) : (
    scheduleLine(routine).text
  );
  if (routine.runningAt !== null)
    return (
      <span className="r-row-line">
        Running since {when(routine.runningAt, now, zoneOf(routine)).replace(/^today /u, "")}
      </span>
    );
  if (!routine.enabled) return <span className="r-row-line">Paused · {sched}</span>;
  const last = lastWords(routine, now);
  return (
    <span className="r-row-line">
      {sched}
      {routine.nextRunAt !== null && ` · Next ${when(routine.nextRunAt, now, zoneOf(routine))}`}
      {" · "}
      {last.failed ? (
        <>
          {last.text.replace(/failed$/u, "")}
          <span data-tone="danger">failed</span>
        </>
      ) : (
        last.text
      )}
    </span>
  );
}

function rowLabel(routine: Routine, bot: string, now: number): string {
  const schedule = scheduleLine(routine).text;
  if (routine.runningAt !== null) return `${routine.name}, ${bot}, running`;
  if (!routine.enabled) return `${routine.name}, ${bot}, paused, ${schedule}`;
  const next =
    routine.nextRunAt === null ? "" : `, next run ${when(routine.nextRunAt, now, zoneOf(routine))}`;
  return `${routine.name}, ${bot}, ${schedule}${next}, ${lastWords(routine, now).text.toLowerCase()}`;
}

function Mark({ routine }: { routine: Routine }) {
  if (routine.runningAt !== null)
    return <span className="glyph" data-state="working" aria-hidden="true" />;
  if (routine.enabled && routine.lastStatus === "error")
    return <span className="glyph" data-state="failed" aria-hidden="true" />;
  return null;
}

function List({
  routines,
  bots,
  bot,
  now,
  onOpen,
}: {
  routines: Routine[];
  bots: Bot[];
  bot: string | null;
  now: number;
  onOpen: (id: string) => void;
}) {
  const groups = owners(bots, routines)
    .filter((each) => bot === null || each.id === bot)
    .map((each) => ({ bot: each, rows: ordered(routines.filter((r) => r.botId === each.id)) }))
    .filter((group) => group.rows.length > 0 || bot !== null);
  if (groups.length === 0 || (bot !== null && groups[0]!.rows.length === 0)) {
    const named = bot !== null ? ownerOf(bots, bot) : null;
    return (
      <div className="work-empty r-empty" data-testid="routines-empty">
        <span className="work-empty-mark">
          <ClockIcon />
        </span>
        {named ? (
          <p className="work-empty-title">{named.name} has no routines.</p>
        ) : (
          <>
            <p className="work-empty-title">No routines yet</p>
            <p className="work-empty-text">
              A routine runs one of your bots on a schedule: a morning summary, a weekly check.
            </p>
          </>
        )}
      </div>
    );
  }
  return (
    <>
      {groups.map(({ bot: each, rows }) => (
        <section key={each.id} aria-labelledby={`r-group-${each.id}`}>
          <div className="r-group">
            <Avatar bot={each} />
            <h2 id={`r-group-${each.id}`}>{each.name}</h2>
          </div>
          <ul className="r-rows" aria-label={each.name}>
            {rows.map((routine) => (
              <li key={routine.id}>
                <div
                  className="r-row"
                  data-paused={!routine.enabled || undefined}
                  data-testid="routine-row"
                  data-routine={routine.id}
                >
                  <button
                    type="button"
                    className="r-row-main"
                    aria-label={rowLabel(routine, each.name, now)}
                    title={routine.name}
                    onClick={() => onOpen(routine.id)}
                  >
                    <span className="r-row-mark">
                      <Mark routine={routine} />
                    </span>
                    <span className="r-row-text">
                      <span className="r-row-name">{routine.name}</span>
                      <RowLine routine={routine} now={now} />
                    </span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** Every bot with a routine, in the gateway's order, then any the client does not hold, named by id. */
function owners(bots: Bot[], routines: Routine[]): Bot[] {
  const known = new Set(bots.map((each) => each.id));
  const absent = [...new Set(routines.map((each) => each.botId))].filter((id) => !known.has(id));
  return [...bots, ...absent.map((id) => ownerOf(bots, id))];
}

/**
 * A routine's runs, for one gateway, read again whenever its last run or
 * running state changes (the `cron` event's `started` and `finished` move
 * those). An answer for another routine or revision is never shown.
 */
function useRuns(gateway: string, routine: Routine | undefined) {
  const bridge = useBridge();
  const id = routine?.id ?? null;
  return useKeyedRead(
    id === null ? null : `${gateway}:${id}:${routine?.lastRunAt ?? ""}:${routine?.runningAt ?? ""}`,
    () => bridge.invoke({ type: "readRoutineRuns", id: id! }),
  );
}

function Retry({ text, error, onRetry }: { text: string; error: string; onRetry: () => void }) {
  return (
    <p className="r-hint" data-testid="read-error">
      {text} {error}{" "}
      <button type="button" className="button" data-size="sm" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}

function runsIn(routine: Routine, bot: string): string {
  if (routine.target === "isolated") return "A new conversation each time";
  if (routine.target === "main") return `${bot}'s main conversation`;
  return "The conversation it was made in";
}

function resultsWords(routine: Routine): string {
  if (routine.delivery === "none") return "Kept with the run";
  if (routine.deliveryChannel) return `Sent to ${routine.deliveryChannel}`;
  if (routine.delivery === "webhook") return "Posted to a webhook the gateway names";
  return "Announced to the gateway's channels";
}

function Instruction({ routine, bot }: { routine: Routine; bot: string }) {
  if (routine.payload === "agentTurn") return <p className="r-instruction">{routine.text}</p>;
  if (routine.payload === "systemEvent")
    return (
      <>
        <p className="r-hint">Posts a reminder in {bot}&apos;s main conversation:</p>
        <p className="r-instruction">{routine.text}</p>
      </>
    );
  return (
    <>
      <p className="r-hint">Runs a command on the gateway, not a bot:</p>
      <p className="r-instruction r-mono">{routine.text}</p>
    </>
  );
}

function Page({
  gateway,
  routine,
  bot,
  now,
  onRun,
}: {
  gateway: string;
  routine: Routine;
  bot: Bot;
  now: number;
  onRun: (run: RoutineRun) => void;
}) {
  const [runs, retry] = useRuns(gateway, routine);
  const tz = routineZone(routine.schedule);
  const viewer = viewerZone();
  const schedule = scheduleLine(routine);
  const nextYours =
    routine.nextRunAt !== null &&
    tz !== null &&
    when(routine.nextRunAt, now, tz) !== when(routine.nextRunAt, now, viewer)
      ? `${when(routine.nextRunAt, now, viewer).replace(/^\S+ /u, "")} your time`
      : null;
  const ranOnce = routine.schedule.kind === "at" && routine.lastRunAt !== null;
  return (
    <>
      <p className="r-state" role="status" data-testid="routine-state">
        {routine.runningAt !== null ? (
          <>
            <span className="glyph" data-state="working" aria-hidden="true" />
            Running since {when(routine.runningAt, now, zoneOf(routine))}
          </>
        ) : !routine.enabled ? (
          "Paused. It won't run until resumed."
        ) : routine.lastStatus === "error" ? (
          <>
            <span className="glyph" data-state="failed" aria-hidden="true" />
            The last run failed.
          </>
        ) : (
          `Runs ${schedule.written ? `on "${schedule.text}"` : schedule.text[0]!.toLowerCase() + schedule.text.slice(1)}.`
        )}
      </p>
      <section className="r-section">
        <h3>Instruction</h3>
        <Instruction routine={routine} bot={bot.name} />
      </section>
      <section className="r-section">
        <h3>When to run</h3>
        <dl className="facts" data-testid="routine-facts">
          <div>
            <dt>Schedule</dt>
            <dd>
              {schedule.written ? (
                <>
                  <code className="r-mono">{scheduleWords(routine.schedule).text}</code>
                  {routine.schedule.kind === "cron" && (
                    <small>in the gateway&apos;s cron format</small>
                  )}
                </>
              ) : (
                scheduleWords(routine.schedule).text
              )}
            </dd>
          </div>
          {routine.schedule.kind !== "every" && routine.schedule.kind !== "other" && (
            <div>
              <dt>Time zone</dt>
              <dd>
                {tz ? (
                  <>
                    {zoneCity(tz)}
                    <small>{tz}</small>
                  </>
                ) : (
                  "The gateway's own time zone"
                )}
              </dd>
            </div>
          )}
          <div>
            <dt>Next run</dt>
            <dd data-testid="routine-next">
              {routine.nextRunAt !== null && routine.enabled ? (
                <>
                  {fullWhen(routine.nextRunAt, now, zoneOf(routine))}
                  {tz && !nextYours && <small>{zoneCity(tz)} time</small>}
                  {nextYours && <small>{nextYours}</small>}
                  {!tz && (
                    <small>
                      {routine.schedule.kind === "cron"
                        ? "Your time. The schedule itself runs in the gateway's time zone."
                        : "Your time"}
                    </small>
                  )}
                </>
              ) : !routine.enabled ? (
                "None while paused"
              ) : ranOnce ? (
                "None: it ran once and is done"
              ) : (
                "None scheduled"
              )}
            </dd>
          </div>
          {routine.gated && (
            <div>
              <dt>Starts</dt>
              <dd>As the gateway decides, from a check or spacing set on it</dd>
            </div>
          )}
          <div>
            <dt>Runs in</dt>
            <dd>{runsIn(routine, bot.name)}</dd>
          </div>
          <div>
            <dt>Results</dt>
            <dd>{resultsWords(routine)}</dd>
          </div>
          <div>
            <dt>Triggers</dt>
            <dd>
              {triggerWords(routine)}
              <small>This gateway&apos;s webhooks start a bot directly, not a routine.</small>
            </dd>
          </div>
        </dl>
      </section>
      <section className="r-section" aria-labelledby="r-runs">
        <h3 id="r-runs">Runs</h3>
        {runs.status === "loading" ? (
          <p className="r-hint">Loading runs…</p>
        ) : runs.status === "error" ? (
          <Retry text="Couldn't load runs." error={runs.error} onRetry={retry} />
        ) : runs.value.length === 0 && routine.runningAt === null ? (
          <p className="r-hint" data-testid="no-runs">
            {routine.enabled && routine.nextRunAt !== null
              ? `No runs yet. The first is due ${when(routine.nextRunAt, now, zoneOf(routine))}.`
              : "No runs yet."}
          </p>
        ) : (
          <ul className="r-rows" aria-label="Runs" data-testid="run-list">
            {routine.runningAt !== null && (
              <li>
                <div className="r-run" data-testid="run-row" data-running="true">
                  <span className="r-row-mark">
                    <span className="glyph" data-state="working" aria-hidden="true" />
                  </span>
                  <span className="r-run-text">
                    <span className="r-run-when">{when(routine.runningAt, now, viewer)}</span>
                    <span className="r-run-how">Running…</span>
                  </span>
                </div>
              </li>
            )}
            {runs.value.map((run) => {
              const outcome = runOutcome(run);
              const at = when(run.runAt, now, viewer);
              return (
                <li key={runKey(run.jobId, run.runId, run.runAt)}>
                  <button
                    type="button"
                    className="r-run"
                    data-testid="run-row"
                    data-run-at={run.runAt}
                    aria-label={`${at}${run.manual ? ", started by hand" : ""}, ${outcome.text}`}
                    onClick={() => onRun(run)}
                  >
                    <span className="r-row-mark">
                      {outcome.mark && (
                        <span className="glyph" data-state={outcome.mark} aria-hidden="true" />
                      )}
                    </span>
                    <span className="r-run-text">
                      <span className="r-run-when">
                        {capital(at)}
                        {run.manual && <span className="r-faint"> · started by hand</span>}
                      </span>
                      <span
                        className="r-run-how"
                        data-tone={outcome.mark === "failed" ? "danger" : undefined}
                      >
                        {outcome.text}
                      </span>
                    </span>
                    <ChevronIcon className="icon r-chevron" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="r-foot-note">
          Clawtrate shows the 20 runs that finished most recently. By default the gateway keeps 7
          days of runs, and each run&apos;s conversation for 24 hours; it can be set to keep them
          longer.
        </p>
      </section>
    </>
  );
}

/** Where a run with no conversation of its own happened, in the design's words (section 7). */
function sharedWords(routine: Routine, bot: Bot): string {
  if (routine.payload === "other") return "A command runs on the gateway, not a bot,";
  if (routine.target === "main") return `This run happened in ${bot.name}'s main conversation.`;
  return "This run happened in the conversation the routine was made in.";
}

function RunView({
  gateway,
  routine,
  run,
  bot,
}: {
  gateway: string;
  routine: Routine;
  run: RoutineRun;
  bot: Bot;
}) {
  const bridge = useBridge();
  const [read, retry] = useKeyedRead(`${gateway}:${routine.id}:${run.runId ?? run.runAt}`, () =>
    bridge.invoke({
      type: "readRunConversation",
      id: routine.id,
      runId: run.runId,
      runAt: run.runAt,
      sessionKey: run.sessionKey,
    }),
  );
  const outcome = runOutcome(run);
  const facts = [
    run.provider && run.model ? `${run.provider}/${run.model}` : run.model,
    run.inputTokens !== null && run.outputTokens !== null
      ? `${run.inputTokens} in, ${run.outputTokens} out tokens`
      : null,
  ].filter(Boolean);
  const returned = (
    <p data-testid="run-summary">What the run returned: {run.summary ?? outcome.text}</p>
  );
  return (
    <div className="r-convo" data-testid="run-view">
      {read.status === "loading" ? (
        <p className="r-hint">Loading this run…</p>
      ) : read.status === "error" ? (
        <Retry text="Couldn't load this run." error={read.error} onRetry={retry} />
      ) : read.value.status === "kept" ? (
        <>
          <div className="r-sched" data-testid="scheduled-message">
            <div className="r-sched-head">
              <ClockIcon /> Scheduled message, as the gateway recorded it
            </div>
            <p>{read.value.message}</p>
            {read.value.messageCut && (
              <p className="r-hint" data-testid="scheduled-message-cut">
                The rest of this message is longer than Clawtrate shows.
              </p>
            )}
          </div>
          {read.value.items.map((item) =>
            item.blocks.map((block, index) =>
              block.kind === "text" && item.role === "assistant" ? (
                <div key={`${item.id}:${index}`} className="bubble r-bubble" data-role="assistant">
                  <Markdown text={block.text} />
                </div>
              ) : block.kind === "tool-call" ? (
                <p key={`${item.id}:${index}`} className="r-step">
                  Used {block.name}
                  {block.result?.isError ? ", which failed" : ""}
                </p>
              ) : null,
            ),
          )}
          {read.value.omitted > 0 && (
            <p className="r-hint">{read.value.omitted} later messages are not shown here.</p>
          )}
        </>
      ) : (
        <Note testId="run-not-kept">
          <p>
            {read.value.reason === "no-session" ? (
              <>
                <strong>{sharedWords(routine, bot)}</strong>{" "}
                {routine.payload === "other"
                  ? "so this run has no conversation."
                  : "Its turn is there among the others; the gateway doesn't keep it apart."}
              </>
            ) : read.value.reason === "too-long" ? (
              <>
                <strong>This run&apos;s conversation is longer than Clawtrate reads.</strong> Its
                start, the scheduled message, is further back than the pages read here.
              </>
            ) : (
              <>
                <strong>Clawtrate can&apos;t show this run&apos;s conversation.</strong> The gateway
                returned none for it. By default it keeps a run&apos;s conversation for 24 hours, so
                an older one may have been removed.
              </>
            )}
          </p>
          {returned}
        </Note>
      )}
      <div className="r-run-foot">
        This run has finished. A run can&apos;t be answered; to change what it does, edit the
        routine.{" "}
        <span data-tone={outcome.mark === "failed" ? "danger" : undefined}>{outcome.text}</span>
        {facts.length > 0 && <span className="r-run-facts">{facts.join(" · ")}</span>}
      </div>
    </div>
  );
}

/** One radio group with one tab stop: arrows move and choose, Home and End go to the ends. */
function ModeSwitch({
  mode,
  modes,
  onMode,
}: {
  mode: RoutinesMode;
  modes: Array<[RoutinesMode, string]>;
  onMode: (mode: RoutinesMode) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (event: KeyboardEvent) => {
    const at = modes.findIndex(([each]) => each === mode);
    const to =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (at + 1) % modes.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (at + modes.length - 1) % modes.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? modes.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    onMode(modes[to]![0]);
    requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(),
    );
  };
  return (
    <div className="r-seg" role="radiogroup" aria-label="Show" ref={ref} onKeyDown={onKey}>
      {modes.map(([each, label]) => (
        <button
          key={each}
          type="button"
          role="radio"
          aria-checked={each === mode}
          tabIndex={each === mode ? 0 : -1}
          onClick={() => onMode(each)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function RoutinesView({
  state,
  nav,
  onNav,
  onClose,
  narrow,
  phone,
}: {
  state: ClawtrateState;
  nav: RoutinesNav;
  onNav: (nav: RoutinesNav) => void;
  onClose: () => void;
  /** Below 800 px: the header has less room. */
  narrow: boolean;
  /** One pane: the view switch offers List and Day, and Back goes to the bots. */
  phone: boolean;
}) {
  const now = useNow();
  const bridge = useBridge();
  const { routines: store, bots } = state;
  const gateway = state.connection.gatewayUrl ?? "";
  // Kept fewer routines than the gateway has: one bot's are read from the gateway when chosen.
  const [botRead, retryBot] = useKeyedRead(
    store.omitted > 0 && nav.bot !== null
      ? `${gateway}:${nav.bot}:${store.routines.length}:${store.omitted}`
      : null,
    () => bridge.invoke({ type: "readBotRoutines", botId: nav.bot! }),
  );

  const fromBot = store.omitted > 0 && botRead.status === "ready" ? botRead.value.routines : [];
  const routine = nav.routine
    ? [...store.routines, ...fromBot].find((each) => each.id === nav.routine)
    : undefined;
  const bot = routine ? ownerOf(bots, routine.botId) : undefined;
  // A rail row names its run by when it started; once the routine's runs have it, it is bound.
  const named = nav.run !== null && !isRun(nav.run) ? nav.run.runAt : null;
  const [found, retryFound] = useRuns(gateway, named === null ? undefined : routine);
  const match =
    found.status === "ready" ? found.value.find((each) => each.runAt === named) : undefined;
  useEffect(() => {
    if (match) onNav({ ...nav, run: match });
  }, [match, nav, onNav]);
  const run = isRun(nav.run) ? nav.run : undefined;
  // A routine removed while its page is open keeps its last values on screen.
  const [kept, setKept] = useState<{ routine: Routine; bot: Bot } | null>(null);
  if (routine && bot && (kept?.routine !== routine || kept.bot.id !== bot.id))
    setKept({ routine, bot });
  const shown =
    routine && bot
      ? { routine, bot }
      : nav.routine && kept?.routine.id === nav.routine
        ? kept
        : null;
  const deleted = nav.routine !== null && !routine && shown !== null;
  const ranOnce =
    deleted && store.removed?.id === nav.routine && store.removed.ranOnce ? store.removed : null;
  const modes = phone ? MODES.slice(0, 2) : MODES;
  const mode = phone && nav.mode !== "list" ? "day" : nav.mode;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const place = `${nav.routine ?? ""}:${nav.run === null ? "" : "run"}`;
  useEffect(() => {
    headingRef.current?.focus();
  }, [place]);
  const back = shown
    ? () => onNav(nav.run ? { ...nav, run: null } : { ...nav, routine: null, run: null })
    : onClose;
  const backLabel = shown
    ? nav.run
      ? `Back to ${shown.routine.name}, all runs`
      : "Back to routines"
    : phone
      ? "Back to bots"
      : "Back to conversation";
  const listed =
    store.omitted > 0 && nav.bot !== null
      ? botRead.status === "ready"
        ? botRead.value.routines
        : []
      : store.routines.filter((each) => nav.bot === null || each.botId === nav.bot);
  const count = listed.length;
  const refresh = () => void bridge.invoke({ type: "refreshRoutines" });

  return (
    <main
      className="r-view"
      aria-label="Routines"
      data-r={!shown && mode !== "list" ? "calendar" : "list"}
      data-narrow={narrow || undefined}
      data-testid="routines-view"
    >
      <header className="r-head">
        <button
          type="button"
          className="icon-button r-back"
          aria-label={backLabel}
          title={backLabel}
          onClick={back}
        >
          <BackIcon />
        </button>
        {shown ? (
          <div className="r-titles">
            <h1 ref={headingRef} tabIndex={-1} title={shown.routine.name}>
              {shown.routine.name}
            </h1>
            <p>
              <Avatar bot={shown.bot} />
              {nav.run
                ? `${shown.bot.name} · ${capital(when(nav.run.runAt, now, viewerZone()))}`
                : shown.bot.name}
            </p>
          </div>
        ) : (
          <h1 ref={headingRef} tabIndex={-1}>
            Routines
          </h1>
        )}
        <span className="spacer" />
        {!shown && (
          <ModeSwitch mode={mode} modes={modes} onMode={(next) => onNav({ ...nav, mode: next })} />
        )}
      </header>
      <div className="r-body">
        {deleted && (
          <Note tone="warn" testId="routine-deleted">
            <p role="status">
              {ranOnce ? (
                <>
                  <strong>This routine ran once, and the gateway removed it.</strong>
                  {ranOnce.runAt !== null &&
                    ` Its run succeeded ${when(ranOnce.runAt, now, viewerZone())}.`}{" "}
                  The gateway keeps nothing more of it, so once you leave this page it isn&apos;t
                  shown again.
                </>
              ) : (
                <>
                  <strong>This routine was deleted.</strong> It won&apos;t run again.
                </>
              )}
            </p>
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() => onNav({ ...nav, routine: null, run: null })}
            >
              Back to routines
            </button>
          </Note>
        )}
        {shown ? (
          nav.run ? (
            run ? (
              <RunView
                key={runKey(run.jobId, run.runId, run.runAt)}
                gateway={gateway}
                routine={shown.routine}
                run={run}
                bot={shown.bot}
              />
            ) : found.status === "error" ? (
              <Retry text="Couldn't load this run." error={found.error} onRetry={retryFound} />
            ) : found.status === "ready" && !match ? (
              <p className="r-hint" data-testid="run-gone">
                This run isn&apos;t among the 20 the gateway lists for this routine now.
              </p>
            ) : (
              <p className="r-hint">Loading this run…</p>
            )
          ) : (
            <Page
              gateway={gateway}
              routine={shown.routine}
              bot={shown.bot}
              now={now}
              onRun={(each) => onNav({ ...nav, run: each })}
            />
          )
        ) : (
          <>
            <div className="r-toolbar">
              <select
                className="b-select"
                aria-label="Bots"
                value={nav.bot ?? ""}
                onChange={(event) => onNav({ ...nav, bot: event.target.value || null })}
              >
                <option value="">All bots</option>
                {owners(bots, store.routines).map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}
                  </option>
                ))}
              </select>
              {store.status === "loaded" && (
                <span data-testid="routine-count">
                  {count} {count === 1 ? "routine" : "routines"}
                </span>
              )}
            </div>
            {store.schedulerOn === false && (
              <Note tone="warn" testId="scheduler-off">
                <p>
                  <strong>The gateway&apos;s scheduler is off.</strong> Routines don&apos;t run on
                  their schedule until it is turned on.
                </p>
              </Note>
            )}
            {store.omitted > 0 && (
              <Note testId="routines-omitted">
                <p>
                  <strong>
                    The gateway has {store.omitted} more{" "}
                    {store.omitted === 1 ? "routine" : "routines"} than Clawtrate keeps.
                  </strong>{" "}
                  {nav.bot === null
                    ? "Choose a bot to see all of its routines."
                    : "All of this bot's are shown."}
                </p>
              </Note>
            )}
            {store.status === "error" && store.routines.length > 0 && (
              <Note tone="warn" testId="routines-stale">
                <p>
                  <strong>Couldn&apos;t refresh routines.</strong> {store.error} What is shown may
                  be out of date.
                </p>
                <button type="button" className="button" data-size="sm" onClick={refresh}>
                  Try again
                </button>
              </Note>
            )}
            {store.status === "error" && store.routines.length === 0 ? (
              <div className="work-empty r-empty" data-testid="routines-error">
                <p className="work-empty-title">Couldn&apos;t load routines.</p>
                <p className="work-empty-text">{store.error}</p>
                <button type="button" className="button" onClick={refresh}>
                  Try again
                </button>
              </div>
            ) : store.status === "idle" ||
              store.status === "loading" ||
              (store.omitted > 0 && nav.bot !== null && botRead.status === "loading") ? (
              <div className="r-loading" aria-busy="true" aria-label="Loading routines">
                <span className="skeleton r-skeleton" />
                <span className="skeleton r-skeleton" />
                <span className="skeleton r-skeleton" />
              </div>
            ) : botRead.status === "error" && store.omitted > 0 && nav.bot !== null ? (
              <Retry
                text="Couldn't load this bot's routines."
                error={botRead.error}
                onRetry={retryBot}
              />
            ) : mode === "list" ? (
              <List
                routines={listed}
                bots={bots}
                bot={nav.bot}
                now={now}
                onOpen={(id) => onNav({ ...nav, routine: id, run: null })}
              />
            ) : (
              <Calendar
                gateway={gateway}
                routines={listed}
                bots={bots}
                days={mode === "day" ? 1 : mode === "3day" ? 3 : 7}
                now={now}
                onOpen={(id) => onNav({ ...nav, routine: id, run: null })}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}
