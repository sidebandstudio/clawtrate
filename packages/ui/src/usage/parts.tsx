// The usage pages' parts (docs/design/controls.md, sections 2 and 16): the
// meter, the bars, the period choice, the "Shown only" mark, and the hook that
// reads a report from the host.

import { rangeFor, type UsagePeriod, type UsageReport } from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { useBridge, useClawtrateState } from "../bridge.tsx";
import { EyeIcon } from "../icons.tsx";
import { barText, deviceTimeZone, meterTone, PERIODS, reportFits, type BarRow } from "./words.ts";

/** A meter: a 6 px bar with its numbers in text beside it, never alone. */
export function Meter({
  used,
  limit,
  words,
  label,
  right,
  testId,
}: {
  used: number;
  limit: number;
  words: string;
  label: string;
  right?: string;
  testId?: string;
}) {
  const share = limit > 0 ? used / limit : 0;
  const percent = Math.floor(share * 100);
  return (
    <div className="c-meter" data-tone={meterTone(used, limit)} data-testid={testId}>
      <div
        className="c-meter-bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-label={label}
      >
        <span style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
      <div className="c-meter-text">
        <span>{words}</span>
        <span>{right ?? `${percent}%`}</span>
      </div>
    </div>
  );
}

/**
 * Horizontal bars, one row each: the name, the bar, the figure in text. A
 * figure that couldn't be read is "Unavailable", with no bar.
 */
