# Effortless setup and connection

How a person gets from opening Clawtrate to chatting with their Main Bot with no Terminal command on this Mac, and with at most one approval for a gateway on another computer. This design replaces the read-only-first tiers of `docs/decisions.md` ("Connecting to the gateway") and changes `setup.md` §7, §9, §12 and §13. Everything else in `setup.md` stands: the first screen's question, SSH routes, setting OpenClaw up, routes and identity.

The evidence is `docs/research/setup-effortless/full-scope-probe.ts`, run against development gateways, and OpenClaw 2026.10.6's own source and docs. `<openclaw>/…` is a path in the installed `openclaw` 2026.10.6 package, as in `docs/research/setup-flow.md`; chunk names carry a build hash, so search by the `//#region` marker. **Live** means a probe ran it on a development gateway; **source** means it was read only.

This version takes in two independent reviews and the product owner's decision on local connect. No credential goes to a local socket until Clawtrate has checked who holds the other end of that exact socket: a process of this account, matching this account's OpenClaw profile (§3). What remains is stated, and was accepted (§13).

## Why the earlier decision is superseded

The product owner decided that repeated approvals defeat the purpose of the app, and gave this design the go-ahead to avoid them.

So two things change on purpose:

1. **Clawtrate asks for all six operator scopes at its first pairing**: `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, `operator.admin` and `operator.pairing`. The gateway's confirmed grant is the limit.
2. **Clawtrate approves other devices from inside the app**, with `device.pair.approve` and `device.pair.reject`, wherever OpenClaw 2026.10.6 allows it.

The targets:

| Gateway                                                          | Terminal commands                                                  | Approvals in total                                                     | Clicks to connect |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------- |
| On this Mac, OpenClaw's defaults (§3's gate)                     | 0                                                                  | 0                                                                      | 1 (Connect)       |
| On another computer reached by SSH, with OpenClaw's TLS on there | 0                                                                  | 0                                                                      | as `setup.md` §5  |
| On another computer by a `wss://` address (Tailscale, VPS)       | 0 when another Clawtrate with its helper is connected; otherwise 1 | 1                                                                      | 1 + the approval  |
| A phone or a second computer, once one Clawtrate is connected    | 0                                                                  | 1 approval in Clawtrate, once its helper plugin is on the gateway (§5) | —                 |

Every other approval or Terminal step is a defect. §12 lists the ones 2026.10.6 still forces, says why, and gives the smallest path around each.

The rules that stay:

- No credential goes to a socket that fails the send gate (§3).
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
13. Residual risk on this Mac, accepted
14. Not covered

## 1. What changes, path by path

| Path                                        | Today                                                                                                                                               | After                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| This Mac, OpenClaw running                  | The look reads the version and stops. The person types the address and token under Advanced, then approves up to three access requests in Terminal. | Clawtrate reads the address and token from OpenClaw's settings file. It sends them only on a socket held by this account and matching this account's OpenClaw profile (§3's gate). One Connect pairs silently with all six. With TLS on, This computer offers no Connect: it says why and offers Advanced (pinning OpenClaw's certificate is a design option, §3). |
| This Mac, a device paired earlier with less | Each first send, admin action or Machines visit asks for more, and each request waits for `openclaw devices approve`.                               | One offer, once: "Give this device full control" or "Keep current access" (§6).                                                                                                                                                                                                                                                                                    |
| Another computer over SSH                   | Not built; would run `openclaw qr` over SSH.                                                                                                        | A fixed script reads the settings file there. A credential goes through the forward by itself only when OpenClaw has TLS on there, with the pin read over SSH.                                                                                                                                                                                                     |
| Another computer by address                 | Advanced, read-only, then one approval per tier.                                                                                                    | An address-and-token form or a pasted setup code, on the first screen. `wss://` only. One approval for all six.                                                                                                                                                                                                                                                    |
| A phone                                     | "Clawtrate doesn't make codes for phones yet."                                                                                                      | "Connect a phone" makes a code through the gateway, with no command. The phone asks; Clawtrate on the desktop shows the approve prompt.                                                                                                                                                                                                                            |

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

Clawtrate reads where the gateway listens and its token from OpenClaw's own settings file. It runs no OpenClaw program before or after Connect: OpenClaw's launcher may repair its own installation before any command (`<openclaw>/openclaw.mjs` lines 649-715). Before any credential leaves the host, Clawtrate checks who holds the other end of that exact socket, and that it matches this account's OpenClaw profile (below).

