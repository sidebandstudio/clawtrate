# @clawtrate/relay-protocol

The wire protocol for reaching a gateway through Clawtrate's relay: the frames a phone and a connector exchange end to end, the relay's own messages, the connector's register proof, and the Noise IK channel with phone enrollment. It does no I/O. The relay, the connector and the phone's socket are built on it.

It runs in Node, Electron, Cloudflare Workers and React Native. It uses `@noble/curves`, `@noble/ciphers` and `@noble/hashes`, pinned to exact versions, and three globals besides the language: `TextEncoder`, `TextDecoder` and, for the relay origin on the relay and the connector, `URL` ([`src/globals.d.ts`](src/globals.d.ts)). Random bytes come from `crypto.getRandomValues`; the options that take another source are for tests only. Every time the package compares is a nonnegative whole number of milliseconds; anything else fails closed.

## Who sees what

```
phone (Initiator) ── wss ──► relay ◄── wss ── connector (Responder) ── its own socket ──► gateway
```

- The relay pairs a phone's dial socket with a connector's session socket and passes binary messages unchanged. It sees the frame header (version and type), sizes, timing and addresses. It cannot read or change what the frames carry.
- The phone pins the connector's Noise static key from the pairing code. The connector lets in only phones it has enrolled. Neither grants anything on the gateway: the gateway's own pairing and approval still apply to every device.

## Keys

| Key                   | Held by   | Used for                                                                                                                                          |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ed25519 registration  | connector | Proving to the relay that it owns its relay id. The relay id is lowercase base32 of the first 16 bytes of SHA-256 over the public key (26 chars). |
| X25519 Noise static   | connector | The responder's static key. The pairing code carries its public half.                                                                             |
| X25519 Noise static   | phone     | The initiator's static key. The connector's allowlist holds its public half.                                                                      |
| 32-byte enroll secret | code      | One-time: enrolls the first phone that presents it before it expires.                                                                             |

## Relay messages (text)

Flat JSON objects with a string type `t`, at most 4,096 bytes. Each direction has its own decoder, which refuses any other type, extra or missing fields, and malformed values ([`src/messages.ts`](src/messages.ts)). A repeated member name is refused, compared after unescaping, so two readers can never disagree about which value counts ([`src/json.ts`](src/json.ts)); the signed register payload is read the same way.

1. The connector opens `/v1/connector/<relayId>`. The relay sends `challenge` with a fresh 32-byte nonce for this socket alone.
2. The connector answers `register` with a proof, `<payload>.<signature>` in base64url. The payload is JSON with `typ` `clawtrate-relay-register/1`, the relay's canonical origin as `aud` (`wss://host[:port]`, lowercase, no default port or path), the relay id, the public key, the nonce, `iat` in seconds and a 16-byte `jti`. The signature is Ed25519 over `"clawtrate relay register proof\n"` followed by the encoded payload.
3. The relay checks it with `ControlRegistration` ([`src/register-proof.ts`](src/register-proof.ts)):
   - one attempt per socket, decided before any wait, so overlapping attempts get `already_used`;
   - the challenge is at most 60 seconds old by a clock that wall-clock corrections cannot move back, and one that survives hibernation;
   - the key derives the relay id, the relay id is the socket's, `aud` equals the relay's configured origin in canonical form, the nonce is this socket's challenge, and the signature verifies under strict RFC 8032 rules;
   - `iat` is within 60 seconds of the relay's wall clock, and the `jti` has not been seen for this relay id. The replay store checks and records in one atomic step and keeps the `jti` until the end of the last second the proof could pass;
   - the relay id is pinned to the full public key that first registered it.

   A store that fails fails the registration. The relay answers `registered`, or `error` and closes. `MemoryReplayStore` and `MemoryKeyClaims` are reference implementations of the store contracts the relay must meet; `snapshot()` and the `restore` option carry a registration across hibernation, and an attempt cut off by it is not resumed.

4. A phone opens `/v1/dial/<relayId>`. The relay sends the connector `dial` with a 16-byte session id and the address it saw. The connector opens `/v1/session/<relayId>/<session>`. The relay sends `open` to both sockets, and binary frames flow between them.

`ping` and `pong` are the fixed texts `{"t":"ping"}` and `{"t":"pong"}` in every direction, so a Worker can answer them without waking.

## Frames (binary)

Every binary message on a spliced session is a frame: one version byte (`1`), one type byte, then a Noise message. At most 65,537 bytes in all ([`src/frames.ts`](src/frames.ts), [`src/limits.ts`](src/limits.ts)).

