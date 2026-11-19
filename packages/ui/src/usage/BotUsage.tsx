// A bot's usage in its Settings tab (docs/design/controls.md, sections 1, 16
// and 17): the Usage group's row, and the page it opens, with the bot's budget
// first, then its figures for a period, by source, by task, and the open
// task's context. Every figure is the gateway's, with its source and its age.

import type { Bot, Task, UsagePeriod, UsageSources } from "@clawtrate/core";
import { useEffect, useState, type ComponentProps } from "react";
import { useBridge, useClawtrateState } from "../bridge.tsx";
import { BotSettings } from "../bots/BotSettings.tsx";
import { BackIcon, ChevronIcon, WarnIcon } from "../icons.tsx";
import { BudgetPart } from "./Budget.tsx";
import { settleUsageRequest, useUsageRequest } from "./navigation.ts";
import { Bars, PeriodChoice, useNow, useUsageReport } from "./parts.tsx";
import {
  asOf,
  budgetLine,
  budgetOf,
  costHint,
  costShort,
  costValue,
  full,
  short,
} from "./words.ts";
import "./usage.css";

/** The Usage group's row: its budget first, then this week's figure (section 16). */
function UsageRow({ bot, onOpen, visible }: { bot: Bot; onOpen: () => void; visible: boolean }) {
  const state = useClawtrateState();
  const now = useNow();
  const own = budgetOf(state.usage, bot.id, now);
  const report = useUsageReport(bot.id, "week", false, visible, own?.count?.asOf ?? null);
  const week =
    report.status === "error" && !report.report
      ? "Couldn't load"
      : report.report
        ? `This week: ${short(report.report.figure.tokens.total)} tokens · ${costShort(report.report.figure.cost)}`
        : "Loading…";
  const value = own ? `Budget ${budgetLine(own.budget, own.count?.used ?? null)} · ${week}` : week;
  return (
    <>
      <h3 className="b-tabgroup">Usage</h3>
      <dl className="facts">
        <div>
          <button
            type="button"
            className="b-open"
            data-bs="usage"
            data-testid="usage-row"
            aria-label={`Usage: ${value}. Open.`}
            onClick={onOpen}
          >
            <span className="c-stack">
              <span>Usage</span>
              <span className="c-stack-value">{value}</span>
            </span>
            <ChevronIcon />
          </button>
        </div>
      </dl>
    </>
  );
}

const SOURCE_NAMES: Array<[keyof Omit<UsageSources, "partial">, string]> = [
  ["people", "Messages from people"],
  ["routines", "Routines"],
  ["bots", "Messages from other bots"],
  ["unattributed", "Not attributed"],
];