### The send gate

The product owner decided how local connect works on this Mac: one-click Connect, with no TLS switch and no OpenClaw restart. As built, the gate is the account check (e) and the profile check (f): the holder holds this profile's gateway lock and state database open, and is the process that lock names. The check of the listening program's executable that the decision first named was dropped; it appears below only in the dated account of the earlier test. With TLS on, This computer offers no Connect: the card says these settings may require a secure address and offers Advanced, where the person connects with the gateway's address. Pinning OpenClaw's certificate (b) is a design option, not built.

A listener check describes a listening socket at one moment. The credential goes to an accepted connection, and the two can differ. So every check below is about the connection that will carry the credential.

What 2026.10.6 offers, checked against the source and, where it could work, live:

| Candidate                                                                                                      | In 2026.10.6                                             | Evidence                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) The gateway signs a client nonce with its identity key                                                     | No                                                       | The identity is in OpenClaw's SQLite state (`<openclaw>/dist/device-identity-async-Dmb-qdPn.mjs` lines 20-45). Nothing signs before auth: `connect.challenge` is a bare server nonce (`<openclaw>/dist/ws-connection-Cq7PPwbb.mjs` lines 314-323), and `hello-ok` carries no signature.                                      |
| (b) A TLS certificate pinned from an owner-only file                                                           | Yes, when TLS is already on; off by default              | **Live** on a development instance with TLS on. Pinned `wss://127.0.0.1` paired silently with all six, plain `ws://` was reset, and an impostor dialled with the pin got 0 application bytes ("gateway tls fingerprint mismatch"; `applyGatewayWebSocketTlsPin`, `@openclaw/gateway-client` `dist/index.mjs` lines 565-600). |
| (c) A Unix-domain socket with peer credentials                                                                 | No                                                       | The operator API is TCP only. OpenClaw's `.sock` files are internal channels.                                                                                                                                                                                                                                                |
| (d) The gateway proves it knows the token first                                                                | No                                                       | The first frame must be `connect` with the credential (`<openclaw>/dist/message-handler-CRCo2VX0.mjs` lines 3520-3521).                                                                                                                                                                                                      |
| (e) The account that holds the accepted end of this exact connection                                           | Yes, as an account check only                            | **Live**, below. The confirming review showed that a same-account proxy passes it even when a sandbox denies that proxy the settings file.                                                                                                                                                                                   |
| (f) The profile's files: what the kernel says that holder holds open, and the process the profile's lock names | Yes, as a check that the connection matches this profile | **Live**, below. It refused a same-account forwarding proxy that (e) alone would have passed.                                                                                                                                                                                                                                |

**With TLS on: a design option, not built.** As built, a profile whose settings turn TLS on (`gateway.tls.enabled: true`, the one switch in both versions) gets no Connect: the look says these settings may require a secure address, and offers Advanced. The pin (b) is how This computer could connect to it:

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
   - At least one holder must be found, every holder the helper can see must be a process of this account, and one of them must pass (f).
   - The macOS kernel returns `EPERM` for another account's or root's descriptors to an ordinary caller (XNU `proc_security_policy`, cited by the review), so their holders are invisible: a connection held only by such a process finds no holder, and is refused. One held beside a visible holder of this account's isn't seen (below, "That no other holder exists").
2. **(f) A match with this account's OpenClaw profile.** For that holder's PID, the kernel's own facts must all match. None of them come from the process's own arguments, which OpenClaw overwrites anyway: the live gateway's argument list read `openclaw-gateway`. As built, there is no check of the executable (a gateway run by Bun, as the OpenClaw Mac app's, would fail one), and the module is a consistency check only:
   - **OpenClaw's native module, where the app has a pin.** If the holder maps a file laid out as `node_modules/@openclaw/fs-safe-<platform>-<arch>/fs-safe-native.node` inside a package whose `package.json` names a version with pins (2026.10.6, 2026.11.10), the module's SHA-256 must equal that version's pin, from the published `@openclaw/fs-safe-*` packages it depends on exactly. The module is ad-hoc signed with no team, so its code signature says nothing. This check authenticates nothing: the package's `package.json` and the module's path are files the holder's own account can write, so a holder with no module, an unreadable one, or one whose package names another version skips it.
   - **The profile's files.** It holds open descriptors on the profile's `tmp/openclaw-<uid>/gateway.state.lock` and `state/openclaw.sqlite`. Each is matched by device and inode against Clawtrate's own no-follow open of the same file.
   - **The lock names it.** The lock is OpenClaw's compatibility projection of its gateway owner (`<openclaw>/docs/gateway/gateway-lock.md`), owner-only, read with the reader's rules. It must name this PID, role `gateway`, this port and this profile's state folder, with a `startTime` equal to the kernel's start time for the PID, to within a second.
   - **The lock names the settings file that was read.** Both versions write the settings file the gateway loaded into its lock (`configPath`), and OpenClaw's `OPENCLAW_CONFIG_PATH` can choose a file other than the profile's own. It must be the profile's own `openclaw.json`, the file the reader read the port, token and TLS from; a gateway started on another file is refused, with no Connect.
