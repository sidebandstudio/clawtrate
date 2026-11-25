// Model and effort, side by side (bots.md section 9): the models the gateway
// lists for the provider, unavailable ones shown and disabled, and the levels
// the gateway reports for the chosen model, or "Not offered". "View more" reads
// the provider's full list each time it is opened, holds the answer for this
// screen only, and shows the models the first list lacks in a section of their
// own, with no verdict on any of them. The last row takes a model id typed in.
// When the gateway reports a newer OpenClaw, a note says so, with a link to
// OpenClaw's update instructions.

import {
  gatewayStamp,
  MAX_MODEL_ID_CHARS,
  modelIdProblem,
  type AccountsState,
  type CatalogModel,
  type ConnectionState,
  type ModelList,
  type OpenClawUpdate,
} from "@clawtrate/core";
import { useEffect, useRef, useState } from "react";
import { useBridge } from "../bridge.tsx";
import { ArrowUpIcon, ExternalIcon } from "../icons.tsx";
import { Note, Select, type SelectRow, type SelectSection } from "./parts.tsx";
import { levelWord, modelsOf, providerName } from "./words.ts";

/** One "View more" answer, as this screen holds it for the provider and connection it shows. */
type Held = { status: "loading" } | ModelList;

/**
 * The provider's full list for "View more": asked when it is opened, and again each time,
 * held by the screen that asked and nowhere else. Each ask has a token, and its answer is
 * taken only while the token is current: the token ends with the page or dialog showing the
 * pair (`shown` false, or the screen going), another provider, or another connection (its
 * stamp, or the time it connected). What is held goes with it, so coming back shows View more
 * closed.
 */
export function useModelList(provider: string, connection: ConnectionState, shown: boolean) {
  const bridge = useBridge();
  const [held, setHeld] = useState<Held | null>(null);
  const stamp = gatewayStamp(connection);
  const key = shown
    ? [
        provider,
        connection.status,
        connection.gatewayUrl ?? "",
        stamp.gatewayId ?? "",
        stamp.target,
        connection.connectedAt ?? "",
      ].join(" ")
    : "";
  // What was held, or still on its way, goes with the provider or connection it was for, so
  // going back never finds a read that will not be answered.
  const [heldFor, setHeldFor] = useState(key);
  if (heldFor !== key) {
    setHeldFor(key);
    setHeld(null);
  }
  // Only the newest ask's answer is taken: none from before a change, or after the screen goes.
  const asks = useRef(0);
  useEffect(() => {
    asks.current += 1;
  }, [key]);
  useEffect(
    () => () => {
      asks.current += 1;
    },
    [],
  );
  const ask = () => {
    const n = ++asks.current;
    const keep = (next: Held) => {
      if (n === asks.current) setHeld(next);
    };
    setHeld({ status: "loading" });
    bridge
      .invoke({ type: "loadModelCatalog", provider })
      .then(keep, (error: unknown) =>
        keep({ status: "error", error: error instanceof Error ? error.message : String(error) }),
      );
  };
  return {
    /** Not asked yet (or dropped), loading, or the answer. */
    state: held,
    /** The answer's models as menu rows, once there is one. Availability is not theirs to say. */
    models:
      held?.status === "ready"
        ? held.models.map((m): CatalogModel => ({ ...m, provider, name: null, available: true }))
        : null,
    ask,
  };
}

export type ModelListHandle = ReturnType<typeof useModelList>;

/** The chosen model's row, from the picker or the held full list, if either has it. */
export function rowFor(
  accounts: AccountsState,
  provider: string | null,
  model: string | null,
  list: ModelListHandle,
): CatalogModel | undefined {
  if (!provider || model === null) return undefined;
  return (
    modelsOf(accounts, provider).find((m) => m.id === model) ??
    list.models?.find((m) => m.id === model)
  );
}

/**
 * What the menu lists for a provider: the gateway's picker, the held full list's other models,
 * and the chosen model pinned first when neither has it, so it always has a checked row.
 */
