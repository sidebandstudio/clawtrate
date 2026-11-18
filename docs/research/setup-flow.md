# Setting Clawtrate up: what the gateway and the tools allow

What a first run of Clawtrate can do to find, reach, pair with and install an OpenClaw gateway, checked against OpenClaw 2026.10.6 and the system `ssh`. It settles the "to be confirmed" cells of `docs/parity.md` rows F-491 to F-513 and is the evidence behind `docs/design/setup.md`.

How to read the citations, as in `gateway-capabilities.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, the one the `openclaw` wrapper script runs. Bundled chunk names carry a build hash (`message-handler-CRCo2VX0.mjs`) that changes with every release; search by the `//#region <source path>` marker at the top of each chunk instead. Line numbers are of the 2026.10.6 chunks.
- `schema` is `protocol.schema.json` in `@openclaw/gateway-protocol@2026.10.6`.
- **Live** means it was run, and the result is quoted. **Source** means it was read in shipped code or bundled docs only. **Unverified** marks what was only read and could not be run here, with the reason.

Where things were run:

- **Development instances** of the gateway, named and started by this checkout with `pnpm dev-gateway start --instance <name> --default-local-pairing`. That option (added for this note, `tools/dev-gateway`) leaves `gateway.nodes.pairing.autoApproveLocal` unset, at the gateway's default; every other instance sets it to `false`. The probes are in `setup-flow/pair-probe.ts` and use this project's own client (`packages/core`) where the desktop app would.
- **An `sshd` of my own**, run as my own user on a loopback port, with a host key, a user key, a configuration and a home created for it in a temporary folder, reached with `ssh -F <that configuration>`, `IdentitiesOnly`, that key and that known-hosts file. Nothing of the machine's own SSH setup was read or used.
- **GitHub's hosted runners** (macOS, Ubuntu and Windows), for everything that installs or registers a service, which must never run on a machine with a working gateway. The workflow is `.github/workflows/setup-research.yml` on the branch `su-research`, which is not merged; runs 44415483883 and 44416142360.

## Summary

| # | Question | Answer | Section |
|---|---|---|---|
| 1 | Is this client's first pairing approved silently on loopback, and through an SSH forward to a loopback-only gateway, with `autoApproveLocal` at its default? | Yes, both. **Live.** But the shared token it needs cannot be read by a program: OpenClaw refuses to print it outside an interactive terminal. A setup code made on the gateway's computer with `openclaw qr --url ws://127.0.0.1:<port>` replaces it, and is also approved silently there. **Live.** | 1 |
| 2 | Is a scope upgrade on such a connection approved silently? | No. `device.scopes.requestUpgrade` always files a request that waits, whatever the locality. **Live.** `openclaw devices approve <requestId>` on the gateway's computer approves it. **Live.** The pairing page's "silently approve … scope upgrades" is about a reconnect that presents the shared token, a different path. | 2 |
| 3 | Setup codes with this client | A code is base64url JSON `{url, bootstrapToken, expiresAtMs}`, never the shared token, valid for 10 minutes, single use. On loopback this client redeems it for `operator.read` alone and is approved silently. **Live.** Away from the gateway's computer, only OpenClaw's own mobile apps connecting as a node are approved by the code; this client's connect waits for `devices approve`. **Source.** | 3 |
| 4 | A setup code without a shell? | `device.pair.setupCode` exists, needs `operator.admin`, and is not advertised in `hello-ok`. A read-only connection is refused. **Live.** So a code needs either a shell on the gateway's computer or an admin connection. | 4 |
| 5 | What identifies a gateway apart from its address? | `gateway.identity.get` (`operator.read`): the gateway's own `{deviceId, publicKey}`, stable across addresses and restarts. It identifies a gateway only after a connection has authenticated; nothing proves the key to a client before a credential is sent. | 5 |
| 6 | The installer | `install-cli.sh --runtime-only --npm --version <exact> --prefix <dir> --json` installs a pinned OpenClaw and its own Node into one folder, with NDJSON steps, in 20 to 33 s. `openclaw onboard --non-interactive --accept-risk --auth-choice skip --gateway-bind loopback --gateway-auth token --install-daemon --json` makes a loopback, token, no-model gateway with a launchd or systemd user service in 18 to 28 s. `openclaw uninstall --service --state --workspace --yes --non-interactive` removes it. **Live** on macOS and Ubuntu. On Windows `install.ps1 -Tag <exact>` installs globally (304 s), replacing the computer's Node when it is too old, before it checks the version exists; onboarding makes a Scheduled Task (63 s). **Live.** | 6 |
| 7 | SSH from a shipped app | `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ExitOnForwardFailure=yes`, `ServerAliveInterval`, `ConnectTimeout`. All three failures exit 255 and are told apart by stderr. The host key's fingerprint is on the `-v` line `Server host key:`. A dropped or silent forward exits 255 and the host restarts it. Windows' bundled OpenSSH 9.5 behaves alike, without ControlMaster and without Unix-socket forwards. **Live.** | 7 |
| 8 | Tailscale | `gateway.tailscale.mode: "serve"` keeps the gateway on loopback and has the gateway itself hold a Serve route to a dedicated listener. It needs the `tailscale` program, signed in, with HTTPS certificates on for the tailnet. A connection through it is not local: a new device waits for approval. **Source.** | 8 |

## 1. The first pairing on loopback and through an SSH forward

