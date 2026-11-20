// The route store (docs/design/setup.md §2 "Routes", §15; docs/decisions.md,
// "Routes, when the setup flow's SSH package is built"): what the host keeps
// of each SSH route, and the one device token each route has. It is one
// private file, `routes.json`, in the host's private data folder, written
// whole through a private sibling and renamed into place.
//
// A route's device token lives here and nowhere else: the core client keeps a
// routed connection's token under `deviceToken:route:<key>:…`, and the host's
// storage hands exactly those keys to this store (`routedStorage`). A token is
// kept only for a route the store has a record of, one per route; removing the
// route removes its token with it.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { ROUTE_KEY, type KeyValueStore } from "@clawtrate/core";

/** What identifies an SSH route and what Remove needs, never a forward's local port. */
export type SshRouteRecord = {
  kind: "ssh";
  /** The transport's route id: its alias and files carry it. */
  id: string;
  /** The key its device token is kept for (`ROUTE_KEY`): the pinned key, the endpoint, the port, the profile. */
  key: string;
  /** What the person typed, as it passed the destination pattern. */
  destination: string;
  /** The name typed, without the user: "devbox". */
  name: string;
  /** "you@devbox.example". */
  account: string;
  /** The resolved endpoint: "you@[devbox.example]:22". */
  endpoint: string;
  /** The pinned key's fingerprint when the route was made. */
  fingerprint: string;
  /** The gateway service the LOOK found: its profile, label, configuration path and port there. */
  profile: "default" | "clawtrate";
  serviceLabel: "LaunchAgent" | "systemd user" | "systemd" | "Scheduled Task";
  configPath: string;
  gatewayPort: number;
  /** The gateway's identity (`gateway.identity.get`), once read after a hello. */
  identity: string | null;
  /** Clawtrate started this gateway (Start over SSH): Remove may also stop it. */
  startedByClawtrate: boolean;
  /** When it was last connected, ms. */
  lastUsed: number;
};

type Stored = SshRouteRecord & {
  /** The route's one device token record, as the core wrote it, for one device and role. */
  token: { deviceId: string; role: string; value: string } | null;
};

type FileShape = { version: 1; routes: Stored[] };

/** Routes kept: this version connects through one at a time, and remembers a few. */
export const MAX_ROUTES = 8;

const TOKEN_KEY = /^deviceToken:route:((?:ssh|here)-[0-9a-f]{24}):([^:]{1,256}):([a-z]{1,32})$/;

/** Whether a storage key is a route's device token: the core's key for a routed connection. */
export const isRouteTokenKey = (key: string) => key.startsWith("deviceToken:route:");

export class RouteStore {
  readonly path: string;
  private cache: FileShape | null = null;

  constructor(dir: string) {
    this.path = join(dir, "routes.json");
  }

