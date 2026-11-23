// Two clients sharing one secure store: the store can change the saved record by itself, as
// when a device token retires an earlier build's gateway token, and neither client writes back
// what it held before that change.

import { ClawtrateClient } from "@clawtrate/core";
import { createSecureCredentials, STATE_FILE, type SecretBox } from "@clawtrate/core/node";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeGateway,
  helloOk,
  sleep,
  testHost,
  until,
} from "../../../packages/core/test/fake-gateway.ts";

const URL_A = "ws://127.0.0.1:19001";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const flip = (bytes: Uint8Array) => Uint8Array.from(bytes, (byte) => byte ^ 0x5a);
const box: SecretBox = {
  available: async () => true,
  encrypt: async (text) => flip(new TextEncoder().encode(text)),
  decrypt: async (data) => new TextDecoder().decode(flip(data)),
};

describe("clients sharing a secure store", () => {
  it("suspending after another client's pairing retired the earlier build's gateway token leaves it retired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-secure-shared-"));
    dirs.push(dir);
    // As an earlier build left it: the gateway saved with its bootstrap token.
    writeFileSync(
      join(dir, STATE_FILE),
      JSON.stringify({ connection: JSON.stringify({ url: URL_A, token: "legacy-bootstrap" }) }),
    );
    const credentials = createSecureCredentials({ dataDir: dir, box });
    const host = (gateway: FakeGateway) => ({
      ...testHost(gateway),
      storage: credentials.storage,
      signer: credentials.signer,
      secureCredentials: credentials.secure,
    });
    const record = async () =>
      JSON.parse((await credentials.storage.get("connection")) ?? "null") as unknown;
    const closed = new FakeGateway();
    closed.refuseConnections = true;
    const pairing = new FakeGateway();
    pairing.connectReply = (params) => ({
      ok: true,
      payload: helloOk((params as { scopes: string[] }).scopes, "issued-A"),
    });
    const client = new ClawtrateClient(host(closed), FAST);
    const other = new ClawtrateClient(host(pairing), FAST);
    try {
      await client.start();
      expect(await record()).toEqual({ url: URL_A, token: "legacy-bootstrap" });
      // The other client pairs: saving its device token retires the earlier token in the store.
      await other.start();
      await until(() => other.state.connection.status === "connected");
      await sleep(30);
      expect(await record()).toEqual({ url: URL_A, token: null });
      await client.suspend();
      expect(await record()).toEqual({ url: URL_A, token: null, suspended: true });
    } finally {
      other.stop();
      client.stop();
    }
  });
});