### What the gateway does

A connection counts as local when its socket comes from a loopback address and it carries no forwarded headers (`resolveGatewayIngressAttribution`, `<openclaw>/dist/ingress-attribution-BQX5Ye8B.mjs` lines 95-118: `direct-local`). `resolvePairingLocality` then calls it `direct_local` (`<openclaw>/dist/node-connect-reconcile-CAkPC2vI.mjs` line 192). `resolveLocalPairingApproval` (`<openclaw>/dist/message-handler-CRCo2VX0.mjs` line 1889) approves a first pairing silently when `shouldAllowSilentLocalPairing` agrees (`node-connect-reconcile-CAkPC2vI.mjs` lines 178-185): not remote, no browser `Origin` header unless the client is OpenClaw's own Control UI, and `autoApproveLocal` not `false`. Unset counts as allowed.

The bundled docs say the same and name the SSH case: "This includes a client reaching a remote loopback-only Gateway through an SSH port forward: the SSH server terminates the connection on the Gateway host, so the Gateway sees the forwarded connection as loopback." (`<openclaw>/docs/gateway/pairing.md` lines 229-246).

Two conditions matter for Clawtrate:

- **No `Origin` header.** The desktop app opens its socket in Electron's main process with Node's built-in `WebSocket` (`packages/core/src/node/index.ts`), which sends none. A socket opened in a renderer or a browser tab would carry one and would not be approved silently.
- **A local `Host` header.** A loopback socket whose `Host` header is not local is treated as remote (`message-handler-CRCo2VX0.mjs` line 3427). An SSH forward is reached as `ws://127.0.0.1:<local port>`, so the header is local.

### Live

On instance `su-pair` (started with `--default-local-pairing --no-seed`), `pair-probe.ts pair`, this project's `ClawtrateClient` with the shared token from the tool's run file:

```
connect ws://127.0.0.1:19900 with the shared token
core client: {"status":"connected","scopes":["operator.read"],"requestedScopes":["operator.read"],"paired":true,"pairing":null,"error":null,"gatewayId":"c5fde286cae1"}
gateway devices: {"pending":[],"paired":[{"clientId":"gateway-client","clientMode":"ui","displayName":"Clawtrate Desktop","roles":["operator"],"scopes":["operator.read"],"approvedVia":"silent"}]}
```

`grep -c autoApproveLocal` on the instance's config printed `0`: the setting was at the gateway's default.

**Through an SSH forward.** `ssh … -N -L 127.0.0.1:59237:127.0.0.1:19900 devbox` through the `sshd` of my own (section 7), then the same probe with a new device at `ws://127.0.0.1:59237`:

```
core client: {"status":"connected","url":"ws://127.0.0.1:59237","scopes":["operator.read"],"paired":true,"pairing":null,"error":null,"gatewayId":"c5fde286cae1"}
gateway devices: {… {"displayName":"Clawtrate Desktop","scopes":["operator.read"],"approvedVia":"silent"} …}
```

Both were approved silently, with `operator.read` and nothing more, and both read the same gateway identity (section 5). On an instance with `autoApproveLocal: false`, which every other development instance has, the same connect waits with `PAIRING_REQUIRED` (`docs/research/gateway-capabilities.md`, section 2; F-002).

### The shared token cannot be read by a program

The first connect needs a credential. The pairing row assumed the host reads the shared token itself. OpenClaw prevents that on purpose:

- `openclaw gateway auth-token --show` refuses "outside an interactive terminal", which it judges as stdin and stdout both being terminals (`<openclaw>/dist/gateway-auth-token-ByElYj5T.mjs` line 13; `terminal-interactivity-D92bdO16.mjs` line 2). **Source.**
- `openclaw config get gateway.auth.token` prints `__OPENCLAW_REDACTED__` (`<openclaw>/docs/install/daytona.md` line 100). **Source.**
- The token can also be a SecretRef that only the gateway resolves.

Allocating a pseudo-terminal to get past the first, or parsing OpenClaw's config file to get past the second, would defeat a guard OpenClaw put there. The design does neither.

**What replaces it: a setup code made on the gateway's computer.** `openclaw qr --json --url ws://127.0.0.1:<port> --limited` is non-interactive by design, prints a short-lived single-use bootstrap token inside a setup code, and never prints the shared token (section 3). On loopback, a connect with that bootstrap token is approved silently like one with the shared token: `shouldAllowSilentLocalPairing` does not look at the auth method for a first pairing. **Live**, section 3. So the host makes a code over its own shell (this computer, or SSH), redeems it at once over loopback or the forward, and the shared token never leaves OpenClaw.

Plain `openclaw qr` refuses a loopback-only gateway ("Gateway is only bound to loopback. Set gateway.publicOrigin …", `<openclaw>/dist/setup-code-Cj6iw2_8.mjs` line 20); the explicit `--url ws://127.0.0.1:<port>` is accepted, because a loopback URL is allowed for setup (`validateMobilePairingUrl`, same file). **Live** on both runners, section 6.4.

## 2. A scope upgrade on a local connection

`docs/research/gateway-capabilities.md` (section 2, "Scope upgrade") says `device.scopes.requestUpgrade` "creates a pending pairing request even on loopback". `<openclaw>/docs/gateway/pairing.md` lines 238-240 say "trusted local connections silently approve first-time device pairing plus role and scope upgrades". Both are right; they describe two paths:

