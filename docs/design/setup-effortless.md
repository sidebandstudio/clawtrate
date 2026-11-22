# Effortless setup and connection

How a person gets from opening Clawtrate to chatting with their Main Bot with no Terminal command on this Mac, and with at most one approval for a gateway on another computer. This design replaces the read-only-first tiers of `docs/decisions.md` ("Connecting to the gateway") and changes `setup.md` §7, §9, §12 and §13. Everything else in `setup.md` stands: the first screen's question, SSH routes, setting OpenClaw up, routes and identity.

The evidence is `docs/research/setup-effortless/full-scope-probe.ts`, run against development gateways, and OpenClaw 2026.10.6's own source and docs. `<openclaw>/…` is a path in the installed `openclaw` 2026.10.6 package, as in `docs/research/setup-flow.md`; chunk names carry a build hash, so search by the `//#region` marker. **Live** means a probe ran it on a development gateway; **source** means it was read only.

This version takes in the first independent review. Its main change: no credential goes to a local socket until Clawtrate has proved who holds the other end of that exact socket (§3).

## Why the earlier decision is superseded

The product owner decided this:

> "You have my OK. This is important to me. Approvals are genuine nightmare and defeat the entire purpose of this."

So two things change on purpose:

1. **Clawtrate asks for all six operator scopes at its first pairing**: `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, `operator.admin` and `operator.pairing`. The gateway's confirmed grant is the limit.
2. **Clawtrate approves other devices from inside the app**, with `device.pair.approve` and `device.pair.reject`, wherever OpenClaw 2026.10.6 allows it.

The targets:

| Gateway                                                       | Terminal commands                                          | Approvals in total      | Clicks to connect |
| ------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------- | ----------------- |
| On this Mac, OpenClaw's defaults                              | 0                                                          | 0                       | 1 (Connect)       |
| On another computer reached by SSH                            | 0                                                          | 0                       | as `setup.md` §5  |
| On another computer by a `wss://` address (Tailscale, VPS)    | 0 when another Clawtrate is already connected; otherwise 1 | 1                       | 1 + the approval  |
| A phone or a second computer, once one Clawtrate is connected | 0                                                          | 1 approval in Clawtrate | —                 |

Every other approval or Terminal step is a defect. §12 lists the ones 2026.10.6 still forces, says why, and gives the smallest path around each.

The rules that stay:

- No credential goes to a socket whose other end isn't proved (§3).
- Local connect runs none of OpenClaw's programs (§3).
- The approve prompt is bound to the device and the exact grant the person reviewed, and can't be clicked through (§5).
- A non-loopback address must be protected: `wss://` or SSH (§4).
- A privileged credential is kept only in the system's secure storage (§2).

## Contents

1. What changes, path by path
2. Scopes, consent and storage
3. Connect to OpenClaw on this Mac
4. Another computer: the form up front
5. Approving a device from inside Clawtrate
6. Existing pairings: a one-time upgrade (F-500)
7. The first run, with #292 and #314, timed
8. Failure states
9. iOS
10. Decisions this supersedes
11. Parity rows
12. What still needs an approval or a command, and why
13. The local threat model, for the product owner
14. Not covered

## 1. What changes, path by path

| Path                                        | Today                                                                                                                                               | After                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This Mac, OpenClaw running                  | The look reads the version and stops. The person types the address and token under Advanced, then approves up to three access requests in Terminal. | Clawtrate reads the address and token from OpenClaw's settings file and proves the other end of its socket runs as this Mac account (or holds OpenClaw's TLS key). One Connect pairs it silently with all six. |
| This Mac, a device paired earlier with less | Each first send, admin action or Machines visit asks for more, and each request waits for `openclaw devices approve`.                               | One offer, once: "Give this device full control" or "Keep current access" (§6).                                                                                                                                |
| Another computer over SSH                   | Not built; would run `openclaw qr` over SSH.                                                                                                        | A fixed script reads the settings file there, and the same socket proof runs on the far side. Until that proof is built, the SSH route sends no credential by itself.                                          |
| Another computer by address                 | Advanced, read-only, then one approval per tier.                                                                                                    | An address-and-token form or a pasted setup code, on the first screen. `wss://` only. One approval for all six.                                                                                                |
| A phone                                     | "Clawtrate doesn't make codes for phones yet."                                                                                                      | "Connect a phone" makes a code through the gateway, with no command. The phone asks; Clawtrate on the desktop shows the approve prompt.                                                                        |

## 2. Scopes, consent and storage

### What OpenClaw 2026.10.6 does (live, on two development gateways)

- **On trusted loopback, with valid shared auth and the default local policy, a new native operator device gets all six silently** (`approvedVia: "silent"`). It then reconnects with its device token alone. `shouldAllowSilentLocalPairing` (`<openclaw>/dist/node-connect-reconcile-CAkPC2vI.mjs` lines 178-185) never looks at the scopes of a first pairing. It looks at:
  - locality;
  - a browser `Origin` header;
  - `gateway.nodes.pairing.autoApproveLocal`. It defaults to `true` (`<openclaw>/docs/gateway/config-gateway.md` line 222), and onboarding doesn't set it.
- **On an ordinary remote shared-token route, with the same client identity and policy, one pending operator request carries all six, and one approval grants them.**
  - `resolvePairingLocality` (same file, lines 186-196) classifies the connection as remote. `shouldAllowSilentLocalPairing` returns `false` both for a remote connection and for disabled local auto-approval. Both cases then go through the same pending-request and manual-approval logic.
  - The live stand-in had local auto-approval off, because a development gateway must bind loopback.
  - The equivalence holds for ordinary operator pairing only. Proxy attribution, an `Origin` header, auth modes, bootstrap profiles and gateway policy can each change the path.
