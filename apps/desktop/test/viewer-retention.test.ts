// What a viewer's socket buffers is part of what the host keeps (ruling 1):
// it is counted in the host's ledger, snapshots wait while the host is at its
// budget, and a new viewer is refused when its first snapshot would not fit.

import { createStore, HostLedger, initialState, type ClawtrateClient } from "@clawtrate/core";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createViewerChannel, startWebHost } from "../src/web-host/server.ts";

function fakeSocket() {
  const sent: string[] = [];
  return {
    sent,
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send(data: string) {
      sent.push(data);
    },
    close() {},
  };
}

describe("viewer buffers in the host ledger", () => {
  it("are counted while the viewer is open and no longer after it stops", () => {
    const ledger = new HostLedger(1_000);
    const socket = fakeSocket();
    const channel = createViewerChannel(socket, ledger);
    socket.bufferedAmount = 400;
    expect(ledger.usage().viewer).toBe(400);
    channel.stop();
    expect(ledger.usage().viewer).toBeUndefined();
  });

  it("hold snapshots back while the host is over its budget, and send the latest once it is not", async () => {
    const ledger = new HostLedger(1_000);
    let other = 1_001;
    ledger.track("other", () => other);
    const socket = fakeSocket();
    const channel = createViewerChannel(socket, ledger);
    channel.sendState(initialState);
    expect(socket.sent).toEqual([]);
    other = 0;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(socket.sent).toHaveLength(1);
    channel.stop();
  });
});

describe("a new viewer when the host is full", () => {
  it("is refused with 1013 rather than given a snapshot the host has no room for", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "clawtrate-static-"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Clawtrate</title>");
    const store = createStore(initialState);
    const ledger = new HostLedger(10_000);
    let other = 0;
    ledger.track("other", () => other);
    const host = startWebHost({
      runtime: {
        client: {
          store,
          get state() {
            return store.get();
          },
          ledger,
          withdraw: () => {},
        } as unknown as ClawtrateClient,
        info: { kind: "web", version: "test", devGateway: null },
        policy: {},
      },
      staticDir,
      host: "127.0.0.1",
      port: 0,
      accessToken: "token",
    });
    await once(host.server, "listening");
    const port = (host.server.address() as AddressInfo).port;
    const connect = () =>
      new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
        headers: { cookie: "clawtrate_access=token", origin: `http://127.0.0.1:${port}` },
      });
    try {
      const admitted = connect();
      await once(admitted, "message");
      admitted.close();
      other = 10_000;
      const refused = connect();
      const [code] = (await once(refused, "close")) as [number];
      expect(code).toBe(1013);
    } finally {
      await host.close();
    }
  });
});
