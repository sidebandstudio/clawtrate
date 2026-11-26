// The encoding's rules, the keys' checks and types, and what the package never does: read a
// clock or a random source, keep global state, or put a secret in an error.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import {
  AccountProtocolError,
  GatewayDeviceKey,
  ListPublicKey,
  ListSecret,
  ListSecretKey,
  SealPublicKey,
  SealSecretKey,
  SessionPublicKey,
  SessionSecretKey,
  verifyCard,
  type DeviceRecord,
} from "../src/index.ts";
import { Reader, Writer } from "../src/bytes.ts";
import { LABEL, TAG } from "../src/labels.ts";
import { MAX_CARD_BYTES, MAX_LIST_BYTES } from "../src/seal.ts";
import { MAX_ENTRY_BYTES } from "../src/list.ts";
import {
  assembleGenesis,
  openCard,
  sealCard,
  signCard,
  signGenesis,
  signSessionRequest,
  verifyList,
  verifySessionRequest,
} from "../src/index.ts";
import { CONTEXT, expectCode, fill, fromHex, makeDevice, toHex } from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

describe("labels and tags", () => {
  const all = [...Object.values(LABEL), ...Object.values(TAG)];

  it("are distinct, ASCII, and none is a prefix of another", () => {
    expect(new Set(all).size).toBe(all.length);
    for (const a of all) {
      expect(a).toMatch(/^clawtrate account [a-z ]+ v1\n$/);
      for (const b of all) if (a !== b) expect(b.startsWith(a)).toBe(false);
    }
  });
});

describe("the reader", () => {
  it("refuses bytes left over, bytes cut short, and lengths over a bound", () => {
    const bytes = new Writer().u8(1).text("abc", 1, 8, "t").finish();
    const reader = new Reader(Uint8Array.of(...bytes, 0));
    reader.u8();
    reader.text(1, 8, "t");
    expectCode(() => reader.end(), "malformed");
    expectCode(() => new Reader(bytes.subarray(0, 3)).fixed(4, "x"), "malformed");
    expectCode(
      () => new Reader(new Writer().text("abcdefghi", 1, 9, "t").finish()).text(1, 8, "t"),
      "too_large",
    );
    expectCode(() => new Reader(Uint8Array.of(0, 0)).text(1, 8, "t"), "malformed");
  });

  it("refuses text that isn't UTF-8, or holds a control or bidirectional character", () => {
    const raw = (bytes: number[]) =>
      new Reader(Uint8Array.of(0, bytes.length, ...bytes)).text(1, 64, "t");
    expectCode(() => raw([0xc0, 0x80]), "malformed"); // an overlong NUL
    expectCode(() => raw([0xed, 0xa0, 0x80]), "malformed"); // a surrogate
    expectCode(() => raw([0x61, 0x0a]), "malformed");
    expectCode(() => raw([0xe2, 0x80, 0xae]), "malformed"); // RIGHT-TO-LEFT OVERRIDE
    expectCode(() => new Writer().text("a‮b", 1, 64, "t"), "malformed");
    expectCode(() => new Writer().text("\ud800", 1, 64, "t"), "malformed");
    expect(raw([0xef, 0xbb, 0xbf, 0x61])).toBe("﻿a"); // a BOM is kept, never stripped
  });

  it("reads another version of a label as unsupported, and anything else as malformed", () => {
    const other = new TextEncoder().encode(LABEL.card.replace("v1", "v2"));
    expectCode(() => new Reader(other).label(LABEL.card), "unsupported_version");
    expectCode(
      () => new Reader(new TextEncoder().encode(LABEL.refusal)).label(LABEL.card),
      "malformed",
    );
  });

  it("has the largest entry and card the bounds name", () => {
    const longName = "n".repeat(64);
    const connector = ListSecretKey.fromSeed(fill(32, 9));
    const device = { ...makeDevice(1).device, name: longName } satisfies DeviceRecord;
    const fields = { context: CONTEXT, connectorKey: connector.publicKey, device };
    const { entry } = assembleGenesis(
      fields,
      signGenesis(connector, fields),
      signGenesis(makeDevice(1).listKey, fields),
    );
    expect(entry.length).toBe(MAX_ENTRY_BYTES);
    const card = signCard(connector, {
      gatewayId: CONTEXT.gatewayId,
      serial: 0,
      tlsPin: fill(32, 1),
      addresses: Array.from({ length: 8 }, () => ({ host: "h".repeat(253), port: 1 })),
      name: longName,
    });
    expect(card.length).toBe(MAX_CARD_BYTES);
    expect(verifyCard(card).addresses).toHaveLength(8);
  });
});