- **What each scope permits** (`<openclaw>/docs/gateway/operator-scopes.md` lines 30-43; `<openclaw>/dist/operator-scope-compat-Ci6GBcmU.mjs` lines 10-16):

  | Scope                | What it permits                                                                                                                                                                        |
  | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `operator.read`      | Read gateway status, bots, visible sessions and history, and diagnostic data.                                                                                                          |
  | `operator.write`     | Send and stop work, invoke allowed tools and relay node commands. Includes read.                                                                                                       |
  | `operator.approvals` | Read and decide permitted exec and plugin approvals.                                                                                                                                   |
  | `operator.questions` | Read and answer interactive questions under the gateway's access rules.                                                                                                                |
  | `operator.admin`     | Change gateway configuration, plugins or accounts, manage high-risk operations, and open the gateway terminal where allowed. Satisfies every operator scope, including pairing events. |
  | `operator.pairing`   | Receive pairing events and use pairing methods within the gateway's caller, device, role and scope rules. A pairing-only device token can't approve or remove another device.          |

- **Clawtrate's ladder today** has three sources:
  - Every connect asks for `operator.read` alone. That comes from `REQUESTED_SCOPES` in `packages/core/src/client.ts`, and `normalizeHeldScopes` in `packages/core/src/scopes.ts` drops admin and pairing.
  - Each later tier is a separate `device.scopes.requestUpgrade`, from the composer and cards, from `bots/parts.tsx` and from `machines/Machines.tsx`.
  - That request always waits, even on loopback (`<openclaw>/dist/devices-mOg4_HQd.mjs` lines 37-110).

### What Clawtrate asks for

- **A first pairing asks for the six by name**, in a fixed order (`FULL_SCOPES` in `packages/core/src/scopes.ts`).
  - Caps are `tool-events`, `approvals`, `exec-approvals` and `plugin-approvals`.
  - It asks for pairing by name even though admin implies it. Pairing events and the device-management rules check the named scope.
- **The confirmed grant is the limit.**
  - The token record holds what the hello granted, within what that attempt asked for.
  - A reconnect asks for exactly that.
  - The client commits a token only when its grant is within the attempt's request. This keeps #295's guard against overwriting or deleting a newer token.
- **Narrower means stop, not retry.** The gateway can grant less in four ways:
  - a named role's ceiling;
  - a limited setup code;
  - a token its owner narrowed;
  - a rejection.

  In each case Clawtrate keeps what was granted, says so, and stops. It never starts a sequence of smaller requests by itself. The gateway may keep a narrowed token even after a later approval (`<openclaw>/docs/web/control-ui/connect-and-pair.md`: approval "preserves that token limit").

- **Platform and device family never change on a device.**
  - The gateway pins both at pairing. A reconnect that reports other values files a `metadata-upgrade` request, which waits off loopback (`resolvePinnedClientMetadata`, `<openclaw>/dist/message-handler-CRCo2VX0.mjs` from line 884; the request at line 1534).
  - Live: a device paired as `ios` reconnected as `darwin` and was asked to pair again.
  - The host fixes both once per device identity.

### Consent before Connect

On every card that pairs (this Mac, SSH, the address form, a setup code), directly above the button:

> "Full control lets Clawtrate change gateway settings, approve devices and, when the gateway allows it, open a terminal on the computer running OpenClaw."

A "What this means" link opens a short page with these points:

- The terminal runs as the gateway's user and inherits that process's environment. It is on by default, within the gateway's and the sandbox's limits (`config-gateway.md` line 201).
- Disconnecting this device leaves its pairing on the gateway. Removing it (Settings, Gateway, Devices, from another admin device) ends that pairing.
- If this device is lost, remove it from another admin connection.
- If the shared token leaked, rotate it on the gateway and review the other paired devices.
- Protecting this app's data limits copies made from backups and app files. It doesn't protect a computer that is already compromised.

### Where credentials live

Secure storage comes before full access, in the same first PR.

- **Under secure storage.** On macOS, the device token and the device signing key move into the Keychain before the first full-scope grant is written. Clawtrate uses Electron's async `safeStorage` API, checked in a signed packaged test, or the Keychain directly.
- **In the file.** `<userData>/gateway/state.json` keeps the URL and non-secret metadata. Today it holds device tokens, and while pairing it can hold a typed gateway token under `connection.token`. The matching Ed25519 key is `device-key.pem` beside it.
- **Migration.**
  - Device identity is preserved.
  - Migration survives a restart, and writes go through the existing token-replacement checks.
  - The protected record is verified before the clear-text copy is removed. If cleanup is interrupted, the protected record stays authoritative.
  - Saved shared credentials from earlier versions are swept in the same step.
- **Credentials kept in memory only.** Newly entered gateway tokens, tokens read from a settings file, and setup codes stay in host memory for the attempt.
- **When secure storage is unavailable**, the full grant is kept for this session only, or Clawtrate says "Clawtrate couldn't save this device securely. Unlock your keychain and try again." It never falls back to a clear-text privileged token, or to Linux's `basic_text` backend. Other hosts follow the same rule with their own secure store, or session-only.

### Read-only mode

Settings, Gateway, "Access" reads "Full control". Its quiet link is "Use read-only mode on this device", with this line:

> "Clawtrate will only read on this device. Its saved pairing still has full control on the gateway; remove the device to end that."

A gateway-side revoke and a narrower replacement are later work (§14). A rejected or removed device never pairs again by itself by looking for the shared credential.

## 3. Connect to OpenClaw on this Mac

Clawtrate reads where the gateway listens and its token from OpenClaw's own settings file. It runs no OpenClaw program before or after Connect: OpenClaw's launcher may repair its own installation before any command (`<openclaw>/openclaw.mjs` lines 649-715). Before any credential leaves the host, Clawtrate proves who holds the other end of that exact socket.

