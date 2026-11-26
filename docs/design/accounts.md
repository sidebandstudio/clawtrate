# A Clawtrate account: adding a device by signing in

How a person links their OpenClaw gateway to a Clawtrate account once, on the gateway's machine, and then adds any other computer or phone by signing in to that account, with no pairing code, no SSH and no command (issue #638). It joins the remote case of #629, the phone of #14 and #286, and the relay of #254. This is a design for sign-off: nothing hosted is built until it is signed off.

**Established** marks what the repository or OpenClaw's own source and documentation show today. **Proposed** marks this design's choice. **Not established** marks what could not be shown here, with what would show it. OpenClaw facts are from the published packages `openclaw@2026.10.6` (the version Clawtrate is tested against) and `openclaw@2026.11.10`, read only; `<openclaw>/docs/…` is a path inside either package.

## The page to decide from

### What an account is for

An account lets a person's devices find their gateway and lets their own devices say who else gets in. A person links their gateway to the account once, with one click on the gateway's machine. After that, a new computer or phone signs in with GitHub or Google, the person confirms it on a device they already have by picking the words the new device shows, and it is in: no address, no token, no code, no Terminal. Removing a device from any of their devices takes it out of the gateway at once. Someone who never makes an account keeps everything that works today.

### Linking a gateway and adding a device, step by step

The case this is for: OpenClaw runs on a Windows PC, and the person wants to use it from a MacBook.

**On the gateway's machine, once** (the Windows PC):

1. Install Clawtrate and open it. "Where does OpenClaw run?" → **This computer** → **Connect**. Clawtrate connects with full control and no approval, because OpenClaw lets a program on its own computer pair without asking (the same-computer flow of #629; on Windows it needs the Windows half of §12). _1 click._
2. Clawtrate offers "Use this gateway from your other devices". **Link with GitHub** or **Link with Google**. _1 click._
3. The browser opens on the account page. **Continue with Google** (or GitHub), and the provider's own consent screen the first time. _1 or 2 clicks._ If the browser isn't signed in to Google or GitHub yet, the person signs in there as they always do; that is typed into the provider, not into Clawtrate.
4. Back in Clawtrate: "Linked to your account. Sign in on your other devices." _0 clicks._

**On each other device, after** (the MacBook):

5. Install Clawtrate and open it. **Sign in**. _1 click._
6. The browser: **Continue with Google**. _1 click._
7. The Mac shows three words, for example "otter · maple · drum", and "Confirm on a device you already have".
8. On the Windows PC (or any device already in), Clawtrate shows "A MacBook Pro wants to use this gateway" and three sets of words. The person picks the one the Mac shows. _1 click._ Picking is what checks that the two screens are talking to each other and to nobody in between.
9. The Mac connects, and the person's bots, tasks, conversations, pinned bots and settings are there. _0 clicks._ Until the relay ships, this needs the two on the same network or the same private network (§8.2).

**Count.** Gateway's machine: 3 to 4 clicks once, then 1 click for each device added. Each new device: 2 clicks. **Typed into Clawtrate: nothing. Terminal: never.** Today the same case needs SSH or commands on the Windows PC, and approvals that are each a command typed there (#629).

A gateway on a server with no screen is the one exception: installing the connector there is one command, once (§8.4), because there is no app to click.

### What the account never holds

The account never holds or sees conversations, gateway tokens, provider credentials or the content of any file. It holds who is signed in, which gateways are linked, and the public keys of the devices on each.

**Why the service can't add a device by itself:** the program on the gateway's machine lets in only a device that one of the person's own devices has signed for, and the signing keys never leave those devices, so the account service, or anyone who takes it over, has nothing to sign with (§4).

### The decisions, with a recommendation and what each costs

1. **Where it runs, for $0.** _Recommended:_ the first version runs only the account service, on Cloudflare's free plan (Workers, with its D1 database and Durable Objects for the waiting room of a join), and carries no conversation through anything the project pays for: devices reach the gateway over the person's own network, their own private network (Tailscale and the like) or SSH. The free plan's 100,000 requests a day fit roughly **10,000 devices in daily use**. Past that, Cloudflare's paid plan is $5 a month and fits roughly 30,000; a million devices cost on the order of $100 to $150 a month. What this accepts: the service stops for the rest of the day (until 00:00 UTC) if the free limits run out, it depends on a provider's free plan that can change, and every connection still works while it is down. The relay that reaches a gateway from anywhere comes after the cryptographic review; on the same free plan it fits only about **75 devices in daily use**, about $90 a month at 10,000 and $8,000 to $9,000 a month at a million (§9). The code is open source and the same service runs on any small machine for someone who hosts it themselves.
2. **Sign-in.** _Decided:_ GitHub and Google first. The account service is the only program registered with each provider; the apps never hold a provider's secret or token (§7). _A third, signing in with a ChatGPT account:_ OpenAI's [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart) exists, but its identity sign-in is "currently available to selected commercial partners through a limited trial" (read 2026-11-25), so it needs OpenAI to admit Clawtrate first; adding it then is one provider module, not a redesign.
3. **Confirming a new device.** _Recommended:_ pick the matching words on a device already in (one click). It is what keeps the service from admitting anyone. A sign-in alone admitting a device would mean whoever controls the service, or the person's Google or GitHub session, could get into their gateway; that option is laid out in §4.6 and not recommended. A passkey can later drop the click on devices that support it (§4.6).
4. **"The same on every device."** _Recommended for the first version:_ everything about the person, not about the window, follows them, kept on their own gateway, which every device already reaches: conversations, tasks and routines (already there), the rail's pins, sections and hidden bots (already there), read and unread, and the settings switches (theme, Show commands, Show thinking, other apps' chats, the gateway's own bot). The window's layout, an unsent draft and what this one device did stay on the device. A new device looks the same within seconds of connecting (§6).

### What waits for the relay's cryptographic review

**Ships before it:** the account service, signing in, linking a gateway, the device list, confirming and removing devices, the gateway letting a confirmed device in with no approval typed, the settings that follow a person, and reaching the gateway over the same network, a private network or SSH. None of these carries a conversation through the relay.

**Waits for it:** reaching a gateway from anywhere through Clawtrate's relay (a phone on cellular, a gateway in a virtual machine behind its host's network, a laptop away from home), because that is what the review is of. `docs/decisions.md` says nothing builds on the relay protocol until the review has passed, and this design keeps that.

---

## Contents

1. The promise, in a person's words
2. The pieces and who runs them
3. What OpenClaw offers, established first
4. How a signed-in device is let in
5. What the account holds and never holds
6. The same on every device
7. Sign-in
8. First-run flows, counted
9. Hosting and what it costs
10. Threat model
11. Before and after the cryptographic review
12. The order of pull requests, and the Windows half
13. Proposed parity rows
14. Not established, and what would establish it
15. Not covered here

## 1. The promise, in a person's words

