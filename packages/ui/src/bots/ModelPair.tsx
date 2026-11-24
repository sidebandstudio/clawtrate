// Model and effort, side by side (bots.md section 9): the models the gateway
// lists for the provider, unavailable ones shown and disabled, and the levels
// the gateway reports for the chosen model, or "Not offered". "View more" reads
// the provider's full list each time it is opened, holds the answer for this
// screen only, and shows the models the first list lacks in a section of their
// own, with no verdict on any of them.

import {
  gatewayStamp,
  type AccountsState,
  type CatalogModel,
  type ConnectionState,
  type ModelList,
} from "@clawtrate/core";
import { useEffect, useRef, useState } from "react";
import { useBridge } from "../bridge.tsx";
import { Select, type SelectRow, type SelectSection } from "./parts.tsx";
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
}) {
  const menu = modelMenu(accounts, provider, model, list.models);
  const who = providerName(provider);
  const held = list.state;

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

  const levels = menu.row?.levels ?? [];
  return (
    <div className="b-pair">
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
        onChoose={(next) =>
          onModel(
            next,
            menu.picker.find((m) => m.id === next) ?? menu.more.find((m) => m.id === next),
          )
        }
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
  );
}
