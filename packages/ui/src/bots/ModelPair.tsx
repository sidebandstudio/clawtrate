// Model and effort, side by side (bots.md section 9): the models the gateway
// lists for the provider, unavailable ones shown and disabled, and the levels
// the gateway reports for the chosen model, or "Not offered". "View more" reads
// the provider's full list each time it is opened, holds the answer for this
// screen only, and shows the models the first list lacks in a section of their
// own, with no verdict on any of them. The last row takes a model id typed in.
// When the gateway reports a newer OpenClaw, or while an update runs, a note
// says so in one line, with a link to Settings › Updates, where the update is
// made and followed (#565, #590).
// "Refresh" asks the gateway to look for the provider's models again, on a
// person's press only, and says once what changed or why nothing did (#565).

import {
  gatewayStamp,
  initialOpenClawUpdate,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_MODELS,
  modelIdProblem,
  limitsProvider,
  type AccountsState,
  type CatalogModel,
  type ClawtrateState,
  type ConnectionState,
  type ModelList,
  type ModelRefresh,
  type OpenClawUpdate,
  type UpdateRunView,
} from "@clawtrate/core";
import { useEffect, useRef, useState } from "react";
import { useBridge, useClawtrateState } from "../bridge.tsx";
import { Select, type SelectRow, type SelectSection } from "./parts.tsx";
import { UpdateOpenClawNote, useUpdateRun } from "./UpdateOpenClaw.tsx";
import { updateLinkLine } from "./update-words.ts";
import { levelWord, modelsOf, providerName } from "./words.ts";

/** One "View more" answer, as this screen holds it for the provider and connection it shows. */
type Held = { status: "loading" } | ModelList;

/** One Refresh, as this screen holds it: under way, or what it found. */
export type HeldRefresh = { status: "looking" } | ModelRefresh;

/**
 * What a screen's held answers belong to: the provider, and the connection they were asked on
 * (its address, the gateway's identity, the host's target and the time it connected). Empty
 * while the screen doesn't show the pair. An answer asked under one key is never shown under
 * another.
 */