3. **Bounds.**
   - Both checks run in a small helper off the main thread, with a 2 s deadline and bounded output. On macOS the helper uses libproc (`proc_pidfdinfo`, `proc_pidpath`, region and vnode info), as `lsof` does. On Linux it reads `/proc/net/tcp`, `/proc/<pid>/exe`, `/proc/<pid>/maps` and `/proc/<pid>/fd`.
   - A missing helper, a timeout, denied access or malformed output all mean unverified, and nothing is sent.
   - Every socket is checked, retries and reconnects included, whether it would carry the shared token or this device's own token.
4. **When a check fails,** no credential is sent. The card stays at "OpenClaw settings found" and says which check failed (`PROOF_REFUSAL_LINES`). It offers Look again and the address route, without filling in its token.

**Live, on a development gateway of this checkout's (`exec` in the probe), when this design was written** (before the executable check was dropped and the pin made conditional).

- **Two direct connections to the gateway passed every check**, in 326 and 534 ms with `lsof`, with nothing sent. The facts:
  - the executable was a Node binary;
  - OpenClaw's native module was mapped from the 2026.10.6 package;
  - the gateway lock and the state database were held, matched by inode;
  - the lock named the PID, role `gateway`, the port, the state folder and the kernel's start time.
- **A same-account TCP proxy that forwarded every byte to the gateway was refused** in 637 ms, with nothing sent. (e) alone would have passed it. The proxy had full access to the profile's files, and was refused anyway: it mapped no OpenClaw module, held neither file, and isn't the process the lock names.

**What (e) and (f) establish.** At the moment of the check, the server end of Clawtrate's connection is held by processes of this account the helper can see, and one of them:

- has this profile's gateway lock and state database open;
- is the process this profile's lock names as its running gateway, with the same start time, started on this profile's own `openclaw.json`.

That is, the connection matches this account's OpenClaw profile. A process that can't open the profile's 0700 folder (a sandboxed proxy, the case the review built) can't hold those descriptors, and is refused. The stated limits, what this defends against and what it doesn't, are in `docs/decisions.md`, "Local connect's proof".

**What they don't establish:**

- **Which program is running.** A process of this same account that can write the profile's files can satisfy (e) and (f); such a process can already read the shared token and the gateway's pairing state, and replace the gateway. OpenClaw offers no way today for a gateway to prove itself from a source such a process can't write.

- **That the JavaScript running is unmodified OpenClaw.** Node loads scripts and closes them. A process of this account with write access to the package, or the power to inject into the gateway, could change what runs. Such a process could read the token anyway.
- **What the running gateway loaded.** "TLS is off" means the settings file the reader read says so. A file changed in place since the gateway started (TLS turned off, a port or a token changed) is still the file the lock names, while the gateway serves what it read at its start. A Connect that gateway never answers on `ws://` ends with Use Advanced and Look again, never behind Connecting.
- **The folder at every moment.** The folder's identity is compared at checkpoints (the look's read and check, Connect's read of the token, both checks of every socket, each reconnect's dial), not watched continuously between them.
- **That no other holder exists.** An unprivileged scan can't see a duplicate of the accepted socket held by another account. One could exist only if a holder of this account passed it on (`SCM_RIGHTS`, inheritance).
- **The moment between the last check and the write.** Two checks narrow that window but don't close it.
- **That the gateway is the one its address implies,** in any cryptographic sense. Only (b), which isn't built, would do that.

§13 states what remains, and the product owner's acceptance of it.

**Over SSH,** the same rule applies on the far side. The SSH host key authenticates the SSH server. The forward's far end is still an unproved loopback connection, and a scan of connections attributed to `sshd` can't bind its result to Clawtrate's channel. So:

