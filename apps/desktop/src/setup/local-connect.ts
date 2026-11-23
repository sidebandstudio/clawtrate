// Local connect's sockets (docs/design/setup-effortless.md §3, "The send
// gate", with TLS off). The host dials OpenClaw's loopback port itself, proves
// the far end of that very socket (local-prove.ts) before undici writes the
// WebSocket upgrade, and hands that same socket to the WebSocket; `verify`
// proves it again just before the frame that carries a credential. Every
// WebSocket gets an agent and a socket of its own, so a retry or a reconnect
// is dialled and proved afresh, and a socket that isn't proved carries no byte.
//
// No shipped host turns this on yet: `SetupControllerOptions.localConnect` is
// off in every one of them.

import { connect as dial, type Socket } from "node:net";
import type { WebSocketLike } from "@clawtrate/core";
import { Agent, WebSocket } from "undici";
import { proveLocalGateway, type ProveRefusal } from "./local-prove.ts";
import { mustSandbox } from "./world.ts";

/** What local connect needs from its host: where to look, the helper, and the home rule. */
export type LocalConnect = {
  /** The home the settings reader reads: the account's own, or a sandbox's. */
  home: string;
  helper: string | null;
  platform: NodeJS.Platform;
  /** `mustSandbox(…)` for this run: the reader's and the proof's home rule. */
  sandboxed: boolean;
};

/** The host's options for local connect, its home rule from `mustSandbox`. */
export function localConnectFor(
  run: Parameters<typeof mustSandbox>[0],
  where: Omit<LocalConnect, "sandboxed">,
): LocalConnect {
  return { ...where, sandboxed: mustSandbox(run) };
}

/** Proves the far end of the host's connection from this local port; false sends nothing. */
export type ProveSocket = (localPort: number) => Promise<boolean>;

/** The proof of one profile's gateway at `port`, its refusals told to `refused` in fixed words. */
export function proveFor(
  local: LocalConnect,
  folder: string,
  port: number,
  refused: (why: ProveRefusal) => void = () => {},
): ProveSocket {
  return async (localPort) => {
    const proof = await proveLocalGateway({ ...local, folder, port, localPort });
    if (!proof.proved) refused(proof.why);
    return proof.proved;
  };
}

export type ProvedSockets = {
  /** A WebSocket to `ws://127.0.0.1:<port>` alone, on a socket proved before any byte goes. */
  createWebSocket: (url: string) => WebSocketLike;
  /** The latest socket, proved again; false once it is closed or replaced. */
  verify: (signal: AbortSignal) => Promise<boolean>;
};

export function provedSockets(port: number, prove: ProveSocket): ProvedSockets {
  let latest: Socket | null = null;
  const connect = (
    options: { hostname: string; port: string; protocol: string },
    callback: (...args: [null, Socket] | [Error, null]) => void,
  ) => {
    // Only the endpoint this was made for: no other host, port or scheme is ever dialled.
    if (
      options.hostname !== "127.0.0.1" ||
      Number(options.port) !== port ||
      options.protocol !== "http:"
    ) {
      callback(new Error("This connection may only go to OpenClaw on this computer."), null);
      return;
    }
    const socket = dial({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (proved: boolean) => {
      if (settled) return;
      settled = true;
      if (proved && !socket.destroyed) {
        latest = socket;
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
      latest = null;
      const agent = new Agent({ connections: 1, connect });
      const socket = new WebSocket(url, { dispatcher: agent });
      socket.addEventListener("close", () => void agent.destroy().catch(() => {}));
      return socket as unknown as WebSocketLike;
    },
    async verify(signal) {
      const socket = latest;
      if (!socket || socket.destroyed || signal.aborted) return false;
      const proved = await prove(socket.localPort!).catch(() => false);
      return proved && !signal.aborted && latest === socket && !socket.destroyed;
    },
  };
}