| Type | Name       | From      | Carries                                 | Body bytes   |
| ---- | ---------- | --------- | --------------------------------------- | ------------ |
| 1    | handshake1 | phone     | Noise IK message 1, payload: the hello  | 96 to 160    |
| 2    | handshake2 | connector | Noise IK message 2, payload: the answer | 48 to 112    |
| 3    | transport  | either    | one encrypted record                    | 17 to 65,535 |

## The channel

`Noise_IK_25519_ChaChaPoly_SHA256` ([`src/noise.ts`](src/noise.ts)), written from the Noise specification, revision 34, and checked against the Cacophony test vectors. The prologue is `clawtrate-relay/<version>\n<relayId>`, with the frame version, so a session spliced to another relay id fails.

- **Hello** (message 1's payload): version `1`, flags `0`, or flags `1` followed by the 32-byte enroll secret.
- **Answer** (message 2's payload): version `1`, then `0` accepted, `1` not enrolled, or `2` enrollment refused. A refusal is final and both sides close. "Accepted" is provisional.
- **The opening** ([`src/channel.ts`](src/channel.ts)):
  1. At message 1 the connector asks its gate, read-only: is the key enrolled, or does its secret match a live offer? Nothing changes. The gate is asked only after message 1 decrypts, and it gets copies of the key and secret.
  2. The phone's first transport record is `confirm`. Message 1 can be replayed by whoever recorded it, and the connector cannot tell a replay from a fresh one; a replay cannot produce the confirm record, because the answer used a fresh ephemeral key.
  3. On `confirm` the connector reports `admit` with copies of the phone's key and secret. The host rechecks and, in one transaction, spends the offer and adds the key (or finds the key still enrolled), then calls `admit()` or `refuse()`. A failed transaction admits nobody and spends nothing. `admit()` returns the admitted key; the host acts only on that key and opens no gateway socket before it.
  4. The connector's first record is `admission`, accepted or refused. The phone reports `open` only on an accepted admission.
- **Records** (each transport payload): one kind byte, then data.
  - `confirm` (empty) and `admission` (one status byte) open the channel.
  - `text-part` carries exactly 65,518 bytes and `text-end` up to 65,518, so a text message, at most 25 MiB (the gateway's own frame ceiling), takes at most 401 records. UTF-8 is checked once the message is whole.
  - `ping` and `pong` carry up to 32 bytes.
  - `close` carries a WebSocket close code an endpoint may send and a reason of up to 123 bytes. A close in the middle of a message cancels that message.
- **Buffered text.** A host can give its channels one `ReceiveBudget` for all the unfinished messages they hold, and its monotonic clock: a message unfinished `MAX_PARTIAL_MESSAGE_MS` (5 minutes) after its first record fails the channel, keep-alives or not. A peer that goes quiet sends nothing to check, so the host also aborts on a timer once `partialMessageSince` is that old.
- **Failure is final.** A frame that fails to decode or decrypt, comes in the wrong state, or is replayed, reordered, dropped or reflected fails the channel. So does a send the key cannot finish, which is caught before anything is encrypted. Nonces are implicit, so any of these shows as a failed decryption. Every end drops the keys, buffered text and any pending enrollment.
- **`abort()`** is how the host ends a channel when its socket closes or a deadline passes. It is safe in any state and returns true only if an authenticated close or refusal came first; a socket that ends without one ended abnormally, and a message it was carrying is discarded.
- **Counters.** Each direction's key takes 2^53-1 records, fewer than the 2^64-1 Noise allows; a new handshake starts new keys. There is no rekey.

What the handshake does not give: message 1's payload (the hello, with the secret) is encrypted only to the connector's static key, so whoever later steals that key can read old enroll secrets, which by then are spent or expired. Message 1 can be replayed, which is why nothing changes on the connector before `confirm`. The size of message 1 shows whether it carried an enroll secret.

## Checks

`test/` holds the Cacophony vector, an interoperation check against a second IK implementation on Node's OpenSSL bindings with each on either end, the channel and enrollment cases (dropped handshakes, an offer expiring between the two checks, two phones confirming with one secret, a failed commit), single-bit tampering of every byte of every handshake and transport frame, replay, reordering, dropping and reflection, the reassembly, budget, deadline and exhaustion limits, the register proof's rejection cases and the control socket's registration, and seeded fuzzing of every decoder.

## Licence

`src/register-proof.ts` and `test/register-proof.test.ts` port logic and test cases from T3 Code under the MIT licence; each keeps its notice, and [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) lists them. The test vectors come from Cacophony, which is in the public domain.
