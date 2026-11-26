// The session request: the device builds it, the service checks it against what it issued.

import { describe, expect, it, vi } from "vitest";
import {
  SESSION_SKEW_MS,
  SessionSecretKey,
  signSessionRequest,
  verifySessionRequest,
} from "../src/index.ts";
import { expectCode, fill } from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const key = SessionSecretKey.fromSeed(fill(32, 0x5e));
const fields = {
  audience: "https://accounts.clawtrate.dev",
  challenge: fill(32, 0x66),
  method: "POST",
  path: "/v1/devices",
  body: new TextEncoder().encode("{}"),
} as const;
const NOW = 1_795_000_000_000;
const request = signSessionRequest(key, { ...fields, issuedAtMs: NOW });

describe("a session request", () => {
  it("names the key that signed it", () => {
    expect(verifySessionRequest(request, { ...fields, nowMs: NOW }).equals(key.publicKey)).toBe(
      true,
    );
  });

  it("answers one challenge, one service and one request", () => {
    expectCode(
      () => verifySessionRequest(request, { ...fields, challenge: fill(32, 0x67), nowMs: NOW }),
      "bad_challenge",
    );
    expectCode(
      () =>
        verifySessionRequest(request, { ...fields, audience: "https://other.example", nowMs: NOW }),
      "bad_challenge",
    );
    expectCode(
      () => verifySessionRequest(request, { ...fields, method: "DELETE", nowMs: NOW }),
      "bad_challenge",
    );
    expectCode(
      () => verifySessionRequest(request, { ...fields, path: "/v1/link", nowMs: NOW }),
      "bad_challenge",
    );
    expectCode(
      () => verifySessionRequest(request, { ...fields, body: new Uint8Array(0), nowMs: NOW }),
      "bad_challenge",
    );
  });

  it(`is good for ${SESSION_SKEW_MS / 1000} seconds either side of the service's clock`, () => {
    for (const skew of [-SESSION_SKEW_MS, 0, SESSION_SKEW_MS]) {
      expect(() => verifySessionRequest(request, { ...fields, nowMs: NOW + skew })).not.toThrow();
    }
    expectCode(
      () => verifySessionRequest(request, { ...fields, nowMs: NOW + SESSION_SKEW_MS + 1 }),
      "bad_time",
    );
    expectCode(
      () => verifySessionRequest(request, { ...fields, nowMs: NOW - SESSION_SKEW_MS - 1 }),
      "bad_time",
    );
    expectCode(() => verifySessionRequest(request, { ...fields, nowMs: NOW + 0.5 }), "bad_time");
    expectCode(() => signSessionRequest(key, { ...fields, issuedAtMs: -1 }), "bad_time");
  });

  it("takes only an origin as its audience and a path as its path", () => {
    for (const audience of [
      "https://a.dev:8443",
      "http://127.0.0.1:8787",
      "http://localhost",
      "http://[::1]:1",
    ]) {
      expect(() => signSessionRequest(key, { ...fields, audience, issuedAtMs: NOW })).not.toThrow();
    }
    for (const audience of [
      "http://accounts.clawtrate.dev",
      "https://accounts.clawtrate.dev:08",
      "accounts.clawtrate.dev",
      "https://accounts.clawtrate.dev/",
      "https://A.dev",
      "https://a b",
    ]) {
      expectCode(
        () => signSessionRequest(key, { ...fields, audience, issuedAtMs: NOW }),
        "malformed",
      );
    }
    for (const path of ["v1", "/v1 x", "/v1\n", ""]) {
      expectCode(() => signSessionRequest(key, { ...fields, path, issuedAtMs: NOW }), "malformed");
    }
    expectCode(
      () =>
        signSessionRequest(key, {
          ...fields,
          body: new Uint8Array(1024 * 1024 + 1),
          issuedAtMs: NOW,
        }),
      "too_large",
    );
  });
});