### Proving the other end of the socket

A listener check identifies a listening socket at one moment. The credential goes to an accepted connection, and the two can differ. So the proof must be about the connection that will carry the credential. Five candidates were checked against 2026.10.6:

| Candidate                                                                   | Works in 2026.10.6?                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) The gateway signs a client nonce with its identity key                  | **No.**                                                    | The gateway's identity is in OpenClaw's SQLite state, not a file (`loadOrCreateProcessDeviceIdentityAsync`, `<openclaw>/dist/device-identity-async-Dmb-qdPn.mjs` lines 20-45). Nothing signs before auth: `connect.challenge` is a bare server nonce (`<openclaw>/dist/ws-connection-Cq7PPwbb.mjs` lines 314-323), `hello-ok` carries no signature (`HelloOk` in the schema), and `gateway.identity.get` needs an authenticated connection.                                                                                                                                                                                                                                                                     |
| (b) A TLS certificate pinned from an owner-only file                        | **Yes, when OpenClaw already has TLS on.** Off by default. | **Live** on a development instance with `gateway.tls.enabled: true`. OpenClaw wrote `gateway/tls/gateway-cert.pem` and `gateway-key.pem`, both 0600. The certificate's SHA-256 matched what it served. A new device pinning it over `wss://127.0.0.1` paired silently with all six (`approvedVia: "silent"`). Plain `ws://` to that port was reset. An impostor TLS listener dialled with the same pin got 0 bytes; the pinned client stopped with "gateway tls fingerprint mismatch" (`applyGatewayWebSocketTlsPin`, `@openclaw/gateway-client` `dist/index.mjs` lines 565-600). With the default `hybrid` reload, the config change restarted the gateway in its own process (same PID), with no `launchctl`. |
| (c) A Unix-domain socket, where `LOCAL_PEERCRED` authenticates the peer     | **No.**                                                    | The gateway's WebSocket API listens on TCP only. The schema has no socket-path setting. The `.sock` files OpenClaw makes (`exec-approvals.sock`, the spawn broker's `resource.sock`) are internal channels, not the operator API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| (d) The gateway proves it knows the shared token before the client sends it | **No.**                                                    | The first frame must be `connect`, carrying the credential (`<openclaw>/dist/message-handler-CRCo2VX0.mjs` lines 3520-3521). The challenge is a random UUID with no proof attached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| (e) The account that holds the accepted end of this exact connection        | **Yes, as an account proof.**                              | **Live.** Three plain TCP connections to a development gateway. Before any byte was sent, Clawtrate looked up the server end by the connection's four-tuple (`127.0.0.1:<port> → 127.0.0.1:<our local port>`). Each was held by the gateway's own PID, as this account, found in 139-273 ms. As a non-root account, the system shows only this account's sockets: a root-owned listener on this Mac showed nothing to `lsof`. A holder from another account can't be seen, so the proof fails closed.                                                                                                                                                                                                           |

**What Clawtrate uses.**

1. **Use the TLS pin (b) when OpenClaw already has TLS on.**
   - Read the certificate from `gateway.tls.certPath`, or else `<state>/gateway/tls/gateway-cert.pem`. It must be owner-only, and the same reader rules as the settings file apply.
   - Check it on the same TLS socket before the WebSocket upgrade, using the pinned client's existing pin check.
   - This proves the far end holds OpenClaw's private key, which only this account (or root) can read.
2. **Otherwise use the account proof (e).**
   - The host dials the TCP socket itself. The pinned `undici` `Agent` connector, matched to Node's bundled version, hands that socket to the WebSocket. So the socket that is proved is the socket that is used.
   - The proof runs before the upgrade request's first byte, and again after `connect.challenge`, before the credential frame.
   - Each check finds every holder of the accepted end by its four-tuple, and needs at least one holder. Every holder must be a process of this account. Nothing found within 2 s means unverified, and the socket closes.
   - Every socket is checked, retries and reconnects included, whether it carries the shared token or this device's own token.
   - On macOS the lookup is `proc_pidinfo` / `proc_pidfdinfo` in a small native helper, which is what `lsof` uses (the probe used `/usr/sbin/lsof`). On Linux it is `/proc/net/tcp`, which shows every socket's owner uid, then this account's `/proc/<pid>/fd`.
3. **Neither proves the peer:** nothing is sent, and the card says "Clawtrate couldn't verify what is listening at port ‹port›."

**Why (e) is enough on this Mac.** It proves the credential reaches a process running as this macOS account. That is exactly the boundary that already holds the token: any process of this account can read the 0600 settings file. It is not a proof that the peer is OpenClaw. A same-account impostor gains nothing it couldn't read for itself. How the proof holds up in each case:

- **Alternate and wildcard listeners.** The proof is about the accepted connection, whichever listener took it.
- **Another account, or root.** Their sockets are invisible to this account, so the proof fails closed.
- **The holder exits, or its PID is reused.** The proof reads only a live connection's holder. If the holder exits, the connection closes and the send fails.
- **The socket is passed on.** It can reach another process only from a holder of this account. Every holder found is checked.

What remains unproved live is a holder that belongs to another macOS account. Creating one needs a second account, so PR 2's packaged check does it on a hosted macOS runner, and asserts that zero credential bytes are sent. These checks reuse #291's attempt, consent, socket and generation guards (`apps/desktop/src/setup/controller.ts` from line 424) and close the socket on any failure.

**Turning TLS on for the person** would give (b) everywhere. It changes OpenClaw's own config and restarts the gateway. Every plain `ws://127.0.0.1` client of that gateway breaks: OpenClaw's own CLI reads the local pin by itself, but the Control UI in a browser meets a self-signed certificate. Clawtrate doesn't do this on its own; §13 puts the choice to the product owner.

