// The person's choices of how things are shown, kept on the gateway so every device of the same
// user shows the same (#639): "Show commands", "Show thinking", and which tasks and bots the list
// shows. One user preference (`users.prefs`, key `clawtrate.choices`), read and written as the
// rail's arrangement is (`sidebar.ts`): a compare-and-set against the value just read, applied
// again to a newer value on a conflict, and ordered by the value's own `rev`.
//
// What the gateway holds here is still content: whatever can write to the gateway can write a
// user's preferences (another of the person's connections, a plugin's tool during the person's
// turn, a bot that runs commands on the gateway's computer with its token), so a value here may
// only show more. Each choice is a "Show ..." switch, and a device shows the thing when it was
// turned on on that device or the gateway holds it on (`shownChoice`): turning one on shows it on
// every device; nothing in the store can turn off what a device turned on itself. None of them
// grants, sends or writes anything. Unknown names and values that are not booleans are dropped.

import { utf8Length } from "./encoding.ts";
import { asRecord } from "./mapping.ts";

export const CHOICES_PREF_KEY = "clawtrate.choices";
/** The choices kept, in Settings' order. */
export const CHOICE_IDS = [
  "commands",
  "thinking",
  "channelChats",
  "otherTools",
  "gatewayBot",
] as const;
export type ChoiceId = (typeof CHOICE_IDS)[number];
/** Times a change is applied again after a conflict before it gives up (as the rail's). */
export const CHOICES_WRITE_ATTEMPTS = 4;
/** The gateway's bound on one preference (`MAX_SIDEBAR_BYTES`); this value is far below it. */
export const MAX_CHOICES_BYTES = 4_096;

/** Some choices, each on or off; a name absent is one the gateway holds no choice for. */
export type ChoiceSet = Partial<Record<ChoiceId, boolean>>;

export type ChoicesPrefs = {
  on: ChoiceSet;
  /** Raised by one on every write under the compare-and-set; absent is 0 (`SidebarPrefs.rev`). */
  rev?: number;
};

export type ChoicesState = {
  /** As `SidebarState.status`: `unavailable` for a connection with no durable user, or a failed read. */
  status: "unknown" | "ok" | "unavailable";
  /** Null while the gateway holds no choices yet. */
  prefs: ChoicesPrefs | null;
};

export const initialChoices: ChoicesState = { status: "unknown", prefs: null };

const isChoice = (name: string): name is ChoiceId =>
  (CHOICE_IDS as readonly string[]).includes(name);

/** Some choices as received: known names with boolean values only. */
export function parseChoiceSet(value: unknown): ChoiceSet {
  const record = asRecord(value) ?? {};
  const out: ChoiceSet = {};
  for (const name of CHOICE_IDS)
    if (typeof record[name] === "boolean") out[name] = record[name] as boolean;
  return out;
}

/** What the gateway holds, read as choices; anything else reads as none. */
export function parseChoices(value: unknown): ChoicesPrefs {
  const record = asRecord(value) ?? {};
  const rev =
    typeof record.rev === "number" && Number.isSafeInteger(record.rev) && record.rev > 0
      ? record.rev
      : 0;
  return { on: parseChoiceSet(record.on), ...(rev > 0 ? { rev } : {}) };
}

/** The revision choices carry; none held is below every revision. */
export function choicesRev(prefs: ChoicesPrefs | null | undefined): number {
  return prefs ? (prefs.rev ?? 0) : -1;
}

/**
 * Whether a choice is on here: on when this device turned it on, or when the gateway holds it on.
 * A value from the gateway only ever shows more.
 */
export const shownChoice = (
  state: ChoicesState | undefined,
  own: boolean | undefined,
  id: ChoiceId,
): boolean => own === true || heldChoice(state, id) === true;

/** The gateway's choice, when it holds one: only from a read that succeeded. */
export function heldChoice(state: ChoicesState | undefined, id: ChoiceId): boolean | undefined {
  return state?.status === "ok" ? state.prefs?.on[id] : undefined;
}

/** Context: the gateway, on the connection the write is bound to. */
export type ChoicesContext = { request: (method: string, params: unknown) => Promise<unknown> };

async function readRaw(ctx: ChoicesContext): Promise<{ ok: true; raw: unknown } | { ok: false }> {
  const result = asRecord(await ctx.request("users.prefs.get", { keys: [CHOICES_PREF_KEY] }));
  if (result?.status !== "ok") return { ok: false };
  const entries = asRecord(result.entries) ?? {};
  return {
    ok: true,
    raw: Object.hasOwn(entries, CHOICES_PREF_KEY) ? entries[CHOICES_PREF_KEY] : null,
  };
}

/** Choices as read with other preferences (`entries` of a `users.prefs.get` answer). */
export function choicesFromEntries(entries: Record<string, unknown>): ChoicesState {
  const raw = Object.hasOwn(entries, CHOICES_PREF_KEY) ? entries[CHOICES_PREF_KEY] : null;
  return { status: "ok", prefs: raw === null || raw === undefined ? null : parseChoices(raw) };
}

/**
 * Change choices on the gateway. `change` is set over what it holds (`mode: "set"`: the last
 * write of a choice wins), or fills only the choices it holds none of (`mode: "fill"`: the
 * first-time merge, where the gateway's choice wins). Answers what the gateway holds after it,
 * or the value read when there was nothing to write.
 */
export async function writeChoices(
  ctx: ChoicesContext,
  change: ChoiceSet,
  mode: "set" | "fill",
): Promise<ChoicesState> {
  for (let attempt = 0; attempt < CHOICES_WRITE_ATTEMPTS; attempt += 1) {
    const read = await readRaw(ctx);
    if (!read.ok) throw new Error("This gateway keeps no preferences for this connection.");
    const from = read.raw === null || read.raw === undefined ? null : parseChoices(read.raw);
    const held = from?.on ?? {};
    const on: ChoiceSet = { ...held };
    for (const name of Object.keys(change).filter(isChoice))
      if (typeof change[name] === "boolean" && (mode === "set" || held[name] === undefined))
        on[name] = change[name];
    if (CHOICE_IDS.every((name) => on[name] === held[name])) return { status: "ok", prefs: from };
    const next: ChoicesPrefs = { on, rev: (from?.rev ?? 0) + 1 };
    if (utf8Length(JSON.stringify(next)) > MAX_CHOICES_BYTES)
      throw new Error("These choices are too large for the gateway to keep.");
    const result = asRecord(
      await ctx.request("users.prefs.set", {
        entries: { [CHOICES_PREF_KEY]: next },
        expectedEntries: { [CHOICES_PREF_KEY]: read.raw ?? null },
      }),
    );
    if (result?.status === "ok") return { status: "ok", prefs: next };
    if (result?.status !== "conflict")
      throw new Error("This gateway keeps no preferences for this connection.");
  }
  throw new Error("These choices kept changing on another device. Try again.");
}
