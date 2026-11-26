# @clawtrate/account-protocol

The signing, device list and join of a Clawtrate account, as the account design (`docs/design/accounts.md`, #641, §4.2, §4.4 steps 1 to 5 and §4.6) has them: the keys and what each may sign, the device list, the join with its three words and decoys, the gateway's sealed card, the list secret, and the session request a device signs for the account service. The connector, the account service and the apps will build on it. Nothing imports it yet.

**An independent cryptographic review found changes it needed; this version makes them, and awaits a confirming review. Nothing builds on it until that review says it is sound.**

It does no I/O and has no clock or random source of its own: every time and every random byte comes in as an argument, so it runs the same in Node, Electron, a Worker and the phone app, and every test is deterministic. Where a random value matters to the join or the sealing, the package derives it, or hedges the caller's bytes with secret key material, so a repeated or predictable argument can't weaken it. It uses `@noble/curves`, `@noble/hashes` and `@noble/ciphers` at the versions the repository pins, `TextEncoder` and `TextDecoder` (with `fatal: true` and `ignoreBOM: true`) and nothing else. It imports nothing from `packages/relay-protocol`.

The rule it exists for: signing in never admits a device; only a signature from one of the person's own devices does, and the account service holds nothing that can sign. Here that means: the list grows only by an entry signed with a device member's list key after a person's pick; no function signs bytes a caller hands it whole, each builds its object's bytes from that object's fields; and every signed object starts with a label of its own, so a signature made for one kind never verifies as another.

## Constructions, and why each

| What                             | Construction                                                                                                                                                                               | Why                                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signatures                       | Ed25519 (RFC 8032): strict decoding of R and A (not ZIP-215), S below the group order, and R refused unless it is in the prime-order subgroup                                              | With A and R both free of small-order parts, the cofactored check noble runs and the cofactorless one of RFC 8032 and OpenSSL accept the same signatures, so two implementations never disagree about a list (fixed vectors in `ed25519-edges.json`).            |
| Public keys accepted             | Ed25519: the canonical encoding of a point in the prime-order subgroup, not of small order. X25519: a canonical u-coordinate whose Edwards point exists and is in the prime-order subgroup | A small-order or mixed key would let anyone make signatures that verify under it, and an X25519 key plus a small-order point is the same key under another encoding. One encoding per key keeps "already on the list" exact.                                     |
| Secret keys                      | HKDF-SHA256 of the caller's 32 random bytes, no salt, with the key's own tag as info (`session key`, `list key`, `seal key`), then the algorithm's own key generation                      | The same random bytes never give the same key in two roles.                                                                                                                                                                                                      |
| Hash, and its domain separation  | SHA-256 over a fixed tag, then the input: `taggedHash(tag, …parts)`                                                                                                                        | Tags are fixed ASCII strings ending in a newline, none a prefix of another, and every part after one is fixed-length or a complete encoding, so inputs can't run into another.                                                                                   |
| Signed bytes                     | The object's label, then its fields, then the signature over all of that                                                                                                                   | The design's "label in front of the payload", applied to the whole object, so the bytes signed are the bytes sent.                                                                                                                                               |
| Key derivation                   | HKDF-SHA256 (RFC 5869)                                                                                                                                                                     | The standard extract-and-expand KDF; HPKE uses it too.                                                                                                                                                                                                           |
| Sealing with the list secret     | XChaCha20-Poly1305, its key HKDF-SHA256 of the secret; a synthetic 24-byte nonce (below); the header and the gateway and account ids as associated data                                    | A synthetic nonce means a repeated random argument reveals at most that two sealed plaintexts were equal.                                                                                                                                                        |
| Sealing to one device's key      | HPKE (RFC 9180), base mode, single-shot: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305                                                                                        | The standard construction for encrypting to a public key. Written from the RFC and checked against its vectors (A.1.1's key encapsulation, all of A.2.1). Every sealed delivery sits inside an object its sender signs, since base mode authenticates no sender. |
| Three words from the transcript  | The first 33 bits of `taggedHash(words tag, transcript hash)`, 11 bits per word, as indexes into the BIP-39 English list                                                                   | 2,048 is 2^11, so each word is uniform with no rejection or modulo.                                                                                                                                                                                              |
| Decoys and the right set's place | 1,024 bytes of HKDF-SHA256 of A's list key's random bytes, salted with the transcript hash, with the `join decoys` tag as info; words by rejection, the place by rejection                 | Secret to A and the same for one transcript, so there is nothing to store between showing and confirming. Uniform words (two bytes, low 11 bits), redrawn when used; the place is a byte below 250 taken modulo 5.                                               |
| Commitment                       | `taggedHash(commitment tag, gateway id, account id, N's record, N's 32-byte nonce)`                                                                                                        | A hash commitment with a 256-bit value no one without N's key can predict hides the record and binds N to it before A answers.                                                                                                                                   |
| Session request                  | Ed25519 by the session key over a structure the device builds; the service's challenge is the only value it chose                                                                          | Section 4.2's rule.                                                                                                                                                                                                                                              |
| TLS pins                         | SHA-256 of the key's DER SubjectPublicKeyInfo, 32 bytes                                                                                                                                    | The usual pin of a TLS key (as in RFC 7469), independent of the key's algorithm: Ed25519 on computers, P-256 on iPhone.                                                                                                                                          |
| The word list                    | BIP-39's English list of 2,048 words                                                                                                                                                       | The design asks for three words from 2,048 and names no list; this one is standard, permissively licensed.                                                                                                                                                       |