/** A bot's Usage page. */
export function BotUsagePage({
  bot,
  task,
  canSet,
  announce,
  openForm,
  onBack,
}: {
  bot: Bot;
  task: Task | null;
  canSet: boolean;
  announce: (text: string) => void;
  openForm: boolean;
  onBack: () => void;
}) {
  const bridge = useBridge();
  const state = useClawtrateState();
  const now = useNow();
  const [period, setPeriod] = useState<UsagePeriod>("week");
  const [form, setForm] = useState(openForm);
  const [forForm, setForForm] = useState(openForm);
  if (forForm !== openForm) {
    setForForm(openForm);
    if (openForm) setForm(true);
  }
  const own = budgetOf(state.usage, bot.id, now);
  const report = useUsageReport(bot.id, period, true, true, own?.count?.asOf ?? null);
  // Count the budget again as the page opens, so its meter and the figures read the same records.
  useEffect(() => {
    void bridge.send({ type: "refreshUsage" }).catch(() => {});
  }, [bridge, bot.id]);
  const name = bot.name;
  const head = (
    <div className="b-subhead">
      <button
        type="button"
        className="icon-button"
        data-variant="quiet"
        aria-label="Back to settings"
        onClick={onBack}
      >
        <BackIcon />
      </button>
      <h3 tabIndex={-1} data-bs-focus="">
        Usage
      </h3>
    </div>
  );
  const budget = (
    <>
      <h4 className="b-group">Budget</h4>
      <BudgetPart
        name={name}
        target={{ botId: bot.id, routineId: null, routineName: null }}
        budget={own?.budget ?? null}
        count={own?.count ?? null}
        usage={state.usage}
        canSet={canSet}
        announce={announce}
        form={form}
        onForm={setForm}
      />
    </>
  );
  if (report.status === "loading" && !report.report)
    return (
      <div className="c-usage" data-testid="usage-page">
        {head}
        {budget}
        <div aria-busy="true" aria-label={`Loading ${name}'s usage`} data-testid="usage-loading">
          <div className="skeleton" style={{ height: 30, width: "60%", marginTop: 18 }} />
          <div className="skeleton" style={{ height: 160, width: "100%" }} />
          <div className="skeleton" style={{ height: 90, width: "100%" }} />
        </div>
      </div>
    );
  if (report.status === "error" && !report.report)
    return (
      <div className="c-usage" data-testid="usage-page">
        {head}
        {budget}
        <div className="work-empty" data-testid="usage-error">
          <span className="empty-mark">
            <WarnIcon />
          </span>
          <h4>Couldn't load {name}'s usage</h4>
          <p>{report.error}</p>
          <div style={{ marginTop: 10 }}>
            <button type="button" className="button" data-size="sm" onClick={report.retry}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  const r = report.report!;
  const figure = r.figure;
  const counting = figure.counting || (r.tasks ?? []).some((each) => each.computing);
  const sources = r.sources;
  const context = task && task.botId === bot.id ? task : null;
  return (
    <div className="c-usage" data-testid="usage-page" aria-busy={report.status === "loading"}>
      {head}
      {budget}
      <h4 className="b-group">Usage</h4>
      <PeriodChoice value={period} onChange={setPeriod} />
      <p className="b-hint" data-testid="usage-source">
        From the gateway's usage records for {name}, {asOf(figure.asOf)}.
        {counting ? " Some of the gateway's records are still being counted." : ""}
      </p>
      <dl className="facts" data-testid="usage-tokens">
        <div>
          <dt>Input</dt>
          <dd>{full(figure.tokens.input)} tokens</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>{full(figure.tokens.output)} tokens</dd>
        </div>
        <div>
          <dt>Cache read</dt>
          <dd>{full(figure.tokens.cacheRead)} tokens</dd>
        </div>
        <div>
          <dt>Cache write</dt>
          <dd>{full(figure.tokens.cacheWrite)} tokens</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd data-testid="usage-total">
            {full(figure.tokens.total)} tokens{counting ? " so far" : ""}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd data-testid="usage-cost">{costValue(figure.cost)}</dd>
        </div>
      </dl>
      <p className="b-hint" data-testid="usage-cost-hint">
        {costHint(figure.cost, figure.asOf)}
      </p>
      <h4 className="b-group">By source</h4>
      {sources ? (
        <>
          <Bars
            rows={SOURCE_NAMES.map(([key, words]) => [words, sources[key]])}
            testId="usage-sources"
          />
          <p className="b-hint">
            Messages from people: runs a person's message started. Routines: runs whose task is a
            routine's. Messages from other bots: runs a send's result names. The rest is not
            attributed, never charged to one message.
            {sources.partial
              ? counting
                ? " Partial: the gateway is still counting, so these may not add up to its total yet."
                : " Partial: some tasks weren't read in full, so more may belong to a named source."
              : ""}
          </p>
        </>
      ) : (
        <p className="b-hint" style={{ marginTop: 0 }}>
          Unavailable{r.detailError ? `: ${r.detailError}` : "."}
        </p>
      )}
      <h4 className="b-group">By task</h4>
      {r.tasks && r.tasks.length > 0 ? (
        <dl className="facts" data-testid="usage-tasks">
          {r.tasks.map((each) => (
            <div key={each.key}>
              <dt>{each.label ?? each.key}</dt>
              <dd className="b-wrap-value">
                {each.computing ? "Still being counted" : `${full(each.total)} tokens`}
              </dd>
            </div>
          ))}
          {r.tasksOmitted > 0 && (
            <div>
              <dt>
                {r.tasksOmitted} more {r.tasksOmitted === 1 ? "task" : "tasks"}
              </dt>
              <dd>Not listed</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="b-hint" style={{ marginTop: 0 }}>
          {r.tasks
            ? `No task of ${name}'s used tokens ${period === "today" ? "today" : period === "week" ? "this week" : "in the last 30 days"}.`
            : "Unavailable."}
        </p>
      )}
      <h4 className="b-group">Context</h4>
      <dl className="facts" data-testid="usage-context">
        <div>
          <dt>{context ? `'${context.title}'` : "The open task"}</dt>
          <dd className="b-wrap-value">
            {context?.context
              ? `${context.context.fresh ? "" : "about "}${full(context.context.used)} of ${full(context.context.window)} tokens`
              : context
                ? "Unavailable"
                : `No task of ${name}'s is open`}
          </dd>
        </div>
      </dl>
      <p className="b-hint">
        Breakdown unavailable: what fills it isn't reported. The gateway counts input, output and
        cache, not history, memory or tools apart.
      </p>
    </div>
  );
}

type BotSettingsProps = ComponentProps<typeof BotSettings>;

/**
 * The bot's Settings tab with its Usage group and page: the tab's own pages
 * stay `BotSettings`'s, and the Usage page replaces the tab's content while
 * it is open (bots.md section 8).
 */
export function BotSettingsWithUsage(props: BotSettingsProps & { task: Task | null }) {
  const { task, ...settings } = props;
  const [page, setPage] = useState<{ botId: string; form: boolean } | null>(null);
  // A request from outside the pane ("Raise budget" above the composer), shown once.
  const request = useUsageRequest();
  const [shown, setShown] = useState(0);
  if (request && request.seq !== shown && request.botId === props.bot.id) {
    setShown(request.seq);
    setPage({ botId: request.botId, form: request.form });
  }
  useEffect(() => {
    if (request && request.seq === shown) settleUsageRequest(request);
  }, [request, shown]);
  const open = page !== null && page.botId === props.bot.id;
  const back = () => {
    setPage(null);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>('#panel-settings [data-bs="usage"], [data-testid="usage-row"]')
        ?.focus(),
    );
  };
  // Opening the page puts focus on its title, or on the budget form's field when it opens with it.
  const withForm = open && page.form;
  useEffect(() => {
    if (open && !withForm)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-testid="usage-page"] [data-bs-focus]')?.focus(),
      );
  }, [open, withForm]);
  return (
    <BotSettings
      {...settings}
      usagePage={
        open ? (
          <BotUsagePage
            bot={props.bot}
            task={task}
            canSet={!props.info.readOnly}
            announce={props.announce}
            openForm={page.form}
            onBack={back}
          />
        ) : null
      }
      extraGroups={
        <UsageRow
          bot={props.bot}
          visible={props.visible}
          onOpen={() => setPage({ botId: props.bot.id, form: false })}
        />
      }
    />
  );
}
