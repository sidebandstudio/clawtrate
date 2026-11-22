# Effortless setup and connection

How a person gets from opening Clawtrate to chatting with their Main Bot with no Terminal command on this Mac, and with at most one approval for a gateway on another computer. This design replaces the read-only-first tiers of `docs/decisions.md` ("Connecting to the gateway") and changes `setup.md` §7, §9, §12 and §13. Everything else in `setup.md` stands: the first screen's question, SSH routes, setting OpenClaw up, routes and identity.

The evidence is `docs/research/setup-effortless/full-scope-probe.ts`, run against development gateways, and OpenClaw 2026.10.6's own source and docs. `<openclaw>/…` is a path in the installed `openclaw` 2026.10.6 package, as in `docs/research/setup-flow.md`; chunk names carry a build hash, so search by the `//#region` marker. **Live** means a probe ran it on a development gateway; **source** means it was read only.

## Why the earlier decision is superseded

The product owner decided this:

> "You have my OK. This is important to me. Approvals are genuine nightmare and defeat the entire purpose of this."

So two things change on purpose:

1. **Clawtrate asks for all six operator scopes at its first connect**: `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, `operator.admin` and `operator.pairing`. It holds less only when the gateway grants less.
2. **Clawtrate approves other devices from inside the app**, with `device.pair.approve` and `device.pair.reject`, wherever OpenClaw 2026.10.6 allows it.

The targets:

| Gateway                                                       | Terminal commands                                          | Approvals in total   |
| ------------------------------------------------------------- | ---------------------------------------------------------- | -------------------- |
| On this Mac, OpenClaw's default settings                      | 0                                                          | 0                    |
| On another computer reached by SSH                            | 0                                                          | 0                    |
| On another computer by address (Tailscale, VPS, LAN, Windows) | 0 when another Clawtrate is already connected; otherwise 1 | 1                    |
| A phone or a second computer, once one Clawtrate is connected | 0                                                          | 1 click in Clawtrate |

Every other approval or Terminal step is a defect. Section 12 lists the ones 2026.10.6 still forces, says exactly why, and gives the smallest path around each.

The safety rules that stay: the approve prompt says exactly which device and which scopes, and cannot be clicked through by accident (§5); local connect runs none of OpenClaw's programs (§3); a plain `ws://` address to a host that isn't this computer is flagged (§4).

## Contents

1. What changes, path by path
2. Scopes: everything at the first connect
3. Connect to OpenClaw on this Mac
4. Another computer: the form up front
5. Approving a device from inside Clawtrate
6. Fixing access from here (F-500)
7. The first run, with #292 and #314, timed
8. Failure states
9. iOS
10. Decisions this supersedes
11. Parity rows
12. What still needs an approval or a command, and why
13. Not covered

## 1. What changes, path by path

| Path                                        | Today                                                                                                                                                                                                                                                                                                                      | After                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| This Mac, OpenClaw running                  | The look reads the version and stops: "This version of OpenClaw can change its own installation whenever one of its commands runs, so Clawtrate doesn't run it to look. Use Advanced with the gateway's address and token." The person types the address and token, then approves up to three access requests in Terminal. | Clawtrate reads the address and token from OpenClaw's settings file. "Connect" pairs silently with all six scopes. No command, no approval.       |
| This Mac, a device paired read-only earlier | Each first send, admin action or Machines visit asks for more, and each request waits for `openclaw devices approve`.                                                                                                                                                                                                      | One reconnect that presents the token from the settings file. The gateway upgrades it silently (live, §6).                                        |
| Another computer over SSH                   | Not built; would run `openclaw qr` over SSH.                                                                                                                                                                                                                                                                               | Clawtrate reads the settings file over SSH with a fixed script that runs no OpenClaw program, forwards the port, and pairs silently with all six. |
| Another computer by address                 | Advanced, read-only, then one approval per tier.                                                                                                                                                                                                                                                                           | The address-and-token form or a pasted setup code on the first screen. One approval for all six, in Clawtrate if another Clawtrate is connected.  |
| A phone                                     | "Clawtrate doesn't make codes for phones yet."                                                                                                                                                                                                                                                                             | "Connect a phone" makes a code through the gateway, with no command. The phone asks; Clawtrate on the desktop shows the approve prompt.           |

## 2. Scopes: everything at the first connect

### What OpenClaw 2026.10.6 does (live, on two development gateways)

