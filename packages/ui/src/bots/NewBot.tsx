// New bot (bots.md sections 3 and 4): the picture and the name, then the
// Account step, then Create. Connecting an account opens inside the same
// dialog. What was entered is kept until the app quits, through a sign-in
// and a request for access; Create clears it.

import type { AccountsState, Bot, ConnectionState, HostInfo } from "@clawtrate/core";
import { firstChoice } from "@clawtrate/core";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { BackIcon, CloseIcon, LockIcon, PlusIcon } from "../icons.tsx";
import { AccountChoices, GATEWAY_CHOICE, gatewayLine } from "./AccountChoices.tsx";
import { AvatarPicker, PicturePreview, pictureFor, type PictureDraft } from "./AvatarPicker.tsx";
import { Connect } from "./Connect.tsx";
import { Dialog } from "./Dialog.tsx";
import { AdminBar, GrantedBar, Note, useAnnouncer, useGranted } from "./parts.tsx";
import { ModelPair, rowFor, useModelList } from "./ModelPair.tsx";
import { recall, remember } from "./memory.ts";
import {
  defaultAccount,
  defaultRef,
  effortFor,
  firstEffort,
  firstModel,
  providerName,
} from "./words.ts";

type Draft = {
  name: string;
  /** Null until the person changes the picture: the new bot then gets the Clawling its id gives. */
  picture: PictureDraft | null;
  /** An account id, `GATEWAY_CHOICE`, or null: nothing chosen. */
  account: string | null;
  model: string | null;
  effort: string | null;
};

/** What New bot shows before the picture is changed: an example, not what is sent. */
const STARTER: PictureDraft = { choice: firstChoice("clawling", "blue"), upload: null };
const PICTURE_FAILED = "Couldn't draw that picture. Choose it again, or choose another.";

const freshDraft = (): Draft => ({
  name: "",
  picture: null,
  account: null,
  model: null,
  effort: null,
});

/** Kept until the app quits: closing the dialog does not lose what was entered. */
type Kept = { draft: Draft; step: "look" | "account" | "connect" };
const KEPT = "new-bot";

