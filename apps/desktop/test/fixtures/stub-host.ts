// A web host with a stub client, run as a child process so a test can see
// whether hostile requests crash it. Prints its port once listening.

import { createStore, initialState, type ClawtrateClient } from "@clawtrate/core";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { HostRuntime } from "../../src/host/runtime.ts";
import { startWebHost } from "../../src/web-host/server.ts";

// The test makes the folder and removes it: a host it stops leaves nothing behind.
const staticDir = process.env.STUB_STATIC_DIR!;
writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Clawtrate</title>");
const store = createStore(initialState);
const runtime: HostRuntime = {
  client: {
    store,
    get state() {
      return store.get();
    },
    // Viewers may open and close tasks; the stub keeps nothing for them.
    openSession: () => {},
    closeSession: () => {},
    withdraw: () => {},
  } as unknown as ClawtrateClient,
  info: { kind: "web", version: "test", devGateway: null },
  policy: {},
};
const host = startWebHost({
  runtime,
  staticDir,
  host: "127.0.0.1",
  port: 0,
  accessToken: process.env.STUB_ACCESS_TOKEN ?? "stub-token",
});
host.server.once("listening", () => {
  console.log(`PORT ${(host.server.address() as AddressInfo).port}`);
});
process.on("SIGTERM", () => void host.close().then(() => process.exit(0)));
