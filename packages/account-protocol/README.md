# @clawtrate/account-protocol

The signing, device list and join of a Clawtrate account, as the account design (`docs/design/accounts.md`, #641, §4.2, §4.4 steps 1 to 5 and §4.6) has them: the keys and what each may sign, the device list, the join with its three words and decoys, the gateway's sealed card, the list secret, and the session request a device signs for the account service. The connector, the account service and the apps will build on it. Nothing imports it yet.

**It has not had its independent cryptographic review. Nothing builds on it until it has.**

It does no I/O and has no clock or random source of its own: every time and every random byte comes in as an argument, so it runs the same in Node, Electron, a Worker and the phone app, and every test is deterministic. It uses `@noble/curves`, `@noble/hashes` and `@noble/ciphers` at the versions the repository pins, `TextEncoder` and `TextDecoder` (with `fatal: true` and `ignoreBOM: true`) and nothing else. It imports nothing from `packages/relay-protocol`.

The rule it exists for: signing in never admits a device; only a signature from one of the person's own devices does, and the account service holds nothing that can sign. Here that means: the list grows only by an entry signed with a device member's list key; no function signs bytes a caller hands it, each builds its object's bytes from that object's fields; and every signed object starts with a label of its own, so a signature made for one kind never verifies as another.

## Constructions, and why each

| What                             | Construction                                                                                                                                     | Why                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signatures                       | Ed25519 (RFC 8032), verified with RFC 8032's strict decoding (`zip215: false`)                                                                   | The design names Ed25519. Strict decoding gives each signature one accepted form.                                                                                                                                          |
| Public keys accepted             | The canonical encoding of a point in the prime-order subgroup, not of small order                                                                | A small-order or mixed key would let anyone make signatures that verify under it; one encoding per key keeps "already on the list" exact.                                                                                  |
| Hash, and its domain separation  | SHA-256 over a fixed tag, then the input: `taggedHash(tag, …parts)`                                                                              | The plain standard hash in `@noble/hashes`. Tags are fixed ASCII strings ending in a newline, none a prefix of another, and every part after one is fixed-length or a complete encoding, so inputs can't run into another. |
| Signed bytes                     | The object's label, then its fields, then the signature over all of that                                                                         | The design's "label in front of the payload", applied to the whole object, so the bytes signed are the bytes sent.                                                                                                         |
| Key derivation                   | HKDF-SHA256 (RFC 5869)                                                                                                                           | The standard extract-and-expand KDF; HPKE uses it too.                                                                                                                                                                     |
| Sealing with the list secret     | XChaCha20-Poly1305, its key HKDF-SHA256 of the secret, a fresh 24-byte random nonce from the caller                                              | A 24-byte nonce can be random without counting, and the same secret seals many things. The header and the gateway and account ids are the associated data.                                                                 |
| Sealing to one device's key      | HPKE (RFC 9180), base mode, single-shot: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305                                              | The standard construction for encrypting to a public key. Written from the RFC and checked against its test vector A.2.1. `@noble` has the parts but not HPKE itself.                                                      |
| The device's sealing key         | X25519, from 32 random bytes through HPKE's `DeriveKeyPair`                                                                                      | HPKE needs a key-exchange key; Ed25519 keys are kept for signing alone rather than converted.                                                                                                                              |
| Three words from the transcript  | The first 33 bits of `taggedHash(words tag, transcript hash)`, 11 bits per word, as indexes into the BIP-39 English list                         | 2,048 is 2^11, so each word is uniform with no rejection or modulo.                                                                                                                                                        |
| Decoys and the right set's place | HKDF-SHA256 expanded from the member's 32-byte decoy seed (salt: the transcript hash) to 1,024 bytes; words by rejection, the place by rejection | Uniform words without bias (two bytes, low 11 bits), redrawn when a word is used; the place is a byte below 250 taken modulo 5. The seed never leaves the member.                                                          |
| Commitment                       | `taggedHash(commitment tag, gateway id, account id, N's record, N's 32-byte nonce)`                                                              | A hash commitment with a 256-bit random value hides the record and binds N to it before A answers.                                                                                                                         |
| Session request                  | Ed25519 by the session key over a structure the device builds; the service's challenge is the only value it chose                                | Section 4.2's rule.                                                                                                                                                                                                        |
| TLS pins                         | SHA-256 of the key's DER SubjectPublicKeyInfo, 32 bytes                                                                                          | The usual pin of a TLS key (as in RFC 7469), independent of the key's algorithm: Ed25519 on computers, P-256 on iPhone.                                                                                                    |
| The word list                    | BIP-39's English list of 2,048 words                                                                                                             | The design asks for three words from 2,048 and names no list; this one is standard, permissively licensed.                                                                                                                 |

## Keys

Each key and purpose is its own class, so one can't be passed where another is expected. A public key class checks its bytes when it is made; a secret key class is made from 32 random bytes the caller supplies, and its secret is reachable only by this package's own signing and opening functions (never printed, serialised or exported).

| Class                                  | Algorithm | Held by                        | Signs or opens, and nothing else                                                                                                                              |
| -------------------------------------- | --------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionSecretKey`, `SessionPublicKey` | Ed25519   | each device                    | Session requests.                                                                                                                                             |
| `ListSecretKey`, `ListPublicKey`       | Ed25519   | each device, and the connector | List entries, refusals and the join's reveal and confirmation (a device); the first entry, the card, removals and the list secret's rotation (the connector). |
| `SealSecretKey`, `SealPublicKey`       | X25519    | each device                    | Opens the list secret and card sealed to it.                                                                                                                  |
| `GatewayDeviceKey`                     | Ed25519   | each device (OpenClaw's own)   | Not used here; recorded so the connector can match pairing requests to it.                                                                                    |
| `ListSecret`                           | 32 bytes  | the connector and each device  | Seals the list, the card and entries on their way.                                                                                                            |

## Encoding

One encoding for everything signed, hashed or sealed:

- `u8`, `u16`, `u32`: unsigned big-endian integers of 1, 2 and 4 bytes. `u64`: 8 bytes big-endian, at most 2^53 − 1.
- `bytes[n]`: exactly `n` bytes.
- `var`: a `u16` length, then that many bytes, within the field's bounds.
- `text`: a `var` holding UTF-8, decoded strictly (no overlong forms, no surrogates, a byte-order mark kept as a character), holding no control character (`\p{Cc}`) and no bidirectional formatting character (`\p{Bidi_Control}`).
- `label`: the object's label, exactly, as ASCII. The same kind's label with another version is refused as `unsupported_version`.
- `context`: the gateway's random id, `bytes[16]`, then the account's id, `bytes[16]`. Every object carries it or is sealed under it.

Nothing is optional and nothing is skipped; a decoder refuses bytes cut short or left over, an unknown enum value, a length over its bound and a key that isn't one, so a value has exactly one encoding.

### Labels and tags

Labels begin an object; tags begin a hash or derivation input and are never the start of an encoding.

| Label                                    | Object                                    |
| ---------------------------------------- | ----------------------------------------- |
| `clawtrate account session request v1\n` | session request (37 bytes)                |
| `clawtrate account list entry v1\n`      | list entry (32)                           |
| `clawtrate account removal notice v1\n`  | the account page's removal, unsigned (36) |
| `clawtrate account refusal v1\n`         | refusal (29)                              |
| `clawtrate account card v1\n`            | the gateway's card (26)                   |
| `clawtrate account join transcript v1\n` | every join message, then a step byte (37) |
| `clawtrate account list secret v1\n`     | the list secret's rotation (33)           |

Tags, each `clawtrate account <purpose> v1\n`: `entry hash`, `card hash`, `join commitment`, `join transcript hash`, `join words`, `join decoys`, `session body`, `list seal key`, `list sealed`, `device seal`.

## Objects, byte for byte

`sig(K)` is a 64-byte Ed25519 signature by `K` over every byte of the object before it (for the first entry, before the first of its two signatures).

**Device record** (`record`): `bytes[32]` list key, `bytes[32]` seal key, `bytes[32]` TLS pin, `bytes[32]` gateway device key, `u8` platform (1 macOS, 2 Windows, 3 Linux, 4 iOS), `text` name (1 to 64 bytes). The name is what the device says; nothing checks it, so members show it as "says it is".

**List entry**: `label`, `context`, `u32` position (0 for the first), `bytes[32]` previous entry's hash (zeros for the first), `u8` type, then:

| Type      | Fields                                                                               | Signatures                              |
| --------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| 1 first   | `bytes[32]` connector key, `record` of the linking device                            | `sig(connector)`, `sig(linking device)` |
| 2 add     | `record`, `bytes[32]` join transcript hash, `bytes[32]` signer                       | `sig(signer)`                           |
| 3 remove  | `u8` origin (1 a member, 2 the account page), `bytes[32]` target, `bytes[32]` signer | `sig(signer)`                           |
| 4 restore | `bytes[32]` target, `bytes[32]` signer                                               | `sig(signer)`                           |

An entry's hash is `taggedHash(entry hash, the whole entry with its signatures)`. The list as one byte string, for sealing: `u16` count, then each entry as a `var`.

**Removal notice** (the account page's removal, unsigned): `label`, `context`, `bytes[32]` target.

**Refusal**: `label`, `context`, `bytes[32]` the list's latest entry hash, `bytes[32]` the join's commitment, `u8` reason (1 a wrong set picked, 2 none match, 3 not started by me, 4 two joins at once), `bytes[32]` signer, `sig(signer)`.

**Card**: `label`, `bytes[16]` gateway id, `u32` serial, `bytes[32]` connector key, `bytes[32]` the connector's TLS pin, `u8` address count (1 to 8), each address a `text` host (1 to 253 bytes of `0-9 a-z . : -`) and a `u16` port (1 to 65535), `text` the gateway's name (1 to 64 bytes), `sig(connector key named in it)`. Its hash is `taggedHash(card hash, the whole card)`.

**Join messages**: `label`, `u8` step, `context`, then:

| Step      | From | Fields                                                                                                                                         |
| --------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 commit  | N    | `bytes[32]` commitment                                                                                                                         |
| 2 answer  | A    | `bytes[32]` commitment, `bytes[32]` A's list key, `bytes[32]` the list's latest entry hash, `bytes[32]` the card's hash, `bytes[32]` A's nonce |
| 3 reveal  | N    | `record`, `bytes[32]` N's nonce, `bytes[32]` transcript hash, `sig(N's list key)`                                                              |
| 4 confirm | A    | `bytes[32]` transcript hash, `var` the add entry (up to 456 bytes), `bytes[32]` HPKE `enc`, `var` HPKE ciphertext, `sig(A's list key)`         |

The HPKE plaintext in a confirmation: `u32` epoch, `bytes[32]` list secret, `var` the signed card. Its `info`: `device seal` tag, `u8` 1, gateway id, account id, transcript hash. No associated data.

**Rotation of the list secret**: `label`, `context`, `u32` epoch, `u8` count (1 to 32), each share `bytes[32]` recipient's list key, `bytes[32]` HPKE `enc`, `bytes[48]` HPKE ciphertext of the 32-byte secret; `sig(connector)`. Each share's `info`: `device seal` tag, `u8` 2, gateway id, account id, `u32` epoch, recipient's list key.

**Sealed with the list secret**: `u8` version 1, `u8` kind (1 the list, 2 the card, 3 an entry), `u32` epoch, `bytes[24]` nonce, then the XChaCha20-Poly1305 ciphertext with its 16-byte tag. The key is HKDF-SHA256 of the secret, no salt, `info` the `list seal key` tag, 32 bytes. The associated data is the `list sealed` tag, the 30-byte header, the gateway id and the account id.

**Session request**: `label`, `text` audience (the service's origin, `https://host[:port]` in lowercase with a DNS name or IPv4 address as host, no IPv6 literal, or `http:` on loopback only), `bytes[32]` session key, `bytes[32]` the service's challenge, `u64` the device's time in milliseconds, `u8` method (1 GET, 2 POST, 3 PUT, 4 DELETE), `text` path (`/` then printable ASCII, up to 512 bytes), `bytes[32]` `taggedHash(session body, body)`, `sig(session key)`.

## The list

`ListState` is what a verifier knows after an entry: the current members with their roles (`connector`, `gateway-device` for the first entry's device, `device`), who added each, the removed ones and how, and every key and pin any device has had. `verifyList(context, entries)` checks a list from its first entry; `state.append(entry)` checks the next one. Each check runs in this order and stops at the first failure: the bytes; the signature (so any change to a signed field is `bad_signature`); the gateway and account; the position and previous hash (`bad_chain` for a reordered, repeated or forked entry); the signer is a current member (`not_member`, `removed_member`); then the rules:

| Entry                       | Who may sign it                       | What it needs                                                                                                                              |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| first                       | the connector and the linking device  | position 0, zero previous hash, two different keys                                                                                         |
| add                         | a device member, never the connector  | no key or pin of the record is or was on the list (`duplicate_key`); fewer than 32 devices (`list_full`). Built only by the join's step 5. |
| remove, by a member         | any member, the connector included    | the target is a current member and not the connector (`protected_member`)                                                                  |
| remove, by the account page | the connector alone (`not_permitted`) | as above, and the target is not the gateway's own device (`protected_member`)                                                              |
| restore                     | a device member, never the connector  | the target's latest removal came from the account page (`bad_target`); fewer than 32 devices. It comes back with its record as it was.     |

The connector is removed only by unlinking, which ends the list; no entry removes it. A list holds at most 1,024 entries (`list_full`). `state.addedBy(key)` names the current members an entry by `key` added, which removing `key` offers to remove too.

Who appends: a member sends its entry (sealed with the list secret) through the service to the connector, which appends it with `append` to the list it holds; the connector's list is the one that counts. A list cut short after any entry still verifies: a member shown an old list by the service sees an old state, and the join refuses to go on when A's list is behind the connector's, because the entry would not follow.

## The join

N is the new device, A a device member. Each step is a function that takes every message so far and checks all of them again, so none can be skipped or run out of order; nothing is kept between calls. The service carries every message.

1. **`joinCommit`** (N): the commitment to N's record (every public key, the TLS pin, the name and platform) and N's 32-byte random nonce.
2. **`joinAnswer`** (A): A must be a current device member, and its card must be signed by the list's connector. The answer holds A's list key, the list's latest entry hash, the card's hash and A's 32-byte random nonce. A has not seen N's keys.
3. **`joinReveal`** (N): checks that the commit is its own and that the answer answers it. Computes the transcript hash over the gateway id, account id, commitment, A's key, the list head, the card hash, A's nonce, N's record and N's nonce, and signs it with its list key, which also proves it holds that key. Returns the reveal and N's three words.
4. **`joinChoices`** (A): checks that the answer is its own and answers the commit; that its list and card are still the ones it answered with (`bad_chain`, `card_mismatch`); that the reveal opens the commitment (`commitment_mismatch`); that the reveal's transcript hash is the one A computes (`transcript_mismatch`) and its signature verifies; and that N's keys are new to the list. Returns five sets: the right one at a uniformly random place, and four decoys from A's 32-byte decoy seed, which A never sends, sharing no word with the right set or each other.
5. **`joinConfirm`** (A): the same checks, then the pick. The right set signs the entry adding N (with the transcript hash) and seals the list secret and the card to N's seal key; the confirmation is signed by A. A wrong set, "None of these match" or "I didn't start this" signs a refusal instead. `refuseJoin` signs one without a pick (before the sets, or for two joins at once). `verifyRefusal` is the connector's check of a refusal; the pause after one (`JOIN_PAUSE_MS`, an hour) is the connector's to keep.
6. **`joinFinish`** (N): checks that the confirmation answers this transcript and is signed by the member key the words covered; that its entry adds exactly N's record, after the list head the words covered, signed by that member; then opens the sealed delivery, and checks that the card's hash is the one the words covered and that the card is signed by the connector key it names. Before using the list, N opens the sealed list with the secret, runs `verifyList`, and checks the card with `checkCardForList`.

Against someone in the middle: N commits before seeing A's nonce and A answers before seeing N's keys, so a party that swaps either side's keys gets matching words only with probability 2^-33 per try, and can't try in advance. A replayed reveal fails against a fresh answer (its signature covers A's nonce), an old confirmation fails against a new transcript, and an entry appended twice fails the chain. A person who picks without the new device in front of them is right one time in six.

## The list secret

The connector makes the first secret (epoch 0) and gives it to the linking device on the gateway's machine, which never involves the service, so the package has no message for it; each joining device gets the current secret in its confirmation. When a member is removed, the connector makes a new secret with the next epoch and `rotateListSecret` seals it to each current device member alone, signed by the connector. `openRotation` checks the connector's signature, the gateway and account, and that the epoch is newer than the secret held (`stale_secret`). The connector then reseals the list and the card under the new secret. A removed device has no share, and its old secret opens nothing sealed after: the epoch is in the header and the associated data, and the key is another.

## Bounds

| Bound                    | Value                          | Why                                                                                                                         |
| ------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Devices on a list        | 32 (`MAX_MEMBERS`)             | Far more than one person's computers and phones; bounds a rotation to 32 shares.                                            |
| Entries in a list        | 1,024 (`MAX_ENTRIES`)          | About 500 joins and removals; bounds verifying a list from its start. The largest list is 468,994 bytes (`MAX_LIST_BYTES`). |
| An entry                 | 456 bytes (`MAX_ENTRY_BYTES`)  | The first entry with the longest name; checked by a test.                                                                   |
| A name                   | 64 bytes of UTF-8              | A line on a screen: 16 to 64 characters, depending on the script.                                                           |
| Addresses on a card      | 8, each host up to 253 bytes   | A LAN address, a private-network name and a few more; 253 is the longest DNS name.                                          |
| A card                   | 2,297 bytes (`MAX_CARD_BYTES`) | Follows from the fields above; checked by a test.                                                                           |
| A session audience, path | 255 and 512 bytes              | An origin and an API path.                                                                                                  |
| A session body           | 1 MiB                          | Hashed, not stored; bounds the work per request.                                                                            |
| A session request's time | 60 seconds either way          | Clock skew between a device and the service; the challenge is the replay guard.                                             |
| A refusal's pause        | 1 hour (`JOIN_PAUSE_MS`)       | The design's figure; kept by the connector.                                                                                 |

## Errors

Every refusal throws `AccountProtocolError` with a `code` (see `src/errors.ts`). Messages are fixed text: no key, secret, nonce or value from the input is ever in one. Secret bytes are compared in constant time where they are compared at all (`equalBytes`); the AEADs compare their own tags.

## What the package does not do

- No I/O, no storage, no clock and no randomness. Callers supply 32 random bytes for each key, nonce and seed, 24 for each list-secret nonce, and the time.
- It doesn't keep the join's pause, decide when to rotate, or remember refusals already seen: that is the connector's (A5).
- It doesn't make or check passes, TLS certificates, the direct listener, or anything the gateway is asked.
- Unlinking, the headless server's first device (design §8.4) and a second gateway per account are not here.
- It checks a name's characters, not its meaning: two devices may say the same name.
- It doesn't wipe secrets from memory; JavaScript can't promise that.

## Checks

`test/` holds the known-answer vectors (`test/vectors/account-v1.json`, every signed object, the transcript, the words and each sealed thing, from fixed keys and randomness, with every signature also checked by Node's own Ed25519), RFC 9180's HPKE vector, the word list's published hash, a cross-kind check of every pair of signed kinds under one key, a field-by-field tamper check of every message, the join against someone in the middle, every list refusal, the secret's rotation and a removed member's blindness, the bounds, and seeded fuzzing of every decoder and of list verification.

## Licence

`src/wordlist.ts` is the BIP-39 English word list, from `trezor/python-mnemonic` under the MIT licence; [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) records its source and notice.
