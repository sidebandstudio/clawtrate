// Budgets and provider limits in the conversation (docs/design/controls.md,
// sections 16 to 18): the grey line at 80 percent of a bot's budget, the note
// above the composer at 100 percent, the note near a provider's reported
// limit, and the desktop notification at 80 percent. Each is a warning: none
// says a run or a send was stopped, held or refused.

import {
  BUDGET_WARN_PERCENT,
  budgetPercent,
  currentCount,
  LIMIT_NOTE_PERCENT,
  type Bot,
  type UsageState,
} from "@clawtrate/core";
import { useEffect, useState } from "react";
import { useClawtrateState } from "../bridge.tsx";
import { CloseIcon } from "../icons.tsx";
import { requestUsagePage } from "./navigation.ts";
import { useNow } from "./parts.tsx";
import { asOf, budgetOf, reachedLine, warnedLine } from "./words.ts";
import "./usage.css";

/** Between 80 and 100 percent of the bot's budget: one grey line at the end of its open task (F-396). */
export function BudgetLine({ bot }: { bot: Bot }) {
  const state = useClawtrateState();
  const now = useNow();
  const own = budgetOf(state.usage, bot.id, now);
  if (!own || own.percent === null || own.count?.used == null) return null;
  if (own.percent < BUDGET_WARN_PERCENT || own.percent >= 100) return null;
  return (
    <p className="event-line" data-side="center" data-testid="budget-line">
      {warnedLine(bot.name, own.budget, own.count.used, own.percent)}
    </p>
  );
}

const day = (at: number) =>
  new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The provider a bot's model names (`provider/model`). */
const providerOf = (bot: Bot) => (bot.model?.includes("/") ? bot.model.split("/")[0]! : null);

/** Notes above the composer: the budget reached, and a provider's reported limit near or reached. */
export function UsageNotes({ bot, canSet }: { bot: Bot; canSet: boolean }) {
  const state = useClawtrateState();
  const now = useNow();
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const own = budgetOf(state.usage, bot.id, now);
  const provider =
    state.accounts.bindings.find((each) => each.botId === bot.id)?.provider ?? providerOf(bot);
  const limits = state.usage?.limits;
  const near =
    provider && limits?.status === "ok"
      ? limits.providers
          .filter((each) => each.provider === provider)
          .flatMap((each) =>
            each.windows
              .filter((window) => window.usedPercent >= LIMIT_NOTE_PERCENT)
              .map((window) => ({ provider: each, window })),
          )
      : [];
  const notes = near
    .map(({ provider: each, window }) => {
      // Closed until the figure changes.
      const key = `${each.provider}:${window.label}:${window.usedPercent}`;
      const kind = window.label.toLowerCase();
      const at = asOf(limits?.updatedAt ?? null);
      const words =
        window.usedPercent >= 100
          ? `${each.displayName} reports a ${kind} limit reached, ${at}.${window.resetAt ? ` It resets ${day(window.resetAt)}.` : ""}`
          : `${each.displayName} reports ${Math.round(window.usedPercent)}% of a ${kind} limit used, ${at}. It doesn't say which of your ${each.displayName} accounts.`;
      return { key, words };
    })
    .filter((note) => !closed.has(note.key));
  const reached = own && own.percent !== null && own.percent >= 100;
  if (!reached && notes.length === 0) return null;
  return (
    <div className="c-composer-notes">
      {notes.map((note) => (
        <div
          key={note.key}
          className="c-composer-note"
          data-tone="neutral"
          role="status"
          data-testid="limit-note"
        >
          <p>{note.words}</p>
          <button
            type="button"
            className="icon-button"
            data-variant="quiet"
            aria-label="Close"
            onClick={() => setClosed((was) => new Set(was).add(note.key))}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
      {reached && (
        <div className="c-composer-note" role="status" data-testid="budget-reached-note">
          <p>{reachedLine(bot.name, own.budget)}</p>
          {canSet && (
            <button
              type="button"
              className="button"
              data-size="sm"
              data-testid="raise-from-composer"
              onClick={() => requestUsagePage(bot.id, true)}
            >
              Raise budget
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const NOTIFIED = "clawtrate.budget-notified";

function readNotified(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(NOTIFIED) ?? "{}");
    return value && typeof value === "object" ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * A system notification when a budget's count first passes 80 percent in its
 * period (F-396), once per budget and period on this device. Only where the
 * platform allows notifications: the desktop app does; a browser only once the
 * person allowed them, which the budget form asks when a budget is saved.
 */
export function useBudgetNotifications(usage: UsageState | undefined, bots: readonly Bot[]): void {
  useEffect(() => {
    if (!usage || usage.budgets.length === 0) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const now = Date.now();
    const notified = readNotified();
    let changed = false;
    for (const budget of usage.budgets) {
      const count = currentCount(usage, budget, now);
      const percent = budgetPercent(budget, count?.used ?? null);
      if (!count || percent === null || percent < BUDGET_WARN_PERCENT) continue;
      const mark = `${count.range.startDate}:${percent >= 100 ? "reached" : "warned"}`;
      if (notified[budget.id] === mark) continue;
      if (percent < 100 && notified[budget.id] === `${count.range.startDate}:reached`) continue;
      notified[budget.id] = mark;
      changed = true;
      const name = bots.find((bot) => bot.id === budget.botId)?.name ?? budget.botId;
      const who = budget.routineId
        ? `${name}'s routine ${budget.routineName ?? budget.routineId}`
        : name;
      try {
        new Notification(
          percent >= 100
            ? `${who} reached its warning budget`
            : `${who} used ${percent}% of its budget`,
          {
            body:
              percent >= 100
                ? "This is shown only: nothing was stopped."
                : warnedLine(who, budget, count.used!, percent),
            tag: `clawtrate-budget-${budget.id}`,
          },
        );
      } catch {
        // The platform refused it; the line in the task still warns.
      }
    }
    if (changed)
      try {
        localStorage.setItem(NOTIFIED, JSON.stringify(notified));
      } catch {
        // Storage may be unavailable; the next count may notify again.
      }
  }, [usage, bots]);
}