- **`device.scopes.requestUpgrade` on a live socket**, which this client uses (`docs/decisions.md`, "Scopes, in tiers"). Its handler always calls `requestDevicePairing` with `silent: false` and never asks about locality (`<openclaw>/dist/devices-mOg4_HQd.mjs` lines 37-110). It waits.
- **A reconnect that asks for more scopes.** `authorizeExistingGatewayDevice` files a `scope-upgrade` pairing (`message-handler-CRCo2VX0.mjs` lines 1546-1555, the `requirePairing("scope-upgrade")` call at line 1553), and `shouldAllowSilentLocalPairing` approves it locally only when the connect authenticated with the shared token or password (`node-connect-reconcile-CAkPC2vI.mjs` line 183: `authMethod === "none" || "token" || "password"`). A device token or a bootstrap token does not qualify. Clawtrate never holds the shared token (section 1), so this path is closed to it, and it is not the documented way to ask.

### Live

`pair-probe.ts upgrade --approve` on the device paired in section 1:

```
before:       {"status":"connected","scopes":["operator.read"],"upgrade":{"status":"idle"}}
after asking: {"status":"connected","scopes":["operator.read"],"upgrade":{"status":"pending","requestId":"e5eb4aa8-175f-40f1-bc7a-8f15cfc40942","scopes":["operator.read","operator.write","operator.approvals","operator.questions"]}}
gateway devices: {"pending":[{"requestId":"e5eb4aa8-…","clientId":"gateway-client","clientMode":"ui","displayName":"Clawtrate Desktop","roles":["operator"],"scopes":["operator.approvals","operator.questions","operator.read","operator.write"]}], …}
devices approve e5eb4aa8-175f-40f1-bc7a-8f15cfc40942: exit 0
Approved 5ae23affda58… (e5eb4aa8-175f-40f1-bc7a-8f15cfc40942)
after approval: {"status":"connected","scopes":["operator.read","operator.write","operator.approvals","operator.questions"],"upgrade":{"status":"approved", …}}
```

On a loopback connection with `autoApproveLocal` at its default, the request waited. `openclaw devices approve <requestId>`, run through the development tool's runner (that is, on the gateway's computer), printed one line, `Approved <deviceId> (<requestId>)`, exited 0, and the client, still connected, held the interactive tier. The device's record then read `approvedVia: "owner"`.

So "Approve from here" (F-500) is the gateway's own `openclaw devices approve <requestId>`, run by the host on the gateway's computer (this computer, or over SSH) after the person confirms. The request id comes from `device.scopes.requestUpgrade`.

## 3. Setup codes

### What a code is

`openclaw qr` encodes `{url, bootstrapToken, expiresAtMs}` (and `tlsFingerprint` for a pinned `wss://` gateway) as base64url JSON (`encodePairingSetupCode`, `<openclaw>/dist/setup-code-Cj6iw2_8.mjs` lines 188-190; payload, lines 288-298). An `oc-pair://` prefix is accepted when reading one (same file, lines 191-197). The bootstrap token is minted by the CLI into the gateway's state (`issueDevicePairSetupBootstrapToken`, line 284). The `--json` result adds `gatewayUrl`, `auth` (the label `token`, `password` or `trusted-proxy`, never the value), `access` (`full`, `limited` or `node`), `accessDowngraded` and `urlSource` (`<openclaw>/docs/cli/qr.md` line 45).

Profiles (`<openclaw>/dist/device-bootstrap-profile-DQKf7Vz1.mjs`): the default asks for `operator.admin` plus the handoff scopes (`full`); `--limited` drops `operator.admin`; a plain `ws://` LAN address is downgraded to `limited` by itself. These are ceilings for OpenClaw's own mobile handoff. They are not what this client is granted: it is granted what it asks for, below.

### Live

`pair-probe.ts code`, on instance `su-pair`:

```
openclaw qr --json --url ws://127.0.0.1:19900: exit 0
result keys: setupCode, gatewayUrl, auth, urlSource, access   access: full   auth: token
payload keys: url, bootstrapToken, expiresAtMs   url: ws://127.0.0.1:19900   bootstrapToken length: 43
shared token in the code: false
lives for seconds: 593
first device redeems it for operator.read: {"outcome":"hello","role":"operator","scopes":["operator.read"],"deviceToken":true}
gateway devices: {… {"displayName":"Clawtrate research first","scopes":["operator.read"],"approvedVia":"silent"} …}
second device, same code: {"outcome":"refused","message":"unauthorized: setup code invalid, expired, revoked, or already used (create a new code; review `openclaw devices list`)","code":"INVALID_REQUEST","details":{"code":"AUTH_BOOTSTRAP_TOKEN_INVALID","authReason":"bootstrap_token_invalid","canRetryWithDeviceToken":false}}
```

With `--limited`, made and redeemed through the SSH forward (`--url ws://127.0.0.1:59237`): `access: limited`, lives 596 s, redeemed silently for `operator.read` alone, and refused the second time the same way.

So, with this client and a code:

- **The connect does not stay pending on loopback** or through an SSH forward: it is approved silently.
- **A device can redeem a code and hold `operator.read` only**: the gateway grants what `connect` asks for, below the code's ceiling (`full` or `limited`).
- **A code lives 10 minutes** (593 and 596 s left a moment after it was made) **and is single use**.
- **It contains** `url`, `bootstrapToken` (43 characters) and `expiresAtMs`, **never the shared token**.

