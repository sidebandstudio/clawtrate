# Effortless setup and connection

How a person gets from opening Clawtrate to chatting with their Main Bot with no Terminal command on this Mac, and with at most one approval for a gateway on another computer. This design replaces the read-only-first tiers of `docs/decisions.md` ("Connecting to the gateway") and changes `setup.md` §7, §9, §12 and §13. Everything else in `setup.md` stands: the first screen's question, SSH routes, setting OpenClaw up, routes and identity.

The evidence is `docs/research/setup-effortless/full-scope-probe.ts`, run against development gateways, and OpenClaw 2026.10.6's own source and docs. `<openclaw>/…` is a path in the installed `openclaw` 2026.10.6 package, as in `docs/research/setup-flow.md`; chunk names carry a build hash, so search by the `//#region` marker. **Live** means a probe ran it on a development gateway; **source** means it was read only.

This version takes in two independent reviews and the product owner's decision on local connect. No credential goes to a local socket until Clawtrate has checked who holds the other end of that exact socket, and what that holder is (§3). What remains is stated, and was accepted (§13).

## Why the earlier decision is superseded

The product owner decided that repeated approvals defeat the purpose of the app, and gave this design the go-ahead to avoid them.

So two things change on purpose:

1. **Clawtrate asks for all six operator scopes at its first pairing**: `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, `operator.admin` and `operator.pairing`. The gateway's confirmed grant is the limit.
2. **Clawtrate approves other devices from inside the app**, with `device.pair.approve` and `device.pair.reject`, wherever OpenClaw 2026.10.6 allows it.

The targets:

| Gateway                                                          | Terminal commands                                                    | Approvals in total                                      | Clicks to connect |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- | ----------------- |
| On this Mac, OpenClaw's defaults (§3's gate)                     | 0                                                                    | 0                                                       | 1 (Connect)       |
| On another computer reached by SSH, with OpenClaw's TLS on there | 0                                                                    | 0                                                       | as `setup.md` §5  |
| On another computer by a `wss://` address (Tailscale, VPS)       | 0 when another Clawtrate with full control is connected; otherwise 1 | 1                                                       | 1 + the approval  |
| A phone or a second computer, once one Clawtrate is connected    | 0                                                                    | 1 click in Clawtrate on a device with full control (§5) | —                 |

Every other approval or Terminal step is a defect. §12 lists the ones 2026.10.6 still forces, says why, and gives the smallest path around each.

The rules that stay:

- No credential goes to a socket that fails the send gate (§3).
- Local connect runs none of OpenClaw's programs (§3).
- The approve sheet approves only the request whose code the person picked, after reading it again, and removes a pairing that differs from what it showed (§5).
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
13. Residual risk on this Mac, accepted
14. Not covered

## 1. What changes, path by path

| Path                                        | Today                                                                                                                                               | After                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This Mac, OpenClaw running                  | The look reads the version and stops. The person types the address and token under Advanced, then approves up to three access requests in Terminal. | Clawtrate reads the address and token from OpenClaw's settings file. It sends them only on a socket whose holder is this account's OpenClaw gateway for that profile (§3's gate), or that presents OpenClaw's TLS certificate. One Connect pairs silently with all six. |
| This Mac, a device paired earlier with less | Each first send, admin action or Machines visit asks for more, and each request waits for `openclaw devices approve`.                               | One offer, once: "Give this device full control" or "Keep current access" (§6).                                                                                                                                                                                         |
| Another computer over SSH                   | Not built; would run `openclaw qr` over SSH.                                                                                                        | A fixed script reads the settings file there. A credential goes through the forward by itself only when OpenClaw has TLS on there, with the pin read over SSH.                                                                                                          |
| Another computer by address                 | Advanced, read-only, then one approval per tier.                                                                                                    | An address-and-token form or a pasted setup code, on the first screen. `wss://` only. One approval for all six.                                                                                                                                                         |
| A phone                                     | "Clawtrate doesn't make codes for phones yet."                                                                                                      | "Connect a phone" makes a code through the gateway, with no command. The phone asks; Clawtrate on the desktop shows the approve prompt.                                                                                                                                 |

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

- **Clawtrate's ladder before 2026-11-25**, with full access off (#318 added the six behind `ClientOptions.fullAccess`; the owner's decision of 2026-11-25 removed that switch, `docs/decisions.md`), has three sources:
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

Clawtrate reads where the gateway listens and its token from OpenClaw's own settings file. It runs no OpenClaw program before or after Connect: OpenClaw's launcher may repair its own installation before any command (`<openclaw>/openclaw.mjs` lines 649-715). Before any credential leaves the host, Clawtrate checks who holds the other end of that exact socket, and what that holder is (below).

### The send gate

The product owner decided how local connect works on this Mac. As relayed to this design, the decision is "pure one-click Connect, with the account check plus a check of the listening program's executable", with "no TLS switch and no OpenClaw restart". TLS pinning still applies whenever OpenClaw already has TLS on.

A listener check describes a listening socket at one moment. The credential goes to an accepted connection, and the two can differ. So every check below is about the connection that will carry the credential.

What 2026.10.6 offers, checked against the source and, where it could work, live:

| Candidate                                                                       | In 2026.10.6                                | Evidence                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) The gateway signs a client nonce with its identity key                      | No                                          | The identity is in OpenClaw's SQLite state (`<openclaw>/dist/device-identity-async-Dmb-qdPn.mjs` lines 20-45). Nothing signs before auth: `connect.challenge` is a bare server nonce (`<openclaw>/dist/ws-connection-Cq7PPwbb.mjs` lines 314-323), and `hello-ok` carries no signature.                                      |
| (b) A TLS certificate pinned from an owner-only file                            | Yes, when TLS is already on; off by default | **Live** on a development instance with TLS on. Pinned `wss://127.0.0.1` paired silently with all six, plain `ws://` was reset, and an impostor dialled with the pin got 0 application bytes ("gateway tls fingerprint mismatch"; `applyGatewayWebSocketTlsPin`, `@openclaw/gateway-client` `dist/index.mjs` lines 565-600). |
| (c) A Unix-domain socket with peer credentials                                  | No                                          | The operator API is TCP only. OpenClaw's `.sock` files are internal channels.                                                                                                                                                                                                                                                |
| (d) The gateway proves it knows the token first                                 | No                                          | The first frame must be `connect` with the credential (`<openclaw>/dist/message-handler-CRCo2VX0.mjs` lines 3520-3521).                                                                                                                                                                                                      |
| (e) The account that holds the accepted end of this exact connection            | Yes, as an account check only               | **Live**, below. The confirming review showed that a same-account proxy passes it even when a sandbox denies that proxy the settings file.                                                                                                                                                                                   |
| (f) The listening program: what the kernel says that holder runs and holds open | Yes, as an OpenClaw-instance check          | **Live**, below. It refused a same-account forwarding proxy that (e) alone would have passed.                                                                                                                                                                                                                                |

