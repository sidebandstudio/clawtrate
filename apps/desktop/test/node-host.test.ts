// The Node host's sockets: a route channel's address goes only over the
// host's own private socket, never over the built-in WebSocket.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { WebSocketLike } from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";

const CHANNEL = "ws://c0123456789abcdef.ssh.invalid";
const client = { displayName: "Clawtrate Test", version: "0.0.0", platform: "test" };

describe("the Node host's sockets", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const dataDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-node-host-"));
    dirs.push(dir);
    return dir;
  };

  it("refuses a route channel's address without the host's private socket for it, and gives it that socket when there is one", () => {
    expect(() => createNodeHost({ dataDir: dataDir(), client }).createWebSocket(CHANNEL)).toThrow(
      /private socket/,
    );
    const none = createNodeHost({ dataDir: dataDir(), client, routeSocket: () => null });
    expect(() => none.createWebSocket(CHANNEL)).toThrow(/private socket/);
    const own = { readyState: 0 } as unknown as WebSocketLike;
    const routed = createNodeHost({
      dataDir: dataDir(),
      client,
      routeSocket: (url) => (url === CHANNEL ? own : null),
    });
    expect(routed.createWebSocket(CHANNEL)).toBe(own);
  });
});
