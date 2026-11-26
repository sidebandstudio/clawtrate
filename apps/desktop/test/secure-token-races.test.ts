// A full pairing's token in secure storage keeps both guarantees at once: a late hello never
// replaces a newer token (#303), and the sealed record keeps the exact grant (full access).

import { ClawtrateClient, FULL_SCOPES, INTERACTIVE_SCOPES } from "@clawtrate/core";
import { createSecureCredentials, type SecretBox } from "@clawtrate/core/node";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deferred,
  FakeGateway,
  helloOk,
  testHost,
  tokenKey,
  until,
} from "../../../packages/core/test/fake-gateway.ts";

const URL_A = "wss://gateway.example:19001";
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

describe("a full pairing's token in secure storage", () => {
  it("an older hello finishing after a newer token was sealed doesn't replace it, and the record keeps the newer exact grant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-secure-race-"));
    dirs.push(dir);
    const credentials = createSecureCredentials({ dataDir: dir, box });
    const storage = credentials.storage;
    await storage.set("connection", JSON.stringify({ url: URL_A, token: null }));
    await storage.set(
      tokenKey(URL_A),
      JSON.stringify({
        token: "token-A",
        grantedScopes: FULL_SCOPES,
        heldScopes: FULL_SCOPES,
        fullGrant: true,
      }),
    );
    const host = (gateway: FakeGateway) => ({
      ...testHost(gateway),
      storage,
      secureCredentials: credentials.secure,
    });
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as { scopes: string[] }).scopes], "token-A"),
    });
    const client = new ClawtrateClient(host(gateway), FAST);
    await client.start();
    await until(() => client.state.connection.status === "connected");

    // The next hello on this client carries an older token, and its save waits on a held read.
    const held = deferred<void>();
    let holdNext = false;
    let waiting = false;
    const get = storage.get;
    storage.get = async (key) => {
      if (holdNext && key === tokenKey(URL_A)) {
        holdNext = false;
        waiting = true;
        await held.promise;
      }
      return get(key);
    };
    const otherGateway = new FakeGateway();
    const other = new ClawtrateClient(host(otherGateway), FAST);
    try {
      gateway.connectReply = () => {
        holdNext = true;
        return { ok: true, payload: helloOk([...FULL_SCOPES], "older-token") };
      };
      // A newer connection on the same store: a new token, and a narrower grant than before.
      otherGateway.connectReply = () => ({
        ok: true,
        payload: helloOk([...INTERACTIVE_SCOPES], "newer-token"),
      });
      gateway.dropAll();
      await until(() => waiting);
      await other.start();
      await until(() => other.state.connection.status === "connected");
      held.resolve();
      await until(() => client.state.connection.status === "connected");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // Read back through a fresh open: the sealed record, decrypted.
      const reopened = createSecureCredentials({ dataDir: dir, box });
      const record = JSON.parse((await reopened.storage.get(tokenKey(URL_A)))!) as {
        token: string;
        heldScopes: string[];
        fullGrant?: boolean;
      };
      expect(record).toMatchObject({
        token: "newer-token",
        heldScopes: [...INTERACTIVE_SCOPES],
        fullGrant: true,
      });
      // And nothing of either token in the files.
      for (const name of readdirSync(dir))
        for (const token of ["older-token", "newer-token"])
          expect(readFileSync(join(dir, name), "latin1"), name).not.toContain(token);
    } finally {
      held.resolve();
      other.stop();
      client.stop();
    }
  });
});