export function heldKey(provider: string, connection: ConnectionState, shown: boolean): string {
  const stamp = gatewayStamp(connection);
  return shown
    ? [
        provider,
        connection.status,
        connection.gatewayUrl ?? "",
        stamp.gatewayId ?? "",
        stamp.target,
        connection.connectedAt ?? "",
      ].join(" ")
    : "";
}

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
  const [refresh, setRefresh] = useState<HeldRefresh | null>(null);
  // The models refreshes found the gateway no longer lists, since View more's answer was read:
  // that answer doesn't offer them again. They go with it, when it is read again or dropped.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const stamp = gatewayStamp(connection);
  const key = heldKey(provider, connection, shown);
  // What was held, or still on its way, goes with the provider or connection it was for, so
  // going back never finds a read that will not be answered.
  const [heldFor, setHeldFor] = useState(key);
  if (heldFor !== key) {
    setHeldFor(key);
    setHeld(null);
    setRefresh(null);
    setGone(new Set());
  }
  // Only the newest ask's answer is taken: none from before a change, or after the screen goes.
  const asks = useRef(0);
  const refreshes = useRef(0);
  useEffect(() => {
    asks.current += 1;
    refreshes.current += 1;
  }, [key]);
  useEffect(
    () => () => {
      asks.current += 1;
      refreshes.current += 1;
    },
    [],
  );
  const ask = () => {
    const n = ++asks.current;
    const keep = (next: Held) => {
      if (n === asks.current) setHeld(next);
    };
    setHeld({ status: "loading" });
    setGone(new Set());
    bridge
      .invoke({ type: "loadModelCatalog", provider })
      .then(keep, (error: unknown) =>
        keep({ status: "error", error: error instanceof Error ? error.message : String(error) }),
      );
  };
  // Refresh (#565): one at a time, on a press. The rows it found reach the menu through the
  // accounts; what changed is this screen's, and is dropped like View more's answer.
  const lookAgain = () => {
    if (refresh?.status === "looking" || key === "") return;
    const n = ++refreshes.current;
    // View more's answer stays: a model chosen from it keeps its row, and its levels.
    const keep = (next: HeldRefresh) => {
      if (n !== refreshes.current) return;
      setRefresh(next);
      // At most as many as View more's answer holds.
      if (next.status === "done" && next.removedIds.length > 0)
        setGone((was) => new Set([...was, ...next.removedIds].slice(-MAX_PROVIDER_MODELS)));
    };
    setRefresh({ status: "looking" });
    bridge
      .invoke({ type: "refreshModels", provider, stamp })
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
    /** The last Refresh: under way, or what it found; null when none was pressed. */
    refresh,
    /** Models refreshes found no longer listed since View more's answer: not offered from it. */
    gone,
    lookAgain,
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
  /** Models a Refresh found no longer listed: not offered from View more's earlier answer. */
  gone: ReadonlySet<string> = new Set(),
) {
  const picker = modelsOf(accounts, provider);
  const pickerIds = new Set(picker.map((m) => m.id));
  const more = held ? held.filter((m) => !pickerIds.has(m.id) && !gone.has(m.id)) : [];
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

/** A menu item's name, as a screen reader says it: its label, else its text. */
/** A menu item as a screen reader tells it apart: its role and its name. */
const itemName = (item: HTMLElement) =>
  `${item.getAttribute("role") ?? ""}\n${item.getAttribute("aria-label") ?? item.textContent ?? ""}`;

/** Names in a sentence: "a", "a and b", "a, b and c", and "and 3 more" past the names given. */
export function namesLine(names: string[], count: number): string {
  const rest = count - names.length;
  const all = rest > 0 ? [...names, `${rest.toLocaleString("en-US")} more`] : names;
  if (all.length <= 1) return all.join("");
  return `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
}

/**
 * What a Refresh found, in plain words (#565): the new models by name, the first few and a
 * count; the ones no longer listed; for a list cut at its bound, how many the gateway lists now
 * and before, and nothing named new on the strength of the cut; "Nothing new"; a provider the
 * gateway couldn't ask, with the gateway's reason. When nothing changed and the gateway didn't
 * ask the provider again: whether the gateway's config is the whole list, or where lists that
 * come with OpenClaw get newer models (a newer OpenClaw, and OpenClaw's model list online, which
 * the gateway checks every 6 hours unless its config turns that off) and what the person can do.
 * Of a newer OpenClaw it says only what the note under the menu says (#594's one line): that one
 * is out (`update` given), or that the note says where an update stands (`updating`). The gateway doesn't say which
 * lists come with OpenClaw (docs/research/model-catalog.md, section 8), so neither does this.
 */
export function refreshWords(
  result: ModelRefresh,
  who: string,
  update: OpenClawUpdate | null,
  updating = false,
  /** A typed model id runs as typed: false under a model list with a wildcard that limits it. */
  typedRuns = true,
): string {
  const said = refreshSentences(result, who, update, updating, typedRuns);
  return [...said.found, ...said.reasons.map((reason) => reason.text)].join(" ");
}

/** What one sentence of a Refresh's result says, to choose the one the first line gives. */
export type ReasonKind =
  | "failed"
  | "auth"
  | "unavailable"
  | "pending"
  | "limits"
  | "configured"
  | "same"
  | "notAsked"
  | "lists"
  | "note"
  | "typed";

/** Every sentence of a Refresh's result (`refreshWords`): what was found, then why. */
export type RefreshSaid = {
  found: string[];
  /** Nothing was found new or gone: the first line may give one reason. */
  nothingNew: boolean;
  reasons: { kind: ReasonKind; text: string }[];
};

export function refreshSentences(
  result: ModelRefresh,
  who: string,
  update: OpenClawUpdate | null,
  updating = false,
  typedRuns = true,
): RefreshSaid {
  if (result.status === "error")
    return { found: [`Couldn't refresh: ${result.error}`], nothingNew: false, reasons: [] };
  const found: string[] = [];
  const reasons: RefreshSaid["reasons"] = [];
  const say = (kind: ReasonKind, text: string) => reasons.push({ kind, text });
  if (result.addedCount > 0) found.push(`New: ${namesLine(result.added, result.addedCount)}.`);
  if (result.counts && result.counts.now !== result.counts.before)
    found.push(
      `${who} lists ${count(result.counts.now)} models now (${count(result.counts.before)} before).`,
    );
  // A whole list this refresh left some of past the bound: the menu doesn't show all of it.
  if (result.cut)
    found.push(
      `${who} lists ${count(result.cut.now)} models; the menu shows ${count(result.cut.shown)}.`,
    );
  if (result.removedCount > 0)
    found.push(`No longer listed: ${namesLine(result.removed, result.removedCount)}.`);
  const changed = found.length > 0;
  // A list the menu showed cut, with as many models as before, may have changed past the cut:
  // only its count is known.
  if (!changed)
    found.push(
      result.counts
        ? `${who} lists ${count(result.counts.now)} models, as before.`
        : result.partial
          ? "Nothing new yet."
          : "Nothing new.",
    );
  if (result.outcome === "auth-rejected")
    say("auth", `The gateway couldn't ask ${who}: ${who} refused the account.`);
  else if (result.outcome === "unavailable")
    say("unavailable", `The gateway couldn't get an answer from ${who}.`);
  if (result.failed) say("failed", "The gateway's refresh failed: try Refresh again.");
  else if (result.partial) say("pending", `The gateway is still looking for ${who}'s models.`);
  else if (!changed && result.outcome === "ready") {
    // Asked again, and every model it lists is the config's: that is the more specific reason.
    if (result.configured)
      say("configured", `${who}'s models are the ones the gateway's config lists.`);
    say(
      "same",
      result.counts
        ? `The gateway asked ${who} again.`
        : `The gateway asked ${who} again, and its list is the same.`,
    );
  } else if (!changed && result.outcome === null) {
    if (result.configured)
      say("configured", `${who}'s models are the ones the gateway's config lists.`);
    else {
      say("notAsked", `The gateway didn't ask ${who} again, so its list is the one it had.`);
      // Said only from a config read: without one, whether the gateway checks the list online
      // isn't known.
      if (result.hostedList !== null)
        say(
          "lists",
          result.hostedList
            ? "Lists that come with OpenClaw get newer models from a newer OpenClaw, and from OpenClaw's model list online, which the gateway checks every 6 hours."
            : "Lists that come with OpenClaw get newer models from a newer OpenClaw.",
        );
      if (updating) say("note", "The note below says where the OpenClaw update stands.");
      else if (update) say("note", `OpenClaw ${update.latest} is out: see the note below.`);
      if (typedRuns)
        say("typed", "To use a model that isn't listed, choose Use another model and type its id.");
    }
  }
  return { found, nothingNew: !changed, reasons };
}

/**
 * The reasons the first line may give when nothing new was found, most specific first: the
 * gateway's own failure, then a provider it couldn't ask, then one it is still asking, then the
 * config's list that keeps models out, then the config as the whole list, then a provider asked
 * with the same answer, then one not asked. The rest are one step away.
 */
export const FIRST_REASONS: readonly ReasonKind[] = [
  "failed",
  "auth",
  "unavailable",
  "pending",
  "limits",
  "configured",
  "same",
  "notAsked",
];

/**
 * What the menu shows of a Refresh (#565): one line, what was found and, when nothing new was,
 * the single most specific reason (`FIRST_REASONS`); and every other sentence, the config's model
 * list included (`limits`), one step away behind `label`.
 */
export function refreshLines(
  said: RefreshSaid,
  limits: string | null,
): { line: string; more: string[]; label: string } {
  const pool = [...said.reasons, ...(limits ? [{ kind: "limits" as const, text: limits }] : [])];
  const first = said.nothingNew
    ? FIRST_REASONS.map((kind) => pool.find((reason) => reason.kind === kind)).find(Boolean)
    : undefined;
  return {
    line: [...said.found, ...(first ? [first.text] : [])].join(" "),
    more: pool.filter((reason) => reason !== first).map((reason) => reason.text),
    label: said.nothingNew ? "Why" : "More",
  };
}

/**
 * What the note under the menu says (#594's one line), as the pair shows it: only with an update
 * run in view or a newer OpenClaw reported, and then the line, if any. `offer` when it is the line
 * that a newer OpenClaw is out, not where an update stands.
 */
export function noteBelow(
  state: ClawtrateState,
  run: UpdateRunView | null,
  update: OpenClawUpdate | null,
): { line: string; offer: boolean } | null {
  if (!run && !update) return null;
  const line = updateLinkLine(state, run);
  if (line === null) return null;
  const offer = updateLinkLine({ ...state, openclawUpdating: initialOpenClawUpdate }, null);
  return { line, offer: line === offer };
}

/**
 * The OpenClaw versions on which what the config's model list limits was established, on a
 * development gateway of each: it limits what the gateway lists and what a task may switch to; a
 * bot's own model or the default only when it has a wildcard, which makes them run on a model it
 * names (docs/research/model-catalog.md, section 8).
 */
export const MODEL_LIMIT_VERSIONS: readonly (readonly [number, number, number])[] = [
  [2026, 10, 6],
  [2026, 11, 10],
];

/**
 * The gateway reports exactly this OpenClaw release, its whole version (a leading `v` allowed).
 * Not a prerelease of it (`2026.11.10-beta.1`): what the model list limits was established on the
 * releases only. `openClawAtLeast` reads only the numbers at the start, which is right for "at
 * least", not here.
 */
function isOpenClaw(
  version: string | null,
  [year, month, patch]: readonly [number, number, number],
) {
  const match = /^v?(\d{4})\.(\d{1,2})\.(\d{1,3})$/.exec(version ?? "");
  return (
    match !== null &&
    Number(match[1]) === year &&
    Number(match[2]) === month &&
    Number(match[3]) === patch
  );
}

/**
 * Whether the config's model list has a wildcard, as the version the gateway reports reads one:
 * 2026.10.6 only `<provider>/…/*`, 2026.11.10 also a prefix (`openai/gpt-*`). On any other
 * version, as the broader of the two reads it.
 */
function hasWildcards(
  list: NonNullable<AccountsState["modelAllowlist"]>,
  serverVersion: string | null,
): boolean {
  return isOpenClaw(serverVersion, [2026, 10, 6]) ? list.wildcards : list.prefixWildcards;
}

/** The config's model list has a wildcard and limits the provider: a model it doesn't name won't run. */
export function wildcardLimits(
  accounts: AccountsState,
  provider: string,
  serverVersion: string | null,
): boolean {
  const list = accounts.modelAllowlist;
  return list !== null && hasWildcards(list, serverVersion) && limitsProvider(list, provider);
}

/**
 * When the gateway's config limits a provider's models for every bot (`modelAllowlist`: no bot has
 * a list of its own), on a version the gateway reports where what that limits is established;
 * nothing elsewhere.
 */
export function allowlistLine(
  accounts: AccountsState,
  provider: string,
  serverVersion: string | null,
): string | null {
  const list = accounts.modelAllowlist;
  if (list === null || !limitsProvider(list, provider)) return null;
  if (!MODEL_LIMIT_VERSIONS.some((each) => isOpenClaw(serverVersion, each))) return null;
  const who = providerName(provider);
  // With any wildcard in the list, a bot set to a model it doesn't name runs on the first one it
  // allows; without one, it runs on its own (docs/research/model-catalog.md, section 8).
  return hasWildcards(list, serverVersion)
    ? `The gateway's config names which of ${who}'s models it lists and lets a task switch to; a bot set to another model runs on one it names.`
    : `The gateway's config names which of ${who}'s models it lists and lets a task switch to; a bot's own model can still be one it doesn't name.`;
}

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
    case "pattern":
      return { error: "A model id can't hold *." };
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
  announce,
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
  /** The screen's polite announcer: what a Refresh found is said there once. */
  announce: (text: string) => void;
}) {
  // Only the models refreshes found the gateway no longer lists, not every model that left the
  // picker: a cut at the picker's bound can push out a model the gateway still lists, and View
  // more keeps it.
  const menu = modelMenu(accounts, provider, model, list.models, list.gone);
  const who = providerName(provider);
  // An update under way or just ended takes the notice's place, as a quiet line.
  const updateRun = useUpdateRun();
  const held = list.state;
  const found = list.refresh;
  // What the note under the menu says now (#594's one line): that a newer OpenClaw is out, where
  // an update stands, or nothing. The result points to it only as it is.
  const state = useClawtrateState();
  const note = noteBelow(state, updateRun, update);
  // What a Refresh found: one line under the row, the rest behind "Why". Nothing before a
  // press, so the menu at rest has no paragraph; the config's model list is said with a result.
  const shownResult =
    found && found.status !== "looking"
      ? refreshLines(
          refreshSentences(
            found,
            who,
            note?.offer ? update : null,
            note !== null && !note.offer,
            !wildcardLimits(accounts, provider, state.connection.serverVersion),
          ),
          allowlistLine(accounts, provider, state.connection.serverVersion),
        )
      : null;
  // The first line is said once, politely, when it arrives; focus stays where it was.
  const said = shownResult?.line ?? null;

  // The field for a model id typed in (section 9), and the last id it chose.
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const [typedId, setTypedId] = useState<string | null>(null);
  const pairRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const saidFor = useRef<HeldRefresh | null>(null);
  // The menu item a person last moved focus to, by its name: a focus event marks each move they
  // make, and none comes when rows change under focus.
  const focusedItem = useRef<string | null>(null);
  useEffect(() => {
    // Only a new answer is said: not the same one again when the words around it change.
    if (said === null || saidFor.current === found) return;
    saidFor.current = found;
    announce(said);
    // Rows the answer added or removed above the item a person was on would otherwise put another
    // under focus: focus goes back to that item, Refresh or one they moved to while it looked,
    // and the line under Refresh comes into view on a short screen.
    const items = [
      ...(pairRef.current?.querySelectorAll<HTMLElement>('[role="menu"] .menu-item') ?? []),
    ];
    const item = items.find((each) => itemName(each) === focusedItem.current);
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (!item || (!lost && !pairRef.current?.contains(active))) return;
    item.focus();
    if (focusedItem.current === "menuitem\nRefresh")
      item.closest("li")?.nextElementSibling?.scrollIntoView?.({ block: "nearest" });
  }, [found, said, announce]);
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
  const looking = found?.status === "looking";
  rows.push({
    label: "Refresh",
    note: looking ? "Looking…" : "Look for new models",
    ...(looking ? { disabled: true } : {}),
    ...(shownResult
      ? {
          line: shownResult.line,
          ...(shownResult.more.length > 0
            ? { more: { label: shownResult.label, lines: shownResult.more } }
            : {}),
        }
      : {}),
    onSelect: () => list.lookAgain(),
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
      <div
        className="b-pair"
        ref={pairRef}
        onFocus={(event) => {
          const item =
            event.target instanceof HTMLElement ? event.target.closest(".menu-item") : null;
          if (item instanceof HTMLElement) focusedItem.current = itemName(item);
        }}
      >
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
      {(updateRun || update) && <UpdateOpenClawNote />}
      {typedId !== null && typedId === model && menu.row === undefined && !typing && (
        <p className="b-hint" data-testid="model-typed-line">
          {typedId} was typed in.
        </p>
      )}
    </>
  );
}
