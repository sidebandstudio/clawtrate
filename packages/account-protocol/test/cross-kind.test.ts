// A signature made for one kind never verifies as another. One Ed25519 key, from one seed,
// signs every kind here: as the session key, as the connector's list key, as the answering
// member's and as the joining device's. For every ordered pair of kinds, the first kind's bytes
// are refused as the second, and the second kind's object carrying the first kind's signature
// is refused too.

import { describe, expect, it, vi } from "vitest";
import {
  encodeRemovalNotice,
  joinConfirm,
  joinFinish,
  ListSecret,
  openRotation,
  refuseJoin,
  rotateListSecret,
  SessionSecretKey,
  signRemovalNotice,
  signSessionRequest,
  verifyCard,
  verifyList,
  verifyRefusal,
  verifySessionRequest,
  joinChoices,
} from "../src/index.ts";
import {
  code,
  CONTEXT,
  DECOY_SEED,
  fill,
  makeDevice,
  makeWorld,
  memberOf,
  N_NONCE,
  runJoin,
  SEAL_SEED,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const K = fill(32, 0x4b);

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
  readonly verify: (bytes: Uint8Array) => unknown;
}

function kinds(): Kind[] {
  // K as the connector: the first entry, the card, the account page's removal, a rotation.
  const asConnector = makeWorld({ connector: K });
  const other = makeDevice(2);
  const plus = joinAdd(memberOf(asConnector, asConnector.gatewayDevice.listKey), other);
  const removal = signRemovalNotice(
    asConnector.connector,
    plus.state,
    encodeRemovalNotice(CONTEXT, other.device.listKey),
  );
  const rotation = rotateListSecret(
    asConnector.connector,
    plus.state,
    ListSecret.fromBytes(fill(32, 9), 1),
    fill(64, 3),
  );
  const holder = { listKey: other.device.listKey, sealKey: other.sealKey };

  // K as the answering member: the add entry, the confirmation, a refusal.
  const asMember = makeWorld({ gatewayDevice: K });
  const member = memberOf(asMember, asMember.gatewayDevice.listKey);
  const mac = makeDevice(2);
  const run = runJoin(member, mac);
  const added = joinConfirm(
    member,
    run.commit,
    run.answer,
    run.reveal,
    DECOY_SEED,
    { set: run.right },
    SEAL_SEED,
  );
  if (added.outcome !== "added") throw new Error("expected an added outcome");
  const refusal = refuseJoin(member, run.commit, "not-started");

  // K as the joining device: the reveal.
  const joinWorld = makeWorld();
  const joiner = makeDevice(3, "Phone", "ios", K);
  const joinerMember = memberOf(joinWorld, joinWorld.gatewayDevice.listKey);
  const joinerRun = runJoin(joinerMember, joiner);

  const session = signSessionRequest(SessionSecretKey.fromSeed(K), {
    ...SESSION,
    issuedAtMs: 1_000_000,
  });

  return [
    {
      name: "session request",
      bytes: session,
      signatures: 1,
      verify: (b) => verifySessionRequest(b, { ...SESSION, nowMs: 1_000_000 }),
    },
    {
      name: "first entry",
      bytes: asConnector.genesis,
      signatures: 2,
      verify: (b) => verifyList(CONTEXT, [b]),
    },
    {
      name: "account removal entry",
      bytes: removal.entry,
      signatures: 1,
      verify: (b) => plus.state.append(b),
    },
    {
      name: "add entry",
      bytes: added.entry,
      signatures: 1,
      verify: (b) => asMember.state.append(b),
    },
    { name: "card", bytes: asConnector.card, signatures: 1, verify: (b) => verifyCard(b) },
    {
      name: "refusal",
      bytes: refusal,
      signatures: 1,
      verify: (b) => verifyRefusal(asMember.state, b),
    },
    {
      name: "join reveal",
      bytes: joinerRun.reveal,
      signatures: 1,
      verify: (b) => joinChoices(joinerMember, joinerRun.commit, joinerRun.answer, b, DECOY_SEED),
    },
    {
      name: "join confirmation",
      bytes: added.confirm,
      signatures: 1,
      verify: (b) => joinFinish(mac, CONTEXT, N_NONCE, run.commit, run.answer, run.reveal, b),
    },
    {
      name: "list secret rotation",
      bytes: rotation,
      signatures: 1,
      verify: (b) => openRotation(holder, plus.state, b, asConnector.secret),
    },
  ];
}

function joinAdd(member: ReturnType<typeof memberOf>, joining: ReturnType<typeof makeDevice>) {
  const run = runJoin(member, joining);
  const outcome = joinConfirm(
    member,
    run.commit,
    run.answer,
    run.reveal,
    DECOY_SEED,
    { set: run.right },
    SEAL_SEED,
  );
  if (outcome.outcome !== "added") throw new Error("expected an added outcome");
  return outcome;
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
