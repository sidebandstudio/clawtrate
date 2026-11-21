// The relay pairing code: valid codes, every malformed field, oversize and expired codes.

import { describe, expect, it } from "vitest";
import { toBase64Url, utf8Encode } from "@clawtrate/relay-protocol";
import {
  encodeRelayCode,
  encodeSetupCode,
  MAX_RELAY_CODE_CHARS,
  MAX_RELAY_CODE_LIFETIME_MS,
  parseRelayCode,
  RelayCodeError,
  type RelayCodeErrorCode,
} from "../src/relay/code.ts";
import { relayDialUrl, relayRouteKey, type RelayRoute } from "../src/relay/route.ts";
import { RELAY_ID, RELAY_ORIGIN } from "./relay-harness.ts";

const NOW = 1_794_921_000_000;
const KEY = new Uint8Array(32).map((_, index) => index + 1);
const SECRET = new Uint8Array(32).fill(9);
const ROUTE: RelayRoute = {
  kind: "relay",
  relayOrigin: RELAY_ORIGIN,
  relayId: RELAY_ID,
  connectorKey: toBase64Url(KEY),
};
const SETUP = {
  url: relayDialUrl(ROUTE),
  bootstrapToken: "boot-Strap_token.1",
  expiresAtMs: NOW + 600_000,
};

/** The code's JSON with some members changed (undefined removes one). */
function codeWith(changes: Record<string, unknown> = {}, setup: Record<string, unknown> = {}) {
  const fields: Record<string, unknown> = {
    v: 1,
    relay: RELAY_ORIGIN,
    relayId: RELAY_ID,
    connectorKey: toBase64Url(KEY),
    enroll: toBase64Url(SECRET),
    expiresAtMs: NOW + 600_000,
    openclaw: encodeSetupCode({ ...SETUP, ...setup } as typeof SETUP),
    ...changes,
  };
  for (const [name, value] of Object.entries(fields)) if (value === undefined) delete fields[name];
  return toBase64Url(utf8Encode(JSON.stringify(fields)));
}

function setupWith(changes: Record<string, unknown>): string {
  const fields: Record<string, unknown> = { ...SETUP, ...changes };
  for (const [name, value] of Object.entries(fields)) if (value === undefined) delete fields[name];
  return toBase64Url(utf8Encode(JSON.stringify(fields)));
}

function refusal(text: string, now = NOW): RelayCodeErrorCode {
  try {
    parseRelayCode(text, now);
  } catch (error) {
    expect(error).toBeInstanceOf(RelayCodeError);
    return (error as RelayCodeError).code;
  }
  throw new Error("accepted");
}

