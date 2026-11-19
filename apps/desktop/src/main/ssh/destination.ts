// What a person may type as an SSH destination, and the values the host writes
// into its own configuration (docs/design/setup.md, section 19, "Validated
// arguments"). Nothing here starts a program.

/** `user@host` or `host`: the user never starts with `-`; the host never with `-` or `.`. */
export const DESTINATION =
  /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** A route's own id; the route's alias is `clawtrate-route-<id>`. */
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

export const routeAlias = (id: string) => `clawtrate-route-${id}`;

/** The account as shown before consent: "you@devbox.example". */
export const accountText = (user: string, hostName: string) => `${user}@${hostName}`;
