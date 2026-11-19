// A warning budget (docs/design/controls.md, section 17): its meter, its
// state, and the form that sets it. A budget is a warning, everywhere: it is
// marked "Shown only", and nothing here says it stops a run or a send.

import {
  budgetPercent,
  budgetTokens,
  type Budget,
  type BudgetCount,
  type BudgetPeriod,
  type UsageState,
} from "@clawtrate/core";
import { useEffect, useId, useRef, useState } from "react";
import { useBridge } from "../bridge.tsx";
import { Note } from "../bots/parts.tsx";
import { Choice, Meter, ShownOnly } from "./parts.tsx";
import {
  asOf,
  budgetLine,
  deviceTimeZone,
  full,
  kindWord,
  periodWord,
  reachedLine,
  resetWords,
} from "./words.ts";

export type BudgetTarget = { botId: string; routineId: string | null; routineName: string | null };

const PERIOD_OPTIONS: ReadonlyArray<readonly [BudgetPeriod, string]> = [
  ["daily", "Daily"],
  ["weekly", "Weekly"],
];

/** Ask once, while the person acts, whether the 80 percent warning may notify them. */
function askToNotify() {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default")
      void Notification.requestPermission().catch(() => {});
  } catch {
    // No notifications here; the line in the task still warns.
  }
}