**Over SSH,** the same rule applies on the far side. The SSH host key authenticates the SSH server, but the forward's far end is a loopback connection that is still unproved. Two options:

- With TLS on there, Clawtrate reads the certificate over SSH with the fixed script and pins it through the forward (`tlsServerName` 127.0.0.1).
- Otherwise the fixed script runs the account proof there after Clawtrate's socket is open, and before the credential frame. It checks every established connection to `127.0.0.1:<port>` whose client end belongs to this account's `sshd`.

Until the SSH unit builds and tests one of these, the SSH route sends no credential by itself.

### The settings reader

A bounded, read-only reader. It never repairs a file or a permission, and runs no OpenClaw code.

- **Where.**
  - Only `~/.openclaw/openclaw.json` (the default profile) and `~/.openclaw-clawtrate/openclaw.json`, under the home folder the operating system reports for this account.
  - `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` affect only processes started with them (`<openclaw>/dist/paths-BP0DYpE8.mjs` lines 117-140, 214-223).
  - If both profiles qualify, both are shown by name: "Choose the OpenClaw profile to connect to."
- **Opening.**
  - The profile folder is opened as a held directory descriptor beneath the home folder. Each untrusted component is walked without following links.
  - The file is opened relative to that descriptor: read-only, no-follow, nonblocking. A FIFO fails without blocking.
  - Node has no `openat`. The same native helper as the socket proof does this, and checks ACLs (below).
- **Checks on what was opened (`fstat`).**
  - The folder is this account's and private.
  - The file is this account's, a regular file with one link, mode exactly 0600.
  - Neither carries an ACL that grants anything to another account.
  - At most 1 MiB, checked against the bytes actually read as well as the first size.
  - OpenClaw writes them as 0700 and 0600 (`<openclaw>/dist/io.write-DVKwks5G.mjs` lines 171 and 267).
- **Parsing.**
  - A purpose-built JSON5 reader in the host. It evaluates nothing, follows no `$include`, does no `${…}` interpolation and imports no OpenClaw code.
  - It allows at most 32 levels of nesting and 20,000 tokens.
  - It rejects:
    - duplicate keys;
    - the names `__proto__`, `constructor` and `prototype`;
    - `$include` at the root or anywhere under `gateway`. A root include can change values inside a `gateway` block that looks complete.
  - It takes own properties of plain objects only. OpenClaw's format is JSON5 (`<openclaw>/dist/io.read-helpers-CMGXaUZA.mjs` lines 89-95, 119-156).
- **What it extracts.** A local gateway's literal token, and nothing else.
  - `gateway.mode` must be `local` or absent.
  - `gateway.auth.mode` must be `token`, or absent with a literal token and no password. An absent mode can mean password (`<openclaw>/dist/auth-resolve-2uQi6dqM.mjs` lines 21-59).
  - The token is rejected when it is a SecretRef object, an unresolved `${…}`, the redaction sentinel, empty, longer than 4 KiB, or contains control characters. Ordinary punctuation is kept, with OpenClaw's own trimming.
  - Password and `none` modes are later routes, not this one.
  - The port must be an integer from 1 to 65535. 18789 is used only when the port is absent. Either way it is a candidate: a running gateway can override it (`--port`, `OPENCLAW_GATEWAY_PORT`; `config-gateway.md` lines 135-146).
- **Using the credential.**
  - The look reads the token only to decide what the card says, and drops it.
  - Connect reads it afresh and keeps it in the host for that bounded attempt only. It is dropped on cancel, failure, timeout or pairing.
  - It goes through the existing staged setup-credential path, with its checks before the send and before a grant is saved (`packages/core/src/client.ts` from line 1289).
  - It never enters preload or renderer state, crash breadcrumbs, logs, arguments, child environments or temporary files.
  - The gateway's own pairing write is the one expected effect of Connect.

### The first screen on a Mac with OpenClaw

The look only reads files and proves sockets, so it runs before the person answers "Where does OpenClaw run?".

