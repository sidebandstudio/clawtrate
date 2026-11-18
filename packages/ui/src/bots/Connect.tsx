// Connecting an account (bots.md sections 5 and 6): one component, inside New
// bot and in Settings → Accounts. It starts the gateway's own sign-in and
// shows its stages; the API key path is folded under its own option. The code
// pasted back and a typed key go to the gateway once and are kept nowhere:
// their fields are cleared as they are sent.

import {
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
} from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { ChevronIcon, ExternalIcon, LockIcon } from "../icons.tsx";
import { recall, remember } from "./memory.ts";
import { AdminBar, CodeBlock, Note, Result, Wait } from "./parts.tsx";
import { accountName, flowWords, providerName } from "./words.ts";

/** A label step left before Done, kept until the app quits so it comes back (section 6). */
const LABEL_KEPT = "connect-label";
type KeptLabel = { account: string; byKey: boolean };

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
  | { view: "label"; account: string; byKey: boolean }
  | { view: "same"; provider: string };

/**
 * The connect component's state and views. The caller draws its head and
 * foot in its own frame (the New bot dialog, a Settings section).
 */
export function useConnect({
  from,
  draftName,
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
  from: "create" | "settings";
  draftName: string | null;
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
      next.view === "label" ? { account: next.account, byKey: next.byKey } : null,
    );
    setWhereState(next);
  };
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [keyProvider, setKeyProvider] = useState(accounts.keyProviders[0]?.provider ?? "");
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyAgain, setKeyAgain] = useState(0);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLInputElement>(null);
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);

  // A sign-in that finished moves on to its label; one that found no new account says so.
  const stage = signIn?.stage ?? null;
  const result = signIn?.result ?? null;
  const [seen, setSeen] = useState<{ stage: string | null; result: unknown }>({ stage, result });
  if (seen.stage !== stage || seen.result !== result) {
    setSeen({ stage, result });
    // Connected: the read after it showed the account. Refreshed: it finished with no new one.
    if (where.view === "flow" && signIn && signIn.method === where.method && result) {
      const added = result.added[0];
      if (stage === "connected" && added)
        setWhere({ view: "label", account: added, byKey: signIn.byKey });
      else if (stage === "refreshed") setWhere({ view: "same", provider: signIn.provider });
    }
  }
  useEffect(() => {
    if (!signIn) return;
    if (stage === "connected" && result)
      announce(signIn.byKey ? "Key saved" : `Connected to ${providerName(signIn.provider)}`);
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
    const saveKey = async () => {
      const key = keyRef.current?.value ?? "";
      if (!key.trim()) {
        setKeyError("Enter a key.");
        return;
      }
      // The field is cleared at once: the key is in this one request, and nowhere after it.
      if (keyRef.current) keyRef.current.value = "";
      setKeyError(null);
      setSaving(true);
      try {
        if (kp?.method) setWhere({ view: "flow", method: kp.method });
        const { profileId } = await bridge.invoke({
          type: "saveApiKey",
          provider: keyProvider,
          key,
          botId: forBot,
        });
        if (!kp?.method) {
          announce("Key saved");
          if (profileId) setWhere({ view: "label", account: profileId, byKey: true });
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
        {!accounts.mainShared && (
          <Note testId="kept-note">
            <p>
              This gateway keeps this sign-in for {targetName} only. Other bots
              {from === "create" ? ", and a bot you are creating," : ""} won't be able to use it.
            </p>
            {from === "create" && (
              <p>
                To give {draftName || "the new bot"} an account of its own, create it with "Let the
                gateway choose", then connect from its settings.
              </p>
            )}
          </Note>
        )}
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
              <p className="b-hint" style={{ marginTop: 4 }}>
                With an API key, the provider bills each request by the tokens it uses, apart from
                any subscription you have. Most people don't need one.
              </p>
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
              {kp?.hasKey && !kp.method && (
                <Note tone="warn">
                  <p>
                    This replaces the {providerName(keyProvider)} key your gateway already has. Bots
                    that use it switch to the new key. To keep both, add the second on the gateway's
                    machine.
                  </p>
                </Note>
              )}
              <p className="b-hint">
                The key goes to your gateway, which keeps it. It is not kept on this device, and
                Clawtrate can't read it back.
              </p>
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
    const landedText = keptBy
      ? `Saved for ${keptBy} only. Other bots can't use it.`
      : landing?.landed === "shared" || (!landing && account)
        ? "Every bot can use it: the gateway shows it to other bots as shared."
        : "Clawtrate hasn't seen it in the gateway's lists yet, so it can't say which bots can use it.";
    const locks = signIn?.result?.locks ?? [];
    const done = async () => {
      if (!typed) {
        finish(where.account);
        return;
      }
      setSaving(true);
      try {
        await bridge.invoke({ type: "setAccountLabel", profileId: where.account, label: typed });
        announce("Label saved");
        finish(where.account);
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
          <Result
            tone="ok"
            mark="check"
            title={where.byKey ? "Key saved" : `Connected to ${who}`}
            focus={false}
          >
            {where.byKey ? "Your gateway keeps the key." : "Your gateway keeps the sign-in."}
          </Result>
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
          {shownError ? (
            <p className="b-field-error" id="b-label-help" role="alert">
              {shownError}
            </p>
          ) : (
            <p className="b-hint" id="b-label-help">
              {needed
                ? `You have another ${who} account, ${accountName(others[0]!, accounts)}. A label tells them apart everywhere.`
                : "Shown wherever this account is, so you can tell accounts apart."}
            </p>
          )}
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
  const another = (
    <button type="button" className="button" data-variant="quiet" onClick={() => void toMethods()}>
      Choose another way
    </button>
  );
  const open = (url: string) => (
    <a
      className="button"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      data-testid="open-page"
    >
      Open {who}'s page <ExternalIcon />
    </a>
  );
  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
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
            The gateway now has a {who} account it didn't have before,{" "}
            <span className="mono">{added}</span>. It may not be ready to use.
          </p>
          <div className="b-actions">
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() => setWhere({ view: "label", account: added, byKey: sign.byKey })}
            >
              Name it
            </button>
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant="quiet"
              data-tone="danger"
              onClick={() => setConfirmDrop(added)}
            >
              Disconnect it…
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
    if (current.flow === "host" || !step.code) {
      body = (
        <>
          <p className="b-lead">
            This sign-in finishes on the gateway's machine: {who} sends your browser back to an
            address there. The gateway says:
          </p>
          {step.message && <p className="b-step b-wrap">{step.message}</p>}
          {step.url && <div className="b-actions">{open(step.url)}</div>}
          <Wait>Waiting for {who} to send your browser back to the gateway…</Wait>
          {saving}
        </>
      );
    } else {
      body = (
        <>
          <ol className="b-steps">
            <li>
              <p>Open {who}'s sign-in page.</p>
              {step.url && open(step.url)}
              {step.url && (
                <p className="b-hint" style={{ marginTop: 6 }}>
                  {hostOf(step.url)}
                </p>
              )}
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
    body = step.sensitive ? (
      <>
        <ol className="b-steps">
          <li>
            <p>Open {who}'s sign-in page and sign in.</p>
            {step.url && open(step.url)}
          </li>
          <li>
            <p>
              The page then shows a code, or your browser lands on an address that does not open.
              Copy the code, or that whole address, and paste it here.
            </p>
            <label className="b-field">
              <span>Code or address</span>
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
        <p className="b-hint">
          It goes straight to your gateway, which finishes the sign-in. Clawtrate does not keep it.
        </p>
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
          {current.error ?? `${who} refused the sign-in.`}
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
  } else if (current.stage === "unconfirmed") {
    const added = current.result?.added[0];
    body = (
      <Result tone="warn" mark="clock" title="Saved, not confirmed">
        {current.error}
      </Result>
    );
    foot = (
      <button
        type="button"
        className="button"
        data-variant="primary"
        data-size="lg"
        disabled={!current.result}
        onClick={() =>
          added ? setWhere({ view: "label", account: added, byKey: current.byKey }) : finish(null)
        }
      >
        Continue
      </button>
    );
  } else {
    body = <Wait>Finishing the sign-in with {who}…</Wait>;
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

  if (confirmDrop) {
    body = (
      <>
        {body}
        <Note tone="danger">
          <p>
            Disconnect <span className="mono">{confirmDrop}</span>? Your gateway removes the
            sign-in.
          </p>
          <div className="b-actions">
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant="quiet"
              onClick={() => setConfirmDrop(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button"
              data-size="sm"
              data-tone="danger"
              onClick={() => {
                const id = confirmDrop;
                setConfirmDrop(null);
                void bridge.send({ type: "disconnectAccount", profileId: id }).catch(() => {});
              }}
            >
              Disconnect
            </button>
          </div>
        </Note>
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