/** The budget form: Daily or Weekly, a whole number of tokens, Save budget. */
export function BudgetForm({
  target,
  existing,
  name,
  announce,
  onDone,
}: {
  target: BudgetTarget;
  existing: Budget | null;
  /** The bot's or the routine's name, for the help line. */
  name: string;
  announce: (text: string) => void;
  onDone: (saved: boolean) => void;
}) {
  const bridge = useBridge();
  const [period, setPeriod] = useState<BudgetPeriod>(existing?.period ?? "weekly");
  const [value, setValue] = useState(existing ? full(existing.tokens) : "");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const ids = useId();
  useEffect(() => {
    field.current?.focus();
  }, []);
  const tokens = budgetTokens(value);
  const invalid = typeof tokens === "string";
  const shownError = invalid && value.trim() !== "" ? tokens : null;
  const save = async () => {
    if (typeof tokens !== "number" || saving) return;
    askToNotify();
    setSaving(true);
    setFailure(null);
    try {
      await bridge.invoke({
        type: "changeBudget",
        change: { op: "set", budget: { ...target, period, tokens, timeZone: deviceTimeZone() } },
      });
      announce("Budget saved");
      onDone(true);
    } catch (error) {
      setFailure(
        `Couldn't save the budget: ${error instanceof Error ? error.message : String(error)}`,
      );
      announce("Couldn't save");
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!existing || saving) return;
    setSaving(true);
    try {
      await bridge.invoke({ type: "changeBudget", change: { op: "remove", id: existing.id } });
      announce("Budget removed");
      onDone(true);
    } catch (error) {
      setFailure(
        `Couldn't remove the budget: ${error instanceof Error ? error.message : String(error)}`,
      );
      announce("Couldn't save");
      setSaving(false);
    }
  };
  return (
    <div
      className="c-form"
      role="group"
      aria-label={`${name}'s budget`}
      data-testid="budget-form"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onDone(false);
        }
      }}
    >
      <Choice
        label="Period"
        name="budget-kind"
        value={period}
        options={PERIOD_OPTIONS}
        onChange={setPeriod}
      />
      <label>
        Tokens
        <input
          ref={field}
          className="input"
          inputMode="numeric"
          data-testid="budget-tokens"
          value={value}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={`${ids}-help${shownError ? ` ${ids}-error` : ""}`}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
          }}
        />
      </label>
      <p className="b-hint" id={`${ids}-help`} style={{ margin: 0 }}>
        A whole number of 1,000 or more. Counts the total the gateway reports for {name}{" "}
        {period === "daily" ? "each day" : "each week"}: input, output and cache. A warning: nothing
        on the gateway stops a bot at its budget.
      </p>
      {shownError && (
        <p className="b-field-error" id={`${ids}-error`} style={{ margin: 0 }}>
          {shownError}
        </p>
      )}
      {failure && (
        <p className="b-field-error" role="alert" style={{ margin: 0 }}>
          {failure}
        </p>
      )}
      <div className="b-actions">
        <button
          type="button"
          className="button"
          data-variant="primary"
          data-size="sm"
          data-testid="budget-save"
          disabled={invalid || saving}
          onClick={() => void save()}
        >
          Save budget
        </button>
        <button
          type="button"
          className="button"
          data-variant="quiet"
          data-size="sm"
          onClick={() => onDone(false)}
        >
          Cancel
        </button>
        {existing && (
          <>
            <span className="spacer" />
            <button
              type="button"
              className="button"
              data-variant="quiet"
              data-size="sm"
              data-testid="budget-remove"
              disabled={saving}
              onClick={() => void remove()}
            >
              Remove budget
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** A budget's meter, its mark and its state; or the way to set one. */
export function BudgetPart({
  name,
  target,
  budget,
  count,
  usage,
  canSet,
  announce,
  form,
  onForm,
}: {
  name: string;
  target: BudgetTarget;
  budget: Budget | null;
  count: BudgetCount | null;
  usage: UsageState | undefined;
  /** False on a host pinned read-only: values only, nothing that would do nothing. */
  canSet: boolean;
  announce: (text: string) => void;
  form: boolean;
  onForm: (open: boolean) => void;
}) {
  if (usage?.budgetsStatus === "unavailable")
    return (
      <p className="b-hint" data-testid="budget-unavailable">
        This gateway keeps no preferences for this connection, so a budget can't be kept.
      </p>
    );
  if (form && canSet)
    return (
      <BudgetForm
        target={target}
        existing={budget}
        name={name}
        announce={announce}
        onDone={() => onForm(false)}
      />
    );
  if (!budget)
    return (
      <>
        <p className="b-hint" style={{ marginTop: 0 }} data-testid="budget-none">
          No budget. A budget is a number of tokens {name} may use in a day or a week. It is a
          warning: nothing stops {name} at it.
        </p>
        {canSet && (
          <div className="b-actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="button"
              data-size="sm"
              data-testid="budget-new"
              onClick={() => onForm(true)}
            >
              Set a budget
            </button>
          </div>
        )}
      </>
    );
  const used = count?.used ?? null;
  const percent = budgetPercent(budget, used);
  return (
    <div data-testid="budget">
      {used === null ? (
        <p className="c-sentence" data-testid="budget-uncounted">
          {full(budget.tokens)} tokens {periodWord(budget.period)}.{" "}
          {count?.error ? `Couldn't count it: ${count.error}` : "Counting…"}
        </p>
      ) : (
        <Meter
          used={used}
          limit={budget.tokens}
          words={budgetLine(budget, used)}
          label={`${name}'s ${kindWord(budget.period)} budget: ${full(used)} of ${full(budget.tokens)} tokens ${periodWord(budget.period)}`}
          testId="budget-meter"
        />
      )}
      <p className="c-sentence">
        <ShownOnly />
      </p>
      <p className="b-hint">
        A warning: at 80% a line in {name}'s task and a notification, at 100% a note above the
        composer. Other apps, channels and routines aren't stopped, and nothing on the gateway stops{" "}
        {name} at the limit.
      </p>
      {percent !== null && percent >= 100 ? (
        <Note tone="warn" testId="budget-reached">
          <p>
            <b>{reachedLine(name, budget)}</b>
          </p>
        </Note>
      ) : percent !== null && percent >= 80 ? (
        <Note tone="warn" testId="budget-warned">
          <p>
            {name} has used {percent}% of its {kindWord(budget.period)} budget.
          </p>
        </Note>
      ) : null}
      <p className="b-hint">
        Counts the total the gateway reports {periodWord(budget.period)}: input, output and cache,
        the same figure as Usage below{used !== null && count ? `, ${asOf(count.asOf)}` : ""}.
        {count?.counting ? " Some of the gateway's records are still being counted." : ""}{" "}
        {resetWords(budget)}
      </p>
      {canSet && (
        <div className="b-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="button"
            data-size="sm"
            data-testid="budget-edit"
            onClick={() => onForm(true)}
          >
            Raise budget
          </button>
        </div>
      )}
    </div>
  );
}