describe("relay codes", () => {
  it("reads a valid code, with whitespace around it", () => {
    const code = parseRelayCode(`\n  ${codeWith()}\n`, NOW);
    expect(code.route).toEqual(ROUTE);
    expect(code.enroll).toEqual(SECRET);
    expect(code.bootstrapToken).toBe("boot-Strap_token.1");
    expect(code.expiresAtMs).toBe(NOW + 600_000);
    expect(relayRouteKey(code.route)).toBe(`relay:${toBase64Url(KEY)}`);
  });

  it("encodeRelayCode makes what parseRelayCode reads", () => {
    const text = encodeRelayCode({
      route: ROUTE,
      enroll: SECRET,
      expiresAtMs: NOW + 60_000,
      setupCode: encodeSetupCode(SETUP),
    });
    expect(parseRelayCode(text, NOW).expiresAtMs).toBe(NOW + 60_000);
  });

  it("the code expires with the earlier of its two expiries", () => {
    expect(parseRelayCode(codeWith({}, { expiresAtMs: NOW + 5 }), NOW).expiresAtMs).toBe(NOW + 5);
    expect(refusal(codeWith({ expiresAtMs: NOW + 5 }), NOW + 5)).toBe("expired");
    expect(refusal(codeWith({}, { expiresAtMs: NOW + 5 }), NOW + 5)).toBe("expired");
    expect(refusal(codeWith(), NOW + 600_000)).toBe("expired");
  });

  it("refuses an expiry further ahead than a code lasts", () => {
    const far = NOW + MAX_RELAY_CODE_LIFETIME_MS + 1;
    expect(refusal(codeWith({ expiresAtMs: far }))).toBe("bad_expiry");
    expect(refusal(codeWith({}, { expiresAtMs: far }))).toBe("bad_expiry");
  });

  it("refuses text longer than a code, before decoding it", () => {
    expect(refusal("A".repeat(MAX_RELAY_CODE_CHARS + 1))).toBe("too_large");
    expect(refusal(" ".repeat(MAX_RELAY_CODE_CHARS * 2 + 1))).toBe("too_large");
    expect(refusal(codeWith({}, { bootstrapToken: "t".repeat(2000) }))).toBe("too_large");
  });

  it.each([
    ["not base64url", "not a code!"],
    ["padding", `${codeWith()}=`],
    ["a standard base64 character", `${codeWith().slice(0, -1)}+`],
    ["not JSON", toBase64Url(utf8Encode("v=1"))],
    ["an array", toBase64Url(utf8Encode("[1]"))],
    ["invalid UTF-8", toBase64Url(Uint8Array.of(0x7b, 0xff, 0x7d))],
    ["an OpenClaw setup code alone", encodeSetupCode(SETUP)],
    [
      "a repeated member",
      toBase64Url(
        utf8Encode(
          JSON.stringify({ v: 1 }).replace("}", ',"\\u0076":1}') /* "v" twice, once escaped */,
        ),
      ),
    ],
  ])("refuses %s", (_label, text) => {
    expect(refusal(text)).toBe("malformed");
  });

  it.each<[string, Record<string, unknown>]>([
    ["another version", { v: 2 }],
    ["a version as text", { v: "1" }],
    ["a missing relay", { relay: undefined }],
    ["an extra field", { extra: true }],
    ["a ws: relay", { relay: "ws://relay.example.test" }],
    ["a relay with a path", { relay: "wss://relay.example.test/v1" }],
    ["a relay with credentials", { relay: "wss://me@relay.example.test" }],
    ["a relay in capitals", { relay: "wss://Relay.example.test" }],
    ["a relay with the default port", { relay: "wss://relay.example.test:443" }],
    ["a relay with a final slash", { relay: `${RELAY_ORIGIN}/` }],
    ["an uppercase relay id", { relayId: RELAY_ID.toUpperCase() }],
    ["a short relay id", { relayId: RELAY_ID.slice(1) }],
    ["a short connector key", { connectorKey: toBase64Url(KEY.subarray(1)) }],
    ["an all-zero connector key", { connectorKey: toBase64Url(new Uint8Array(32)) }],
    ["a connector key as a number", { connectorKey: 7 }],
    ["a non-canonical connector key", { connectorKey: `${toBase64Url(KEY).slice(0, 42)}B` }],
    ["a short enrollment secret", { enroll: toBase64Url(SECRET.subarray(1)) }],
    ["a missing enrollment secret", { enroll: undefined }],
    ["a non-canonical enrollment secret", { enroll: `${toBase64Url(SECRET).slice(0, 42)}R` }],
    ["a fractional expiry", { expiresAtMs: NOW + 0.5 }],
    ["a negative expiry", { expiresAtMs: -1 }],
    ["an expiry as text", { expiresAtMs: String(NOW + 1000) }],
    ["a missing setup code", { openclaw: undefined }],
    ["a setup code that is not one", { openclaw: "abc" }],
  ])("refuses %s", (_label, changes) => {
    expect(refusal(codeWith(changes))).toBe("malformed");
  });

  it.each<[string, Record<string, unknown>]>([
    ["for another address", { url: "wss://gateway.example.test" }],
    ["for another relay id", { url: `${RELAY_ORIGIN}/v1/dial/${"a".repeat(26)}` }],
    ["with a TLS fingerprint", { tlsFingerprint: "ab:cd" }],
    ["with an empty token", { bootstrapToken: "" }],
    ["with a token holding a space", { bootstrapToken: "a b" }],
    ["with a token holding a control character", { bootstrapToken: "a\u0001b" }],
    ["with a token as a number", { bootstrapToken: 12 }],
    ["without a token", { bootstrapToken: undefined }],
    ["with a fractional expiry", { expiresAtMs: NOW + 0.5 }],
  ])("refuses an OpenClaw setup code %s", (_label, changes) => {
    expect(refusal(codeWith({ openclaw: setupWith(changes) }))).toBe("malformed");
  });

  it("refuses a ws: relay unless a loopback test allows it", () => {
    const route = { ...ROUTE, relayOrigin: "ws://127.0.0.1:9000" };
    const text = codeWith({ relay: route.relayOrigin }, { url: relayDialUrl(route) });
    expect(refusal(text)).toBe("malformed");
    expect(parseRelayCode(text, NOW, { allowLoopbackWs: true }).route.relayOrigin).toBe(
      "ws://127.0.0.1:9000",
    );
    const remote = codeWith({ relay: "ws://relay.example.test" });
    expect(() => parseRelayCode(remote, NOW, { allowLoopbackWs: true })).toThrow(RelayCodeError);
  });

  it("refuses a bad clock reading", () => {
    expect(() => parseRelayCode(codeWith(), Number.NaN)).toThrow(RelayCodeError);
  });
});