On both runners (section 6.4) a code made with `--url ws://127.0.0.1:18789` had the keys `url`, `bootstrapToken` (43 characters) and `expiresAtMs`, `access: "full"` without `--limited`, and did not contain the shared token.

### Away from the gateway's computer (source)

Off loopback the code alone approves a device only in three cases (`resolvePairingApprovalPlan`, `message-handler-CRCo2VX0.mjs` lines 1916-1969; `isSetupCodeHandoffBootstrapClient`, line 834; `isMobileNodeBootstrapConnect`, line 858): OpenClaw's own iOS and Android apps connecting with role `node` and mode `node`; OpenClaw's node host with a node-only code; OpenClaw's own Control UI with its owner profile. A `gateway-client` connect with role `operator` from a phone matches none of them, so its pairing waits and its owner approves it with `openclaw devices approve <requestId>` (the docs say as much: "If a request remains pending (for example, for a non-official client …), review and approve it", `<openclaw>/docs/cli/qr.md` lines 25-32). **Unverified live:** a loopback-only development instance cannot be reached from a non-loopback address, and a proxy that adds `X-Forwarded-For` is refused outright (below), so a phone's connect could not be reproduced here.

Connecting as a mobile node to be approved by the code is not an option for Clawtrate: it is OpenClaw's own app identity, it gives the device a node role, and its operator handoff carries write scopes, against F-509.

The waiting is short in practice when the code was made from a desktop that has a shell on the gateway's computer: that desktop can list the pending request (`openclaw devices list --json`) and approve it (`openclaw devices approve <requestId>`) after the person confirms, the same "Approve from here" as section 2.

### A proxy route made by hand

`pair-probe.ts proxy`: the client connects through a loopback proxy that adds `X-Forwarded-For: 192.0.2.10`, as Tailscale Serve or another reverse proxy pointed at the ordinary listener does:

```
core client: {"status":"connecting","error":{"code":"UNREACHABLE","message":"Nothing answered at 127.0.0.1:61042."}}
gateway log: [gateway] observed unattributable proxy-shaped traffic from 127.0.0.1; Gateway-authenticated routes reject it, while plugin-authenticated routes ignore forwarded claims. Configure gateway.trustedProxies narrowly and make the proxy overwrite or safely rebuild forwarded client headers.
```

The same upgrade sent straight to the gateway with `curl` and `X-Forwarded-For: 192.0.2.10` is answered `HTTP/1.1 403 Forbidden` with `{"error":{"message":"Proxy client attribution is required. …","type":"proxy_attribution_required"}}`; without the header it is `101 Switching Protocols`. Node's `WebSocket` does not expose the status of a refused upgrade, which is why the core client reports "Nothing answered"; telling this case apart needs the host to read the HTTP answer (for builders, `docs/design/setup.md` §19).

This is `unattributableProxy` (`ingress-attribution-BQX5Ye8B.mjs` line 116): with forwarded headers and no `gateway.trustedProxies`, the gateway refuses to attribute the connection. That is F-512's evidence: a Serve route Clawtrate did not make does not work until its owner configures `trustedProxies`, and even then it is remote, never local.

## 4. A setup code without a shell