These are the sentences the screens and the website may say. Each rests on a section below.

- **Linking.** "Link this gateway to your Clawtrate account. You do this once, on the computer OpenClaw runs on." One click there, then the provider's sign-in. The gateway is linked to one account. Linking changes nothing in how the gateway works for anything already connected to it.
- **Adding a device.** "Sign in on your other computer or phone, then confirm it on a device you already have." The new device shows three words; the person picks them on the other device. From then on the new device reconnects by itself, with nothing to sign in to again until it is removed.
- **Removing a device.** "Remove it from Settings on any of your devices, or from your account page in a browser if you no longer have any." It loses access to the gateway at once, and its saved credentials stop working.
- **Unlinking.** "Unlink on the gateway's computer, or from any of your devices." The devices the account added are removed from the gateway too, unless the person keeps them (§8.5).
- **Without an account.** "You don't need an account to use Clawtrate." Connecting on the same computer, a typed address, SSH and setup codes all work as they do today, and an account is never asked for.
- **When the service is down.** "Your devices keep working with your gateway." Only signing in a new device and the account page need the service.

## 2. The pieces and who runs them

```
your device (Clawtrate)                        the gateway's machine
  sign-in, its own keys            direct          the connector ──────► OpenClaw gateway
  the device list (a copy)  ───────────────────►   the device list          (loopback only)
         │                    later: relay  ┐      its own keys
         │                                  │           │
         └──── account service ◄────────────┼───────────┘
               sign-in, which gateways,     │
               a waiting room for joins     └─► Clawtrate's relay (after the review)
```

| Piece                        | Who runs it                                                                 | What exists in the repository                                                                                                                                                                                                                          | What is missing                                                                                                                                                                                                                          | What it needs from OpenClaw                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account service**          | The project (hosted), or anyone (self-hosted)                               | Nothing. The parity checklist's `not planned:` class describes Clawtrate as running no hosted service; this is the first.                                                                                                                              | All of it: sign-in with GitHub and Google, accounts, linked gateways, the waiting room where a join is confirmed, the account page (§7, §9).                                                                                             | Nothing. It never talks to a gateway.                                                                                                                                             |
| **Connector**                | The person, on the gateway's machine: inside Clawtrate there, or on its own | The relay protocol's connector side (`Responder`, the enrollment gate, the register proof) in `packages/relay-protocol`, imported by nothing. A connector package was drafted in #285 and closed (#254's salvage note keeps its head).                 | Its own pairing with the gateway, the device list, letting devices in and out on the gateway (§4), a direct listener for the same network (§11), and later the relay side. A way to run on Windows and on a server with no screen (§12). | A first pairing with full control on its own computer, `device.pair.list`, `device.pair.approve`, `device.pair.remove`, `device.token.revoke`, and `gateway.trustedProxies` (§3). |
| **Client** (desktop, iOS)    | The person                                                                  | Six-scope pairing, secure storage for credentials on macOS (`SecretBox`, `createSecureCredentials`), tokens kept per gateway address, reading paired devices (`packages/core/src/machines.ts`), the rail's arrangement on the gateway (`users.prefs`). | Signing in, the device list and the join (both sides), Settings → Devices from the device list, a route to the connector's direct listener, the synced settings (§6). Later, core's relay route (drafted in #270, closed).               | Its own pairing hello as today; `users.prefs` for settings.                                                                                                                       |
| **Relay** (after the review) | The project (hosted), or anyone (self-hosted)                               | The protocol: frames, the relay's messages, the register proof and its stores, in `packages/relay-protocol`. A relay service was drafted in #281 and closed.                                                                                           | The service, its hosting, its limits per connector, its privacy page. It waits for the review (§11).                                                                                                                                     | Nothing.                                                                                                                                                                          |

**Proposed:** the connector is part of Clawtrate wherever Clawtrate runs on the gateway's machine, started and stopped with it, so there is nothing more to install there. On a machine without the app (a server, or a Windows gateway inside WSL) it is a small program of its own (§8.4).

## 3. What OpenClaw offers, established first

The account can only do what OpenClaw lets a program on the gateway's machine do. `docs/design/setup-effortless.md` (§2, §3 and §5) established most of this live on OpenClaw 2026.10.6; this section keeps what this design rests on and adds what it found.

**A program on the gateway's own computer can pair with full control and no approval** (established, both versions). A first operator pairing over loopback that presents the gateway's shared token, with no forwarded headers and no browser `Origin`, is approved silently with every scope it asks for, unless `gateway.nodes.pairing.autoApproveLocal` is `false` (default true). Sources: `<openclaw>/docs/gateway/pairing.md`, "Silent local pairing" (2026.10.6 line 229, 2026.11.10 line 291), and `setup-effortless.md` §2 and §3. The first hello must ask for everything: a reconnect that asks for broader scopes "creates a new pending upgrade request" (`<openclaw>/docs/gateway/operator-scopes.md`, 2026.10.6 line 557, 2026.11.10 line 892).

**A paired device can approve another device** (established, both versions; `<openclaw>/docs/gateway/operator-scopes.md`, 2026.10.6 lines 531 and 597 to 610, 2026.11.10 lines 866 and 922 to 945). `device.pair.approve` needs `operator.pairing`, and for each scope the request asks for, that scope or `operator.admin`; a request for `operator.admin` needs admin. A device whose token lacks admin can manage only its own entry. So the connector must hold `operator.pairing` and `operator.admin` to approve anyone else. `device.pair.reject`, `device.pair.remove`, `device.pair.rename`, `device.token.rotate` and `device.token.revoke` exist in both versions (`<openclaw>/docs/gateway/protocol/rpc-devices-nodes-and-approvals.md`).

