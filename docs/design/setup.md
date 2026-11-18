# Setting up

How a new person gets from a first launch to a connected, read-only Clawtrate: one question, "Where does OpenClaw run?", then Clawtrate looks there and says what it found. It replaces the address-and-token form as the first screen and keeps that form under "Advanced". This is the fourth part of the design, after `visual-language.md`, `conversation.md`, `bots.md` and `work-pane.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-491 to F-513, with F-001, F-003 and F-009, and the rows this document adds at the end (section 18). What the gateway, OpenClaw's installer and `ssh` do is in `docs/research/setup-flow.md`; every state below names the fact it rests on, and section 17 lists them. Section 19 is for builders.

The yardstick is one person's daily case: OpenClaw on a development box, the desktop app on a laptop, "Another computer", the SSH name of the box, and it works. No Tailscale step, no token typed, no command run by hand on the box. Everything below is measured against that and against a person who has never run OpenClaw.

Three facts from the research shape the whole design:

- **A first pairing on the gateway's own computer, or through an SSH forward to it, is approved by the gateway without a prompt**, and ends with `operator.read` alone (research §1).
- **Clawtrate never reads the gateway's shared token.** OpenClaw refuses to print it to a program, on purpose. Instead the host makes a one-time setup code on the gateway's computer and redeems it at once; the code lives ten minutes, works once, and never contains the shared token (research §1, §3).
- **Asking for more than read access always waits for approval on the gateway**, even on its own computer (research §2). Where Clawtrate can run programs there, it offers to run the gateway's own approve command, after the person confirms.

The prototype shows every state: `prototype/setup.html`, with the state in the address (`prototype/README.md`). The styles are in `prototype/css/setup.css`, the behaviour in `prototype/js/setup.js`, and `prototype/tools/checks/setup.mjs` checks the words and structure of every state.

## Contents

1. How the pieces fit
2. Shared rules: safety, routes, components, input
3. The first screen
4. Looking on this computer
5. Another computer: the field and the look over SSH
6. What the look found
7. Connecting, with nothing typed
8. The forward's life
9. Approve from here
10. Setting OpenClaw up
11. Removing OpenClaw, or leaving it
12. Connect a phone
13. A setup code on the desktop, and the iPhone's first screen
14. Private access with Tailscale
15. Several routes to one gateway
16. Widths, themes, keyboard, screen readers, motion
17. What each fact drives
18. Parity rows to reword, and rows added
19. For builders
20. Not covered here

## 1. How the pieces fit

```
first launch (desktop)            "Where does OpenClaw run?"
  This computer                     look here: find OpenClaw, ask its gateway
  Another computer                  one field: an SSH host or alias, then look there over SSH
    host key not known yet            the fingerprint, "Trust and connect" or Back
  Have a setup code?                paste a code made on the gateway's computer
  Advanced                          the address-and-token form, as it was
what the look found               one screen, one primary action
  running                           Connect: a one-time code, made and used by the host
  installed, not running            Start OpenClaw (confirmed first)
  not there                         Set up OpenClaw here (what, where, from where; confirmed first)
connecting                        steps, then the app opens read-only
the app                           the status strip says when a forward is being restored
  access bar (bots.md §2)           "Approve from here" where Clawtrate can run programs on the gateway's computer
  Settings, Gateway                 how it is reached, Connect a phone, Private access with Tailscale, Remove
first launch (iPhone)             Scan a setup code, or Paste a setup code; Advanced
```

The first screen keeps what the old one had: the product's mark, the name, the slogan, the row of bots along the foot (`visual-language.md` §10). Only the form below the slogan changes.

## 2. Shared rules

### Safety, as rules

These are written so that a builder cannot read them two ways. Each screen below obeys all of them, and section 19 says how.

1. **The interface gains no power.** It sends the host one of a fixed list of setup commands (section 19), each with plain data. The host turns each into fixed programs with argument arrays. No program is ever given a shell string built from anything typed, read from a file, received from a gateway or decoded from a code.
2. **Every variable argument is validated before use** against the patterns in section 19: an SSH destination, a port, a request id, a fingerprint. Anything else is refused before any program starts, with "That isn't an SSH host or alias Clawtrate can use."
3. **`ssh` passes a command line to the other computer's shell.** So over SSH the host sends only a script that is a constant of the app, the same for every computer, followed by values that matched rule 2, each single-quoted. Nothing else ever crosses.
4. **Nothing is installed, started, stopped, approved or changed on any computer until the person confirms it on the screen that says what will happen and where.** Looking is read-only: `openclaw --version`, `openclaw gateway status --json`, `openclaw devices list --json`, `tailscale status --json`.
5. **Read access first.** Every first connection asks for `operator.read` alone, and every setup code Clawtrate makes is `--limited`. Anything more is asked for later by an explicit request (`conversation.md` §3, `bots.md` §2) and approved on the gateway.
6. **No credential is ever in a log, a state snapshot, an error message or the interface.** The shared token is never read. A bootstrap token lives in the host's memory from the moment its code is made until it is redeemed or expires, and is never stored. A setup code is shown only on "Connect a phone", whose purpose is to show it. Device tokens are kept as `docs/decisions.md` says. The host removes any of these values from program output before keeping, logging or showing it.
7. **A host key is never accepted by itself**, and a changed host key cannot be accepted inside Clawtrate at all.
8. **Clawtrate stops only what it started**: its own `ssh` processes, by PID, and a gateway only when Clawtrate's own record says Clawtrate started or installed it. A gateway, a service or a Tailscale route someone else made is never stopped, changed or removed.
9. **The person's own SSH files are read by `ssh` and never written.** Keys the person trusts in Clawtrate go to Clawtrate's own known-hosts file, in its data folder.

### Routes

A **route** is how Clawtrate reaches one gateway. It is the unit Clawtrate saves, and the unit a device token is kept for (`docs/decisions.md`, section 18 here).

| Route         | Made by                          | Saved as                                                                                                     | Shell on the gateway's computer |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| This computer | "This computer"                  | the gateway's port on loopback                                                                               | Yes, the host's own             |
| SSH           | "Another computer"               | the SSH destination as resolved by `ssh -G`, the host key's fingerprint, the gateway's port on that computer | Yes, over SSH                   |
| Address       | "Have a setup code?", "Advanced" | the address                                                                                                  | No                              |

"Shell" decides what a screen may offer: Start, Set up, Approve from here, Connect a phone from the host's own code, Private access with Tailscale and Remove need it. On an address route these are absent, or offered through an admin connection where the gateway has a method (section 12).

### Components used

| Component                                                                                                  | From                               | Used for                                               |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| The connection screen's column, mark, name, slogan and bots                                                | `visual-language.md` §10           | Every setup screen                                     |
| Pill field (`.input`), primary, default and quiet buttons                                                  | `visual-language.md` §4            | Every control                                          |
| The pairing screen's command block, copy button and waiting line                                           | `visual-language.md` §10           | Commands, codes, waits                                 |
| Choice list (`.b-choices`), note (`.b-note`), switch (`.b-switch`), dialog (`.b-dialog`), code (`.b-code`) | `bots.md` §2                       | The first question, notes, Settings                    |
| The access bar and its states                                                                              | `bots.md` §2, `conversation.md` §3 | Asking for more access, with "Approve from here" added |
| The status strip                                                                                           | `visual-language.md` §11           | A forward being restored                               |
| Fact block (`.facts`)                                                                                      | `visual-language.md` §9            | What was found                                         |

### New components

Each is defined once, in `prototype/css/setup.css`, from existing tokens.

| Component                | What it is                                                                                                                                                                                                                                                                                                                                                                                          | Tokens                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Step list (`.s-steps`)   | A vertical list of steps, each a 20 px mark and its words (15). Waiting: a hollow ring in `--text-faint`. Running: the working arc in `--text` (a still ring when motion is reduced) and, after 10 s, the elapsed time (13, faint, tabular). Done: a check in `--text-muted`. Failed: a cross in `--danger` and the step's words in `--danger`. A list; the running step has `aria-current="step"`. | `--text`, `--text-faint`, `--danger` |
| Fingerprint (`.s-print`) | A host key's fingerprint: the algorithm (13, faint) over the value in mono, 14 px, in groups of eight, on `--bg-inset`, radius 14, with a copy button.                                                                                                                                                                                                                                              | `--font-mono`, `--bg-inset`          |
| Found card (`.s-found`)  | What the look found: a 44 px empty mark, a title (17/500), a fact block of at most four rows, and the screen's one primary action under it.                                                                                                                                                                                                                                                         | `--bg-bubble`                        |
| QR code (`.s-qr`)        | A setup code's QR, drawn by Clawtrate from the code, black modules on white with a 16 px quiet zone in both themes, 200 px (176 on a phone), radius 14.                                                                                                                                                                                                                                             | `#000`, `#fff`                       |
| Countdown (`.s-expiry`)  | "Expires in 9:41", 13, faint, tabular; `--warn` in the last minute.                                                                                                                                                                                                                                                                                                                                 | `--text-faint`, `--warn`             |

