// How this device arranges the rail: which bots are pinned, which are hidden,
// the sort order and the manual order. The gateway can store none of it for a
// read-only connection (`users.prefs.set` needs `operator.write`), so it is
// kept per device, and the sort control says so for the manual order.
//
// Bot ids belong to a gateway (every gateway has a `main`), so the arrangement
// is kept per gateway: under the gateway's own identity, or under its address
// when it gives none. One kept under the address before the identity was known
// moves to the identity. An arrangement saved before it was kept per gateway
// names no gateway, so it is ignored and left where it is.

import type { Bot, ConnectionState, Task } from "@clawtrate/core";
import { useCallback, useState } from "react";
import { readPreference, writePreference } from "./preferences.ts";

export type SortOrder = "recent" | "name" | "manual";

export const SORT_ORDERS: Array<{ id: SortOrder; label: string }> = [
  { id: "recent", label: "Recent activity" },
  { id: "name", label: "Name" },
  { id: "manual", label: "Manual" },
];

export type RosterPrefs = {
  /** Pinned bots, in their own order. */
  pinned: string[];
  hidden: string[];
  sort: SortOrder;
  /** The manual order of the list. Bots not in it follow, in the gateway's order. */
  manual: string[];
};

/** The preference key of one gateway's arrangement. */
export const rosterKey = (scope: string) => `roster:${scope}`;

/** Which gateway an arrangement belongs to: its identity, else its address. Null with neither. */
export function rosterScope(
  connection: Pick<ConnectionState, "gatewayId" | "gatewayUrl">,
): string | null {
  if (connection.gatewayId) return `gateway:${connection.gatewayId}`;
  if (connection.gatewayUrl) return `address:${connection.gatewayUrl}`;
  return null;
}

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * The arrangement for `scope`. When it has none yet, the one kept under the
 * gateway's address (`fallback`) moves to it.
 */
export function readRoster(scope: string | null, fallback: string | null = null): RosterPrefs {
  if (scope === null) return parseRoster(null);
  let raw = readPreference(rosterKey(scope));
  if (raw === null) {
    const from = fallback && fallback !== scope ? rosterKey(fallback) : null;
    if (from && readPreference(from) !== null) {
      raw = readPreference(from);
      writePreference(rosterKey(scope), raw);
      writePreference(from, null);
    }
  }
  return parseRoster(raw);
}

function parseRoster(raw: string | null): RosterPrefs {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (value && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch {
    // A damaged preference starts over.
  }
  const sort = SORT_ORDERS.some((order) => order.id === parsed.sort)
    ? (parsed.sort as SortOrder)
    : "recent";
  return {
    pinned: ids(parsed.pinned),
    hidden: ids(parsed.hidden),
    sort,
    manual: ids(parsed.manual),
  };
}

/** A bot's latest activity across its tasks, or null when it has none. */
export function latestActivity(tasks: Task[] | undefined): number | null {
  let latest: number | null = null;
  for (const task of tasks ?? []) {
    if (task.updatedAt !== null && (latest === null || task.updatedAt > latest)) {
      latest = task.updatedAt;
    }
  }
  return latest;
}

export type Arrangement = { pinned: Bot[]; list: Bot[]; hidden: Bot[] };

/**
 * Pinned bots first, in their pinned order; then the list in the chosen order;
 * hidden bots apart. Ties keep the gateway's order, so the order is stable.
 */
export function arrange(
  bots: Bot[],
  tasksByBot: Record<string, Task[]>,
  prefs: RosterPrefs,
): Arrangement {
  const hidden = new Set(prefs.hidden);
  const pinnedIds = prefs.pinned.filter((id) => !hidden.has(id));
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const pinned = pinnedIds.flatMap((id) => byId.get(id) ?? []);
  const rest = bots.filter((bot) => !hidden.has(bot.id) && !pinnedIds.includes(bot.id));
  const gateway = new Map(bots.map((bot, index) => [bot.id, index]));
  const position = (id: string) => {
    const index = prefs.manual.indexOf(id);
    return index === -1 ? prefs.manual.length + gateway.get(id)! : index;
  };
  const compare = {
    recent: (a: Bot, b: Bot) =>
      (latestActivity(tasksByBot[b.id]) ?? -Infinity) -
      (latestActivity(tasksByBot[a.id]) ?? -Infinity),
    name: (a: Bot, b: Bot) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    manual: (a: Bot, b: Bot) => position(a.id) - position(b.id),
  }[prefs.sort];
  const list = [...rest].sort((a, b) => compare(a, b) || gateway.get(a.id)! - gateway.get(b.id)!);
  return { pinned, list, hidden: bots.filter((bot) => hidden.has(bot.id)) };
}

/** Move one bot to a new place in the manual order of the list it is shown in. */
export function moveInOrder(shown: string[], id: string, toIndex: number): string[] {
  const without = shown.filter((other) => other !== id);
  const at = Math.max(0, Math.min(without.length, toIndex));
  return [...without.slice(0, at), id, ...without.slice(at)];
}

/**
 * The rail's per-device arrangement for one gateway, persisted on every
 * change. `scope` is from `rosterScope`; `fallback` is the gateway's address
 * scope, whose arrangement moves to `scope` the first time.
 */
export function useRoster(scope: string | null, fallback: string | null = null) {
  const [held, setHeld] = useState(() => ({ scope, prefs: readRoster(scope, fallback) }));
  let current = held;
  // Another gateway: its own arrangement.
  if (held.scope !== scope) {
    current = { scope, prefs: readRoster(scope, fallback) };
    setHeld(current);
  }
  const update = useCallback((change: (prefs: RosterPrefs) => RosterPrefs) => {
    setHeld((now) => {
      const next = change(now.prefs);
      if (now.scope !== null) writePreference(rosterKey(now.scope), JSON.stringify(next));
      return { scope: now.scope, prefs: next };
    });
  }, []);
  return {
    prefs: current.prefs,
    setSort: useCallback((sort: SortOrder) => update((p) => ({ ...p, sort })), [update]),
    togglePin: useCallback(
      (id: string) =>
        update((p) => ({
          ...p,
          pinned: p.pinned.includes(id) ? p.pinned.filter((x) => x !== id) : [...p.pinned, id],
        })),
      [update],
    ),
    setHidden: useCallback(
      (id: string, hide: boolean) =>
        update((p) => ({
          ...p,
          hidden: hide ? [...new Set([...p.hidden, id])] : p.hidden.filter((x) => x !== id),
        })),
      [update],
    ),
    setManual: useCallback((manual: string[]) => update((p) => ({ ...p, manual })), [update]),
  };
}

export type RosterModel = ReturnType<typeof useRoster>;