- With TLS on there, Clawtrate reads the certificate over the authenticated SSH channel and checks it inside TLS through the forward (`tlsServerName` 127.0.0.1). The certificate is read there under the same rules as on this Mac (above), so SSH doesn't stand in for a certificate those rules refuse.
- Without TLS, the SSH route sends no credential by itself. The person uses the address route, or turns TLS on themselves.

### The settings reader

A bounded, read-only reader. It never repairs a file or a permission, and runs no OpenClaw code.

- **Where.**
  - Only `~/.openclaw/openclaw.json` (the default profile) and `~/.openclaw-clawtrate/openclaw.json`, under the home folder the operating system reports for this account.
  - `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` affect only processes started with them (`<openclaw>/dist/paths-BP0DYpE8.mjs` lines 117-140, 214-223).
  - If both profiles qualify, the look offers the first whose port matches its profile, the default profile first, and doesn't name the other: a choice between them isn't built.
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
  - The settings must say TLS is off: no `gateway.tls`, or one whose `enabled` is absent or `false`. OpenClaw 2026.10.6 and 2026.11.10 serve TLS exactly when the loaded settings' `gateway.tls.enabled` is `true` (`loadGatewayTlsServerRuntime`), with no variable or gateway flag that turns it on; local connect dials `ws://` only, so any other value or shape is taken as TLS (it isn't evidence that the gateway uses TLS, only that Clawtrate can't tell it doesn't), and the card says these settings may require a secure address and offers Advanced, with no Connect.
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

1. **Settings found, not yet checked:** a card "OpenClaw settings found", with "Port 18789 · default profile" under it. The look then opens one socket, runs the send gate on it, sends nothing, and closes it. The result is a discovery hint for the card; Connect checks again on its own sockets.
2. **Matched:** the card says "Found your OpenClaw settings on this Mac", and under it "What is listening at the port they name matches them.", with **Connect** and the consent line of §2 above it. Below it, quieter, is "Another computer".
3. **Connect** shows steps in place of the button: "Reading OpenClaw's settings", "Checking it matches OpenClaw's settings", "Pairing this Mac", "Loading your bots". This takes one to three seconds. Each socket is checked again (above).

Clicking Connect is the consent. There is no second dialog. On this Mac the count is **1 click, 0 commands, 0 approvals**, with OpenClaw's defaults (TLS off, through (e) and (f)). With TLS on, This computer shows Advanced instead (above). It changes nothing in OpenClaw.

### In development

A sandboxed run reads the development instance's own `openclaw.json`, proven as `sandbox.ts` proves the instance today. The development config contract has TLS off, so the setup checks exercise (e) and (f). On a development gateway, the pinned hash of OpenClaw's native module is the hash of the installed 2026.10.6 package's own file. F-492's boundary tests add four cases, each asserting zero upgrade and zero credential bytes:

- a same-account forwarding proxy;
- a same-account proxy that a sandbox denies the settings folder;
- a listener that holds the port while the instance is stopped;
- on a hosted macOS runner, a listener from a second account.

An earlier design experiment checked a TLS path with a probe-style test that turned TLS on in its own instance only; that path isn't built. What is tested now: the extractor takes every TLS form in the settings as TLS, before any port or credential is used (`settings-extract.test.ts`), and the look gives such a profile no Connect and asks for no check of its port (`local-setup.test.ts`); the card offers Advanced. A development gateway has local auto-approval off by its contract. So the setup checks start their instance with `--default-local-pairing` for the zero-approval path, and without it for the one-approval path.

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
- This device's code, large, in mono: 16 base32 characters of the SHA-256 of its public key, in four groups ("K7QF-2MXA-9TRB-W4HD"). Under it: "The approver types this code."
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
  - Approving twice answers "unknown requestId". After a rejection, the device's next connect files a new request. §4 ("How the waiting device learns the request ended") says how Clawtrate notices that and stops.
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
- **The code.** "Enter the code shown on the device you want to approve."
  - The code is Crockford Base32 over the first 10 bytes of SHA-256 of the canonical raw Ed25519 public key: 16 characters, about 80 bits, in four groups of four.
  - It is compared against the code the person reads off the intended device's own screen.
  - One input. It is formatted and compared in place on every `input` event: groups are inserted, case is ignored, and `I`, `L` and `O` are read as `1`, `1` and `0`, as Crockford defines.
  - The match or mismatch shows while the person types. Enter finishes editing and moves focus to Approve when the code matches; it never sends a decision.
  - One explicit **Approve**, enabled only on a match. "Deny" sits beside it.
  - Enter in the input never sends a decision.
  - Focus starts outside the decisions. Escape dismisses ("Not now").
  - At phone width, the request details scroll inside the sheet, and the input and both buttons stay pinned above the keyboard. Match, mismatch, Tab, Enter and Escape are checked at 390 px with the keyboard up.
  - There are no multiple choices and no second guess on the same review. A wrong code says "That code doesn't match this request." and keeps Approve disabled.
