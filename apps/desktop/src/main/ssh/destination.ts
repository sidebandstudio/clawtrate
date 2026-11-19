// What a person may type as an SSH destination, and the values the host writes
// into its own configuration (docs/design/setup.md, section 19, "Validated
// arguments"). Nothing here starts a program.

import { createHash } from "node:crypto";

/** `user@host` or `host`: the user never starts with `-`; the host never with `-` or `.`. */
export const DESTINATION =
  /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** A route's own id; the route's alias is `clawtrate-route-<id>-<endpoint tag>`. */
const ROUTE_ID = /^[a-z0-9]{1,32}$/;

export type Destination = {
  /** Exactly what was typed, once it passed the pattern. */
  typed: string;
  user: string | null;
  /** The host or alias part, looked up in the person's configuration. */
  host: string;
};

export function parseDestination(raw: unknown): Destination | null {
  if (typeof raw !== "string" || !DESTINATION.test(raw)) return null;
  const at = raw.indexOf("@");
  return at === -1
    ? { typed: raw, user: null, host: raw }
    : { typed: raw, user: raw.slice(0, at), host: raw.slice(at + 1) };
}

export const isHost = (value: string) => HOST.test(value);
export const isUser = (value: string) => USER.test(value);
export const isRouteId = (value: unknown): value is string =>
  typeof value === "string" && ROUTE_ID.test(value);

export function parsePort(value: string): number | null {
  if (!/^[0-9]{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/** A gateway port on the other computer: an integer from 1024 to 65535. */
export const isGatewayPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;

/** The resolved endpoint a route names: account, host and port, as "you@[devbox.example]:22". */
export const endpointText = (user: string, hostName: string, port: number) =>
  `${user}@[${hostName}]:${port}`;

/** Twelve hex digits of the endpoint's SHA-256: one alias, one set of files, one pin per endpoint. */
export const endpointTag = (endpoint: string) =>
  createHash("sha256").update(endpoint).digest("hex").slice(0, 12);

export const routeAlias = (id: string, endpoint: string) =>
  `clawtrate-route-${id}-${endpointTag(endpoint)}`;

export const ROUTE_ALIAS = /^clawtrate-route-[a-z0-9]{1,32}-[0-9a-f]{12}$/;
export const ENDPOINT =
  /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@\[[A-Za-z0-9][A-Za-z0-9.-]{0,252}\]:[0-9]{1,5}$/;

/** The account as shown before consent: "you@devbox.example". */
export const accountText = (user: string, hostName: string) => `${user}@${hostName}`;