describe("keys", () => {
  const valid = ed25519.getPublicKey(fill(32, 1));

  it("refuses an Ed25519 key that is short, not a point, not canonical, of small order or mixed", () => {
    for (const make of [
      ListPublicKey.fromBytes,
      SessionPublicKey.fromBytes,
      GatewayDeviceKey.fromBytes,
    ]) {
      expect(make(valid).bytes).toEqual(valid);
      expectCode(() => make(valid.subarray(0, 31)), "bad_key");
      // The identity, a point of order 1.
      expectCode(() => make(fromHex("01" + "00".repeat(31))), "bad_key");
      // y = p + 1, a non-canonical encoding of y = 1.
      expectCode(
        () => make(fromHex("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")),
        "bad_key",
      );
      // A point of order 8.
      expectCode(
        () => make(fromHex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a")),
        "bad_key",
      );
      // A valid key plus a point of order 8: on the curve, not in the prime-order subgroup.
      const torsion = ed25519.Point.fromBytes(
        fromHex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
      );
      const mixed = ed25519.Point.fromBytes(valid).add(torsion).toBytes();
      expectCode(() => make(mixed), "bad_key");
      // Not on the curve.
      expectCode(() => make(fromHex("02" + "00".repeat(31))), "bad_key");
    }
  });

  it("refuses an X25519 key that is not canonical or of small order", () => {
    const good = SealSecretKey.fromSeed(fill(32, 1)).publicKey.bytes;
    expect(SealPublicKey.fromBytes(good).bytes).toEqual(good);
    for (const bad of [
      "00".repeat(32),
      "01" + "00".repeat(31),
      "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", // order 8
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p - 1
      "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p
      toHex(good.map((b, i) => (i === 31 ? b | 0x80 : b))), // the top bit set
    ]) {
      expectCode(() => SealPublicKey.fromBytes(fromHex(bad)), "bad_key");
    }
  });

  it("gives each key and purpose its own type", () => {
    const list = ListSecretKey.fromSeed(fill(32, 1));
    const session = SessionSecretKey.fromSeed(fill(32, 1));
    // The same seed makes the same Ed25519 key, yet the types keep them apart.
    expect(list.publicKey.bytes).toEqual(session.publicKey.bytes);
    // @ts-expect-error a session key is not a list key
    const wrong: ListPublicKey = session.publicKey;
    // @ts-expect-error a list key is not a seal key
    const wrongSeal: SealPublicKey = list.publicKey;
    // @ts-expect-error a public key is not a secret key
    const wrongSecret: ListSecretKey = list.publicKey;
    void [wrong, wrongSeal, wrongSecret];
    expect(list.publicKey).not.toBeInstanceOf(SessionPublicKey);
  });

  it("refuses a seed that is not 32 bytes", () => {
    expectCode(() => ListSecretKey.fromSeed(fill(31, 1)), "bad_argument");
    expectCode(() => SessionSecretKey.fromSeed(fill(33, 1)), "bad_argument");
    expectCode(() => SealSecretKey.fromSeed(new Uint8Array(0)), "bad_argument");
    expectCode(() => ListSecret.fromBytes(fill(16, 1), 0), "bad_argument");
  });
});

describe("secrets stay inside", () => {
  it("are not shown by printing or serialising a secret key or a list secret", () => {
    const seed = fill(32, 0x3c);
    const seedHex = toHex(seed);
    for (const secret of [
      ListSecretKey.fromSeed(seed),
      SessionSecretKey.fromSeed(seed),
      SealSecretKey.fromSeed(seed),
      ListSecret.fromBytes(seed, 0),
    ]) {
      const shown = `${inspect(secret, { showHidden: true, depth: 5 })} ${JSON.stringify(secret)} ${String(secret)}`;
      const compact = shown.replace(/\s/g, "");
      expect(compact).not.toContain(seedHex);
      expect(compact).not.toContain("60,60,60,60");
      expect(compact).not.toContain('"0":60');
      for (const value of Object.values(secret)) expect(value).not.toEqual(seed);
    }
  });

  it("never put a value from the input in an error", () => {
    // Every message the package can throw is a fixed string: no template takes a value from input.
    for (const file of sourceFiles()) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /fail\(\s*"[a-z_]+",\s*(`[^`]*`|"[^"]*")/g,
      )) {
        const message = match[1]!;
        const placeholders = [...message.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
        for (const placeholder of placeholders)
          expect(["what", "max", "length", "kind"]).toContain(placeholder);
      }
    }
    expect(new AccountProtocolError("malformed", "x")).toBeInstanceOf(Error);
  });
});

function sourceFiles(): string[] {
  const dir = new URL("../src/", import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => fileURLToPath(new URL(name, dir)));
}

describe("what the package never does", () => {
  it("reads no clock, no random source and no Node or DOM API, and keeps no mutable state at module level", () => {
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(
        /Math\.random|Date\.now|new Date|performance\.|getRandomValues|randomBytes|crypto\.|process\.|Buffer|require\(|from "node:/,
      );
      // Module-level `let` only for the secret accessors each class sets once in its static block.
      for (const match of text.matchAll(/^let (\w+)/gm))
        expect(match[1]).toMatch(/^(sessionSeed|listSeed|sealSecret|secretBytes)$/);
    }
  });
});

describe("the bounds the README states", () => {
  it("are the numbers the code holds", () => {
    expect(MAX_CARD_BYTES).toBe(2297);
    expect(MAX_LIST_BYTES).toBe(468_994);
    expect(MAX_ENTRY_BYTES).toBe(456);
  });
});

describe("bytes from a Node Buffer", () => {
  // A Buffer is a Uint8Array whose slices share memory and whose bytes may sit at an offset in a
  // larger pool; the package must read and keep the same values as from a plain array.
  const inPool = (bytes: Uint8Array) => {
    const pool = Buffer.alloc(bytes.length + 7, 0xee);
    pool.set(bytes, 7);
    return pool.subarray(7);
  };

  it("decode to the same values", () => {
    const connector = ListSecretKey.fromSeed(fill(32, 9));
    const device = makeDevice(1);
    const fields = { context: CONTEXT, connectorKey: connector.publicKey, device: device.device };
    const { entry, state } = assembleGenesis(
      fields,
      signGenesis(connector, fields),
      signGenesis(device.listKey, fields),
    );
    expect(verifyList(CONTEXT, [inPool(entry)]).head).toEqual(state.head);
    const card = signCard(connector, {
      gatewayId: CONTEXT.gatewayId,
      serial: 7,
      tlsPin: fill(32, 1),
      addresses: [{ host: "a.example", port: 443 }],
      name: "Gateway",
    });
    expect(verifyCard(inPool(card)).serial).toBe(7);
  });

  it("are copied, so clearing the caller's buffer changes nothing kept", () => {
    const seed = Buffer.alloc(32, 0x21);
    const key = SessionSecretKey.fromSeed(seed);
    seed.fill(0);
    const fields = {
      audience: "https://a.dev",
      challenge: fill(32, 1),
      method: "GET",
      path: "/",
      body: new Uint8Array(0),
    } as const;
    const request = signSessionRequest(key, { ...fields, issuedAtMs: 1 });
    expect(verifySessionRequest(request, { ...fields, nowMs: 1 }).equals(key.publicKey)).toBe(true);

    const secretBytes = Buffer.alloc(32, 0x22);
    const secret = ListSecret.fromBytes(secretBytes, 0);
    const sealed = sealCard(secret, CONTEXT, fill(40, 3), fill(24, 4));
    secretBytes.fill(0);
    expect(openCard(secret, CONTEXT, sealed)).toEqual(fill(40, 3));

    const publicBytes = Buffer.from(key.publicKey.bytes);
    const publicKey = SessionPublicKey.fromBytes(publicBytes);
    publicBytes.fill(0);
    expect(publicKey.equals(key.publicKey)).toBe(true);
    publicKey.bytes.fill(0);
    expect(publicKey.equals(key.publicKey)).toBe(true);
  });
});