- **The click.** The comparison happens inside the gateway's own approval mutation, not in a list-then-approve wrapper. A wrapper inherits the race.
  - **The plugin.** A small Clawtrate plugin, `clawtrate-pairing`, registers one admin method: `clawtrate-pairing.approve {requestId, expected}`.
  - **What `expected` carries.** Everything the prompt showed: public key and device id, roles, scopes, the reported fields as displayed, `remoteIp`, and for a repair the paired record's roles and token scopes as shown.
  - **How it approves.** The method calls `approveDevicePairing(requestId, { callerScopes, isApprovalCurrent })` from the pinned plugin SDK (`openclaw/plugin-sdk/device-bootstrap`; type `DevicePairingApprovalOptions`, `<openclaw>/dist/config-contracts-C65kIjn4.d.ts` lines 16344-16358). `callerScopes` are the caller's own scopes.
  - **Where the comparison runs.** `isApprovalCurrent({pending, existing})` runs inside the pairing worker's admitted transaction, after the pairing lock (`approvalAdmission`, `<openclaw>/dist/device-pairing-approval-uwflSfHu.mjs` lines 17-38; `requestDevicePairingMutationAdmission`, `device-pairing-core.worker-B-kYFMQS.mjs` lines 82-89). It compares the authoritative pending row and paired record with `expected`, field by field. Any difference refuses the approval ("approval-policy-changed"), and nothing is approved.
  - **The first decision wins.** It applies the stock rules too: expiry, and the cross-device and caller-scope rules, because the plugin method is admin-only, like every plugin method.
  - **On a refusal,** the prompt re-reads the list, clears the code and asks for a fresh review.
  - **Only a confirmed answer counts.** Success is reported only on a confirmed RPC answer: "Approved. The device connects in a moment."
  - **Without the plugin.** When `clawtrate-pairing.approve` isn't in `hello-ok.features.methods`, Clawtrate doesn't approve from the app. The prompt becomes a passive notice with the gateway-owner route: the Control UI's Devices, or the command. Stock `device.pair.approve` takes only a `requestId` and can't hold the displayed snapshot.
  - **The scenario check.** A pinned `pnpm scenarios` check covers:
    - a same-envelope refresh keeping the id;
    - an expansion or origin change superseding the id;
    - role removal under an existing id (`removePairedDeviceRoleInWorker`, the same file lines 402-439);
    - a repair whose existing token changed (`device.token.rotate`);
    - a stale decision leaving the request unapproved.
  - **Installing the plugin.** It needs `plugins.install` (`operator.admin`). Clawtrate offers it once, with its own consent: "Install Clawtrate's device approval helper on this gateway". It never installs it silently. How Clawtrate ships its plugins to a person's gateway is shared with the memory and rules plugins, and is PR 3a's dependency.
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
| 2    | "Found your OpenClaw settings on this Mac", the consent line, Connect.                                                                                                             | Reads, clicks Connect | 3-5 s                    |
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
| TLS on (built; the pin of §3 is a design option)                               | "These settings may require a secure address. Use Advanced to connect with the gateway's address."                      | Advanced, with its address (§4)                                                                                   |
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

   Replacement: "**Scopes, once, at the first pairing.** A first pairing asks for `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, `operator.admin` and `operator.pairing`, after the consent line, because the product owner decided that repeated approvals defeat the purpose. The gateway's confirmed grant is the limit, and a reconnect asks for exactly that. A narrower grant is kept and reported, and nothing asks again by itself. The narrower `operator.sessions.*` scopes are never requested."

2. **Requested is not granted**:

   > "Only `heldScopes`, normalized to read plus whichever interactive scopes were granted, is ever requested"

   Replacement: "Only `heldScopes`, the confirmed grant within what the attempt asked for, is ever requested. An existing device gets one explicit upgrade offer (`setup-effortless.md` §6)."

3. **Pairing**:

   > "On `PAIRING_REQUIRED` it shows the request id and an approve command chosen by the host"

   Replacement: "…it shows this device's 16-character code, the scopes asked for, and three ways to approve: Clawtrate on another admin device, OpenClaw's Control UI, and last the approve command chosen by the host."

