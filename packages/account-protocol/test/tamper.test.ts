// Every field of every message, changed in turn: each byte's low bit and high bit flipped. Each
// field lists the codes a change to it may give; nothing changed is ever accepted. Changes made
// by someone who can also sign (a member gone wrong, or a key of the attacker's own) are in
// list.test.ts and join.test.ts.

import { describe, expect, it, vi } from "vitest";
import {
  encodeRemovalNotice,
  openFirstSecret,
  sealFirstSecret,
  signWithdrawal,
  verifyHead,
  ListSecret,
  MemberJoin,
  NewDeviceJoin,
  openCard,
  openEntry,
  openList,
  openRotation,
  refuseJoin,
  rotateListSecret,
  sealCard,
  sealEntry,
  sealList,
  SessionSecretKey,
  signRemovalNotice,
  signRestore,
  signSessionRequest,
  verifyCard,
  verifyRefusal,
  verifySessionRequest,
  type AccountProtocolErrorCode as Code,
} from "../src/index.ts";
import {
  chain,
  appended,
  code,
  CONTEXT,
  fill,
  flip,
  LIST_RANDOM,
  makeDevice,
  makeWorld,
  memberOf,
  N_RANDOM,
  runJoin,
  SEAL_RANDOM,
  CLOCK,
  NOW,
  headObject,
  headOf,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

type Field = readonly [name: string, length: number, codes: readonly Code[]];

const LABEL: readonly Code[] = ["malformed", "unsupported_version"];
const SIGNED: readonly Code[] = ["bad_signature"];
const KEY: readonly Code[] = ["bad_key", "bad_signature"];
const CONTEXT_FIELDS = (codes: readonly Code[]): Field[] => [
  ["gateway id", 16, codes],
  ["account id", 16, codes],
];

function record(name: string, codes: readonly Code[], keyCodes: readonly Code[]): Field[] {
  return [
    ["list key", 32, keyCodes],
    ["seal key", 32, keyCodes],
    ["TLS pin", 32, codes],
    ["gateway device key", 32, keyCodes],
    ["platform", 1, ["malformed", ...codes]],
    ["name length", 2, ["malformed", "too_large", "bad_key"]],
    ["name", new TextEncoder().encode(name).length, ["malformed", ...codes]],
  ];
}

/** Flips each byte's low and high bit in each field, and checks the code. */
function tamper(
  bytes: Uint8Array,
  fields: readonly Field[],
  verify: (bytes: Uint8Array) => unknown,
): void {
  const total = fields.reduce((sum, [, length]) => sum + length, 0);
  expect(total).toBe(bytes.length);
  expect(code(() => verify(bytes))).toBe("ok");
  let at = 0;
  for (const [name, length, codes] of fields) {
    for (let i = at; i < at + length; i++) {
      for (const bit of [0, 7]) {
        const found = code(() => verify(flip(bytes, i, bit)));
        if (!codes.includes(found as Code)) {
          throw new Error(
            `${name}, byte ${i - at}, bit ${bit}: ${found}, expected one of ${codes.join(", ")}`,
          );
        }
      }
    }
    at += length;
  }
}

describe("tampering with the list", () => {
  const world = makeWorld();
  const gateway = world.gatewayDevice;
  const mac = makeDevice(2, "MacBook Pro");
  const member = memberOf(world, gateway.listKey);
  const run = runJoin(member, mac);
  const added = run.a.confirm(run.words, SEAL_RANDOM, NOW);
  if (added.outcome !== "added") throw new Error("expected an added outcome");
  const withMac = appended(world, added.entry);
  const head = (codes: readonly Code[]): Field[] => [
    ["label", 32, LABEL],
    ...CONTEXT_FIELDS(codes),
    ["position", 4, codes],
    ["previous hash", 32, codes],
  ];

  it("the first entry", () => {
    tamper(
      world.genesis,
      [
        ...head(SIGNED),
        ["type", 1, ["malformed", "bad_key", "bad_signature", "bad_chain"]],
        ["connector key", 32, KEY],
        ...record("Windows PC", SIGNED, KEY),
        ["connector signature", 64, SIGNED],
        ["device signature", 64, SIGNED],
      ],
      (b) => chain(CONTEXT, [b]),
    );
  });

  it("an add entry", () => {
    tamper(
      added.entry,
      [
        ...head(SIGNED),
        ["type", 1, ["malformed", "bad_key", "bad_chain", "too_large"]],
        ...record("MacBook Pro", SIGNED, KEY),
        ["join transcript", 32, SIGNED],
        ["signer", 32, KEY],
        ["signature", 64, SIGNED],
      ],
      (b) => world.state.append(b),
    );
  });

  it("a removal from the account page and a restore", () => {
    const notice = encodeRemovalNotice(CONTEXT, mac.device.listKey);
    const removal = signRemovalNotice(world.connector, withMac.state, notice);
    const removed = withMac.state.append(removal);
    tamper(
      removal,
      [
        ...head(SIGNED),
        ["type", 1, ["malformed", "bad_key", "bad_signature"]],
        ["origin", 1, ["malformed", "bad_signature"]],
        ["target", 32, KEY],
        ["signer", 32, KEY],
        ["signature", 64, SIGNED],
      ],
      (b) => withMac.state.append(b),
    );
    const restore = signRestore(gateway.listKey, removed, mac.device.listKey);
    tamper(
      restore,
      [
        ...head(SIGNED),
        ["type", 1, ["malformed", "bad_key", "bad_signature"]],
        ["target", 32, KEY],
        ["signer", 32, KEY],
        ["signature", 64, SIGNED],
      ],
      (b) => removed.append(b),
    );
  });

  it("a refusal", () => {
    const refusal = refuseJoin(member, run.commit, "none-match");
    tamper(
      refusal,
      [
        ["label", 29, LABEL],
        ...CONTEXT_FIELDS(SIGNED),
        ["list head", 32, SIGNED],
        ["commitment", 32, SIGNED],
        ["reason", 1, ["malformed", "bad_signature"]],
        ["signer", 32, KEY],
        ["signature", 64, SIGNED],
      ],
      (b) => verifyRefusal(world.state, b, [world.state.head]),
    );
  });

  it("the card", () => {
    tamper(
      world.card,
      [
        ["label", 26, LABEL],
        ["gateway id", 16, SIGNED],
        ["serial", 4, SIGNED],
        ["connector key", 32, ["bad_key", "card_mismatch"]],
        ["TLS pin", 32, SIGNED],
        ["address count", 1, ["malformed", "too_large"]],
        ["host length", 2, ["malformed", "too_large"]],
        ["host", 16, ["malformed", "bad_signature"]],
        ["port", 2, SIGNED],
        ["host length", 2, ["malformed", "too_large"]],
        ["host", 18, ["malformed", "bad_signature"]],
        ["port", 2, SIGNED],
        ["name length", 2, ["malformed", "too_large", "bad_key"]],
        ["name", 10, ["malformed", "bad_signature"]],
        ["signature", 64, SIGNED],
      ],
      (b) => verifyCard(b, world.connector.publicKey, CONTEXT.gatewayId),
    );
  });

  it("a rotation of the list secret", () => {
    const rotation = rotateListSecret(
      world.connector,
      withMac.state,
      world.secret,
      ListSecret.fromBytes(fill(32, 9), 1),
      fill(32, 3),
    );
    const holder = { listKey: mac.device.listKey, sealKey: mac.sealKey };
    const share: Field[] = [
      ["recipient", 32, KEY],
      ["enc", 32, SIGNED],
      ["sealed secret", 48, SIGNED],
    ];
    tamper(
      rotation,
      [
        ["label", 33, LABEL],
        ...CONTEXT_FIELDS(SIGNED),
        ["generation", 4, SIGNED],
        ["length", 4, SIGNED],
        ["latest entry hash", 32, SIGNED],
        ["epoch", 4, SIGNED],
        ["count", 1, ["malformed", "too_large"]],
        ...share,
        ...share,
        ["signature", 64, SIGNED],
      ],
      (b) => openRotation(holder, withMac.state, b, world.secret),
    );
  });

  it("the head and the first secret", () => {
    const head = headOf(world, withMac);
    tamper(
      head,
      [
        ["label", 31, LABEL],
        ...CONTEXT_FIELDS(SIGNED),
        ["generation", 4, SIGNED],
        ["count", 4, SIGNED],
        ["latest entry hash", 32, SIGNED],
        ["epoch", 4, SIGNED],
        ["card hash", 32, SIGNED],
        ["serial", 4, SIGNED],
        ["signature", 64, SIGNED],
      ],
      (b) => verifyHead(b, world.connector.publicKey, CONTEXT),
    );
    const first = sealFirstSecret(world.connector, world.state, world.secret, fill(32, 4));
    const holder = { listKey: gateway.device.listKey, sealKey: gateway.sealKey };
    tamper(
      first,
      [
        ["label", 34, LABEL],
        ...CONTEXT_FIELDS(SIGNED),
        ["first entry hash", 32, SIGNED],
        ["recipient", 32, KEY],
        ["enc", 32, SIGNED],
        ["sealed secret", 48, SIGNED],
        ["signature", 64, SIGNED],
      ],
      (b) => openFirstSecret(holder, world.state, b),
    );
  });

  it("a withdrawal", () => {
    const withdrawal = signWithdrawal(world.connector, withMac.state, mac.device.listKey);
    tamper(
      withdrawal,
      [
        ...head(SIGNED),
        ["type", 1, ["malformed", "bad_key", "bad_signature"]],
        ["origin", 1, ["malformed", "bad_signature"]],
        ["target", 32, KEY],
        ["signer", 32, KEY],
        ["signature", 64, SIGNED],
      ],
      (b) => withMac.state.append(b),
    );
  });

  it("each sealed thing", () => {
    const secret = world.secret;
    const sealedHeader = (codes: readonly Code[]): Field[] => [
      ["version", 1, ["unsupported_version"]],
      ["kind", 1, ["malformed"]],
      ["epoch", 4, ["decrypt_failed"]],
      ["nonce", 24, codes],
    ];
    const list = sealList(secret, CONTEXT, [world.genesis], fill(32, 1), headObject(world));
    tamper(
      list,
      [...sealedHeader(["decrypt_failed"]), ["ciphertext", list.length - 30, ["decrypt_failed"]]],
      (b) => openList(secret, CONTEXT, b, headOf(world)),
    );
    const card = sealCard(secret, CONTEXT, world.card, fill(32, 2), headObject(world));
    tamper(
      card,
      [...sealedHeader(["decrypt_failed"]), ["ciphertext", card.length - 30, ["decrypt_failed"]]],
      (b) => openCard(secret, world.state, b, headObject(world)),
    );
    const entry = sealEntry(secret, CONTEXT, added.entry, fill(32, 3), headObject(world));
    tamper(
      entry,
      [...sealedHeader(["decrypt_failed"]), ["ciphertext", entry.length - 30, ["decrypt_failed"]]],
      (b) => openEntry(secret, world.state, b),
    );
  });
});

describe("tampering with the join", () => {
  const world = makeWorld();
  const member = memberOf(world, world.gatewayDevice.listKey);
  const mac = makeDevice(2, "MacBook Pro");
  const run = runJoin(member, mac);
  const added = run.a.confirm(run.words, SEAL_RANDOM, NOW);
  if (added.outcome !== "added") throw new Error("expected an added outcome");
  const sealed = sealList(
    world.secret,
    CONTEXT,
    appended(world, added.entry).entries,
    LIST_RANDOM,
    headObject(world),
  );
  /** A fresh N with the same keys and random: the same commitment, ready for one answer. */
  const freshN = () => NewDeviceJoin.start(mac, CONTEXT, N_RANDOM, CLOCK);
  const label: Field = ["label", 37, LABEL];
  const step: Field = ["step", 1, ["transcript_mismatch"]];

  it("the commit, as A answers it and N then finds the answer", () => {
    tamper(
      run.commit,
      [
        label,
        step,
        ...CONTEXT_FIELDS(["wrong_gateway", "wrong_account"]),
        ["commitment", 32, ["transcript_mismatch"]],
      ],
      (b) => freshN().reveal(MemberJoin.answer(member, b, CLOCK).answer),
    );
  });

  it("the answer, refused by N or, where N can't tell, by A", () => {
    // A changed key, list head, card hash or nonce gives N other words and a reveal A refuses.
    const throughBoth = (b: Uint8Array) => {
      const { reveal } = freshN().reveal(b);
      return MemberJoin.answer(member, run.commit, CLOCK).choices(reveal);
    };
    tamper(
      run.answer,
      [
        label,
        step,
        ...CONTEXT_FIELDS(["wrong_gateway", "wrong_account"]),
        ["commitment", 32, ["transcript_mismatch"]],
        ["member key", 32, ["bad_key", "transcript_mismatch"]],
        ["list head", 32, ["transcript_mismatch"]],
        ["card hash", 32, ["transcript_mismatch"]],
        ["nonce", 32, ["transcript_mismatch"]],
      ],
      throughBoth,
    );
  });

  it("the reveal, as A checks it", () => {
    tamper(
      run.reveal,
      [
        label,
        step,
        ...CONTEXT_FIELDS(["wrong_gateway", "wrong_account"]),
        ...record("MacBook Pro", ["commitment_mismatch"], ["bad_key", "commitment_mismatch"]),
        ["nonce", 32, ["commitment_mismatch"]],
        ["transcript hash", 32, ["transcript_mismatch"]],
        ["signature", 64, SIGNED],
      ],
      (b) => MemberJoin.answer(member, run.commit, CLOCK).choices(b),
    );
  });

  it("the confirmation, as N checks it", () => {
    const entryLength = added.entry.length;
    const sealedLength = added.confirm.length - (37 + 1 + 32 + 32 + 2 + entryLength + 32 + 2 + 64);
    tamper(
      added.confirm,
      [
        label,
        step,
        ...CONTEXT_FIELDS(["wrong_gateway", "wrong_account"]),
        ["transcript hash", 32, ["transcript_mismatch"]],
        ["entry length", 2, ["malformed", "too_large"]],
        ["entry", entryLength, SIGNED],
        ["enc", 32, SIGNED],
        ["sealed length", 2, ["malformed", "too_large"]],
        ["sealed", sealedLength, SIGNED],
        ["signature", 64, SIGNED],
      ],
      (b) => {
        const n = freshN();
        n.reveal(run.answer);
        return n.finish(b, sealed, headOf(world, appended(world, added.entry)));
      },
    );
  });
});

describe("tampering with a session request", () => {
  it("every field", () => {
    const key = SessionSecretKey.fromSeed(fill(32, 0x5e));
    const fields = {
      audience: "https://accounts.clawtrate.dev",
      challenge: fill(32, 0x66),
      method: "POST",
      path: "/v1/devices",
      body: fill(10, 1),
    } as const;
    const request = signSessionRequest(key, { ...fields, issuedAtMs: 5_000_000 });
    tamper(
      request,
      [
        ["label", 37, LABEL],
        ["audience length", 2, ["malformed", "too_large", "bad_key"]],
        ["audience", 30, ["malformed", "bad_signature"]],
        ["session key", 32, KEY],
        ["challenge", 32, SIGNED],
        ["time", 8, ["bad_time", "bad_signature"]],
        ["method", 1, ["malformed", "bad_signature"]],
        ["path length", 2, ["malformed", "too_large"]],
        ["path", 11, ["malformed", "bad_signature"]],
        ["body hash", 32, SIGNED],
        ["signature", 64, SIGNED],
      ],
      (b) => verifySessionRequest(b, { ...fields, nowMs: 5_000_000 }),
    );
  });
});
