// Local connect's sockets (docs/design/setup-effortless.md §3, "The send
// gate", with TLS off). The host dials OpenClaw's loopback port itself, proves
// the far end of that very socket (local-prove.ts) before undici writes the
// WebSocket upgrade, and hands that same socket to the WebSocket; `verify`
// proves it again just before the frame that carries a credential. Every
// WebSocket gets an agent and a socket of its own, so a retry or a reconnect
// is dialled and proved afresh, and a socket that isn't proved carries no byte.
// A gateway set up this way is saved with its profile folder as its route, and
// `provedRouteFor` gives the client its sockets after setup, and after a
// restart, the same way.
//
// No shipped host turns it on yet. When one does, a person's packaged app gets
// the account's own home; every other run has no default home
// (`localConnectFor`).

import { connect as dial, type Socket } from "node:net";
import { PROOF_REFUSAL_LINES, type ProvedRoute, type WebSocketLike } from "@clawtrate/core";
import { Agent, WebSocket } from "undici";
import { proveLocalGateway, refusalKind, type ProveRefusal } from "./local-prove.ts";
import {
  accountHome,
  CLAWTRATE_PROFILE_DEFAULT_PORT,
  mustSandbox,
  OPENCLAW_DEFAULT_PORT,
  personsLaunch,
} from "./world.ts";

/** What local connect needs from its host: where to look, the helper, and the home rule. */
export type LocalConnect = {
  /** The home the settings reader reads: the account's own, or a sandbox's. */
  home: string;
  helper: string | null;
  platform: NodeJS.Platform;
  /** `mustSandbox(…)` for this run: the reader's and the proof's home rule. */
  sandboxed: boolean;
  /** The helper's and the parse worker's deadline: `READ_DEADLINE_MS` unless a test lengthens it. */
  deadlineMs?: number;
};

/**
 * The host's options for local connect, its home rule from `mustSandbox`, or
 * null when it is off. A person's packaged app looks in the account's own
 * home, as the system reports it, and nowhere else. Any other run (a
 * development build, a test, an automated launch) has no default home: only
 * one the run names itself, which the reader and the proof then take only as
 * a private folder below the system's temporary root (`guardHome`).
 */
export function localConnectFor(
  run: Parameters<typeof mustSandbox>[0],
  where: { home?: string | null; helper: string | null; platform: NodeJS.Platform },
  accountHomeOf: () => string | null = accountHome,
): LocalConnect | null {
  const sandboxed = mustSandbox(run);
  const home = sandboxed ? where.home : accountHomeOf();
  if (!home || (!sandboxed && where.home != null && where.home !== home)) return null;
  return { home, helper: where.helper, platform: where.platform, sandboxed };
}

/**
 * Whether local connect may dial this port. Outside a person's packaged app it never dials
 * one of OpenClaw's default ports, which a settings file that names none falls back to: on a
 * computer that runs OpenClaw, that is the person's own gateway (as `guardPort` keeps a
 * sandboxed look away from it). A sandbox's gateway is on a port of its own, named in its file.
 * "A person's packaged app" is this process's own launch (`personsLaunch`), the home rule's
 * classification, and the caller's `sandboxed` as well: either one refuses the defaults.
 */
export function localPortAllowed(
  local: LocalConnect,
  port: number,
  launch: () => boolean = personsLaunch,
): boolean {
  const defaults = port === OPENCLAW_DEFAULT_PORT || port === CLAWTRATE_PROFILE_DEFAULT_PORT;
  return (
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    !(defaults && (local.sandboxed || !launch()))
  );
}

/** Proves the far end of the host's connection from this local port; false sends nothing. */
export type ProveSocket = (localPort: number) => Promise<boolean>;

/** How long the proof waits before asking once more, after finding no holder of this account's. */
export const HOLDER_RETRY_MS = 750;

/**
 * The proof of one profile's gateway at `port`, its refusals told to `refused` in fixed words.
 * A gateway under load may not have taken the connection into its table within the helper's
 * own wait, so finding no holder is asked once more, after a short wait, before it refuses.
 */
export function proveFor(
  local: LocalConnect,
  folder: string,
  port: number,
  refused: (why: ProveRefusal) => void = () => {},
): ProveSocket {
  return async (localPort) => {
    const ask = () => proveLocalGateway({ ...local, folder, port, localPort });
    let proof = await ask();
    if (!proof.proved && proof.why === "holder") {
      await new Promise((done) => setTimeout(done, HOLDER_RETRY_MS));
      proof = await ask();
    }
    if (!proof.proved) refused(proof.why);
    return proof.proved;
  };
}

