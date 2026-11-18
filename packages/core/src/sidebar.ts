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
  return { pins: ids(record.pins), sections, hidden: ids(record.hidden), order: ids(record.order) };
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

/** Context: the gateway, and the write tier for a change. */
export type SidebarContext = {
  request: (method: string, params: unknown) => Promise<unknown>;
  ensureWrite: () => Promise<void>;
};

/** What the gateway holds now: the parsed arrangement and the raw value to compare against. */
async function readRaw(
  ctx: SidebarContext,
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
    const next = applySidebarChange(from, change);
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