No new tokens.

### Input

- Every setup screen is one column; Tab follows reading order; the screen's primary action is the default button, so Enter in the one field is that action.
- Back is always the first control and goes to the screen before, with what was typed kept.
- A screen that changes its content moves focus to its new title (`tabindex="-1"`), and the page's polite live region announces the change in the title's words.
- Copy follows the pairing screen: a check for 1.5 s and "Copied."; when the clipboard refuses, the text is selected and the region says how to copy it.
- Every wait can be left: Back during a look stops it (the host stops its programs by PID); Cancel during an install asks first (section 10).

## 3. The first screen

**Desktop, first launch, and whenever no gateway is saved** (F-001, F-491).

- The mark, "Clawtrate" (28/600), "Your OpenClaw agents, orchestrated." (15, muted).
- "Where does OpenClaw run?" (17/500), the screen's heading.
- One choice list with two rows, each opening the next screen (a chevron at its end):
  - "This computer", and under it "Clawtrate looks for OpenClaw here."
  - "Another computer", and under it "A computer you reach with SSH, such as a server or a desktop at home."
- Under the list, two quiet links on one line: "Have a setup code?" and "Advanced".
- One hint (13, faint): "New to OpenClaw? Choose where it should run, and Clawtrate offers to set it up there."

The person never chooses between "I already use OpenClaw" and "I am new to OpenClaw". Those are the two results of the look (section 6).

**The row of bots** stands along the foot as before, and is hidden below 640 px of height.

**On a computer with a development gateway** (a build that knows one, `visual-language.md` §10), "Use the development gateway" stays as a quiet button under the links. It is not in a shipped build.

## 4. Looking on this computer

"This computer" starts the look at once; there is nothing to confirm, because looking changes nothing (rule 4).

**What the host runs**, in order, each with its own time limit, all read-only:

| Step            | Program and arguments                                                                                                                                                                                                                                                                                    | Limit                                                                | Gives                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Find OpenClaw   | The first that exists of: Clawtrate's own install (`<app data>/openclaw/bin/openclaw`), OpenClaw's default (`~/.openclaw/bin/openclaw`), then the person's login shell's `PATH` through `/bin/sh -lc 'command -v openclaw'` (a constant). On Windows: Clawtrate's own install, then `where.exe openclaw` | 5 s                                                                  | a path, or none                                                                       |
| Version         | `openclaw --version`                                                                                                                                                                                                                                                                                     | 10 s                                                                 | e.g. `OpenClaw 2026.10.6 (fe06181)`                                                   |
| Ask the gateway | `openclaw gateway status --json`                                                                                                                                                                                                                                                                         | 20 s (60 s on Windows, where a scheduled task can be slow to answer) | the service, its state, the gateway's port and bind, `rpc.ok`, other gateway services |

**What the person sees** in place of the choice list, under the slogan: the title "Looking on this computer", and a step list with "Finding OpenClaw", "Checking its version" and "Asking the gateway". It usually takes one to three seconds. After 8 s the screen adds "Still looking. A gateway that has just started can take a while to answer." Back stops the look.

## 5. Another computer: the field and the look over SSH

**The field** (F-495). Title "Another computer", Back. One pill field, label "SSH host or alias", placeholder "devbox or you@devbox.example". Under it (13, faint): "Clawtrate uses your SSH settings and keys, and never asks for a password." Primary button "Look there". Under the button, a quiet link: "Have a setup code instead?".

- **Accepted**: an alias from the person's SSH configuration, a host name, or `user@host`. A port, a jump host or a key file belongs in the person's SSH configuration under an alias, which the field then takes. Validated by rule 2's pattern before anything runs; a value that fails says "That isn't an SSH host or alias Clawtrate can use." under the field.
- **Remembered**: computers that worked before are offered above the field, at most three, as rows ("devbox", "OpenClaw 2026.10.6 · last used today"), so the second time is one click.

**The look over SSH.** Title "Looking on devbox", step list "Reaching devbox", "Finding OpenClaw", "Checking its version", "Asking the gateway". The host:

1. Resolves the destination with `ssh -G <destination>` (no connection), to know the host name and port it will reach.
2. Runs `ssh <ssh base> -v <destination> -- <the LOOK script>`. The base options are in section 19: no prompts, no unknown host keys, keepalives, a 10 s connect limit, and the person's own SSH configuration. The LOOK script is a constant: it finds `openclaw` the same way as section 4 (Clawtrate's own install on that computer, `~/.openclaw/bin/openclaw`, then the login shell's `PATH`), and prints the results of `--version` and `gateway status --json`, each as one JSON line, or that it found nothing. It also reports the computer's system (`uname -s`), because only macOS and Linux can be set up from here (section 10).

Usually two to five seconds; the "Still looking" line after 8 s, as on this computer; Back stops `ssh` by its PID.

**The three failures.** `ssh` exits with 255 for all three; the host tells them apart from its error output (research §7). Each replaces the step list with a note and keeps the field filled.

| Failure            | Note (title, then sentence)                                                                                                                                                                      | Next                                                                                                                                                                                   | Actions                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Cannot be reached  | **Can't reach devbox** · "Nothing answered at devbox.example (connection refused)." The part in brackets is `ssh`'s own reason: connection refused, no such name, timed out, network unreachable | "Check the name and that the computer is on. A VPN or a jump host goes in your SSH settings."                                                                                          | "Try again" (primary), Back |
| Sign-in refused    | **devbox didn't accept your key** · "The SSH sign-in for you@devbox.example was refused."                                                                                                        | "Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first." On Windows, add: "Turn on the OpenSSH Authentication Agent service in Services." | "Try again" (primary), Back |
| Host key not known | Below                                                                                                                                                                                            |                                                                                                                                                                                        |                             |

**A host key Clawtrate hasn't seen** (rule 7). The `-v` output names the key the computer sent (`Server host key: ssh-ed25519 SHA256:…`). The screen:

- Title "Is this devbox?", and "Clawtrate hasn't connected to devbox before. Check that this matches the key the computer shows, then trust it."
- The fingerprint: "ED25519" over `SHA256:Q3v8Lw0e Xk2Rj9Ta Nf5Hc1Ub Ym7Pd4Gs Zi6Ko2Ea Vr8`.
- A disclosure "How to check": "On devbox, run this and compare the result:" and `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` with its copy button.
- Primary "Trust and connect", default "Back". Trust writes the key to Clawtrate's own known-hosts file, after the host has fetched it with `ssh-keyscan` and checked that its fingerprint is the one shown (research §7). If they differ, nothing is trusted, and the screen shows "devbox sent a different key just now. Nothing was trusted." with "Try again".

**A host key that changed.** A `--danger` note, title **devbox's identity has changed**, and "The key devbox sent is not the one trusted before. This can mean someone is between you and that computer, so Clawtrate won't connect. If devbox was reinstalled, remove its old key from your SSH settings, then try again." The fingerprint it sent is shown under it, for comparison. Actions: "Try again" and Back. There is no way to accept it here (rule 7).

## 6. What the look found

One screen for both computers. The title says where ("On this computer", "On devbox"), a found card says what, and there is one primary action.

