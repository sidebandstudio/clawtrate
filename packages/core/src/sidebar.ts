// The rail's arrangement kept on the gateway, so every device of the same user
// sees it: pinned bots, sections, hidden bots and the manual order, in one user
// preference (`users.prefs`, key `clawtrate.sidebar`). Reading is
// `operator.read`; writing is `operator.write` (OpenClaw 2026.10.6,
// `core-method-policy`), a compare-and-set against the value just read, so two
// devices changing it at once never lose each other's change: on a conflict
// the change is applied again to what the gateway now holds. The store is per
// user profile; a connection without one (a shared token) gets
// `no_durable_identity`, and the rail then keeps its arrangement per device.

import { utf8Length } from "./encoding.ts";
import { asRecord } from "./mapping.ts";

export const SIDEBAR_PREF_KEY = "clawtrate.sidebar";
/** Bots any list in the arrangement names (the state's `MAX_BOTS`). */
export const MAX_SIDEBAR_BOTS = 32;
export const MAX_SIDEBAR_SECTIONS = 16;
export const MAX_SECTION_NAME_CHARS = 64;
/** The longest bot id kept: the bridge's own bot id bound. */
export const MAX_SIDEBAR_ID_CHARS = 128;
/** Times a change is applied again after a conflict before it gives up. */
export const SIDEBAR_WRITE_ATTEMPTS = 4;
/**
 * The most the gateway keeps in one preference: 4,096 UTF-8 bytes of its JSON
 * (`prepareEntries`, OpenClaw 2026.10.6 `user-preferences` validation, which
 * refuses more with `value-too-large`).
 */
export const MAX_SIDEBAR_BYTES = 4_096;

/** A change the gateway would refuse as too large, or a list already full: said in plain words. */
export class SidebarFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidebarFullError";
  }
}

/** The bytes the gateway counts for an arrangement. */
export function sidebarBytes(prefs: SidebarPrefs): number {
  return utf8Length(JSON.stringify(prefs));
}

export type SidebarSection = { name: string; bots: string[] };

export type SidebarPrefs = {
  /** Pinned bots, in their own order. */
  pins: string[];
  /** Named sections; a bot is in at most one. */
  sections: SidebarSection[];
  hidden: string[];
  /** The manual order of the list. */
  order: string[];
  /**
   * The arrangement's revision on the gateway: every write raises it by one under the
   * compare-and-set, so it orders the values the gateway held. The gateway's protocol
   * gives no version of a preference (`users.prefs.get` answers entries, and
   * `users.prefs.changed` names keys), so the arrangement carries its own. Absent is 0.
   */
  rev?: number;
};

export type SidebarState = {
  /**
   * `unknown` until read; `ok` when the gateway keeps the user's preferences
   * (`prefs` null while it holds no arrangement yet); `unavailable` when this
   * connection has no durable user (`no_durable_identity`) or the read failed.
   */
  status: "unknown" | "ok" | "unavailable";
  prefs: SidebarPrefs | null;
};

export const initialSidebar: SidebarState = { status: "unknown", prefs: null };

/** One change to the arrangement, applied to whatever the gateway holds. */
export type SidebarChange =
  | { op: "pin"; botId: string; pinned: boolean }
  | { op: "hide"; botId: string; hidden: boolean }
  /**
   * Move one bot in the manual order: before `before`, or to the end when null.
   * `shown` is the order this device shows, which places the bots the stored
   * order does not name yet; every other bot keeps the place the gateway holds,
   * so another device's moves made meanwhile survive.
   */
  | { op: "move"; botId: string; before: string | null; shown: string[] }
  /** Move a bot into a section, made when new; null takes it out of every section. */
  | { op: "section"; botId: string; section: string | null };

const BOT_ID = /^[\w.-]{1,128}$/;

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && BOT_ID.test(item) && !out.includes(item)) out.push(item);
    if (out.length >= MAX_SIDEBAR_BOTS) break;
  }
  return out;
}

/** A section's name as kept: one line, trimmed, at most `MAX_SECTION_NAME_CHARS`. */
export function sectionName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) throw new Error("A section needs a name.");
  if (name.length > MAX_SECTION_NAME_CHARS)
    throw new Error(`A section's name can be at most ${MAX_SECTION_NAME_CHARS} characters.`);
  return name;
}

/**
 * What the gateway holds, read as an arrangement: unknown fields dropped,
 * every list bounded, a bot in at most one section, empty sections removed.
 * Anything that is not an arrangement reads as an empty one.
 */