  private load(): FileShape {
    if (this.cache) return this.cache;
    let text: string | null = null;
    try {
      const info = lstatSync(this.path);
      // Only a plain file of this account's, small: anything else is not this store's.
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
        throw new Error("The route store is not a plain file.");
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new Error("The route store belongs to another account.");
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parsed = text === null ? null : (JSON.parse(text) as FileShape);
    this.cache =
      parsed && parsed.version === 1 && Array.isArray(parsed.routes)
        ? { version: 1, routes: parsed.routes.filter(validStored).slice(0, MAX_ROUTES) }
        : { version: 1, routes: [] };
    return this.cache;
  }

  private save(next: FileShape): void {
    const temp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const data = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, this.path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    this.cache = next;
  }

  /** Every route, without its token. */
  list(): SshRouteRecord[] {
    return this.load().routes.map(withoutToken);
  }

  get(id: string): SshRouteRecord | null {
    const found = this.load().routes.find((route) => route.id === id);
    return found ? withoutToken(found) : null;
  }

  byKey(key: string): SshRouteRecord | null {
    const found = this.load().routes.find((route) => route.key === key);
    return found ? withoutToken(found) : null;
  }

  /**
   * Keeps `record`, replacing the route with its id. A route whose key changed
   * (another key pinned, another port, another profile) loses its token: a
   * token is offered only on the route it was issued for.
   */
  put(record: SshRouteRecord): void {
    if (!validRecord(record)) throw new Error("Not a route record.");
    const data = this.load();
    const old = data.routes.find((route) => route.id === record.id);
    const others = data.routes.filter(
      (route) => route.id !== record.id && route.key !== record.key,
    );
    const token = old && old.key === record.key ? old.token : null;
    const routes = [...others, { ...record, token }];
    // The oldest go first when there are too many.
    routes.sort((a, b) => b.lastUsed - a.lastUsed);
    this.save({ version: 1, routes: routes.slice(0, MAX_ROUTES) });
  }

  /** Forgets the route and its token. */
  remove(id: string): void {
    const data = this.load();
    if (!data.routes.some((route) => route.id === id)) return;
    this.save({ version: 1, routes: data.routes.filter((route) => route.id !== id) });
  }

  getToken(key: string, deviceId: string, role: string): string | null {
    const route = this.load().routes.find((each) => each.key === key);
    const token = route?.token;
    return token && token.deviceId === deviceId && token.role === role ? token.value : null;
  }

  /** The route's one token; refused for a route the store has no record of. */
  setToken(key: string, deviceId: string, role: string, value: string): void {
    const data = this.load();
    const route = data.routes.find((each) => each.key === key);
    if (!route) throw new Error("There is no such route to keep a token for.");
    this.save({
      version: 1,
      routes: data.routes.map((each) =>
        each === route ? { ...each, token: { deviceId, role, value } } : each,
      ),
    });
  }

  deleteToken(key: string): void {
    const data = this.load();
    if (!data.routes.some((each) => each.key === key && each.token)) return;
    this.save({
      version: 1,
      routes: data.routes.map((each) => (each.key === key ? { ...each, token: null } : each)),
    });
  }
}

/** The host's storage: a route's device token goes to the route store, everything else to `base`. */
export function routedStorage(base: KeyValueStore, routes: RouteStore): KeyValueStore {
  const parse = (key: string) => {
    const match = TOKEN_KEY.exec(key);
    if (!match) throw new Error("Not a route's token key.");
    return { key: match[1]!, deviceId: match[2]!, role: match[3]! };
  };
  return {
    get: async (key) => {
      if (!isRouteTokenKey(key)) return base.get(key);
      const { key: route, deviceId, role } = parse(key);
      return routes.getToken(route, deviceId, role);
    },
    set: async (key, value) => {
      if (!isRouteTokenKey(key)) return base.set(key, value);
      const { key: route, deviceId, role } = parse(key);
      routes.setToken(route, deviceId, role, value);
    },
    delete: async (key) => {
      if (!isRouteTokenKey(key)) return base.delete(key);
      routes.deleteToken(parse(key).key);
    },
  };
}

function withoutToken(stored: Stored): SshRouteRecord {
  const { token: _token, ...record } = stored;
  return record;
}

const LABELS = ["LaunchAgent", "systemd user", "systemd", "Scheduled Task"];

function validRecord(value: SshRouteRecord): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    value.kind === "ssh" &&
    /^[a-z0-9]{1,32}$/.test(value.id) &&
    ROUTE_KEY.test(value.key) &&
    value.key.startsWith("ssh-") &&
    typeof value.destination === "string" &&
    value.destination.length <= 320 &&
    typeof value.name === "string" &&
    typeof value.account === "string" &&
    typeof value.endpoint === "string" &&
    /^SHA256:[A-Za-z0-9+/]{43}$/.test(value.fingerprint) &&
    (value.profile === "default" || value.profile === "clawtrate") &&
    LABELS.includes(value.serviceLabel) &&
    typeof value.configPath === "string" &&
    Number.isInteger(value.gatewayPort) &&
    value.gatewayPort >= 1024 &&
    value.gatewayPort <= 65535 &&
    (value.identity === null || typeof value.identity === "string") &&
    typeof value.startedByClawtrate === "boolean" &&
    typeof value.lastUsed === "number"
  );
}

function validStored(value: Stored): boolean {
  const token = value?.token;
  return (
    validRecord(value) &&
    (token === null ||
      (typeof token === "object" &&
        typeof token.deviceId === "string" &&
        typeof token.role === "string" &&
        typeof token.value === "string"))
  );
}
