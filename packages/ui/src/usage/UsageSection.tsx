// Settings, Usage (docs/design/controls.md, sections 16 and 17): the limits
// providers report, as the gateway reports them and with their time; every
// budget; usage by bot and by source, for a period.

import {
  budgetPercent,
  currentCount,
  type Bot,
  type Budget,
  type ConnectionState,
  type HostInfo,
  type Routine,
  MAX_BOTS,
  type UsagePeriod,
} from "@clawtrate/core";
import { useEffect, useState, type ReactNode } from "react";
import { useBridge, useClawtrateState } from "../bridge.tsx";
import { ChevronIcon } from "../icons.tsx";
import { BudgetForm, type BudgetTarget } from "./Budget.tsx";
import {
  Bars,
  Meter,
  PeriodChoice,
  ShownOnly,
  stillCounted,
  useNow,
  useUsageReport,
} from "./parts.tsx";
import {
  asOf,
  botBars,
  botsLeftOut,
  budgetLine,
  figureLine,
  full,
  kindWord,
  PARTIAL_COUNT,
  refreshFailed,
  reportWindow,
  sourceBars,
  sourcesNote,
  USAGE_WAITING,
} from "./words.ts";
import "./usage.css";

const day = (at: number) =>
  new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The limits providers report: each window with its percentage, its reset and the gateway's time. */
function Limits() {
  const state = useClawtrateState();
  const limits = state.usage?.limits;
  if (!limits || limits.status === "unknown")
    return (
      <p className="b-hint" style={{ marginTop: 0 }}>
        Reading the providers' limits…
      </p>
    );
  if (limits.status === "error")
    return (
      <p className="b-hint" style={{ marginTop: 0 }} data-testid="limits-error">
        Couldn't read the providers' limits from the gateway.
      </p>
    );
  const at = limits.updatedAt === null ? "" : ` · ${asOf(limits.updatedAt)}`;
  const reporting = limits.providers.filter((each) => each.windows.length > 0);
  const silent = limits.providers.filter((each) => each.windows.length === 0);
  return (
    <div data-testid="limits">
      {reporting.length === 0 && (
        <p className="b-hint" style={{ marginTop: 0 }} data-testid="limits-none">
          No limits reported{limits.updatedAt === null ? "" : `, ${asOf(limits.updatedAt)}`}.
        </p>
      )}
      {reporting.flatMap((provider) =>
        provider.windows.map((window) => {
          const words = `${provider.displayName} · ${window.label} · ${Math.round(window.usedPercent)}% used${window.resetAt ? ` · resets ${day(window.resetAt)}` : ""}${at}`;
          return (
            <Meter
              key={`${provider.provider}:${window.label}`}
              used={window.usedPercent}
              limit={100}
              words={words}
              right=""
              label={`${provider.displayName}'s ${window.label} limit: ${Math.round(window.usedPercent)}% used${limits.updatedAt ? `, ${asOf(limits.updatedAt)}` : ""}`}
            />
          );
        }),
      )}
      {silent.length > 0 && (
        <p className="b-hint">
          {silent
            .map(
              (each) =>
                `${each.displayName}: no limits reported${each.error ? ` (${each.error})` : ""}.`,
            )
            .join(" ")}
        </p>
      )}
      {limits.providers.length > 0 && (
        <p className="b-hint">
          The gateway doesn't say which of your accounts a limit is about, and a limit says nothing
          about what a run will do.
        </p>
      )}
    </div>
  );
}

