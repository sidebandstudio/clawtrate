// New bot (bots.md sections 3 and 4): the picture and the name, then the
// Account step, then Create. Connecting an account opens inside the same
// dialog. What was entered is kept until the app quits, through a sign-in
// and a request for access; Create clears it.

import type { AccountsState, Bot, ConnectionState, HostInfo } from "@clawtrate/core";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { Character, CHARACTER_COLORS, type BodyName } from "../Avatar.tsx";
import { BackIcon, CloseIcon, LockIcon, PlusIcon } from "../icons.tsx";
import { AccountChoices, GATEWAY_CHOICE, gatewayLine } from "./AccountChoices.tsx";
import { Connect } from "./Connect.tsx";
import { Dialog } from "./Dialog.tsx";
import { AdminBar, GrantedBar, Note, useAnnouncer, useGranted } from "./parts.tsx";
import { ModelPair } from "./ModelPair.tsx";
import { recall, remember } from "./memory.ts";
import { defaultAccount, defaultRef, firstEffort, firstModel, providerName } from "./words.ts";

export const BODIES: BodyName[] = [
  "pebble",
  "block",
  "arch",
  "bloom",
  "disc",
  "hex",
  "drop",
  "gem",
];
const COLOR_NAMES = ["Green", "Blue", "Orange", "Violet", "Yellow", "Pink", "Sky", "Lime"];

type Draft = {
  name: string;
  body: BodyName;
  color: string;
  /** An account id, `GATEWAY_CHOICE`, or null: nothing chosen. */
  account: string | null;
  model: string | null;
  effort: string | null;
};

const freshDraft = (): Draft => ({
  name: "",
  body: "drop",
  color: "#ff6f9c",
  account: null,
  model: null,
  effort: null,
});

/** Kept until the app quits: closing the dialog does not lose what was entered. */
type Kept = { draft: Draft; step: "look" | "account" | "connect" };
const KEPT = "new-bot";

/** The picture of a drawn character, as a data URL the gateway keeps with the bot. */
function pictureOf(svg: SVGElement | null | undefined): string | null {
  if (!svg) return null;
  let markup = svg.outerHTML;
  if (!markup.includes("xmlns="))
    markup = markup.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;base64,${btoa(markup)}`;
}

/** A radio group of one tab stop: arrows move and choose, Home and End go to the ends. */
function onRadioKeys<T>(values: readonly T[], current: T, choose: (value: T) => void) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    const index = values.indexOf(current);
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % values.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (index - 1 + values.length) % values.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = values.length - 1;
    if (next === null) return;
    event.preventDefault();
    choose(values[next]!);
    requestAnimationFrame(() =>
      event.currentTarget?.querySelectorAll<HTMLElement>('[role="radio"]')[next!]?.focus(),
    );
  };
}

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
    requestAnimationFrame(() => {
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

  function choose(value: string) {
    const nextProvider = providerOf(value);
    setDraft((was) => {
      const keepModel = nextProvider && providerOf(was.account) === nextProvider ? was.model : null;
      const model =
        keepModel ??
        (nextProvider
          ? value === GATEWAY_CHOICE && gw
            ? gw.model
            : firstModel(accounts, nextProvider)
          : null);
      return {
        ...was,
        account: value,
        model,
        effort: nextProvider ? firstEffort(accounts, nextProvider, model, was.effort) : null,
      };
    });
  }

  // Once, when the accounts arrive and nothing is chosen yet.
  const [autoChosen, setAutoChosen] = useState(false);
  if (!autoChosen && draft.account === null && named && shared.some((a) => a.id === named)) {
    setAutoChosen(true);
    choose(named);
  }

  const creation = accounts.creation;
  const busy = creation?.status === "creating" || creation?.status === "checking";
  const create = async () => {
    if (!draft.account || !provider || !draft.model || busy) return;
    announce("Creating the bot");
    try {
      const { botId } = await bridge.invoke({
        type: "createBot",
        name: draft.name.trim(),
        avatar: pictureOf(previewRef.current?.querySelector("svg")),
        account: draft.account === GATEWAY_CHOICE ? null : draft.account,
        provider,
        model: draft.model,
        effort: draft.effort,
      });
      remember(KEPT, null);
      announce(`Created ${name}`);
      void bridge.send({ type: "dismissBotCreation" }).catch(() => {});
      onCreated(botId);
    } catch {
      announce("Could not create the bot");
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
        <span className="b-preview" role="img" aria-label={`${name}'s picture`} ref={previewRef}>
          <Character spec={{ body: draft.body, color: draft.color, tilt: 0, look: [0.6, 0] }} />
        </span>
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
              setStep("account");
            }
          }}
        />
        <p className="b-label" id="b-shape-label">
          Shape
        </p>
        <div
          className="b-shapes"
          role="radiogroup"
          aria-labelledby="b-shape-label"
          onKeyDown={onRadioKeys(BODIES, draft.body, (body) =>
            setDraft((was) => ({ ...was, body })),
          )}
        >
          {BODIES.map((body) => (
            <button
              key={body}
              type="button"
              className="b-shape"
              role="radio"
              aria-checked={body === draft.body}
              tabIndex={body === draft.body ? 0 : -1}
              aria-label={body}
              onClick={() => setDraft((was) => ({ ...was, body }))}
            >
              <Character spec={{ body, color: draft.color, tilt: 0, look: [0.6, 0] }} />
            </button>
          ))}
        </div>
        <p className="b-label" id="b-color-label">
          Colour
        </p>
        <div
          className="b-colors"
          role="radiogroup"
          aria-labelledby="b-color-label"
          onKeyDown={onRadioKeys(
            CHARACTER_COLORS,
            draft.color as (typeof CHARACTER_COLORS)[number],
            (color) => setDraft((was) => ({ ...was, color })),
          )}
        >
          {CHARACTER_COLORS.map((color, index) => (
            <button
              key={color}
              type="button"
              className="b-color"
              role="radio"
              aria-checked={color === draft.color}
              tabIndex={color === draft.color ? 0 : -1}
              aria-label={COLOR_NAMES[index]}
              style={{ ["--swatch" as string]: color }}
              onClick={() => setDraft((was) => ({ ...was, color }))}
            />
          ))}
        </div>
      </>
    );
    foot = (
      <button
        type="button"
        className="button"
        data-variant="primary"
        data-size="lg"
        onClick={() => setStep("account")}
      >
        Next
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
        <span
          className="b-preview"
          style={{ ["--avatar-create" as string]: "56px", marginBottom: 10 }}
          aria-hidden="true"
          ref={previewRef}
        >
          <Character spec={{ body: draft.body, color: draft.color, tilt: 0, look: [0.6, 0] }} />
        </span>
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
              model={draft.model}
              effort={draft.effort}
              disabled={!admin}
              onModel={(model) =>
                setDraft((was) => ({
                  ...was,
                  model,
                  effort: firstEffort(accounts, provider, model, was.effort),
                }))
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
              <b>Could not create the bot.</b> Please try again.
            </p>
          </Note>
        )}
        <button
          type="button"
          className="button"
          data-variant="primary"
          data-size="lg"
          disabled={busy || !draft.account || !draft.model}
          onClick={() => void create()}
          data-testid="create"
        >
          {busy ? "Creating…" : "Create"}
        </button>
        {!draft.account && !busy && (
          <p className="b-hint" style={{ textAlign: "center", margin: 0 }}>
            Choose an account, or let the gateway choose.
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