export function parseSidebar(value: unknown): SidebarPrefs {
  const record = asRecord(value) ?? {};
  const sections: SidebarSection[] = [];
  const placed = new Set<string>();
  for (const entry of Array.isArray(record.sections) ? record.sections : []) {
    const section = asRecord(entry);
    if (!section || typeof section.name !== "string") continue;
    let name: string;
    try {
      name = sectionName(section.name);
    } catch {
      continue;
    }
    if (sections.some((other) => other.name === name)) continue;
    const bots = ids(section.bots).filter((id) => !placed.has(id));
    bots.forEach((id) => placed.add(id));
    if (bots.length > 0) sections.push({ name, bots });
    if (sections.length >= MAX_SIDEBAR_SECTIONS) break;
  }
  const rev =
    typeof record.rev === "number" && Number.isSafeInteger(record.rev) && record.rev > 0
      ? record.rev
      : 0;
  return {
    pins: ids(record.pins),
    sections,
    hidden: ids(record.hidden),
    order: ids(record.order),
    ...(rev > 0 ? { rev } : {}),
  };
}

/** The revision an arrangement carries; none held is below every revision. */
export function sidebarRev(prefs: SidebarPrefs | null | undefined): number {
  return prefs ? (prefs.rev ?? 0) : -1;
}

/** Apply one change. Pure; the result is within every bound. */
export function applySidebarChange(prefs: SidebarPrefs, change: SidebarChange): SidebarPrefs {
  const without = (list: string[], id: string) => list.filter((other) => other !== id);
  switch (change.op) {
    case "pin":
      if (
        change.pinned &&
        !prefs.pins.includes(change.botId) &&
        prefs.pins.length >= MAX_SIDEBAR_BOTS
      )
        throw new SidebarFullError(`At most ${MAX_SIDEBAR_BOTS} bots can be pinned.`);
      return parseSidebar({
        ...prefs,
        pins: change.pinned
          ? [...without(prefs.pins, change.botId), change.botId]
          : without(prefs.pins, change.botId),
      });
    case "hide":
      return parseSidebar({
        ...prefs,
        hidden: change.hidden
          ? [...without(prefs.hidden, change.botId), change.botId]
          : without(prefs.hidden, change.botId),
        // A hidden bot is not pinned.
        pins: change.hidden ? without(prefs.pins, change.botId) : prefs.pins,
      });
    case "move": {
      const order = [...prefs.order];
      for (const id of change.shown) if (!order.includes(id)) order.push(id);
      const without = order.filter((id) => id !== change.botId);
      const at = change.before === null ? -1 : without.indexOf(change.before);
      without.splice(at === -1 ? without.length : at, 0, change.botId);
      return parseSidebar({ ...prefs, order: without });
    }
    case "section": {
      const sections = prefs.sections.map((section) => ({
        name: section.name,
        bots: without(section.bots, change.botId),
      }));
      if (change.section !== null) {
        const name = sectionName(change.section);
        const existing = sections.find((section) => section.name === name);
        if (existing) existing.bots.push(change.botId);
        else {
          if (sections.filter((section) => section.bots.length > 0).length >= MAX_SIDEBAR_SECTIONS)
            throw new Error(`There can be at most ${MAX_SIDEBAR_SECTIONS} sections.`);
          sections.push({ name, bots: [change.botId] });
        }
      }
      return parseSidebar({ ...prefs, sections });
    }
  }
}

/**
 * A device's own arrangement merged into the gateway's, the first time the device writes there
 * (docs/decisions.md, "Your choices follow you"). The gateway's comes first and wins: a bot it
 * pins stays pinned, and its order and sections keep their places. Hidden is a union, except a
 * bot the gateway pins; the device's pins, order and section places are added after for bots the
 * gateway doesn't place. Within every bound; the gateway's `rev` is kept for the caller to raise.
 */
export function mergeSidebars(gateway: SidebarPrefs, device: SidebarPrefs): SidebarPrefs {
  const hidden = [
    ...gateway.hidden,
    ...device.hidden.filter((id) => !gateway.hidden.includes(id) && !gateway.pins.includes(id)),
  ];
  const sections = gateway.sections.map((section) => ({ ...section, bots: [...section.bots] }));
  const placed = new Set(sections.flatMap((section) => section.bots));
  const pins = [
    ...gateway.pins,
    ...device.pins.filter(
      (id) => !gateway.pins.includes(id) && !hidden.includes(id) && !placed.has(id),
    ),
  ];
  for (const section of device.sections) {
    const bots = section.bots.filter((id) => !placed.has(id));
    if (bots.length === 0) continue;
    const same = sections.find((each) => each.name === section.name);
    if (same) same.bots.push(...bots);
    else if (sections.length < MAX_SIDEBAR_SECTIONS) sections.push({ name: section.name, bots });
    else continue;
    bots.forEach((id) => placed.add(id));
  }
  const order = [...gateway.order, ...device.order.filter((id) => !gateway.order.includes(id))];
  return parseSidebar({ pins, sections, hidden, order, rev: gateway.rev });
}

const sameArrangement = (a: SidebarPrefs, b: SidebarPrefs) =>
  JSON.stringify([a.pins, a.sections, a.hidden, a.order]) ===
  JSON.stringify([b.pins, b.sections, b.hidden, b.order]);

/**
 * Merge this device's arrangement into the gateway's (`mergeSidebars`), with a compare-and-set
 * as for a change. Nothing is written when it adds nothing, or when the merged arrangement would
 * pass the gateway's bound: the gateway's then stays as it is. Answers what the gateway holds.
 */