**With TLS on: the pin (b).** This is the gate whenever OpenClaw already has TLS on.

- **Where the pin comes from.** The public leaf certificate at the configured `gateway.tls.certPath`, or else `<state>/gateway/tls/gateway-cert.pem`.
- **How it is read.**
  - A held-descriptor walk through ancestors that no other account can write to.
  - Links are refused, and so is a relative custom path that could mean more than one place.
  - The leaf must be an owner-only regular file.
  - The generated `gateway/tls` folder is 0755 inside the private state folder, and that is allowed when the integrity checks pass.
- **What it proves.** A file certificate pins the leaf, and TLS proves the other end holds the matching private key. For a custom path, the public certificate's mode says nothing about who can read the key, so Clawtrate claims only possession of the key.
- **What it is bound to.** The pin belongs to one profile and one normalized endpoint.
- **When it is checked.** The SHA-256 of the leaf's DER is compared on the same TLS socket after `secureConnect`, before the upgrade. The pinned client already defers its upgrade until the pin passes. A second check before the credential frame isn't needed once the checked socket is the one used.
- **A mismatch** closes the socket and keeps the prior pin.
- **A local rotation** needs a new Look again and Connect against the newly verified file. A manually pinned remote address needs the new fingerprint from a trusted channel.
- **A TLS failure** never falls back to plain `ws://`.

**With TLS off: (e) and (f) together, before the first byte and again before the credential.** Clawtrate dials the TCP socket itself: a pinned `undici` `Agent` connector hands that socket to the WebSocket, so the socket that is checked is the socket that is used. On that socket:

1. **(e) The accepted end.** Find every holder of the server end of this exact connection, by its four-tuple `127.0.0.1:<port> → 127.0.0.1:<our local port>`.
   - At least one holder must be found, and every holder must be a process of this account.
   - The macOS kernel returns `EPERM` for another account's or root's descriptors to an ordinary caller (XNU `proc_security_policy`, cited by the review), so their holders are invisible and the check fails closed.
2. **(f) The listening program.** For that holder's PID, the kernel's own facts must all match. None of them come from the process's own arguments, which OpenClaw overwrites anyway: the live gateway's argument list read `openclaw-gateway`.
   - **Executable.** The executable the kernel reports (`proc_pidpath`) is a Node binary.
   - **OpenClaw's native module.** Its mapped code includes OpenClaw's own native module, `node_modules/@openclaw/fs-safe-<platform>-<arch>/fs-safe-native.node`, inside a package whose `package.json` is `openclaw` 2026.10.6. The module's SHA-256 equals the value Clawtrate pins for that version and architecture, from the published `@openclaw/fs-safe-*@0.25.0` packages that 2026.10.6 depends on exactly (`<openclaw>/package.json` lines 1843-1844). The module is ad-hoc signed with no team, so its code signature proves nothing and the hash is what binds it.
   - **The profile's files.** It holds open descriptors on the profile's `tmp/openclaw-<uid>/gateway.state.lock` and `state/openclaw.sqlite`. Each is matched by device and inode against Clawtrate's own no-follow open of the same file.
   - **The lock names it.** The lock is OpenClaw's compatibility projection of its gateway owner (`<openclaw>/docs/gateway/gateway-lock.md`), owner-only, read with the reader's rules. It must name this PID, role `gateway`, this port and this profile's state folder, with a `startTime` equal to the kernel's start time for the PID, to within a second.
3. **Bounds.**
   - Both checks run in a small helper off the main thread, with a 2 s deadline and bounded output. On macOS the helper uses libproc (`proc_pidfdinfo`, `proc_pidpath`, region and vnode info), as `lsof` does. On Linux it reads `/proc/net/tcp`, `/proc/<pid>/exe`, `/proc/<pid>/maps` and `/proc/<pid>/fd`.
   - A missing helper, a timeout, denied access or malformed output all mean unverified, and nothing is sent.
   - Every socket is checked, retries and reconnects included, whether it would carry the shared token or this device's own token.
4. **When nothing proves the peer,** nothing is sent. The card stays at "OpenClaw settings found" with "Clawtrate couldn't verify what is listening at port ‹port›." It offers Look again and the address route, without filling in its token.

**Live, on a development gateway of this checkout's (`exec` in the probe).**

- **Two direct connections to the gateway passed every check**, in 326 and 534 ms with `lsof`, with nothing sent. The facts:
  - the executable was a Node binary;
  - OpenClaw's native module was mapped from the 2026.10.6 package;
  - the gateway lock and the state database were held, matched by inode;
  - the lock named the PID, role `gateway`, the port, the state folder and the kernel's start time.
- **A same-account TCP proxy that forwarded every byte to the gateway was refused** in 637 ms, with nothing sent. (e) alone would have passed it. The proxy had full access to the profile's files, and was refused anyway: it mapped no OpenClaw module, held neither file, and isn't the process the lock names.

**What (e) and (f) prove.** At the moment of the check, the server end of Clawtrate's connection is held only by processes of this account. One of them is a Node process that:

- has OpenClaw 2026.10.6's own native module loaded;
- has this profile's gateway lock and state database open;
- is the process this profile's OpenClaw records as its running gateway, with the same start time.