- **On loopback, with OpenClaw's default local pairing, a new device asking for all six with the shared token is paired silently with all six** (`approvedVia: "silent"`), and reconnects later with its device token alone, asking for the same six. `shouldAllowSilentLocalPairing` (`<openclaw>/dist/node-connect-reconcile-CAkPC2vI.mjs` lines 178-185) does not look at the scopes asked for a first pairing; it looks at locality, a browser `Origin` header and `gateway.nodes.pairing.autoApproveLocal`, which defaults to `true` (`<openclaw>/docs/gateway/config-gateway.md` line 222) and which onboarding does not set.
- **Off loopback, one request for all six is one approval.** On an instance with local auto-approval off (the stand-in for another computer, since a development gateway is loopback-only by its contract), the connect failed with `PAIRING_REQUIRED`, `requestedScopes` all six, and `openclaw devices list` showed one pending request with all six. One `devices approve` paired it with all six.
- **Admin covers everything.** `operator.admin` satisfies every operator scope (`<openclaw>/docs/gateway/operator-scopes.md` line 38). Clawtrate still asks for all six by name, because `operator.pairing` is what the gateway checks for pairing events, and because a token whose admin is later narrowed keeps the named scopes.
- **Clawtrate's ladder today** comes from three places: every connect asks for `operator.read` alone (`REQUESTED_SCOPES` in `packages/core/src/client.ts`; `normalizeHeldScopes` in `packages/core/src/scopes.ts` drops admin and pairing from what a reconnect asks for); each later tier is a separate `device.scopes.requestUpgrade` (the composer, the cards and the access bar ask for the interactive tier; `bots/parts.tsx` asks for admin; `machines/Machines.tsx` asks for pairing); and `device.scopes.requestUpgrade` always files a request that waits, even on loopback (`<openclaw>/dist/devices-mOg4_HQd.mjs` lines 37-110; `setup-flow.md` §2). So a person on a remote gateway approved up to four times, and on this Mac up to three.

### What Clawtrate asks for

- **Every first connect asks for the six**, in this order: `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, `operator.admin`, `operator.pairing` (`FULL_SCOPES` in `packages/core/src/scopes.ts`, replacing `READ_SCOPES` as what a new pairing requests). Caps are `tool-events`, `approvals`, `exec-approvals` and `plugin-approvals`, as for any connect that asks for approvals.
- **Held is what was granted.** The token record's `heldScopes` becomes whatever the hello granted within the six. A reconnect asks for exactly `heldScopes`. Nothing is dropped from it by normalization any more.
- **Narrower only when the gateway grants narrower.** That happens in four ways in 2026.10.6, and each has one answer:
  - A named operator role caps the request (`gateway.roles`; `requestUpgrade` refuses with "requested scopes exceed your assigned operator role", `devices-mOg4_HQd.mjs` lines 54-61). Clawtrate then asks once for the interactive four plus pairing, then for read alone, and holds the first that is granted. Settings says "This gateway's owner limits what Clawtrate can do here."
  - A setup code with the `limited` ceiling refuses a request that includes admin (`AUTH_BOOTSTRAP_TOKEN_INVALID`, live). A code whose address is plain `ws://` to another host is limited by OpenClaw itself (`<openclaw>/dist/device-bootstrap-profile-DQKf7Vz1.mjs`). Clawtrate asks such a code for the five without admin.
  - The gateway's owner narrows the device token later (`openclaw devices rotate --scope …`). The next reconnect asking for `heldScopes` is refused with `AUTH_SCOPE_MISMATCH` (live). Clawtrate reconnects asking for read, holds what that grants, and offers "Ask for full access" once.
  - The owner rejects the request. The device stays as it was.
- **Existing pairings migrate once.** A device that holds less than the six asks for the rest at its next connect: on this Mac or over SSH by the shared-token reconnect of §6, silently; elsewhere by one `device.scopes.requestUpgrade` for all six, approved in Clawtrate on another device or once on the gateway's computer. The access bar's tiers (`AccessBar.tsx`) disappear; the bar remains only while a request waits or after a refusal.
- **Platform and device family never change on a device.** The gateway pins both at pairing; a reconnect that reports another value files a `metadata-upgrade` request, which off loopback waits for approval (`resolvePinnedClientMetadata`, `<openclaw>/dist/message-handler-CRCo2VX0.mjs` from line 884; the request at line 1534; live: a device paired as `ios` that reconnected as `darwin` waited). The host fixes both once per device and never derives them from anything that can change.

### What the person is told

On the card before Connect (this Mac, SSH and the address form alike), one line under the button:

> "Clawtrate gets full control of this OpenClaw: your bots, their settings and tools, and which devices may connect."

After connecting, Settings, Gateway, "Access" reads "Full control" with "Clawtrate can change this gateway's settings, approve devices, and open a terminal on its computer." and a quiet "Use read-only access" link that reconnects this device asking for read alone (§13 leaves the reverse to later work).

## 3. Connect to OpenClaw on this Mac

Clawtrate reads where the gateway listens and its token from OpenClaw's own settings file. It runs no OpenClaw program, before or after Connect. That keeps #145's rule: OpenClaw's launcher may repair its own installation before any command (`<openclaw>/openclaw.mjs` lines 649-715), so Clawtrate never starts it to connect.

### Where 2026.10.6 keeps them (source, and live on development gateways)

