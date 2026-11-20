// Connecting an account (bots.md sections 5 and 6): one component, inside New
// bot and in Settings → Accounts. It starts the gateway's own sign-in and
// shows its stages; the API key path is folded under its own option. The code
// pasted back and a typed key go to the gateway once and are kept nowhere:
// their fields are cleared as they are sent.

import {
  isSecretStep,
  isSignInActive,
  labelProblem,
  normalizeLabel,
  type AccountsState,
  type Bot,
  type ConnectionState,
  type GatewayAccount,
  type HostInfo,
  type SignInMethod,
  type SignInState,
  type SignInStep,
} from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { ChevronIcon, ExternalIcon, LockIcon } from "../icons.tsx";
import { recall, remember } from "./memory.ts";
import { AdminBar, CodeBlock, CommandBlock, Note, Result, Wait } from "./parts.tsx";
import { AccountTitle } from "./AccountChoices.tsx";
import {
  accountName,
  flowWords,
  forwardCommand,
  opensIn,
  pageDestination,
  providerName,
  REFUSED_PAGE,
} from "./words.ts";

/** A label step left before Done, kept until the app quits so it comes back (section 6). */
const LABEL_KEPT = "connect-label";
/**
 * What the naming screen says of how its account came to be listed: nothing
 * when the read confirmed it, otherwise the outcome it came from.
 */
type Unconfirmed = { title: string; text: string } | null;
type KeptLabel = {
  account: string;
  byKey: boolean;
  unconfirmed?: Unconfirmed;
  candidate?: boolean;
};

/** The label step left open, when its account is still on the gateway. */
export function keptLabel(accounts: AccountsState): KeptLabel | null {
  const kept = recall<KeptLabel>(LABEL_KEPT);
  if (!kept) return null;
  const there =
    accounts.accounts.some((each) => each.id === kept.account) ||
    (accounts.signIn?.result?.added.includes(kept.account) ?? false);
  return there ? kept : null;
}

export type ConnectView = {
  title: string;
  backLabel: string;
  body: ReactNode;
  foot: ReactNode;
  /** Back: what it does depends on the view. */
  onBack: () => void;
};

type Where =
  | { view: "methods" }
  | { view: "flow"; method: string }
  | {
      view: "label";
      account: string;
      byKey: boolean;
      unconfirmed?: Unconfirmed;
      /** Chosen by the person from the read after a sign-in whose answer named no account. */
      candidate?: boolean;
    }
  | { view: "same"; provider: string }
  /** A key the gateway took whose account the read after it didn't show, with its warning. */
  | { view: "key-check"; provider: string; known: string[]; warning: string | null };

/**
 * The connect component's state and views. The caller draws its head and
 * foot in its own frame (the New bot dialog, a Settings section).
 */