The gateway has a method: `device.pair.setupCode` (`schema` `methods`: scope `operator.admin`, since `<=2026.7`; `<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 1445-1450, with `advertise: false`, so it is not in `hello-ok.features.methods`). Its handler (`<openclaw>/dist/device-pair-setup-DIJSs_9O.mjs` lines 28-89) takes `{publicUrl?, preferRemoteUrl?, includeQr?, bootstrapProfile?: "limited" | "node" | "voice-node", joinUrl?}` and returns `{setupId, expiresAtMs, setupCode, joinUrl?, qrDataUrl?, gatewayUrl, gatewayUrls?, auth, urlSource, access, accessDowngraded?}` (`schema` `DevicePairSetupCodeResult`). `device.pair.setupStatus {setupId}` (also admin) reports whether the code was redeemed and by which device.

### Live

`pair-probe.ts method` on the read-only device of section 1:

```
scopes: ["operator.read"]
device.pair.setupCode refused: GatewayProtocolRequestError: missing scope: operator.admin
```

So "Connect a phone" (F-506) has two sources, in this order: the host's shell on the gateway's computer (`openclaw qr --json --limited`, any tier), or, with no shell, `device.pair.setupCode {bootstrapProfile: "limited"}` on a connection that already holds `operator.admin`. Clawtrate asks for admin only by explicit request (`docs/design/bots.md` §2), so the second is offered behind that request, never by itself.

## 5. What identifies a gateway apart from its address

- **`gateway.identity.get`** (`operator.read`; handler `<openclaw>/dist/system-C_-PvNDr.mjs` lines 350-356) returns `{deviceId, publicKey}` of the gateway process's own device identity, created once in its state folder (`loadOrCreateProcessDeviceIdentityAsync`). It is the same over every address and across restarts; the core already reads it (`ConnectionState.gatewayId`, `packages/core/src/types.ts`) and keys the rail's arrangement by it (`docs/decisions.md`, "The rail's arrangement is this device's").
- `hello-ok` carries no stable identity: `server.bootId` is new at every start, `buildId` names the build, `connId` the connection (`schema` `HelloOk.server`).
- **What it cannot do.** The identity is read after a connection has authenticated, and no method found here signs a client's challenge with the gateway's key (`connect.challenge` carries the gateway's nonce for the client to sign, not the reverse). So it tells Clawtrate that two authenticated routes reach the same gateway; it cannot tell Clawtrate, before a device token is sent to a new address, that the address is that gateway. A device token sent to an impostor is a credential lost.
- **OpenClaw's own position** is the same: "Unidentified, manually forwarded loopback URLs cannot safely reuse a device token saved only for that URL: the same port may now lead to another Gateway" and "SSH aliases … remain operator-owned route selections, not cryptographic Gateway identifiers" (`<openclaw>/docs/gateway/remote.md` lines 103-116). OpenClaw keys a client-managed tunnel's credentials by SSH target and remote port, not by the local forwarded port (same file, lines 91-102).

### What in `docs/decisions.md` changes and what must not

"Device tokens are scoped to one gateway URL" and "A credential never crosses gateways" (section "Connecting to the gateway"):

- **Must not change.** A device token is offered only where it was issued. No route is given a token because a gateway claims an identity. A credential never crosses from one gateway to another.
- **Has to change.** "One gateway URL" becomes "one route". A forwarded `ws://127.0.0.1:<port>` changes port every time the forward is made, so for an SSH route the key is the route's own identity: the host key's fingerprint, the SSH target as resolved, and the gateway's port on that computer. A changed host key is a different route. For a direct route the key stays its URL.
- **Can be added.** Routes are grouped into one gateway, for the person, by the `deviceId` that `gateway.identity.get` returns over each route once it has authenticated there. Each route pairs once by itself (silently for this computer and SSH, by a setup code otherwise), so the grouping never moves a credential.

## 6. Installing, onboarding and removing OpenClaw

**Never run on this machine.** Everything below that installs, onboards or uninstalls was run on GitHub's hosted runners only; the scripts were read in the installed package.

### 6.1 The three scripts

| Script | Where it comes from | What it does | Needs | Writes |
|---|---|---|---|---|
| `install.sh` | `https://openclaw.ai/install.sh` only; not in the npm package | Installs Node if needed (Homebrew on macOS, NodeSource on Linux), Git, then OpenClaw globally with npm or from a Git checkout; can run onboarding; on an existing install refreshes the service and runs `doctor --fix` (`<openclaw>/docs/install/installer.md` lines 117-156) | `curl`, `bash`, `sudo` for system packages | System Node, global npm prefix, `~/.openclaw` after onboarding |
| `install-cli.sh` | the npm package's `scripts/install-cli.sh` with `scripts/install-policy.sh` beside it, or the website's assembled copy | Downloads a pinned Node (`24.22.1`) into `<prefix>/tools`, verifies its SHA-256, installs OpenClaw under the prefix, writes `<prefix>/bin/openclaw`, checks `--version`; `--runtime-only` skips service work and onboarding (`installer.md` lines 284-349; `<openclaw>/scripts/install-cli.sh` lines 1298-1365) | `bash`, `curl` or `wget`, `tar`, a SHA-256 tool; no root | Only the prefix (default `~/.openclaw`) |
| `install.ps1` | `https://openclaw.ai/install.ps1`, also in the npm package | Installs Node with winget, Chocolatey or Scoop, else a portable Node; installs OpenClaw globally with npm; adds to the user PATH; refreshes a loaded service (`installer.md` lines 431-466) | PowerShell 5+ | System or portable Node, global npm prefix, user PATH |

**Pinning.** `--version <exact>` (`install.sh`, `install-cli.sh`) and `-Tag <exact>` (`install.ps1`) install that version instead of `latest` (`installer.md` lines 248, 397, 508). Clawtrate takes the installer from the pinned release itself: the npm registry's `openclaw-2026.10.6.tgz`, checked against its published integrity (`sha512-jSpQPa2J…qrxwA==`), holds `scripts/install-cli.sh` (SHA-256 `11e97095…dcffc`) and `scripts/install-policy.sh` (`704d7467…879cc6`). **Live**: run 44415483883, both runners. The website's `install-cli.sh` is a different file (1,991 lines, assembled with the policy inlined, SHA-256 `f5042f59…05d85b` on the day of the run) and can change at any time; running a script fetched live is what pinning avoids.

**NDJSON.** With `--json`, `install-cli.sh` writes one event per line: `{"event":"step","name":"node"|"openclaw"|"git"|"gateway-service"|…,"status":"start"|"ok"|"skip"|"warn",…}`, `{"event":"error","message":…}`, and `{"event":"done","ok":true,"version":…}` (`emit_json`, `<openclaw>/scripts/install-cli.sh` lines 230-254). A step list can be driven from it directly.

### 6.2 Installing, live

Run 44415483883, `install-cli.sh --json --runtime-only --npm --version 2026.10.6 --prefix "$RUNNER_TEMP/oc"`:

| | macOS (arm64, Node 24.22.3 on the runner) | Ubuntu |
|---|---|---|
| Exit | 0 | 0 |
| Time | 33 s | 20 s |
| Events | `node start`, `node ok 24.22.1`, `openclaw start 2026.10.6`, `openclaw ok`, `gateway-service skip runtime-only`, `done OpenClaw 2026.10.6 (fe06181)` | the same |
| Size | 808 MB | 825 MB |
| Wrote outside the prefix | nothing (`~/.openclaw` still absent) | nothing |

**A version that does not exist** (`--version 2026.99.99`): exit 1, events `node start`, `node ok`, `openclaw start`, then `{"event":"error","message":"npm install did not produce a usable OpenClaw package"}`, with npm's `ETARGET` on stderr, after one retry. The prefix keeps the downloaded Node in `tools/`. **Live**, both runners.

### 6.3 Onboarding without a model, live

`openclaw onboard --non-interactive --accept-risk --auth-choice skip --gateway-bind loopback --gateway-auth token --install-daemon --skip-skills --json`, run with the prefix's `openclaw`:

| | macOS | Ubuntu |
|---|---|---|
| Exit | 0 | 0 |
| Time | 28 s | 18 s |
| Service | `Installed LaunchAgent: ~/Library/LaunchAgents/ai.openclaw.gateway.plist` | `Installed systemd service: ~/.config/systemd/user/openclaw-gateway.service` |
| JSON | `{"ok":true,"mode":"local","workspace":…,"authChoice":"skip","gateway":{"port":18789,"bind":"loopback","authMode":"token","tailscaleMode":"off"},"installDaemon":true,"daemonInstall":{"requested":true,"installed":true},…}` | the same |

- `--auth-choice skip` is also the default when no provider flag is given (`<openclaw>/dist/onboard-non-interactive-Hx4CQstr.mjs` line 274); no model key is asked for or written.
- The success JSON names port, bind, auth mode and Tailscale mode, never the token (lines 455-470). A failure is `{"ok":false,"phase":…,"message":…,"classification":"auth-mismatch"|"module-missing"|"service-missing"|"service-stopped"|"startup-blocked"|"not-listening",…,"hints":[…]}`, with secrets redacted (lines 75-148). A service that cannot be installed, such as a Linux session without systemd user services, ends with exit 1 and `skippedReason: "systemd-user-unavailable"` (lines 335-361). **Source**; the runners had working service managers.
- `--install-daemon` on native Windows tries a Scheduled Task first and falls back to a Startup-folder login item (`<openclaw>/docs/cli/onboard.md` line 427). **Source** (section 6.6).

### 6.4 Looking at it, live

`openclaw gateway status --json` (exit 0) has the top-level keys `cli`, `logFile`, `service`, `config`, `gateway`, `hostDesktop`, `port`, `rpc`, `extraServices`, `pluginVersionDrift`. The parts the design reads:

- `service`: `{label: "LaunchAgent" | "systemd user", loaded: true, loadedText, runtime: {status: "running", pid, …}}`
- `gateway`: `{version: "2026.10.6", bindMode: "loopback", bindHost: "127.0.0.1", port: 18789, probeUrl: "ws://127.0.0.1:18789"}`
- `rpc`: `{ok: true, url: "ws://127.0.0.1:18789"}`

The command reuses a cached CLI device token and never creates a device identity or pairing record to check (`<openclaw>/docs/cli/gateway/query.md`, "Status semantics"). `openclaw devices list --json` on a fresh gateway: `{"pending":[],"paired":[]}`. `openclaw qr --json`: exit 1 with the loopback error (section 1); `openclaw qr --json --url ws://127.0.0.1:18789`: exit 0, as in section 3.

### 6.5 Removing it, live

`openclaw uninstall --service --state --workspace --yes --non-interactive`: exit 0 on both. Ubuntu printed "Stopped systemd service: openclaw-gateway.service", "Removed systemd service: …" and each removed folder; afterwards no `~/.openclaw`, no user unit, and on macOS no launchd job. The CLI itself is not removed by `uninstall` ("There is no separate CLI-removal scope", `<openclaw>/docs/cli/uninstall.md`); for an app-owned prefix, deleting the prefix removes it. `--state` refuses while an unmanaged gateway still runs on that state (same doc).

### 6.6 Windows

Run 44415483883, `install.ps1` from the website (SHA-256 `E2813A79…7D27C6`, 2,665 lines):

- `-DryRun -Tag 2026.10.6 -NoOnboard` printed "[OK] Windows detected", "[OK] Dry run", "[OK] Install method: npm", "[OK] Onboard: skipped".
- **`-Tag 2026.99.99` changed the machine before it failed.** The runner's Node 22.23.4 is unsupported, so the script first installed Node 26.13.1 machine-wide with winget ("Found Node.js (LTS) [OpenJS.NodeJS.LTS] Version 26.13.1 … Successfully installed"), and only then ran npm, which failed with `ETARGET`; exit 1. A missing version is found after the system's Node has been replaced.
- `install.ps1` has no prefix option: OpenClaw goes into the global npm prefix. There is no Windows counterpart of `install-cli.sh`'s app-owned prefix; `-NodeOnly -NodePrefix <dir>` installs a private Node only (`installer.md` lines 468-470).

Run 44416142360 went on past the failure (Node 26.13.1 was now installed):

| Step | What came back |
|---|---|
| `install.ps1 -Tag 2026.10.6 -NoOnboard` | exit 0 after 304 s: "[OK] Node.js v26.13.1 found", "[*] Installing OpenClaw (openclaw@2026.10.6)...", "OpenClaw installed successfully (OpenClaw 2026.10.6 (fe06181))!"; `openclaw.cmd` in the global npm prefix |
| `onboard … --install-daemon --json` (as in 6.3) | exit 0 after 63 s: "Installed Scheduled Task: OpenClaw Gateway", "Startup mode: Unattended (S4U; boot and logon; no stored password)", the same JSON as macOS and Ubuntu; `schtasks` showed the task "Running" |
| `gateway status --json` | `service: {label: "Scheduled Task", loaded: true, loadedText: "registered"}`, `gateway` and `rpc` as on the others |
| `uninstall --service --state --workspace --yes --non-interactive` | removed the task script and every folder inside `~\.openclaw`, then "State cleanup failed: EBUSY: resource busy or locked, rmdir '<home>\.openclaw'" and "Workspace cleanup blocked because state cleanup could not safely complete."; exit 1. The task was gone; the empty folder stayed |
| `npm uninstall -g openclaw` | exit 0, "removed 493 packages" |

So on Windows: the version pin works; the install changes the machine's Node and global npm prefix; onboarding makes a Scheduled Task; removal can end with exit 1 over an empty, locked folder, which the next install does not trip on (a fresh `~\.openclaw` is created inside it).

### 6.7 What each failure looks like, and undoing it

| Failure | How it shows | Undo |
|---|---|---|
| No network, or a download stalls | `install-cli.sh` allows five minutes per connection or stalled transfer (`UPDATE_NETWORK_TIMEOUT_SECONDS=300`); then an `error` event and exit 1 | Delete the prefix |
| Version missing | `error` "npm install did not produce a usable OpenClaw package" | Delete the prefix |
| Not enough disk | `disk-space` step `warn` or a failing npm step (`preflight_fresh_git_disk_space`, git method only) | Delete the prefix |
| Node cannot be provisioned | `node` step fails, or "Private Node.js recovery is unavailable on musl Linux" | Nothing written but the prefix |
| Onboarding cannot install the service | onboarding JSON `ok:false`, `daemonInstall.skippedReason` | `openclaw uninstall --state --workspace --yes --non-interactive` |
| The gateway does not come up | onboarding JSON `ok:false` with `classification` | `openclaw gateway status --json`, then uninstall |
| Cancelled midway | the process is stopped by its PID; npm may leave a partial package, which `install-cli.sh` detects on the next run (`.openclaw-lifecycle-pending`, retried once) | Delete the prefix, and `~/.openclaw` if onboarding had begun |

## 7. SSH from a shipped desktop app

### Options

| Option | Why |
|---|---|
| `BatchMode=yes` | Never prompts for a password, a passphrase or a host key; a key that needs a passphrase and is not in an agent is refused ("Permission denied (publickey)") instead of prompting. **Live.** |
| `StrictHostKeyChecking=yes` | Never accepts an unknown or changed host key by itself. **Live.** |
| `UserKnownHostsFile=<the user's file> <Clawtrate's own file>` | Keys the person already trusts are used; keys the person accepts in Clawtrate go to Clawtrate's own file, never into the person's. |
| `ExitOnForwardFailure=yes` | A forward that cannot listen ends the process with exit 255 instead of running without it. **Live.** |
| `ServerAliveInterval=15`, `ServerAliveCountMax=3` | A forward over a dead network ends within about 45 s instead of hanging. **Live** with 2 and 2: "Timeout, server 127.0.0.1 not responding.", exit 255. |
| `ConnectTimeout=10` | An address that does not answer fails in seconds. |
| `-N -L 127.0.0.1:<free port>:127.0.0.1:<gateway port>` | Port forward only, no remote command; bound to loopback. |
| `-o ControlMaster=no -o ControlPath=none`, `-o ForwardAgent=no`, `-o ClearAllForwardings=no`, `-T` | No shared master the person's own sessions could ride, no agent forwarding, no terminal. |

The person's own SSH configuration (aliases, `User`, `Port`, `ProxyJump`, `IdentityFile`, their agent) is used as it is: the field takes an alias or a host, and `ssh -G <host>` resolves it without connecting. **Live** (`ssh -G -F <config> devbox` printed the alias's `hostname`, `port` and `user`).