- **The file.** `openclaw.json` in the profile's state folder: `~/.openclaw/openclaw.json` for the default profile, `~/.openclaw-<profile>/openclaw.json` for a named one (`resolveConfigPath`, `<openclaw>/dist/paths-BP0DYpE8.mjs` lines 118-140; `CONFIG_FILENAME`, line 25). `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` move it, but only for a process started with them; Clawtrate reads the two canonical places only, the default profile and `clawtrate`.
- **Its format.** JSON5 (`parseConfigJson5`, `<openclaw>/dist/io.read-helpers-CMGXaUZA.mjs` line 89; `<openclaw>/docs/gateway/configuration.md` line 10). OpenClaw writes it as owner-only: the folder 0700 and the file 0600 (`<openclaw>/dist/io.write-DVKwks5G.mjs` lines 171 and 267, modes 448 and 384). Live: both development instances' files were 0600 and plain JSON. A file may use `$include` to split itself.
- **The port.** `gateway.port`; precedence is `--port`, then `OPENCLAW_GATEWAY_PORT`, then `gateway.port`, then 18789 (`config-gateway.md` line 135; `DEFAULT_GATEWAY_PORT`, `paths-BP0DYpE8.mjs` line 174). Every bind mode keeps a listener on `127.0.0.1` for the same port: `loopback` and `auto` bind it, `lan` binds `0.0.0.0`, and `tailnet` and `custom` add `127.0.0.1` beside their own address (`config-gateway.md` line 145).
- **The token.** `gateway.auth.token`, with the mode `token` by default (`finalizeResolvedGatewayAuth`, `<openclaw>/dist/auth-resolve-2uQi6dqM.mjs` lines 21-60; config first, then `OPENCLAW_GATEWAY_TOKEN`). QuickStart onboarding, interactive or not, writes a plain random token into the file (`<openclaw>/dist/setup.gateway-config-DLdeoMLK.mjs` lines 94-138; `<openclaw>/dist/gateway-config-LAsda5fP.mjs`). The advanced flow can store it instead as a SecretRef: in OpenClaw's own SQLite secret store, in an environment variable, a file or a command (`provisionGatewayTokenStoreRef`, `<openclaw>/dist/auth-token-store-ref-CCN2hGmr.mjs`). Clawtrate uses only a plain string; it never opens OpenClaw's database or runs a command.
- **The other modes.** `password` with a plain `gateway.auth.password` is used the same way. `none` connects with no credential. `trusted-proxy` can't be used from here.
- **Reading has no side effect.** A read changes nothing OpenClaw watches; OpenClaw reloads on writes (`configuration.md` line 74).
- **A loopback connect with the shared token pairs silently**, at any scopes asked for (§2, live).

### What Clawtrate checks before it sends the token

1. The file is `openclaw.json` in one of the two canonical folders, opened without following a link, a regular file with one link, owned by this account, not writable by group or others, and at most 1 MiB. Anything else: "can't use the settings file" (§8).
2. It parses as JSON5, with no `$include` under `gateway`. `gateway.mode` is `local` or absent.
3. `gateway.auth.mode` is `token`, `password`, `none` or absent, and the token or password is a non-empty plain string, not a SecretRef object.
4. `gateway.tls.enabled` is not `true`. A TLS gateway on this Mac goes to the form (§8).
5. The port, from `gateway.port` or 18789, has a listener on `127.0.0.1` owned by this account, read from the system (`lsof` on macOS, `/proc/net/tcp` on Linux), never from OpenClaw. A listener of another account is refused: it could be anything waiting for the token.

These checks run when the first screen opens, so the card already knows what Connect will do. The token is read again at Connect, held in the host process only for the handshake, never stored, never put in renderer state, a log line, an argument or an environment, and forgotten at the first hello. After pairing, the device token is what Clawtrate keeps, as today.

### The first screen on a Mac with OpenClaw running

The question stays "Where does OpenClaw run?", but the look runs before the person answers, because it only reads files. When it finds a gateway it can connect to, the first screen leads with it:

