// How the rail is arranged: which bots are pinned, which are hidden, the user's
// sections, the sort order and the manual order. The gateway keeps the
// arrangement for its user (`users.prefs`, `sidebar.ts` in the engine), so every
// device sees it: once it holds one, the rail shows it, and a connection that
// writes changes it there. Until it holds one, or where it keeps none (a
// connection with no durable user), the rail keeps its arrangement per device,
// and the first change a writing connection makes starts the gateway's from it.
// The sort order is always this device's own.
//
// Bot ids belong to a gateway (every gateway has a `main`), so the arrangement
// is kept per gateway: under the gateway's own identity, or under its address
// when it gives none. One kept under the address before the identity was known
// moves to the identity. An arrangement saved before it was kept per gateway
// names no gateway, so it is ignored and left where it is.

import type { ConnectionState, SidebarChange, SidebarPrefs, SidebarState } from "@clawtrate/core";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { fromSidebar, SORT_ORDERS, type RosterPrefs, type SortOrder } from "./arrangement.ts";
import { readPreference, writePreference } from "./preferences.ts";

export {
  arrange,
  fromSidebar,
  latestActivity,
  SORT_ORDERS,
  type Arrangement,
  type RosterPrefs,
  type SortOrder,
} from "./arrangement.ts";

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
  const sections: RosterPrefs["sections"] = [];
  for (const entry of Array.isArray(parsed.sections) ? parsed.sections : []) {
    const section = entry as { name?: unknown; bots?: unknown };
    if (typeof section?.name === "string" && section.name.trim()) {
      const bots = ids(section.bots);
      if (bots.length > 0) sections.push({ name: section.name, bots });
    }
  }
  return {
    pinned: ids(parsed.pinned),
    hidden: ids(parsed.hidden),
    sort,
    manual: ids(parsed.manual),
    sections,
  };
}

/** This device's arrangement in the gateway's form, the base of its first change there. */
export function toSidebar(prefs: RosterPrefs): SidebarPrefs {
  return {
    pins: prefs.pinned,
    sections: prefs.sections,
    hidden: prefs.hidden,
    order: prefs.manual,
  };
}

/** One change applied to this device's own arrangement. */
function applyLocal(prefs: RosterPrefs, change: SidebarChange): RosterPrefs {
  switch (change.op) {
    case "pin":
      return {
        ...prefs,
        pinned: change.pinned
          ? [...prefs.pinned.filter((x) => x !== change.botId), change.botId]
          : prefs.pinned.filter((x) => x !== change.botId),
      };
    case "hide":
      return {
        ...prefs,
        hidden: change.hidden
          ? [...new Set([...prefs.hidden, change.botId])]
          : prefs.hidden.filter((x) => x !== change.botId),
      };
    case "move": {
      const order = [...prefs.manual];
      for (const id of change.shown) if (!order.includes(id)) order.push(id);
      const without = order.filter((id) => id !== change.botId);
      const at = change.before === null ? -1 : without.indexOf(change.before);
      without.splice(at === -1 ? without.length : at, 0, change.botId);
      return { ...prefs, manual: without };
    }
    case "section": {
      const sections = prefs.sections
        .map((section) => ({ ...section, bots: section.bots.filter((x) => x !== change.botId) }))
        .filter((section) => section.bots.length > 0);
      const name = change.section?.replace(/\s+/g, " ").trim();
      if (name) {
        const existing = sections.find((section) => section.name === name);
        if (existing) existing.bots.push(change.botId);
        else sections.push({ name, bots: [change.botId] });
      }
      return { ...prefs, sections };
    }
  }
}

/** Move one bot to a new place in the manual order of the list it is shown in. */
export function moveInOrder(shown: string[], id: string, toIndex: number): string[] {
  const without = shown.filter((other) => other !== id);
  const at = Math.max(0, Math.min(without.length, toIndex));
  return [...without.slice(0, at), id, ...without.slice(at)];
}

/** How the rail reaches the gateway's arrangement. */
export type RosterSync = {
  sidebar: SidebarState | undefined;
  /** The connection writes: a change goes to the gateway. */
  interactive: boolean;
  change: (change: SidebarChange, base: SidebarPrefs | null) => Promise<void>;
};

/**
 * The rail's arrangement for one gateway. `scope` is from `rosterScope`;
 * `fallback` is the gateway's address scope, whose arrangement moves to `scope`
 * the first time. With `sync`, the gateway's arrangement is shown once it holds
 * one, and a writing connection changes it there.
 */
export function useRoster(
  scope: string | null,
  fallback: string | null = null,
  sync: RosterSync | null = null,
) {
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
  const gateway = sync?.sidebar?.status === "ok" ? sync.sidebar : null;
  /** Where the arrangement lives: the gateway once it holds one, or once a writing connection would start it. */
  const synced = gateway !== null && (gateway.prefs !== null || sync!.interactive);
  const prefs = gateway?.prefs ? fromSidebar(gateway.prefs, current.prefs.sort) : current.prefs;
  const latest = useRef({ sync, synced, local: current.prefs });
  useLayoutEffect(() => {
    latest.current = { sync, synced, local: current.prefs };
  });

  /** Apply a change where the arrangement lives. Read-only, on the gateway's: nothing to do. */
  const apply = useCallback(
    async (change: SidebarChange): Promise<void> => {
      const { sync, synced, local } = latest.current;
      if (!synced) return update((p) => applyLocal(p, change));
      if (!sync?.interactive) return;
      await sync.change(change, toSidebar(local));
    },
    [update],
  );

  return {
    prefs,
    /** The arrangement is the gateway's, shared by the user's devices. */
    synced,
    /** This connection may change the arrangement: always for its own, only when it writes for the gateway's. */
    editable: !synced || sync?.interactive === true,
    setSort: useCallback((sort: SortOrder) => update((p) => ({ ...p, sort })), [update]),
    togglePin: useCallback(
      (id: string) => apply({ op: "pin", botId: id, pinned: !prefs.pinned.includes(id) }),
      [apply, prefs.pinned],
    ),
    setHidden: useCallback(
      (id: string, hide: boolean) => apply({ op: "hide", botId: id, hidden: hide }),
      [apply],
    ),
    /** Move a bot before another in the manual order (null: to the end); `shown` is the list as shown. */
    move: useCallback(
      (id: string, before: string | null, shown: string[]) =>
        apply({ op: "move", botId: id, before, shown }),
      [apply],
    ),
    moveToSection: useCallback(
      (id: string, section: string | null) => apply({ op: "section", botId: id, section }),
      [apply],
    ),
  };
}

export type RosterModel = ReturnType<typeof useRoster>;