/**
 * The client's sockets for a gateway saved with a local connect route
 * (`ClientOptions.localConnect`): only `ws://127.0.0.1:<port>`, proved as the
 * profile folder `route` in the home local connect names. Anything else is null,
 * and the client opens nothing for it.
 */
export function provedRouteFor(
  local: LocalConnect,
  refused: (why: ProveRefusal) => void = () => {},
): (url: string, route: string) => ProvedRoute | null {
  return (url, route) => {
    const port = Number(/^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(url)?.[1]);
    if (!localPortAllowed(local, port)) return null;
    // The latest refusal since a proof last passed, for the client's words (`ProvedRoute.refusal`).
    let latest: ProveRefusal | null = null;
    const prove = proveFor(local, route, port, (why) => {
      latest = why;
      refused(why);
    });
    const sockets = provedSockets(port, async (localPort) => {
      const proved = await prove(localPort);
      if (proved) latest = null;
      return proved;
    });
    return {
      createSocket: sockets.createWebSocket,
      verify: sockets.verify,
      refusal: () => (latest === null ? null : PROOF_REFUSAL_LINES[refusalKind(latest)](port)),
    };
  };
}

export type ProvedSockets = {
  /** A WebSocket to `ws://127.0.0.1:<port>` alone, on a socket proved before any byte goes. */
  createWebSocket: (url: string) => WebSocketLike;
  /**
   * The socket the latest WebSocket carries, proved again; false once it is
   * closed, or that WebSocket is replaced.
   */
  verify: (signal: AbortSignal) => Promise<boolean>;
};

/**
 * A close code this WebSocket sends: 1000, or one of 3000 to 4999. undici's
 * spec WebSocket throws on any other, before it closes or fires `close`, and
 * the protocol client closes with 1008 (a challenge that never came, a connect
 * that failed); such a code goes as 4000 + its last three digits, so the
 * socket still closes and its `close` still starts the client's recovery.
 */
export function sendableCloseCode(code: number | undefined): number | undefined {
  if (code === undefined || code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return 4000 + (Math.abs(Math.trunc(code)) % 1000);
}

/** One WebSocket's socket: dialled once, and set only once its proof passed. */
type Slot = { dialled: boolean; socket: Socket | null };

export function provedSockets(port: number, prove: ProveSocket): ProvedSockets {
  let current: Slot | null = null;
  const connectFor =
    (slot: Slot) =>
    (
      options: { hostname: string; port: string; protocol: string },
      callback: (...args: [null, Socket] | [Error, null]) => void,
    ) => {
      // Only the endpoint this was made for, one socket per WebSocket, and only for the
      // latest one: no other host, port or scheme is ever dialled.
      if (
        options.hostname !== "127.0.0.1" ||
        Number(options.port) !== port ||
        options.protocol !== "http:" ||
        slot.dialled ||
        current !== slot
      ) {
        callback(new Error("This connection may only go to OpenClaw on this computer."), null);
        return;
      }
      slot.dialled = true;
      const socket = dial({ host: "127.0.0.1", port });
      let settled = false;
      const settle = (proved: boolean) => {
        if (settled) return;
        settled = true;
        // A proof that finishes after its WebSocket was replaced hands nothing over.
        if (proved && !socket.destroyed && current === slot) {
          slot.socket = socket;
          callback(null, socket);
          return;
        }
        socket.destroy();
        callback(new Error("Clawtrate couldn't verify what is listening at this port."), null);
      };
      socket.once("error", () => settle(false));
      socket.once("close", () => settle(false));
      socket.once("connect", () => {
        prove(socket.localPort!).then(settle, () => settle(false));
      });
    };
  return {
    createWebSocket(url) {
      if (url !== `ws://127.0.0.1:${port}`)
        throw new Error("This connection may only go to OpenClaw on this computer.");
      const slot: Slot = { dialled: false, socket: null };
      current = slot;
      const agent = new Agent({ connections: 1, connect: connectFor(slot) });
      const socket = new WebSocket(url, { dispatcher: agent });
      socket.addEventListener("close", () => void agent.destroy().catch(() => {}));
      const close = socket.close.bind(socket);
      socket.close = (code?: number, reason?: string) => close(sendableCloseCode(code), reason);
      return socket as unknown as WebSocketLike;
    },
    async verify(signal) {
      const slot = current;
      const socket = slot?.socket;
      if (!slot || !socket || socket.destroyed || signal.aborted) return false;
      const proved = await prove(socket.localPort!).catch(() => false);
      return (
        proved && !signal.aborted && current === slot && slot.socket === socket && !socket.destroyed
      );
    },
  };
}