- A found card at the top: a green dot, "OpenClaw is running on this Mac", and under it "Port 18789 · default profile · version 2026.10.6" (the version read from OpenClaw's own `package.json`, as today; another profile is named).
- **"Connect"**, primary, with the full-control line of §2 under it.
- Below the card, quieter: "Another computer" and "Have a setup code?".

Clicking Connect is the consent; there is no second dialog on this Mac. The steps then show in place of the button, each with its tick:

1. "Reading OpenClaw's settings"
2. "Pairing this Mac"
3. "Loading your bots"

It takes one to three seconds. Then the first run continues (§7).

When the look finds nothing it can connect to, the first screen is as today (`setup.md` §3), with the reason in a note above the two rows (§8).

### Over SSH

The SSH route of `setup.md` §5 and §8 stays, with one change: the LOOK and CODE scripts that would run `openclaw` on the other computer are replaced by a fixed script that reads `~/.openclaw/openclaw.json` (and `~/.openclaw-clawtrate/openclaw.json`) and checks the port's listener with that computer's own tools, the same checks as above. The file is parsed on the desktop, never on the other computer. The forward then makes the connect a loopback one, and the gateway pairs it silently with all six (`setup-flow.md` §1 measured the forward's silence for read; the scopes don't change it, §2). The token travels inside the SSH connection only.

### In development

A sandboxed run reads the development instance's own `openclaw.json` (`~/.openclaw-clawtrate-dev-<name>/openclaw.json`), proven as `sandbox.ts` proves the instance today. That replaces the stand-in's answers to `gateway status` and `qr`. A development gateway has local auto-approval off by its contract, so a sandboxed Connect ends on one approval unless the instance was started with `--default-local-pairing`, which the setup checks use for this path.

## 4. Another computer: the form up front

"Another computer" opens one screen with the SSH field first, as `setup.md` §5 has it, and two more ways in, at the same level instead of under Advanced:

- **"Address and token"**: two fields, "Gateway address" (placeholder `wss://gateway.example`) and "Token" (a password field with show and hide). Connect is available when the address parses.
- **"Setup code"**: one field, "Paste a setup code", for a code made by another Clawtrate (§9) or by OpenClaw.

The address-and-token form is the old Advanced form, moved here; "Advanced" disappears from the first screen.

**Warnings, and only these.**

| The address                                          | Line under the field                                                                                                                                             | Connect                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `wss://` with a certificate the system trusts        | none                                                                                                                                                             | Available                                                                              |
| `ws://` to `127.0.0.1`, `::1` or `localhost`         | none                                                                                                                                                             | Available                                                                              |
| `ws://` to any other host                            | "This connection isn't encrypted. Anyone on the network between you and the gateway can read it, including the token. Use a `wss://` address or SSH if you can." | Available, as "Connect without encryption"                                             |
| `wss://` with a certificate the system doesn't trust | "Clawtrate can't verify this gateway's certificate. Its fingerprint is SHA-256 AB:12:…:9F. Connect only if this matches the gateway's own."                      | Available after "Trust this certificate", which pins that fingerprint for this address |
| Not an address                                       | "That isn't a gateway address."                                                                                                                                  | Unavailable                                                                            |

A setup code validates as `setup.md` §13 says, with its `ws://` refusal replaced by the warning above.

**Waiting for the one approval.** The connect asks for all six and the gateway answers `PAIRING_REQUIRED`. The screen, titled "Approve this Mac", shows:

- "Waiting for approval from the gateway's owner." and the address.
- This device's code, large, in the mono face: "7C41-D2E0", with "The approver sees this code."
- What was asked for: "Full control" with the six scopes in plain words (§5's list).
- Three ways to approve, in this order:
  1. "In Clawtrate on a computer or phone already connected to this gateway: it asks you there." (no command)
  2. "In OpenClaw's Control UI on the gateway's computer, under Devices." (no command; `<openclaw>/docs/web/control-ui/connect-and-pair.md` lines 32-34)
  3. "Or on the gateway's computer, run:" and the command, `openclaw devices approve <requestId>`, with the copy button and the profile line of `setup.md` §9.
- The waiting line, "Check now" and Back, as the pairing screen has them.

Clawtrate retries every 3 seconds, which keeps the request id, and connects by itself once it is approved. A pending request expires after five minutes (`DEVICE_PAIRING_PENDING_TTL_MS`, `<openclaw>/dist/device-pairing-identity-D438fF14.mjs`); the screen then says "The request expired." with "Ask again".

## 5. Approving a device from inside Clawtrate

### What 2026.10.6 allows (live)

- **The event.** A connection holding `operator.pairing` (or admin) receives `device.pair.requested` when any device files a pairing request, and `device.pair.resolved` when one is decided. Read and write connections receive neither (live here and in `device-node.md` §1.6). The event is a prompt to read the list; Clawtrate never acts on the event's payload alone.
- **The payload** (`DevicePairRequestedEvent` in the protocol schema): `requestId`, `deviceId`, `publicKey`, `displayName`, `platform`, `deviceFamily`, `clientId`, `clientMode`, `browserOrigin`, `role`, `roles`, `scopes`, `remoteIp`, `silent`, `isRepair`, `ts`. Live, a new device asking for all six showed `displayName`, `platform`, `clientId: "gateway-client"`, `clientMode: "ui"`, `role` and `roles` `["operator"]`, the six `scopes`, `silent: false` and `isRepair: false`. `remoteIp` appears for a connection that isn't loopback. **Every field except the ids, the key, `remoteIp` and the time is written by the device that asks.** A name like "My iPhone" proves nothing.
- **`device.pair.list`** (`{}`, `operator.pairing`) returns `pending` and `paired`. A caller with admin sees every request; a device-token caller without admin sees only its own (`devices-mOg4_HQd.mjs` lines 341-354; live: the pairing-only device listed none).
- **`device.pair.approve {requestId}` and `device.pair.reject {requestId}`** (`operator.pairing`). **Approving another device's request needs `operator.admin`**: without admin, a device-token caller is refused for any request but its own (`authorizePairingDecision`, `devices-mOg4_HQd.mjs` line 303, `device-ownership-mismatch`), and the approver must hold every scope it grants (`caller-missing-scope`, `<openclaw>/dist/device-pairing-approval-uwflSfHu.mjs` lines 6-16). Live: a device holding read and pairing heard the request, listed nothing, and was refused ("device pairing approval denied") for a full request and for a read-only one; the admin device approved both kinds. OpenClaw's docs say pairing is enough for operator approvals within the caller's scopes (`<openclaw>/docs/cli/devices.md` line 59); that holds for a shared-token caller, which Clawtrate never is once paired.
- **What approving does.** The approve answer carries the device record, with `approvedVia: "owner"` and the scopes granted. The requester's next retry with the same credential gets a hello with all six (live). Approving the same request twice answers "unknown requestId". Rejecting a request ends it; the same device's next connect files a new request (live).

### Who sees the prompt

Every Clawtrate window and device connected with admin. A connection with pairing but without admin hears the event and shows no prompt; its notification says "A device is asking to connect to this gateway. Approve it in Clawtrate on a device with full control." Clawtrate's own device never sees a prompt for its own request.

### The prompt

A modal over the app, at any screen, opened by the event after `device.pair.list` confirms the request is pending. It never opens on its own over a text field the person is typing in: it waits, and the rail shows a badge on Settings, Gateway, "Devices" with "1 asking" meanwhile.

- Title: **"Let a new device control this gateway?"** For `isRepair`: **"Give "Clawtrate Desktop" more access?"**
- Who asks, in a framed block:
  - The name it reports, in quotes, with "(reported by the device)" in muted text.
  - Platform and app, in words: "iPhone · Clawtrate", "Mac · Clawtrate", "Browser · OpenClaw Control UI (from https://…)" when `browserOrigin` is set, "Another app (gateway-client)" otherwise.
  - Where from: "On the gateway's own computer" without `remoteIp`; "From 192.0.2.10" with it, and "(Tailscale)" for 100.64.0.0/10.
  - When: "Asked 12 seconds ago".
- What it gets, as a list in plain words, each scope on its own row with its name in mono beside it:
  - "See your bots, tasks and conversations" (`operator.read`)
  - "Send messages and stop runs" (`operator.write`)
  - "Answer approval cards" (`operator.approvals`)
  - "Answer bots' questions" (`operator.questions`)
  - "Change the gateway's settings, plugins and accounts, and open a terminal on the gateway's computer" (`operator.admin`), in the warning color
  - "Approve and remove other devices" (`operator.pairing`), in the warning color
  - For `isRepair`, only the scopes it doesn't hold yet, under "Adds".
- **The code check**, which is what makes the prompt impossible to click through: "Which code does the new device show?", and three codes as buttons, one of them the requester's (the first eight hex digits of `deviceId`, grouped 4-4, the device code component of `setup.md` §2) and two others made at random for this prompt, in random order. Approve is disabled until a code is chosen. A wrong choice closes the prompt as "Didn't match: nothing was approved." and keeps the request pending; the next attempt draws two new decoys.
- Buttons: **"Deny"** (secondary, left) and **"Approve"** (primary, right, disabled until the right code is chosen). Escape and clicking outside close the prompt and decide nothing ("Not now"). Enter never approves. Focus starts on the code choice.
- A role other than `operator` (a node asking to be a machine) opens no prompt; it goes to Machines, whose approval design is `device-node.md`'s.

**After a choice**: Approve calls `device.pair.approve` once and shows "Approved. The device connects in a moment." for 3 seconds; Deny calls `device.pair.reject` and shows "Denied. The device can ask again." The decision is never retried by itself.

### Several windows and devices

- Every admin window and device opens the prompt. The first decision wins. `device.pair.resolved` closes every other open prompt for that request with "Approved on another device" or "Denied on another device".
- A decision that answers "unknown requestId" re-reads the list and closes the prompt with what the list says now ("Already decided" or "This request expired").
- A request superseded by a new one (the device retried with changed details) closes its prompt; the new request opens a new one, and the code check starts again.
- Requests arriving while a prompt is open queue behind it, at most 8; more than that shows one line, "Several devices are asking", which opens Settings, Gateway, Devices.

### Settings, Gateway, Devices

The list from `device.pair.list`: pending requests at the top with Approve and Deny (each through the same prompt), then paired devices with their name, platform, scopes in words, "Paired 3 days ago", and "Remove" (`device.pair.remove`, admin, through the host's confirmation "Remove "Clawtrate iPhone"? It can't connect again until it pairs."). Shown only with admin.

## 6. Fixing access from here (F-500)

F-500 asked for "Approve from here" when an access request waits on this computer or over SSH. With the token readable, nothing has to be approved there:

- **On this Mac and over SSH**, Clawtrate reconnects once presenting the shared token from the settings file, asking for the six. The gateway files a `scope-upgrade` and approves it silently, because the connection is local and authenticated with the shared token (`shouldAllowSilentLocalPairing`, the `scope-upgrade` branch, `node-connect-reconcile-CAkPC2vI.mjs` line 183). Live: a device paired for read alone was refused with `AUTH_SCOPE_MISMATCH` when it asked for six with its device token, was upgraded to all six when it presented the shared token, and then reconnected with its device token alone holding all six.
- **The confirmation.** The access bar or Settings says "Clawtrate has read-only access to OpenClaw on this Mac." with **"Give full control"**. That opens the host's own dialog, "Give Clawtrate full control of OpenClaw on this Mac?", with the detail "Clawtrate reads OpenClaw's token from its settings file and reconnects. It can then change the gateway's settings and approve devices." and "Give full control" and "Cancel".
- **The check on reconnect.** The hello must grant all six. If it grants fewer, Clawtrate holds what was granted and says "OpenClaw granted less than full control." with the list of what is missing. If the gateway answers `PAIRING_REQUIRED` with reason `scope-upgrade` (local auto-approval is off), the screen of §4 shows the one approval.
- **On a gateway by address**, Clawtrate calls `device.scopes.requestUpgrade` for the six on its live socket, and the other Clawtrate devices with admin get the §5 prompt (an upgrade is a pairing request with `isRepair`). Otherwise the §4 screen shows the three ways.

**Running OpenClaw's own program after the person clicks Connect or Give full control is not acceptable as the default path, and is not needed.** The launcher replays pending package-lifecycle work and may start a Node runtime recovery before it handles any command (`openclaw.mjs` lines 37-80 and 649-715). That is OpenClaw finishing an install of its own, but a click on Connect doesn't consent to it, and Clawtrate can't tell beforehand what it will change. The one case left where only OpenClaw's command could approve is a gateway on this Mac with `autoApproveLocal: false`; its owner chose to approve every device by hand, so Clawtrate shows the command instead of running it (§12).

## 7. The first run, with #292 and #314, timed

From opening the app to chatting with an animated Main Bot, on a Mac where OpenClaw runs with OpenClaw's defaults and a model account:

| Step | What happens                                                                                                                                                                                      | The person does       | Time      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------- |
| 1    | The app opens. The host reads the settings file and checks the listener while the first screen draws.                                                                                             | Nothing               | 1-2 s     |
| 2    | The first screen leads with "OpenClaw is running on this Mac" and Connect.                                                                                                                        | Reads, clicks Connect | 3-5 s     |
| 3    | Pairs silently with all six; loads bots and tasks. External channel chats are hidden by default (#314), so the rail shows bots, not channel traffic.                                              | Nothing               | 1-3 s     |
| 4    | "How hands-off should your bots be?" (#292 §1): two choices, "Let them work on their own" (default) and "Ask me before they act". Full control is already held, so either choice applies at once. | Chooses               | 5-10 s    |
| 5    | The Main Bot's chat opens (#292 §2): an existing primary bot, or a new one when the gateway has none (F-005). Its creature (#300) plays "working".                                                | Nothing               | under 1 s |
| 6    | The Main Bot greets and asks what to call it (F-006). This waits for the model's first reply.                                                                                                     | Reads                 | 5-10 s    |
| 7    | The person answers; the Main Bot renames itself and the rail follows (#292 §2).                                                                                                                   | Types a name          | 5-15 s    |

That is 21 to 46 seconds, with no command and no approval. Steps 1 to 5 are Clawtrate's; step 6 is the model's.

The same first run from SSH adds the SSH screens of `setup.md` §5 (the name, and the host key at first contact): 10 to 20 seconds more. From an address, the one approval adds however long its owner takes; with another Clawtrate already connected, that is the 5 to 10 seconds of the prompt.

Where 60 seconds is not reachable, and why:

- **No OpenClaw yet.** Setting OpenClaw up takes 20 to 33 seconds to install and 18 to 28 to onboard (`setup-flow.md` §6), and the Main Bot then needs a model account (F-504, the provider accounts flow) before it can greet.
- **A gateway with no model account.** The Main Bot can't answer. #292's greeting should then come with the account sign-in as its first question card, rather than a silent wait.

## 8. Failure states

On this Mac, before Connect (the first screen's note, above the two rows):

| What the host found                                                                            | Note                                                                                                     | Actions                                                      |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| No `openclaw.json` in either folder, and no OpenClaw program                                   | **"Clawtrate didn't find OpenClaw on this Mac."**                                                        | "Set up OpenClaw here" (`setup.md` §10), "Another computer"  |
| No `openclaw.json`, OpenClaw's program installed                                               | **"OpenClaw is installed but not set up yet."** "Finish OpenClaw's setup, then look again."              | "Look again", "Another computer"                             |
| The file can't be read: not a regular file, a link, another owner, writable by others, too big | **"Clawtrate can't use OpenClaw's settings file."** "It must belong to you and only you may change it."  | "Use an address and token" (the form, the address filled in) |
| Not valid JSON5, or `gateway` uses `$include`                                                  | **"Clawtrate couldn't read OpenClaw's settings."**                                                       | as above                                                     |
| The token is a SecretRef                                                                       | **"OpenClaw keeps its token somewhere Clawtrate doesn't read."** "Paste the token, or connect over SSH." | the form, the address filled in                              |
| `trusted-proxy` mode                                                                           | **"This gateway signs in through a proxy Clawtrate can't use here."**                                    | the form                                                     |
| TLS on                                                                                         | **"This gateway uses TLS on this Mac."**                                                                 | the form, `wss://127.0.0.1:<port>` filled in                 |
| Nothing listens on the port                                                                    | **"OpenClaw is set up but not running."** "Port 18789 didn't answer."                                    | "Look again" (F-497's Start stays later work)                |
| Another account's process listens on the port                                                  | **"Another account on this Mac is using port 18789."** "Clawtrate won't send OpenClaw's token to it."    | "Look again"                                                 |
| A version below 2026.7.0                                                                       | as today's "too old" card                                                                                | as today                                                     |

After Connect:

| What happened                                                                             | Line                                                                                                          | Actions                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| The token was refused (`AUTH_TOKEN_MISMATCH`): the gateway was started with another token | **"The token in OpenClaw's settings didn't work."** "The gateway may have been started with a different one." | "Use an address and token"          |
| `PAIRING_REQUIRED`: local auto-approval is off                                            | the §4 waiting screen                                                                                         | as there                            |
| The hello granted fewer than six                                                          | **"OpenClaw granted less than full control."** with what is missing                                           | "Continue" (holds what was granted) |
| The port stopped answering between the look and Connect                                   | **"OpenClaw stopped answering."**                                                                             | "Look again"                        |
| A protocol other than 4                                                                   | today's protocol notice                                                                                       | as today                            |
| The bots couldn't be read                                                                 | today's "Connected, but Clawtrate couldn't read your bots."                                                   | as today                            |

## 9. iOS

The iPhone app (#14, #52) is not on `main`. What this changes for it:

- **It asks for all six** at its first connect, like the desktop.
- **Its first screen** offers "Scan a code from Clawtrate" (primary), "Paste a setup code" and "Enter an address and token". The review screen of `setup.md` §13 stays, with the `ws://` refusal replaced by §4's warning.
- **Its waiting screen** shows its device code large, "Approve this iPhone in Clawtrate on your computer. Check that it shows 7C41-D2E0.", the six in plain words, and the other two ways of §4 below. It connects by itself on approval.
- **"Connect a phone" on the desktop** (F-506) works with no command: with admin, the desktop calls `device.pair.setupCode` (`operator.admin`, not advertised in `hello-ok`, `setup-flow.md` §4) with the gateway's address the phone can reach, shows the QR code and the code with its expiry, and keeps the dialog open; when the phone asks, the §5 prompt opens on top, and its code check matches the phone's screen. Live: a code made this way lived 600 seconds; a new device redeeming it asking for six waited (`PAIRING_REQUIRED`), the admin device heard the request and approved it, and the device's retry with the same code got all six. A `limited` code refused a request for six. `device.pair.setupStatus` stayed empty and the request carries no `setupId`, so the request can't be tied to the code by the gateway; the code check is what ties it.
- **The phone's address.** The code needs an address the phone can reach: a Tailscale `wss://` address or a LAN one. A gateway on loopback alone has none; the dialog says "This gateway is only reachable on its own computer. Set up private access first." with `setup.md` §14's link. A plain `ws://` LAN address makes OpenClaw limit the code, so the phone asks for the five without admin and says so.
- **The prompt at 390 px** is a full-height sheet with the same content; the code buttons are full width.
- **A phone with admin approves too.** It gets the same prompt as the desktop.

## 10. Decisions this supersedes

Each quote is from `docs/decisions.md` or `docs/design/setup.md` as it stands; the build rewrites those sections with the replacement, as `AGENTS.md` asks.

1. `decisions.md`, "Connecting to the gateway", **Scopes, in tiers**:

   > "A device starts read-only: every `connect` requests exactly `operator.read`, and reading bots, tasks, transcripts and live streams needs nothing more. The first time the user sends, stops or answers something, the client asks once, through `device.scopes.requestUpgrade`, for the interactive tier … `operator.admin` and the narrower `operator.sessions.*` scopes are never requested."

   Replacement: "**Scopes, all at once.** Every first connect asks for `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, `operator.admin` and `operator.pairing`, because the product owner decided approvals defeat the purpose ("Approvals are genuine nightmare and defeat the entire purpose of this."). A reconnect asks for exactly what was granted. The client asks for less only when the gateway grants less: a role ceiling, a limited setup code, a narrowed token or a rejection (`docs/design/setup-effortless.md` §2). The narrower `operator.sessions.*` scopes are never requested."

2. `decisions.md`, **Requested is not granted**:

   > "Only `heldScopes`, normalized to read plus whichever interactive scopes were granted, is ever requested; a record without it means read."

   Replacement: "Only `heldScopes`, the granted scopes within the six, is ever requested; a record without it means read, and asks for the rest once (§2, 'Existing pairings migrate once')."

3. `decisions.md`, **Pairing**:

   > "On `PAIRING_REQUIRED` it shows the request id and an approve command chosen by the host"

   Replacement: "On `PAIRING_REQUIRED` it shows this device's code, the scopes asked for, and three ways to approve: Clawtrate on another device, OpenClaw's Control UI, or the approve command chosen by the host, last."

4. `decisions.md`, "Setting up on this computer", **What the look runs, and when it runs nothing**:

   > "So the look never runs an installed OpenClaw whose version isn't on a list of versions verified to have a read-only path (`READ_ONLY_VERSIONS` in `apps/desktop/src/setup/look.ts`), and that list is empty. … 'This version of OpenClaw can change its own installation whenever one of its commands runs, so Clawtrate doesn't run it to look. Use Advanced with the gateway's address and token.'"

   Replacement: "The look runs no OpenClaw program on any version. It reads the version from OpenClaw's `package.json`, and the address and token from `openclaw.json` in the default or `clawtrate` profile's folder, with the checks of `setup-effortless.md` §3, and checks the port's listener with the system's own tools. `READ_ONLY_VERSIONS`, `gateway status`, `config get` and `qr` leave the look." (Why the launcher is never run stays as written.)

5. `decisions.md`, **The host's confirmation**:

   > "Connect asks for read access, always, and the card's button says 'Connect read-only'."

   Replacement: "Connect asks for the six. On this Mac the card's button is the consent, with the full-control line under it; no second dialog."

6. `decisions.md`, **The one-time code**:

   > "After the dialog the host runs `openclaw [--profile clawtrate] qr --json --voice-node --url ws://127.0.0.1:<port>`"

   Replacement: removed. The host connects with the token read from the settings file, held in memory for the handshake only.

7. `decisions.md`, **No grant wider than the request**:

   > "After `acceptHello` it writes the token only when the hello's protocol is this client's, its role is `operator` and its scopes are exactly `["operator.read"]` (`setupGrant`)."

   Replacement: "…its role is `operator` and its scopes are within the six asked for. Another role, or a scope that wasn't asked for, writes nothing and closes the connection."

8. `decisions.md`, **What a sign-in is given is scrubbed** and **What a setup connection publishes**:

   > "The shared token is never asked for; only Advanced takes a token, typed."

   Replacement: "The shared token is read from OpenClaw's settings file on this Mac or over SSH, held in the host process for one handshake, and scrubbed from everything the client publishes and logs, as typed tokens are."

9. `setup.md`, the four facts:

   > "**Clawtrate does not read the gateway's shared token.** OpenClaw's commands refuse to show it to a program. The same user could read OpenClaw's configuration file, and the design deliberately does not."

   Replacement: "Clawtrate reads the gateway's shared token from OpenClaw's settings file, which belongs to the same user, and never runs OpenClaw's commands to get it."

10. `setup.md` §9:

    > "'Approve from here', which would run the approve command for the person, is not in this version"

    Replacement: §5 and §6 of this design.

11. `setup.md` §12:

    > "Clawtrate doesn't hand a code to a phone in this version, and approves nothing for the person"

    Replacement: §9 of this design.

12. `docs/parity.md` F-509:

    > "a setup code never gives the device more than read access at first; anything more is asked for later, by an explicit request, like every other connection."

    Replacement: "a setup code gives the device what it asks for up to the code's ceiling: all six for a full code, five without admin for a limited one."

`AGENTS.md`'s rule "Request the smallest operator scopes a feature needs, and keep a read-only connection useful" conflicts with item 1. This design doesn't edit `AGENTS.md`; the product owner updates it.

## 11. Parity rows

- **F-002** keeps "a pending-approval screen lists the exact operator scopes requested", now six.
- **F-491, F-492, F-494, F-515, F-516** become reachable on a real computer: the look connects without running OpenClaw. F-494's code becomes the shared token, under the same no-leak rule.
- **F-496** reads the settings file over SSH instead of making a code there.
- **F-500** becomes §5 and §6.
- **F-506** becomes §9's "Connect a phone".
- **F-509** changes as in §10.
- A new row: "a connected desktop with full control shows a prompt when another device asks to pair, with the device's reported name, platform and address, the scopes in plain words, and a code check; approving pairs it with no command."

## 12. What still needs an approval or a command, and why

| Case                                                                            | What 2026.10.6 forces     | Why                                                                                                                                                                                                                                                 | Smallest path around it                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The first device of a gateway by address, with no Clawtrate connected to it yet | One approval              | Off loopback, a client that isn't one of OpenClaw's own apps is never paired by its credential alone (`resolvePairingApprovalPlan`, `message-handler-CRCo2VX0.mjs` lines 1916-1969); approving needs an admin connection or the gateway's computer. | SSH instead (0); or approve in OpenClaw's Control UI on that computer, under Devices (no command); or the one command. |
| A gateway on this Mac with `autoApproveLocal: false`                            | One approval              | Its owner turned silent local pairing off; the check comes before any auth method (`node-connect-reconcile-CAkPC2vI.mjs` line 182).                                                                                                                 | The Control UI's Devices page, or the command. Clawtrate doesn't run it (§6).                                          |
| A token kept as a SecretRef                                                     | Typing the token once     | The value is in OpenClaw's database, the environment of its service, or a command Clawtrate doesn't run.                                                                                                                                            | Paste it into the form; or use SSH from a computer where it is a plain string.                                         |
| A device whose platform or family changed                                       | One approval off loopback | The gateway pins both (§2).                                                                                                                                                                                                                         | Never change them; a new device identity pairs fresh instead.                                                          |
| A device token narrowed by its owner                                            | One "Ask for full access" | The owner's narrowing wins (`connect-and-pair.md`: approval "preserves that token limit").                                                                                                                                                          | None by design: the owner chose it.                                                                                    |

## 13. Not covered

- Switching a connected device from full control back to read-only and forward again, beyond the "Use read-only access" link of §2.
- Keeping the device token in the system keychain instead of `<userData>/gateway/state.json`. With admin, it is worth more; see the research note's open questions.
- Tailscale identity sign-in (`gateway.auth.allowTailscale`), which was not tested.
- Node (machine) approvals, which stay in `device-node.md`.
- Windows, except as another computer reached over the network.
- The web preview host, which stays on the address-and-token form: it is a different device from the person's.
