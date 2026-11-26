// How the rail is arranged: which bots are pinned, which are hidden, the user's
// sections, the sort order and the manual order. The gateway keeps the
// arrangement for its user (`users.prefs`, `sidebar.ts` in the engine), so every
// device sees it: once it holds one, the rail shows it, and a connection that
// writes changes it there. Until it holds one, or where it keeps none (a
// connection with no durable user), the rail keeps its arrangement per device,
// and the first change a writing connection makes starts the gateway's from it.
// The first time a writing connection finds the gateway holding none, this
// device's own starts it, with nothing to click (`mergeSidebar` in the engine,
// docs/decisions.md). Once the gateway holds one, this device's copy only
// mirrors it: an older copy is dropped, never merged back in.
// The sort order is always this device's own.
//
// Bot ids belong to a gateway (every gateway has a `main`), so the arrangement
// is kept per gateway: under the gateway's own identity, or under its address
// when it gives none. One kept under the address before the identity was known
// moves to the identity. An arrangement saved before it was kept per gateway
// names no gateway, so it is ignored and left where it is.

import type {
  Bot,
  ConnectionState,
  SidebarChange,
  SidebarPrefs,
  SidebarState,
  Task,
} from "@clawtrate/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readPreference, writePreference } from "./preferences.ts";
import { isUnread, type SeenMap } from "./unread.ts";

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
  /** The user's sections, each a name and its bots; a bot is in at most one. */
  sections: Array<{ name: string; bots: string[] }>;
  /** This device has met the gateway's arrangement: its copy is a mirror of it, never sent again. */
  merged?: true;
  /**
   * Bots this device shows although the gateway's arrangement hides them: "Show in sidebar" on a
   * connection that only reads. This device's own, never sent; at most `MAX_SHOWN_HERE`.
   */
  shownHere?: string[];
};

/** Bots one device may show over the gateway's hides (the arrangement's own bot bound). */
export const MAX_SHOWN_HERE = 32;

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
    ...(parsed.merged === true ? { merged: true as const } : {}),
    ...(ids(parsed.shownHere).length > 0
      ? { shownHere: ids(parsed.shownHere).slice(0, MAX_SHOWN_HERE) }
      : {}),
  };
}

function withoutShownHere(prefs: RosterPrefs, id: string): RosterPrefs {
  const rest = (prefs.shownHere ?? []).filter((each) => each !== id);
  const next = { ...prefs };
  if (rest.length > 0) next.shownHere = rest;
  else delete next.shownHere;
  return next;
}

/** Whether this device arranged anything of its own. */
const arranged = (prefs: RosterPrefs) =>
  prefs.pinned.length + prefs.hidden.length + prefs.manual.length + prefs.sections.length > 0;

/** This device's arrangement in the gateway's form, the base of its first change there. */
export function toSidebar(prefs: RosterPrefs): SidebarPrefs {
  return {
    pins: prefs.pinned,
    sections: prefs.sections,
    hidden: prefs.hidden,
    order: prefs.manual,
  };
}

/** The gateway's arrangement, with this device's sort order and the bots it shows of its own. */
function fromSidebar(prefs: SidebarPrefs, local: RosterPrefs): RosterPrefs {
  return {
    pinned: prefs.pins,
    hidden: prefs.hidden,
    sort: local.sort,
    manual: prefs.order,
    sections: prefs.sections,
    ...(local.shownHere ? { shownHere: local.shownHere } : {}),
  };
}

/**
 * What this device keeps once it has met the gateway's arrangement: a mirror of it, marked, so
 * an older copy of its own is dropped rather than merged in, and a reset gateway shows the last
 * arrangement the person had rather than an older one.
 */
export function mirrorOf(gateway: SidebarPrefs, local: RosterPrefs): RosterPrefs {
  return { ...fromSidebar(gateway, local), merged: true };
}

/**
 * Whether this device's own arrangement starts the gateway's: only while the gateway answered
 * that it holds none, on a connection that writes and is up, and only once per device and gateway
 * (`merged`, set after it starts or once the device has met the gateway's). A reinstall or a
 * cleared store has nothing of its own to start it with.
 */
export function seedWanted(
  local: RosterPrefs,
  gateway: SidebarState | null | undefined,
  writes: boolean,
  connected: boolean,
): boolean {
  return (
    gateway?.status === "ok" &&
    gateway.prefs === null &&
    writes &&
    connected &&
    local.merged !== true &&
    arranged(local)
  );
}

/** Hidden bots with an unread task (a reply, a failed run's end): counted on the "Hidden bots" fold. */
export function hiddenWithUnread(
  hidden: Bot[],
  tasksByBot: Record<string, Task[]>,
  seen: SeenMap,
): number {
  return hidden.filter((bot) => (tasksByBot[bot.id] ?? []).some((task) => isUnread(task, seen)))
    .length;
}

