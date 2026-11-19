// Settings, Usage (docs/design/controls.md, sections 16 and 17): the limits
// providers report, as the gateway reports them and with their time; every
// budget; usage by bot and by source, for a period.

import {
  budgetPercent,
  currentCount,
  type Bot,
  type ConnectionState,
  type HostInfo,
  type Routine,
  type UsagePeriod,
  type UsageSources,
} from "@clawtrate/core";
import { useEffect, useState, type ReactNode } from "react";
import { useBridge, useClawtrateState } from "../bridge.tsx";
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
import { asOf, budgetLine, costShort, full, kindWord } from "./words.ts";
import "./usage.css";

const SOURCES: Array<[keyof Omit<UsageSources, "partial">, string]> = [
  ["people", "Messages from people"],
  ["routines", "Routines"],
  ["bots", "Messages from other bots"],
  ["unattributed", "Not attributed"],
];

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
            const who = budget.routineId
              ? `Routine ${budget.routineName ?? budget.routineId} (${name(budget.botId)})`
              : name(budget.botId);
            return (
              <div className="b-row" key={budget.id} data-budget={budget.id}>
                <span className="b-row-main">
                  <span>
                    {who} · {kindWord(budget.period)} · {budgetLine(budget, count?.used ?? null)}
                    {percent !== null && percent >= 100
                      ? " · reached"
                      : percent !== null && percent >= 80
                        ? ` · ${percent}%`
                        : ""}
                  </span>
                  <small>
                    <ShownOnly />
                  </small>
                </span>
              </div>
            );
          })}
        </dl>
      )}
      {canSet && !adding && (
        <div className="b-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="button"
            data-size="sm"
            data-testid="budget-add"
            onClick={() => setAdding(true)}
          >
            Add a budget
          </button>
        </div>
      )}
      {canSet && adding && (
        <div className="c-form" data-testid="budget-add-form">
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
  const [period, setPeriod] = useState<UsagePeriod>("week");
  const report = useUsageReport(null, period, true, true);
  const r = report.report;
  return (
    <>
      <h4 className="b-group">By bot</h4>
      <PeriodChoice value={period} onChange={setPeriod} />
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
          <p className="b-hint" style={{ marginTop: 0 }}>
            From the gateway's usage records, {asOf(r.figure.asOf)}.
            {stillCounted(r) ? " Some of the gateway's records are still being counted." : ""}
          </p>
          <Bars
            testId="usage-bots"
            rows={(r.bots ?? []).map((each) => [
              bots.find((bot) => bot.id === each.botId)?.name ?? each.botId,
              each.figure?.tokens.total ?? 0,
            ])}
          />
          <p className="b-hint" data-testid="usage-all-total">
            Every bot: {full(r.figure.tokens.total)} tokens · {costShort(r.figure.cost)}.
            {(r.bots ?? []).some((each) => each.error)
              ? " Some bots' figures couldn't be read."
              : ""}
          </p>
          <h4 className="b-group">By source</h4>
          {r.sources ? (
            <>
              <Bars
                testId="usage-sources"
                rows={SOURCES.map(([key, words]) => [words, r.sources![key]])}
              />
              <p className="b-hint">
                Messages from other bots counts only runs a send's result names. The rest is not
                attributed, never charged to one message.
                {r.sources.partial
                  ? stillCounted(r)
                    ? " Partial: the gateway is still counting, so these may not add up to its total yet."
                    : " Partial: some tasks weren't read in full."
                  : ""}
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