**A connection forwarded through a local program is treated as remote only when it says so** (established). A loopback socket that carries `Forwarded`, `X-Forwarded-*` or `X-Real-IP` loses its claim to be local and its pairing waits for approval (`<openclaw>/docs/gateway/pairing.md`, "Locality and forwarded headers", both versions), and the gateway answers such a socket only when `gateway.trustedProxies` covers loopback (#286's research, `docs/research/relay-pairing.md` §5 on that branch, live on development gateways). That matters here: every device the connector forwards must reach the gateway as a remote device with its own pairing, never as a local one, or the connector would hand out its own computer's trust.

**A setup code can't carry the approval for Clawtrate** (established, both versions). `device.pair.setupCode` exists (admin), but a request from a client other than OpenClaw's own can stay pending after a code (`<openclaw>/docs/cli/qr.md` line 27, both versions), and "Pairing-mutation scope is never handed off by a setup code" (the same file, 2026.10.6 line 56, 2026.11.10 line 58). So the design doesn't use setup codes for an account device.

**What the gateway listens on** (established). Loopback by default on port 18789; `lan`, `tailnet`, `custom` or `auto` binds need gateway authentication; its own TLS; Tailscale Serve (`<openclaw>/docs/gateway/config-gateway.md`, 2026.10.6 line 145, 2026.11.10 line 146). Changing the bind or TLS restarts the gateway under the default reload mode `hybrid` (`<openclaw>/docs/gateway/config-gateway.md`, 2026.10.6 lines 330 and 359 to 362). **Proposed:** the design changes none of these. The gateway stays on loopback; the connector does the listening (§11).

**What a plugin can do** (established for 2026.11.10, read only). The principal-bound remote ingress a plugin can open is offered "only for bundled plugins and verified official installations" (`<openclaw>/docs/plugins/sdk-gateway-ingress.md`), so a Clawtrate plugin can't be the network entrance. The connector is an ordinary client on loopback instead, which needs nothing installed into the gateway.

**What OpenClaw itself has for remote access** (established, 2026.11.10 only). An experimental, off-by-default Lab, "OpenClaw ID remote access" (`<openclaw>/docs/concepts/experimental-features.md`, "OpenClaw ID remote access"; `<openclaw>/docs/cli/id.md`), keeps owner devices certified by a root key derived from a recovery kit, and a discovery service that "can relay a pending request but cannot admit" (`<openclaw>/docs/gateway/remote.md`). It is not in 2026.10.6 and needs the Lab turned on and its own sign-in. This design does not depend on it and changes nothing it does. A connection that arrives through it keeps OpenClaw's own role rules; Clawtrate's connector never forwards into it.

## 4. How a signed-in device is let in

### 4.1 Who decides

The gateway decides whether a device is paired, as everywhere in Clawtrate. **Proposed:** the party that asks the gateway to approve an account device is the **connector**, on the gateway's machine, using the gateway's own `device.pair.approve` under its own `operator.pairing` and `operator.admin`. It approves a request only for a device that is on that gateway's **device list**, and a device is on the list only when one of the person's own devices signed for it after the person picked the matching words. So the decision is the person's twice over: they linked the connector on their machine, and they confirmed each device on another of their own.

The account service introduces devices to each other and keeps a waiting room for a join. It holds no key that can sign for a device, and the connector believes nothing the service says that would let someone in. The rule throughout: **anything that grants access must be signed by one of the person's devices; anything that only takes access away may come from the service too.**

This deliberately differs from "the account vouches" in the wording of #638: an account that vouches by itself is an account whose operator can let anyone in (§4.6).

### 4.2 Keys (proposed)

| Key                        | Held by                                   | Used for                                                                                                                    |
| -------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Device key (Ed25519)       | each device, in its secure storage        | Signing entries on a device list, signing in to the account service (so a stolen session token alone is useless).           |
| Gateway device identity    | each device, as today (`credentials.bin`) | The device's own OpenClaw pairing. Unchanged.                                                                               |
| Connector key (Ed25519)    | the connector, in secure storage          | Signing the first entry of the list and the gateway's card; later its relay registration key (the protocol's existing key). |
| Connector TLS key          | the connector                             | Its direct listener's certificate, pinned by every device from the card (§11).                                              |
| List key (32 random bytes) | the connector and each device on the list | Encrypting the list's entries and the gateway's card, so the service carries them without reading them.                     |

### 4.3 Linking, on the gateway's machine

1. The person clicks **Link**. Clawtrate there already holds a full pairing (the same-computer flow).
2. The connector starts with a new identity and asks the gateway to pair with all six scopes. On a machine with Clawtrate, the app approves that one request itself with `device.pair.approve`, bound to the request id and the connector's public key it just made, so the connector never reads the gateway's shared token. On a machine without the app, the connector pairs with the shared token over loopback, which OpenClaw approves silently (§3, §8.4).
3. The connector sets `gateway.trustedProxies` to include loopback through the gateway's own config call, recording the earlier value and putting exactly it back when it is unlinked, as #286's design does over a shell; here it is the admin connection, not a shell.
4. The browser signs in to the account. The account service records the link: this gateway's random id, the connector's public key and a sealed card.
5. The connector writes the list's first entry, signed by its key and by the linking app's device key: those two are the list's first members. This happens on the gateway's machine and involves the service only as a mailbox.

The person never sees steps 2, 3 and 5. What they see is §8.2.

### 4.4 Adding a device: the join

The new device **N** is signed in. An existing member **A** is any device on the list, including Clawtrate on the gateway's machine. The service carries every message and can read none of what matters.

1. N makes its device key and asks to join the account's gateway. It first sends only a **commitment**: a hash of its public keys and a random value, so it can't change them later.
2. Each member that is open is told; the first the person uses answers with its own public key, the list's latest entry and a random value of its own.
3. N then sends its public keys and its random value. Both sides compute three words from everything exchanged. Because N committed first and A answered before seeing N's keys, someone in the middle (the service, say) can't choose keys that make the words match: each attempt has about one chance in 8.6 billion (three words from a list of 2,048), and the service limits attempts.
4. N shows its words. A shows three sets of words, one right and two made up, and "None of these match", and the person picks. **The pick is the confirmation**: a person who clicks without looking picks wrong two times in three, and a wrong pick or "None of these match" ends the join. When someone in the middle has changed the keys, none of A's sets is what N shows.
5. A signs a new entry adding N (its device key, its gateway device identity, its name and platform), seals the list key and the gateway's card to N, and sends both through the service. The connector checks the entry's signature against the list it holds and appends it. N checks that the card's keys are the ones the words covered.
6. N connects to the connector (§11), which lets in only devices on the list, and sends its own OpenClaw pairing hello asking for the six. The gateway files a pending request.
7. The connector reads `device.pair.list`, finds the pending request whose device identity is exactly N's entry's, that arrived on N's own forwarded connection, with role `operator` and scopes within the six, and approves it. Anything else, it leaves for the person. N's device token comes from the gateway, straight to N over its own connection.

Steps 6 and 7 use only what exists in both OpenClaw versions. Nothing here changes what the gateway's scopes allow: a device that asked for less gets less.

### 4.5 Removing a device

From Settings → Devices on any member, or the account page in a browser:

1. A member signs a removal entry. The account page, which has no device key, sends an unsigned removal; the connector accepts it because it only takes access away.
2. The connector removes the device's pairing on the gateway (`device.pair.remove`, then `device.token.revoke` for any token left), closes its connections, drops its keys from the listener, writes a new list key and seals it to the members that remain. The device's saved credentials stop working at once.
3. The connector also watches the gateway's own device list. A device removed elsewhere (Clawtrate's Devices pane, OpenClaw's own page or command) is taken off the device list too, so the two never disagree for long.

Removing the device that linked the gateway does not unlink it. Removing the connector is unlinking (§8.5).

### 4.6 The options for confirming a device