/** A task the person has to act on now: a hidden bot with one shows in the list until it doesn't. */
export const needsYou = (task: Task) => task.status === "waiting" || task.status === "blocked";

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

export type Arrangement = {
  pinned: Bot[];
  list: Bot[];
  /** The user's sections, after the list, each in the chosen order. */
  sections: Array<{ name: string; bots: Bot[] }>;
  hidden: Bot[];
};

/**
 * Pinned bots first, in their pinned order; then the list in the chosen order;
 * then each section; hidden bots apart. Ties keep the gateway's order, so the
 * order is stable.
 */
export function arrange(
  bots: Bot[],
  tasksByBot: Record<string, Task[]>,
  prefs: RosterPrefs,
): Arrangement {
  // A hidden bot with something the person has to act on (`needsYou`) shows in the list until it
  // doesn't: hiding, which any device of the person (or anything that writes to the gateway) can
  // do, never keeps an approval, a question or a blocked run out of view. One this device shows of
  // its own (`shownHere`) is listed too.
  const waits = (id: string) => (tasksByBot[id] ?? []).some(needsYou);
  const here = new Set(prefs.shownHere ?? []);
  const hidden = new Set(prefs.hidden.filter((id) => !waits(id) && !here.has(id)));
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
  const sorted = [...rest].sort((a, b) => compare(a, b) || gateway.get(a.id)! - gateway.get(b.id)!);
  const sectionOf = new Map<string, string>();
  for (const section of prefs.sections)
    for (const id of section.bots) if (!sectionOf.has(id)) sectionOf.set(id, section.name);
  const sections = prefs.sections
    .map((section) => ({
      name: section.name,
      bots: sorted.filter((bot) => sectionOf.get(bot.id) === section.name),
    }))
    .filter((section) => section.bots.length > 0);
  return {
    pinned,
    list: sorted.filter((bot) => !sectionOf.has(bot.id)),
    sections,
    hidden: bots.filter((bot) => hidden.has(bot.id)),
  };
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
  /** The connection is up now: the first-time merge waits for it. */
  connected?: boolean;
  /** Merge this device's arrangement into the gateway's; answers whether it was merged. */
  merge?: (base: SidebarPrefs) => Promise<boolean>;
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
  // Once the gateway holds an arrangement, this device's copy mirrors it (`mirrorOf`): an older
  // copy of its own is dropped, never merged into the gateway's.
  if (gateway?.prefs && current.scope !== null) {
    const mirror = mirrorOf(gateway.prefs, current.prefs);
    const text = JSON.stringify(mirror);
    if (text !== JSON.stringify(current.prefs)) {
      writePreference(rosterKey(current.scope), text);
      current = { scope: current.scope, prefs: mirror };
      setHeld(current);
    }
  }
  /** Where the arrangement lives: the gateway once it holds one, or once a writing connection would start it. */
  const synced = gateway !== null && (gateway.prefs !== null || sync!.interactive);
  const prefs = gateway?.prefs ? fromSidebar(gateway.prefs, current.prefs) : current.prefs;
  const latest = useRef({ sync, synced, local: current.prefs });
  useLayoutEffect(() => {
    latest.current = { sync, synced, local: current.prefs };
  });

  // The first time, with the gateway holding none: this device's own starts it (`seedWanted`).
  // A start that failed is made again on the next connect.
  const seedScope =
    current.scope !== null &&
    sync?.merge !== undefined &&
    seedWanted(current.prefs, gateway, sync.interactive, sync.connected === true)
      ? current.scope
      : null;
  const seeding = useRef<string | null>(null);
  useEffect(() => {
    const merge = latest.current.sync?.merge;
    if (seedScope === null || seeding.current === seedScope || !merge) return;
    seeding.current = seedScope;
    const done = () => {
      if (seeding.current === seedScope) seeding.current = null;
    };
    merge(toSidebar(latest.current.local)).then((merged) => {
      done();
      if (!merged) return;
      setHeld((now) => {
        if (now.scope !== seedScope) return now;
        const next = { ...now.prefs, merged: true as const };
        writePreference(rosterKey(seedScope), JSON.stringify(next));
        return { scope: now.scope, prefs: next };
      });
    }, done);
  }, [seedScope]);

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
      (id: string, hide: boolean) => {
        // Hidden again from here: this device no longer shows it of its own.
        if (hide) update((p) => (p.shownHere?.includes(id) ? withoutShownHere(p, id) : p));
        return apply({ op: "hide", botId: id, hidden: hide });
      },
      [apply, update],
    ),
    /**
     * Show a bot the gateway's arrangement hides, on this device only: for a connection that
     * can't change the gateway's, so a hide written elsewhere is always one click from undone here.
     */
    showHere: useCallback(
      (id: string) =>
        update((p) =>
          p.shownHere?.includes(id) || (p.shownHere?.length ?? 0) >= MAX_SHOWN_HERE
            ? p
            : { ...p, shownHere: [...(p.shownHere ?? []), id] },
        ),
      [update],
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