**A local port of 0 is refused** for `-L` ("Bad local forwarding specification '127.0.0.1:0:127.0.0.1:…'"). **Live.** The host picks a free loopback port, and `ExitOnForwardFailure` turns a lost race into exit 255 ("bind [127.0.0.1]:…: Address already in use … Could not request local forwarding."), after which it picks another. **Live.** A Unix-socket forward (`-L <path>:127.0.0.1:<port>`) works on macOS (**live**, with `StreamLocalBindMask=0177`) but not on Windows (below), so the design uses a loopback TCP port everywhere.

**A forward to a port where nothing listens** does not fail when it is made: each connection through it fails, and `ssh` prints "channel 1: open failed: connect failed: Connection refused" and keeps running. **Live.** So "is the gateway running there?" is answered by `openclaw gateway status --json` over SSH before forwarding, not by the forward.

### The three failures (all exit 255), live

| Failure | stderr (macOS and Linux) | Windows (OpenSSH_for_Windows_9.5p2) |
|---|---|---|
| Cannot be reached: refused | `ssh: connect to host 127.0.0.1 port 1: Connection refused` | `banner exchange: Connection to UNKNOWN port -1: Connection refused` |
| Cannot be reached: no such name | `ssh: Could not resolve hostname nonexistent.invalid: nodename nor servname provided, or not known` (Linux: `Name or service not known`) | `ssh: Could not resolve hostname nonexistent.invalid: No such host is known.` |
| Cannot be reached: no answer | `ssh: connect to host 192.0.2.1 port …: Operation timed out` | not run |
| Sign-in refused | `<user>@<host>: Permission denied (publickey).` | the same |
| Host key not known | `No ED25519 host key is known for [127.0.0.1]:<port> and you have requested strict checking.` then `Host key verification failed.` | the same |
| Host key changed | `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!` … `The fingerprint for the ED25519 key sent by the remote host is SHA256:…` … `Host key verification failed.` | not run |
| A running forward drops | `Connection to 127.0.0.1 closed by remote host.` | not run |
| A running forward goes silent | `Timeout, server 127.0.0.1 not responding.` | not run |

