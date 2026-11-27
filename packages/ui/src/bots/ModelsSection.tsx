// Settings › Models (docs/design/gateway-settings.md section 4.1): the default model every bot
// uses and the account it runs on, its backup models and the thinking level. A change applies at
// once, read back against the value this device wrote, with "Put back <earlier value>" while the
// setting still holds it (section 6). A change that restarts OpenClaw waits for one press
// (section 7). Writes go through the accounts engine, which reads and writes the models already.

import {
  gatewayBotHidden,
  openClawAtLeast,
  parseModelRef,
  type AccountsState,
  type Bot,
  type ConnectionState,
  type DefaultsChange,
  type DefaultsValues,
  type HostInfo,
} from "@clawtrate/core";
import { useState, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { screenStamp, shownStamp } from "../stamp.ts";
import { AdminBar, GrantedBar, useGranted } from "./parts.tsx";
import { accountName, providerName } from "./words.ts";
import type { SectionView } from "./AccountsSection.tsx";

/** A model reference as a person reads it: the model's name, and the account it runs on. */
export function modelWords(ref: string | null, accounts: AccountsState): string {
  const parsed = parseModelRef(ref);
  if (!parsed) return "None";
  const model = accounts.models.find(
    (m) => m.provider === parsed.provider && m.id === parsed.model,
  );
  const name = model?.name ?? parsed.model;
  const account = parsed.account ? accounts.accounts.find((a) => a.id === parsed.account) : null;
  if (account) return `${name}, on ${accountName(account, accounts)}`;
  return `${name}, ${providerName(parsed.provider)}`;
}

/** What a restart does to running work, by the gateway's version (section 7). */
export function restartWords(
  serverVersion: string | null,
  reloadOff: boolean,
): { line: string; button: string } {
  const newer = openClawAtLeast(serverVersion, 2026, 11, 10);
  // With reload off, 2026.11.10 saves the change and applies it when OpenClaw next starts; it
  // doesn't restart by itself (ran on a development gateway). 2026.10.6 restarts.
  if (reloadOff && newer)
    return {
      line: "OpenClaw applies changes like this when it restarts. Save now, and it uses this the next time it starts.",
      button: "Save",
    };
  if (serverVersion !== null && !newer)
    return {
      line: "Saving restarts OpenClaw once its bots finish what they're doing, which can take up to 5 minutes.",
      button: "Save and restart",
    };
  if (newer)
    return {
      line: "Saving restarts OpenClaw. Conversations pick up where they left off; tasks a bot started stop and may need starting again.",
      button: "Save and restart",
    };
  return {
    line: "Saving may restart OpenClaw. Work running now may be interrupted.",
    button: "Save and restart",
  };
}

const FIELD_NAMES: Record<keyof DefaultsValues, string> = {
  primary: "Default model",
  fallbacks: "Backup models",
  thinking: "Thinking",
};

/** One setting's value as a person reads it. */
function valueWords(
  field: keyof DefaultsValues,
  values: DefaultsValues,
  accounts: AccountsState,
): string {
  const value = values[field];
  if (field === "primary") return modelWords((value as string | null) ?? null, accounts);
  if (field === "fallbacks") {
    const list = (value as string[] | null) ?? [];
    return list.length === 0
      ? "none"
      : list.map((ref) => modelWords(ref, accounts)).join(", then ");
  }
  return (value as string | null) ?? "the model's own";
}

/** The line a change leaves, as `section 6` and `section 7` word it. */
export function changeLine(
  change: DefaultsChange,
  accounts: AccountsState,
  serverVersion: string | null,
): string {
  const field = (Object.keys(change.after)[0] ?? "primary") as keyof DefaultsValues;
  const name = FIELD_NAMES[field];
  const after = valueWords(field, change.after, accounts);
  switch (change.status) {
    case "held":
      return restartWords(serverVersion, accounts.defaults?.reloadOff ?? false).line;
    case "saving":
      return `Saving ${name.toLowerCase()}…`;
    case "restarting":
      return `OpenClaw is restarting to apply ${name.toLowerCase()}.`;
    case "saved":
      return `${name} is now ${after}.`;
    case "changedSince":
      return `Changed on another device since: ${name.toLowerCase()} is now ${valueWords(field, change.current ?? {}, accounts)}.`;
    case "notApplied":
      return "Saved. OpenClaw applies it when it next restarts.";
    case "unconfirmed":
      return "Clawtrate can't reach OpenClaw yet, so it can't confirm the change applied.";
    case "failed":
      return change.error ?? "That change wasn't saved.";
  }
}

export function useModelsSection({
  accounts,
  bots,
  connection,
  info,
  announce,
  toNav,
  showGatewayBot = false,
}: {
  accounts: AccountsState;
  bots: readonly Bot[];
  /** "Show the gateway's own bot" (Advanced): otherwise it is left out, as in every bot list. */
  showGatewayBot?: boolean;
  connection: ConnectionState;
  info: HostInfo;
  announce: (text: string) => void;
  toNav: ReactNode;
}): SectionView {
  const bridge = useBridge();
  const granted = useGranted(connection);
  const admin = connection.canAdmin && !info.readOnly;
  // Where the values shown were read: a change made from them goes only to that gateway.
  const shownOn = accounts.readOn ?? shownStamp(connection);
  const [busy, setBusy] = useState(false);
  /** The held change the person set aside with Cancel, by when it was held. */
  const [setAside, setSetAside] = useState<number | null>(null);
  const defaults = accounts.defaults;
  const change = accounts.defaultsChange;
  const version = connection.serverVersion;

  const run = async (command: Parameters<typeof bridge.invoke>[0]) => {
    setBusy(true);
    try {
      await bridge.invoke(command);
    } catch {
      // The engine keeps what happened in `defaultsChange`; the line says it.
    } finally {
      setBusy(false);
    }
  };
  const set = async (values: DefaultsValues, restart = false) => {
    setSetAside(null);
    await run({
      type: "setModelDefaults",
      values,
      restart,
      stamp: await screenStamp(bridge, shownOn),
    });
  };
  const putBack = async () =>
    run({ type: "putBackModelDefaults", stamp: await screenStamp(bridge, shownOn) });

  // Each signed-in account's models, named for the person: "Swift 2 · Acme · Work".
  const choices = accounts.accounts.flatMap((account) =>
    accounts.models
      .filter((m) => m.provider === account.provider && m.available)
      .map((m) => ({
        ref: `${m.provider}/${m.id}@${account.id}`,
        words: `${m.name ?? m.id} · ${accountName(account, accounts)}`,
      })),
  );
  const options = (current: string | null) => {
    const listed = choices.some((c) => c.ref === current);
    return (
      <>
        {current !== null && !listed && (
          <option value={current}>{modelWords(current, accounts)}</option>
        )}
        {choices.map((c) => (
          <option key={c.ref} value={c.ref}>
            {c.words}
          </option>
        ))}
      </>
    );
  };
  const primary = parseModelRef(defaults?.primary ?? null);
  const levels =
    accounts.models.find((m) => m.provider === primary?.provider && m.id === primary?.model)
      ?.levels ?? [];
  const fallbacks = defaults?.fallbacks ?? [];
  const disabled = !admin || busy || defaults === null;

  const line =
    change && !(change.status === "held" && setAside === change.at) ? (
      <div className="b-models-line" role="status" data-status={change.status}>
        <span>{changeLine(change, accounts, version)}</span>
        {change.status === "held" && (
          <>
            <button
              type="button"
              className="button"
              data-variant="primary"
              data-size="sm"
              disabled={!admin || busy}
              onClick={() => void set(change.after, true)}
            >
              {restartWords(version, defaults?.reloadOff ?? false).button}
            </button>
            <button
              type="button"
              className="button"
              data-variant="quiet"
              data-size="sm"
              onClick={() => {
                setSetAside(change.at);
                announce("Not changed");
              }}
            >
              Cancel
            </button>
          </>
        )}
        {change.status === "saved" && (
          <button
            type="button"
            className="button"
            data-variant="quiet"
            data-size="sm"
            disabled={!admin || busy}
            onClick={() => void putBack()}
          >
            Put back{" "}
            {valueWords(
              (Object.keys(change.before)[0] ?? "primary") as keyof DefaultsValues,
              change.before,
              accounts,
            )}
            {change.restart ? " and restart" : ""}
          </button>
        )}
      </div>
    ) : null;

  const body = (
    <div className="b-models">
      {defaults === null ? (
        <p className="b-hint">
          {accounts.status === "error" ? accounts.error : "Reading the models…"}
        </p>
      ) : (
        <>
          <h4 className="b-group">For every bot</h4>
          <label className="b-field">
            <span>Default model</span>
            <select
              className="input"
              value={defaults.primary ?? ""}
              disabled={disabled}
              onChange={(event) => void set({ primary: event.target.value })}
            >
              {defaults.primary === null && <option value="">None</option>}
              {options(defaults.primary)}
            </select>
            <span className="b-hint">What a bot uses unless it has a model of its own.</span>
          </label>
          <div className="b-field">
            <span id="b-models-backups">If it can't answer</span>
            <ul className="b-models-backups" aria-labelledby="b-models-backups">
              {fallbacks.map((ref) => (
                <li key={ref}>
                  <span>{modelWords(ref, accounts)}</span>
                  {admin && (
                    <button
                      type="button"
                      className="button"
                      data-variant="quiet"
                      data-size="sm"
                      disabled={disabled}
                      aria-label={`Remove ${modelWords(ref, accounts)} from the backups`}
                      onClick={() =>
                        void set({ fallbacks: fallbacks.filter((each) => each !== ref) })
                      }
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <select
              className="input"
              aria-label="Add a backup model"
              value=""
              disabled={disabled}
              onChange={(event) =>
                event.target.value && void set({ fallbacks: [...fallbacks, event.target.value] })
              }
            >
              <option value="">
                {fallbacks.length === 0 ? "Add a backup model" : "Add another"}
              </option>
              {choices
                .filter((c) => c.ref !== defaults.primary && !fallbacks.includes(c.ref))
                .map((c) => (
                  <option key={c.ref} value={c.ref}>
                    {c.words}
                  </option>
                ))}
            </select>
          </div>
          {levels.length > 0 && (
            <label className="b-field">
              <span>Thinking</span>
              <select
                className="input"
                value={defaults.thinking ?? ""}
                disabled={disabled}
                onChange={(event) => void set({ thinking: event.target.value || null })}
              >
                <option value="">The model's own</option>
                {levels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          )}
          {line}
          <h4 className="b-group">Each bot</h4>
          <ul className="b-models-bots">
            {bots
              .filter((bot) => !gatewayBotHidden(bot, bots, showGatewayBot))
              .map((bot) => {
                const binding = accounts.bindings.find((b) => b.botId === bot.id);
                const own = binding && binding.mode !== "default-model" ? binding.primary : null;
                return (
                  <li key={bot.id}>
                    <span className="b-models-bot">{bot.name}</span>
                    <span className="b-hint">
                      {own
                        ? modelWords(own, accounts)
                        : `The default: ${modelWords(defaults.primary, accounts)}`}
                    </span>
                  </li>
                );
              })}
          </ul>
        </>
      )}
    </div>
  );

  const foot = granted ? (
    <GrantedBar />
  ) : admin ? null : (
    <AdminBar connection={connection} info={info} need="Changing the models needs admin access." />
  );
  return { title: "Models", back: toNav, body, foot };
}
