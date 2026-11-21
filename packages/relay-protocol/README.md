# @clawtrate/relay-protocol

The wire protocol for reaching a gateway through Clawtrate's relay: the frames a phone and a connector exchange end to end, the relay's own messages, the connector's register proof, and the Noise IK channel with phone enrollment. It does no I/O. The relay, the connector and the phone's socket are built on it.

It runs in Node, Electron, Cloudflare Workers and React Native. It uses `@noble/curves`, `@noble/ciphers` and `@noble/hashes`, pinned to exact versions, and two globals besides the language: `TextEncoder` and `TextDecoder` ([`src/globals.d.ts`](src/globals.d.ts)). Random bytes come from `crypto.getRandomValues`.

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

JSON objects with a type `t`, at most 4,096 bytes. Each direction has its own decoder, which refuses any other type, extra or missing fields, and malformed values ([`src/messages.ts`](src/messages.ts)).

1. The connector opens `/v1/connector/<relayId>`. The relay sends `challenge` with a 32-byte nonce.
2. The connector answers `register` with a proof, `<payload>.<signature>` in base64url. The payload is JSON with `typ` `clawtrate-relay-register/1`, the relay's origin as `aud`, the relay id, the public key, the nonce, `iat` in seconds and a 16-byte `jti`. The signature is Ed25519 over `"clawtrate relay register proof\n"` followed by the encoded payload.
3. The relay checks it ([`src/register-proof.ts`](src/register-proof.ts)): the key derives the relay id, the relay id is the socket's, `aud` is this relay, the nonce is this socket's challenge, the signature verifies under strict RFC 8032 rules, `iat` is within 60 seconds of the relay's clock, and the `jti` has not been seen for this relay id. It keeps the `jti` until the end of the last second the proof could pass. It answers `registered`, or `error` and closes.
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

`Noise_IK_25519_ChaChaPoly_SHA256` ([`src/noise.ts`](src/noise.ts)), written from the Noise specification, revision 34, and checked against the Cacophony test vectors. The prologue is `clawtrate-relay/1\n<relayId>`, so a session spliced to another relay id fails.

- **Hello** (message 1's payload): version `1`, flags `0`, or flags `1` followed by the 32-byte enroll secret.
- **Answer** (message 2's payload): version `1`, then `0` accepted, `1` not enrolled, or `2` enrollment refused. A refused phone learns why, and both sides close.
- **The connector's decision** ([`src/channel.ts`](src/channel.ts)): an enrolled phone key is accepted. An unknown key with a secret is accepted only if the secret matches a pending offer that has not expired or been used, which enrolls it. Anything else is refused. The gate is asked only after message 1 decrypts, so the phone has shown it holds its static key.
- **Confirmation.** The phone's first transport record is `confirm`. The connector reports `open` only when it arrives. Message 1 can be replayed by whoever recorded it, and the connector cannot tell a replay from a fresh one; a replay cannot produce the confirm record, because the answer used a fresh ephemeral key. The connector opens no gateway socket before `open`.
- **Records** (each transport payload): one kind byte, then data. `confirm` (empty), `text-part` (never empty) and `text-end` carry a UTF-8 text message cut into pieces of up to 65,518 bytes; `ping` and `pong` carry up to 32 bytes; `close` carries a WebSocket close code an endpoint may send and a reason of up to 123 bytes. A reassembled message is at most 25 MiB, the gateway's own frame ceiling.
- **Failure is final.** A frame that fails to decode or decrypt, comes in the wrong state, or is replayed, reordered, dropped or reflected fails the channel; the caller closes the socket. Nonces are implicit, so any of these shows as a failed decryption.

What the handshake does not give: message 1's payload (the hello, with the secret) is encrypted only to the connector's static key, so whoever later steals that key can read old enroll secrets, which by then are spent or expired. Message 1 can be replayed, which is why the connector waits for `confirm`.

## Checks

`test/` holds the Cacophony vector, the channel and enrollment cases, single-bit tampering of every byte of every handshake and transport frame, replay, reordering, dropping and reflection, the register proof's rejection cases, and seeded fuzzing of every decoder.

## Licence

`src/register-proof.ts` and `test/register-proof.test.ts` port logic and test cases from T3 Code under the MIT licence; each keeps its notice, and [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) lists them. The test vectors come from Cacophony, which is in the public domain.
