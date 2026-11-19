// Budgets and provider limits in the conversation (docs/design/controls.md,
// sections 16 to 18): the grey line at 80 percent of a bot's budget, the note
// above the composer at 100 percent, the note near a provider's reported
// limit. Each is a warning: none says a run or a send was stopped, held or
// refused. A system notification waits for the notifications design.

import { BUDGET_WARN_PERCENT, LIMIT_NOTE_PERCENT, type Bot } from "@clawtrate/core";
import { useState } from "react";
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