| Option                                                  | Clicks on a new device   | What stops the service from admitting                                                                                                                                                           | Recommendation                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pick the words on a device already in** (this design) | sign-in + 1 on the other | The service has no key to sign with, and can't make the words match.                                                                                                                            | **Default.**                                                                                                                                                        |
| Allow on a device already in, without words             | sign-in + 1 on the other | A signature still, but a service that sends its own request at the same moment, named the same, can be approved by mistake. Also, the new device can't check that it reached the right gateway. | Not recommended: the words cost a glance and close both.                                                                                                            |
| A passkey that derives a key the service never sees     | sign-in + Touch ID       | The key comes from the passkey (the WebAuthn PRF extension), never sent.                                                                                                                        | **Later.** Not established: support for that extension in Electron on Windows and Linux, and in cross-device passkeys; it also adds a sign-in the person must keep. |
| The account vouches by itself (a sign-in is enough)     | sign-in only             | Nothing. Whoever runs or takes over the service, or holds the person's Google or GitHub session, can add a device and get a gateway token.                                                      | **Not offered.** It is the one way to make sign-in alone enough, and it moves the gateway's trust to the service.                                                   |

A device on a person's list is the fallback for every other: with no other device left, Clawtrate on the gateway's machine is always on the list and can confirm. A server with no screen shows the words in the connector's own output (§8.4).

## 5. What the account holds and never holds

**Never:** conversations, transcripts, files, tasks, routines, memory, gateway tokens (shared or device), provider credentials or keys, the list key, the content of the gateway's card (its addresses, its name, its certificate), any device's private key.

**Holds** (proposed):

| What                                                                                                                                                | Why                                       | Kept                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| An account id (random), the sign-ins linked to it: provider, the provider's id for the person, a display name and picture address the provider gave | to sign in and show who is signed in      | until the account is deleted             |
| Each linked gateway: a random id, the connector's public key, the sealed list and card                                                              | to introduce devices to it                | until unlinked                           |
| Each device: its device public key, platform, when it was added, the day it was last seen                                                           | the account page, and removing a device   | until removed; last seen to the day only |
| A join in the waiting room: the sealed messages of §4.4                                                                                             | to carry the join                         | until it ends, at most 10 minutes        |
| Sign-in events: time, provider, the address seen                                                                                                    | abuse limits and the person's own history | 30 days                                  |
| Counts per minute per account and address                                                                                                           | rate limits                               | 1 hour                                   |

**What the service necessarily sees:** who signs in, when, from which address; how many devices and gateways each account has; when a device joins or is removed; the sizes and times of what it carries. It does not see the gateway's address or name, which devices talk to the gateway, or when.

**What a person can delete:** any device (§4.5); a linked gateway (unlinking); a sign-in method, while another remains; the whole account, from the account page, which removes every row at once and asks every linked connector to remove the devices it added. Backups held by the hosting provider expire with its restore window, at most 30 days (not established: the exact window of the chosen plan, §14).

**The relay, later,** sees what #286's design lists in its §3: the addresses of both ends, when each connects, sizes and timing, and a random id for the connector. It keeps none of what is said.

## 6. The same on every device

Direction for the first version: a person signs in on any device and finds their gateway the way they left it. Conversations, tasks, routines, bots, memory, skills and files already live on the gateway, so the account's job there is only that every device reaches the same gateway. The rest is the app's own state about the person, surveyed here from the code.

| What                                                                                                       | Where it lives today                                                                                              | Proposed                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Conversations, tasks, routines, bots, memory, files                                                        | the gateway                                                                                                       | unchanged                                                                                                                        |
| Rail: pinned bots, sections, hidden bots, manual order                                                     | the gateway, `users.prefs` key `clawtrate.sidebar` (`packages/core/src/sidebar.ts`); per device without a profile | unchanged                                                                                                                        |
| Usage budgets                                                                                              | the gateway, `users.prefs` `clawtrate.budgets`                                                                    | unchanged                                                                                                                        |
| A bot's account kind and intended account                                                                  | the gateway, `users.prefs` `clawtrate.account-kind.*`, `clawtrate.bot-account.*`                                  | unchanged                                                                                                                        |
| Read and unread                                                                                            | the gateway's unread marker, plus what this viewer read, in local storage (`packages/ui/src/unread.ts`)           | **follows:** the gateway's marker becomes the truth, set when a task is read; every full pairing can write it                    |
| Theme, bubbles, motion                                                                                     | this device, local storage (`packages/ui/src/preferences.ts`)                                                     | **follows:** gateway                                                                                                             |
| Show commands, Show thinking                                                                               | this device, local storage                                                                                        | **follows:** gateway                                                                                                             |
| Other apps' chats, other tools' sessions, the gateway's own bot                                            | this device, host storage (`show-channel-chats`, `show-other-tool-sessions`, `show-gateway-bot`)                  | **follows:** gateway                                                                                                             |
| A run's time limit                                                                                         | this device, host storage (`turn-limit-minutes`)                                                                  | **follows:** gateway                                                                                                             |
| The gateway's name on this device                                                                          | this device, host storage (`gateway-names`)                                                                       | **follows:** gateway, as the person's name for it                                                                                |
| Bot names declined ("Not now")                                                                             | this device, host storage (`clawtrate.bot-name-declines`)                                                         | **follows:** gateway, so a card dismissed on one device doesn't come back on another                                             |
| The guides' "New bots too" answer                                                                          | this device, host storage (`clawtrate.guides.<gateway id>`)                                                       | **follows:** gateway; the list of bots this device added stays the device's, because "removed outside Clawtrate" is judged by it |
| Selected bot, open panel, Work tab, folded steps, a workspace's sort, the computer's live and note toggles | this device, local storage                                                                                        | stays: they are the window's, and two windows differ                                                                             |
| Unsent drafts                                                                                              | this device, local storage (`clawtrate.draft.*`)                                                                  | stays in the first version: a draft is the person's words, and moving it means writing it to the gateway as they type            |
| OpenClaw updates this device started and followed                                                          | this device, host storage (`clawtrate.openclaw-update`, `clawtrate.openclaw-updated`)                             | stays: F-590 rests on "this device's own press"                                                                                  |
| The answer to the full-control offer                                                                       | this device, host storage                                                                                         | stays: it is about this device's pairing                                                                                         |
| Clawtrate's own update track (Beta or Stable)                                                              | this device                                                                                                       | stays: it is about this installation                                                                                             |
| Credentials, device keys, tokens                                                                           | this device, secure storage                                                                                       | stays, always                                                                                                                    |

**Where what follows is kept: on the gateway** (recommended). It is the one store every device already reaches, it is the person's own, and Clawtrate already writes there: `users.prefs` holds up to 4,096 bytes of JSON per key, read with `operator.read` and written with `operator.write` as a compare-and-set, with a `users.prefs.changed` event (`packages/core/src/sidebar.ts`, OpenClaw 2026.10.6). One new key, `clawtrate.settings`, holds every switch above, versioned and bounded like the sidebar's. A device without write access reads it and keeps its own changes locally.