4. **What the look runs, and when it runs nothing**:

   > "So the look never runs an installed OpenClaw whose version isn't on a list of versions verified to have a read-only path (`READ_ONLY_VERSIONS` …), and that list is empty."

   Replacement: "The look runs no OpenClaw program on any version, and reads no version. It reads the port and token from the canonical `openclaw.json` of the default and `clawtrate` profiles with the bounded reader of `setup-effortless.md` §3. It sends nothing to a socket until it passes `setup-effortless.md` §3's send gate: the account that holds the accepted end, and that end's match to this account's OpenClaw profile (the profile's lock and state database held open by the process the lock names, and the settings file the lock names being the one read). With TLS on in the settings, This computer offers no Connect, and the person uses Advanced with the gateway's address. `READ_ONLY_VERSIONS`, `gateway status`, `config get` and `qr` leave the look."

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

   Replacement: "Clawtrate reads the shared token from OpenClaw's settings file, which belongs to the same account, and sends it only to a socket held by this account whose other end matches this account's OpenClaw profile (§3's send gate)."

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
- **A new row** for the approve prompt: bound to the key and grant by `clawtrate-pairing.approve` inside the gateway's approval mutation, with a typed Crockford code.

## 12. What still needs an approval or a command, and why

| Case                                                                | What 2026.10.6 forces      | Why                                                                                                                                                                                  | Smallest path around it                                                                |
| ------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| The first device of a gateway by address                            | One approval               | Off loopback, a client that isn't one of OpenClaw's own apps is never paired by its credential alone (`resolvePairingApprovalPlan`, `message-handler-CRCo2VX0.mjs` lines 1916-1969). | SSH (0 when TLS is on there); the Control UI's Devices (no command); the command, last |
| This Mac with `autoApproveLocal: false`                             | One approval               | The owner turned silent local pairing off (`node-connect-reconcile-CAkPC2vI.mjs` line 182).                                                                                          | The Control UI or the command; Clawtrate doesn't run it                                |
| A token kept as a SecretRef                                         | Typing the token once      | The value is in OpenClaw's database, a service's environment or a command                                                                                                            | The address form                                                                       |
| A socket whose other end can't be proved                            | No connection              | §3                                                                                                                                                                                   | §13                                                                                    |
| This Mac with TLS on                                                | Advanced, with its address | The pin of §3 is a design option, not built: This computer connects only with TLS off (§3)                                                                                           | A `wss://` address that isn't loopback, with a certificate the system trusts (§4)      |
| Approving another device without `clawtrate-pairing` on the gateway | The owner's route          | The stock RPC can't bind the displayed request (§5)                                                                                                                                  | Install the helper once from the app, with consent                                     |
| A changed platform or family                                        | One approval off loopback  | The gateway pins both                                                                                                                                                                | Never change them                                                                      |
| A token its owner narrowed                                          | Keep the narrower grant    | The owner's limit wins                                                                                                                                                               | None, by design                                                                        |

## 13. Residual risk on this Mac, accepted

**The decision, as first relayed (superseded in part).** The product owner chose the local send gate of §3: one-click Connect, with no TLS switch and no OpenClaw restart. As first relayed, that gate was the account check plus a check of the listening program's executable; the executable check is superseded, and the check as built is the account check (e) and the profile check (f) of §3 (see "The product owner decided how local connect works" there). The confirming review found that the account check alone isn't a proof of identity. The relay records that the product owner accepts that narrow residual risk.

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

**How this compares with OpenClaw's own clients.** OpenClaw's CLI and its Control UI send the same token to the same `127.0.0.1` port the same way, with no check of the peer at all. With TLS off, Clawtrate's gate is stricter than OpenClaw's own. With TLS on, the pin of §3 would authenticate the endpoint cryptographically; it is a design option, and This computer offers Advanced there instead.

**What would remove the residue.** A gateway-signed challenge, a Unix socket with peer credentials, or TLS by default. 2026.10.6 offers only TLS, and the product owner decided not to switch it on for the person.

## 14. Not covered

- A gateway-side revoke and a narrower replacement for "Use read-only mode on this device".
- Password and `none` auth routes; Tailscale identity sign-in (`gateway.auth.allowTailscale`).
- Node (machine) approvals, which stay in `device-node.md`.
- Windows, except as another computer reached by a protected route.
- The web preview host, which stays on the address-and-token form.
