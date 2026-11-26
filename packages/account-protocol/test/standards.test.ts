// Vectors from outside the code under test: RFC 8032's Ed25519 tests, RFC 9180's HPKE vectors
// (the KEM of A.1.1 and all of A.2.1), and the XChaCha20-Poly1305 draft's vector, from
// `test/vectors/standards.json`. And the Ed25519 edge cases: signatures a signer can craft that
// one Ed25519 accepts and another refuses (`test/vectors/ed25519-edges.json`). This package must
// accept exactly what OpenSSL, through Node, accepts.

import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vitest";
import { encapsulate, deriveSealKeyPair, hpkeOpen, hpkeSeal } from "../src/hpke.ts";
import { verifyEd25519 } from "../src/keys.ts";
import { ListPublicKey } from "../src/index.ts";
import { fill, fromHex, toHex } from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const standards = JSON.parse(
  readFileSync(new URL("./vectors/standards.json", import.meta.url), "utf8"),
) as {
  ed25519: { secret: string; public: string; message: string; signature: string }[];
  hpkeKem: Record<string, string>[];
  hpkeSeal: Record<string, string>;
  xchacha20poly1305: Record<string, string>;
};

const SPKI = fromHex("302a300506032b6570032100");
function openssl(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({
    key: Buffer.concat([SPKI, publicKey]),
    format: "der",
    type: "spki",
  });
  return nodeVerify(null, message, key, signature);
}

describe("RFC 8032, section 7.1", () => {
  it("verifies TEST 1 to TEST 3, and their public keys are accepted", () => {
    for (const v of standards.ed25519) {
      expect(toHex(ed25519.getPublicKey(fromHex(v.secret)))).toBe(v.public);
      expect(toHex(ed25519.sign(fromHex(v.message), fromHex(v.secret)))).toBe(v.signature);
      expect(verifyEd25519(fromHex(v.public), fromHex(v.message), fromHex(v.signature))).toBe(true);
      expect(ListPublicKey.fromBytes(fromHex(v.public)).bytes).toEqual(fromHex(v.public));
    }
  });
});

describe("RFC 9180", () => {
  it("derives the key pairs and the shared secret of A.1.1 and A.2.1", () => {
    for (const v of standards.hpkeKem) {
      const e = deriveSealKeyPair(fromHex(v.ikmE!));
      const r = deriveSealKeyPair(fromHex(v.ikmR!));
      expect([toHex(e.secretKey), toHex(e.publicKey)]).toEqual([v.skEm, v.pkEm]);
      expect([toHex(r.secretKey), toHex(r.publicKey)]).toEqual([v.skRm, v.pkRm]);
      const { enc, shared } = encapsulate(fromHex(v.pkRm!), fromHex(v.ikmE!));
      expect([toHex(enc), toHex(shared)]).toEqual([v.pkEm, v.shared_secret]);
    }
  });

  it("seals A.2.1's plaintext to its ciphertext and opens it", () => {
    const v = standards.hpkeSeal;
    const sealed = hpkeSeal(
      fromHex(v.pkRm!),
      fromHex(v.info!),
      fromHex(v.aad!),
      fromHex(v.pt!),
      fromHex(v.ikmE!),
    );
    expect(toHex(sealed.ciphertext)).toBe(v.ct);
    const opened = hpkeOpen(
      fromHex(v.skRm!),
      fromHex(v.pkRm!),
      sealed.enc,
      fromHex(v.info!),
      fromHex(v.aad!),
      sealed.ciphertext,
    );
    expect(toHex(opened)).toBe(v.pt);
  });
});

describe("draft-irtf-cfrg-xchacha, A.3.1", () => {
  it("is the cipher the list secret seals with", () => {
    const v = standards.xchacha20poly1305;
    const out = xchacha20poly1305(fromHex(v.key!), fromHex(v.nonce!), fromHex(v.aad!)).encrypt(
      fromHex(v.plaintext!),
    );
    expect(toHex(out)).toBe(v.ciphertext! + v.tag!);
  });
});

// The edge cases. A signer who knows its scalar a can choose R freely: R = r*B + T and
// S = r + k*a, where T is a point of small order and k = SHA-512(R, A, M).
const L = ed25519.Point.Fn.ORDER;
const T8 = ed25519.Point.fromBytes(
  fromHex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
);
function le(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}
function toLe(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
function crafted(
  seed: Uint8Array,
  message: Uint8Array,
  r: bigint,
  torsion: boolean,
  rBytes?: Uint8Array,
) {
  const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(seed);
  let point = r === 0n ? ed25519.Point.ZERO : ed25519.Point.BASE.multiply(r);
  if (torsion) point = point.add(T8);
  const encodedR = rBytes ?? point.toBytes();
  const k = le(sha512(Uint8Array.of(...encodedR, ...pointBytes, ...message))) % L;
  const s = (r + k * scalar) % L;
  return { publicKey: pointBytes, signature: Uint8Array.of(...encodedR, ...toLe(s)) };
}

interface Edge {
  readonly name: string;
  readonly publicKey: string;
  readonly message: string;
  readonly signature: string;
  readonly accept: boolean;
}

function makeEdges(): Edge[] {
  const seed = fill(32, 7);
  const message = new TextEncoder().encode("clawtrate account list entry v1\nan edge case");
  const honest = ed25519.sign(message, seed);
  const publicKey = ed25519.getPublicKey(seed);
  const edge = (
    name: string,
    sig: { publicKey: Uint8Array; signature: Uint8Array },
    accept: boolean,
  ) => ({
    name,
    publicKey: toHex(sig.publicKey),
    message: toHex(message),
    signature: toHex(sig.signature),
    accept,
  });
  return [
    edge("an honest signature", { publicKey, signature: honest }, true),
    edge(
      "S + L, a second encoding of S",
      {
        publicKey,
        signature: Uint8Array.of(...honest.subarray(0, 32), ...toLe(le(honest.subarray(32)) + L)),
      },
      false,
    ),
    edge(
      "R written as y = p, a ZIP-215-only encoding of the order-4 point",
      crafted(
        seed,
        message,
        0n,
        false,
        fromHex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
      ),
      false,
    ),
    edge("R = r*B plus a point of order 8", crafted(seed, message, 123456789n, true), false),
    edge("R the point of order 8 itself", crafted(seed, message, 0n, true), false),
    edge("R = r*B, crafted honestly", crafted(seed, message, 987654321n, false), true),
  ];
}

const EDGES = new URL("./vectors/ed25519-edges.json", import.meta.url);

describe("Ed25519 edge cases", () => {
  it("match the committed vectors", () => {
    const made = makeEdges();
    if (process.env.WRITE_VECTORS === "1")
      writeFileSync(EDGES, `${JSON.stringify(made, null, 2)}\n`);
    expect(made).toEqual(JSON.parse(readFileSync(EDGES, "utf8")));
  });

  it("are accepted by this package exactly when OpenSSL accepts them", () => {
    const edges = JSON.parse(readFileSync(EDGES, "utf8")) as Edge[];
    for (const v of edges) {
      const args = [fromHex(v.publicKey), fromHex(v.message), fromHex(v.signature)] as const;
      expect([v.name, openssl(...args)]).toEqual([v.name, v.accept]);
      expect([v.name, verifyEd25519(...args)]).toEqual([v.name, v.accept]);
    }
  });
});
