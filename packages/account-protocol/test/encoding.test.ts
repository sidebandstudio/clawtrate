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
import { MAX_CARD_BYTES } from "../src/seal.ts";
import {
  completeServerFirst,
  MAX_ENTRY_BYTES,
  MAX_FRESH_START_BYTES,
  MAX_LIST_BYTES,
  signServerFirst,
} from "../src/list.ts";
import {
  assembleGenesis,
  openCard,
  sealCard,
  signCard,
  signGenesis,
  signSessionRequest,
  verifySessionRequest,
} from "../src/index.ts";
import {
  chain,
  code,
  CONTEXT,
  expectCode,
  fill,
  fromHex,
  makeDevice,
  makeWorld,
  toHex,
  headObject,
} from "./helpers.ts";

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
    // Invisible (default-ignorable) characters: a byte-order mark, a zero-width space and joiner,
    // a soft hyphen, a variation selector.
    for (const invisible of ["\ufeff", "\u200b", "\u200d", "\u00ad", "\ufe0f"]) {
      expectCode(() => new Writer().text(`a${invisible}b`, 1, 64, "t"), "malformed");
      const bytes = [...new TextEncoder().encode(`a${invisible}b`)];
      expectCode(() => raw(bytes), "malformed");
    }
    expect(raw([0xc3, 0xa9, 0xe6, 0x97, 0xa5])).toBe("\u00e9\u65e5"); // letters in any script are fine
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
    expect(entry.length).toBe(MAX_ENTRY_BYTES - 32);
    // The largest entry is a server's first entry: the same, with the join's transcript hash.
    const serverFirst = completeServerFirst(
      makeDevice(1).listKey,
      signServerFirst(connector, CONTEXT, device, fill(32, 7)),
    );
    expect(serverFirst.length).toBe(MAX_ENTRY_BYTES);
    const card = signCard(connector, {
      gatewayId: CONTEXT.gatewayId,
      serial: 0,
      tlsPin: fill(32, 1),
      addresses: Array.from({ length: 8 }, () => ({ host: LONGEST_HOST, port: 1 })),
      name: longName,
    });
    expect(card.length).toBe(MAX_CARD_BYTES);
    expect(verifyCard(card, connector.publicKey, CONTEXT.gatewayId).addresses).toHaveLength(8);
  });
});

/** The longest host the card takes: four labels, each starting with a letter, 253 bytes in all. */
const LONGEST_HOST = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");