export function NewBot({
  accounts,
  bots,
  connection,
  info,
  onClose,
  onCreated,
}: {
  accounts: AccountsState;
  bots: readonly Bot[];
  connection: ConnectionState;
  info: HostInfo;
  onClose: () => void;
  onCreated: (botId: string) => void;
}) {
  const bridge = useBridge();
  const [draft, setDraftState] = useState<Draft>(() => recall<Kept>(KEPT)?.draft ?? freshDraft());
  const [step, setStepState] = useState<"look" | "account" | "connect">(
    () => recall<Kept>(KEPT)?.step ?? "look",
  );
  const [announcer, announce] = useAnnouncer();
  const [pictureFailed, setPictureFailed] = useState(false);
  const [pictureBusy, setPictureBusy] = useState(false);
  // This opening of the dialog: whether it still stands, the gateway it was opened on, the draft
  // as it is now, and whether a Create is being prepared or sent.
  const open = useRef(true);
  // The gateway it was opened on: its address, and the first identity seen for it on the
  // connection the dialog opened on. Results are acted on only while the connected gateway's
  // identity positively matches that one, so a reconnect to the same gateway, such as the one
  // that grants admin access, keeps the dialog's work, and an unknown identity never counts.
  const [gateway] = useState(() => connection.gatewayUrl);
  const [firstConnection] = useState(() => connection.connectedAt);
  const [openedOn, setOpenedOn] = useState(connection.gatewayId);
  // The host's target as it opened: a Connect, Disconnect or switch since refuses what it sends.
  const [target] = useState(connection.target);
  if (
    openedOn === null &&
    connection.gatewayId !== null &&
    connection.gatewayUrl === gateway &&
    connection.connectedAt === firstConnection
  )
    setOpenedOn(connection.gatewayId);
  const now$ = useRef(connection);
  const latest = useRef(draft);
  const pending = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // Layout effects, so the guard changes as the dialog is committed, before a Create can resume.
  useLayoutEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    now$.current = connection;
    latest.current = draft;
  });
  const matchesGateway = (now: ConnectionState) =>
    now.status === "connected" &&
    now.gatewayUrl === gateway &&
    now.target === target &&
    now.gatewayId !== null &&
    now.gatewayId === openedOn;
  const canSubmitHere = matchesGateway(connection);
  const stands = () => open.current && matchesGateway(now$.current) && latest.current === draft;
  const shown = draft.picture ?? STARTER;
  const previewRef = useRef<HTMLSpanElement>(null);
  const granted = useGranted(connection);
  const admin = connection.canAdmin;
  const [now] = useState(() => Date.now());
  const setDraft = (change: (draft: Draft) => Draft) =>
    setDraftState((was) => {
      const next = change(was);
      remember(KEPT, { draft: next, step: recall<Kept>(KEPT)?.step ?? step });
      return next;
    });
  const setStep = (next: "look" | "account" | "connect") => {
    remember(KEPT, { draft, step: next });
    setStepState(next);
    // The new step's first field or heading takes focus in the next frame, but only if nothing
    // else has taken it since the step changed: a person who tabs or clicks in at once keeps
    // their place. The button that changed the step going away moves no focus, so it doesn't count.
    let taken = false;
    const onFocus = () => {
      taken = true;
    };
    document.addEventListener("focusin", onFocus);
    requestAnimationFrame(() => {
      document.removeEventListener("focusin", onFocus);
      if (taken) return;
      const dialog = document.querySelector<HTMLElement>('[data-testid="new-bot"]');
      (
        dialog?.querySelector<HTMLElement>("[data-b-focus]") ??
        dialog?.querySelector<HTMLElement>("h2")
      )?.focus();
    });
  };

  // The accounts are read when the dialog opens.
  useEffect(() => {
    void bridge.send({ type: "refreshAccounts" }).catch(() => {});
  }, [bridge]);

  // The gateway's default model names an account: it is chosen at first (section 4).
  const named = defaultAccount(accounts);
  const shared = accounts.accounts.filter((a) => a.keptBy === null);
  const name = draft.name.trim() || "New bot";
  const gw = defaultRef(accounts);
  const providerOf = (value: string | null) =>
    value === GATEWAY_CHOICE
      ? (gw?.provider ?? null)
      : (accounts.accounts.find((a) => a.id === value)?.provider ?? null);
  const provider = providerOf(draft.account);
  // "View more" for this dialog, and the effort resolved once from the model's row: what Effort
  // shows and what Create sends.
  const list = useModelList(provider ?? "", connection, step === "account");
  const shownEffort = effortFor(rowFor(accounts, provider, draft.model, list), draft.effort);

  // The model chosen at first for an account (section 4); null until its provider's rows arrive.
  const firstFor = (value: string, forProvider: string) =>
    value === GATEWAY_CHOICE && gw ? gw.model : firstModel(accounts, forProvider);

  function choose(value: string) {
    const nextProvider = providerOf(value);
    setDraft((was) => {
      const keepModel = nextProvider && providerOf(was.account) === nextProvider ? was.model : null;
      const model = keepModel ?? (nextProvider ? firstFor(value, nextProvider) : null);
      return {
        ...was,
        account: value,
        model,
        effort: nextProvider ? firstEffort(accounts, nextProvider, model, was.effort) : null,
      };
    });
  }

  // An account chosen before its provider's rows arrived gets its first model when they do.
  // A model the person chose is never null, so it is never replaced.
  const lateModel =
    draft.account && provider && !draft.model ? firstFor(draft.account, provider) : null;
  if (lateModel && provider)
    setDraft((was) =>
      was.model === null && was.account === draft.account
        ? {
            ...was,
            model: lateModel,
            effort: firstEffort(accounts, provider, lateModel, was.effort),
          }
        : was,
    );

  // Once, when the accounts arrive and nothing is chosen yet.
  const [autoChosen, setAutoChosen] = useState(false);
  if (!autoChosen && draft.account === null && named && shared.some((a) => a.id === named)) {
    setAutoChosen(true);
    choose(named);
  }

  // A choice counts only while the list as it stands shows it: an account the last read lost,
  // or a list that failed to load, cannot be created on.
  const listedChoice =
    draft.account === GATEWAY_CHOICE ||
    (accounts.status === "ready" && shared.some((a) => a.id === draft.account));
  const creation = accounts.creation;
  const busy = creation?.status === "creating" || creation?.status === "checking";
  const create = async () => {
    if (!draft.account || !listedChoice || !provider || !draft.model || busy) return;
    // One Create at a time, for this opening of the dialog and the gateway it was opened on.
    if (pending.current) return;
    pending.current = true;
    setPreparing(true);
    const sent = { ...draft, effort: shownEffort };
    try {
      // A picture the person chose must be drawn to be sent; if it can't be, nothing is created.
      const avatar = sent.picture
        ? await pictureFor(sent.picture, previewRef.current?.querySelector("svg"))
        : null;
      // Checked again right before sending: a dialog closed, or a gateway changed, while the
      // picture was drawn sends nothing.
      if (!stands()) return;
      if (sent.picture && !avatar) {
        setPictureFailed(true);
        announce(PICTURE_FAILED);
        return;
      }
      setPictureFailed(false);
      announce("Creating the bot");
      await send(sent, avatar);
    } finally {
      pending.current = false;
      if (open.current) setPreparing(false);
    }
  };
  const send = async (sent: Draft, avatar: string | null) => {
    if (!sent.account || !provider || !sent.model) return;
    try {
      const { botId, missing } = await bridge.invoke({
        type: "createBot",
        name: sent.name.trim(),
        avatar,
        account: sent.account === GATEWAY_CHOICE ? null : sent.account,
        provider,
        model: sent.model,
        effort: sent.effort,
        // The host refuses it unless this is still the gateway, and the target, it names.
        stamp: { gatewayId: now$.current.gatewayId, target },
      });
      // An answer for an opening that has gone, from a gateway or connection since replaced, or for
      // a draft changed since, closes, clears and selects nothing.
      if (!stands()) return;
      remember(KEPT, null);
      // The bot exists; what did not land is said here, and finished by its id.
      if (missing.length > 0) {
        announce(`Created ${name}, not finished`);
        return;
      }
      announce(`Created ${name}`);
      void bridge.send({ type: "dismissBotCreation" }).catch(() => {});
      onCreated(botId);
    } catch {
      if (stands()) announce("Could not create the bot");
    }
  };
  const partial = creation?.status === "partial" ? creation : null;
  const finish = async () => {
    // Bound as Create is: this opening, on the gateway it was opened on.
    if (!partial?.botId || finishing || !stands()) return;
    setFinishing(true);
    try {
      const { botId, missing } = await bridge.invoke({
        type: "finishBot",
        botId: partial.botId,
        // The host refuses it unless this is still the gateway, and the target, it names.
        stamp: { gatewayId: now$.current.gatewayId, target },
      });
      if (!stands() || missing.length > 0) return;
      announce(`Created ${partial.name}`);
      void bridge.send({ type: "dismissBotCreation" }).catch(() => {});
      onCreated(botId);
    } catch {
      if (stands()) announce(`Could not finish ${partial.name}`);
    } finally {
      if (open.current) setFinishing(false);
    }
  };

  let head: ReactNode;
  let body: ReactNode;
  let foot: ReactNode;
  const close = (
    <button
      type="button"
      className="icon-button b-close"
      aria-label="Close"
      title="Close (Esc)"
      onClick={onClose}
    >
      <CloseIcon />
    </button>
  );
  const back = (label: string, to: () => void) => (
    <button type="button" className="icon-button b-back" aria-label={label} onClick={to}>
      <BackIcon />
    </button>
  );

  if (step === "look") {
    head = (
      <header className="b-head">
        <h2 id="create-title" tabIndex={-1}>
          New bot
        </h2>
        {close}
      </header>
    );
    body = (
      <>
        <PicturePreview draft={shown} label={`${name}'s picture`} previewRef={previewRef} />
        <label className="visually-hidden" htmlFor="b-name">
          Name
        </label>
        <input
          className="input b-name"
          id="b-name"
          data-b-focus=""
          autoComplete="off"
          maxLength={40}
          placeholder="Name"
          value={draft.name}
          onChange={(event) => setDraft((was) => ({ ...was, name: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              // Not while a chosen picture is still being read.
              if (!pictureBusy) setStep("account");
            }
          }}
        />
        <AvatarPicker
          draft={shown}
          onChange={(picture) => setDraft((was) => ({ ...was, picture }))}
          onBusy={setPictureBusy}
        />
      </>
    );
    foot = (
      <button
        type="button"
        className="button"
        data-variant="primary"
        data-size="lg"
        disabled={pictureBusy}
        onClick={() => setStep("account")}
      >
        {pictureBusy ? "Reading the picture…" : "Next"}
      </button>
    );
  } else if (step === "account") {
    head = (
      <header className="b-head">
        {back("Back to the picture", () => setStep("look"))}
        <h2 id="create-title" tabIndex={-1}>
          Account
        </h2>
        {close}
      </header>
    );
    const loading = accounts.status === "loading" || accounts.status === "idle";
    const failed = accounts.status === "error";
    const line = gatewayLine(accounts, gw?.provider ?? null, gw?.model ?? null, null);
    const who = provider ? providerName(provider) : null;
    body = (
      <>
        <PicturePreview draft={shown} label={null} previewRef={previewRef} small />
        {pictureFailed && (
          <div className="b-upload">
            <p className="b-field-error" role="alert">
              {PICTURE_FAILED}
            </p>
            <button
              type="button"
              className="button"
              data-variant="quiet"
              data-size="sm"
              onClick={() => {
                // The bot then gets the Clawling its id gives; the name and account stay.
                setDraft((was) => ({ ...was, picture: null }));
                setPictureFailed(false);
              }}
            >
              Use the default picture
            </button>
          </div>
        )}
        <p className="b-lead">
          Choose the account {name} runs on. The sign-in stays on your gateway.
        </p>
        {loading && (
          <div aria-busy="true" aria-label="Loading accounts" data-testid="accounts-loading">
            <div className="skeleton" style={{ height: 58, width: "100%" }} />
            <div className="skeleton" style={{ height: 58, width: "100%" }} />
            <div className="skeleton" style={{ height: 58, width: "100%" }} />
          </div>
        )}
        {failed && (
          <Note tone="danger">
            <p>
              <b>Couldn't load the gateway's accounts.</b>
            </p>
            <div className="b-actions">
              <button
                type="button"
                className="button"
                data-size="sm"
                onClick={() => void bridge.send({ type: "refreshAccounts" })}
              >
                Try again
              </button>
            </div>
          </Note>
        )}
        {!loading && !failed && shared.length === 0 && (
          <div className="work-empty">
            <span className="empty-mark">
              <LockIcon />
            </span>
            <h4>No accounts yet</h4>
            <p>Sign in with a subscription you already have, and {name} runs on it.</p>
            {admin && (
              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  onClick={() => setStep("connect")}
                >
                  Connect an account
                </button>
              </div>
            )}
          </div>
        )}
        <AccountChoices
          label="Accounts"
          list={loading || failed ? [] : shared}
          accounts={accounts}
          bots={bots}
          chosen={draft.account}
          onChoose={choose}
          disabled={!admin}
          gatewayLine={line}
          now={now}
        />
        {!loading && !failed && shared.length > 0 && (
          <ul className="b-choices" style={{ marginTop: 12 }}>
            <li>
              <button
                type="button"
                className="b-choice"
                data-kind="add"
                disabled={!admin}
                aria-disabled={!admin || undefined}
                onClick={() => setStep("connect")}
              >
                <PlusIcon />
                <span className="b-choice-text">
                  <span className="b-choice-title">Connect another account</span>
                </span>
              </button>
            </li>
          </ul>
        )}
        {named && draft.account === named && (
          <p className="b-hint">Chosen because the gateway's default model names it.</p>
        )}
        {provider && who && (
          <>
            <h4 className="b-group">Model</h4>
            <ModelPair
              accounts={accounts}
              provider={provider}
              anyAccount={draft.account === GATEWAY_CHOICE}
              update={connection.openclawUpdate}
              announce={announce}
              model={draft.model}
              list={list}
              effort={shownEffort}
              disabled={!admin}
              onModel={(model, row) =>
                setDraft((was) => ({ ...was, model, effort: effortFor(row, was.effort) }))
              }
              onEffort={(effort) => setDraft((was) => ({ ...was, effort }))}
            />
            <p className="b-hint">
              {who}'s models, as the gateway lists them. Which ones{" "}
              {draft.account === GATEWAY_CHOICE ? "an account" : "this account"} may use is {who}'s
              decision. Change either later in {name}'s settings.
            </p>
          </>
        )}
      </>
    );
    foot = granted ? (
      <GrantedBar />
    ) : !admin ? (
      <AdminBar
        connection={connection}
        info={info}
        need="Creating a bot changes the gateway's settings, which needs admin access. What you chose stays here while you ask."
      />
    ) : (
      <>
        {creation?.status === "failed" && (
          <Note tone="danger" testId="create-failed">
            <p>
              <b>Could not create the bot.</b>{" "}
              {creation.uncertain ? creation.error : "Please try again."}
            </p>
          </Note>
        )}
        {partial && (
          <Note tone="warn" testId="create-partial">
            <p>
              <b>{partial.name} exists, and isn't finished.</b> {partial.error}
            </p>
            <div className="b-actions">
              <button
                type="button"
                className="button"
                data-variant="primary"
                data-size="sm"
                disabled={!canSubmitHere || finishing}
                onClick={() => void finish()}
              >
                Finish {partial.name}
              </button>
              {/* A bot the gateway's list doesn't show yet can't be opened. One whose first-run
                  questions are still on isn't opened as it is: that would drop the Finish that
                  turns them off, and its first reply would ask for a name and a picture. */}
              {!partial.missing.includes("listed") && !partial.missing.includes("identity") && (
                <button
                  type="button"
                  className="button"
                  data-variant="quiet"
                  data-size="sm"
                  onClick={() => {
                    void bridge.send({ type: "dismissBotCreation" }).catch(() => {});
                    onCreated(partial.botId!);
                  }}
                >
                  Open {partial.name} as it is
                </button>
              )}
            </div>
          </Note>
        )}
        <button
          type="button"
          className="button"
          data-variant="primary"
          data-size="lg"
          disabled={
            busy ||
            preparing ||
            partial !== null ||
            !draft.account ||
            !listedChoice ||
            !draft.model ||
            !canSubmitHere
          }
          onClick={() => void create()}
          data-testid="create"
        >
          {busy || preparing ? "Creating…" : "Create"}
        </button>
        {!canSubmitHere && (
          <p className="b-hint" role="status" style={{ textAlign: "center", margin: 0 }}>
            {connection.gatewayUrl !== gateway ||
            (connection.status === "connected" && connection.gatewayId !== null)
              ? "Reopen New bot to use this gateway. Your draft is kept."
              : "Waiting for the gateway to say which gateway it is."}
          </p>
        )}
        {!draft.account && !busy && (
          <p className="b-hint" style={{ textAlign: "center", margin: 0 }}>
            Choose an account, or let the gateway choose.
          </p>
        )}
        {draft.account && !listedChoice && !busy && (
          <p
            className="b-hint"
            role="status"
            style={{ textAlign: "center", margin: 0 }}
            data-testid="choice-gone"
          >
            {accounts.status === "ready"
              ? "The account chosen is no longer on the gateway. Choose another, or let the gateway choose."
              : "The gateway's accounts aren't loaded, so the account chosen can't be used. Try again, or let the gateway choose."}
          </p>
        )}
        {creation?.status === "checking" && (
          <p className="b-hint" role="status" style={{ textAlign: "center", margin: 0 }}>
            Checking whether {name} was created…
          </p>
        )}
        {creation?.status === "creating" && creation.slow && (
          <p className="b-hint" role="status" style={{ textAlign: "center", margin: 0 }}>
            Still creating. What you entered is kept.
          </p>
        )}
      </>
    );
  } else {
    return (
      <Dialog kind="create" labelledBy="create-title" onClose={onClose} testId="new-bot">
        <Connect
          from="create"
          draftName={draft.name.trim() || null}
          forBot={null}
          accounts={accounts}
          bots={bots}
          connection={connection}
          info={info}
          announce={announce}
          onDone={(account) => {
            if (account && accounts.accounts.some((a) => a.id === account && a.keptBy === null))
              choose(account);
            setStep("account");
          }}
          onLeave={() => setStep("account")}
        >
          {(view) => (
            <div className="b-sheet">
              <header className="b-head">
                {back(view.backLabel, view.onBack)}
                <h2 id="create-title" tabIndex={-1}>
                  {view.title}
                </h2>
                {close}
              </header>
              <div className="b-body">{view.body}</div>
              {view.foot && <footer className="b-foot">{view.foot}</footer>}
              {announcer}
            </div>
          )}
        </Connect>
      </Dialog>
    );
  }

  return (
    <Dialog kind="create" labelledBy="create-title" onClose={onClose} testId="new-bot">
      <div className="b-sheet">
        {head}
        <div className="b-body">{body}</div>
        {foot && <footer className="b-foot">{foot}</footer>}
        {announcer}
      </div>
    </Dialog>
  );
}

/** Forget what New bot kept, for a test that starts afresh. */
export function forgetNewBotDraft(): void {
  remember(KEPT, null);
}
