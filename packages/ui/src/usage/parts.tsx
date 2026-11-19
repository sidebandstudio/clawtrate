// The usage pages' parts (docs/design/controls.md, sections 2 and 16): the
// meter, the bars, the period choice, the "Shown only" mark, and the hook that
// reads a report from the host.

import type { UsagePeriod, UsageReport } from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useBridge } from "../bridge.tsx";
import { EyeIcon } from "../icons.tsx";
import { deviceTimeZone, full, PERIODS, short } from "./words.ts";

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
  const tone = share >= 1 ? "danger" : percent >= 80 ? "warn" : undefined;
  return (
    <div className="c-meter" data-tone={tone} data-testid={testId}>
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

/** Horizontal bars, one row each: the name, the bar, the figure in text. */
export function Bars({ rows, testId }: { rows: Array<[string, number]>; testId?: string }) {
  const max = Math.max(1, ...rows.map(([, value]) => value));
  return (
    <ul className="c-bars" data-testid={testId}>
      {rows.map(([name, value]) => (
        <li key={name} aria-label={`${name}: ${full(value)} tokens`}>
          <span>{name}</span>
          <span className="c-meter-bar" aria-hidden="true">
            <span style={{ width: `${(value / max) * 100}%` }} />
          </span>
          <span aria-hidden="true" title={`${full(value)} tokens`}>
            {short(value)} tokens
          </span>
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
    onChange(options[to]![0]);
    requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLElement>(`[data-value="${options[to]![0]}"]`)?.focus(),
    );
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
  | { status: "loading"; report: UsageReport | null }
  | { status: "ready"; report: UsageReport }
  | { status: "error"; report: UsageReport | null; error: string };

/** How soon a figure the gateway is still counting is read again. */
export const COUNTING_AGAIN_MS = 5_000;

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
 * changes or `again` does, and never kept beyond this view.
 */
export function useUsageReport(
  botId: string | null,
  period: UsagePeriod,
  detail: boolean,
  enabled: boolean,
  again: unknown = null,
): ReportState & { retry: () => void } {
  const bridge = useBridge();
  const [tries, setTries] = useState(0);
  const retry = useCallback(() => setTries((n) => n + 1), []);
  const key = JSON.stringify([botId, period, detail, tries, again]);
  // The answer, and the request it answers: one for an earlier request is shown as loading.
  const [answer, setAnswer] = useState<{ key: string; state: ReportState } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    bridge
      .invoke({ type: "readUsage", botId, period, timeZone: deviceTimeZone(), detail })
      .then((report) => {
        if (live) setAnswer({ key, state: { status: "ready", report } });
      })
      .catch((failure: unknown) => {
        if (live)
          setAnswer((was) => ({
            key,
            state: {
              status: "error",
              report: was?.state.report ?? null,
              error: failure instanceof Error ? failure.message : String(failure),
            },
          }));
      });
    return () => {
      live = false;
    };
  }, [bridge, botId, period, detail, enabled, key]);
  // While the gateway says it is still counting, read again shortly: its next answer can be complete.
  const counting =
    answer?.key === key &&
    answer.state.status === "ready" &&
    (answer.state.report.figure.counting ||
      (answer.state.report.tasks ?? []).some((each) => each.computing));
  useEffect(() => {
    if (!counting || !enabled) return;
    const timer = setTimeout(retry, COUNTING_AGAIN_MS);
    return () => clearTimeout(timer);
  }, [counting, enabled, retry]);
  const state: ReportState =
    answer === null
      ? { status: "loading", report: null }
      : answer.key === key
        ? answer.state
        : { status: "loading", report: answer.state.report };
  return { ...state, retry };
}