Telling them apart: exit 255 always; then "Host key verification failed" → host key; "Permission denied" → sign-in; "Could not resolve hostname", "Connection refused", "timed out", "No route to host", "Network is unreachable" → cannot be reached. Anything else is shown as it came, as "ssh stopped: <last line>".

**The fingerprint.** With `-v`, `ssh` prints `debug1: Server host key: ssh-ed25519 SHA256:<fingerprint>` before it refuses an unknown key. **Live** on all three systems. To trust it, the host fetches the key with `ssh-keyscan -t ed25519 -p <port> <host>`, checks that `ssh-keygen -lf` gives the same fingerprint the refused connection saw, and only then writes that line to Clawtrate's own known-hosts file. **Live** (keyscan's `SHA256:1V4KgC…` matched the `-v` line).

### Windows

**Live**, run 44416142360: `C:\Windows\System32\OpenSSH\ssh.exe` is present, `OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2`; the `ssh-agent` service is `Stopped`, start type `Disabled`. The same options work and the same messages come back, except: "Connection refused" reads `banner exchange: Connection to UNKNOWN port -1: Connection refused`; `ControlMaster=auto` fails ("getsockname failed: Not a socket", exit -1); a Unix-socket forward is refused ("Bad local forwarding specification 'D:/a/_temp/fwd.sock:127.0.0.1:18789'"). With the agent disabled, a key that has a passphrase cannot be used without a prompt; the person enables the agent service and adds the key once. Windows also ships `ssh-keyscan.exe` and `ssh-keygen.exe`.