export function useConnect({
  forBot,
  accounts,
  bots,
  connection,
  info,
  announce,
  onDone,
  onLeave,
  startWith,
}: {
  /** The bot the person is working on, when there is one. */
  forBot: string | null;
  accounts: AccountsState;
  bots: readonly Bot[];
  connection: ConnectionState;
  info: HostInfo;
  announce: (text: string) => void;
  /** A sign-in or key finished with this account (or none appeared). */
  onDone: (account: string | null) => void;
  /** Back from the first screen. */
  onLeave: () => void;
  /** "Sign in again": start this method at once. */
  startWith?: string;
}): ConnectView {
  const bridge = useBridge();
  const admin = connection.canAdmin;
  // Done: the sign-in that finished is let go, so the component opens afresh next time.
  const finish = (account: string | null) => {
    remember(LABEL_KEPT, null);
    void bridge.send({ type: "dismissSignIn" }).catch(() => {});
    onDone(account);
  };
  const signIn = accounts.signIn;
  const [where, setWhereState] = useState<Where>(() => {
    if (startWith && connection.canAdmin) return { view: "flow", method: startWith };
    if (signIn && isSignInActive(signIn)) return { view: "flow", method: signIn.method };
    const kept = keptLabel(accounts);
    return kept ? { view: "label", ...kept } : { view: "methods" };
  });
  // The label step is kept while it is open; leaving it any other way than closing lets it go.
  const setWhere = (next: Where) => {
    remember(
      LABEL_KEPT,
      next.view === "label"
        ? {
            account: next.account,
            byKey: next.byKey,
            unconfirmed: next.unconfirmed ?? null,
            candidate: next.candidate ?? false,
          }
        : null,
    );
    setWhereState(next);
  };
  const [label, setLabel] = useState("");
  const [labelFor, setLabelFor] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [keyProvider, setKeyProvider] = useState(accounts.keyProviders[0]?.provider ?? "");
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyAgain, setKeyAgain] = useState(0);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLInputElement>(null);

  // A sign-in that finished moves on to its label; one that found no new account says so.
  const stage = signIn?.stage ?? null;
  const result = signIn?.result ?? null;
  const [seen, setSeen] = useState<{ stage: string | null; result: unknown }>({ stage, result });
  if (seen.stage !== stage || seen.result !== result) {
    setSeen({ stage, result });
    // Refreshed: it finished with no new account.
    if (where.view === "flow" && signIn && signIn.method === where.method && result) {
      if (stage === "refreshed") setWhere({ view: "same", provider: signIn.provider });
    }
  }
  useEffect(() => {
    if (!signIn) return;
    if (stage === "several" && result) announce(`Signed in to ${providerName(signIn.provider)}`);
    else if (stage === "cancelled") announce("Sign-in cancelled");
    // Once per stage reached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, result === null]);

  const targetBot = accounts.mainShared
    ? "main"
    : (forBot ?? bots.find((bot) => bot.isDefault)?.id ?? bots[0]?.id ?? null);
  const targetName = bots.find((bot) => bot.id === targetBot)?.name ?? "this bot";
  const method = (id: string) => accounts.methods.find((each) => each.id === id) ?? null;

  const begin = useCallback(
    async (id: string) => {
      await bridge.send({ type: "dismissSignIn" }).catch(() => {});
      await bridge.send({ type: "startSignIn", methodId: id, botId: forBot }).catch(() => {});
    },
    [bridge, forBot],
  );
  const start = async (id: string) => {
    setWhere({ view: "flow", method: id });
    await begin(id);
  };
  // A new view or stage moves focus on purpose: to its field, or else to its title.
  const shownView = `${where.view}:${where.view === "flow" ? (stage ?? "") : ""}`;
  useEffect(() => {
    requestAnimationFrame(() => {
      const dialogs = document.querySelectorAll<HTMLElement>("dialog[open]");
      // In a dialog (New bot, Settings), or in a bot's Settings tab.
      const top =
        dialogs[dialogs.length - 1] ??
        document.querySelector<HTMLElement>('[data-testid="bot-settings"]');
      if (!top) return;
      (
        top.querySelector<HTMLElement>("[data-b-focus]:not([disabled])") ??
        top.querySelector<HTMLElement>("#create-title, #b-section-title, [data-bs-focus]")
      )?.focus();
    });
  }, [shownView]);
  // "Sign in again" opens on the sign-in itself.
  const [startedWith] = useState(startWith && admin ? startWith : null);
  useEffect(() => {
    if (startedWith) void begin(startedWith);
  }, [startedWith, begin]);
  const toMethods = async () => {
    // A sign-in under way is left only once the gateway confirms its cancel: otherwise it stays
    // on screen, saying the cancel is not known.
    if (signIn && isSignInActive(signIn)) {
      const answer = await bridge
        .invoke({ type: "cancelSignIn" })
        .catch(() => ({ cancelled: false }));
      if (!answer.cancelled) return;
    }
    await bridge.send({ type: "dismissSignIn" }).catch(() => {});
    setWhere({ view: "methods" });
  };
  // A key's sign-in that ended without a key saved starts again where a key is typed.
  const toKey = async (provider: string) => {
    await bridge.send({ type: "dismissSignIn" }).catch(() => {});
    if (accounts.keyProviders.some((each) => each.provider === provider)) setKeyProvider(provider);
    setKeyOpen(true);
    setKeyAgain((n) => n + 1);
    setWhere({ view: "methods" });
  };
  // The key's fields, brought into view as the disclosure opens (a phone shows little at once).
  useEffect(() => {
    if (keyOpen) requestAnimationFrame(() => keyRef.current?.scrollIntoView({ block: "nearest" }));
  }, [keyOpen]);
  useEffect(() => {
    if (keyAgain > 0) requestAnimationFrame(() => keyRef.current?.focus());
  }, [keyAgain]);

  // --- Choosing how -------------------------------------------------------------
  if (where.view === "methods") {
    const subs = accounts.methods.filter((m) => m.group === "subscription" && m.flow !== "key");
    const token = accounts.methods.filter((m) => m.group === "token" && m.flow !== "key");
    const row = (m: SignInMethod) => (
      <li key={m.id}>
        <button
          type="button"
          className="b-choice"
          data-method={m.id}
          aria-disabled={!admin || undefined}
          onClick={() => admin && void start(m.id)}
        >
          <span className="b-choice-text">
            <span className="b-choice-title">
              {m.label} {m.hint && <span>· {m.hint}</span>}
            </span>
            <span className="b-choice-sub">{flowWords(m.flow)}</span>
          </span>
          <ChevronIcon />
        </button>
      </li>
    );
    const kp = accounts.keyProviders.find((each) => each.provider === keyProvider);
    const replaced = kp?.replaces ? accounts.accounts.find((a) => a.id === kp.replaces) : undefined;
    const saveKey = async () => {
      const key = keyRef.current?.value ?? "";
      if (!key.trim()) {
        setKeyError("Enter a key.");
        return;
      }
      // The field is cleared at once: the key is in this one request, and nowhere after it.
      if (keyRef.current) keyRef.current.value = "";
      const known = accounts.accounts.filter((a) => a.provider === keyProvider).map((a) => a.id);
      setKeyError(null);
      setSaving(true);
      try {
        if (kp?.method) setWhere({ view: "flow", method: kp.method });
        const { profileId, warning } = await bridge.invoke({
          type: "saveApiKey",
          provider: keyProvider,
          key,
          botId: forBot,
        });
        if (!kp?.method) {
          // Saved only when the read after it shows the account; otherwise it says so. The
          // gateway's warning stays with it.
          if (profileId) {
            announce(warning ? "Key saved, not confirmed" : "Key saved");
            setWhere({
              view: "label",
              account: profileId,
              byKey: true,
              unconfirmed: warning ? { title: "Saved, not confirmed", text: warning } : null,
            });
          } else setWhere({ view: "key-check", provider: keyProvider, known, warning });
        }
      } catch (error) {
        setKeyError(error instanceof Error ? error.message : String(error));
        setWhere({ view: "methods" });
      } finally {
        setSaving(false);
      }
    };
    const body = (
      <>
        <Note testId="kept-note">
          <p>Clawtrate starts sign-in for {targetName}.</p>
        </Note>
        <p className="b-lead">
          Sign in with a subscription you already pay for. Your gateway does the sign-in and keeps
          it; Clawtrate never sees your password and never keeps the sign-in.
        </p>
        {subs.length > 0 && (
          <>
            <h4 className="b-group">Subscriptions</h4>
            <ul className="b-choices">{subs.map(row)}</ul>
          </>
        )}
        {token.length > 0 && (
          <>
            <h4 className="b-group">Billed per token</h4>
            <ul className="b-choices">{token.map(row)}</ul>
          </>
        )}
        {subs.length + token.length === 0 && (
          <p className="b-hint">
            This gateway offers no sign-in Clawtrate can start. Sign in on the gateway's machine.
          </p>
        )}
        {accounts.keyProviders.length > 0 && (
          <details
            className="b-disclosure"
            open={keyOpen}
            onToggle={(event) => setKeyOpen(event.currentTarget.open)}
          >
            <summary>
              <ChevronIcon />
              Use an API key instead
            </summary>
            <div className="b-disclosure-body">
              <label className="b-field">
                <span>Provider</span>
                <select
                  className="input"
                  value={keyProvider}
                  disabled={!admin}
                  onChange={(event) => setKeyProvider(event.target.value)}
                >
                  {accounts.keyProviders.map((each) => (
                    <option key={each.provider} value={each.provider}>
                      {providerName(each.provider)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="b-field">
                <span>Key</span>
                <input
                  ref={keyRef}
                  className="input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the key"
                  disabled={!admin}
                  aria-invalid={keyError ? true : undefined}
                  aria-describedby={keyError ? "b-key-error" : undefined}
                  data-testid="api-key"
                />
              </label>
              {keyError && (
                <p className="b-field-error" id="b-key-error" role="alert">
                  {keyError}
                </p>
              )}
              {/* Only from a read that succeeded: a reference kept from an earlier one may be gone. */}
              {kp?.replaces && !kp.method && accounts.status === "ready" && (
                <Note tone="warn" testId="key-replaces">
                  <p>
                    If saved, this key replaces{" "}
                    {replaced ? accountName(replaced, accounts) : kp.replaces}, which the gateway's{" "}
                    {providerName(keyProvider)} settings name. To keep both, add the second on the
                    gateway's machine.
                  </p>
                </Note>
              )}
              <p className="b-hint">Clawtrate sends the key to your gateway.</p>
              <div className="b-actions" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="button"
                  data-size="sm"
                  disabled={!admin || saving}
                  onClick={() => void saveKey()}
                >
                  {saving ? "Saving…" : "Save key"}
                </button>
              </div>
            </div>
          </details>
        )}
      </>
    );
    return {
      title: "Connect an account",
      backLabel: "Back to accounts",
      body,
      foot: admin ? null : (
        <AdminBar
          connection={connection}
          info={info}
          need="Connecting an account needs admin access. The gateway lets only admin connections start a sign-in."
        />
      ),
      onBack: onLeave,
    };
  }

  // --- A key not confirmed --------------------------------------------------------
  if (where.view === "key-check") {
    const who = providerName(where.provider);
    const fresh = accounts.accounts
      .filter((a) => a.provider === where.provider && !where.known.includes(a.id))
      .map((a) => a.id);
    // A new account in the list says nothing of whether this key was applied: it is said, and
    // the person returns to Accounts. The gateway's warning stays with it.
    const appeared = accounts.status === "ready" && fresh.length > 0;
    const written = accounts.write?.what === "key" ? accounts.write.error : null;
    return {
      title: "API key",
      backLabel: "Back to sign-in methods",
      body: (
        <Result tone="warn" mark="clock" title="Key sent, not confirmed">
          {where.warning && !written?.includes(where.warning) && (
            <>
              <span data-testid="key-warning">{where.warning}</span>{" "}
            </>
          )}
          {written ?? `The gateway took the key, but Clawtrate hasn't seen its ${who} account yet.`}{" "}
          {appeared
            ? `The gateway now lists a new ${who} account.`
            : "Check again reads the gateway's accounts."}
        </Result>
      ),
      foot: appeared ? (
        <button
          type="button"
          className="button"
          data-variant="primary"
          data-size="lg"
          onClick={() => finish(null)}
        >
          Continue
        </button>
      ) : (
        <button
          type="button"
          className="button"
          data-variant="primary"
          data-size="lg"
          onClick={() => void bridge.send({ type: "refreshAccounts" }).catch(() => {})}
        >
          Check again
        </button>
      ),
      onBack: () => setWhere({ view: "methods" }),
    };
  }

  // --- Naming the account -------------------------------------------------------
  if (where.view === "label" || where.view === "same") {
    if (where.view === "same") {
      const who = providerName(where.provider);
      return {
        title: "Connect an account",
        backLabel: "Back to sign-in methods",
        body: (
          <Result tone="ok" mark="check" title="Signed in">
            No new {who} account appeared: if this was an account you already have, the gateway may
            have refreshed its sign-in.
          </Result>
        ),
        foot: (
          <button
            type="button"
            className="button"
            data-variant="primary"
            data-size="lg"
            onClick={() => finish(null)}
          >
            Done
          </button>
        ),
        onBack: () => void toMethods(),
      };
    }
    const account: GatewayAccount | null =
      accounts.accounts.find((each) => each.id === where.account) ?? null;
    // An account that already has a label, such as a key that replaced the one before, keeps it.
    if (labelFor !== where.account) {
      setLabelFor(where.account);
      setLabel(account?.label ?? "");
    }
    const provider = account?.provider ?? where.account.split(":")[0]!;
    const who = providerName(provider);
    const others = accounts.accounts.filter(
      (each) => each.provider === provider && each.id !== where.account,
    );
    const typed = normalizeLabel(label);
    const problem = typed ? labelProblem(accounts.accounts, where.account, typed) : null;
    const needed = others.length > 0;
    // Where it landed, from the read after the sign-in when it has one, else from the account list.
    const landing =
      signIn?.result && signIn.result.added.includes(where.account) ? signIn.result : null;
    const keeper = landing ? landing.keptBy : (account?.keptBy ?? null);
    const keptBy = keeper ? (bots.find((bot) => bot.id === keeper)?.name ?? keeper) : null;
    // Inherited by another bot only when the current merged views say so, with no other copy;
    // anything less is said as not shown.
    const inherited =
      account !== null &&
      !account.unclear &&
      account.keptBy === null &&
      (landing === null || landing.landed === "shared");
    const landedText = keptBy
      ? `The gateway lists this account in ${keptBy}'s own store.`
      : inherited
        ? "The gateway lists this account as inherited by another bot."
        : "The gateway's lists don't show which bots can use it.";
    const locks = signIn?.result?.locks ?? [];
    const done = async () => {
      // Nothing to write: no label, or the one the account already has.
      if (!typed || (account?.label && normalizeLabel(account.label) === typed)) {
        finish(where.account);
        return;
      }
      setSaving(true);
      try {
        await bridge.invoke({ type: "setAccountLabel", profileId: where.account, label: typed });
        announce("Label saved");
        finish(where.candidate ? null : where.account);
      } catch (error) {
        setLabelError(error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(false);
      }
    };
    const shownError = problem ?? labelError;
    return {
      title: where.byKey ? "API key" : "Connect an account",
      backLabel: "Back to sign-in methods",
      body: (
        <>
          {where.unconfirmed ? (
            // Not confirmed by the read: the outcome it came from stays on this screen.
            <Result tone="warn" mark="clock" title={where.unconfirmed.title} focus={false}>
              {where.unconfirmed.text}
            </Result>
          ) : (
            <Result
              tone="ok"
              mark="check"
              title={
                where.candidate
                  ? `Signed in to ${who}`
                  : where.byKey
                    ? "Key saved"
                    : `Connected to ${who}`
              }
              focus={false}
            >
              {where.candidate
                ? "The label goes to the account you chose."
                : where.byKey
                  ? "Your gateway keeps the key."
                  : "Your gateway keeps the sign-in."}
            </Result>
          )}
          <p className="b-hint" role="status" style={{ textAlign: "center" }} data-testid="landed">
            {landedText}
          </p>
          <label className="b-field">
            <span>Label</span>
            <input
              className="input"
              maxLength={32}
              value={label}
              placeholder={needed ? "For example, Home or Studio" : "For example, Personal"}
              aria-describedby="b-label-help"
              aria-invalid={shownError ? true : undefined}
              data-b-focus=""
              onChange={(event) => {
                setLabel(event.target.value);
                setLabelError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !(needed && !typed) && !problem) void done();
              }}
            />
          </label>
          {/* The error covers the hint in its place, so the dialog keeps its height as you type. */}
          <div className="b-field-note">
            <p
              className="b-hint"
              id={shownError ? undefined : "b-label-help"}
              data-covered={shownError ? "" : undefined}
            >
              {needed
                ? `You have another ${who} account, ${accountName(others[0]!, accounts)}. A label tells them apart everywhere.`
                : "Shown wherever this account is, so you can tell accounts apart."}
            </p>
            {shownError && (
              <p className="b-field-error" id="b-label-help" role="alert">
                {shownError}
              </p>
            )}
          </div>
          {locks.map((lock) => {
            const name = bots.find((bot) => bot.id === lock.botId)?.name ?? lock.botId;
            const locked = accounts.accounts.find((each) => each.id === lock.account);
            const lockedName = locked ? accountName(locked, accounts) : lock.account;
            // Each from the read after the sign-in: what it showed, or that it could not show it.
            return lock.outcome === "kept" ? (
              <Note key={lock.botId} icon={<LockIcon />} testId="lock-kept">
                <p>
                  Clawtrate checked {name}'s lock after this sign-in. It still allows only{" "}
                  {lockedName}.
                </p>
              </Note>
            ) : lock.outcome === "unchecked" ? (
              <Note key={lock.botId} tone="warn" testId="lock-unchecked">
                <p>
                  Clawtrate couldn't check {name}'s lock after this sign-in, so it can't say whether
                  the sign-in changed it. {name}'s Account page checks it again.
                </p>
              </Note>
            ) : lock.outcome === "widened" ? (
              <Note key={lock.botId} tone="warn" testId="lock-widened">
                <p>
                  This sign-in added the new account to {name}'s lock: the gateway's order for{" "}
                  {name} now names more than {lockedName}. Lock {name} again in its settings.
                </p>
              </Note>
            ) : (
              <Note key={lock.botId} tone="warn" testId="lock-changed">
                <p>
                  {name}'s order no longer names only {lockedName}, so {name} is not locked to it.
                  Lock {name} again in its settings.
                </p>
              </Note>
            );
          })}
        </>
      ),
      foot: (
        <button
          type="button"
          className="button"
          data-variant="primary"
          data-size="lg"
          disabled={(needed && !typed) || Boolean(problem) || saving}
          onClick={() => void done()}
        >
          {saving ? "Saving…" : "Done"}
        </button>
      ),
      onBack: () => void toMethods(),
    };
  }

  // --- A sign-in ------------------------------------------------------------------
  const chosen = method(where.method);
  const current: SignInState | null = signIn && signIn.method === where.method ? signIn : null;
  const who = providerName(current?.provider ?? chosen?.provider ?? "");
  const title = `Sign in to ${current?.label ?? chosen?.label ?? who}`;
  const cancelButton = current && isSignInActive(current) && (
    <button
      type="button"
      className="button"
      data-variant="quiet"
      disabled={current.saving || current.cancelling}
      onClick={() => void bridge.send({ type: "cancelSignIn" }).catch(() => {})}
    >
      {current.saving ? "Saving…" : "Cancel"}
    </button>
  );
  const again = (word: string, primary = true) => (
    <button
      type="button"
      className="button"
      data-variant={primary ? "primary" : undefined}
      data-size="lg"
      onClick={() =>
        void (current && (current.byKey || current.flow === "key")
          ? toKey(current.provider)
          : start(where.method))
      }
    >
      {word}
    </button>
  );
  // The gateway's answer names no account: the new ones the read found are candidates to label.
  const chooser = (sign: SignInState) => (
    <ul className="b-choices" data-testid="several" aria-label="New accounts">
      {sign.result!.added.map((id) => {
        const listed = accounts.accounts.find((each) => each.id === id);
        const name = listed ? accountName(listed, accounts) : id;
        return (
          <li key={id}>
            <button
              type="button"
              className="b-choice"
              data-choose={id}
              aria-label={`${name}: label this account`}
              onClick={() =>
                void bridge.invoke({ type: "chooseSignInAccount", profileId: id }).then(
                  () =>
                    setWhere({
                      view: "label",
                      account: id,
                      byKey: sign.byKey,
                      candidate: true,
                      ...(sign.stage === "unconfirmed"
                        ? {
                            unconfirmed: {
                              title: "Saved, not confirmed",
                              text:
                                sign.error ??
                                "The gateway saved the sign-in, but couldn't confirm it.",
                            },
                          }
                        : {}),
                    }),
                  (error: unknown) =>
                    announce(error instanceof Error ? error.message : String(error)),
                )
              }
            >
              <span className="b-choice-text">
                <span className="b-choice-title">
                  {listed ? <AccountTitle account={listed} accounts={accounts} /> : id}
                </span>
                <span className="b-choice-sub">Label this account</span>
              </span>
              <ChevronIcon />
            </button>
          </li>
        );
      })}
    </ul>
  );
  const another = (
    <button type="button" className="button" data-variant="quiet" onClick={() => void toMethods()}>
      Choose another way
    </button>
  );
  // The page the gateway named, as the core parsed it: the button opens that one address, and
  // the destination it shows is that address's own scheme, host, port and path.
  const open = (step: SignInStep) =>
    step.url ? (
      <div className="b-open" data-testid="open">
        <a
          className="button"
          href={step.url.href}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="open-page"
        >
          Open {who}'s page <ExternalIcon />
        </a>
        <p className="b-hint" data-testid="page-address">
          {pageDestination(step.url)}
        </p>
        <p className="b-hint" data-testid="page-opens">
          {opensIn(step.url)}
        </p>
      </div>
    ) : step.urlRefused ? (
      <p className="b-hint" data-testid="page-refused">
        {REFUSED_PAGE}
      </p>
    ) : null;
  const reread = (sign: SignInState) => {
    const res = sign.result;
    if (!res) return <Wait>Checking the gateway's accounts…</Wait>;
    if (res.readFailed)
      return (
        <p className="b-hint" style={{ textAlign: "center" }}>
          Clawtrate couldn't read the gateway's accounts after the sign-in.
        </p>
      );
    const added = res.added[0];
    if (added)
      return (
        <Note tone="warn" testId="reread">
          <p>
            The refreshed account list includes <span className="mono">{added}</span>. The gateway
            did not identify which sign-in added it.
          </p>
          <div className="b-actions">
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() =>
                setWhere({
                  view: "label",
                  account: added,
                  byKey: sign.byKey,
                  candidate: true,
                  unconfirmed: {
                    title: "Listed, not finished",
                    text: `The gateway lists this ${who} account, but the sign-in did not finish. It may not be ready to use.`,
                  },
                })
              }
            >
              Name it
            </button>
          </div>
        </Note>
      );
    return (
      <p className="b-hint" style={{ textAlign: "center" }} data-testid="reread">
        Clawtrate checked the gateway's accounts: no new {who} account.
      </p>
    );
  };

  let body: ReactNode;
  let foot: ReactNode = null;
  if (!admin) {
    body = <p className="b-lead">{chosen ? flowWords(chosen.flow) : ""}.</p>;
    foot = (
      <AdminBar
        connection={connection}
        info={info}
        need="Signing in needs admin access. The gateway lets only admin connections start a sign-in."
      />
    );
  } else if (!current || current.stage === "starting") {
    body = (
      <>
        <p className="b-lead">{chosen ? flowWords(chosen.flow) : ""}.</p>
        <Wait>Asking the gateway to start the sign-in…</Wait>
      </>
    );
    foot = cancelButton;
  } else if (current.stage === "busy") {
    body = (
      <Result tone="warn" mark="clock" title="The gateway is busy">
        It is already running a sign-in or a setup, and does one at a time. Try again when that one
        finishes.
      </Result>
    );
    foot = (
      <>
        {again("Try again")}
        {another}
      </>
    );
  } else if (current.stage === "waiting" && current.step) {
    const step = current.step;
    const saving = current.saving ? (
      <p className="b-hint">Too late to cancel: the gateway is saving the sign-in.</p>
    ) : null;
    if (step.type === "note") {
      // A note with a page: the gateway's own words, shown as a note. How the provider finishes
      // the sign-in is not inferred from it.
      const { words, command } = forwardCommand(step.message);
      body = (
        <>
          <p className="b-lead">The gateway says:</p>
          {words
            .split(/\n{2,}/)
            .filter((part) => part.trim())
            .map((part, index) => (
              <p className="b-step b-said" key={index} data-testid="gateway-says">
                {part}
              </p>
            ))}
          {command && (
            <>
              <p className="b-step">The command in the gateway's note:</p>
              <CommandBlock command={command} label="Copy forward command" />
            </>
          )}
          {open(step)}
          <Wait>Waiting for the gateway…</Wait>
          {saving}
        </>
      );
    } else if (!step.code) {
      // A page and no code: the gateway's words, and nothing said of how the sign-in finishes.
      body = (
        <>
          {step.message && <p className="b-lead">{step.message}</p>}
          {open(step)}
          <Wait>Waiting for the gateway…</Wait>
          <p className="b-hint">
            Keep this open until it finishes. Closing Clawtrate or losing the connection to the
            gateway ends the sign-in.
          </p>
          {saving}
        </>
      );
    } else {
      body = (
        <>
          <ol className="b-steps">
            <li>
              <p>Open {who}'s sign-in page.</p>
              {open(step)}
            </li>
            <li>
              <p>Enter this code there, and approve.</p>
              <CodeBlock code={step.code} />
            </li>
          </ol>
          <Wait>
            Waiting for {who}.
            {step.expiresInMinutes ? ` The code works for ${step.expiresInMinutes} minutes.` : ""}
          </Wait>
          <p className="b-hint">
            Keep this open until it finishes. Closing Clawtrate or losing the connection to the
            gateway ends the sign-in.
          </p>
          {saving}
        </>
      );
    }
    foot = cancelButton;
  } else if (current.stage === "entering" && current.step) {
    const step = current.step;
    const submit = async () => {
      const value = pasteRef.current?.value ?? "";
      if (!value.trim()) return;
      // Cleared as it is sent: the code goes to the gateway in this one request.
      if (pasteRef.current) pasteRef.current.value = "";
      await bridge.send({ type: "answerSignIn", value }).catch(() => {});
    };
    // A step with a page, or one the gateway marks secret, takes a pasted code or address: kept
    // from view, as the engine keeps it.
    body = isSecretStep(step) ? (
      <>
        <ol className="b-steps">
          <li>
            <p>Open {who}'s sign-in page and sign in.</p>
            {open(step)}
          </li>
          <li>
            {/* What the gateway asks for, as it asks: a code, a whole address, or something else. */}
            <p data-testid="requested">{step.message ?? "Paste the requested answer here."}</p>
            <label className="b-field">
              <span>{step.title ?? "Answer"}</span>
              <input
                ref={pasteRef}
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={step.placeholder ?? "Paste here"}
                data-b-focus=""
                data-testid="paste"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
            </label>
          </li>
        </ol>
        <p className="b-hint">It goes straight to your gateway. Clawtrate does not keep it.</p>
      </>
    ) : (
      <>
        <p className="b-lead">
          {step.message ?? "The gateway asks for this before the sign-in goes on."}
        </p>
        <label className="b-field">
          <span>{step.title ?? "GitHub Enterprise address"}</span>
          <input
            ref={pasteRef}
            className="input"
            placeholder={step.placeholder ?? ""}
            data-b-focus=""
            data-testid="paste"
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </label>
      </>
    );
    foot = (
      <>
        <button
          type="button"
          className="button"
          data-variant="primary"
          data-size="lg"
          onClick={() => void submit()}
        >
          Continue
        </button>
        {cancelButton}
      </>
    );
  } else if (current.stage === "checking" || (current.stage === "connected" && !current.result)) {
    body = <Wait>Finishing the sign-in with {who}…</Wait>;
    foot = cancelButton;
  } else if (current.stage === "failed") {
    body = (
      <>
        <Result tone="danger" mark="warning" title="Couldn't connect">
          {current.error ?? "Clawtrate could not confirm that the sign-in finished."}
        </Result>
        {reread(current)}
      </>
    );
    foot = (
      <>
        {again("Try again")}
        {another}
      </>
    );
  } else if (current.stage === "expired") {
    body = (
      <>
        <Result tone="warn" mark="clock" title="The sign-in expired">
          It wasn't finished in time. Start again for a new code.
        </Result>
        {reread(current)}
      </>
    );
    foot = (
      <>
        {again("Start again")}
        {another}
      </>
    );
  } else if (current.stage === "cancelled") {
    body = (
      <>
        <Result tone="" mark="x" title="Sign-in cancelled" />
        {reread(current)}
      </>
    );
    foot = (
      <>
        {again("Start again", false)}
        {another}
      </>
    );
  } else if (current.stage === "ended") {
    body = (
      <>
        <Result tone="warn" mark="warning" title="The sign-in ended">
          The connection to the gateway dropped, and a sign-in ends with its connection.
        </Result>
        {reread(current)}
      </>
    );
    foot = (
      <>
        {again("Start again")}
        {another}
      </>
    );
  } else if (current.stage === "unverified") {
    body = (
      <Result tone="warn" mark="clock" title="Signed in, not confirmed">
        The sign-in finished, but Clawtrate couldn't read the gateway's accounts afterwards, so it
        can't say whether {who} has a new account or where it is.
      </Result>
    );
    foot = (
      <>
        <button
          type="button"
          className="button"
          data-variant="primary"
          data-size="lg"
          onClick={() => void bridge.send({ type: "recheckSignIn" }).catch(() => {})}
        >
          Check again
        </button>
        {another}
      </>
    );
  } else if (current.stage === "several") {
    body = (
      <>
        <Result tone="ok" mark="check" title={`Signed in to ${who}`} focus={false}>
          The gateway's answer doesn't name an account. The refreshed list has{" "}
          {current.result!.added.length === 1
            ? `a new ${who} account`
            : `${current.result!.added.length} new ${who} accounts`}
          . Choose an account to label, or return to Accounts.
        </Result>
        {chooser(current)}
      </>
    );
    foot = (
      <button
        type="button"
        className="button"
        data-variant="quiet"
        data-size="lg"
        onClick={() => finish(null)}
      >
        Done
      </button>
    );
  } else if (current.stage === "unconfirmed") {
    const candidates = current.result?.added.length ?? 0;
    body = (
      <>
        <Result tone="warn" mark="clock" title="Saved, not confirmed">
          {current.error ?? "The gateway saved the sign-in, but couldn't confirm it."}
        </Result>
        {candidates > 0 && (
          <p className="b-hint">Choose an account to label, or return to Accounts.</p>
        )}
        {candidates > 0 && chooser(current)}
      </>
    );
    foot = (
      <button
        type="button"
        className="button"
        data-variant={candidates > 0 ? "quiet" : "primary"}
        data-size="lg"
        disabled={!current.result}
        onClick={() => finish(null)}
      >
        {candidates > 0 ? "Done" : "Continue"}
      </button>
    );
  } else {
    body = <Wait>Finishing the sign-in with {who}…</Wait>;
  }

  // A cancel the gateway declined is said wherever one can be declined: the waiting view says it
  // in place; every other stage of a sign-in still going says it here, after a code or a key too.
  if (current && isSignInActive(current) && current.saving && current.stage !== "waiting") {
    body = (
      <>
        {body}
        <p className="b-hint" data-testid="too-late">
          Too late to cancel: the gateway is saving the sign-in.
        </p>
      </>
    );
  }

  if (current?.cancelUnknown && isSignInActive(current)) {
    body = (
      <>
        <Note tone="warn" testId="cancel-unknown">
          <p>
            Clawtrate couldn't tell whether the gateway cancelled the sign-in
            {current.error ? ` (${current.error})` : ""}. It is reading the gateway's accounts
            again. Cancel again, or wait for the sign-in to end.
          </p>
        </Note>
        {body}
      </>
    );
  }

  return {
    title,
    backLabel: "Back to sign-in methods",
    body,
    foot,
    onBack: () => void toMethods(),
  };
}

/** The connect component, drawn by its caller's frame (`children`). */
export function Connect({
  children,
  ...options
}: Parameters<typeof useConnect>[0] & { children: (view: ConnectView) => ReactNode }) {
  return <>{children(useConnect(options))}</>;
}