A process that can't open the profile's 0700 folder (a sandboxed proxy, the case the review built) can't hold those descriptors, and is refused.

**What they don't prove:**

- **That the JavaScript running is unmodified OpenClaw.** Node loads scripts and closes them. A process of this account with write access to the package, or the power to inject into the gateway, could change what runs. Such a process could read the token anyway.
- **That no other holder exists.** An unprivileged scan can't see a duplicate of the accepted socket held by another account. One could exist only if a holder of this account passed it on (`SCM_RIGHTS`, inheritance).
- **The moment between the last check and the write.** Two checks narrow that window but don't close it.
- **That the gateway is the one its address implies,** in any cryptographic sense. Only (b) does that.

§13 states what remains, and the product owner's acceptance of it.

**Over SSH,** the same rule applies on the far side. The SSH host key authenticates the SSH server. The forward's far end is still an unproved loopback connection, and a scan of connections attributed to `sshd` can't bind its result to Clawtrate's channel. So:

- With TLS on there, Clawtrate reads the certificate over the authenticated SSH channel and checks it inside TLS through the forward (`tlsServerName` 127.0.0.1). The certificate is read there under the same rules as on this Mac (above), so SSH doesn't stand in for a certificate those rules refuse.
- Without TLS, the SSH route sends no credential by itself. The person uses the address route, or turns TLS on themselves.

### The settings reader

A bounded, read-only reader. It never repairs a file or a permission, and runs no OpenClaw code.

- **Where.**
  - Only `~/.openclaw/openclaw.json` (the default profile) and `~/.openclaw-clawtrate/openclaw.json`, under the home folder the operating system reports for this account.
  - `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` affect only processes started with them (`<openclaw>/dist/paths-BP0DYpE8.mjs` lines 117-140, 214-223).
  - If both profiles qualify, both are shown by name: "Choose the OpenClaw profile to connect to."
- **Which home.** Every entry point of the reader requires a `sandboxed` option, and the choice is made before anything is opened.
  - A production run reads only the home the operating system reports for this account, refuses any other home a caller names, and reads nothing when that home can't be determined.
  - Any other run, including one with the option missing, reads only a private folder of this account's below one of this machine's temporary roots, away from the account's real home.
- **Opening.**
  - The home folder is opened without following a link, held as a descriptor, and checked on what was opened. In production it must be this account's, with no group or other write bits, and no ACL entry that lets another account change its entries. In a sandboxed run it must be the very folder that was checked, by device and inode, and still private.
  - The profile folder is opened as a held directory descriptor beneath the held home. Each untrusted component is walked without following links.
  - The file is opened relative to that descriptor: read-only, no-follow, nonblocking. A FIFO fails without blocking.
  - Node has no `openat`. The same native helper as the send gate does this, and checks ACLs (below).
- **Checks on what was opened (`fstat`).**
  - The folder is this account's and private.
  - The file is this account's, a regular file with one link, mode exactly 0600.
  - Neither carries an ACL that grants anything to another account.
  - At most 1 MiB, checked against the bytes actually read as well as the first size.
  - OpenClaw writes them as 0700 and 0600 (`<openclaw>/dist/io.write-DVKwks5G.mjs` lines 171 and 267).
- **Parsing.**
  - `json5` 2.2.3, pinned as a direct dependency (it is already in the lockfile). It is a non-evaluating parser: it follows no `$include`, does no `${…}` interpolation, and imports no OpenClaw code.
  - `json5` has no depth or work limits of its own. So it runs only after a small in-tree lexer has passed the same 1 MiB of text, and that lexer is reviewed against these limits in PR 2a:
    - at most 32 levels of nesting;
    - at most 20,000 tokens;
    - the keys of every object recorded, for the rejections below.
  - The parse runs in a worker with `resourceLimits` and a deadline.
  - It rejects:
    - duplicate keys;
    - the names `__proto__`, `constructor` and `prototype`;
    - `$include` at the root or anywhere under `gateway` or `env`. A root include can change values inside a `gateway` block that looks complete, and an `env` include could add a password fallback.
  - It takes own properties of plain objects only. OpenClaw's format is JSON5 (`<openclaw>/dist/io.read-helpers-CMGXaUZA.mjs` lines 89-95, 119-156).
- **What it extracts.** A local gateway's literal token, and nothing else.
  - `gateway.mode` must be `local` or absent.
  - `gateway.auth.mode` must be `token` or absent. An absent mode can mean password (`<openclaw>/dist/auth-resolve-2uQi6dqM.mjs` lines 21-59).
  - `gateway.auth.password` must be absent in both cases, explicit `token` mode included. A mixed-auth fixture (a token and a password, with and without a mode) checks that the reader never stages a token.
  - With the mode absent, any password OpenClaw could resolve would put it in password mode, so a password fallback refuses implicit token mode too:
    - a `gateway.remote.password`;
    - an `OPENCLAW_GATEWAY_PASSWORD` key in `env` or `env.vars`;
    - the login-shell fallback, which fills a missing `OPENCLAW_GATEWAY_PASSWORD` from the shell. It is on with `env.shellEnv.enabled`, or with an `OPENCLAW_LOAD_SHELL_ENV` in the file's `env` that OpenClaw reads as true.

    Explicit `token` mode stays eligible beside these fallbacks.

  - The token is rejected when it is a SecretRef object, an unresolved `${…}`, the redaction sentinel, empty, longer than 4 KiB, or contains control characters. Ordinary punctuation is kept, with OpenClaw's own trimming.
  - Password and `none` modes are later routes, not this one.
  - The port must be an integer from 1 to 65535. When the file names none, it is the profile's own default: 18789 for the default profile, and 22768 for `clawtrate` (OpenClaw's `20000 + FNV-1a(name) % 40000`). A port that the file's own `env` could override is refused. Either way it is a candidate: a running gateway can override it (`--port`, `OPENCLAW_GATEWAY_PORT`; `config-gateway.md` lines 135-146).
