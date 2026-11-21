// The account choices (bots.md sections 4 and 11): one radio group, in
// blocks, subscriptions first, and last, set apart, "Let the gateway choose".
// One tab stop: the chosen row, or the first when none is; arrows move and
// choose; Home and End go to the ends; Space or Enter chooses.

import type { AccountsState, Bot, GatewayAccount } from "@clawtrate/core";
import { useRef, type KeyboardEvent } from "react";
import { CheckIcon, ChevronIcon } from "../icons.tsx";
import { accountGroups, accountLine, accountName, accountParts, providerName } from "./words.ts";

/** The value of the "Let the gateway choose" row. */
export const GATEWAY_CHOICE = "__gateway";

export function AccountTitle({
  account,
  accounts,
}: {
  account: GatewayAccount;
  accounts: Pick<AccountsState, "labels" | "accounts">;
}) {
  const { label, id } = accountParts(account, accounts);
  // The id, when it is needed, is a line of its own: the label gives way, never the id.
  return (
    <>
      <span className="b-choice-name">
        {providerName(account.provider)}
        {label && <span> · {label}</span>}
      </span>
      {id && <span className="mono b-choice-id">{id}</span>}
    </>
  );
}

function AccountText({
  account,
  accounts,
  bots,
  now,
}: {
  account: GatewayAccount;
  accounts: AccountsState;
  bots: readonly Bot[];
  now: number;
}) {
  const line = accountLine(account, accounts, bots, now);
  return (
    <span className="b-choice-text">
      <span className="b-choice-title" title={accountName(account, accounts)}>
        <AccountTitle account={account} accounts={accounts} />
      </span>
      {/* Wraps rather than cuts: who the views say names the account is read whole. */}
      <span className="b-choice-sub b-wrap">
        {line.kind}
        {line.state && (
          <>
            {" · "}
            <span data-tone={line.state.tone}>{line.state.word}</span>
          </>
        )}
        {" · "}
        {line.users}
      </span>
    </span>
  );
}

export function AccountChoices({
  label,
  list,
  accounts,
  bots,
  chosen,
  onChoose,
  disabled,
  gatewayLine,
  now,
  keptToo = false,
}: {
  label: string;
  list: readonly GatewayAccount[];
  accounts: AccountsState;
  bots: readonly Bot[];
  /** An account id, `GATEWAY_CHOICE`, or null for nothing chosen yet. */
  chosen: string | null;
  onChoose: (value: string) => void;
  disabled: boolean;
  gatewayLine: string;
  now: number;
  keptToo?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const groups = accountGroups(list, keptToo);
  const values = [...groups.flatMap((group) => group.accounts.map((a) => a.id)), GATEWAY_CHOICE];
  const stop = chosen && values.includes(chosen) ? chosen : values[0];

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = values.indexOf(
      (document.activeElement as HTMLElement | null)?.dataset.value ?? "",
    );
    if (index < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % values.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      next = (index - 1 + values.length) % values.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = values.length - 1;
    if (next === null) return;
    event.preventDefault();
    const value = values[next]!;
    ref.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`)?.focus();
    if (!disabled) onChoose(value);
  };

  const radio = (value: string, content: React.ReactNode, name: string) => (
    <button
      type="button"
      className="b-choice"
      role="radio"
      aria-checked={chosen === value}
      aria-disabled={disabled || undefined}
      aria-label={name}
      tabIndex={value === stop ? 0 : -1}
      data-value={value}
      onClick={() => !disabled && onChoose(value)}
    >
      {content}
      <CheckIcon className="b-tick" />
    </button>
  );

  return (
    <div
      role="radiogroup"
      aria-label={label}
      ref={ref}
      onKeyDown={onKey}
      data-testid="account-choices"
    >
      {groups.map((group) => (
        <div key={group.title}>
          <h4 className="b-group">{group.title}</h4>
          <ul className="b-choices">
            {group.accounts.map((account) => {
              const line = accountLine(account, accounts, bots, now);
              const name = [accountName(account, accounts), line.kind, line.state?.word, line.users]
                .filter(Boolean)
                .join(", ");
              return (
                <li key={account.id}>
                  {radio(
                    account.id,
                    <AccountText account={account} accounts={accounts} bots={bots} now={now} />,
                    name,
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {accounts.labels && list.some((account) => !account.label) && (
        <p className="b-hint" data-testid="unlabelled-hint">
          An account without a label is named by its id on the gateway. Settings → Accounts can
          label it.
        </p>
      )}
      <ul className="b-choices b-gw">
        <li>
          {radio(
            GATEWAY_CHOICE,
            <span className="b-choice-text">
              <span className="b-choice-title">Let the gateway choose</span>
              <span className="b-choice-sub b-wrap">{gatewayLine}</span>
            </span>,
            `Let the gateway choose. ${gatewayLine}`,
          )}
        </li>
      </ul>
    </div>
  );
}

/** A row that opens something: the account's page in Settings. */
export function AccountRow({
  account,
  accounts,
  bots,
  now,
  onOpen,
  onLabel,
}: {
  account: GatewayAccount;
  accounts: AccountsState;
  bots: readonly Bot[];
  now: number;
  onOpen: () => void;
  /** On admin, an account without a label offers to label it (section 6). */
  onLabel?: () => void;
}) {
  const offer = onLabel && accounts.labels && !account.label;
  const line = accountLine(account, accounts, bots, now);
  const name = [accountName(account, accounts), line.kind, line.state?.word, line.users]
    .filter(Boolean)
    .join(", ");
  return (
    <li className={offer ? "b-choice-with" : undefined}>
      <button
        type="button"
        className="b-choice"
        data-account={account.id}
        aria-label={`${name}. Open.`}
        onClick={onOpen}
      >
        <AccountText account={account} accounts={accounts} bots={bots} now={now} />
        {!offer && <ChevronIcon />}
      </button>
      {offer && (
        <button
          type="button"
          className="button"
          data-variant="quiet"
          data-size="sm"
          data-label-offer={account.id}
          aria-label={`Add a label to ${accountName(account, accounts)}`}
          onClick={onLabel}
        >
          Add a label
        </button>
      )}
    </li>
  );
}

/** The one line of "Let the gateway choose" (section 4). */
export function gatewayLine(
  accounts: AccountsState,
  provider: string | null,
  model: string | null,
  own: { bot: string } | null,
): string {
  if (!provider || !model)
    return "No fixed account. The gateway picks an account for each run, as its account order allows.";
  const who = providerName(provider);
  const which = own ? `${own.bot}'s own model, ${model}` : `its default model, ${model}`;
  const any = accounts.accounts.some((a) => a.provider === provider && a.keptBy === null);
  return any
    ? `No fixed account. The gateway picks one of ${who}'s accounts for each run, as its account order allows, with ${which}.`
    : `No fixed account. The gateway uses what it has for ${who}, with ${which}.`;
}
