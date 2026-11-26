// Known-answer vectors: fixed keys and randomness in, exact bytes out, for every signed object,
// the transcript, the words and each sealed thing. `test/vectors/account-v1.json` holds them;
// `WRITE_VECTORS=1` rewrites it, which only a deliberate change to the protocol should need.
// Every signature is also checked with Node's own Ed25519, a second implementation, over
// exactly the bytes in front of it. The word list is checked against the published file's hash.
// Vectors from the standards themselves are in standards.test.ts.

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  encodeRemovalNotice,
  entryHash,
  ListSecret,
  openRotation,
  refuseJoin,
  rotateListSecret,
  sealCard,
  sealEntry,
  sealList,
  SessionSecretKey,
  signRemoval,
  signRemovalNotice,
  signRestore,
  signSessionRequest,
  cardHash,
} from "../src/index.ts";
import { WORDLIST_TEXT } from "../src/wordlist.ts";
import {
  addDevice,
  appended,
  CONTEXT,
  fill,
  fromHex,
  makeDevice,
  makeWorld,
  memberOf,
  toHex,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const FILE = new URL("./vectors/account-v1.json", import.meta.url);

const SPKI_ED25519 = fromHex("302a300506032b6570032100");

/** Node's Ed25519, over exactly the bytes given. */
function nodeVerifies(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519, publicKey]),
    format: "der",
    type: "spki",
  });
  return verify(null, message, key, signature);
}

/** Checks the last `count` signatures of `bytes`, each over everything before the first of them. */
function checkSigned(bytes: Uint8Array, keys: Uint8Array[]): void {
  const signedLength = bytes.length - 64 * keys.length;
  keys.forEach((key, i) => {
    const signature = bytes.subarray(signedLength + 64 * i, signedLength + 64 * (i + 1));
    expect(nodeVerifies(key, bytes.subarray(0, signedLength), signature)).toBe(true);
  });
}

function scenario() {
  const world = makeWorld();
  const gateway = world.gatewayDevice;
  const mac = makeDevice(2, "MacBook Pro");
  const member = memberOf(world, gateway.listKey);
  const { run, confirm, held: withMac, finished } = addDevice(world, gateway.listKey, mac);
  const added = { confirm };
  const refusal = refuseJoin(member, run.commit, "none-match");
  const notice = encodeRemovalNotice(CONTEXT, mac.device.listKey);
  const byPageEntry = signRemovalNotice(world.connector, withMac.state, notice);
  const byPage = appended(withMac, byPageEntry);
  const restoreEntry = signRestore(gateway.listKey, byPage.state, mac.device.listKey);
  const restored = appended(byPage, restoreEntry);
  const removalEntry = signRemoval(gateway.listKey, restored.state, mac.device.listKey);
  const removal = appended(restored, removalEntry);
  const next = ListSecret.fromBytes(fill(32, 0xe1), 1);
  const rotation = rotateListSecret(
    world.connector,
    removal.state,
    world.secret,
    next,
    fill(32, 0x55),
  );
  const entries = [...removal.entries];
  const restore = restoreEntry;
  const session = signSessionRequest(SessionSecretKey.fromSeed(fill(32, 0x5e)), {
    audience: "https://accounts.clawtrate.dev",
    challenge: fill(32, 0x66),
    issuedAtMs: 1_795_000_000_000,
    method: "POST",
    path: "/v1/devices",
    body: new TextEncoder().encode('{"platform":"macos"}'),
  });
  // The transcript hash is the 32 bytes before the reveal's signature.
  const transcriptHash = run.reveal.subarray(run.reveal.length - 96, run.reveal.length - 64);
  return {
    world,
    gateway,
    mac,
    run,
    added,
    finished,
    refusal,
    notice,
    byPage,
    restore,
    removal,
    next,
    rotation,
    entries,
    session,
    transcriptHash,
  };
}