### Values the package derives or hedges

Each is one HKDF-SHA256 call or one HMAC-SHA256 call; "the key's random bytes" are the 32 bytes the key was made from, which only this package reads.

- **N's nonce:** HKDF-SHA256 with N's list key's random bytes as input, the caller's 32 random bytes as salt, and as info the `join new nonce` tag, the gateway and account ids and N's encoded record.
- **A's answer nonce:** HKDF-SHA256 with A's list key's random bytes as input, no salt, and as info the `join answer nonce` tag, the gateway and account ids and the commitment. No caller randomness: the same commitment always gets the same answer.
- **The decoys:** 1,024 bytes of HKDF-SHA256 with A's list key's random bytes as input, the transcript hash as salt and the `join decoys` tag as info.
- **A confirmation's HPKE ephemeral input:** HKDF-SHA256 with A's list key's random bytes as input, the caller's 32 random bytes as salt, and as info the `join ephemeral` tag followed by the delivery's HPKE `info` (which holds the transcript hash).
- **A rotation share's HPKE ephemeral input:** HKDF-SHA256 with the connector key's random bytes as input, the caller's 32 random bytes as salt, and as info the `rotation ephemeral` tag followed by the share's HPKE `info` (which holds the epoch and the recipient).
- **The list seal's nonce:** the first 24 bytes of HMAC-SHA256, keyed with HKDF-SHA256 of the list secret (no salt, `list seal nonce` tag as info), over the `list seal nonce` tag, the version, kind and epoch, the gateway and account ids, the caller's 32 random bytes and the plaintext.

A hedged value can't be predicted by anyone without the key, whatever the caller's bytes are; with fresh caller bytes it can't be predicted even by someone who learns the key.

## Keys

Each key and purpose is its own class, so one can't be passed where another is expected. A public key class checks its bytes when it is made; a secret key class is made from 32 random bytes the caller supplies, derived for its purpose (above), and its secret is reachable only by this package's own signing, opening and derivation functions (never printed, serialised or exported). Every key, secret and state object is frozen, and the package's internal files can't be imported from outside it (a lint rule for the whole repository).

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
- `text`: a `var` holding UTF-8, decoded strictly (no overlong forms, no surrogates), holding no control character (`\p{Cc}`), no bidirectional formatting character (`\p{Bidi_Control}`) and no invisible one (`\p{Default_Ignorable_Code_Point}`, which includes a byte-order mark and zero-width characters).
- `label`: the object's label, exactly, as ASCII. The same kind's label with another version is refused as `unsupported_version`.
- `context`: the gateway's random id, `bytes[16]`, then the account's id, `bytes[16]`. Every object carries it or is sealed under it.

Nothing is optional and nothing is skipped; a decoder refuses bytes cut short or left over, an unknown enum value, a length over its bound and a key that isn't one, so a value has exactly one encoding. Every public function copies its byte arguments once on entry and works on the copy.

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

Tags, each `clawtrate account <purpose> v1\n`: `entry hash`, `card hash`, `join commitment`, `join transcript hash`, `join words`, `join decoys`, `session body`, `list seal key`, `list sealed`, `device seal`, `session key`, `list key`, `seal key`, `join new nonce`, `join answer nonce`, `join ephemeral`, `rotation ephemeral`, `list seal nonce`, `refusal hash`.

## Objects, byte for byte

`sig(K)` is a 64-byte Ed25519 signature by `K` over every byte of the object before it (for the first entry, before the first of its two signatures).