The other way, encrypted on the account service with the list key, would make the settings follow a person across several gateways and keep them while a gateway is off. It costs a second store, its conflicts, and something on the service that only encryption keeps unreadable. Not recommended for the first version; it can come later for the few settings that are about the person and not the gateway (theme).

**A brand-new device, the moment after sign-in:** once the join ends and the gateway approves it (seconds), it connects and reads, as any connection does now, the bots, the task list, the rail's arrangement and `clawtrate.settings`. It is the same as the person's other devices from its first screen, with each conversation loading when opened. What it doesn't have: drafts and the window's layout, which start fresh.

Not established: that two devices of one person paired with device tokens land on the same OpenClaw user profile for `users.prefs`. `sidebar.ts` relies on it ("every device of the same user sees it"); a check against a development gateway with two paired devices would show it (§14).

## 7. Sign-in

### 7.1 The first version: GitHub and Google

**Shape (proposed).** The account service is the only OAuth client registered with each provider: one GitHub OAuth app and one Google web client, with their redirect addresses on the service's own domain and their secrets on the service. A Clawtrate app signs in to the account service, not to the provider: it opens the system browser at the account service with a one-time PKCE challenge (a hash of a secret the app keeps), the service sends the person to the provider and back, and then returns to the app with a one-time code that only the app's secret redeems.

- **Desktop** (macOS, Windows, Linux): the return is `http://127.0.0.1:<port>/callback` on a port the app opened for that sign-in alone; the system browser, never a window inside the app. This works the same on all three systems.
- **iPhone**: `ASWebAuthenticationSession`, which returns to the app that started it.
- **The session** the service then issues is bound to the device key: each request is signed by it, so a copied session token is useless elsewhere. The protocol package's register proof is the same kind of signed request.
- **What is asked of the provider**: only who the person is. GitHub: no scopes (the public profile). Google: `openid` and `profile`. No repository access, no email reading, nothing else.