## 8. Tailscale

From `<openclaw>/docs/gateway/tailscale.md` and the ingress source only. **No `tailscale` program was run.**

- `gateway.tailscale.mode`: `off` (default), `serve` (tailnet only) or `funnel` (public, needs password auth) (lines 15-23). With `serve` the gateway stays on `127.0.0.1` and holds the Serve route itself, as a foreground claim, to a dedicated `127.0.0.1:<ephemeral>` listener; stopping the gateway releases the route (lines 133, 148).
- Needs: the `tailscale` CLI installed and signed in (line 130); HTTPS certificates enabled for the tailnet (line 145); MagicDNS. A daemon reporting `Stopped` prevents gateway start (line 150); "Serve not enabled on the tailnet" leaves the loopback gateway running and warns (line 133). On Linux a non-root gateway needs Tailscale operator rights (`sudo tailscale set --operator=$USER`, line 134).
- A connection through managed Serve is `tailscale-serve` ingress (`resolveManagedTailscaleIngress`, `ingress-attribution-BQX5Ye8B.mjs` lines 55-93), never `direct-local`: a new device's pairing waits for approval like any remote one. Tailscale identity headers sign in only OpenClaw's own Control UI (lines 110-120).
- `openclaw qr` advertises the Tailscale address only when OpenClaw owns the route (`<openclaw>/docs/cli/qr.md` line 69), which makes it the setup-code address for a phone away from home.
- A route someone made by hand to the ordinary listener is generic proxy ingress and needs `gateway.trustedProxies` (lines 122-126); without it the gateway refuses it (section 3, "A proxy route made by hand").
- Turning it on is `openclaw config set gateway.tailscale.mode serve` and a restart of the gateway (`openclaw gateway restart`); off is `openclaw config set gateway.tailscale.mode off` and a restart. What the three named failures look like is read from `openclaw gateway status --json` and the gateway's log after the restart; their exact words are **unverified**, because the program may not be run here. The design names them from Tailscale's own states: not installed (the program is not found), signed out (`NeedsLogin`), HTTPS not enabled.

## 9. What could not be proven here

| What | Why | What the design does about it |
|---|---|---|
| A phone's setup-code connect from another address waits for approval | The development instance listens on loopback only, and a header-adding proxy is refused outright | Treats it as waiting, with "Approve from here" on the desktop (source, section 3) |
| A clean Windows without a usable Node | The runner had Node 22, which the installer replaced machine-wide | The design says before installing on Windows that the computer's Node may be replaced (section 6.6) |
| Tailscale's three failures, in OpenClaw's words | No `tailscale` program may run on this machine; the runners are not on a tailnet | Named from Tailscale's own states, worded by Clawtrate |
| A gateway signing a client's challenge with its identity key | No such method found | Each route pairs by itself; routes are grouped after authentication (section 5) |
| `install.sh` | Not in the npm package; only served by the website | Not used: `install-cli.sh` from the pinned tarball covers macOS and Linux |

## Files

| File | What it is |
|---|---|
| `setup-flow/pair-probe.ts` | The probes for sections 1 to 4: `pair`, `upgrade`, `code`, `method`, `proxy`. Acts only on a named instance started with `--default-local-pairing`, runs `openclaw` only through the development tool's guarded runner, and redacts every token it prints. |
