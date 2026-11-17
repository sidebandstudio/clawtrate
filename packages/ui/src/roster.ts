// How this device arranges the rail: which bots are pinned, which are hidden,
// the sort order and the manual order. The gateway can store none of it for a
// read-only connection (`users.prefs.set` needs `operator.write`), so it is
// kept per device, and the sort control says so for the manual order.

import type { Bot, Task } from "@clawtrate/core";
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

const KEY = "roster";

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export function readRoster(): RosterPrefs {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readPreference(KEY) ?? "{}");
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

/** The rail's per-device arrangement, persisted on every change. */
export function useRoster() {
  const [prefs, setPrefs] = useState<RosterPrefs>(readRoster);
  const update = useCallback((change: (prefs: RosterPrefs) => RosterPrefs) => {
    setPrefs((current) => {
      const next = change(current);
      writePreference(KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return {
    prefs,
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