**Device record** (`record`): `bytes[32]` list key, `bytes[32]` seal key, `bytes[32]` TLS pin, `bytes[32]` gateway device key, `u8` platform (1 macOS, 2 Windows, 3 Linux, 4 iOS), `text` name (1 to 64 bytes). The name is what the device says; nothing checks it, so members show it as "says it is". Only the list key is proven, by the reveal's signature; the TLS pin, the gateway device key and the seal key are claimed here and proven later, by the TLS handshake, the connector's door and use.

**List entry**: `label`, `context`, `u32` position (0 for the first), `bytes[32]` previous entry's hash (zeros for the first), `u8` type, then:

| Type      | Fields                                                                               | Signatures                              |
| --------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| 1 first   | `bytes[32]` connector key, `record` of the linking device                            | `sig(connector)`, `sig(linking device)` |
| 2 add     | `record`, `bytes[32]` join transcript hash, `bytes[32]` signer                       | `sig(signer)`                           |
| 3 remove  | `u8` origin (1 a member, 2 the account page), `bytes[32]` target, `bytes[32]` signer | `sig(signer)`                           |
| 4 restore | `bytes[32]` target, `bytes[32]` signer                                               | `sig(signer)`                           |

An entry's hash is `taggedHash(entry hash, the whole entry with its signatures)`. The list as one byte string, for sealing: `u16` count, then each entry as a `var`.