- **Using the credential.**
  - The look reads the token only to decide what the card says, and drops it.
  - Connect reads it afresh and keeps it in the host for that bounded attempt only. It is dropped on cancel, failure, timeout or pairing.
  - It goes through the existing staged setup-credential path, with its checks before the send and before a grant is saved (`packages/core/src/client.ts` from line 1289).
  - It never enters preload or renderer state, crash breadcrumbs, logs, arguments, child environments or temporary files.
  - The gateway's own pairing write is the one expected effect of Connect.

### The first screen on a Mac with OpenClaw

The look only reads files and proves sockets, so it runs before the person answers "Where does OpenClaw run?".

1. **Settings found, not yet proved:** a card "OpenClaw settings found", with "Port 18789 · default profile · version 2026.10.6" under it. The version comes from OpenClaw's own `package.json`. The look then opens one socket, runs the send gate on it, sends nothing, and closes it. The result is a discovery hint for the card; Connect checks again on its own sockets.
2. **Proved:** the card says "OpenClaw is running on this Mac", with **Connect** and the consent line of §2 above it. Below it, quieter, is "Another computer".
3. **Connect** shows steps in place of the button: "Reading OpenClaw's settings", "Checking it's OpenClaw on this Mac", "Pairing this Mac", "Loading your bots". This takes one to three seconds. Each socket is proved again (above).

Clicking Connect is the consent. There is no second dialog. On this Mac the count is **1 click, 0 commands, 0 approvals**, with OpenClaw's defaults (TLS off, through (e) and (f)) and with TLS on (through the pin). It changes nothing in OpenClaw.

### In development

A sandboxed run reads the development instance's own `openclaw.json`, proven as `sandbox.ts` proves the instance today. The development config contract has TLS off, so the setup checks exercise (e) and (f). On a development gateway, the pinned hash of OpenClaw's native module is the hash of the installed 2026.10.6 package's own file. F-492's boundary tests add four cases, each asserting zero upgrade and zero credential bytes:

- a same-account forwarding proxy;
- a same-account proxy that a sandbox denies the settings folder;
- a listener that holds the port while the instance is stopped;
- on a hosted macOS runner, a listener from a second account.

The TLS path is checked by a probe-style test that turns TLS on in its own instance only. A development gateway has local auto-approval off by its contract. So the setup checks start their instance with `--default-local-pairing` for the zero-approval path, and without it for the one-approval path.

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

- A loopback address has no fingerprint flow. On this Mac, §3's gate decides what may be sent, and a fingerprint offered for a loopback address would come from the same unproved socket.
- A gateway on this Mac can still be reached by address through a `wss://` name that isn't loopback, such as a Tailscale Serve address, under the rules above.
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
- This device's code, large, in mono: 8 Crockford Base32 characters from the SHA-256 of its public key, in two groups ("K7QF-2MXA"), and where to pick it (§5).
- "Asked for: full control", with the six in plain words.
- Three ways to approve, in this order:
  1. In Clawtrate on a device already connected with full control.
  2. In OpenClaw's Control UI on the gateway's computer, under Devices (`<openclaw>/docs/web/control-ui/connect-and-pair.md` lines 32-34).
  3. Last, the command `openclaw devices approve <requestId>`, with the profile line of `setup.md` §9.

**How the waiting device learns the request ended.** Clawtrate retries every 3 seconds, and each retry is a new `connect`. In 2026.10.6 every connect from a device that isn't paired files or refreshes a pending request (`requestDevicePairing`, `<openclaw>/dist/message-handler-CRCo2VX0.mjs` line 2061). It keeps the same id while that request is pending and makes a new one otherwise (§5, "What a `requestId` binds"). The device gets no event when it is denied:

- `device.pair.resolved` goes only to pairing connections (§5).
- A connection is held open for its own decision only for OpenClaw's Control UI (`waitForResolution = state.isControlUi && role === "operator"`, same file line 2057).
- A Deny deletes the pending row and keeps no record of it (`rejectDevicePairingInWorker`, `<openclaw>/dist/device-pairing-core.worker-B-kYFMQS.mjs` lines 327-341).

So:

- **The signal.** The `PAIRING_REQUIRED` answer carries the id of this device's pending request (`requestId`, `message-handler-CRCo2VX0.mjs` lines 2156 and 2180). While the request waits, every retry gets the same id. A different id means the request Clawtrate was waiting on ended without approval: denied, expired or superseded. 2026.10.6 doesn't say which.
- **Clawtrate stops on that signal,** before any further connect, with "This request is no longer pending." and "Ask again".
- **The one request that retry filed.** Nothing refreshes it, so it expires on the gateway five minutes later. Other admin devices see it as a new request. Approving it approves this same device and grant, and the next Ask again connects.
- **A code the gateway refuses** (`AUTH_BOOTSTRAP_TOKEN_INVALID`) also stops the retries.
- **No new request by itself.** After either stop, Clawtrate makes no new request until the person chooses Ask again.
- **The cap.** Clawtrate caps its own wait at 10 minutes. The gateway's five minutes count from the last refresh, which the public record hides. After the cap: "Clawtrate stopped waiting for approval." and "Ask again".

## 5. Approving a device from inside Clawtrate

A Clawtrate that already holds admin on a gateway approves a waiting device with one click, and nothing is typed. The waiting device shows a short code made from its own key. The approving device shows the request and a few codes; the person picks the one the waiting device shows. The app approves with the gateway's own `device.pair.approve` and checks afterwards that what was paired is what it showed.

### Why this design

An earlier version of this section had the approver type a 16-character code and installed a helper plugin on the gateway, with its own consent, so the comparison ran inside the gateway's approval. Both are gone. Typing a code and a consent step to install a plugin are the friction this is meant to remove: connecting takes one approval at most, and it is a click.

- **No typing.** Picking a code is the one click, and it is also what shows the person looked at the right device: a request from somewhere else carries a code that isn't on their device's screen.
- **No helper plugin.** The gateway keeps a request's key, roles and scopes fixed under one request id (below). So approving by id, after reading the request again and finding what was shown, approves what was shown. Reading the paired device back afterwards, and removing it if it differs, covers what slips between the read and the approval.
- **The binding is OpenClaw's code, not its contract.** A scenario check holds it on each version the development gateway runs (`tools/dev-gateway/src/pairing-checks.ts`, `pnpm scenarios --pairing`).