describe("a card's hosts", () => {
  const connector = ListSecretKey.fromSeed(fill(32, 9));
  const card = (host: string) => () =>
    signCard(connector, {
      gatewayId: CONTEXT.gatewayId,
      serial: 0,
      tlsPin: fill(32, 1),
      addresses: [{ host, port: 443 }],
      name: "G",
    });

  it("take one form each: a dotted quad, a DNS name of letter-first labels, or bracketed shortest IPv6", () => {
    for (const host of [
      "192.0.2.7",
      "0.0.0.0",
      "255.255.255.255",
      "windows-pc.local",
      "a",
      "pc-1.example.net",
      "[2001:db8::1]",
      "[::1]",
      "[2001:db8:0:1:1:1:1:1]",
      "[1::]",
      LONGEST_HOST,
    ]) {
      expect([host, code(card(host))]).toEqual([host, "ok"]);
    }
  });

  it("refuse every other way to write a host, and any port in it", () => {
    for (const host of [
      "2130706433", // a number a URL parser reads as 127.0.0.1
      "0x7f000001",
      "0",
      "1.2.3",
      "01.2.3.4",
      "1.2.3.4:8443",
      "256.1.1.1",
      "1password.example",
      "Windows-PC.local",
      "-a.example",
      "a-.example",
      "a..b",
      "a.",
      "2001:db8::1", // IPv6 without brackets
      "[2001:DB8::1]", // not lowercase
      "[2001:0db8::1]", // a leading zero
      "[2001:db8:0:0:0:0:0:1]", // not the shortest form
      "[2001:db8::0:1]",
      "[2001:db8:0:1:1:1:1:1::]",
      "[::ffff:192.0.2.1]", // an embedded IPv4 form
      "[" + "a".repeat(10) + "]",
      "a".repeat(64),
    ]) {
      expect([host, code(card(host))]).toEqual([host, "malformed"]);
    }
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
    // The same random bytes give another key in each role: each is derived for its purpose.
    expect(list.publicKey.bytes).not.toEqual(session.publicKey.bytes);
    // @ts-expect-error a session key is not a list key
    const wrong: ListPublicKey = session.publicKey;
    // @ts-expect-error a list key is not a seal key
    const wrongSeal: SealPublicKey = list.publicKey;
    // @ts-expect-error a public key is not a secret key
    const wrongSecret: ListSecretKey = list.publicKey;
    void [wrong, wrongSeal, wrongSecret];
    expect(list.publicKey).not.toBeInstanceOf(SessionPublicKey);
  });

  it("refuses an X25519 key with a small-order part: one key, one encoding", () => {
    // A seal key plus a point of order 8, mapped to Montgomery u: the same Diffie-Hellman result
    // for a clamped scalar, so it would be a second encoding of the same key.
    const T8 = ed25519.Point.fromBytes(
      fromHex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
    );
    const point = ed25519.Point.BASE.multiply(123456789n);
    const toU = (pt: typeof point) => {
      const p = ed25519.Point.Fp.ORDER;
      const { y } = pt.toAffine();
      let u = ((1n + y) * ed25519.Point.Fp.inv((1n - y + p) % p)) % p;
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        out[i] = Number(u & 0xffn);
        u >>= 8n;
      }
      return out;
    };
    expect(SealPublicKey.fromBytes(toU(point)).bytes).toEqual(toU(point));
    expectCode(() => SealPublicKey.fromBytes(toU(point.add(T8))), "bad_key");
  });

  it("are frozen: no field of a key or a list secret can be reassigned", () => {
    const list = ListSecretKey.fromSeed(fill(32, 1));
    const secret = ListSecret.fromBytes(fill(32, 2), 3);
    for (const object of [
      list,
      list.publicKey,
      SessionSecretKey.fromSeed(fill(32, 1)),
      SealSecretKey.fromSeed(fill(32, 1)),
      secret,
    ]) {
      expect(Object.isFrozen(object)).toBe(true);
    }
    expect(() => {
      (list as unknown as { publicKey: unknown }).publicKey = null;
    }).toThrow(TypeError);
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
        /Math\.random|Date\.now|new Date|performance\.|getRandomValues|randomBytes|randomSecretKey|keygen|globalThis|crypto\.|process\.|Buffer|require\(|from "node:/,
      );
      // Module-level `let` only for the secret accessors each class sets once in its static block.
      for (const match of text.matchAll(/^let (\w+)/gm))
        expect(match[1]).toMatch(/^(sessionSeed|listSeed|listRoot|sealSecret|secretBytes)$/);
    }
  });
});

describe("the bounds the README states", () => {
  it("are the numbers the code holds", () => {
    expect(MAX_CARD_BYTES).toBe(2297);
    expect(MAX_ENTRY_BYTES).toBe(488);
    expect(MAX_FRESH_START_BYTES).toBe(7534);
    expect(MAX_LIST_BYTES).toBe(524_488);
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
    expect(chain(CONTEXT, [inPool(entry)]).head).toEqual(state.head);
    const card = signCard(connector, {
      gatewayId: CONTEXT.gatewayId,
      serial: 7,
      tlsPin: fill(32, 1),
      addresses: [{ host: "a.example", port: 443 }],
      name: "Gateway",
    });
    expect(verifyCard(inPool(card), connector.publicKey, inPool(CONTEXT.gatewayId)).serial).toBe(7);
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
    const world = makeWorld();
    const sealed = sealCard(secret, CONTEXT, world.card, fill(32, 4), headObject(world));
    secretBytes.fill(0);
    expect(openCard(secret, world.state, sealed, headObject(world)).serial).toBe(1);

    const publicBytes = Buffer.from(key.publicKey.bytes);
    const publicKey = SessionPublicKey.fromBytes(publicBytes);
    publicBytes.fill(0);
    expect(publicKey.equals(key.publicKey)).toBe(true);
    publicKey.bytes.fill(0);
    expect(publicKey.equals(key.publicKey)).toBe(true);
  });
});