function vectors(): Record<string, unknown> {
  const s = scenario();
  return {
    inputs: {
      gatewayId: toHex(CONTEXT.gatewayId),
      accountId: toHex(CONTEXT.accountId),
      note: "Seeds, nonces and pins are single bytes repeated; see test/helpers.ts.",
    },
    keys: {
      connectorList: toHex(s.world.connector.publicKey.bytes),
      gatewayDeviceList: toHex(s.gateway.device.listKey.bytes),
      gatewayDeviceSeal: toHex(s.gateway.device.sealKey.bytes),
      macList: toHex(s.mac.device.listKey.bytes),
      macSeal: toHex(s.mac.device.sealKey.bytes),
      session: toHex(SessionSecretKey.fromSeed(fill(32, 0x5e)).publicKey.bytes),
    },
    card: toHex(s.world.card),
    cardHash: toHex(cardHash(s.world.card)),
    entries: {
      genesis: toHex(s.entries[0]!),
      add: toHex(s.entries[1]!),
      removeOnNotice: toHex(s.entries[2]!),
      restore: toHex(s.entries[3]!),
      remove: toHex(s.entries[4]!),
      hashes: s.entries.map((entry) => toHex(entryHash(entry))),
    },
    removalNotice: toHex(s.notice),
    join: {
      commit: toHex(s.run.commit),
      answer: toHex(s.run.answer),
      reveal: toHex(s.run.reveal),
      transcriptHash: toHex(s.transcriptHash),
      words: s.run.words,
      sets: s.run.sets,
      rightIndex: s.run.right,
      confirm: toHex(s.added.confirm),
    },
    refusal: toHex(s.refusal),
    rotation: toHex(s.rotation),
    sealed: {
      list: toHex(sealList(s.world.secret, CONTEXT, s.entries, fill(32, 0x71))),
      card: toHex(sealCard(s.world.secret, CONTEXT, s.world.card, fill(32, 0x72))),
      entry: toHex(sealEntry(s.world.secret, CONTEXT, s.entries[1]!, fill(32, 0x73))),
    },
    session: toHex(s.session),
  };
}

describe("known-answer vectors", () => {
  it("match the committed file byte for byte", () => {
    const made = vectors();
    if (process.env.WRITE_VECTORS === "1")
      writeFileSync(FILE, `${JSON.stringify(made, null, 2)}\n`);
    expect(made).toEqual(JSON.parse(readFileSync(FILE, "utf8")));
  });

  it("carry signatures Node's own Ed25519 accepts, over exactly the bytes in front of them", () => {
    const s = scenario();
    const connector = s.world.connector.publicKey.bytes;
    const gateway = s.gateway.device.listKey.bytes;
    checkSigned(s.entries[0]!, [connector, gateway]);
    checkSigned(s.entries[1]!, [gateway]);
    checkSigned(s.entries[2]!, [connector]);
    checkSigned(s.entries[3]!, [gateway]);
    checkSigned(s.entries[4]!, [gateway]);
    checkSigned(s.world.card, [connector]);
    checkSigned(s.run.reveal, [s.mac.device.listKey.bytes]);
    checkSigned(s.added.confirm, [gateway]);
    checkSigned(s.refusal, [gateway]);
    checkSigned(s.rotation, [connector]);
    checkSigned(s.session, [SessionSecretKey.fromSeed(fill(32, 0x5e)).publicKey.bytes]);
  });

  it("let N open the card the words covered, and the remaining devices open the rotation", () => {
    const s = scenario();
    expect(s.finished.card.name).toBe("Windows PC");
    const opened = openRotation(
      { listKey: s.gateway.device.listKey, sealKey: s.gateway.sealKey },
      s.removal.state,
      s.rotation,
      s.world.secret,
    );
    expect(opened.epoch).toBe(1);
  });
});

describe("the word list", () => {
  it("is the published BIP-39 English list, byte for byte", () => {
    const hash = createHash("sha256").update(`${WORDLIST_TEXT}\n`).digest("hex");
    expect(hash).toBe("2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
    const words = WORDLIST_TEXT.split("\n");
    expect(words).toHaveLength(2048);
    expect(new Set(words).size).toBe(2048);
  });
});