/** Every budget, each with its count, and the form to add or change one. */
function Budgets({
  bots,
  canSet,
  announce,
}: {
  bots: readonly Bot[];
  canSet: boolean;
  announce: (text: string) => void;
}) {
  const bridge = useBridge();
  const state = useClawtrateState();
  const usage = state.usage;
  const now = useNow();
  const [adding, setAdding] = useState(false);
  // The saved budget whose form is open, opened from its own row.
  const [editing, setEditing] = useState<string | null>(null);
  const [target, setTarget] = useState<string>("");
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  useEffect(() => {
    if (!adding || routines) return;
    let live = true;
    bridge
      .invoke({ type: "listRoutines" })
      .then((list) => live && setRoutines(list))
      .catch(() => live && setRoutines([]));
    return () => {
      live = false;
    };
  }, [adding, routines, bridge]);
  const name = (botId: string) => bots.find((bot) => bot.id === botId)?.name ?? botId;
  if (usage?.budgetsStatus === "unavailable")
    return (
      <p className="b-hint" style={{ marginTop: 0 }}>
        This gateway keeps no preferences for this connection, so a budget can't be kept.
      </p>
    );
  const budgets = usage?.budgets ?? [];
  const targets: Array<[string, string, BudgetTarget]> = [
    ...bots.map((bot): [string, string, BudgetTarget] => [
      `bot:${bot.id}`,
      bot.name,
      { botId: bot.id, routineId: null, routineName: null },
    ]),
    ...(routines ?? []).map((routine): [string, string, BudgetTarget] => [
      `routine:${routine.id}`,
      `Routine ${routine.name} (${name(routine.botId)})`,
      { botId: routine.botId, routineId: routine.id, routineName: routine.name },
    ]),
  ];
  const chosen = targets.find(([id]) => id === target) ?? null;
  const who = (budget: Budget) =>
    budget.routineId
      ? `Routine ${budget.routineName ?? budget.routineId} (${name(budget.botId)})`
      : name(budget.botId);
  const edited = budgets.find((each) => each.id === editing) ?? null;
  const closeEditor = (id: string) => {
    setEditing(null);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-budget="${id}"] button.b-open`)?.focus(),
    );
  };
  return (
    <>
      {budgets.length === 0 ? (
        <p className="b-hint" style={{ marginTop: 0 }} data-testid="budgets-none">
          No budgets. A budget is a warning: nothing on the gateway stops a bot at it.
        </p>
      ) : (
        <dl className="facts" data-testid="budgets">
          {budgets.map((budget) => {
            const count = currentCount(usage, budget, now);
            const percent = budgetPercent(budget, count?.used ?? null);
            const line = `${who(budget)} · ${kindWord(budget.period)} · ${budgetLine(budget, count)}${
              percent !== null && percent >= 100
                ? " · reached"
                : percent !== null && percent >= 80
                  ? ` · ${percent}%`
                  : ""
            }`;
            const main = (
              <span className="b-row-main">
                <span>{line}</span>
                {count?.partial && <small>{PARTIAL_COUNT}</small>}
                <small>
                  <ShownOnly />
                </small>
              </span>
            );
            // A saved budget's row opens its own form; read-only, it is a value only.
            return canSet ? (
              <div key={budget.id} data-budget={budget.id}>
                <button
                  type="button"
                  className="b-open"
                  aria-label={`${line}. Shown only. Change.`}
                  onClick={() => {
                    setAdding(false);
                    setEditing(budget.id);
                  }}
                >
                  {main}
                  <ChevronIcon />
                </button>
              </div>
            ) : (
              <div className="b-row" key={budget.id} data-budget={budget.id}>
                {main}
              </div>
            );
          })}
        </dl>
      )}
      {canSet && edited && (
        <div data-testid="budget-edit-form">
          <BudgetForm
            key={edited.id}
            target={{
              botId: edited.botId,
              routineId: edited.routineId,
              routineName: edited.routineName,
            }}
            existing={edited}
            canSave={!edited.routineId || !currentCount(usage, edited, now)?.error}
            name={
              edited.routineId ? `routine ${edited.routineName ?? edited.routineId}` : who(edited)
            }
            announce={announce}
            onDone={() => closeEditor(edited.id)}
          />
        </div>
      )}
      {canSet && !adding && !edited && (
        <div className="b-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="button"
            data-size="sm"
            data-testid="budget-add"
            onClick={() => {
              setEditing(null);
              setAdding(true);
            }}
          >
            Add a budget
          </button>
        </div>
      )}
      {canSet && adding && (
        <div
          className="c-form"
          data-testid="budget-add-form"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setAdding(false);
            setTarget("");
            requestAnimationFrame(() =>
              document.querySelector<HTMLElement>('[data-testid="budget-add"]')?.focus(),
            );
          }}
        >
          <label>
            For
            <select
              className="input"
              value={target}
              data-testid="budget-target"
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">Choose a bot or a routine</option>
              {targets.map(([id, words]) => (
                <option key={id} value={id}>
                  {words}
                </option>
              ))}
            </select>
          </label>
          {routines === null && (
            <p className="b-hint" style={{ margin: 0 }}>
              Reading the routines…
            </p>
          )}
          {chosen ? (
            <BudgetForm
              key={chosen[0]}
              target={chosen[2]}
              existing={budgets.find((each) => each.id === chosen[0]) ?? null}
              name={chosen[2].routineId ? `routine ${chosen[2].routineName}` : chosen[1]}
              announce={announce}
              onDone={() => {
                setAdding(false);
                setTarget("");
              }}
            />
          ) : (
            <div className="b-actions">
              <button
                type="button"
                className="button"
                data-variant="quiet"
                data-size="sm"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Usage by bot and by source, for a period. */
function ByBot({ bots }: { bots: readonly Bot[] }) {
  const left = botsLeftOut(useClawtrateState().cut);
  const [period, setPeriod] = useState<UsagePeriod>("week");
  const report = useUsageReport(null, period, true, true);
  const r = report.report;
  return (
    <>
      <h4 className="b-group">By bot</h4>
      <PeriodChoice value={period} onChange={setPeriod} />
      {report.status === "loading" && report.waiting && (
        <p className="b-hint" role="status" data-testid="usage-waiting">
          {USAGE_WAITING}
        </p>
      )}
      {!r && report.status === "loading" && (
        <div aria-busy="true" aria-label="Loading usage">
          <div className="skeleton" style={{ height: 80, width: "100%", marginTop: 8 }} />
        </div>
      )}
      {!r && report.status === "error" && (
        <p className="b-hint" data-testid="usage-error">
          Couldn't load usage: {report.error}{" "}
          <button type="button" className="link-button" onClick={report.retry}>
            Try again
          </button>
        </p>
      )}
      {r && (
        <div aria-busy={report.status === "loading"} data-testid="usage-all">
          {report.status === "error" && (
            <p className="b-field-error" role="alert" data-testid="usage-refresh-error">
              {refreshFailed(report.error, r)}{" "}
              <button type="button" className="link-button" onClick={report.retry}>
                Try again
              </button>
            </p>
          )}
          <p className="b-hint" style={{ marginTop: 0 }}>
            From the gateway's usage records {reportWindow(r.period, r.range)},{" "}
            {asOf(r.figure.asOf)}.
            {stillCounted(r) ? " Some of the gateway's records are still being counted." : ""}
          </p>
          <Bars
            testId="usage-bots"
            rows={botBars(r, (id) => bots.find((bot) => bot.id === id)?.name ?? id)}
          />
          <p className="b-hint" data-testid="usage-all-total">
            Every bot: {figureLine(r.figure)}.
            {left > 0
              ? ` ${full(left)} more ${left === 1 ? "bot isn't" : "bots aren't"} shown by name: Clawtrate lists at most ${full(MAX_BOTS)} bots.`
              : ""}
          </p>
          <h4 className="b-group">By source</h4>
          {r.sources ? (
            <>
              <Bars testId="usage-sources" rows={sourceBars(r.sources)} />
              <p className="b-hint">
                Messages from other bots counts only runs a send's result names. The rest is not
                attributed, never charged to one message.
                {sourcesNote(r.sources, stillCounted(r))}
              </p>
            </>
          ) : (
            <p className="b-hint" style={{ marginTop: 0 }}>
              Unavailable{r.detailError ? `: ${r.detailError}` : "."}
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** The Usage section of Settings, in the frame the other sections use. */
export function useUsageSection({
  bots,
  info,
  announce,
  toNav,
}: {
  bots: readonly Bot[];
  connection: ConnectionState;
  info: HostInfo;
  announce: (text: string) => void;
  toNav: ReactNode;
}): { title: string; back: ReactNode; body: ReactNode; foot: ReactNode } {
  const body = (
    <div className="c-usage" data-testid="usage-section">
      <h4 className="b-group" style={{ marginTop: 0 }}>
        Provider limits
      </h4>
      <Limits />
      <h4 className="b-group">Budgets</h4>
      <Budgets bots={bots} canSet={!info.readOnly} announce={announce} />
      <ByBot bots={bots} />
    </div>
  );
  return { title: "Usage", back: toNav, body, foot: null };
}
