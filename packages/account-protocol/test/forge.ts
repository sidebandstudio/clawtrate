// Hand-built, validly signed messages that break one rule each: what a member gone wrong, or the
// service holding a key of its own, could send. Tests use them to show that each check catches
// what it is there for. Built from the package's internals, which nothing outside it can import.

import { concat, Writer } from "../src/bytes.ts";
import { hpkeSeal } from "../src/hpke.ts";
import {
  signList,
  type ListPublicKey,
  type ListSecretKey,
  type SealPublicKey,
} from "../src/keys.ts";
import { LABEL, TAG } from "../src/labels.ts";
import type { ListContext } from "../src/records.ts";
import { listSecretBytes, type ListSecret } from "../src/seal.ts";

export function transcriptOf(reveal: Uint8Array): Uint8Array {
  return reveal.slice(reveal.length - 96, reveal.length - 64);
}

/** An answer with any fields: N has no list to check one against. */
export function forgeAnswer(fields: {
  context: ListContext;
  commitment: Uint8Array;
  memberKey: ListPublicKey;
  listHead: Uint8Array;
  cardHash: Uint8Array;
  nonce: Uint8Array;
}): Uint8Array {
  return new Writer()
    .label(LABEL.joinTranscript)
    .u8(2)
    .fixed(fields.context.gatewayId, 16, "g")
    .fixed(fields.context.accountId, 16, "a")
    .fixed(fields.commitment, 32, "c")
    .fixed(fields.memberKey.bytes, 32, "k")
    .fixed(fields.listHead, 32, "h")
    .fixed(fields.cardHash, 32, "card")
    .fixed(fields.nonce, 32, "n")
    .finish();
}

export function commitmentOf(commit: Uint8Array): Uint8Array {
  return commit.slice(commit.length - 32);
}

/** A confirmation signed by `member` with whatever entry, secret and card it chooses. */
export function forgeConfirm(fields: {
  member: ListSecretKey;
  context: ListContext;
  transcript: Uint8Array;
  entry: Uint8Array;
  sealTo: SealPublicKey;
  secret: ListSecret;
  card: Uint8Array;
}): Uint8Array {
  const payload = new Writer()
    .u32(fields.secret.epoch)
    .fixed(listSecretBytes(fields.secret), 32, "secret")
    .bytes(fields.card, 1, 4096, "card")
    .finish();
  const info = new Writer()
    .label(TAG.deviceSeal)
    .u8(1)
    .fixed(fields.context.gatewayId, 16, "g")
    .fixed(fields.context.accountId, 16, "a")
    .fixed(fields.transcript, 32, "t")
    .finish();
  const { enc, ciphertext } = hpkeSeal(
    fields.sealTo.bytes,
    info,
    new Uint8Array(0),
    payload,
    new Uint8Array(32).fill(0x5f),
  );
  const signed = new Writer()
    .label(LABEL.joinTranscript)
    .u8(4)
    .fixed(fields.context.gatewayId, 16, "g")
    .fixed(fields.context.accountId, 16, "a")
    .fixed(fields.transcript, 32, "t")
    .bytes(fields.entry, 1, 456, "entry")
    .fixed(enc, 32, "enc")
    .bytes(ciphertext, 17, 4096, "sealed")
    .finish();
  return concat(signed, signList(fields.member, signed));
}

/** A refusal signed by any list key, the connector's included. */
export function forgeRefusal(fields: {
  signer: ListSecretKey;
  context: ListContext;
  listHead: Uint8Array;
  commitment: Uint8Array;
  reason: number;
}): Uint8Array {
  const signed = new Writer()
    .label(LABEL.refusal)
    .fixed(fields.context.gatewayId, 16, "g")
    .fixed(fields.context.accountId, 16, "a")
    .fixed(fields.listHead, 32, "h")
    .fixed(fields.commitment, 32, "c")
    .u8(fields.reason)
    .fixed(fields.signer.publicKey.bytes, 32, "s")
    .finish();
  return concat(signed, signList(fields.signer, signed));
}