| Found                                                                                                                             | Card                                                                             | Facts                                                                                                                                                                                                              | Primary                                                   | Also                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Running and answering** (`rpc.ok`)                                                                                              | A check mark, "OpenClaw is running"                                              | Version "2026.10.6"; Listens "On this computer only" ("On devbox only") for bind loopback, "On your network" (lan) or "Through Tailscale"; Starts "With the computer" (service loaded) or "When someone starts it" | "Connect"                                                 | "Clawtrate asks for read access. Sending or changing anything is asked for later, once." (13, faint)                                                   |
| **Installed, not running** (service loaded, not running; or no service and nothing listening)                                     | A pause mark, "OpenClaw is installed but not running"                            | Version; Starts: "With the computer, but stopped now" or "Not set up to start"                                                                                                                                     | "Start OpenClaw"                                          | Below                                                                                                                                                  |
| **Running, refusing** (`rpc.ok` false with an auth or proxy error; or the gateway's config is in remote mode)                     | A warning mark, "The gateway here won't let Clawtrate in"                        | The reason in words (below)                                                                                                                                                                                        | depends                                                   |                                                                                                                                                        |
| **Not there**                                                                                                                     | An empty mark with a plus, "OpenClaw isn't on this computer" ("isn't on devbox") | none                                                                                                                                                                                                               | "Set up OpenClaw here" ("Set up OpenClaw on devbox")      | "It runs on another computer" (quiet), which goes to section 5                                                                                         |
| **Older than this build is tested with**                                                                                          | the running card, with a `--warn` note under the facts                           | "OpenClaw 2026.9.37 is older than the version this Clawtrate is tested with (2026.10.6). Some things may not work."                                                                                                | "Connect anyway"                                          | "How to update" opens a disclosure with `openclaw update` and "Run it on the gateway's computer when you're ready. Clawtrate doesn't update OpenClaw." |
| **Newer**                                                                                                                         | the running card, with a neutral note                                            | "OpenClaw 2026.11.4 is newer than the version this Clawtrate is tested with (2026.10.6). It should work; if something looks wrong, update Clawtrate."                                                              | "Connect"                                                 |                                                                                                                                                        |
| **Too old to connect** (its protocol below the client's; `gateway status --json` gives the version, `hello-ok.protocol` confirms) | A cross mark, "This OpenClaw is too old for Clawtrate"                           | "OpenClaw 2026.6.2 speaks an older protocol than Clawtrate needs. Update it, then look again."                                                                                                                     | "Look again"                                              | the same "How to update"                                                                                                                               |
| **More than one gateway** (`gateway status --json` lists other gateway services)                                                  | A list mark, "Two gateways run here"                                             | One choice row per gateway: its label and port ("OpenClaw · port 18789", "OpenClaw · port 19001"), and its state                                                                                                   | "Connect" to the chosen one, disabled until one is chosen | Nothing is chosen at first                                                                                                                             |

**Refusing, in words** (from `gateway status --json` and the connect's own error):

- "This computer's OpenClaw is set to connect to another gateway." (config in remote mode) → primary "Look on another computer".
- "The gateway refused the sign-in." (auth mismatch) → "Look again".
- "The gateway only accepts connections through a proxy it trusts." (proxy refusal) → no primary; "Use Advanced to enter its address" (quiet).

**Start OpenClaw** (F-497). A confirmation in place of the card: "Start OpenClaw on devbox?", then "The gateway starts as a service and keeps running after Clawtrate closes." for a loaded service (`openclaw gateway start`), or "This sets OpenClaw to start with devbox and starts it now." when there is no service (`openclaw gateway install`). Buttons "Start" (primary) and "Cancel". Then a step list, "Starting the gateway" and "Asking the gateway", and the running card. If it does not come up: a `--danger` note "**OpenClaw didn't start.**" with the classification in words (`service-missing`: "The service isn't installed."; `startup-blocked`: "The gateway reported a problem when starting."; `not-listening`: "Nothing is listening yet.") and "Try again". Clawtrate records that it started this gateway (rule 8).

## 7. Connecting, with nothing typed

"Connect" on a running gateway (F-492, F-496).

**What happens, on this computer:**

1. The host runs `openclaw qr --json --limited --url ws://127.0.0.1:<port>`, `<port>` from `gateway status --json`. It reads the setup code from the JSON, decodes the bootstrap token, and keeps it in memory only.
2. The core connects to `ws://127.0.0.1:<port>` with that bootstrap token (not a shared token), asking for `operator.read`.
3. The gateway approves the first pairing without a prompt and returns a device token (research §1, §3). The bootstrap token is forgotten.
4. Bots load; the app opens read-only.

**Over SSH**, the same, with two differences: the code is made on that computer through the same SSH destination (`ssh … -- <the CODE script> '<port>'`), and before step 2 the host starts the forward (`ssh … -N -L 127.0.0.1:<free port>:127.0.0.1:<port> <destination>`, section 8) and connects through it.

**What the person sees**: title "Connecting to devbox" ("Connecting"), a step list: "Making a one-time code on devbox" ("Making a one-time code"), "Opening a private connection to devbox" (SSH only), "Connecting", "Loading your bots". It takes one to three seconds. Then the app, read-only, with the access bar where a write would be (`conversation.md` §3).

**Where the shared token lives**: in OpenClaw's configuration on the gateway's computer, and nowhere else. Clawtrate never reads it, never asks for it, and never shows a field for it outside "Advanced" (F-494).

**If the gateway asks before every device** (`gateway.nodes.pairing.autoApproveLocal: false`, which some owners set): the connect returns `PAIRING_REQUIRED`. The pairing screen of `visual-language.md` §10 appears as it is, with one addition on a route with a shell: "Approve from here" (section 9), so the person still runs nothing by hand.

**Failures** (F-009):

| Fact                                                                            | Note                                                                                                    | Actions      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------ |
| `openclaw qr` failed                                                            | **Couldn't make a one-time code.** and OpenClaw's message                                               | "Try again"  |
| The code was refused (`AUTH_BOOTSTRAP_TOKEN_INVALID`: expired, used or revoked) | **The one-time code didn't work.** "It may have expired. Clawtrate makes a new one when you try again." | "Try again"  |
| The forward could not start                                                     | the SSH failure of section 5                                                                            | as there     |
| Nothing answered on the port                                                    | **Nothing answered on port 18789.** "The gateway may have just stopped."                                | "Look again" |
| The pairing was rejected or expired                                             | the pairing screen's own states (F-009)                                                                 | as there     |

## 8. The forward's life

Each SSH route has one forward, owned by the host: one `ssh -N -L` process per route, started on connect, its PID recorded (F-498, F-499).

| Event                                              | What `ssh` does (research §7)                                                               | What the host does                                                                                                   | What the person sees                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The computer sleeps, or the network changes        | Exits 255 with "Timeout, server … not responding." or "Connection … closed by remote host." | Starts the forward again at once on wake or on a network change, and otherwise after 1, 2, 4, 8, 16, then every 30 s | The status strip: **Restoring the connection to devbox** · showing saved messages, with "Retry now"; then **Connected to devbox again** for 4 s |
| The local port was taken meanwhile                 | Exits 255, "Address already in use"                                                         | Picks another free port and starts again                                                                             | Nothing more                                                                                                                                    |
| devbox stops answering for good                    | Exits 255 each time                                                                         | Keeps the backoff                                                                                                    | After 2 minutes the strip says **Can't reach devbox** · the reason, with "Retry now"                                                            |
| A restart fails with a host key or sign-in failure | Exits 255 with that error                                                                   | Stops retrying                                                                                                       | The strip says **devbox's identity has changed** or **devbox didn't accept your key**, with "Fix", which opens the matching screen of section 5 |
| The gateway on devbox stopped                      | The forward stays up; each connection through it fails                                      | Runs the LOOK script once                                                                                            | The strip says **OpenClaw stopped on devbox**, with "Start", which asks first (section 6)                                                       |
| Clawtrate quits                                    |                                                                                             | Stops its `ssh` processes by PID                                                                                     |                                                                                                                                                 |

**Removing the route** (Settings, Gateway, "Remove this gateway"): a confirmation "Remove devbox from Clawtrate?", "Clawtrate disconnects and forgets how to reach it. OpenClaw keeps running on devbox." When Clawtrate's record says it started or installed that gateway, a checkbox follows, unchecked: "Also stop OpenClaw on devbox. Clawtrate started it." Buttons "Remove" and "Cancel". The forward is stopped by its PID; the gateway is stopped only with the box checked (`openclaw gateway stop` over SSH), and never when Clawtrate did not start it.

## 9. Approve from here

Wherever the gateway waits for its owner and the route has a shell (F-500): the access bar's "Requested" state (`bots.md` §2), the pairing screen of section 7, and a phone's request (section 12).

- Under the command block, a default button: **"Approve from here"**.
- It opens a confirmation (a `.b-dialog` of kind confirm): "Approve on devbox?", then what is asked for, one line per scope, in the access bar's words: "Send messages and stop runs", "Answer questions", "Approve actions" for the interactive tier; "Change bots, accounts and settings" for admin; "Read bots, tasks and conversations" for a pairing. Then "Clawtrate runs OpenClaw's approve command on devbox for request e5eb4aa8." Buttons "Approve" (primary) and "Cancel".
- Approve runs `openclaw devices approve <requestId>` on that computer (research §2). The waiting line then finds the approval as it always does; nothing else changes. If the command fails, a `--danger` note: "**Couldn't approve.**" and OpenClaw's message, with the command still there to run by hand.
- On an address route there is no button; the command block stays as it is.

## 10. Setting OpenClaw up

"Set up OpenClaw here" or "Set up OpenClaw on devbox" (F-501 to F-505).

**Before anything is downloaded** (F-501): title "Set up OpenClaw on this computer" ("on devbox"), and a fact block:

|       | This computer (macOS, Linux)                                                                                                                           | devbox (over SSH)                        | This computer (Windows)                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| What  | "OpenClaw 2026.10.6, the version this Clawtrate is tested with, and its own copy of Node.js"                                                           | the same                                 | "OpenClaw 2026.10.6, the version this Clawtrate is tested with"                       |
| Where | "In Clawtrate's folder, about 830 MB" (`<app data>/openclaw`)                                                                                          | "In ~/.openclaw on devbox, about 830 MB" | "For every program on this computer, through npm"                                     |
| From  | "The npm registry and nodejs.org"                                                                                                                      | the same, downloaded by devbox           | "The npm registry, nodejs.org, and Windows Package Manager if Node.js needs updating" |
| Then  | "A gateway that listens on this computer only, starts with the computer, and has no AI provider yet. You sign in to one when you make your first bot." | the same, "on devbox only"               | the same, "as a scheduled task"                                                       |

Under it (13, faint): "Nothing is asked for: no account and no model key." On Windows, a neutral note above the buttons: "If this computer's Node.js is older than OpenClaw needs, Windows Package Manager updates it for every program." Buttons "Download and set up" (primary) and "Cancel".

On devbox, setup needs macOS or Linux with `curl` or `wget`, `tar` and a SHA-256 tool. When the look reported another system, the not-there card says "Clawtrate can set OpenClaw up on macOS and Linux computers." and offers no button.

**The steps** (F-502), title "Setting up OpenClaw":

| Step                           | What the host runs (section 19)                                                                                                                                                    | Its failure, in words                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| "Download OpenClaw 2026.10.6"  | Fetches `openclaw-2026.10.6.tgz` from the npm registry and checks it against the integrity this build carries; takes its installer out of it                                       | "The download didn't finish." · "The download didn't match the version Clawtrate expects, so nothing was installed." |
| "Install Node.js and OpenClaw" | The release's own `install-cli.sh --json --runtime-only --npm --version 2026.10.6 --prefix <folder>`; the step's line follows its events ("Node.js 24.22.1", "OpenClaw 2026.10.6") | The installer's `error` event, in its own words, e.g. "npm install did not produce a usable OpenClaw package"        |
| "Set up the gateway"           | `openclaw onboard --non-interactive --accept-risk --auth-choice skip --gateway-bind loopback --gateway-auth token --install-daemon --skip-skills --json`                           | The JSON's message and classification in words, as in section 6                                                      |
| "Start and check"              | `openclaw gateway status --json` until `rpc.ok`, at most 60 s                                                                                                                      | "The gateway didn't answer after it was set up."                                                                     |
| "Connect"                      | Section 7                                                                                                                                                                          | Section 7                                                                                                            |

It takes about a minute on macOS and Linux (research §6.2-6.3) and several minutes on Windows. The running step shows its elapsed time after 10 s.

**A failed step** is drawn failed, the steps after it stay waiting, and a `--danger` note under the list says "**<the step's words> failed.**" and the reason. Actions: "Try again" (primary), which starts again from the download, because a partial install is removed first; "Show details", a disclosure with the last 20 lines of the step's output, with credentials removed (rule 6); and "Cancel".

**Cancel**, at any point before "Connect": a confirmation "Stop setting up OpenClaw?", "Clawtrate stops and removes what it installed in its folder. Nothing else on this computer was changed." (devbox: "in ~/.openclaw on devbox"; Windows: "OpenClaw is removed; Node.js, if it was updated, stays updated."). Buttons "Stop and remove" and "Keep going". Stopping ends the running program by its PID, then removes the folder; if onboarding had begun, it runs `openclaw uninstall --service --state --workspace --yes --non-interactive` first. The next attempt starts from nothing (F-502).

**The end** (F-505): every step done, then the app opens read-only on the new gateway, with no bots yet. The rail's empty state leads to `bots.md`'s "New bot" with its Account step, where the first sign-in happens (F-504). Clawtrate records that it installed this gateway (rule 8).

## 11. Removing OpenClaw, or leaving it

**Settings, Gateway** shows, for a gateway Clawtrate installed: "Installed by Clawtrate · OpenClaw 2026.10.6 · Starts with this computer", and a quiet danger button "Remove OpenClaw…" (F-514).

- Confirmation: "Remove OpenClaw from this computer?", "This removes the gateway service, its settings, its bots and their conversations, and the program. It can't be undone." A checkbox, unchecked: "Keep the bots and their conversations". Buttons "Remove" (danger) and "Cancel".
- Remove runs `openclaw uninstall --service --yes --non-interactive`, adding `--state --workspace` unless the box is checked, then removes Clawtrate's folder. On Windows a last "the folder is in use" (research §6.6) is reported as "OpenClaw was removed. An empty folder is left in your home folder." and is not a failure.
- A gateway Clawtrate did not install is never offered for removal.
- **Leaving it**: removing the Clawtrate app does not remove OpenClaw. The install's sheet says so once: "OpenClaw keeps running if you remove Clawtrate. To remove it too, use Settings first."

## 12. Connect a phone

**Where**: Settings, Gateway, "Connect a phone", and the gateway menu (F-506). A dialog, 440 px, title "Connect a phone".

**Where the code comes from**, in this order:

1. A route with a shell: the host runs `openclaw qr --json --limited` on the gateway's computer (research §3), without `--url`, so OpenClaw chooses the address a phone can use.
2. No shell, on a connection that holds `operator.admin`: `device.pair.setupCode {bootstrapProfile: "limited", includeQr: false}` (research §4).
3. No shell and no admin: the access bar, "**Admin access needed.** Making a code needs admin access when Clawtrate can't run OpenClaw on the gateway's computer.", with "Request admin access".

**The code**: the QR (`.s-qr`), "Open Clawtrate on your iPhone and scan this code." (13, faint), the code in mono with its copy button, then the countdown "Expires in 9:41" from `expiresAtMs`. At zero: "This code has expired." and "Make a new code" (primary); the QR is replaced by the empty mark.

**The address in plain words**, one line above the QR, from the code's address:

| Address                                      | Line                                                   |
| -------------------------------------------- | ------------------------------------------------------ |
| A private network address or a `.local` name | "Works on the same Wi-Fi as this computer."            |
| A Tailscale name (MagicDNS) or address       | "Works wherever your phone is signed in to Tailscale." |
| Any other `wss://` address                   | "Works anywhere: gateway.example."                     |

**Loopback only.** When OpenClaw answers that the gateway is bound to loopback (research §1), there is no code a phone can use, and none is made. A `--warn` note: "**A phone can't reach this gateway yet.** It only listens on this computer." followed by two ways forward: "Turn on private access with Tailscale" (a button that opens section 14) and "Or set OpenClaw to listen on your network (`gateway.bind`)." (13, faint).

**Waiting for the phone.** While the code is shown on a route with a shell, the host runs `openclaw devices list --json` every 3 s. A pending request made after the code, from a `gateway-client` device, appears under the code as a row: "Clawtrate iPhone wants to connect" and "Read bots, tasks and conversations", with "Approve" (primary) and "Not now". The row is the confirmation: it says exactly which device and what it gets, and Approve runs `openclaw devices approve <requestId>` (section 9). Then: "iPhone connected, read-only." Without a shell, the line is "Approve the phone on the gateway's computer with `openclaw devices approve`.", with the request id when `device.pair.setupStatus` reports it.

## 13. A setup code on the desktop, and the iPhone's first screen

**On the desktop** (F-508): "Have a setup code?" on the first screen, and "Have a setup code instead?" under the SSH field. Title "Use a setup code", one field (mono, three lines tall), label "Setup code", placeholder "Paste a code from openclaw qr or from Connect a phone". As soon as the field holds a code, it is decoded locally (never sent anywhere) and a line under it says where it leads: "Connects to devbox.local, on your network. Expires in 8 minutes." A code that does not decode says "That isn't a setup code."; an expired one "This code has expired. Make a new one on the gateway's computer." Primary "Connect".

Off loopback the gateway does not approve a device by its code alone (research §3), so "Connect" ends on the pairing screen: "Approve this device" with the gateway's approve command and the request id (`visual-language.md` §10). The code still saved typing an address and a token.

**On iPhone** (F-001, F-507), first launch:

- The mark, the name, the slogan, then "Connect to your OpenClaw" (17/500).
- "Scan a setup code" (primary, opens the camera), "Paste a setup code" (default).
- A hint: "Make a code in Clawtrate on your computer, in Settings, Connect a phone. Or run openclaw qr on the gateway's computer."
- "Advanced" (quiet link): the address-and-token form.

After a scan or a paste: "Connects to devbox.tailnet.example, through Tailscale." and "Connect". Then "Waiting for approval": "Approve this iPhone in Clawtrate on your computer, or run this on the gateway's computer:", the command block with the request id, and the waiting line. Approved: the app opens read-only (F-509).

## 14. Private access with Tailscale

**Settings, Gateway**, only on a route with a shell (F-510): a switch row, "Private access with Tailscale", and under it "Reach this gateway from your own devices anywhere, through Tailscale. Tailscale is never needed for anything else."

**Turning it on**: a confirmation, "Turn on private access?", "OpenClaw restarts on devbox. Your devices signed in to Tailscale can then reach it at an address like devbox.tailnet.example. Clawtrate reconnects by itself." Buttons "Turn on" and "Cancel". Then a step list:

| Step                        | What the host runs there                                                                                                | Failure                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| "Checking Tailscale"        | `tailscale status --json`                                                                                               | The first two below; nothing has changed yet                                         |
| "Turning on private access" | `openclaw config set gateway.tailscale.mode serve`                                                                      | OpenClaw's message                                                                   |
| "Restarting OpenClaw"       | `openclaw gateway restart`                                                                                              | OpenClaw's message; the setting is put back to `off` and the gateway restarted again |
| "Checking the address"      | `openclaw qr --json --limited --remote` gives the Tailscale address, or the gateway's warning says Serve is not enabled | "HTTPS isn't turned on for this tailnet", below; the setting is put back             |

**The three named failures** (F-511), each a `--warn` note with the next step, and "The gateway is reachable the way it was." under it:

| Failure                                    | From                                       | Note                                                                                   |
| ------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Tailscale isn't installed on devbox**    | `tailscale` not found                      | "Install Tailscale on devbox and sign in, then turn this on again."                    |
| **Tailscale is signed out on devbox**      | `BackendState` `NeedsLogin` (or `Stopped`) | "Sign in to Tailscale on devbox, then turn this on again."                             |
| **HTTPS isn't turned on for this tailnet** | OpenClaw's Serve warning after the restart | "Turn on HTTPS certificates in your Tailscale admin console, then turn this on again." |

**On**: the row says "On · devbox.tailnet.example", and "Connect a phone" uses that address. **Off**: a confirmation "Turn off private access?", "OpenClaw restarts on devbox. Devices using the Tailscale address stop reaching it." Then `config set gateway.tailscale.mode off` and a restart.

**A route Clawtrate didn't make** (F-512). When `tailscale status --json` or the gateway's status shows a Serve route to this gateway's port and OpenClaw's own mode is `off`, the row says "**A Tailscale route to this gateway already exists.** Clawtrate didn't make it and leaves it alone. OpenClaw refuses connections through it unless its owner sets gateway.trustedProxies." The switch is disabled, because turning OpenClaw's mode on would take that route over (research §8). Nothing in Clawtrate changes or removes it.

## 15. Several routes to one gateway

What the research allows now (F-513, research §5):

- Each route pairs by itself, and keeps its own device token. A token is offered only on the route it was issued on.
- Every route reads the gateway's identity (`gateway.identity.get`) once it has authenticated. Two saved routes with the same identity are one gateway: Settings, Gateway lists them under it ("Reached through: this computer · devbox over SSH"), and the rail, pins and preferences follow the identity, as they already do.
- The route in use is the one the person connected through; Settings marks it "In use".

What waits:

- Trying routes in order and moving back to an earlier one when it answers again. It needs a route list per gateway and an engine that holds one connection while testing another; it comes after the six packages (section 19).
- Adding a route the gateway names itself (its Tailscale address, read over an SSH route). It is safe only if each such route still pairs by itself; then it is an "Add route" button, never automatic.

## 16. Widths, themes, keyboard, screen readers, motion

| Concern                            | Rule                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1440 and 1100 px                   | The 360 px column centred on the stage, as `visual-language.md` §10; dialogs centred                                                                                                                                                                                                                                                                                                     |
| 800 px                             | The same; the bots along the foot scale as the connection screen's do                                                                                                                                                                                                                                                                                                                    |
| Phone (390 px, and the iPhone app) | The column fills the width less 16 px a side; rows are 64 px, buttons 48 px; the bots hide below 640 px of height; dialogs become sheets (`bots.md` §2); the QR is 176 px; the fingerprint breaks into two lines of three groups                                                                                                                                                         |
| Light and dark                     | Tokens only; the QR stays black on white in both                                                                                                                                                                                                                                                                                                                                         |
| Keyboard                           | Tab order is reading order; the choice list is a list of buttons, Up and Down move between them; Enter is the screen's primary action; Escape is Back on a step screen and Cancel in a dialog                                                                                                                                                                                            |
| Screen readers                     | Each screen's title is its heading and takes focus when it appears; the step list is a list with the running step `aria-current="step"`; each step's state is in its accessible name ("Asking the gateway, running"); notes are `role="alert"` for failures and `role="status"` otherwise; the countdown is announced once a minute, not every second; the fingerprint is read in groups |
| Reduced motion                     | The running step's arc is a still ring; the waiting dot stops pulsing; nothing slides                                                                                                                                                                                                                                                                                                    |
| Branding                           | Clawtrate's mark and bots only; OpenClaw and Tailscale named in text, with no logo or colour of theirs                                                                                                                                                                                                                                                                                   |

## 17. What each fact drives

| Fact                                                                 | Source (research) | Shown                                                                                  |
| -------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| No `openclaw` found                                                  | the look          | "OpenClaw isn't on this computer" (section 6)                                          |
| `openclaw --version`                                                 | §6.4              | The version fact; older, newer or too old (section 6)                                  |
| `gateway status --json` `service.loaded`, `runtime.status`           | §6.4              | "With the computer", "stopped now", "Not set up to start"                              |
| `gateway.port`, `gateway.bindMode`                                   | §6.4              | The port used for the code and the forward; "On this computer only", "On your network" |
| `rpc.ok` true                                                        | §6.4              | "OpenClaw is running", Connect                                                         |
| `rpc.ok` false and nothing listening                                 | §6.4              | "installed but not running", Start                                                     |
| `extraServices` not empty                                            | §6.4              | "Two gateways run here"                                                                |
| `ssh` exit 255 and its error output                                  | §7                | The three failures, "identity has changed"                                             |
| `Server host key: … SHA256:…`                                        | §7                | The fingerprint                                                                        |
| `openclaw qr --json` `setupCode`                                     | §3                | Connect's one-time code; the phone's QR and code                                       |
| Bootstrap token redeemed, `approvedVia: "silent"`                    | §1, §3            | Connected, read-only, nothing typed                                                    |
| `AUTH_BOOTSTRAP_TOKEN_INVALID`                                       | §3                | "The one-time code didn't work"                                                        |
| "Gateway is only bound to loopback"                                  | §1                | "A phone can't reach this gateway yet"                                                 |
| `device.scopes.requestUpgrade` `requestId`, pending                  | §2                | The access bar's Requested state with "Approve from here"                              |
| `devices approve` exit 0                                             | §2                | The wait finds the approval                                                            |
| `devices list --json` pending, after the code                        | §3                | "Clawtrate iPhone wants to connect"                                                    |
| `device.pair.setupCode` refused below admin                          | §4                | The access bar on "Connect a phone"                                                    |
| `install-cli.sh` NDJSON events                                       | §6.1-6.2          | The install's step lines and failures                                                  |
| Onboarding JSON `ok`, `classification`                               | §6.3              | "Set up the gateway" done or failed                                                    |
| `ssh` "Timeout, server … not responding." or "closed by remote host" | §7                | "Restoring the connection to devbox"                                                   |
| `tailscale status --json`                                            | §8                | The first two Tailscale failures                                                       |
| A Serve route with OpenClaw's mode `off`                             | §3, §8            | "A Tailscale route to this gateway already exists"                                     |
| `gateway.identity.get` `deviceId`                                    | §5                | Routes grouped under one gateway                                                       |
| HTTP 403 `proxy_attribution_required`                                | §3                | "only accepts connections through a proxy it trusts"                                   |

## 18. Parity rows to reword, and rows added

Only the Clawtrate and gateway columns change; statuses do not. These are the whole set.

| Row   | Clawtrate column                                                                                                                                                                                                                                                                                                                                                                                                                 | Gateway column                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-001 | better: no vendor account. On the desktop the first screen asks one question, "Where does OpenClaw run?", with "This computer" and "Another computer" (F-491), and offers "Have a setup code?" (F-508); on iPhone it offers to scan or paste a setup code (F-507). The form that takes an address and a token is under "Advanced" on both (F-493).                                                                               | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| F-003 | better: a step list (connecting, pairing, loading Bots) and the app opens read-only as soon as Bots load. A connection over SSH adds making a one-time code there and opening the forward (F-496); an install has its own steps: download, install, set up, start and check, connect (F-502).                                                                                                                                    | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| F-009 | same; note: for gateway unreachable, pairing rejected and pairing expired. The failures of a connection over SSH (cannot be reached, sign-in refused, host key not known, host key changed) are row F-495, and each failed install step is row F-502.                                                                                                                                                                            | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| F-492 | better: with a gateway answering on this computer, the screen names it and one action connects: no address, token or command is typed, the device ends paired with `operator.read` only, and the gateway's shared token is never read.                                                                                                                                                                                           | available: the host makes a one-time setup code on this computer (`openclaw qr --json --limited --url ws://127.0.0.1:<port>`) and the client connects with its bootstrap token; the gateway approves the first pairing of a loopback connection without a prompt unless `gateway.nodes.pairing.autoApproveLocal` is false, and grants `operator.read` alone (live, `docs/research/setup-flow.md` §1, §3). The shared token cannot be read by a program: `openclaw gateway auth-token --show` refuses outside an interactive terminal. |
| F-494 | better: Clawtrate never reads the gateway's shared token. The first connection on this computer or over SSH uses a one-time setup code that the host makes and redeems at once; its bootstrap token stays in the host, never reaches the interface, a state snapshot, an error message or a log, and is forgotten once used or expired.                                                                                          | client only: a setup code is `{url, bootstrapToken, expiresAtMs}`, lives 10 minutes, works once, and never contains the shared token (live, §3).                                                                                                                                                                                                                                                                                                                                                                                      |
| F-495 | better: "Another computer" takes an SSH host or an alias from the user's SSH configuration. A failure says which it was: the host cannot be reached, the sign-in was refused, or the host's key is not known. Clawtrate never accepts an unknown host key by itself: it shows the key's fingerprint and the user decides; a key that changed is refused and cannot be accepted inside Clawtrate.                                 | client only: the host starts the system `ssh` with `BatchMode=yes`, `StrictHostKeyChecking=yes`, fixed arguments and a validated host; all three failures exit 255 and are told apart by its error output, alike on macOS, Linux and Windows' bundled OpenSSH (live, §7); no shell string is built from what the user typed.                                                                                                                                                                                                          |
| F-496 | better: with OpenClaw running on the other computer, Clawtrate makes a one-time code there over SSH, forwards a free local port to that computer's loopback gateway, and connects read-only with nothing else typed: no port looked up, no token copied, no command run by hand on that computer.                                                                                                                                | available: as F-492 through `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<port>` with `ExitOnForwardFailure=yes`; the gateway treats the forwarded connection as local and approves it without a prompt (live, §1).                                                                                                                                                                                                                                                                                                                     |
| F-497 | as written                                                                                                                                                                                                                                                                                                                                                                                                                       | partial: `openclaw --version` and `openclaw gateway status --json` (service, port, bind, `rpc.ok`; live, §6.4), and `openclaw gateway start` or `openclaw gateway install`, run on that computer over SSH; nothing in the gateway protocol.                                                                                                                                                                                                                                                                                           |
| F-500 | better: when an access request or a pairing waits for approval on a gateway Clawtrate reaches on this computer or over SSH, it offers "Approve from here": it names what is asked for and runs the gateway's own approve command on that computer only after the user confirms.                                                                                                                                                  | partial: `device.scopes.requestUpgrade` always waits for approval, on loopback too (live, §2); `openclaw devices approve <requestId>` on the gateway's computer approves it and prints `Approved <deviceId> (<requestId>)` (live).                                                                                                                                                                                                                                                                                                    |
| F-502 | better: an install shows a step list (download, install, set up, start and check, connect). A step that fails is named, with what went wrong, "Try again" and its details; a cancelled or failed install is removed before the next attempt, so it leaves nothing behind that the next attempt trips on.                                                                                                                         | partial: OpenClaw's own `install-cli.sh --json` from the pinned release, whose NDJSON events name each step and error, and `openclaw onboard --non-interactive --json`, whose result names a failure's class (live, §6.2, §6.3); none of it is gateway protocol.                                                                                                                                                                                                                                                                      |
| F-503 | better: the OpenClaw version Clawtrate installs is the one this build of Clawtrate is tested against, not whatever is newest, and the screen names it; the installer is taken from that release's own package, checked against its published integrity, never fetched live.                                                                                                                                                      | available: `install-cli.sh --version 2026.10.6` from `openclaw-2026.10.6.tgz`, checked against its npm integrity; on Windows `install.ps1 -Tag 2026.10.6` (live, §6.1, §6.2, §6.6).                                                                                                                                                                                                                                                                                                                                                   |
| F-504 | as written                                                                                                                                                                                                                                                                                                                                                                                                                       | available: `openclaw onboard --non-interactive --accept-risk --auth-choice skip`; no model key is asked for or written (live, §6.3).                                                                                                                                                                                                                                                                                                                                                                                                  |
| F-505 | as written                                                                                                                                                                                                                                                                                                                                                                                                                       | available: `openclaw onboard` with `--gateway-bind loopback`, `--gateway-auth token` and `--install-daemon`: a LaunchAgent on macOS, a systemd user service on Linux, a Scheduled Task on Windows (live, §6.3, §6.6).                                                                                                                                                                                                                                                                                                                 |
| F-506 | better: a connected desktop app offers "Connect a phone": a QR code and a setup code that expire, with the address the code carries named in plain words (the same Wi-Fi, Tailscale, or anywhere), and a warning when the gateway listens only on this computer, which a phone cannot reach. While the code is shown on a route with a shell, a pairing request from a phone appears with what it asks for and "Approve".        | partial: `openclaw qr --json --limited` on the gateway's computer; with no shell, `device.pair.setupCode {bootstrapProfile: "limited"}`, which needs `operator.admin` (live: refused below admin, §4); a loopback-only gateway gives no code a phone can use (live, §1); `openclaw devices list --json` and `devices approve` for the phone's request.                                                                                                                                                                                |
| F-507 | better: on iPhone, scanning the QR code or pasting the setup code connects the phone, which waits until the gateway's owner approves it (from the desktop's "Connect a phone", or with the gateway's approve command), then opens the app read-only: no address and no token is typed.                                                                                                                                           | partial: a setup code carries the gateway's address and a 10-minute, single-use bootstrap token, never the shared token (live, §3); off loopback only OpenClaw's own mobile apps are approved by the code, so this client's pairing waits for `openclaw devices approve` (source, §3).                                                                                                                                                                                                                                                |
| F-509 | as written                                                                                                                                                                                                                                                                                                                                                                                                                       | available: this client asks for `operator.read` in `connect` and the gateway grants that alone with a setup code, `--limited` or not (live, §3).                                                                                                                                                                                                                                                                                                                                                                                      |
| F-510 | better: for a gateway Clawtrate has a shell on (this computer, or over SSH), Settings shows "Private access with Tailscale". Turning it on checks Tailscale first, then sets OpenClaw's own Tailscale mode after a confirmation that says the gateway restarts; turning it off puts the setting back. Tailscale is never required for anything else.                                                                             | partial: `gateway.tailscale.mode: "serve"` through `openclaw config set` on the gateway's computer, then `openclaw gateway restart`; a connection through Serve is remote, so a new device's pairing waits for approval (source, §8).                                                                                                                                                                                                                                                                                                 |
| F-511 | as written                                                                                                                                                                                                                                                                                                                                                                                                                       | partial: `tailscale status --json` on the gateway's computer before anything changes (program not found, `NeedsLogin`), and OpenClaw's Serve warning after the restart for HTTPS; their exact words are unverified (§8).                                                                                                                                                                                                                                                                                                              |
| F-512 | as written                                                                                                                                                                                                                                                                                                                                                                                                                       | partial: a route that reaches the gateway through a proxy adding forwarded headers is refused with HTTP 403 `proxy_attribution_required` unless `gateway.trustedProxies` names it (live, §3); OpenClaw's own Serve mode takes over a root route to the gateway's port (source, §8), so the switch stays off while one exists.                                                                                                                                                                                                         |
| F-513 | better: one gateway can be reached by several routes (this computer, SSH, an address on the local network, a Tailscale address). Each route pairs by itself and keeps its own device token, which is never offered on another route; routes that reach the same gateway, by the identity the gateway reports, are shown as one, with the route in use marked. Trying routes in order and moving back to an earlier one is later. | partial: `gateway.identity.get` (`operator.read`) gives the gateway's own `{deviceId, publicKey}`, the same over every route (live: one id over loopback and the SSH forward, §1), but only after a route has authenticated; nothing proves it before a credential is sent (§5).                                                                                                                                                                                                                                                      |

F-491, F-493, F-498, F-499, F-501 and F-508 are met as written. No row is turned to `gap`: every row the gateway could not honor as first written (F-492's reading of the shared token, F-507's pairing without approval) is met by another route that the research proved.

**Rows added**, at the end of `docs/parity.md`, because these screens show behaviours no row covers:

| Row   | Clawtrate column                                                                                                                                                                                                                                                                                                      | Gateway column                                                                                                                                                                        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-514 | better: Settings shows OpenClaw that Clawtrate installed, with "Remove OpenClaw…", which removes the gateway service, its settings and the program after a confirmation that lists them, keeping the bots and their conversations if the user asks; a gateway Clawtrate did not install is never offered for removal. | partial: `openclaw uninstall --service [--state --workspace] --yes --non-interactive` on the gateway's computer (live, §6.5); on Windows it can end with an empty folder left (§6.6). |
| F-515 | better: the look names the OpenClaw version it found and says when it is older or newer than the version this build is tested against; one too old for the client's protocol is not connected to, with what to do. Clawtrate never updates OpenClaw by itself.                                                        | partial: `openclaw --version` and `gateway status --json` `gateway.version` (live, §6.4); `hello-ok.protocol`.                                                                        |
| F-516 | better: when the look finds more than one gateway on one computer, it lists each with its port and state and the user chooses; nothing is chosen for them.                                                                                                                                                            | partial: `gateway status --json` `extraServices` (source; a computer with two gateways was not run, §6.4).                                                                            |

## 19. For builders

### What each part uses

| Screen                 | Existing                                                    | New                |
| ---------------------- | ----------------------------------------------------------- | ------------------ |
| First screen           | The connection column, mark, bots, choice list, quiet links | none               |
| Looking                | The connection column                                       | Step list          |
| Another computer       | `.input`, notes, the copy button                            | Fingerprint        |
| What the look found    | Fact block, notes, buttons, choice list                     | Found card         |
| Connecting, setting up | Notes, disclosure                                           | Step list          |
| Approve from here      | The access bar, the pairing screen, the confirm dialog      | none               |
| Settings, Gateway      | Settings frame (`bots.md`), switch, notes, confirm dialog   | none               |
| Connect a phone        | Dialog, code, notes, choice rows                            | QR code, countdown |
| iPhone first screen    | The connection column                                       | none               |

### What the host does

**Setup commands** the interface may send the host, and nothing else. Every argument is data, validated on arrival:

| Command                                   | Arguments                                          | Does                                                                              |
| ----------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `setup.look`                              | `{where: "here"}` or `{where: "ssh", destination}` | Section 4 or 5; returns the facts of section 17                                   |
| `setup.cancel`                            | `{lookId}`                                         | Stops that look's programs by PID                                                 |
| `setup.trustHostKey`                      | `{destination, fingerprint}`                       | `ssh-keyscan`, compares, writes Clawtrate's known-hosts file                      |
| `setup.connect`                           | `{routeId}`                                        | Section 7                                                                         |
| `setup.start`                             | `{routeId}`                                        | Section 6, Start                                                                  |
| `setup.install` / `setup.cancelInstall`   | `{where}` / `{installId}`                          | Section 10                                                                        |
| `setup.approve`                           | `{routeId, requestId}`                             | Section 9                                                                         |
| `setup.phoneCode` / `setup.phoneRequests` | `{routeId}`                                        | Section 12                                                                        |
| `setup.tailscale`                         | `{routeId, on}`                                    | Section 14                                                                        |
| `setup.removeRoute`                       | `{routeId, stopGateway}`                           | Section 8                                                                         |
| `setup.uninstall`                         | `{routeId, keepData}`                              | Section 11                                                                        |
| `setup.readCode`                          | `{code}`                                           | Decodes a pasted code locally and returns its address and expiry, never its token |

**Validated arguments** (rule 2):

| Value           | Pattern                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| SSH destination | `^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,252}$`: never starts with `-`, no spaces, no `:` or `/` |
| Port            | an integer 1 to 65535, from `gateway status --json` only                                                        |
| Request id      | `^[A-Za-z0-9-]{1,128}$` (the gateway's are UUIDs)                                                               |
| Fingerprint     | `^SHA256:[A-Za-z0-9+/]{43}$`                                                                                    |
| Version         | a constant of the build, `2026.10.6`, with the tarball's integrity                                              |

**Programs**, each started with an argument array, never through a shell (rule 1); `<ssh base>` is below:

| Program                 | Arguments                                                                                                                                       | When                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `ssh`                   | `-G <destination>`                                                                                                                              | resolve                                                  |
| `ssh`                   | `<ssh base> -v <destination> -- <LOOK script>`                                                                                                  | the look over SSH                                        |
| `ssh-keyscan`           | `-t ed25519 -p <port> <hostname from ssh -G>`                                                                                                   | trusting a key                                           |
| `ssh-keygen`            | `-lf <a temporary file of the host's>`                                                                                                          | checking the scanned key                                 |
| `ssh`                   | `<ssh base> -N -L 127.0.0.1:<free port>:127.0.0.1:<port> <destination>`                                                                         | the forward                                              |
| `ssh`                   | `<ssh base> <destination> -- <CODE script> '<port>'`                                                                                            | a one-time code there                                    |
| `ssh`                   | `<ssh base> <destination> -- <APPROVE script> '<requestId>'`                                                                                    | approve from here, there                                 |
| `openclaw`              | `--version`; `gateway status --json`; `devices list --json`                                                                                     | this computer, the look                                  |
| `openclaw`              | `qr --json --limited --url ws://127.0.0.1:<port>`; `qr --json --limited`                                                                        | this computer, connect and phone                         |
| `openclaw`              | `devices approve <requestId>`; `gateway start`; `gateway install`; `gateway stop`; `gateway restart`                                            | this computer, confirmed                                 |
| `openclaw`              | `config set gateway.tailscale.mode serve` or `off`                                                                                              | this computer, confirmed                                 |
| `tailscale`             | `status --json`                                                                                                                                 | this computer, the Tailscale check                       |
| `/bin/bash`             | `<folder>/install/install-cli.sh --json --runtime-only --npm --version 2026.10.6 --prefix <folder>`                                             | install, macOS and Linux                                 |
| `<folder>/bin/openclaw` | `onboard --non-interactive --accept-risk --auth-choice skip --gateway-bind loopback --gateway-auth token --install-daemon --skip-skills --json` | install                                                  |
| `openclaw`              | `uninstall --service [--state --workspace] --yes --non-interactive`                                                                             | remove, cancel                                           |
| `powershell.exe`        | `-NoProfile -ExecutionPolicy Bypass -File <folder>\install.ps1 -Tag 2026.10.6 -NoOnboard`                                                       | install, Windows (the script from the release's tarball) |

`<ssh base>`: `-o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=<the user's default> <Clawtrate's file>" -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o ControlMaster=no -o ControlPath=none -o ForwardAgent=no -T`. It does not set `IdentitiesOnly`, `IdentityFile` or `IdentityAgent`: the person's own configuration and agent apply. On Windows, `ssh` is `%WINDIR%\System32\OpenSSH\ssh.exe`; ControlMaster is unsupported there and already off.

**Scripts over SSH** (rule 3) are constants in the host's source, each a few lines of POSIX `sh` run as `sh -lc '<script>' sh <args>` on the other computer, taking validated values as positional parameters only:

- LOOK: finds `openclaw` (Clawtrate's install there, `$HOME/.openclaw/bin/openclaw`, `command -v openclaw`), prints `uname -s`, `--version` and `gateway status --json` as JSON lines.
- CODE: `openclaw qr --json --limited --url "ws://127.0.0.1:$1"`.
- APPROVE: `openclaw devices approve "$1"`.
- START, STOP, RESTART, TAILSCALE, UNINSTALL, PHONE: the same pattern, one fixed OpenClaw command each.
- INSTALL copies the two verified scripts from the tarball to a new folder made with `mktemp -d` on that computer, through `ssh`'s standard input, then runs `install-cli.sh` there with the arguments of the table and `--prefix "$HOME/.openclaw"`.

**What the host keeps**: routes (section 2), each with its device token as `docs/decisions.md` keeps them, keyed by route; Clawtrate's own known-hosts file; a record of the gateways it installed or started, by route; nothing else. Program output is kept only as the last 20 lines of a failed step, with credentials removed.

**Telling a proxy refusal apart.** Node's `WebSocket` does not expose the status of a refused upgrade (research §3), so after a connect fails before any frame the host sends one plain HTTP upgrade request to the same address and reads its status: `403` with `proxy_attribution_required` is the proxy refusal of section 6.

**What `docs/decisions.md` gains** when package 2 is built (research §5): "Device tokens are scoped to one gateway URL" becomes "to one route": a URL for an address route; the host key's fingerprint, the resolved SSH target and the gateway's port on that computer for an SSH route (never the forward's local port); the gateway's port for this computer. "A credential never crosses gateways" stays word for word, and a new line says routes are grouped into one gateway by `gateway.identity.get` after each has authenticated, and that the grouping never moves a token.

### What the engine supplies

| Need                                         | Supplied by                                                                                                          | Notes                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Connect with a bootstrap token               | `packages/core` `connect({url, bootstrapToken})`, passing it to the pinned lifecycle's `buildPlan({bootstrapToken})` | Not stored; dropped after hello as the shared token is today |
| A device token per route                     | The token store keyed by route id instead of URL                                                                     | As above                                                     |
| The gateway's identity per route             | `gateway.identity.get`, already read                                                                                 | Groups routes (section 15)                                   |
| `PAIRING_REQUIRED`, the upgrade's request id | As today                                                                                                             | "Approve from here" uses them                                |
| The connection's state for the strip         | As today, plus the route's forward state from the host                                                               | "Restoring the connection to devbox"                         |

### Order

The six packages, in this order, each with its checks:

1. **This computer, found** (F-491 to F-494, F-515, F-516): the first screen; the look; the found card; Connect with a code made by the host; the bootstrap token in the core; "Advanced". Check: on a development instance started with `--default-local-pairing`, the device ends paired with `operator.read`, `approvedVia: "silent"`, and nothing in the state or log holds a token.
2. **Another computer over SSH** (F-495 to F-500): the field; the LOOK script; the three failures and the fingerprint; the forward and its life; "Approve from here". Checks against an `sshd` the test starts as its own user on a loopback port, as the research did.
3. **This computer, not found: install** (F-501 to F-505, F-514): the sheet; the steps from NDJSON; failures; cancel; the end; Remove. Checks: the step list driven by recorded NDJSON and onboarding JSON; a real install only on a hosted runner.
4. **A phone or a computer without SSH** (F-506 to F-509): Connect a phone; the address line; the loopback warning; the phone's request; the desktop's setup code; the iPhone's first screen.
5. **The Tailscale switch** (F-510 to F-512): with a stand-in `tailscale` on the test's own `PATH`.
6. **Several routes** (F-513): grouping by identity first; trying routes in order later.

### The prototype's states

`setup.html?screen=<id>`, with the shared `theme`, `width`, `motion` and `chrome` parameters. Each state's words and structure are checked by `tools/checks/setup.mjs`.

| `screen`                                                                                                             | Shows                                                                     |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `first`                                                                                                              | The first screen                                                          |
| `looking-here`                                                                                                       | Looking on this computer, second step running                             |
| `found`                                                                                                              | Running and answering, on this computer                                   |
| `stopped`, `start-confirm`                                                                                           | Installed, not running; Start's confirmation                              |
| `refusing`                                                                                                           | Running, refusing (remote mode)                                           |
| `notfound`                                                                                                           | Not on this computer                                                      |
| `older`, `newer`, `tooold`                                                                                           | Versions                                                                  |
| `several`                                                                                                            | Two gateways                                                              |
| `there`                                                                                                              | The SSH field, with a remembered computer                                 |
| `looking-there`                                                                                                      | Looking on devbox                                                         |
| `unreachable`, `refused`                                                                                             | Two failures                                                              |
| `hostkey`, `hostkey-changed`                                                                                         | A key not seen before; a changed key                                      |
| `found-there`                                                                                                        | Running on devbox                                                         |
| `connecting`                                                                                                         | Connecting over SSH, second step running                                  |
| `install-confirm`, `install-confirm-win`                                                                             | Before downloading; the Windows sheet                                     |
| `installing`, `install-failed`, `install-cancel`                                                                     | Steps; a failed step; cancel                                              |
| `approve`, `approve-confirm`                                                                                         | The access bar's Requested state with Approve from here; its confirmation |
| `restoring`                                                                                                          | The status strip while a forward is restored                              |
| `remove`                                                                                                             | Remove devbox from Clawtrate                                              |
| `uninstall`                                                                                                          | Remove OpenClaw                                                           |
| `phone`, `phone-loopback`, `phone-request`, `phone-expired`                                                          | Connect a phone                                                           |
| `code`                                                                                                               | A setup code on the desktop                                               |
| `iphone`, `iphone-waiting`                                                                                           | The iPhone's first screen; waiting for approval                           |
| `tailscale`, `tailscale-confirm`, `tailscale-missing`, `tailscale-signedout`, `tailscale-https`, `tailscale-foreign` | Private access with Tailscale                                             |
| `advanced`                                                                                                           | The address-and-token form under Advanced                                 |

## 20. Not covered here

- Setting OpenClaw up on a Windows computer over SSH, or on a computer that is neither macOS nor Linux; the look says so.
- Updating OpenClaw from Clawtrate. The look names the version and the command; the person runs it.
- Changing the gateway's bind to the local network from Clawtrate (`gateway.bind`). "Connect a phone" names it.
- A relay of Clawtrate's own: not in the first version.
- Trying several routes in order, and routes the gateway names itself (section 15).
- "Another computer" over SSH on iPhone.
- The pairing screen itself, which `visual-language.md` §10 keeps as it is.