**Removal notice** (the account page's removal, unsigned): `label`, `context`, `bytes[32]` target.

**Refusal**: `label`, `context`, `bytes[32]` the list's latest entry hash, `bytes[32]` the join's commitment, `u8` reason (1 a wrong set picked, 2 none match, 3 not started by me, 4 two joins at once), `bytes[32]` signer, `sig(signer)`. Its hash, by which the connector takes it once, is `taggedHash(refusal hash, the whole refusal)`.

**Card**: `label`, `bytes[16]` gateway id, `u32` serial, `bytes[32]` connector key, `bytes[32]` the connector's TLS pin, `u8` address count (1 to 8), each address a `text` host and a `u16` port (1 to 65535), `text` the gateway's name (1 to 64 bytes), `sig(connector)`. A host has one form: an IPv4 dotted quad with no leading zeros; a lowercase DNS name whose every label starts with a letter (1 to 63 bytes of letters, digits and inner hyphens); or an IPv6 address in brackets in its shortest lowercase form (RFC 5952). No port goes in a host. A device builds the address as `wss://<host>:<port>/`. Its hash is `taggedHash(card hash, the whole card)`. A card is checked against the connector key the reader already trusts (the list's, from its first entry), never against the key the card names.

**Join messages**: `label`, `u8` step, `context`, then:

| Step      | From | Fields                                                                                                                                         |
| --------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 commit  | N    | `bytes[32]` commitment                                                                                                                         |
| 2 answer  | A    | `bytes[32]` commitment, `bytes[32]` A's list key, `bytes[32]` the list's latest entry hash, `bytes[32]` the card's hash, `bytes[32]` A's nonce |
| 3 reveal  | N    | `record`, `bytes[32]` N's nonce, `bytes[32]` transcript hash, `sig(N's list key)`                                                              |
| 4 confirm | A    | `bytes[32]` transcript hash, `var` the add entry (up to 456 bytes), `bytes[32]` HPKE `enc`, `var` HPKE ciphertext, `sig(A's list key)`         |

The HPKE plaintext in a confirmation: `u32` epoch, `bytes[32]` list secret, `var` the signed card. Its `info`: `device seal` tag, `u8` 1, gateway id, account id, transcript hash. No associated data.

**Rotation of the list secret**: `label`, `context`, `u32` epoch, `u8` count (1 to 32), each share `bytes[32]` recipient's list key, `bytes[32]` HPKE `enc`, `bytes[48]` HPKE ciphertext of the 32-byte secret; `sig(connector)`. Each share's `info`: `device seal` tag, `u8` 2, gateway id, account id, `u32` epoch, recipient's list key.

**Sealed with the list secret**: `u8` version 1, `u8` kind (1 the list, 2 the card, 3 an entry), `u32` epoch, `bytes[24]` nonce, then the XChaCha20-Poly1305 ciphertext with its 16-byte tag. The key is HKDF-SHA256 of the secret, no salt, `info` the `list seal key` tag, 32 bytes. The nonce is synthetic (above). The associated data is the `list sealed` tag, the 30-byte header, the gateway id and the account id.

**Session request**: `label`, `text` audience, `bytes[32]` session key, `bytes[32]` the service's challenge, `u64` the device's time in milliseconds, `u8` method (1 GET, 2 POST, 3 PUT, 4 DELETE), `text` path (`/` then printable ASCII, up to 512 bytes), `bytes[32]` `taggedHash(session body, body)`, `sig(session key)`. The audience is the service's origin, `https://host[:port]` in lowercase with a DNS name or IPv4 address as host (no IPv6 literal) and a port of 1 to 65535; `http:` on loopback is accepted only when the caller says it is a development build, because on a shared machine another user could listen on that port first. It relies on two things the service keeps: each session key belongs to exactly one account (no account id is signed), and each challenge is taken once and issued to this device alone.

## The list

`ListState` is what a verifier knows after an entry: the current members with their roles (`connector`, `gateway-device` for the first entry's device, `device`), who added each, the removed ones and how, and every key and pin the list has held. `verifyList(context, entries)` checks a list from its first entry; `state.append(entry)` checks the next one. Each check runs in this order and stops at the first failure: the bytes; the signature (so any change to a signed field is `bad_signature`); the gateway and account; the position and previous hash (`bad_chain` for a reordered, repeated or forked entry); for an add or a restore, the growth limit (`list_full`); the signer is a current member (`not_member`, `removed_member`); then the rules:

| Entry                       | Who may sign it                                                                     | What it needs                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| first                       | the connector and the linking device                                                | position 0, zero previous hash, no key appearing twice (the connector's key, and each of the device's keys)                                                                                         |
| add                         | a device member, never the connector                                                | no key of the record appears twice in it, and no key or pin of it is or was on the list in any role, the connector's key included (`duplicate_key`); fewer than 32 devices. Built only by the join. |
| remove, by a member         | any device member (`signRemoval`), or the connector (`signRemovalOnGatewayMachine`) | the target is a current member and not the connector (`protected_member`)                                                                                                                           |
| remove, by the account page | the connector alone (`signRemovalNotice`)                                           | as above, and the target is not the gateway's own device (`protected_member`)                                                                                                                       |
| restore                     | a device member, never the connector                                                | the target's latest removal came from the account page (`bad_target`); fewer than 32 devices. It comes back with its record as it was.                                                              |

The connector is removed only by unlinking, which ends the list; no entry removes it. Adds and restores are refused once a list holds 1,024 entries (`GROWTH_LIMIT`); a removal is never refused for the list's size, so no device can make itself impossible to remove, and a list holds at most 1,056 entries (`MAX_ENTRIES`). `state.addedBy(key)` names the current members an entry by `key` added.

The sign functions return only the entry: whether it is on the list is the connector's to decide when it appends it. Who appends: a member sends its entry (sealed with the list secret) through the service to the connector, which appends it with `openEntry` or `append` to the list it holds; the connector's list is the one that counts. The connector may refuse an entry a member signed (its list moved, a pause, a full list), so "Confirmed" on a member can come before the connector's refusal; the new device then holds the list secret and card without being a member, and gets no pass.

## The join

N is the new device, A a device member. Each side is an object with one-shot state kept inside the package; the service carries every message.

**The rules the words rest on.** The figure of one chance in 2^33 (about 8.6 billion) for someone in the middle holds only while N reveals at most once per commitment and A answers a commitment once. After one reveal, anyone who saw it can compute N's words for any answer, so a second reveal would let the service grind an answer offline until N shows the words a member is showing for the service's own device. So:

- `NewDeviceJoin` holds N's nonce privately and takes exactly one answer. The same answer again gets the same reveal, byte for byte (resuming after a dropped connection); any other answer ends the join for good (`join_spent`), and nothing more is revealed or finished.
- `MemberJoin` derives A's answer nonce from A's key and the commitment, so the same commitment always gets the same answer, byte for byte, and never a second, different one. It takes one reveal (the same reveal again gets the same sets) and confirms once.

The steps:

1. **`NewDeviceJoin.start(device, context, random)`** (N): the commitment to N's record (every public key, the TLS pin, the name and platform) and N's derived nonce; `commit` is the message.
2. **`MemberJoin.answer(member, commit)`** (A): A must be a current device member, and its card must verify against the list's connector key. The answer holds A's list key, the list's latest entry hash, the card's hash and A's derived nonce. A has not seen N's keys.
3. **`reveal(answer)`** (N): checks that the answer answers its commitment, computes the transcript hash over the gateway id, account id, commitment, A's key, the list head, the card hash, A's nonce, N's record and N's nonce, and signs it with its list key, which also proves it holds that key. Returns the reveal and N's three words.
4. **`choices(reveal)`** (A): checks that the reveal opens the commitment (`commitment_mismatch`), that its transcript hash is the one A computes (`transcript_mismatch`), that its signature verifies, and that N's keys are new to the list and fit in it. Returns five sets: the right one at a uniformly random place, and four decoys A derives, sharing no word with the right set or each other.
5. **`confirm(pick, random)`** (A): `pick` is the three words of the set the person picked, compared with the transcript's own words, or "none-match" or "not-started"; words that weren't among the five sets shown are refused. A right pick signs the entry adding N (with the transcript hash) and seals the list secret and the card to N's seal key inside A's signed confirmation. Anything else signs a refusal. `refuseJoin` signs one without a pick (before the sets, or for two joins at once). `verifyRefusal` is the connector's check of a refusal and returns its hash, so the connector takes each refusal once; the pause after one (`JOIN_PAUSE_MS`, an hour) is the connector's to keep.
6. **`finish(confirm, sealedList)`** (N): makes every check, in this order, before it hands anything back: (1) the confirmation answers this transcript and is signed by the member key the words covered; (2) its entry adds exactly N's record, carries this transcript and follows the head the words covered; (3) the delivery opens, and the card's hash is the one the words covered; (4) the sealed list opens with the delivered secret, verifies from its first entry, holds the covered head with N's entry (byte for byte the confirmation's) right after it, and has N as a current member; (5) the confirming device is a current device member of that list; (6) the card verifies against the connector key in that list's first entry and is for this gateway. Anything that fails throws, and nothing is returned. It finishes once.

Against someone in the middle: N commits before seeing A's nonce and A answers before seeing N's keys, each only once, so a party that swaps either side's keys gets matching words only with probability 2^-33 per try, and can't try in advance. An old confirmation fails against a new transcript, and an entry appended twice fails the chain. Someone who picks one of the five sets without looking at the new device is right one time in five; someone who presses any of the seven choices at random, one time in seven. Someone who compares only the first word, or two words, is protected only to 2^-11 or 2^-22. Anyone who can talk to the person can tell them the right set; the decoys don't help against that.

**What these checks don't settle:** they hold for a list and card that came from one of the person's devices. A service that runs its own connector and its own "member" under the real gateway's and account's ids passes every one of them, because the whole list is its own. The design's word back (§4.4 step 5a) is the answer to that; it is not in this version.

## The list secret

The connector makes the first secret (epoch 0) and gives it to the linking device on the gateway's machine, which never involves the service, so the package has no message for it yet; each joining device gets the current secret in its confirmation. When a member is removed, the connector makes a new secret with the next epoch and `rotateListSecret(connector, state, held, next, random)` seals it to each current device member alone, signed by the connector. It refuses a new secret whose epoch isn't higher than the held one's or whose bytes are the held ones (`stale_secret`): a removed device still has the old bytes. `openRotation` checks the connector's signature, the gateway and account, and that the epoch is newer than, and the secret differs from, the one held. The connector then reseals the list and the card under the new secret. A removed device has no share, and its old secret opens nothing sealed after: the epoch is in the header and the associated data, and the key is another.

`openList`, `openCard` and `openEntry` only open and verify together: a list comes back as its verified state, a card checked against the list's connector key and gateway, an entry appended to the given state.

## Bounds

| Bound                    | Value                                                   | Why                                                                                                                          |
| ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Devices on a list        | 32 (`MAX_MEMBERS`)                                      | Far more than one person's computers and phones; bounds a rotation to 32 shares.                                             |
| Growth of a list         | 1,024 entries (`GROWTH_LIMIT`), for adds and restores   | About 500 joins and removals; bounds verifying a list from its start.                                                        |
| Entries in a list        | 1,056 (`MAX_ENTRIES`): the growth limit and 32 removals | Removals are never refused, and at most 32 devices are left to remove. The largest list is 483,650 bytes (`MAX_LIST_BYTES`). |
| An entry                 | 456 bytes (`MAX_ENTRY_BYTES`)                           | The first entry with the longest name; checked by a test.                                                                    |
| A name                   | 64 bytes of UTF-8                                       | A line on a screen: 16 to 64 characters, depending on the script.                                                            |
| Addresses on a card      | 8, each host up to 253 bytes                            | A LAN address, a private-network name and a few more; 253 is the longest DNS name.                                           |
| A card                   | 2,297 bytes (`MAX_CARD_BYTES`)                          | Follows from the fields above; checked by a test.                                                                            |
| A session audience, path | 255 and 512 bytes                                       | An origin and an API path.                                                                                                   |
| A session body           | 1 MiB                                                   | Hashed, not stored; bounds the work per request.                                                                             |
| A session request's time | 60 seconds either way                                   | Clock skew between a device and the service; the challenge is the replay guard.                                              |
| A refusal's pause        | 1 hour (`JOIN_PAUSE_MS`)                                | The design's figure; kept by the connector.                                                                                  |

## Errors

Every refusal throws `AccountProtocolError` with a `code` (see `src/errors.ts`). Messages are fixed text: no key, secret, nonce or value from the input is ever in one.

## What is stated rather than enforced

- **Timing.** Secret bytes are compared in constant time where they are compared at all (`equalBytes`), and the AEADs compare their own tags. Every other comparison is of public values. Noble's Ed25519 and X25519 run on JavaScript's BigInt, which can't promise constant-time arithmetic. An HPKE opening runs only after a signature check, so no unauthenticated peer drives a seal key's Diffie-Hellman.
- **Neither AEAD commits to its key** (the list seal's XChaCha20-Poly1305 and HPKE's ChaCha20-Poly1305). No setting here needs it: everything sealed is a signed object checked again after opening, each opening tries exactly one key, and the keys are 256-bit random. If a sealed object ever carries meaning its signature doesn't cover, use a committing AEAD or prepend an HMAC of the key.
- **The words' numbers.** The words are bits 0 to 10, 11 to 21 and 22 to 32 of the words hash; the decoys and the place are uniform and secret to A. From its traffic the service learns only whether a pick was right, or which refusal reason came back.
- **Crossing protocols with OpenClaw's device signatures.** The package never signs with a gateway device key, every message it signs begins with `clawtrate account `, and no key may hold two roles on a list. Whether OpenClaw's own signed hello could ever begin with those bytes is not established here.
- **Only the list key's possession is proven at the join.** A member could list another device's OpenClaw key under its own entry; "says it is" and removing what a device added cover that.

## What the caller owes

- Fresh random bytes for every key and every `random` argument, from the system's random source, and fresh keys and a fresh `NewDeviceJoin` for every attempt: the same keys with the same random bytes give the same commitment, which a service may already have seen opened.
- Keeping one `NewDeviceJoin` per attempt and one `MemberJoin` per commitment, and never building a second from other bytes to get around one's refusal.
- The connector's part: keeping the pause, taking each refusal once by its hash, deciding when to rotate, never calling `signRemovalOnGatewayMachine` for a request that came through the service, and resealing the list and card after a rotation.
- The service's part: one account per session key, each challenge taken once.
- What the package can't wipe: JavaScript can't promise that a secret leaves memory.

## What the package does not do

- No I/O, no storage, no clock and no randomness of its own.
- It doesn't make or check passes, TLS certificates, the direct listener, or anything the gateway is asked.
- Not yet here (the design's next additions): the connector's signed head, rotations bound to it and on restore, the first secret's message, the word back, the withdrawal, the server's first entry and a fresh start of a list.
- It checks a name's characters, not its meaning: two devices may say the same name, and look-alike letters remain possible.

## Checks

`test/` holds: known-answer vectors (`test/vectors/account-v1.json`, every signed object, the transcript, the words and each sealed thing, from fixed keys and randomness, with every signature also checked by Node's own Ed25519); vectors from the standards (`test/vectors/standards.json`: RFC 8032's Ed25519 tests, RFC 9180's A.1.1 key encapsulation and A.2.1, the XChaCha20-Poly1305 draft's A.3.1) and the Ed25519 edge cases (`test/vectors/ed25519-edges.json`), each accepted here exactly when OpenSSL accepts it; the word list's published hash; a cross-kind check of every pair of eleven signed kinds under one key, and of each kind signed without its label; a field-by-field tamper check of every message; the one-shot rules and the derived values; hand-built, validly signed counter-examples for each of N's checks, the connector's refusal check and a rotation for another list; every list refusal, the growth limit with removals past it, the secret's rotation and a removed member's blindness; and seeded fuzzing of every decoder and of list verification.

## Licence

`src/wordlist.ts` is the BIP-39 English word list, from `trezor/python-mnemonic` under the MIT licence; [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) records its source and notice.