### What OpenClaw allows (2026.10.6 and 2026.11.10, source and live)

`<openclaw>` is a scratch copy of each version's npm package. 2026.11.10's `dist/` is minified one-line files, so for it the file is named and the same function was read there. The pairing checks ran on both.

- **Who files a request.** A connect is authenticated before pairing is considered (`rejectUnauthorized`, `message-handler-CRCo2VX0.mjs` lines 1263-1269). In token or password mode that means the shared secret, a setup code (`device.pair.setupCode`, admin, 10 minutes) or a device token. So a stranger's request comes from someone holding the shared secret, a code made for someone else, or, in other auth modes, a trusted proxy's identity header or no secret at all.
- **The code check is still needed.** The shared secret is on every computer it was ever typed into and in the gateway's settings file. A code is a bearer pass for its 10 minutes. A device's name is whatever it reports. And the person may have two requests waiting, theirs and someone else's. Only the code tells them apart.
- **What a request id binds.** A request is refreshed under the same id only when its public key, browser origin and role are unchanged and its roles and scopes stay within the existing set; a refresh keeps the existing roles and scopes (`canRefreshPendingDevicePairingRequest` and `refreshPendingDevicePairingRequest`, 2026.10.6 `device-pairing-core.worker-B-kYFMQS.mjs` lines 240-274; 2026.11.10 `device-pairing-core.worker-CXQtJOvQ.mjs`). Anything else deletes the device's pending request and makes a new id (lines 279-324), broadcast to the old id as `device.pair.resolved` `rejected`. Only reported fields and `remoteIp` move under one id. A browser origin is recorded only for OpenClaw's browser copilot client, so a Clawtrate request never has one (`resolveGatewayWsBrowserOrigin`, `ws-origin-policy-sYiBryoo.mjs` lines 148-156).
- **Who decides.** `device.pair.approve` and `device.pair.reject` on a connection with `operator.admin` decide any request; the approver must hold every scope it grants, which admin does (`devices-mOg4_HQd.mjs` lines 355-365; `device-pairing-core.worker-B-kYFMQS.mjs` lines 127-143). A device-token connection without admin lists and decides only its own request (lines 303 and 341-354). So the six, which a first pairing asks for where it is safe (secure storage, writes allowed and a protected route, §2), approve a request for the six or for fewer; a device paired with less, or a read-and-pairing device, approves nobody.
- **Who is told.** `device.pair.requested` and `device.pair.resolved` go to connections holding `operator.pairing`, which admin satisfies (`EVENT_SCOPE_GUARDS`, `server-start-D6vaUNGz.mjs` lines 4309-4311; 2026.11.10 `gateway-prewarm.js`). `requested` is sent for a new request, not a refresh (`message-handler-CRCo2VX0.mjs` line 2141).
- **The waiting device.** Every connect answers `PAIRING_REQUIRED` with its request id (line 2180), and Clawtrate retries every 3 seconds (§4). After an approval the next connect is let in, so its screen moves on by itself. A rejection deletes the request and revokes the device's setup codes (`rejectDevicePairingInWorker`, lines 327-341). A device connecting with the shared token then files a new id on its next connect, and Clawtrate says "This request is no longer pending."; one that came with a setup code is refused it (`AUTH_BOOTSTRAP_TOKEN_INVALID`), which also stops its retries (§4). A request lives 5 minutes from its last refresh (`DEVICE_PAIRING_PENDING_TTL_MS`, `device-pairing-identity-D438fF14.mjs` line 602), so it doesn't expire while the device retries.
- **No bound.** Neither version caps pending device requests or rate-limits filing them, beyond one per device id and the five minutes; twenty keys make twenty requests. (2026.11.10's cap of 32 applies only to its own browser pairing requests.)

### The code

- **A request's code** is 8 characters of Crockford's Base32 over the first 40 bits of SHA-256 of a fixed label, the raw 32-byte Ed25519 public key and the gateway's id for that request, in two groups: `K7QF-2MXA` (`pairCode` in `packages/core/src/device-approval.ts`, one function for both sides).
  - The gateway makes the id with `randomUUID()` when it files the request (2026.10.6 `device-pairing-core.worker-B-kYFMQS.mjs` line 293; 2026.11.10 the same function in `device-pairing-core.worker-CXQtJOvQ.mjs`) and gives it to the waiting device as `details.requestId` of its `PAIRING_REQUIRED` answer (`buildPairingConnectErrorDetails`, `message-handler-CRCo2VX0.mjs` line 2180; 2026.11.10 `message-handler-BWGnyhL-.mjs` line 40). The approving device reads it from `device.pair.list`, and checks that the device id is the key's hash.
  - So the code can't be computed before the request exists. A compatible retry keeps the id, and with it the code. A new request (after a denial, an expiry or a change) brings a new id, which is a new input to the hash: its code is drawn afresh and matches the old one only by the same 1-in-2^40 chance. A device's key alone is permanent and public, so a code from the key alone could be matched offline, ahead of time.
- **The choices** are the request's own code and three others, sorted. The others are SHA-256 over 32 random bytes the app makes once, the key, the id and a counter, so a request gets the same choices each time the sheet opens, and looking again gives nothing away. They never equal the request's code or each other. Sorting puts the real code at a uniformly random place, and nothing in the form tells it apart.
- **Two waiting requests with the same code** (once in 2^40 for a pair, by chance) are both blocked, the rows past the sixteen included: neither is picked, and the sheet says to deny both and ask again from the new device.
  - Once this host has seen a request share a code, that request stays blocked for as long as it waits, even after the other is gone: it takes Deny and Ask again, which brings a new id. At most 32 such requests are remembered; past that every request is blocked until the gateway lists none.
  - These checks run over the list Clawtrate last read: on each list read, and again on the read just before the approval, which publishes the whole list by the same rules if it is the newest and approves nothing if it isn't. The read and the approval are separate gateway calls, so a request filed between them isn't seen by that check. Closing that gap would take a conditional approval in the gateway itself.
- **The numbers.**
  - Another request shows the same code as the person's own once in 2^40, about 1 in 1.1 trillion; comparing only the first group, once in 2^20, about 1 in a million. Among many requests at once, some pair shares a code by the birthday bound, which doesn't make matching one particular code any cheaper.
  - Matching a code someone has seen needs a new id at the gateway for each try, about 2^40 of them, each a request filed with a credential that can file one; a retry of the same request is no new try. And a match seen in the list is blocked, since both requests then show it.
  - A pick made without looking approves a stranger's request one time in 4 among the codes, or one in 6 among every choice, and only once: a wrong pick takes no second pick for that request on this device.

### Who sees it

- **Only a connection with admin**, on a host that allows writes, lists requests (`device.pair.list`, read on each hello, once for a burst of events at most once a second, and every 30 seconds while any wait; a read that fails is tried again 1, 4, 16 and 64 seconds later; then the last list read stays shown with the failure, and nothing is read until the next event, hello or refresh; a failure older than a list already applied changes nothing) and decides them. A setup connection lists and decides none, whatever it holds: it publishes typed outcomes only. When setup ends on that connection, the list is read at once.
- **One sheet per app host.** It opens by itself only for the only waiting request, once, in the window that has focus. More than one waiting is one quiet line in the rail, "3 devices are asking to use this gateway.", with Review.
- **A connection with pairing but no admin** shows a notice: "A device is asking to connect. Approve it in Clawtrate on a device with full control."
- **A connection with read alone** receives no pairing events and shows nothing.
- **Settings, Gateway, "Devices asking"** lists them, newest first, each opening the same sheet. At most 16 are kept; past that, "4 more are waiting." A flood of requests is a list, never a stack of sheets.
- **While more wait than are shown**, none takes a pick: the person can't judge a set they can't see. Each says too many devices are asking. Deny shrinks the list, and older requests come into view as it does; while new requests keep arriving faster, approving through Clawtrate stays unavailable, and the gateway's owner approves on the gateway's computer (§4) or first shuts out the access the requests come from.
- **After any refusal or wrong pick** on this host (a wrong code, "None of these match" on a request offering codes, or "I didn't start this"), no sheet opens by itself for five minutes, for every device asking on this gateway, across reconnects; each refusal starts the five minutes again, and only pointing Clawtrate at another gateway clears them. The requests are still listed and can be opened and decided at once. So a stream of new keys can't put sheet after sheet in front of the person.

### The sheet

- **Title.** "A device is asking to use this gateway", then the gateway's name.
- **Reported by the device.** Name, platform and app, each one line of at most 64 characters with control and format characters removed, each marked "(reported)".
- **Seen by the gateway.** "From ‹remoteIp›" when it reports one, otherwise "Address not reported".
- **What it would be allowed to do**, each scope in plain words.
- **"Which code does the waiting device show?"**: "I didn't start this" and "None of these match" first, then the four codes. A screen reader reads each as "Code K 7 Q F, 2 M X A".
- **Focus** starts on the title, outside the decisions. Tab reaches the two refusals before any code. Escape is "Not now", which decides nothing.
- **Not approved here**, with no codes and only "I didn't start this": a request whose roles aren't exactly `operator` (machines, `device-node.md`), one from a device already paired asking for more, one asking for a scope outside the six, and one whose key doesn't match its device id.

### A pick

- **The request's own code.** The app reads `device.pair.list` again. If the request is gone: "This request is no longer pending." If its key, device id, roles, scopes or origin differ from what was shown, or it became a repair: nothing is approved, and the sheet says what changed. Otherwise `device.pair.approve {requestId}`. An "unknown requestId" answer is "no longer pending"; any other refusal is said as the gateway said it.
- **Afterwards.** The app reads the paired device. Its key, its roles (exactly `operator`), its scopes and its one live operator token's scopes must be exactly what was shown. Then: "Approved. The device connects in a moment." If any differs, the app removes the pairing at once (`device.pair.remove`) and says what differed; the removal counts only once a read of the paired devices no longer lists it (an answer without a paired list confirms nothing), and if it fails or isn't confirmed, the app says so and where to remove it.
- **An answer that was lost** is read back the same way, once: a paired device as shown is "Approved"; one that differs is removed on that read, as above; not paired, or not readable, is "Clawtrate didn't get the gateway's answer, so it can't say whether the device was approved." The request stays taken until it leaves the list, so no second approval for it goes from this host.
- **Another code** approves nothing: "That isn't this request's code, so nothing was approved." That request takes no other pick on this device. "Deny it" lets the device ask again.
- **"None of these match"**, offered only where codes are, sends nothing: "Nothing was approved." "Deny it" follows. It is a pick like a code: a request picked for once takes no other, and only "I didn't start this" remains.
- **"I didn't start this"** calls `device.pair.reject`: "Denied. The device can ask again."
- **After a denial** a device on the shared token learns of it on its next connect, which files one more request as it stops (§4). That request is listed, and the five quiet minutes above keep it from opening the sheet by itself.
- **Several windows and hosts.** Each decision reads the list again, so another window's or host's decision, an expiry or a supersession ends as "no longer pending". The app never names who decided.
- **One connection.** Every read and write of a decision goes on the connection the sheet was read on. If it changes before the approval is sent, nothing is approved; after, nothing more is read or removed there, and the result is "not known".
- **The reads are ordered.** Every `device.pair.list` on a connection goes through one function, whichever path asks (the list read, a decision's read again, the read of a device just paired, or Settings, Machines reading, renaming or removing a paired device), and is numbered as it goes out; that function applies every reply's waiting requests on a connection with admin, and Machines takes its paired devices from the same reply. A source check fails for any other sender of the method in the app's code. A reply without a pending list changes nothing, and a decision resting on one approves nothing. A reply older than the newest one applied changes nothing: it prunes nothing, publishes nothing, and a decision resting on it sends no approval (it ends "not allowed" and the list is read again). A decision whose read is the newest applies it like any list read, then decides on the list as published: a request not in it (hidden past the sixteen) or blocked in it takes no approval.
- **One decision at a time per request.** A pick takes its request before anything is sent, with a token of its own, and keeps it until the gateway's answer: a second press, another window's pick, "None of these match" or "I didn't start this" on that request in the meantime decide nothing. Only the decision holding the token frees the request, so one that ends after Clawtrate moved to another gateway frees nothing a newer decision holds. A decision the gateway may have acted on (approved, a denial, or either whose answer was lost) keeps the request taken until it leaves the list.
- **A sheet belongs to the connection that listed it.** The list carries the connection it was read on, and every decision carries it back; one made on a list an earlier connection published sends nothing, spends no pick and starts no quiet minutes, and the new connection has read its own list on its hello.

### The waiting device

Its pairing screen shows its code, large, in mono, and one sentence: "Or approve it with one click: open Clawtrate on a device that already has full control of this gateway and pick this code there." The rest of that screen is §4's.

### Not here yet

- Approving a scope upgrade of a device that is already paired: the same sheet fits, with what it holds beside what is added, once the after-check compares against that.
- Removing or renaming paired devices: Settings, Machines.
- The iPhone app's own code while it waits (§9).

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
| TLS on, with no certificate Clawtrate can read under §3's rules                | "Clawtrate couldn't safely read OpenClaw's certificate. It must be a private file that belongs to your Mac account."    | Look again once it is; a `wss://` address that isn't loopback (§4). SSH reads it under the same rules (§3)        |
| The endpoint changed during an attempt                                         | "OpenClaw's address or listener changed. Look again."                                                                   | Look again                                                                                                        |
| The token was refused                                                          | "OpenClaw didn't accept the token in its settings."                                                                     | An address and token                                                                                              |
| `PAIRING_REQUIRED` (local auto-approval off)                                   | §4's waiting screen                                                                                                     | as there                                                                                                          |
| A narrower grant                                                               | "OpenClaw granted less than full control." with what is missing                                                         | Continue with what was granted                                                                                    |
| Secure storage unavailable                                                     | "Clawtrate couldn't save this device securely. Unlock your keychain and try again."                                     | Try again; this session only                                                                                      |

Where an action above names an address for a gateway on this Mac, it means a `wss://` address that isn't loopback, under §4's rules. A typed loopback address is refused there, with no fingerprint flow. SSH to this Mac sends a credential by itself only with TLS on and a certificate §3's rules accept.

## 9. iOS

The iPhone app (#14, #52) isn't on `main`.

- **Connecting.** It asks for all six, with the consent line and the same transport rules: `wss://` or nothing.
- **Its first screen**: "Scan a code from Clawtrate", "Paste a setup code", "Enter an address and token".
- **Waiting.** Its waiting screen shows its code (§5), to pick in Clawtrate on a device with full control.
- **"Connect a phone" on the desktop** (F-506) works with no command.
  - With admin, the desktop calls `device.pair.setupCode` with an address the phone can reach. It shows the QR code and expiry, and keeps the dialog open. The phone's request then opens §5's prompt.
  - Live: a full code made this way lived 600 s. A new device redeeming it for six waited; the admin device approved; the device's retry with the same code got all six. A limited code refused six.
  - The request carries no `setupId`, so the picked code is what ties the phone to the sheet.
- **Addresses.** A loopback-only gateway has no address for a phone. A plain `ws://` LAN address is refused by the transport rule.
- **Its key.** The phone keeps its device key and token in the iOS Keychain.

## 10. Decisions this supersedes

Each quote is from `docs/decisions.md`, `docs/design/setup.md` or `docs/parity.md` as it stands. The build rewrites those sections with the replacement.

1. `decisions.md`, **Scopes, in tiers**:

   > "A device starts read-only: every `connect` requests exactly `operator.read` … `operator.admin` and the narrower `operator.sessions.*` scopes are never requested."

   Replacement: "**Scopes, once, at the first pairing.** A first pairing asks for `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, `operator.admin` and `operator.pairing`, after the consent line, because the product owner decided that repeated approvals defeat the purpose. The gateway's confirmed grant is the limit, and a reconnect asks for exactly that. A narrower grant is kept and reported, and nothing asks again by itself. The narrower `operator.sessions.*` scopes are never requested."

2. **Requested is not granted**:

   > "Only `heldScopes`, normalized to read plus whichever interactive scopes were granted, is ever requested"

   Replacement: "Only `heldScopes`, the confirmed grant within what the attempt asked for, is ever requested. An existing device gets one explicit upgrade offer (`setup-effortless.md` §6)."

3. **Pairing**:

   > "On `PAIRING_REQUIRED` it shows the request id and an approve command chosen by the host"

   Replacement: "…it shows this device's code (§5), the scopes asked for, and three ways to approve: picking that code in Clawtrate on a device with full control, OpenClaw's Control UI, and last the approve command chosen by the host."

4. **What the look runs, and when it runs nothing**:

   > "So the look never runs an installed OpenClaw whose version isn't on a list of versions verified to have a read-only path (`READ_ONLY_VERSIONS` …), and that list is empty."

   Replacement: "The look runs no OpenClaw program on any version. It reads the version from `package.json`, and the address and token from `openclaw.json` with the bounded reader of `setup-effortless.md` §3. It sends nothing to a socket until it passes `setup-effortless.md` §3's send gate: OpenClaw's TLS pin when TLS is on, and otherwise the account that holds the accepted end plus the kernel's facts about that holder. `READ_ONLY_VERSIONS`, `gateway status`, `config get` and `qr` leave the look."

5. **The host's confirmation**:

   > "Connect asks for read access, always, and the card's button says 'Connect read-only'."

   Replacement: "Connect asks for the six. The consent line sits above the button, and the button is the consent."

6. **The one-time code**:

   > "After the dialog the host runs `openclaw [--profile clawtrate] qr --json --voice-node …`"

   Replacement: removed. The host sends the settings file's token on a socket that passed the send gate, holding it for one attempt.

7. **No grant wider than the request**:

   > "…its role is `operator` and its scopes are exactly `["operator.read"]` (`setupGrant`)."

   Replacement: "…its role set is exactly `operator` and its scopes are within the six asked for."

8. **What a setup connection publishes**:

   > "The shared token is never asked for; only Advanced takes a token, typed."

   Replacement: "The shared token is read from OpenClaw's settings file, held in the host for one attempt, sent only on a socket that passed the send gate, and scrubbed from everything the client publishes and logs."

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

**The change to `AGENTS.md`, approved by the product owner.** It was made in setup PR 1 (#318), not in this design, and replaced again on 2026-11-25 (`docs/decisions.md`, "One pairing, with everything"), when the six became the default. It replaced "Request the smallest operator scopes a feature needs, and keep a read-only connection useful." Because #318 put full access behind a flag that was off, `AGENTS.md` read, until 2026-11-25:

> "First pairings request read access by default. Ask once for the six standard operator scopes (read, write, approvals, questions, admin and pairing) only when the person starts an eligible first pairing and the host allows writes, reports secure credential storage and has full-access pairing enabled. Explain full control before connecting. Treat the gateway's confirmed grant as the limit, and request only the scopes this device holds when it reconnects. Keep read-only connections useful. Changing an existing connection's grant requires the person's consent and the gateway's approval policy. Use the least authority each feature needs, and ask for no additional scope without a documented reason and explicit approval. Provider credentials stay on the gateway."

## 11. Parity rows

- **F-002** keeps "a pending-approval screen lists the exact operator scopes requested", now six.
- **F-491, F-492, F-494, F-515 and F-516** become reachable on a real computer. F-492's boundary checks (`apps/desktop/test/setup-connect-boundaries.test.ts`) gain four cases from §3's "In development": a same-account proxy, a sandboxed same-account proxy, a port holder while the gateway is down, and another account's listener on a hosted runner. In each, zero upgrade and credential bytes are sent.
- **F-496** reads the settings file over SSH, and sends a credential by itself only through a TLS pin read over SSH.
- **F-500** becomes §6: the shared-token upgrade on a proved local socket, the remote request with one owner decision, and the owner's route when local auto-approval is off.
- **F-506** becomes §9.
- **F-509** changes as in §10.
- **F-550** is the approve sheet: a picked code, the request read again before `device.pair.approve`, and the paired device checked after it.

## 12. What still needs an approval or a command, and why

| Case                                                                 | What 2026.10.6 forces                   | Why                                                                                                                                                                                  | Smallest path around it                                                                |
| -------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| The first device of a gateway by address                             | One approval                            | Off loopback, a client that isn't one of OpenClaw's own apps is never paired by its credential alone (`resolvePairingApprovalPlan`, `message-handler-CRCo2VX0.mjs` lines 1916-1969). | SSH (0 when TLS is on there); the Control UI's Devices (no command); the command, last |
| This Mac with `autoApproveLocal: false`                              | One approval                            | The owner turned silent local pairing off (`node-connect-reconcile-CAkPC2vI.mjs` line 182).                                                                                          | The Control UI or the command; Clawtrate doesn't run it                                |
| A token kept as a SecretRef                                          | Typing the token once                   | The value is in OpenClaw's database, a service's environment or a command                                                                                                            | The address form                                                                       |
| A socket whose other end can't be proved                             | No connection                           | §3                                                                                                                                                                                   | §13                                                                                    |
| This Mac with TLS on and a certificate that isn't an owner-only file | One change to the file, then Look again | The pin is only as good as the file it is read from (§3)                                                                                                                             | A `wss://` address that isn't loopback, with a certificate the system trusts (§4)      |
| A changed platform or family                                         | One approval off loopback               | The gateway pins both                                                                                                                                                                | Never change them                                                                      |
| A token its owner narrowed                                           | Keep the narrower grant                 | The owner's limit wins                                                                                                                                                               | None, by design                                                                        |

## 13. Residual risk on this Mac, accepted

**The decision.** The product owner chose the local send gate of §3. As relayed to this design: "pure one-click Connect, with the account check plus a check of the listening program's executable", "no TLS switch and no OpenClaw restart". The confirming review found that the account check alone isn't a proof of identity. The relay records that the product owner "accepts that narrow residual risk".

**What is at stake.** OpenClaw's shared token. Whoever has it can pair a device with full control, and that includes a terminal as the gateway's user.

**What remains, plainly:**

- **A same-account process that grabs OpenClaw's port while OpenClaw is down.** (e) passes it. (f) refuses it unless it also does all of these:
  - holds the profile's gateway lock and state database open;
  - has OpenClaw's native module loaded;
  - is the process the lock names, with a matching start time.

  It can do that only with read and write access to the profile's 0700 folder. With that access it could read the settings file, and the token in it, directly. A sandboxed process denied that folder, the review's case, is refused.

- **Descriptor hand-off.** A process of this account that holds the accepted socket can pass it to another process (`SCM_RIGHTS`, inheritance). That process may run as another account and stay invisible to the scan. It needs the cooperation of a same-account holder, which normally is the gateway itself.
- **Modified OpenClaw code.** A same-account process with write access to OpenClaw's package, or that can inject into the gateway process, can change what runs behind checks (e) and (f). It could read the token anyway.
- **The window between the last check and the write.** It is narrowed by checking twice, not closed.
- **Root.** Root can read the settings file and is outside the account boundary in every case.

**How this compares with OpenClaw's own clients.** OpenClaw's CLI and its Control UI send the same token to the same `127.0.0.1` port the same way, with no check of the peer at all. With TLS off, Clawtrate's gate is stricter than OpenClaw's own. With TLS on, the pin of §3 authenticates the endpoint cryptographically, and Clawtrate uses it.

**What would remove the residue.** A gateway-signed challenge, a Unix socket with peer credentials, or TLS by default. 2026.10.6 offers only TLS, and the product owner decided not to switch it on for the person.

## 14. Not covered

- A gateway-side revoke and a narrower replacement for "Use read-only mode on this device".
- Password and `none` auth routes; Tailscale identity sign-in (`gateway.auth.allowTailscale`).
- Node (machine) approvals, which stay in `device-node.md`.
- Windows, except as another computer reached by a protected route.
- The web preview host, which stays on the address-and-token form.