| Provider | Registration                                                                                                   | The account's key for the person                           | Notes                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub   | One OAuth app (free). Its web flow needs the client secret, so the exchange happens on the service.            | the numeric user id, never the login, which can be renamed | PKCE (S256) and loopback addresses with any port are supported ([GitHub's docs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)). |
| Google   | One OAuth client of the web type (free); the consent screen's brand verified for the logo; no sensitive scopes | the ID token's `sub`, never the email                      | Desktop clients can't keep a secret ([Google's docs](https://developers.google.com/identity/protocols/oauth2/native-app)); the web client on the service avoids that.    |

**The same person with both.** Each sign-in is its own account until linked. Settings → Account → "Also sign in with Google" (while signed in with GitHub, or the reverse) adds the second to the same account. Accounts are never joined by a matching email: an email can change hands or be unverified, and joining by it would let someone who controls one sign-in take over the other's account. A person who signs in with the other provider by mistake sees "No gateway on this account" and the other provider's button beside it.

**More providers.** Sign-ins are rows of (provider, the provider's id for the person) pointing at an account. Another OpenID Connect provider is one registration and one small module.

### 7.2 Later: signing in with ChatGPT

OpenAI documents [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart) (OpenID Connect with PKCE, a client id from OpenAI). Its quickstart says identity sign-in is "currently available to selected commercial partners through a limited trial", and that what is open to open-source projects is using a ChatGPT plan for AI requests (read 2026-11-25). The second isn't the account's business: model access stays on the gateway. So a third sign-in waits until OpenAI lets Clawtrate register a client for identity; it then fits §7.1 unchanged.

### 7.3 Other options, for the record

| Option             | Cost to build and run                                                              | On Windows and Linux                                                          | Why not first                                                     |
| ------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Sign in with Apple | an Apple developer account (already needed for signing), a service key             | works in a browser, less familiar off Apple's systems                         | not chosen for the first version                                  |
| An email link      | an email-sending service (free tiers are small), deliverability and abuse handling | same everywhere                                                               | the most upkeep; a mailbox becomes the key                        |
| Passkeys           | a WebAuthn server on the service; no provider                                      | Windows Hello, and phones for cross-device; not established in Electron (§14) | worth adding later as the way to drop the confirming click (§4.6) |

## 8. First-run flows, counted

Clicks count presses in Clawtrate and in the account page; "typed" counts what goes into Clawtrate. Signing in at Google or GitHub, when the browser isn't already, is the provider's and is counted apart.

### 8.1 The same computer, no account

Unchanged and not made worse: "This computer" → **Connect**: 1 click, nothing typed, no approval (#629). Nothing in this flow mentions an account. After it, Settings → Gateway offers "Use this gateway from your other devices" quietly, once.

### 8.2 Another computer: a gateway on Windows, Clawtrate on a Mac

| Where                                | Steps                                                                                                  | Clicks | Typed |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------ | ----- |
| Gateway's machine, once              | This computer → Connect; Link with Google; Continue with Google; the provider's consent the first time | 3 to 4 | 0     |
| The Mac                              | Sign in; Continue with Google                                                                          | 2      | 0     |
| Gateway's machine (or any device in) | pick the Mac's words                                                                                   | 1      | 0     |

Before the review, the Mac reaches the gateway when the two are on the same network or the same private network, through the connector's direct listener (§11). A gateway in a Windows virtual machine is a common case: if that machine sits behind its host's own network address translation, nothing on the home network can reach it until the relay ships, and the Mac says so plainly ("Your gateway's computer isn't reachable from here yet") rather than failing. A virtual machine on a bridged network works before.

The first screen on the Mac gains a third answer to "Where does OpenClaw run?": "I use Clawtrate on another device: Sign in". F-001's "no account to sign in to" stays true: nothing requires it.

### 8.3 A phone (#14, #286)

Sign in (1), Continue with Google (1, and the system's "wants to use google.com to sign in" prompt, 1), pick the words on a device already in (1). Nothing typed. Before the review it reaches the gateway only on the same network or a private network; with the relay, anywhere. The setup code of #14 and the relay code of #286 stay for someone with no account, and #286's design becomes the account-less path rather than the only one: its "Approve from here" is what a member does in §4.4, and its "Remote access" row in Settings is this design's linked gateway.

### 8.4 A gateway on a server with no screen

One command on the server, which installs the connector as a service of the person's own account (a user service on Linux) and prints a sign-in address and code; the person opens it on any device and signs in there (the provider's device sign-in shape, RFC 8628, offered by the account service). The words for each device the person adds show in the connector's output and on that device, and the person confirms on the device instead, which is already signed in. Typed: the one command. This is the only flow with a terminal, because there is nowhere else to click.

### 8.5 Unlinking, and a gateway linked to the wrong account

Settings → Gateway → "Linked to <account>" → **Unlink** (on the gateway's machine or any member): one click and a confirmation, which lists the devices the account added and offers "Also remove these devices from the gateway" ticked. The connector puts `gateway.trustedProxies` back as it found it, forgets its keys and removes its own pairing last.

## 9. Hosting and what it costs

### 9.1 Direction and recommendation

Direction: the default path costs nothing to run. A hosted relay is for when the project grows.

**Recommended first version:** the account service on Cloudflare's free plan, in the project's own account; no relay. Devices carry their conversations to the gateway over routes the person already has. The one hosted thing is small: sign-ins, linked gateways, device rows and a waiting room.

### 9.2 What runs for $0, and what breaks first

Cloudflare's limits as published on 2026-11-25 ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)):

| Free plan        | Limit                                                       | Used by                           |
| ---------------- | ----------------------------------------------------------- | --------------------------------- |
| Workers requests | 100,000 a day, 10 ms of CPU each                            | every call to the service         |
| D1 (database)    | 5 million rows read and 100,000 written a day, 5 GB         | accounts, gateways, devices       |
| Durable Objects  | 100,000 requests and 13,000 GB-s a day; SQLite storage only | the waiting room, later the relay |
| Outgoing traffic | not charged                                                 | —                                 |

Over a free limit, further calls of that kind fail until 00:00 UTC.

**The account service.** Assumed per device in daily use: about ten requests a day (refreshing the session, opening the waiting room's socket a few times, reading the account). Joins are rare. So the free plan's 100,000 requests fit about **10,000 devices in daily use**; requests run out first, long before the database. Assumptions to measure once built.

**The relay, after the review.** A connected device's traffic is the gateway's events: a run streams hundreds to thousands of them. Assumed: about 25,000 messages a day for a device in daily use, nearly all from the connector. Durable Objects bill incoming WebSocket messages at 20 to a request and nothing for outgoing ones, and charge no time while a socket hibernates between messages. That is about 1,300 requests a day per device, so the free plan fits about **75 devices in daily use**; at an assumed 2 ms of work per message, time (about 6 GB-s a day per device) runs out much later. Requests run out first here too. The live view of a bot's computer adds far more messages than text and would lower that.

**The person's own machine as the relay.** The connector already runs there, but a machine behind a home router can't be reached from outside without something outside: a port opened on the router (often off, and a risk), or a meeting point that helps the two ends reach each other directly (which the account service could be, cheaply) with a relay still needed when either end is behind carrier-grade address translation, as phones on cellular often are. Not in the first version; worth measuring later as the way to keep most relayed traffic off the project's bill.

**The person's own private network.** Where the gateway's machine is on a Tailscale network or the like, the connector listens there too and the card carries that address, so a device on the same network reaches the gateway from anywhere, for $0 to the project. Clawtrate never sets that network up.

### 9.3 Where it stops being free, and after

| Devices in daily use | Account service            | Relay (after the review)       |
| -------------------- | -------------------------- | ------------------------------ |
| 100                  | $0                         | $0 to $5 a month               |
| 10,000               | $0 to $5 a month           | about $90 a month              |
| 1,000,000            | about $100 to $150 a month | about $8,000 to $9,000 a month |

From Cloudflare's paid plan: $5 a month for 10 million Worker requests ($0.30 a million after), 1 million Durable Object requests ($0.15 a million after) and 400,000 GB-s ($12.50 a million after); D1's writes beyond 50 million a month at $1 a million. Every number in this table rests on the assumptions above and is an order of magnitude, not a quote. What drives cost is relayed traffic, and within it, the computer's live view.

### 9.4 What the first version accepts

- **Limits.** Past about 10,000 devices in daily use, the service stops for the rest of each day once its free requests are spent. The $5 plan is the fix.
- **Dependence on one free plan.** If Cloudflare changes it, the service moves to the paid plan or to the self-hosted runner on a small server. Nothing about the person's data moves, because the service holds almost none, and the lists live on the devices and the connector.
- **No reach from anywhere** until the relay, which also waits for the review. When it comes, the free plan carries a small number of people; a share per connector per day keeps one heavy user from spending everyone's, and the paid plan follows use.

### 9.5 Self-hosting

The service is open source, and the same code runs as one Node process with SQLite, as #281's relay draft had a Node runner. Hosting it takes a machine with a public HTTPS address, a GitHub OAuth app and a Google OAuth client registered to that address (free, a few minutes each in their consoles), and the address set once in Clawtrate's Settings → Advanced → Account service. A self-hosted service is its own set of accounts. The relay, later, is the same.

### 9.6 When the hosted service is down

Everything that is connected or can connect keeps working: a gateway on the same computer, a typed address, SSH, and an account device over the connector's direct listener, because a device keeps its card and its gateway token, and the connector keeps its list. Nothing on a connection asks the service. Removing a device still works from Settings while connected to the gateway, because the connector also follows the gateway's own device list (§4.5). What stops: signing in a new device, joining, and the account page. After the relay ships, relayed connections stop while the relay is down; direct ones don't.

## 10. Threat model

| Case                                                                     | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | What the person does                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A stolen sign-in** (someone has the person's Google or GitHub session) | They can sign in to the account and see how many gateways and devices it has. They can ask to join; every member shows a request the person didn't make, and without the words picked on one of the person's devices it goes nowhere. They can remove devices through the account page, which takes access away and grants none.                                                                                                                                                                                                                                                                              | Deny the request ("I didn't do this"), which also tells the person to secure the provider account; add back a removed device with one pick.              |
| **A stolen device**                                                      | It is a member until removed: it has its own pairing and token, as any device does today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Remove it from another device or the account page; the gateway drops it at once (§4.5).                                                                  |
| **A lost device**                                                        | The same as stolen, as far as the gateway knows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Remove it. If it turns up, add it again.                                                                                                                 |
| **The account service compromised**                                      | It can read what §5 says it holds, refuse service, and remove devices. It can't add a device: the connector accepts only entries signed by a member. It can't read a conversation: none passes through it, and the card is sealed. It can't get a gateway token: tokens go from the gateway to the device over the device's own connection. It can lie about keys and addresses to a joining device; the words don't match, and the join ends. It can't push code: the apps are signed and update from their own feed.                                                                                        | Nothing for access. The project rotates the service's provider secrets and tells people.                                                                 |
| **The relay compromised** (after the review)                             | It sees metadata, and can drop or delay traffic. It can't read or change what it carries (Noise, with the connector's key pinned from the card), and can't let anyone in (the connector's list).                                                                                                                                                                                                                                                                                                                                                                                                              | Nothing for access; direct routes keep working.                                                                                                          |
| **A hostile network**                                                    | The service is HTTPS. The direct listener is TLS 1.3 with the connector's certificate pinned from the card, and it lets in only members. Later, the relay channel is end to end.                                                                                                                                                                                                                                                                                                                                                                                                                              | Nothing.                                                                                                                                                 |
| **A bot on the gateway trying to add a device or link an account**       | A bot that can run commands as the person on the gateway's machine can already approve any device with OpenClaw's own command and read the gateway's token; the account gives it no power it lacks. What the design adds against it: link and confirm happen only on Clawtrate's own screens, never by a command, on a machine with the app; the connector's key is in the system's secure storage; every member is told when a device joins or the gateway is linked or unlinked; and OpenClaw's Devices list names every device the connector approved. A bot without command access can't reach any of it. | Keep commands behind approval (the controls design). Remove an unexpected device; unlink and link again if the gateway was linked to an unknown account. |
| **Two people linked to one gateway**                                     | Not possible: a connector is linked to one account, and a second link is refused until the first is unlinked on the gateway's machine. A second person can still be let in the ways that exist today (a setup code, an approval), outside the account.                                                                                                                                                                                                                                                                                                                                                        | Link once; share by the existing ways.                                                                                                                   |
| **A gateway linked to the wrong account**                                | The link screen shows the account's name and picture before the person confirms, and every member of the wrong account is told. Devices of the wrong account join only if one of its members confirms them.                                                                                                                                                                                                                                                                                                                                                                                                   | Unlink (§8.5), which removes that account's devices, and link again.                                                                                     |
| **A person who picks the wrong words**                                   | The join ends; nothing is added. After three ended joins in an hour, the account's joins pause for an hour.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Start again on the new device.                                                                                                                           |

What stays a risk, said plainly: anyone with the person's unlocked device, or with command access as the person on the gateway's machine, has what that device or account has today. The account doesn't change that boundary and doesn't claim to.

## 11. Before and after the cryptographic review

**The direct listener, before the review (proposed).** The connector listens on the gateway machine's local network and private-network addresses (never on a public address) with TLS 1.3, using Node's own TLS with a self-signed certificate whose key is pinned in the card. Each device presents its device key in the TLS handshake as a client certificate, and the connector lets in only members. For each, it opens its own loopback socket to the gateway with `X-Forwarded-For`, so the gateway sees a remote device with its own pairing (§3). This is a standard construction, not the relay protocol, so it doesn't wait for that review; it is new security-relevant code, and the security review of this design (below) covers it.

On Windows, a program that listens on the local network brings up the system's firewall prompt the first time (not established on the installer's path; §12).

| Ships before the review                                                                                                                                                        | Waits for it                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| The account service; sign-in with GitHub and Google; linking; the device list; joining and removing; the connector approving on the gateway; the settings that follow a person | The relay service and its hosting                                                                   |
| The connector's direct listener on the same network and a private network                                                                                                      | The connector's relay side                                                                          |
| A phone and a computer joining and connecting on the same or a private network                                                                                                 | Core's relay route; reaching a gateway from anywhere; a gateway behind a host's address translation |
| #286's account-less phone path, unchanged                                                                                                                                      | Any public sentence about what the relay can't read                                                 |

An interim option, not recommended: carrying the direct listener's TLS through a plain relay that only passes bytes, so a gateway in a virtual machine behind its host works before the review. It would be a second channel to build, review and keep beside the Noise one, for the months until the review; finishing the review is the shorter path.

**For the security review of this design**, beyond the relay protocol's: the join (commit, reveal, words, the chance of a match by grinding, how the waiting room limits attempts), the list (signatures, order, removal, the list key's rotation), the connector's matching of a pending request to an entry, the direct listener's pinning and client certificates, and the session signed by the device key.

## 12. The order of pull requests, and the Windows half

Each is small enough to review alone. "Design" means a document; "after the review" means after the relay protocol's.

| #   | Pull request                                                                                                                                                                                                | Needs first | Kind                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------- |
| A1  | This design.                                                                                                                                                                                                | —           | design               |
| A2  | Approving a pending device from inside Clawtrate (`device.pair.approve` and `reject`, the prompt naming the device and its scopes), as `setup-effortless.md` §5 designs it.                                 | #629        | client               |
| A3  | The settings that follow a person: `clawtrate.settings` in `users.prefs`, read and unread from the gateway's marker (§6).                                                                                   | —           | client               |
| A4  | `packages/account-protocol`: device keys, the list, the join's messages and words, the sealed card; no I/O; test vectors and seeded fuzzing, as `relay-protocol` has.                                       | A1          | protocol             |
| A5  | `services/accounts`: sign-in with GitHub and Google, accounts, sign-ins, linked gateways, devices, the waiting room; a Cloudflare Worker and a Node runner with SQLite for self-hosting and tests.          | A4          | service              |
| A6  | Desktop sign-in: the system browser, the loopback return, the device-key session, Settings → Account.                                                                                                       | A5          | client               |
| A7  | `packages/connector` (redo of #285 without the relay): its own pairing, `trustedProxies` through the admin connection with the earlier value kept, the list, approving and removing on the gateway, status. | A2, A4      | connector            |
| A8  | Desktop: Link this gateway, the connector started with the app, the join's two screens, Settings → Devices from the list.                                                                                   | A6, A7      | client               |
| A9  | The connector's direct listener and core's route to it, with the card's addresses and pin.                                                                                                                  | A7, A8      | connector and client |
| A10 | The connector on its own for a server: the one command, the user service, the device sign-in.                                                                                                               | A9          | connector            |
| A11 | iPhone: sign-in, the join, the direct route.                                                                                                                                                                | A8, A9      | iOS                  |
| A12 | The hosting decision, privacy page and limits for the account service.                                                                                                                                      | A5          | design and site      |
| R2  | The relay service (redo of #281), with a share per connector.                                                                                                                                               | the review  | after the review     |
| R3  | The connector's relay side, the list's Noise keys enrolled from the list instead of a code.                                                                                                                 | R2, A7      | after the review     |
| R4  | Core's relay route (redo of #270), desktop and iPhone.                                                                                                                                                      | R3          | after the review     |

A2 and A3 help on their own and can start at once. A4 to A12 ship before the review.

### The Windows half

Written to be handed over as it stands; Windows work in this repository belongs to its own contributor.

1. **Secure storage on Windows.** Electron's `safeStorage` uses DPAPI there. Without it the app has no full access, so it can hold neither `operator.admin` nor `operator.pairing`, and can neither link nor confirm. First, and needed by #629 too.
2. **Connecting on the same Windows computer.** Reading OpenClaw's settings on Windows (`%USERPROFILE%\.openclaw\openclaw.json` for a native install) without running OpenClaw's programs, and a send gate that proves the other end of the loopback socket is this account's gateway (the owning process from the TCP table, its user, its image, the profile's lock naming it), the counterpart of `apps/desktop/src/setup/local-prove.ts` (Windows has none yet, as the header of `settings-reader.ts` says). A gateway inside WSL (OpenClaw's Windows app keeps one of its own, `<openclaw>/docs/platforms/windows.md` in 2026.11.10) answers loopback through WSL's own relay, so this proof can't name it, and it needs its own design; until then the connector for such a gateway runs inside WSL as on a server (§8.4).
3. **The connector's lifetime on Windows.** Running while Clawtrate runs, and an option to start at sign-in to Windows (a per-user Scheduled Task or the Run key) so devices reach the gateway when the app is closed. No service, no administrator rights.
4. **The firewall.** The direct listener on the local network: whether the installer adds a rule for the connector (it already runs with the rights to) or the system prompts on first listen, and what the person sees either way. Not established (§14).
5. **The sign-in return.** The system browser opening and returning to `http://127.0.0.1:<port>/callback` on Windows, through the default browser, with the loopback port chosen by the app.
6. **Checks.** The join and the connector's approval against a development gateway on Windows, as the macOS checks will run them.

## 13. Proposed parity rows

Seven rows, F-594 to F-600, in `main`'s format. Proposed here only; `docs/parity.md` is not changed by this pull request.

| id    | area     | platform | behavior                                                                                                    | target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | gateway dependency                                                                                                                                                                                                                             | status |
| ----- | -------- | -------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F-594 | Accounts | both     | A person can sign in to a Clawtrate account with GitHub or Google.                                          | better: Sign in opens the system browser at the account service (a window inside the app never), returns on a loopback address on the desktop and through the system's web sign-in on iPhone, and redeems a one-time code only with the app's own PKCE secret; the session is signed by this device's key; the provider is asked only who the person is; an account is never joined to another by a matching email. Check: a stand-in provider and service, a replayed code, a code redeemed without the secret, and a copied session refused.                                                       | client only: the account service is Clawtrate's; nothing is asked of the gateway.                                                                                                                                                              | todo   |
| F-595 | Accounts | desktop  | On the gateway's computer, one click links the gateway to the account, with nothing typed.                  | better: Link on a computer where Clawtrate holds a full pairing starts the connector, approves the connector's own pairing request (exactly its request id and key) with `device.pair.approve`, sets `gateway.trustedProxies` to include loopback through the admin connection with the earlier value recorded, and writes the device list's first entry there; Unlink restores that value exactly, removes the connector's pairing and, when ticked, the devices the account added. No Terminal step.                                                                                               | available: `device.pair.approve`, `device.pair.remove` and the config call exist in OpenClaw 2026.10.6 and 2026.11.10 (`operator-scopes.md`, `rpc-devices-nodes-and-approvals.md`); `trustedProxies` set and restored live in #286's research. | todo   |
| F-596 | Accounts | both     | A new device that signs in is let into the gateway after the person picks its words on a device already in. | better: the new device commits to its keys before it sees the member's; both show words computed from the whole exchange; the member offers three sets and only the right pick signs the entry; the connector then approves only the pending request whose device identity is the entry's, that arrived on that device's own connection, for role operator within the six; nothing is typed and no approval command is shown. Check: against a development gateway, a join that connects and holds the six, and a wrong pick, a changed key and a request from another device that are each refused. | available: `device.pair.list` and `device.pair.approve` with `operator.pairing` and `operator.admin` (both versions); a forwarded connection pairs as remote (#286's research §5).                                                             | todo   |
| F-597 | Accounts | both     | Removing a device from any of the person's devices, or the account page, takes it out of the gateway.       | better: a removal signed by a member, or an unsigned one from the account page, makes the connector remove the pairing (`device.pair.remove`), revoke any token left, close its connections and rotate the list key; a device removed on the gateway by any other means leaves the list too. Check: the removed device's saved token is refused at its next hello.                                                                                                                                                                                                                                   | available: `device.pair.remove`, `device.token.revoke` (both versions).                                                                                                                                                                        | todo   |
| F-598 | Accounts | desktop  | The account service can't let a device in by itself.                                                        | better: with a hostile stand-in for the account service, the connector refuses an unsigned entry, an entry signed by a removed member, an entry replayed or out of order, and a join whose keys were swapped in the middle (the words differ); none reaches `device.pair.approve`, and no gateway token or conversation passes through the stand-in.                                                                                                                                                                                                                                                 | client only: the connector's own checks; the gateway is only seen not to be asked.                                                                                                                                                             | todo   |
| F-599 | Accounts | both     | A device that joins shows the person's gateway as their other devices do.                                   | better: after a join, without a step, the new device shows the same bots, tasks, rail arrangement, read and unread, and the settings kept in `clawtrate.settings` (theme, Show commands, Show thinking, other apps' chats, other tools' sessions, the gateway's own bot, the run limit, the gateway's name, declined names, "New bots too"); a change on one device reaches the other with `users.prefs.changed`; drafts and the window's layout stay per device.                                                                                                                                    | available: `users.prefs.get`, `users.prefs.set` with a compare-and-set, `users.prefs.changed` (OpenClaw 2026.10.6, used by the rail today). Unverified: two device-token pairings sharing one user profile.                                    | todo   |
| F-600 | Accounts | both     | Without an account, or with the service down, nothing that works today stops working.                       | better: a person who never signs in sees the account only as one quiet offer after connecting and as the first screen's third answer; with the account service unreachable, a gateway on the same computer, a typed address, SSH and an account device over the direct listener connect as before, and removing a device from Settings still reaches the gateway.                                                                                                                                                                                                                                    | client only.                                                                                                                                                                                                                                   | todo   |

F-001's target ("no account to sign in to") stays as it is and stays true. F-506, F-507 and F-509 are unchanged: the code paths remain for people without an account.

## 14. Not established, and what would establish it

| Point                                                                                                   | What would establish it                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two device-token pairings of one person share one OpenClaw user profile for `users.prefs`.              | A check on a development gateway with two paired devices writing and reading `clawtrate.settings`.                                                     |
| The connector can tell which pending request arrived on a given forwarded connection.                   | A probe on a development gateway: two forwarded connections, two pending requests, and what `device.pair.list` and the hello's refusal say about each. |
| The gateway restarts by itself, not at all, or not cleanly when `trustedProxies` changes on 2026.11.10. | #286's research showed no restart on its development gateways; a probe on 2026.11.10 would show it there.                                              |
| Windows firewall behaviour for the direct listener, with and without an installer rule.                 | A run of the installer and the connector on a clean Windows machine in the contributor's session.                                                      |
| How often two ends behind home routers can reach each other with only a meeting point.                  | A measurement once the relay exists, across home networks and cellular.                                                                                |
| The traffic of a device in daily use, and of the computer's live view.                                  | Counting frames on a development gateway's scenarios, and later the relay's own counts per minute.                                                     |
| Passkey PRF support in Electron on Windows and Linux, and with phones as cross-device keys.             | A spike on each system.                                                                                                                                |
| The restore window of the hosting plan's database backups.                                              | The provider's documentation for the plan chosen in A12.                                                                                               |
| Whether OpenAI opens Sign in with ChatGPT's identity flow to open-source apps.                          | OpenAI's quickstart, read again before §7.2 is built.                                                                                                  |

## 15. Not covered here

The account page's own layout and copy, the relay's privacy page (#286's R8), the connector's packaging for each system, sharing one gateway between several people, and anything a gateway with OpenClaw's own remote access Lab turned on would add.