export function modelMenu(
  accounts: AccountsState,
  provider: string,
  model: string | null,
  held: CatalogModel[] | null,
) {
  const picker = modelsOf(accounts, provider);
  const pickerIds = new Set(picker.map((m) => m.id));
  const more = held ? held.filter((m) => !pickerIds.has(m.id)) : [];
  const row: CatalogModel | undefined =
    picker.find((m) => m.id === model) ?? more.find((m) => m.id === model);
  return {
    picker,
    more,
    pinned: model !== null && row === undefined ? model : null,
    row,
    cut: accounts.modelsCut.find((c) => c.provider === provider) ?? null,
  };
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * OpenClaw's own page on updating, for every kind of install, a container's included
 * (`docs/install/updating.md` in the OpenClaw package).
 */
const OPENCLAW_UPDATE_DOCS = "https://docs.openclaw.ai/install/updating";

/**
 * A typed model id, or why it can't be one, under the rule the bridge applies to every model id
 * (`modelIdProblem`). A leading `<provider>/` is the provider's own and is dropped.
 */
export function typedModel(text: string, provider: string): { id: string } | { error: string } {
  let id = text.trim();
  if (id.startsWith(`${provider}/`)) id = id.slice(provider.length + 1);
  switch (modelIdProblem(id)) {
    case "empty":
      return { error: "Type a model id." };
    case "long":
      return { error: `A model id is at most ${MAX_MODEL_ID_CHARS} characters.` };
    case "control":
      return { error: "A model id can't hold control characters." };
    case "space":
      return { error: "A model id has no spaces and no @." };
    case null:
      return { id };
  }
}

export function ModelPair({
  accounts,
  provider,
  list,
  model,
  effort,
  disabled,
  onModel,
  onEffort,
  placeholder,
  anyAccount = false,
  update = null,
}: {
  accounts: AccountsState;
  provider: string;
  /** This screen's "View more" (`useModelList`), which the screen also reads the row from. */
  list: ModelListHandle;
  model: string | null;
  /** The effort as the screen resolved it from the model's row: what it shows and what it sends. */
  effort: string | null;
  disabled: boolean;
  /** The model's row, when either section lists it: its levels decide the effort. */
  onModel: (model: string, row: CatalogModel | undefined) => void;
  onEffort: (effort: string) => void;
  /** Shown while no model is chosen: "Choose". */
  placeholder?: string;
  /** The model is for whichever account the gateway chooses, not one account. */
  anyAccount?: boolean;
  /** A newer OpenClaw, as the gateway reports it. */
  update?: OpenClawUpdate | null;
}) {
  const menu = modelMenu(accounts, provider, model, list.models);
  const who = providerName(provider);
  const held = list.state;

  // The field for a model id typed in (section 9), and the last id it chose.
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const [typedId, setTypedId] = useState<string | null>(null);
  const pairRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  // On a phone the field and its buttons can open below the fold.
  useEffect(() => {
    if (typing) fieldRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [typing]);
  const backToSelect = () =>
    pairRef.current?.querySelector<HTMLElement>('[data-testid="model-select"]')?.focus();
  const stopTyping = () => {
    setTyping(false);
    setText("");
    setTypedError(null);
  };
  // Another provider: what was typed for the last one, its error and its note go.
  const [typedFor, setTypedFor] = useState(provider);
  if (typedFor !== provider) {
    setTypedFor(provider);
    stopTyping();
    setTypedId(null);
  }
  const takeTyped = () => {
    const result = typedModel(text, provider);
    if ("error" in result) return setTypedError(result.error);
    // An id the menu lists is that row: one the picker disables can't be had by typing it.
    const listed =
      menu.picker.find((m) => m.id === result.id) ?? menu.more.find((m) => m.id === result.id);
    if (listed && !listed.available && menu.picker.includes(listed))
      return setTypedError("Not available");
    stopTyping();
    setTypedId(result.id);
    onModel(result.id, listed);
    requestAnimationFrame(backToSelect);
  };

  const rows: SelectRow[] = [];
  if (menu.cut)
    rows.push({
      label: `${count(menu.picker.length)} of ${count(menu.cut.total)} shown`,
      disabled: true,
      onSelect: () => {},
    });
  let section: SelectSection | undefined;
  if (held === null) rows.push({ label: "View more", expands: true, onSelect: () => list.ask() });
  else if (held.status === "loading")
    rows.push({ label: "View more", note: "Loading…", disabled: true, onSelect: () => {} });
  else if (held.status === "ready")
    section = {
      // "No more" only from a complete answer with nothing left out of it.
      line: held.partial
        ? `The gateway is still listing ${who}'s models, so this list may not be complete.`
        : menu.more.length > 0
          ? `Also listed for ${who}. ${who} decides which ${anyAccount ? "an account" : "this account"} can use.`
          : held.total > held.models.length
            ? `The gateway lists ${count(held.total - held.models.length)} more of ${who}'s models that can't be shown here.`
            : `The gateway lists no more models for ${who}.`,
      choices: menu.more.map((each) => ({ value: each.id, label: each.id })),
      rows: [
        ...(held.total > held.models.length
          ? [
              {
                label: `${count(held.models.length)} of ${count(held.total)} shown`,
                disabled: true,
                onSelect: () => {},
              },
            ]
          : []),
        ...(held.partial ? [{ label: "Check again", onSelect: () => list.ask() }] : []),
      ],
    };
  else if (held.status === "error")
    section = {
      line: "Couldn't load more models.",
      choices: [],
      rows: [{ label: "Try again", onSelect: () => list.ask() }],
    };
  // Refused (a gateway without `view: "all"`): no "View more".
  const typeRow: SelectRow = {
    label: "Use another model…",
    note: "Type its id",
    close: true,
    onSelect: () => setTyping(true),
  };
  if (section) section.rows.push(typeRow);
  else rows.push(typeRow);

  const levels = menu.row?.levels ?? [];
  return (
    <>
      <div className="b-pair" ref={pairRef}>
        <Select
          label="Model"
          value={model ?? placeholder ?? "Choose"}
          choices={[
            ...(menu.pinned ? [{ value: menu.pinned, label: menu.pinned }] : []),
            ...menu.picker.map((each) => ({
              value: each.id,
              label: each.id,
              disabled: !each.available,
              ...(each.available ? {} : { note: "Not available" }),
            })),
          ]}
          rows={rows}
          {...(section ? { section } : {})}
          onChoose={(next) => {
            stopTyping();
            onModel(
              next,
              menu.picker.find((m) => m.id === next) ?? menu.more.find((m) => m.id === next),
            );
          }}
          disabled={disabled}
          testId="model-select"
        />
        <Select
          label="Effort"
          value={levels.length > 0 && effort ? effort : "Not offered"}
          choices={levels.map((level) => ({ value: level, label: levelWord(level) }))}
          onChoose={onEffort}
          disabled={disabled || levels.length === 0}
          testId="effort-select"
        />
      </div>
      {typing && !disabled && (
        <div className="b-model-typed" data-testid="model-typed" ref={fieldRef}>
          <label className="b-field">
            <span>Model id</span>
            <input
              className="input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={text}
              aria-invalid={typedError ? true : undefined}
              aria-describedby={typedError ? "b-model-typed-error" : "b-model-typed-hint"}
              data-testid="model-id"
              onChange={(event) => {
                setText(event.target.value);
                setTypedError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  takeTyped();
                } else if (event.key === "Escape") {
                  // Escape belongs to the field first, not the dialog around it.
                  event.preventDefault();
                  event.stopPropagation();
                  stopTyping();
                  requestAnimationFrame(backToSelect);
                }
              }}
            />
          </label>
          {typedError ? (
            <p className="b-field-error" id="b-model-typed-error" role="alert">
              {typedError}
            </p>
          ) : (
            <p className="b-hint" id="b-model-typed-hint">
              As {who} names it.
            </p>
          )}
          <div className="b-actions">
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant="primary"
              onClick={takeTyped}
            >
              Use
            </button>
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() => {
                stopTyping();
                backToSelect();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {update && (
        <Note icon={<ArrowUpIcon />} testId="openclaw-update">
          <p>
            Your gateway runs OpenClaw {update.current}, and {update.latest} is out
            {update.channel && update.channel !== "latest"
              ? ` on its ${update.channel} channel${update.channel === "beta" || update.channel === "dev" ? ", not as a stable release" : ""}`
              : ""}
            . Updating the gateway is how newer models get listed.
          </p>
          <p>
            <a href={OPENCLAW_UPDATE_DOCS} target="_blank" rel="noreferrer noopener">
              OpenClaw's update instructions <ExternalIcon />
            </a>
          </p>
        </Note>
      )}
      {typedId !== null && typedId === model && menu.row === undefined && !typing && (
        <p className="b-hint" data-testid="model-typed-line">
          {typedId} was typed in.
        </p>
      )}
    </>
  );
}
