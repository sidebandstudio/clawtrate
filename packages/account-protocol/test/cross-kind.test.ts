// A signature made for one kind never verifies as another. One Ed25519 key signs every kind
// here: as the connector's list key, as the answering member's, as the joining device's, and,
// built by hand from that same list key's Ed25519 key, as a session key (the package itself
// derives its session key for that purpose alone, so this is stronger than any caller can do).
// For every ordered pair of kinds, the first kind's bytes are refused as the second, and the
// second kind's object carrying the first kind's signature is refused too. A label left out of
// the signed bytes is refused as well.

import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vitest";
import {
  encodeRemovalNotice,
  ListSecret,
  MemberJoin,
  NewDeviceJoin,
  openRotation,
  refuseJoin,
  rotateListSecret,
  sealList,
  SessionSecretKey,
  signRemoval,
  signRemovalNotice,
  signRestore,
  signSessionRequest,
  verifyCard,
  verifyList,
  verifyRefusal,
  verifySessionRequest,
} from "../src/index.ts";
import { TAG } from "../src/labels.ts";
import {
  addDevice,
  appended,
  code,
  CONTEXT,
  fill,
  LIST_RANDOM,
  makeDevice,
  makeWorld,
  memberOf,
  N_RANDOM,
  runJoin,
  SEAL_RANDOM,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const K = fill(32, 0x4b);
/** The Ed25519 seed the package derives from K for a list key. */
const K_SEED = hkdf(sha256, K, undefined, new TextEncoder().encode(TAG.listKey), 32);

const SESSION = {
  audience: "https://accounts.clawtrate.dev",
  challenge: fill(32, 0x66),
  method: "POST",
  path: "/v1/session",
  body: new Uint8Array(0),
} as const;

interface Kind {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** How many signatures end the bytes; the one by K is the first of them. */
  readonly signatures: number;
  /** How many bytes at the start are the label the signature covers. */
  readonly label: number;
  readonly verify: (bytes: Uint8Array) => unknown;
}

/** A session request signed by K's list key, its session key field set to that key. */
function sessionRequestByK(): Uint8Array {
  const honest = signSessionRequest(SessionSecretKey.fromSeed(fill(32, 1)), {
    ...SESSION,
    issuedAtMs: 1_000_000,
  });
  const body = honest.slice(0, honest.length - 64);
  const keyAt = 37 + 2 + SESSION.audience.length;
  body.set(ed25519.getPublicKey(K_SEED), keyAt);
  return Uint8Array.of(...body, ...ed25519.sign(body, K_SEED));
}

function kinds(): Kind[] {
  // K as the connector: the first entry, the card, the account page's removal, a rotation.
  const asConnector = makeWorld({ connector: K });
  const other = makeDevice(2);
  const plus = addDevice(asConnector, asConnector.gatewayDevice.listKey, other).held;
  const removal = signRemovalNotice(
    asConnector.connector,
    plus.state,
    encodeRemovalNotice(CONTEXT, other.device.listKey),
  );
  const rotation = rotateListSecret(
    asConnector.connector,
    plus.state,
    asConnector.secret,
    ListSecret.fromBytes(fill(32, 9), 1),
    fill(32, 3),
  );
  const holder = { listKey: other.device.listKey, sealKey: other.sealKey };

  // K as the answering member: the add entry, the confirmation, a refusal, a removal, a restore.
  const asMember = makeWorld({ gatewayDevice: K });
  const member = memberOf(asMember, asMember.gatewayDevice.listKey);
  const mac = makeDevice(2);
  const run = runJoin(member, mac);
  const added = run.a.confirm(run.words, SEAL_RANDOM);
  if (added.outcome !== "added") throw new Error("expected an added outcome");
  const withMac = appended(asMember, added.entry);
  const sealed = sealList(asMember.secret, CONTEXT, withMac.entries, LIST_RANDOM);
  const refusal = refuseJoin(member, run.commit, "not-started");
  const memberRemoval = signRemoval(
    asMember.gatewayDevice.listKey,
    withMac.state,
    mac.device.listKey,
  );
  const byPage = appended(
    withMac,
    signRemovalNotice(
      asMember.connector,
      withMac.state,
      encodeRemovalNotice(CONTEXT, mac.device.listKey),
    ),
  );
  const restore = signRestore(asMember.gatewayDevice.listKey, byPage.state, mac.device.listKey);

  // K as the joining device: the reveal.
  const joinWorld = makeWorld();
  const joiner = makeDevice(3, "Phone", "ios", K);
  const joinerMember = memberOf(joinWorld, joinWorld.gatewayDevice.listKey);
  const joinerRun = runJoin(joinerMember, joiner);

  return [
    {
      name: "session request",
      bytes: sessionRequestByK(),
      signatures: 1,
      label: 37,
      verify: (b) => verifySessionRequest(b, { ...SESSION, nowMs: 1_000_000 }),
    },
    {
      name: "first entry",
      bytes: asConnector.genesis,
      signatures: 2,
      label: 32,
      verify: (b) => verifyList(CONTEXT, [b]),
    },
    {
      name: "account removal entry",
      bytes: removal,
      signatures: 1,
      label: 32,
      verify: (b) => plus.state.append(b),
    },
    {
      name: "add entry",
      bytes: added.entry,
      signatures: 1,
      label: 32,
      verify: (b) => asMember.state.append(b),
    },
    {
      name: "member removal entry",
      bytes: memberRemoval,
      signatures: 1,
      label: 32,
      verify: (b) => withMac.state.append(b),
    },
    {
      name: "restore entry",
      bytes: restore,
      signatures: 1,
      label: 32,
      verify: (b) => byPage.state.append(b),
    },
    {
      name: "card",
      bytes: asConnector.card,
      signatures: 1,
      label: 26,
      verify: (b) => verifyCard(b, asConnector.connector.publicKey, CONTEXT.gatewayId),
    },
    {
      name: "refusal",
      bytes: refusal,
      signatures: 1,
      label: 29,
      verify: (b) => verifyRefusal(asMember.state, b),
    },
    {
      name: "join reveal",
      bytes: joinerRun.reveal,
      signatures: 1,
      label: 37,
      verify: (b) => MemberJoin.answer(joinerMember, joinerRun.commit).choices(b),
    },
    {
      name: "join confirmation",
      bytes: added.confirm,
      signatures: 1,
      label: 37,
      verify: (b) => {
        const n = NewDeviceJoin.start(mac, CONTEXT, N_RANDOM);
        n.reveal(run.answer);
        return n.finish(b, sealed);
      },
    },
    {
      name: "list secret rotation",
      bytes: rotation,
      signatures: 1,
      label: 33,
      verify: (b) => openRotation(holder, plus.state, b, asConnector.secret),
    },
  ];
}

/** The signature by K: the first of the signatures that end the bytes. */
function signatureOf(kind: Kind): Uint8Array {
  const at = kind.bytes.length - 64 * kind.signatures;
  return kind.bytes.slice(at, at + 64);
}

function withSignature(kind: Kind, signature: Uint8Array): Uint8Array {
  const out = kind.bytes.slice();
  out.set(signature, kind.bytes.length - 64 * kind.signatures);
  return out;
}

describe("signing contexts", () => {
  const all = kinds();

  it("every kind verifies as itself", () => {
    for (const kind of all)
      expect([kind.name, code(() => kind.verify(kind.bytes))]).toEqual([kind.name, "ok"]);
  });

  it("a signature over a kind's bytes without its label is refused", () => {
    for (const kind of all) {
      const signedLength = kind.bytes.length - 64 * kind.signatures;
      const withoutLabel = kind.bytes.slice(kind.label, signedLength);
      const unlabelled = withSignature(kind, ed25519.sign(withoutLabel, K_SEED));
      expect([kind.name, code(() => kind.verify(unlabelled))]).toEqual([
        kind.name,
        "bad_signature",
      ]);
    }
  });

  for (const from of all) {
    for (const as of all) {
      if (from === as) continue;
      it(`a ${from.name} is refused as a ${as.name}`, () => {
        expect(code(() => as.verify(from.bytes))).not.toBe("ok");
        const transplanted = withSignature(as, signatureOf(from));
        expect(code(() => as.verify(transplanted))).toBe("bad_signature");
      });
    }
  }
});