1. **Settings found, not yet proved:** a card "OpenClaw settings found", with "Port 18789 · default profile · version 2026.10.6" under it (the version comes from OpenClaw's own `package.json`). The look then opens one socket, proves it, sends nothing, and closes it.
2. **Proved:** the card says "OpenClaw is running on this Mac", with **Connect** and the consent line of §2 above it. Below it, quieter, is "Another computer".
3. **Connect** shows steps in place of the button: "Reading OpenClaw's settings", "Checking it's OpenClaw on this Mac", "Pairing this Mac", "Loading your bots". This takes one to three seconds. Each socket is proved again (above).

Clicking Connect is the consent. There is no second dialog. On this Mac the count is **1 click, 0 commands, 0 approvals** with OpenClaw's defaults, and the same when OpenClaw has TLS on.

### In development

A sandboxed run reads the development instance's own `openclaw.json`, proven as `sandbox.ts` proves the instance today. The development config contract has TLS off, so the setup checks exercise (e). The TLS path is checked by a probe-style test that turns TLS on in its own instance only. A development gateway has local auto-approval off by its contract. So the setup checks start their instance with `--default-local-pairing` for the zero-approval path, and without it for the one-approval path.

## 4. Another computer: the form up front

"Another computer" offers three ways in, at one level:

- **SSH**: the field of `setup.md` §5.
- **Address and token**: "Gateway address" (placeholder `wss://gateway.example`) and "Token" (a password field with show and hide).
- **Setup code**: "Paste a setup code".

"Advanced" leaves the first screen; its form is the address-and-token way.

**A protected transport, enforced in the host before any credential, on every route.** That includes pasted codes, reconnects and saved addresses.

| The address                                                 | Line                                                                                                                                                          | Connect                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `wss://` with a certificate the system trusts for that name | none                                                                                                                                                          | Available                                                  |
| `ws://` or `wss://` to `127.0.0.1`, `::1` or `localhost`    | accepted only as the verified local route of §3 or an SSH forward; typed here: "Use This Mac or SSH for a gateway on this computer."                          | Unavailable here                                           |
| `ws://` to any other host                                   | "This address would send the gateway token and chat traffic without encryption. Use a secure address (wss://) or SSH."                                        | Unavailable                                                |
| `wss://` with a certificate the system doesn't trust        | "Clawtrate can't verify this gateway's certificate." and the full SHA-256 fingerprint, grouped. "Compare it with the gateway owner over a channel you trust." | "Verify certificate", which pins it for this endpoint only |
| User info, a fragment, or a redirect                        | "That address can't be used."                                                                                                                                 | Unavailable                                                |

More rules for addresses:

- A private-looking address or hostname doesn't make a route protected.
- A gateway's base path is kept after normalizing the endpoint.
- Normal trust and hostname verification are the default.
- A manual pin is checked on the same TLS socket before the upgrade, on every connection. Clawtrate's bare Node WebSocket path gets no pin check of its own, so the host's connector does it.
- When a pinned certificate changes, Clawtrate stops: "The gateway's certificate changed. Verify the new fingerprint to reconnect." It keeps the old pin until the person replaces it.

**Setup codes.**

- A code's payload doesn't say its profile, and `AUTH_BOOTSTRAP_TOKEN_INVALID` also means expired, used, revoked or malformed. So Clawtrate never takes that error as proof of a limited code.
- When the issuing Clawtrate knows the profile, it uses that. Otherwise it says "This code didn't work. Ask for a fresh one."
- A limited code permits four of Clawtrate's six (read, write, approvals, questions), and neither admin nor pairing (`<openclaw>/dist/device-bootstrap-profile-DQKf7Vz1.mjs` lines 3-43). After a known limited code, Clawtrate offers "Connect with limited access".
- Only a full code made for loopback was exercised live.

**Waiting for the one approval.** The screen is titled "Approve this Mac" and shows:

- "Waiting for approval from the gateway's owner at ‹address›."
- This device's code, large, in mono: 16 base32 characters of the SHA-256 of its public key, in four groups ("K7QF-2MXA-9TRB-W4HD"). Under it: "The approver types this code."
- "Asked for: full control", with the six in plain words.
- Three ways to approve, in this order:
  1. In Clawtrate on a device already connected with full control.
  2. In OpenClaw's Control UI on the gateway's computer, under Devices (`<openclaw>/docs/web/control-ui/connect-and-pair.md` lines 32-34).
  3. Last, the command `openclaw devices approve <requestId>`, with the profile line of `setup.md` §9.

Clawtrate retries every 3 seconds, keeping the request id. Clawtrate caps its own wait at 10 minutes. The gateway's five minutes count from the last refresh, which the public record hides. After the cap: "Clawtrate stopped waiting for approval." and "Ask again". After a Deny, or a code the gateway refuses, Clawtrate doesn't make a new request by itself.

## 5. Approving a device from inside Clawtrate

### What 2026.10.6 allows (live unless marked)

- **The events.**
  - A connection holding `operator.pairing` (or admin, by implication) receives `device.pair.requested` and `device.pair.resolved`. Read and write connections receive neither.
  - An event only prompts a list read.
  - A superseded request can be broadcast as `rejected`.
- **The payload** (`DevicePairRequestedEvent`): `requestId`, `deviceId`, `publicKey`, `displayName`, `platform`, `deviceFamily`, `clientId`, `clientMode`, `browserOrigin`, `role`, `roles`, `scopes`, `remoteIp`, `silent`, `isRepair`, `ts`.
  - Name, platform, family, client id and mode are written by the device that asks.
  - `remoteIp` is the gateway's observation, when present.
- **`device.pair.list`.** An admin caller sees every request. A device-token caller without admin sees only its own (`devices-mOg4_HQd.mjs` lines 341-354).
- **`device.pair.approve {requestId}` and `reject`.** These are pairing RPCs.
  - A device-token caller without admin may decide only its own request (`authorizePairingDecision`, line 303).
  - The approver must hold every scope it grants (`<openclaw>/dist/device-pairing-approval-uwflSfHu.mjs` lines 6-56).
  - A shared-auth operator session can decide eligible operator requests within its scopes. Paired Clawtrate is never one.
  - Live: a read-and-pairing device was refused for another device's request, even a read-only one. The admin device approved and rejected.
  - Approving twice answers "unknown requestId". After a rejection, the device's next connect files a new request.
- **What a `requestId` binds (source).** A pending request is refreshed under the same id only when the public key, browser origin and role are unchanged, and the roles and scopes stay within the existing set (`canRefreshPendingDevicePairingRequest`, `<openclaw>/dist/device-pairing-core.worker-B-kYFMQS.mjs` lines 240-256). The refresh keeps the existing roles and scopes (lines 257-274). Any other change deletes the old request and makes a new id (lines 279-324).
  - So under one id, `deviceId` (the hash of the key), `publicKey`, `browserOrigin`, roles and scopes are fixed.
  - Only the reported metadata and `remoteIp` can drift.
  - Approving by id after a fresh list read therefore approves the key and grant the person checked. This is a property of 2026.10.6's code, not a documented contract. A `pnpm scenarios` check holds it, and an upgrade of OpenClaw re-runs it.
  - A repair's effect also depends on the device's current token. The prompt shows the current grant beside what is added.

### Who sees it

- Only a connection with admin.
- One prompt per app host, in its active window. Other windows show a badge.
- A connection with pairing but no admin shows a passive notice: "A device is asking to connect. Approve it in Clawtrate on a device with full control."
- Events are coalesced into a bounded list refresh, with dedupe and a rate limit. Outside an explicit pairing flow, more than one waiting request is one passive badge, "Devices asking", leading to Settings, Gateway, Devices.

### The prompt

The host keeps the snapshot of the request it shows.

- **Title.** "Let a new device control this gateway?". For a repair: "Give this device more access?"
- **The gateway**, by name and address.
- **Reported by the device.** Name, platform and app, each as bounded text with control and bidi-override characters stripped, all three marked "(reported)". That includes a claim of being Clawtrate.
- **Seen by the gateway.** "From ‹remoteIp›" when supplied, otherwise "Address not reported". No Tailscale identity is inferred.
- **Roles and grant.**
  - The whole role set. A request whose roles aren't exactly `operator` goes to Machines (`device-node.md`).
  - The complete effective scope set in the words of §2's table.
  - For a repair: what it holds now, and what is added.
- **The code.** "Enter the code shown on the device you want to approve." One input for the 16-character code, with groups inserted as the person types, case-insensitive. Then one explicit **Approve**, enabled only on a match. "Deny" sits beside it.
  - Enter in the input never sends a decision.
  - Focus starts outside the decisions. Escape dismisses ("Not now").
  - At phone width, the input and both buttons stay reachable when the sheet scrolls or the keyboard is up.
  - There are no multiple choices and no second guess on the same review. A wrong code says "That code doesn't match this request." and keeps Approve disabled.
- **The click.** Before calling `device.pair.approve`, the host revalidates against a fresh `device.pair.list`:
  - the connection's generation and admin;
  - the request id;
  - the public key and device id;
  - the roles and scopes;
  - the repair baseline;
  - the reported details shown.

  Any visible change clears the code and asks for a fresh review. Only a confirmed RPC answer is reported as success: "Approved. The device connects in a moment."

- **Deny** calls `device.pair.reject`: "Denied. The device can ask again."

### Several windows and hosts

- Dropped broadcasts and racing decisions are reconciled against the list.
- When the list can't tell apart another decision, expiry or supersession, the prompt closes with "This request is no longer pending". It never attributes the decision to another person.

### Settings, Gateway, Devices (admin only)

- **Pending requests** at the top, each opening the prompt.
- **Paired devices**, each with:
  - the reported name, marked as such;
  - platform;
  - scopes in words;
  - "Paired 3 days ago";
  - "This device" on the current one.
- **Remove.**
  - Works by exact `deviceId`, after a confirmation that names the gateway and the device.
  - Removing this device, or the last known admin device, needs a recovery path first. That means another admin device, or the gateway's owner.
  - After it completes, the list refreshes: "Removed. This device's saved pairing no longer works."
  - OpenClaw deletes the paired record and its pending repairs, and disconnects the device's clients (`<openclaw>/dist/devices-mOg4_HQd.mjs` lines 445-484). A holder of a valid shared secret or code can still ask to pair again.

## 6. Existing pairings: a one-time upgrade (F-500)

- **Resuming.** An existing connection resumes with its current grant.
- **The offer.** Once per device and gateway, the app offers "Give this device full control" and "Keep current access".
  - A dismissal or refusal is recorded, so startup, another window and a reconnect don't ask again.
  - Consent is bound to the current identity, endpoint, requested scope set and connection generation.
- **After consent:**
  - **This Mac**, with the endpoint proved by §3: one reconnect presenting the shared token, asking for the six. The gateway files a `scope-upgrade` and approves it silently, because the connection is local and authenticated with the shared token (`node-connect-reconcile-CAkPC2vI.mjs` line 183). Live: the read device was refused with `AUTH_SCOPE_MISMATCH` on its device token. It was upgraded to six with the shared token. It then reconnected on its device token alone.
  - **Elsewhere**: `device.scopes.requestUpgrade` and `waitUpgrade` on the live socket, with one owner decision: Clawtrate's prompt on another admin device, the Control UI, or the command.
  - **With local auto-approval off on this Mac**: the same request waits for the gateway's owner. §4's three ways show.
- **The result.** Clawtrate holds and publishes only the gateway-confirmed grant, within the scopes that attempt asked for. A narrower grant is kept and reported, and Clawtrate stops.
- **No OpenClaw program runs.** The launcher replays pending package-lifecycle work and may start a Node runtime recovery before any command (`openclaw.mjs` lines 37-80, 649-715). A click on Connect doesn't consent to that.

## 7. The first run, with #292 and #314, timed

On a Mac where OpenClaw runs with its defaults and a model account. These are estimates; PR 6 measures them.

| Step | What happens                                                                                                                                                                       | The person does       | Time                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------ |
| 1    | The app opens. The host reads the settings file and proves one socket.                                                                                                             | Nothing               | 1-2 s                    |
| 2    | "OpenClaw is running on this Mac", the consent line, Connect.                                                                                                                      | Reads, clicks Connect | 3-5 s                    |
| 3    | Pairs silently with all six and loads bots. External channel chats are hidden (#314), and the native Main Bot session stays visible even when channel traffic shares the main key. | Nothing               | 1-3 s                    |
| 4    | "How hands-off should your bots be?" (#292 §1)                                                                                                                                     | Chooses               | 5-10 s                   |
| 5    | The Main Bot's chat opens with its composer (#292 §2), and its creature (#300) plays.                                                                                              | Nothing               | under 1 s                |
| 6    | The Main Bot's first visible reply (F-006).                                                                                                                                        | Reads                 | 5-10 s with a real model |

PR 6 reports two times separately:

- opening the app to an interactive Main Bot composer, with a target of 20 s;
- that point to the bot's first visible reply on the scripted model.

Provider latency and a remote approval's wait are reported apart. Not reachable in 60 s: a Mac with no OpenClaw (installing and onboarding take 40-60 s), and a gateway with no model account.

## 8. Failure states

| Condition                                                                      | Copy                                                                                                                    | Actions                                                                                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Canonical settings absent                                                      | "Clawtrate couldn't find OpenClaw settings on this Mac."                                                                | Look again; an address; Set up OpenClaw here when the program is absent too                                       |
| Wrong owner or mode, an unsafe ACL, a link, a special file, or reading refused | "Clawtrate couldn't safely read OpenClaw's settings. The settings file must be private and belong to your Mac account." | Look again; a separately verified address                                                                         |
| Too large, too complex, malformed, duplicate keys or includes                  | "Clawtrate couldn't read these OpenClaw settings directly."                                                             | An address and token                                                                                              |
| An invalid port, or a remote profile                                           | "These settings don't give Clawtrate a usable local gateway address."                                                   | The address form, with no guessed address                                                                         |
| A missing, indirect or invalid credential, or an unsupported auth mode         | "Clawtrate couldn't get a usable token from these settings."                                                            | The address form for token auth, or the gateway owner's supported sign-in route. SSH doesn't resolve a SecretRef. |
| No listener                                                                    | "Nothing answered at port ‹port›."                                                                                      | Look again                                                                                                        |
| The socket's other end not proved                                              | "Clawtrate couldn't verify what is listening at port ‹port›."                                                           | Look again                                                                                                        |
| Two profiles qualify                                                           | "Choose the OpenClaw profile to connect to."                                                                            | The two by name                                                                                                   |
| TLS with no readable owner-only certificate                                    | "Verify this gateway's certificate to continue."                                                                        | The fingerprint flow of §4                                                                                        |
| The endpoint changed during an attempt                                         | "OpenClaw's address or listener changed. Look again."                                                                   | Look again                                                                                                        |
| The token was refused                                                          | "OpenClaw didn't accept the token in its settings."                                                                     | An address and token                                                                                              |
| `PAIRING_REQUIRED` (local auto-approval off)                                   | §4's waiting screen                                                                                                     | as there                                                                                                          |
| A narrower grant                                                               | "OpenClaw granted less than full control." with what is missing                                                         | Continue with what was granted                                                                                    |
| Secure storage unavailable                                                     | "Clawtrate couldn't save this device securely. Unlock your keychain and try again."                                     | Try again; this session only                                                                                      |

## 9. iOS

The iPhone app (#14, #52) isn't on `main`.

- **Connecting.** It asks for all six, with the consent line and the same transport rules: `wss://` or nothing.
- **Its first screen**: "Scan a code from Clawtrate", "Paste a setup code", "Enter an address and token".
- **Waiting.** Its waiting screen shows its 16-character code: "Type this code into Clawtrate on your computer."
- **"Connect a phone" on the desktop** (F-506) works with no command.
  - With admin, the desktop calls `device.pair.setupCode` with an address the phone can reach. It shows the QR code and expiry, and keeps the dialog open. The phone's request then opens §5's prompt.
  - Live: a full code made this way lived 600 s. A new device redeeming it for six waited; the admin device approved; the device's retry with the same code got all six. A limited code refused six.
  - The request carries no `setupId`, so the typed code is what ties the phone to the prompt.
- **Addresses.** A loopback-only gateway has no address for a phone. A plain `ws://` LAN address is refused by the transport rule.
- **Its key.** The phone keeps its device key and token in the iOS Keychain.

## 10. Decisions this supersedes

Each quote is from `docs/decisions.md`, `docs/design/setup.md` or `docs/parity.md` as it stands. The build rewrites those sections with the replacement.

1. `decisions.md`, **Scopes, in tiers**:

   > "A device starts read-only: every `connect` requests exactly `operator.read` … `operator.admin` and the narrower `operator.sessions.*` scopes are never requested."

   Replacement: "**Scopes, once, at the first pairing.** A first pairing asks for `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, `operator.admin` and `operator.pairing`, after the consent line, because the product owner decided approvals defeat the purpose ("Approvals are genuine nightmare and defeat the entire purpose of this."). The gateway's confirmed grant is the limit, and a reconnect asks for exactly that. A narrower grant is kept and reported, and nothing asks again by itself. The narrower `operator.sessions.*` scopes are never requested."

2. **Requested is not granted**:

   > "Only `heldScopes`, normalized to read plus whichever interactive scopes were granted, is ever requested"

   Replacement: "Only `heldScopes`, the confirmed grant within what the attempt asked for, is ever requested. An existing device gets one explicit upgrade offer (`setup-effortless.md` §6)."

3. **Pairing**:

   > "On `PAIRING_REQUIRED` it shows the request id and an approve command chosen by the host"

   Replacement: "…it shows this device's 16-character code, the scopes asked for, and three ways to approve: Clawtrate on another admin device, OpenClaw's Control UI, and last the approve command chosen by the host."

4. **What the look runs, and when it runs nothing**:

   > "So the look never runs an installed OpenClaw whose version isn't on a list of versions verified to have a read-only path (`READ_ONLY_VERSIONS` …), and that list is empty."

   Replacement: "The look runs no OpenClaw program on any version. It reads the version from `package.json`, and the address and token from `openclaw.json` with the bounded reader of `setup-effortless.md` §3. It sends nothing to a socket until the socket's other end is proved: by OpenClaw's own TLS certificate when TLS is on, and otherwise by the account holding the accepted end. `READ_ONLY_VERSIONS`, `gateway status`, `config get` and `qr` leave the look."

5. **The host's confirmation**:

   > "Connect asks for read access, always, and the card's button says 'Connect read-only'."

   Replacement: "Connect asks for the six. The consent line sits above the button, and the button is the consent."

6. **The one-time code**:

   > "After the dialog the host runs `openclaw [--profile clawtrate] qr --json --voice-node …`"

   Replacement: removed. The host sends the settings file's token on a proved socket, holding it for one attempt.

7. **No grant wider than the request**:

   > "…its role is `operator` and its scopes are exactly `["operator.read"]` (`setupGrant`)."

   Replacement: "…its role set is exactly `operator` and its scopes are within the six asked for."

8. **What a setup connection publishes**:

   > "The shared token is never asked for; only Advanced takes a token, typed."

   Replacement: "The shared token is read from OpenClaw's settings file, held in the host for one attempt, sent only on a proved socket, and scrubbed from everything the client publishes and logs."

9. `setup.md`, the four facts:

   > "**Clawtrate does not read the gateway's shared token.** … the design deliberately does not."

   Replacement: "Clawtrate reads the shared token from OpenClaw's settings file, which belongs to the same account, and sends it only to a socket whose other end it has proved."

10. `setup.md` §9:

    > "'Approve from here' … is not in this version"

    Replacement: §5 and §6 here.

11. `setup.md` §12:

    > "Clawtrate doesn't hand a code to a phone in this version"

    Replacement: §9 here.

12. `parity.md` F-509:

    > "a setup code never gives the device more than read access at first"

    Replacement: "a setup code gives the device what it asks for, up to the code's ceiling: all six for a full code; read, write, approvals and questions for a limited one."

**A proposed change to `AGENTS.md`, for the product owner.** Not made here. Today it says "Request the smallest operator scopes a feature needs, and keep a read-only connection useful." The reviewer proposed:

> "On first pairing, ask once for the six standard operator scopes: read, write, approvals, questions, admin and pairing. Explain full control before connecting. Treat the gateway's confirmed grant as the limit, and request only the scopes this device holds when it reconnects. Keep read-only connections useful. Changing an existing connection's grant requires the person's consent and the gateway's approval policy. Use the least authority each feature needs, and ask for no additional scope without a documented reason and explicit approval. Provider credentials stay on the gateway."

## 11. Parity rows

- **F-002** keeps "a pending-approval screen lists the exact operator scopes requested", now six.
- **F-491, F-492, F-494, F-515 and F-516** become reachable on a real computer. F-492's boundary checks (`apps/desktop/test/setup-connect-boundaries.test.ts`) gain a case: an unproved peer receives zero credential bytes.
- **F-496** reads the settings file over SSH and proves the far socket.
- **F-500** becomes §6: the shared-token upgrade on a proved local socket, the remote request with one owner decision, and the owner's route when local auto-approval is off.
- **F-506** becomes §9.
- **F-509** changes as in §10.
- **A new row** for the approve prompt: bound to the key and grant, entered code, revalidated on click.

## 12. What still needs an approval or a command, and why

| Case                                     | What 2026.10.6 forces     | Why                                                                                                                                                                                  | Smallest path around it                                                                        |
| ---------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| The first device of a gateway by address | One approval              | Off loopback, a client that isn't one of OpenClaw's own apps is never paired by its credential alone (`resolvePairingApprovalPlan`, `message-handler-CRCo2VX0.mjs` lines 1916-1969). | SSH (0, once its socket proof lands); the Control UI's Devices (no command); the command, last |
| This Mac with `autoApproveLocal: false`  | One approval              | The owner turned silent local pairing off (`node-connect-reconcile-CAkPC2vI.mjs` line 182).                                                                                          | The Control UI or the command; Clawtrate doesn't run it                                        |
| A token kept as a SecretRef              | Typing the token once     | The value is in OpenClaw's database, a service's environment or a command                                                                                                            | The address form                                                                               |
| A socket whose other end can't be proved | No connection             | §3                                                                                                                                                                                   | §13                                                                                            |
| A changed platform or family             | One approval off loopback | The gateway pins both                                                                                                                                                                | Never change them                                                                              |
| A token its owner narrowed               | Keep the narrower grant   | The owner's limit wins                                                                                                                                                               | None, by design                                                                                |

## 13. The local threat model, for the product owner

Ask: keep the default at the account proof (e), or also let Clawtrate offer to turn OpenClaw's TLS on.

**What is at stake.** OpenClaw's shared token. Whoever has it can pair a device with full control, which includes a terminal as the gateway's user.

**Who already has it.** Every process of this Mac account: the settings file is 0600 and belongs to the account. Same-account malware gains nothing from Clawtrate.

**Who could get it if Clawtrate sent it carelessly.** Another macOS account, or root, that holds `127.0.0.1:<port>`. That can happen if it starts listening first, or while OpenClaw is stopped. OpenClaw's own CLI and Control UI send the same token to the same port the same way, with no proof of the peer.

**What Clawtrate does.** It sends nothing unless one of these holds:

- the peer presents OpenClaw's own TLS certificate, read from an owner-only file;
- the peer's accepted socket is held by a process of this account.

Either way: 1 click, 0 commands, 0 approvals. Otherwise it refuses, and says that something it can't verify is listening.

**The choice left to the product owner.**

- **(e) as the default**, with (b) used whenever OpenClaw already has TLS on. Recommended. It is as strong as the file's own protection and changes nothing in OpenClaw.
- **Add an offer to turn OpenClaw's TLS on.** That is a second click ("Encrypt the connection to OpenClaw on this Mac") and a change to OpenClaw's config with a gateway restart. It proves OpenClaw rather than the account, and it breaks the Control UI's plain address and any other plain `ws://` client of that gateway. Recommended only as a Settings option, never on the first run.

## 14. Not covered

- A gateway-side revoke and a narrower replacement for "Use read-only mode on this device".
- Password and `none` auth routes; Tailscale identity sign-in (`gateway.auth.allowTailscale`).
- Node (machine) approvals, which stay in `device-node.md`.
- Windows, except as another computer reached by a protected route.
- The web preview host, which stays on the address-and-token form.