export function Bars({ rows, testId }: { rows: BarRow[]; testId?: string }) {
  const max = Math.max(1, ...rows.map((row) => row.tokens ?? 0));
  return (
    <ul className="c-bars" data-testid={testId}>
      {rows.map((row) => (
        <li key={row.id} aria-label={`${row.name}: ${barText(row)}`}>
          <span>{row.name}</span>
          <span className="c-meter-bar" aria-hidden="true">
            {row.tokens !== null && <span style={{ width: `${(row.tokens / max) * 100}%` }} />}
          </span>
          <span aria-hidden="true">{barText(row)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Section 2's "Shown only" mark: nothing on the gateway holds a budget. */
export function ShownOnly() {
  return (
    <span className="c-mark" data-testid="shown-only">
      <EyeIcon />
      Shown only
    </span>
  );
}

/**
 * A radio group of a few choices with one tab stop: arrows move and choose,
 * Home and End go to the ends (controls.md section 2, Input).
 */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  name,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (next: T) => void;
  name: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent) => {
    const at = options.findIndex(([id]) => id === value);
    const to =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (at + 1) % options.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (at - 1 + options.length) % options.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    // Focus moves now, as the key is handled: a key pressed straight after (Tab) acts from the
    // option it reached, and nothing a frame later takes focus back.
    ref.current?.querySelector<HTMLElement>(`[data-value="${options[to]![0]}"]`)?.focus();
    onChange(options[to]![0]);
  };
  return (
    <div
      ref={ref}
      className="seg c-seg"
      role="radiogroup"
      aria-label={label}
      onKeyDown={move}
      data-choice={name}
    >
      {options.map(([id, words]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={id === value}
          tabIndex={id === value ? 0 : -1}
          data-value={id}
          onClick={() => onChange(id)}
        >
          {words}
        </button>
      ))}
    </div>
  );
}

export const PeriodChoice = ({
  value,
  onChange,
}: {
  value: UsagePeriod;
  onChange: (next: UsagePeriod) => void;
}) => <Choice label="Period" name="period" value={value} options={PERIODS} onChange={onChange} />;

export type ReportState =
  /** `waiting`: the host answered that it is busy reading other reports; asked again while shown. */
  | { status: "loading"; report: UsageReport | null; waiting?: boolean }
  | { status: "ready"; report: UsageReport }
  | { status: "error"; report: UsageReport | null; error: string };

/** Whether any figure of a report is one the gateway said it is still counting. */
export function stillCounted(report: UsageReport): boolean {
  return (
    report.figure.counting ||
    report.detailCounting ||
    (report.bots ?? []).some((each) => each.figure?.counting === true)
  );
}

/** How soon a figure the gateway is still counting is read again. */
export const COUNTING_AGAIN_MS = 5_000;
/** How soon a report the host was too busy to read is asked for again. */
export const BUSY_AGAIN_MS = 3_000;

/** Whether the window is shown: a hidden one asks the host for nothing again. */
export function useWindowShown(): boolean {
  return useSyncExternalStore(
    (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/** The tick a view judges periods and budget states at: now, and every 30 seconds. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * A usage report, read from the host when shown, again when the period
 * changes, when its days change (the date's rollover, judged every 30
 * seconds) or `again` does, and never kept beyond this view. While a new one
 * is read, or when reading it failed, the last one is shown only if it is
 * for the same bot and the same days; a failed read is said either way.
 * `enabled` is whether the view is shown: only a shown view asks again,
 * after the host said it was busy or while the gateway is still counting.
 */
export function useUsageReport(
  botId: string | null,
  period: UsagePeriod,
  detail: boolean,
  enabled: boolean,
  again: unknown = null,
): ReportState & { retry: () => void } {
  const bridge = useBridge();
  const { connection } = useClawtrateState();
  const gateway = JSON.stringify([connection.gatewayUrl, connection.gatewayId]);
  const [tries, setTries] = useState(0);
  const retry = useCallback(() => setTries((n) => n + 1), []);
  const range = rangeFor(period, useNow(), deviceTimeZone());
  const key = JSON.stringify([
    botId,
    period,
    detail,
    tries,
    again,
    range,
    gateway,
    connection.connectedAt,
  ]);
  // The answer, the request it answers and its gateway: one for an earlier request is shown as
  // loading, and one from another gateway is not shown at all.
  const [received, setAnswer] = useState<{
    key: string;
    gateway: string;
    state: ReportState;
  } | null>(null);
  const answer = received?.gateway === gateway ? received : null;
  const shown = useWindowShown() && enabled;
  useEffect(() => {
    if (!shown || document.visibilityState === "hidden") return;
    if (connection.status !== "connected") return;
    let live = true;
    bridge
      .invoke({ type: "readUsage", botId, period, timeZone: deviceTimeZone(), detail })
      .then((report) => {
        if (!live) return;
        if ("busy" in report)
          setAnswer((was) => ({
            key,
            gateway,
            state: {
              status: "loading",
              report: was?.gateway === gateway ? was.state.report : null,
              waiting: true,
            },
          }));
        else setAnswer({ key, gateway, state: { status: "ready", report } });
      })
      .catch((failure: unknown) => {
        if (live)
          setAnswer((was) => ({
            key,
            gateway,
            state: {
              status: "error",
              report: was?.gateway === gateway ? was.state.report : null,
              error: failure instanceof Error ? failure.message : String(failure),
            },
          }));
      });
    return () => {
      live = false;
    };
  }, [bridge, botId, period, detail, shown, key, gateway, connection.status]);
  // While the gateway says it is still counting, read again shortly: its next answer can be complete.
  const counting =
    answer?.key === key && answer.state.status === "ready" && stillCounted(answer.state.report);
  // The host was busy: ask again in a moment, while this view is shown.
  const waiting =
    answer?.key === key && answer.state.status === "loading" && answer.state.waiting === true;
  useEffect(() => {
    if (!shown || (!counting && !waiting)) return;
    const timer = setTimeout(retry, waiting ? BUSY_AGAIN_MS : COUNTING_AGAIN_MS);
    return () => clearTimeout(timer);
  }, [counting, waiting, shown, retry]);
  // A report is shown only for this bot and these days, never for another period's.
  const kept = (report: UsageReport | null) =>
    report && reportFits(report, botId, period, range) ? report : null;
  const state: ReportState =
    answer === null
      ? { status: "loading", report: null }
      : answer.key !== key
        ? { status: "loading", report: kept(answer.state.report) }
        : answer.state.status === "ready"
          ? answer.state
          : { ...answer.state, report: kept(answer.state.report) };
  return { ...state, retry };
}