export async function mergeSidebar(
  ctx: Pick<SidebarContext, "request">,
  base: SidebarPrefs,
): Promise<SidebarState> {
  const device = parseSidebar(base);
  for (let attempt = 0; attempt < SIDEBAR_WRITE_ATTEMPTS; attempt += 1) {
    const read = await readRaw(ctx);
    if (read.status !== "ok")
      throw new Error("This gateway keeps no preferences for this connection.");
    const held = read.raw === null || read.raw === undefined ? null : parseSidebar(read.raw);
    const merged = mergeSidebars(held ?? parseSidebar({}), device);
    if (
      (held && sameArrangement(merged, held)) ||
      (!held && sameArrangement(merged, parseSidebar({})))
    )
      return { status: "ok", prefs: held };
    const next = { ...merged, rev: (held?.rev ?? 0) + 1 };
    if (!Number.isSafeInteger(next.rev) || sidebarBytes(next) > MAX_SIDEBAR_BYTES)
      return { status: "ok", prefs: held };
    const result = asRecord(
      await ctx.request("users.prefs.set", {
        entries: { [SIDEBAR_PREF_KEY]: next },
        expectedEntries: { [SIDEBAR_PREF_KEY]: read.raw ?? null },
      }),
    );
    if (result?.status === "ok") return { status: "ok", prefs: next };
    if (result?.status !== "conflict")
      throw new Error("This gateway keeps no preferences for this connection.");
  }
  throw new Error("The arrangement kept changing on another device. Try again.");
}

/** Context: the gateway, and the write tier for a change. */
export type SidebarContext = {
  request: (method: string, params: unknown) => Promise<unknown>;
  ensureWrite: () => Promise<void>;
};

/** What the gateway holds now: the parsed arrangement and the raw value to compare against. */
async function readRaw(
  ctx: Pick<SidebarContext, "request">,
): Promise<{ status: "ok"; raw: unknown } | { status: "unavailable" }> {
  const result = asRecord(await ctx.request("users.prefs.get", { keys: [SIDEBAR_PREF_KEY] }));
  if (result?.status !== "ok") return { status: "unavailable" };
  const entries = asRecord(result.entries) ?? {};
  return {
    status: "ok",
    raw: Object.hasOwn(entries, SIDEBAR_PREF_KEY) ? entries[SIDEBAR_PREF_KEY] : null,
  };
}

/** The arrangement as the gateway holds it now. */
export async function readSidebar(ctx: SidebarContext): Promise<SidebarState> {
  const read = await readRaw(ctx);
  if (read.status !== "ok") return { status: "unavailable", prefs: null };
  return {
    status: "ok",
    prefs: read.raw === null || read.raw === undefined ? null : parseSidebar(read.raw),
  };
}

/** The arrangement as read with other preferences (`entries` of a `users.prefs.get` answer). */
export function sidebarFromEntries(entries: Record<string, unknown>): SidebarState {
  const raw = Object.hasOwn(entries, SIDEBAR_PREF_KEY) ? entries[SIDEBAR_PREF_KEY] : null;
  return { status: "ok", prefs: raw === null || raw === undefined ? null : parseSidebar(raw) };
}

/**
 * Apply a change on the gateway. When it holds no arrangement yet, `base`
 * (this device's) is where the change starts, so the first change keeps what
 * the person had arranged. Compare-and-set; on a conflict the change is applied
 * again to the newer value, up to `SIDEBAR_WRITE_ATTEMPTS` times.
 */
export async function changeSidebar(
  ctx: SidebarContext,
  change: SidebarChange,
  base: SidebarPrefs | null,
): Promise<SidebarState> {
  await ctx.ensureWrite();
  for (let attempt = 0; attempt < SIDEBAR_WRITE_ATTEMPTS; attempt += 1) {
    const read = await readRaw(ctx);
    if (read.status !== "ok")
      throw new Error("This gateway keeps no preferences for this connection.");
    const from =
      read.raw === null || read.raw === undefined
        ? parseSidebar(base ?? {})
        : parseSidebar(read.raw);
    const next = { ...applySidebarChange(from, change), rev: (from.rev ?? 0) + 1 };
    if (sidebarBytes(next) > MAX_SIDEBAR_BYTES)
      throw new SidebarFullError(
        "The gateway keeps at most 4,096 bytes of arrangement, and this change would pass that. Remove a section or shorten section names first.",
      );
    const result = asRecord(
      await ctx.request("users.prefs.set", {
        entries: { [SIDEBAR_PREF_KEY]: next },
        expectedEntries: { [SIDEBAR_PREF_KEY]: read.raw ?? null },
      }),
    );
    if (result?.status === "ok") return { status: "ok", prefs: next };
    if (result?.status !== "conflict")
      throw new Error("This gateway keeps no preferences for this connection.");
  }
  throw new Error("The arrangement kept changing on another device. Try again.");
}
