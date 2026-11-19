# Setting up

How a new person gets from a first launch to a connected, read-only Clawtrate: one question, "Where does OpenClaw run?", then Clawtrate looks there and says what it found. It replaces the address-and-token form as the first screen and keeps that form, unchanged, under "Advanced". This is the fourth part of the design, after `visual-language.md`, `conversation.md`, `bots.md` and `work-pane.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-491 to F-517 with F-001, F-003 and F-009. What the gateway, OpenClaw's installer and `ssh` do is in `docs/research/setup-flow.md`; every state below names the fact it rests on, and section 17 lists them. Section 19 is for builders.

The yardstick is one person's daily case: OpenClaw on a development box, the desktop app on a laptop, "Another computer", the SSH name of the box, and it works, with no Tailscale step, no token typed and no command run by hand on the box. Everything below is measured against that, and against a person who has never run OpenClaw.

This flow installs software, opens tunnels and approves access, so one rule sits above the rest: **where something cannot be proven safe from what is known, the app does less and says so.** A path that ends in "do this one step yourself; here is the exact command" is acceptable. A path that does something on a person's computer on a guess is not.

Four facts from the research shape the design:

- **A first pairing on the gateway's own computer, or through an SSH forward to it, is approved by the gateway without a prompt**, and ends with exactly the scopes the device asks for (research §1, §3).
- **Clawtrate does not read the gateway's shared token.** OpenClaw's commands refuse to show it to a program. The same user could read OpenClaw's configuration file, and the design deliberately does not. Instead the host makes a one-time setup code on the gateway's computer and redeems it at once (research §1, §3).
- **A setup code is a bearer credential with a ceiling, not a read-only credential.** On loopback a `--limited` code was redeemed for read and write when both were asked for. The narrowest code, `--voice-node`, was redeemed for read and refused write. Clawtrate makes only that kind, and the host asks for `operator.read` alone (research §3).
- **Asking for more than read access through `device.scopes.requestUpgrade` always waits for approval**, even on the gateway's own computer (research §2). Where Clawtrate runs programs there and the version is the tested one, it offers to run the gateway's own approve command for exactly that request, after the host's own confirmation.

The prototype walks every path to each of its outcomes: `prototype/setup.html`, with the state in the address (`prototype/README.md`). The styles are in `prototype/css/setup.css`, the behaviour in `prototype/js/setup.js`, and `prototype/tools/checks/setup.mjs` clicks through every walk and asserts where each click leads, as well as the words and structure of every state.

## Contents

1. How the pieces fit
2. Shared rules: safety, the host's confirmation, routes, components, input
3. The first screen
4. Looking on this computer: what "found" means
5. Another computer: the field, the SSH settings Clawtrate uses, the host key
6. What the look found
7. Connecting, with nothing typed
8. The forward's life
9. Approve from here
10. Setting OpenClaw up (macOS and Linux)
11. Removing OpenClaw, or leaving it
12. Connect a phone
13. A setup code on the desktop, and the iPhone's first screen
14. Private access with Tailscale
15. Several routes to one gateway
16. Widths, themes, keyboard, screen readers, motion
17. What each fact drives
18. Parity rows
19. For builders
20. Not covered here

## 1. How the pieces fit

```
first launch (desktop)            "Where does OpenClaw run?"
  This computer                     look here: find the gateway, its version and its state
  Another computer                  one field: an SSH host or alias, then look there over SSH
    first contact                     the host key, captured without signing in; the host confirms trust
  Have a setup code?                paste a code made on the gateway's computer; then approval there
  Advanced                          the address-and-token form, as it was (connect.html)
what the look found               one screen, one primary action, or none
  running, tested version           Connect: a one-time code made and used by the host; read-only
  running, untested version         Connect read-only; nothing run on that computer for the person
  installed, not running            Start OpenClaw (the host confirms)
  not there (macOS, Linux)          Set up OpenClaw (what is verified and what is not; the host confirms)
  not there (Windows)               not offered yet, with OpenClaw's own instructions
the app                           read-only; the status strip says when a forward is being restored
  access bar (bots.md §2)           "Approve from here" for exactly this device's request
  Settings, Gateway                 the route, Connect a phone, Private access with Tailscale, Remove
first launch (iPhone)             Scan or Paste a setup code; review the address; wait for approval
```

The first screen keeps what the old one had: the product's mark, the name, the slogan and the row of bots along the foot (`visual-language.md` §10). Only the form below the slogan changes.

## 2. Shared rules

### Safety, as rules

Written so that a builder cannot read them two ways. Every screen below obeys all of them, and section 19 says how.

1. **The interface gains no power.** It may ask the host to look and to connect this device read-only. Everything that changes any computer or gateway is an operation the host prepares, shows in its own confirmation dialog, and runs only after that dialog's answer (below). The interface cannot run one by calling the host.
2. **Every argument is validated before use** against the patterns of section 19, which never admit a leading `-`, spaces, quotes or shell characters. Anything else is refused before any program starts.
3. **SSH runs only with a configuration the host writes.** The host reads the person's SSH configuration as a file and takes a short list of settings from it (section 5). A host whose settings use anything else is refused by name. `ssh` is started with `-F <that configuration>` and the host's fixed options, so nothing in the person's files can run a command, forward another port or weaken host-key checking.
4. **Nothing typed and nothing received is ever interpreted by a shell.** On the other computer the remote command is always the constant `/bin/sh -s`, and the script arrives on its standard input. The script is a constant of the app; the only values in it are a port and a request id that the host itself read and validated. On this computer no shell is used at all.
5. **Read access first.** Every first connection asks for `operator.read` alone. A code the host makes for its own connection is never given to the interface, and the host checks that the gateway granted exactly `operator.read` before it keeps the device token. Codes Clawtrate makes are `--voice-node`, the narrowest ceiling OpenClaw offers.
6. **No credential in a log, a state snapshot, an error message, a process list or the interface,** on either computer: none in a program's arguments or environment, none in a temporary file. Program output is parsed by the host, in memory and within size limits, into typed facts; raw output is never kept or shown. There are three named exceptions, each deliberate. OpenClaw keeps an issued code in its own state until the code is used or expires; there is no command to revoke it. "Connect a phone" shows its code, because that is its purpose. A code the person pastes is in the interface because they typed it; it is sent to the host once, and never stored or logged.
7. **What another computer says is data.** Versions, ports, paths, addresses, names and messages are bounded in size, checked against the expected shape, and shown as text. A remote string never becomes a link, a command or a path the host runs.
8. **A host key is trusted only as one act**: the key the computer presented is captured without signing in, its fingerprint is shown, and those same key bytes are pinned after the host's confirmation. From then on the route accepts that key only. A changed key is never replaced by itself (section 5).
9. **Clawtrate removes and stops only what it owns**, and proves ownership first (section 11). A gateway, a service, a folder or a Tailscale route someone else made is never stopped, changed or removed.
10. **An untested OpenClaw version gets read-only access and nothing more.** Connect stays available, because read-only changes nothing. Start, Set up, Approve from here, Connect a phone and Private access with Tailscale show the exact command for the person to run instead of running it.

### The host's confirmation

Every operation that changes something is confirmed in a dialog the host draws itself (a native dialog on the desktop), never in the page. The page leads up to it: the screen says what will happen, and its button asks the host. The host then:

1. Prepares the operation from its own state: the exact computer (the name the person typed and the name the computer reported), the route, the gateway instance, the parameters, and the facts it observed in the last look.
2. Shows the dialog with those exact words. Some operations add a checkbox the person must tick first; replacing a host key is one.
3. On the answer, reads the facts again; if anything differs from what the dialog showed, nothing runs, and the page says "This changed since you looked. Look again."
4. Runs the operation once. The prepared operation expires after 2 minutes, cannot be repeated, and cannot be changed by the page.

| Operation                             | The dialog's message                  | Its detail                                                                                                  |
| ------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Trust a host key                      | Trust devbox's key?                   | The fingerprint; "Clawtrate will connect to devbox only while it presents this key."                        |
| Replace a trusted key                 | Replace devbox's trusted key?         | Both fingerprints; checkbox "I checked the new key on devbox itself"                                        |
| Start                                 | Start OpenClaw on devbox?             | The service's name; "It keeps running after Clawtrate closes."                                              |
| Set up                                | Set up OpenClaw on this computer?     | What is checked and what is not (section 10)                                                                |
| Approve                               | Approve this request on devbox?       | The gateway, the account, the device, and the exact scopes added (section 9)                                |
| Make a phone code                     | Make a one-time setup code on devbox? | "Anyone who has the code in the next 10 minutes can ask to connect. Nothing connects until you approve it." |
| Tailscale on or off                   | Turn on private access on devbox?     | What restarts, and what is put back on failure                                                              |
| Stop, remove a route, remove OpenClaw | Remove OpenClaw from devbox?          | The exact items, each by name (section 11)                                                                  |

The web preview host has no native dialogs, so it offers none of these operations. Looking and connecting read-only work everywhere.

### Routes

A **route** is how Clawtrate reaches one gateway: the unit Clawtrate saves, and the unit a device token is kept for (section 15, `docs/decisions.md`).

| Route         | Made by                          | Its identity                                                                                                         | A shell on the gateway's computer |
| ------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| This computer | "This computer"                  | The OpenClaw profile and its port                                                                                    | Yes, the host's own               |
| SSH           | "Another computer"               | The pinned host key, the resolved SSH target and the gateway's port on that computer; never the forward's local port | Yes, over SSH                     |
| Address       | "Have a setup code?", "Advanced" | The address                                                                                                          | No                                |

### Components used

| Component                                                                                | From                               | Used for                                                    |
| ---------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| The connection screen's column, mark, name, slogan and bots                              | `visual-language.md` §10           | Every setup screen                                          |
| Pill field (`.input`), primary, default and quiet buttons                                | `visual-language.md` §4            | Every control                                               |
| The pairing screen, its command block, copy button and waiting line                      | `visual-language.md` §10           | Commands, codes, waits, and a pasted code's pending pairing |
| Choice list (`.b-choices`), note (`.b-note`), switch (`.b-switch`), dialog (`.b-dialog`) | `bots.md` §2                       | The first question, notes, Settings                         |
| The access bar and its states                                                            | `bots.md` §2, `conversation.md` §3 | Asking for more access, with "Approve from here"            |
| The status strip                                                                         | `visual-language.md` §11           | A forward being restored; a route that changed              |
| Fact block (`.facts`)                                                                    | `visual-language.md` §9            | What was found                                              |

### New components

Each is defined once, in `prototype/css/setup.css`, from existing tokens.

| Component                               | What it is                                                                                                                                                                                                                                                                                                                                                                                             | Tokens                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Step list (`.s-steps`)                  | A vertical list of steps, each a 20 px mark and its words (15). Waiting: a hollow ring in `--text-faint`. Running: the working arc in `--text` (a still ring when motion is reduced) and, after 10 s, the elapsed time (13, faint, tabular). Done: a check in `--text-muted`. Failed: a cross in `--danger` with the step's words in `--danger`. A list, whose running step has `aria-current="step"`. | `--text`, `--text-faint`, `--danger` |
| Fingerprint (`.s-print`)                | A host key's fingerprint: its label (13, faint) over the value in mono, 14 px, in groups of eight, on `--bg-inset`, radius 14, with a copy button. Two of them side by side, or stacked on a phone, compare a pinned key with a new one.                                                                                                                                                               | `--font-mono`, `--bg-inset`          |
| Device code (`.s-device`)               | A device's id shown as two groups of four characters ("5AE2-3AFF"), mono, 17 px, so that two screens can be compared by eye.                                                                                                                                                                                                                                                                           | `--font-mono`                        |
| Found card (`.s-found`)                 | What the look found: a 44 px empty mark, a title (17/500), a fact block of at most five rows, and the screen's one primary action under it.                                                                                                                                                                                                                                                            | `--bg-bubble`                        |
| QR code (`.s-qr`)                       | A setup code's QR, black on white with a 16 px quiet zone in both themes, 200 px (176 on a phone), radius 14. In the prototype it is a sample picture, labelled "Sample".                                                                                                                                                                                                                              | `#000`, `#fff`                       |
| Countdown (`.s-expiry`)                 | "Expires at 20:41 (in 9 minutes)", 13, faint; `--warn` in the last minute.                                                                                                                                                                                                                                                                                                                             | `--text-faint`, `--warn`             |
| Host dialog (`.s-host`, prototype only) | The prototype's picture of the host's native confirmation: a small sheet with the app's icon, the message, the detail, an optional checkbox, and the buttons. It is a stand-in; the app shows a real native dialog.                                                                                                                                                                                    | `--bg-raised`, `--shadow-pop`        |

No new tokens.

### Input

- Every setup screen is one column; Tab follows reading order; the screen's primary action is the default button, so Enter in its one field is that action.
- Back is the first control of every screen that has somewhere to go back to, including every wait, and keeps what was typed: Back from "Looking on devbox" returns to the field with "devbox" still in it.
- In the first screen's choice list, Up and Down move between the two rows, and Home and End go to the ends.
- A screen that changes its content moves focus to its new title (`tabindex="-1"`), and the page's polite live region announces the title.
- A dialog keeps focus inside, makes everything behind it inert, closes with Escape (or Cancel), and returns focus to the control that opened it.
- Copy follows the pairing screen: a check for 1.5 s and "Copied."; when the clipboard refuses, the text is selected and the region says how to copy it.

## 3. The first screen

**Desktop, first launch, and whenever no gateway is saved** (F-001, F-491).

- The mark, "Clawtrate" (28/600), and "Your OpenClaw agents, orchestrated." (15, muted).
- "Where does OpenClaw run?" (17/500), the screen's heading.
- One choice list with two rows, each opening the next screen (a chevron at its end):
  - "This computer", with "Clawtrate looks for OpenClaw here." under it.
  - "Another computer", with "A computer you reach with SSH, such as a server or a desktop at home." under it.
- Under the list, two quiet links on one line: "Have a setup code?" and "Advanced". "Advanced" opens the address-and-token form exactly as it was built (`connect.html`, F-493).
- One hint (13, faint): "New to OpenClaw? Choose where it should run, and Clawtrate offers to set it up there." On Windows the hint is "New to OpenClaw? Choose Another computer to use or set up OpenClaw on a Mac or a Linux computer." (section 10).

The person never chooses between "I already use OpenClaw" and "I am new to OpenClaw"; those are the two results of the look (section 6). The row of bots stands along the foot as before, and is hidden below 640 px of height.

## 4. Looking on this computer: what "found" means

"This computer" starts the look at once. There is nothing to confirm, because looking changes nothing.

**Which gateways the look covers.** OpenClaw's default profile, and the profile Clawtrate installs (`clawtrate`, section 10). Other profiles can be reached with "Advanced"; the look names them when it sees them (below), and does not connect to them.

**What the host runs**, each with its own time limit, all read-only, never through a shell:

| Step                                  | Program and arguments                                                                                                                                                                                                                                                                                                                      | Limit                 | Gives                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find OpenClaw                         | The first of these that exists and is a regular executable file: Clawtrate's own install (`<app data>/openclaw/bin/openclaw`), `~/.openclaw/bin/openclaw`, `/opt/homebrew/bin/openclaw`, `/usr/local/bin/openclaw`, `~/.local/bin/openclaw`, `~/.npm-global/bin/openclaw`. On Windows: `%APPDATA%\npm\openclaw.cmd`, then the npm prefix's | 2 s                   | A path from that list, or none                                                                                                                    |
| Version                               | `openclaw --version`                                                                                                                                                                                                                                                                                                                       | 10 s                  | `OpenClaw 2026.10.6 (fe06181)`, checked against the shape `OpenClaw <yyyy>.<m>.<d>`                                                               |
| The gateway                           | `openclaw gateway status --json` (and with `--profile clawtrate` when that install exists)                                                                                                                                                                                                                                                 | 20 s; 60 s on Windows | The service (label, loaded, state), the gateway's port and bind, auth mode, the config path, `rpc.ok` and the version the running gateway reports |
| Other gateways                        | `openclaw gateway status --json --deep`, read for `extraServices` only                                                                                                                                                                                                                                                                     | 20 s                  | Names of other OpenClaw services, shown and not used                                                                                              |
| Signs of OpenClaw without its program | Whether `~/.openclaw` exists and whether a service named `ai.openclaw.gateway`, `openclaw-gateway.service` or `OpenClaw Gateway` is registered                                                                                                                                                                                             | 2 s                   | Whether OpenClaw seems set up                                                                                                                     |

**What "found" means.** A gateway is found when all of these are known: which profile (`default` or `clawtrate`), its config path, its service and whether it runs, its port and bind, its auth mode, and an `rpc.ok` answer that carries its version. Anything less is one of the other results of section 6, and nothing is offered on it but what that result allows. A program that answers `--version` is not a gateway; a running service is not a gateway that answers.

**The results**, from what the steps gave:

| Result                  | When                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Running, tested         | Found, and the running gateway's version is 2026.10.6                                                                    |
| Running, untested       | Found, with another version                                                                                              |
| Too old                 | The version is below the oldest that speaks this client's protocol, or the handshake is refused with a protocol mismatch |
| Installed, not running  | A program and a registered service, but no answer on its port                                                            |
| Set up, program missing | No program in the list, but `~/.openclaw` or the service exists                                                          |
| Can't tell              | A step timed out, or a program answered with something of the wrong shape                                                |
| Not set up              | No program, no `~/.openclaw`, no service                                                                                 |
| Not token sign-in       | Found, but `gateway.auth.mode` is `password`, `none` or `trusted-proxy`                                                  |

**What the person sees** in place of the choice list: Back, the title "Looking on this computer", and a step list: "Finding OpenClaw", "Checking its version", "Asking the gateway". It usually takes one to three seconds. After 8 s the screen adds "Still looking. A gateway that has just started can take a while to answer." Back stops the look; the host ends its programs by PID.

## 5. Another computer: the field, the SSH settings Clawtrate uses, the host key

**The field** (F-495). Back, the title "Another computer", and one pill field labelled "SSH host or alias", with the placeholder "devbox or you@devbox.example". Under it (13, faint): "Clawtrate uses your SSH keys and the host's settings from your SSH configuration, and never asks for a password." The primary button is "Look there", and under it a quiet link, "Have a setup code instead?".

- **Accepted**: an alias from the person's SSH configuration, a host name, or `user@host`, matching the pattern of section 19. A value that fails says "That isn't an SSH host or alias Clawtrate can use." under the field, and nothing runs.
- **Remembered computers**, at most three, appear above the field only once one has worked: rows such as "devbox" with "OpenClaw 2026.10.6 · last used today".

**The SSH settings Clawtrate uses.** The host reads the person's SSH configuration file (`~/.ssh/config` and the files it includes) as text, finds the `Host` block for the name typed, and takes only these settings from it: `HostName`, `User`, `Port`, `IdentityFile`, `IdentitiesOnly` and `CertificateFile`. It then writes its own configuration with those values and its fixed options (section 19), and starts `ssh -F <that file>`. `ssh -G` is not used, because it evaluates `Match exec`.

A block that uses any other setting that matters is refused before anything connects, and the screen says which setting and why. These are refused: `Match`, `ProxyCommand`, `ProxyJump`, `LocalCommand`, `PermitLocalCommand`, `LocalForward`, `RemoteForward`, `DynamicForward`, `SendEnv`, `SetEnv`, `ForwardAgent`, `ForwardX11`, `StrictHostKeyChecking`, `UserKnownHostsFile`, `GlobalKnownHostsFile`, `KnownHostsCommand`, `UpdateHostKeys`, `HostKeyAlias`, `ControlMaster`, `ControlPath`, `RemoteCommand` and `Include` inside a matching block.

| Refused setting                                                                               | The note                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProxyJump`, `ProxyCommand`                                                                   | **devbox is reached through another computer.** "Clawtrate doesn't connect through jump hosts yet. Use a setup code made on devbox, or Advanced."                                                   |
| A command or a forward (`LocalCommand`, `RemoteCommand`, `*Forward`, `Match`)                 | **devbox's SSH settings run a command or open other forwards.** "Clawtrate only opens one forward, with no commands of yours. Add a plain alias for devbox to your SSH configuration and use that." |
| Host-key settings (`StrictHostKeyChecking`, `*KnownHosts*`, `UpdateHostKeys`, `HostKeyAlias`) | **devbox's SSH settings change how its key is checked.** "Clawtrate checks host keys its own way. Add a plain alias for devbox and use that."                                                       |

The key agent the person already runs is used to sign in (it is not forwarded). A key with a passphrase works only through that agent: `BatchMode` never prompts.

**The look over SSH.** Back, the title "Looking on devbox", and a step list: "Reaching devbox", "Finding OpenClaw", "Checking its version", "Asking the gateway". The host runs `ssh -F <its file> <fixed options> -- devbox /bin/sh -s` with the LOOK script on standard input (section 19). The script looks only in fixed places, like section 4, prints one JSON line per fact, and stops after 30 s. The host reads at most 64 KiB of its output and validates each fact.

**The three failures.** `ssh` exits with 255 for all three; the host tells them apart from its error output, in memory, and keeps only the category and the one cause in brackets (research §7). Each failure replaces the step list with a note, and the field stays filled.

| Failure                | Note (title, then sentence)                                                                                                                                                            | Next                                                                                                                                                                      | Actions                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Cannot be reached      | **Can't reach devbox** · "Nothing answered at devbox.example (connection refused)." The words in brackets are one of: connection refused, no such name, timed out, network unreachable | "Check the name and that the computer is on."                                                                                                                             | "Try again" (primary), Back |
| Sign-in refused        | **devbox didn't accept your key** · "The SSH sign-in for you@devbox.example was refused."                                                                                              | "Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first." On Windows, add "Turn on the OpenSSH Authentication Agent service." | "Try again" (primary), Back |
| Host key not known yet | Below                                                                                                                                                                                  |                                                                                                                                                                           |                             |

**First contact: the key, as one act** (rule 8). When the computer's key is in neither Clawtrate's own file nor the person's known-hosts file, the host connects once more with `StrictHostKeyChecking=accept-new` into an empty capture file, under the route's own alias, and with `PreferredAuthentications=none`. The key exchange completes, `ssh` writes the key the computer presented to the capture file, and the sign-in is never attempted, so nothing of the person's is offered to an unverified computer (research §7.2). The screen then shows:

- the title "Is this devbox?", and "This is the first time Clawtrate connects to devbox. Its key is below. If you can, compare it with the key devbox itself shows before you trust it."
- the fingerprint of that captured key: "ED25519" over `SHA256:Q3v8Lw0e Xk2Rj9Ta Nf5Hc1Ub Ym7Pd4Gs Zi6Ko2Ea Vr8`.
- a disclosure, "How to compare": "On devbox, in a session you already trust, `ssh-keygen -lf` with the key file shows its fingerprint. The file depends on the key's type, for example `/etc/ssh/ssh_host_ed25519_key.pub`."
- the primary button "Trust this key…", which asks the host (the dialog "Trust devbox's key?"), and the default button Back.

On confirmation the host moves exactly the captured line into Clawtrate's own known-hosts file, under the route's alias. Every later connection runs with `StrictHostKeyChecking=yes` and that file alone, so it accepts that key only. Then the look continues.

**A key the person already trusts.** When the person's known-hosts file already trusts devbox, the strict connection succeeds and nothing is asked. `ssh -v` names the file and line that matched ("Found key in …:2"), and the host copies exactly that line into its own file under the route's alias, so the route is pinned from then on (research §7.2).

**A changed key.** A `--danger` note, **devbox's key has changed**: "The key devbox presented is not the one Clawtrate trusted. This happens when a computer is reinstalled, and it is also what someone between you and devbox would cause. Clawtrate won't connect until you decide." The host captures the new key the same way, without signing in. The screen shows both fingerprints, "Trusted" and "Presented now", with the date the trusted one was pinned. Actions: "Try again" (primary) and Back, and, as a quiet button, "Replace the trusted key…". That opens the host's dialog "Replace devbox's trusted key?", with both fingerprints and the checkbox "I checked the new key on devbox itself"; Replace stays unavailable until it is ticked. Nothing ever replaces the key by itself, and a key in the person's own known-hosts file is never edited.

## 6. What the look found

One screen for both computers. The title says where ("On this computer", "On devbox"), a found card says what was found, and there is one primary action, or none.

| Result                        | Card                                                                                     | Facts                                                                                                                                                                                                                                                                           | Primary                                                                                                      | Also                                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Running, tested**           | A check mark, "OpenClaw is running"                                                      | Version "2026.10.6"; Profile "default"; Listens "On this computer only" ("On devbox only"); Service per system: "LaunchAgent, starts when you log in" (macOS), "systemd user service, starts with your session" (Linux), "Scheduled Task" (Windows), or "None, started by hand" | "Connect"                                                                                                    | "Connect pairs this computer with the gateway as a device that can only read, and the gateway keeps it. Sending or changing anything is asked for later." (13, faint) |
| **Running, untested**         | The running card, with a `--warn` note                                                   | "OpenClaw 2026.9.37 isn't the version this Clawtrate is tested with (2026.10.6). Clawtrate connects read-only, and won't run commands on this computer for you until the versions match."                                                                                       | "Connect read-only"                                                                                          | "How to update" opens a disclosure with `openclaw update` and "Run it yourself when you're ready."                                                                    |
| **Too old**                   | A cross mark, "This OpenClaw is too old for Clawtrate"                                   | "OpenClaw 2026.6.2 speaks an older protocol than Clawtrate needs. Update it, then look again."                                                                                                                                                                                  | "Look again"                                                                                                 | "How to update"                                                                                                                                                       |
| **Installed, not running**    | A pause mark, "OpenClaw is installed but not running"                                    | Version; Service: "LaunchAgent, stopped"                                                                                                                                                                                                                                        | "Start OpenClaw" (the host confirms; untested version: the command `openclaw gateway start` to run yourself) |                                                                                                                                                                       |
| **Set up, program missing**   | A warning mark, "OpenClaw seems to be set up here, but Clawtrate can't find its program" | "Clawtrate looked in the usual places. If you installed OpenClaw somewhere else, use Advanced, or run `openclaw gateway status` here to see where it is."                                                                                                                       | none                                                                                                         | Back                                                                                                                                                                  |
| **Can't tell**                | A warning mark, "Clawtrate couldn't tell what is on this computer"                       | "Asking the gateway didn't finish in time." or "OpenClaw answered in a way Clawtrate doesn't understand."                                                                                                                                                                       | "Look again"                                                                                                 |                                                                                                                                                                       |
| **Not set up** (macOS, Linux) | An empty mark with a plus, "OpenClaw isn't on this computer" ("isn't on devbox")         | none                                                                                                                                                                                                                                                                            | "Set up OpenClaw here" ("Set up OpenClaw on devbox")                                                         | "It runs on another computer" (quiet)                                                                                                                                 |
| **Not set up** (Windows)      | An empty mark, "OpenClaw isn't on this computer"                                         | "Clawtrate doesn't set OpenClaw up on Windows yet: OpenClaw's Windows installer changes this computer's Node.js, npm and PATH, which Clawtrate won't do for you."                                                                                                               | "Use another computer"                                                                                       | A link, "OpenClaw's own install instructions", which opens docs.openclaw.ai in the browser                                                                            |
| **Not token sign-in**         | A warning mark, "This gateway uses another way to sign in"                               | "Clawtrate connects by itself only to gateways that use a token. Use Advanced."                                                                                                                                                                                                 | none                                                                                                         | "Advanced"                                                                                                                                                            |
| **Other gateways seen**       | Under any card, a neutral note                                                           | "Clawtrate also saw another OpenClaw service here (OpenClaw Gateway (work)). It connects only to the default gateway and its own; use Advanced for others."                                                                                                                     |                                                                                                              |                                                                                                                                                                       |

**Start OpenClaw** (F-497). The host's dialog: "Start OpenClaw on this computer?", with the detail "Starts the LaunchAgent ai.openclaw.gateway. It keeps running after Clawtrate closes." On confirmation: a step list, "Starting the gateway" and "Asking the gateway", then the running card. If it doesn't come up, a `--danger` note: "**OpenClaw didn't start.**" and the classification in words (`service-missing`: "The service isn't installed."; `startup-blocked`: "The gateway reported a problem when starting."; `not-listening`: "Nothing is listening yet."), with "Try again". The host records that it started this gateway (rule 9).

## 7. Connecting, with nothing typed

"Connect" on a running gateway of the tested version (F-492, F-496).

**On this computer:**

1. The host runs `openclaw qr --json --voice-node --url ws://127.0.0.1:<port>`, `<port>` from the look. It parses the result in memory, decodes the code's bootstrap token, and checks the code's address is exactly that loopback address.
2. The host's client connects to `ws://127.0.0.1:<port>` with that bootstrap token, asking for `operator.read`.
3. The gateway approves the first pairing without a prompt and returns a device token. The host checks that the granted scopes are exactly `["operator.read"]`; any other grant closes the connection, and Connect fails as "The gateway granted more than read access, so Clawtrate disconnected." The bootstrap token is forgotten.
4. The host reads `gateway.identity.get` and records it with the route. Bots load, and the app opens read-only.

**Over SSH**, the same, with two differences. The code is made on devbox by the CODE script through the pinned connection, and before step 2 the host starts the forward (`ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<port>`, section 8) and connects through it.

**What the person sees.**

- On this computer: Back, the title "Connecting", and a step list: "Making a one-time code", "Pairing this computer, read-only", "Loading your bots".
- Over SSH: Back, the title "Connecting to devbox", and a step list: "Making a one-time code on devbox", "Opening a private connection to devbox", "Pairing this computer, read-only", "Loading your bots".

It takes one to three seconds; then the app opens read-only, with the access bar where a write would be (`conversation.md` §3). Back during connecting stops it and returns to the found card. If the device was already paired by then, it stays paired and the next Connect reuses it.

**The shared token** stays in OpenClaw's configuration on the gateway's computer. Clawtrate never reads it and never asks for it outside "Advanced", where the person may type it themselves (F-494).

**If the gateway asks before every device** (`gateway.nodes.pairing.autoApproveLocal: false`): the connect returns `PAIRING_REQUIRED`, and the pairing screen of `visual-language.md` §10 appears, with "Approve from here" on a route with a shell (section 9).

**Failures** (F-009, F-492):

| Fact                                                  | Note                                                                                      | Actions      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------ |
| `openclaw qr` failed                                  | **Couldn't make a one-time code.** "OpenClaw said: <its message, at most 200 characters>" | "Try again"  |
| The code was refused (`AUTH_BOOTSTRAP_TOKEN_INVALID`) | **The one-time code didn't work.** "Clawtrate makes a new one when you try again."        | "Try again"  |
| More than read was granted                            | **The gateway granted more than read access, so Clawtrate disconnected.**                 | Back         |
| The forward could not start                           | the SSH failure of section 5                                                              | as there     |
| Nothing answered on the port                          | **Nothing answered on port 18789.** "The gateway may have just stopped."                  | "Look again" |
| The pairing was rejected or expired                   | the pairing screen's own states (F-009)                                                   | as there     |

## 8. The forward's life

Each SSH route has one forward, owned by the host: one `ssh -N -L` process per route, started on connect, its PID recorded, always with the pinned key (F-498, F-499).

| Event                                          | What `ssh` does (research §7)                                                               | What the host does                                                                                                                                                                                     | What the person sees                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The computer sleeps, or the network changes    | Exits 255 with "Timeout, server … not responding." or "Connection … closed by remote host." | Starts the forward again at once on wake or on a network change, otherwise after 1, 2, 4, 8 and 16 s, then every 30 s; each time with the pinned key, and after hello it checks the gateway's identity | The status strip: **Restoring the connection to devbox** · showing saved messages, with "Retry now"; then **Connected to devbox again** for 4 s |
| The local port was taken meanwhile             | Exits 255, "Address already in use"                                                         | Picks another free port and starts again                                                                                                                                                               | Nothing more                                                                                                                                    |
| devbox stops answering for good                | Exits 255 each time                                                                         | Keeps the backoff                                                                                                                                                                                      | After 2 minutes, **Can't reach devbox** · the cause, with "Retry now"                                                                           |
| The key changed                                | Exits 255, "REMOTE HOST IDENTIFICATION HAS CHANGED"                                         | Stops retrying                                                                                                                                                                                         | **devbox's key has changed**, with "Review", which opens section 5's screen                                                                     |
| A different gateway answers (another identity) |                                                                                             | Disconnects, and drops this route's device token                                                                                                                                                       | **This address now leads to a different gateway**, with "Review"                                                                                |
| The gateway on devbox stopped                  | The forward stays up; each connection through it fails                                      | Runs the LOOK script once                                                                                                                                                                              | **OpenClaw stopped on devbox**, with "Start" (the host confirms)                                                                                |
| Clawtrate quits                                |                                                                                             | Ends its `ssh` processes by PID                                                                                                                                                                        |                                                                                                                                                 |

**Removing the route** (Settings, Gateway, "Remove this gateway…") goes through the host's dialog "Remove devbox from Clawtrate?", with the detail "Clawtrate disconnects, forgets this route and its pinned key, and leaves OpenClaw on devbox running." When Clawtrate's record says it started or installed that gateway, the dialog adds a checkbox, unticked: "Also stop OpenClaw on devbox (Clawtrate started it)." The forward is stopped by its PID; the gateway is stopped only with the box ticked, and never when Clawtrate didn't start it.

## 9. Approve from here

Offered wherever the gateway waits for its owner, the route has a shell, and the version is the tested one (F-500): the access bar's "Requested" state (`bots.md` §2), the pairing screen of section 7, and a phone's request (section 12).

**Binding.** "Approve from here" approves one request: this request id, for this device, for these scopes, on this gateway, or nothing.

- The request id comes from the gateway's own answer on this device's connection (`device.scopes.requestUpgrade`, or `PAIRING_REQUIRED`), or, for a phone, from the request the person picked by its device code (section 12).
- Before the host's dialog, the host reads `openclaw devices list --json` on that computer. It requires a pending entry with that exact request id, whose device id is this device's (or the phone's that was picked), whose client is `gateway-client`, and whose scopes are exactly the scopes shown.
- It also requires that the gateway's identity, read over the route, is the one recorded for it.
- Any difference ends it: "The request on devbox isn't the one shown here any more. Nothing was approved."

**What the page shows.** Under the command block, a default button, **"Approve from here"**, and above it one sentence of what to check first: "Check that the request is yours: this computer's device code is 5AE2-3AFF."

**The host's dialog**, "Approve this request on devbox?", lists:

- the gateway (its name and identity, "devbox · gateway c5fd-e286"), and the account the command runs as ("you on devbox.example");
- the device asking ("Clawtrate Desktop · 5AE2-3AFF, this computer");
- the scopes it adds, one line each, in the access bar's words: "Send messages and stop runs", "Answer questions", "Approve actions" for the interactive tier; "Change bots, accounts and settings" for admin; "Read bots, tasks and conversations" for a first pairing.

**On confirmation** the host reads the list again and checks the same entry. It then runs `openclaw devices approve <requestId>` once (the APPROVE script over SSH) and checks the output's one line, `Approved <deviceId> (<requestId>)`. The waiting line finds the approval as it always does. If the command fails, a `--danger` note says "**Couldn't approve.**" and the command stays there to run by hand.

**Untested version, or an address route**: no button. The command block stays, with "Run this on devbox." over it.

## 10. Setting OpenClaw up (macOS and Linux)

"Set up OpenClaw here" or "Set up OpenClaw on devbox" (F-501 to F-505). Offered on macOS (Apple silicon and Intel) and on Linux with glibc (x64 and arm64), on this computer or over SSH. Elsewhere, including Windows, Alpine and other musl Linux, and FreeBSD, the not-set-up card says what is offered instead (section 6, F-517).

**What Clawtrate owns.** An install is Clawtrate's when all four of these are true, and removal and rollback rely on nothing else (section 11):

- **A program folder of its own**, `<app data>/openclaw` on this computer and `~/.local/share/clawtrate/openclaw` on devbox. It is created empty by the install, and holds a record, `.clawtrate-install.json`, with the install's id, the version and the profile.
- **An OpenClaw profile of its own**, `clawtrate`: its state is `~/.openclaw-clawtrate`, which holds an owner file, `.clawtrate-owner.json`, with the same id, written after onboarding. Its service is the profile's own: `ai.openclaw.clawtrate` (LaunchAgent), `openclaw-gateway-clawtrate.service` (systemd user unit). Its port is one the host picked free.
- **Clawtrate's own record** of that install: the computer, the id, the folders, the service and the port.
- **Nothing there before.** The install refuses to start if either folder or the service already exists: "Something named clawtrate is already set up on devbox. Clawtrate won't change it."

A default OpenClaw (`~/.openclaw`, `ai.openclaw.gateway`) is never touched: proven on both systems with a decoy default folder that came through install and removal unchanged (research §6.8).

**What is verified, and what isn't** (rule 1; research §6.8). Before anything runs, the host downloads two files and checks each against a hash built into this Clawtrate: OpenClaw 2026.10.6's npm tarball (its published `sha512` integrity) and Node.js 24.22.1 for the computer's system (its published SHA-256). It takes OpenClaw's own installer, `install-cli.sh`, out of that checked tarball. It puts the checked Node.js where the installer looks first, and has the installer install the checked tarball itself, not a version fetched again. npm then downloads the packages OpenClaw depends on, 345 of them, from the npm registry. Their versions are chosen by npm and Clawtrate can't check them. npm's own configuration is replaced by empty files for this install, so a registry or a setting of the person's isn't used. If the installer's Node.js step doesn't report that it used the checked Node.js, the install stops and is removed.

**Before anything is downloaded** (F-501): the title "Set up OpenClaw on this computer" ("on devbox"), and a fact block:

|             |                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What        | "OpenClaw 2026.10.6, the version this Clawtrate is tested with, with its own copy of Node.js 24.22.1"                                                                                                                                      |
| Where       | "Its own folders: the program in Clawtrate's folder, the gateway's data in ~/.openclaw-clawtrate. An OpenClaw you already have isn't touched." (devbox: "~/.local/share/clawtrate/openclaw and ~/.openclaw-clawtrate on devbox")           |
| Checked     | "OpenClaw and Node.js are checked against fingerprints built into this Clawtrate before anything runs."                                                                                                                                    |
| Not checked | "npm then downloads about 345 packages OpenClaw uses from the npm registry. Clawtrate can't check those."                                                                                                                                  |
| Then        | "A gateway that listens on this computer only, as a LaunchAgent that starts when you log in, with no AI provider yet. You sign in to one when you make your first bot." (Linux: "as a systemd user service that starts with your session") |

Under the facts (13, faint): "Nothing is asked for: no account and no model key." and "OpenClaw keeps running if you remove Clawtrate. Remove it in Settings first if you want it gone." Then "Set up OpenClaw…" (primary), which opens the host's dialog repeating what is checked and what isn't, and "Cancel".

**Over SSH** the host copies the two checked files and the two installer scripts to a new folder made with `mktemp -d` on devbox, through the pinned connection's standard input. devbox downloads nothing from Clawtrate's side; it fetches only npm's packages. devbox needs `tar` and a SHA-256 tool; the look reports both (section 19).

**The steps** (F-502), title "Setting up OpenClaw":

| Step                                    | What the host runs (section 19)                                                                                                                                                                                  | Its failure, in words                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| "Download and check OpenClaw 2026.10.6" | Fetches the tarball and Node.js and checks both hashes                                                                                                                                                           | "The download didn't finish." · "A download didn't match the fingerprint built into Clawtrate, so nothing was installed." |
| "Install Node.js and OpenClaw"          | `install-cli.sh --json --runtime-only --npm --version <the checked tarball> --prefix <program folder>`; its NDJSON events drive the step's line ("Node.js 24.22.1, checked", "OpenClaw 2026.10.6, 345 packages") | The installer's `error` event, as text, at most 200 characters; or "The installer didn't use the checked Node.js."        |
| "Set up the gateway"                    | `openclaw --profile clawtrate onboard --non-interactive --accept-risk --auth-choice skip --gateway-bind loopback --gateway-auth token --gateway-port <port> --install-daemon --skip-skills --json`               | The result's `classification` in words, as in section 6                                                                   |
| "Start and check"                       | `openclaw --profile clawtrate gateway status --json` until `rpc.ok` with version 2026.10.6, at most 60 s                                                                                                         | "The gateway didn't answer after it was set up."                                                                          |
| "Connect"                               | Section 7                                                                                                                                                                                                        | Section 7                                                                                                                 |

The step list shows elapsed time after 10 s on the running step. An install takes about a minute (research §6.2, §6.8; the times in the prototype are samples).

**A failed step** is drawn failed, the steps after it stay waiting, and a `--danger` note under the list says "**<the step's words> failed.**" and the cause. "Show details" opens the step's typed record: step, exit status, and the last installer event, as text. The actions are "Try again" (primary), which first removes what this attempt made (below), and "Cancel".

**Cancel**, at any point before "Connect", goes through the host's dialog "Stop setting up OpenClaw?", with the detail "Clawtrate stops the installer and removes the folders and the service this setup made. Nothing else is touched." The host ends the installer's whole process group, which it started and whose id it recorded in the program folder (over SSH, through the CANCEL script). It then re-checks ownership (section 11) and removes only what this attempt made. A partial result is reported item by item.

**The end** (F-505): every step done, then the app opens read-only on the new gateway, with no bots yet. The rail's empty state leads to `bots.md`'s "New bot", where the first sign-in happens (F-504).

## 11. Removing OpenClaw, or leaving it

**Settings, Gateway** shows, for a gateway Clawtrate installed: "Installed by Clawtrate · OpenClaw 2026.10.6 · LaunchAgent ai.openclaw.clawtrate", and a quiet danger button "Remove OpenClaw…" (F-514). For any other gateway there is no such button.

**Ownership, proven again before anything is removed.** All of these must hold, or nothing is removed and the page says "Clawtrate can't prove it installed this OpenClaw, so it won't remove it.":

- the install record in the program folder, the owner file in the profile's state folder and Clawtrate's own record carry the same id;
- the profile is `clawtrate`;
- the service's label is the profile's own;
- the service's command runs the program in Clawtrate's program folder.

**The page** names the computer by both its names: the title "Remove OpenClaw from devbox?" and "devbox.example, which reports its name as devbox-1." It lists exactly what will be removed:

- "The service ai.openclaw.clawtrate"
- "The program in ~/.local/share/clawtrate/openclaw"
- "The gateway's settings, bots and conversations in ~/.openclaw-clawtrate"

A checkbox, unticked: "Keep the gateway's settings, bots and conversations". Ticked, the third line is struck out. The button "Remove…" opens the host's dialog with the same list.

**What runs**: `openclaw --profile clawtrate uninstall --service --yes --non-interactive`, with `--state --workspace` unless Keep is ticked, then removal of the program folder. Then the host checks each item and reports exactly what is left:

| Left                                                                      | The report                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Nothing                                                                   | "OpenClaw is removed from devbox."                                           |
| The LaunchAgent's file in the Trash (macOS moves it there, research §6.8) | "OpenClaw is removed. macOS moved its service file to your Trash."           |
| An empty folder (seen on Windows, research §6.6)                          | "OpenClaw is removed. An empty folder is left: ~/.openclaw-clawtrate."       |
| The service, a folder that isn't empty, or a log file                     | "Part of OpenClaw is still on devbox:" and each item by name, with its path. |

**Leaving it**: removing the Clawtrate app does not remove OpenClaw. The install's sheet says so once.

## 12. Connect a phone

**Where**: Settings, Gateway, "Connect a phone", and the gateway menu (F-506). A dialog, 440 px, titled "Connect a phone".

**Making the code is explicit.** The dialog opens with one sentence, "Make a one-time code that Clawtrate on your iPhone can scan. It works once, for 10 minutes, and it can only ask to read.", and the primary button "Make a code…", which opens the host's dialog. Nothing is made by opening the dialog.

**Where the code comes from**, in this order:

1. A route with a shell, tested version: `openclaw qr --json --voice-node` on the gateway's computer, without `--url`, so that OpenClaw chooses the address a phone can use: its Tailscale address when OpenClaw serves one, a configured public address, or a network address when it listens on one.
2. No shell, on a connection that holds `operator.admin`: `device.pair.setupCode {bootstrapProfile: "voice-node", includeQr: false}`.
3. Neither: the access bar, "**Admin access needed.** Making a code needs admin access when Clawtrate can't run OpenClaw on the gateway's computer.", with "Request admin access".

**The code.** A line saying where it leads, then the QR, "Open Clawtrate on your iPhone and scan this code.", the code in mono with its copy button, and the countdown "Expires at 20:41 (in 9 minutes)". When it runs out: "This code has expired." and "Make a new code…". A code can't be withdrawn; closing the dialog says "The code stops working by itself at 20:41." (rule 6).

**Where it leads, in plain words.** The line describes the address. It makes no promise about reaching it: the app cannot test from the phone.

| The code's address                         | Line                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wss://` on a Tailscale name               | "This code leads to devbox.tailnet.example, through Tailscale. Your phone needs Tailscale on."                                                         |
| `wss://` elsewhere                         | "This code leads to gateway.example, over an encrypted connection."                                                                                    |
| `ws://` on a local name or network address | "This code leads to devbox.local on your local network. The connection isn't encrypted until the phone is paired; use it only on a network you trust." |

**Loopback only.** When OpenClaw answers that the gateway listens only on loopback, no code is made. A `--warn` note says "**A phone can't reach this gateway yet.** It only listens on devbox itself." It is followed by two ways forward:

- "Turn on private access with Tailscale" (section 14);
- "Or let OpenClaw listen on your local network. Run these on devbox yourself:", with the commands `openclaw config set gateway.bind lan` and `openclaw gateway restart`, and under them "Anyone on that network can then reach the gateway's sign-in; it still needs a token or a pairing." Clawtrate doesn't change the gateway's bind for you.

**Waiting for the phone, and binding it.** While a code is shown on a route with a shell, the host reads `openclaw devices list --json` every 3 s. A pending request from a `gateway-client` device, made after the code, appears as a row: "iPhone · 7C41-D2E0", "Asks to read bots, tasks and conversations", with "Approve…" and "Not now". Above the rows: "Check that the device code matches the one on your iPhone." The phone shows its own device code on its waiting screen (section 13).

- A request that asks for more than read is shown with "Asks for more than read access. Clawtrate won't approve it here.", and without "Approve…".
- "Approve…" is section 9 with that request id and that device. Then: "iPhone connected, read-only."

Without a shell, the line is "Approve the phone on devbox with `openclaw devices approve` and the request id `openclaw devices list` shows."

## 13. A setup code on the desktop, and the iPhone's first screen

**On the desktop** (F-508): "Have a setup code?" on the first screen, and "Have a setup code instead?" under the SSH field. Back, the title "Use a setup code", and one field (mono, three lines), labelled "Setup code", with the placeholder "Paste a code from openclaw qr or from Connect a phone". The field's text goes to the host once, which decodes it. A code is not sent to any computer before Connect, and it is never stored or logged.

The line under the field says what the host found, and Connect follows it:

| The host found                                                                                     | Line                                                                                          | Connect     |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------- |
| A code, with a `wss://` address, not expired                                                       | "Connects to gateway.example, over an encrypted connection. Expires at 20:41."                | Available   |
| A code, with a `ws://` network address                                                             | "Connects to devbox.local on your local network, unencrypted until paired. Expires at 20:41." | Available   |
| A code, with a loopback address                                                                    | "This code leads to the computer it was made on, 127.0.0.1. It works only there."             | Unavailable |
| Expired                                                                                            | "This code has expired. Make a new one on the gateway's computer."                            | Unavailable |
| Not a code, or an address with a user name, a path elsewhere, or a scheme other than `ws` or `wss` | "That isn't a setup code Clawtrate can use."                                                  | Unavailable |

Off loopback the gateway does not approve a device by its code alone (research §3), so Connect ends on the pairing screen: "Approve this device", with the gateway's approve command, the request id and this computer's device code (`visual-language.md` §10). This is a first pairing of this device, read-only. It is not a request for more access. When it is approved, the app opens read-only.

**On iPhone** (F-001, F-507), first launch:

- The mark, the name, the slogan, then "Connect to your OpenClaw" (17/500).
- "Scan a setup code" (primary, opens the camera), and "Paste a setup code" (default).
- A hint: "Make a code in Clawtrate on your computer, in Settings, Connect a phone."
- "Advanced" (quiet link): the address-and-token form.

After a scan or a paste comes a review screen, with Back: the title "Connect to devbox?", the address line of section 12 ("This code leads to devbox.tailnet.example, through Tailscale. Your phone needs Tailscale on."), the expiry, and "Connect" (primary) and "Cancel". Nothing connects until Connect.

**Waiting for approval**, with Back: the title "Waiting for approval", "Approve this iPhone in Clawtrate on your computer. Its device code is:", the device code "7C41-D2E0", and "Or, on the gateway's computer, run:" over the command block with the request id. The waiting line follows. When it is approved, the app opens read-only (F-509).

## 14. Private access with Tailscale

**Settings, Gateway**, on a route with a shell and the tested version (F-510): a switch row, "Private access with Tailscale", with "Reach this gateway from your own devices anywhere, through Tailscale. Tailscale is never needed for anything else." under it.

**What the row reads first**, each time Settings opens, over the route's shell. These are reads only: `openclaw --profile <p> config get gateway.tailscale --json`, `tailscale status --json` and `tailscale serve status --json`.

| What was read                                                                                         | The row                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw's mode is off, and no Serve or Funnel route serves the gateway's port                        | Off; the switch can be turned on                                                                                                                                                                                                                                      |
| OpenClaw's mode is `serve`, and Clawtrate's record says Clawtrate turned it on, with the value it set | On · its address; the switch can be turned off                                                                                                                                                                                                                        |
| OpenClaw's mode is `serve` or `funnel`, not set by Clawtrate                                          | "On, set outside Clawtrate. Change it on devbox." The switch is disabled                                                                                                                                                                                              |
| A Serve or Funnel route serves the gateway's port while OpenClaw's mode is off                        | "**A Tailscale route to this gateway already exists.** Clawtrate didn't make it and leaves it alone. OpenClaw refuses connections through it unless its owner sets gateway.trustedProxies." The switch is disabled, because OpenClaw's mode would take the route over |
| Tailscale can't be read                                                                               | The failure, below; the switch is disabled                                                                                                                                                                                                                            |

**Turning it on**: the host's dialog "Turn on private access on devbox?", with the detail "OpenClaw restarts on devbox and becomes reachable from your devices signed in to Tailscale. If anything fails, Clawtrate puts the setting back as it was and checks that the gateway answers." Then a step list:

| Step                           | What runs there                                                                                                                                                                                       | Failure                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| "Checking Tailscale"           | `tailscale status --json`: the program, `BackendState` `Running`, a DNS name, and a certificate domain (HTTPS on)                                                                                     | The named failures below; nothing has changed |
| "Turning on private access"    | Records the exact current value of `gateway.tailscale`, then `config set gateway.tailscale.mode serve`                                                                                                | OpenClaw's message; the value is put back     |
| "Restarting OpenClaw"          | `openclaw gateway restart`                                                                                                                                                                            | Rollback (below)                              |
| "Checking the new address"     | `tailscale serve status --json` shows an HTTPS route on the DNS name to a loopback port that is not the gateway's own (OpenClaw's managed listener), and `https://<name>/healthz` answers from devbox | Rollback                                      |
| "Checking the connection here" | Clawtrate reconnects over the SSH route and the gateway's identity is unchanged                                                                                                                       | Rollback                                      |

**On**: "On · devbox.tailnet.example · checked" on the row, and "Connect a phone" uses that address. When this computer is on the same tailnet, the host also opens `https://<name>/healthz` from here, and the row says "checked from this computer too". Otherwise it says "checked on devbox".

**The named failures** (F-511), each a `--warn` note with the next step:

| Failure                                     | From                                                                 | Note                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Tailscale isn't installed on devbox.**    | The program isn't found                                              | "Install Tailscale on devbox and sign in, then turn this on again."                       |
| **Tailscale is stopped on devbox.**         | `BackendState` `Stopped`                                             | "Start Tailscale on devbox, then turn this on again."                                     |
| **Tailscale is signed out on devbox.**      | `BackendState` `NeedsLogin`                                          | "Sign in to Tailscale on devbox, then turn this on again."                                |
| **HTTPS isn't turned on for this tailnet.** | No certificate domain; or OpenClaw's Serve warning after the restart | "Turn on HTTPS certificates in your Tailscale admin console, then turn this on again."    |
| **OpenClaw can't use Tailscale on devbox.** | Linux: Tailscale refuses the user (no operator permission)           | "On devbox, run `sudo tailscale set --operator=$USER` yourself, then turn this on again." |

Each failure note says what happened to the setting:

- "Nothing was changed." when the failure came before the change.
- "The setting is back as it was, and the gateway answers again." when the value was put back and the original route checked.
- "The setting is back as it was, but the gateway hasn't answered yet. Clawtrate keeps checking." while that check hasn't succeeded. The row keeps checking, and says so until it does.

**Rollback** puts back exactly the recorded value: `config set gateway.tailscale --json '<recorded>'`, or `config unset gateway.tailscale.mode` when there was none. It then restarts the gateway and checks the original route as in the last step.

**Off**: offered only when Clawtrate's record matches what is set now. The host's dialog "Turn off private access on devbox?", with the detail "OpenClaw restarts on devbox. Devices using the Tailscale address stop reaching it." Then the recorded earlier value is put back, the gateway restarted and checked, and the row says "Off".

## 15. Several routes to one gateway

One gateway can be reached by several routes: this computer, SSH, an address on the local network, a Tailscale address (F-513). This is built after the iPhone work, as the owner ordered, and it is designed now so that nothing before it has to change.

**Each route pairs for itself.** A route uses its own device token. The one exception is two SSH routes with the same pinned host key and the same gateway port on that computer. They end at the same gateway on the same machine, proven by the key, so they share a token. Every other route pairs for itself: silently for this computer and SSH, by a setup code and approval otherwise.

**Grouping and continuity.** After each connection the host reads `gateway.identity.get`. Routes that report the same identity are one gateway in the rail and in Settings. A route that reports a different identity than it did before is not that gateway any more: the host disconnects, drops that route's token, and the strip says "This address now leads to a different gateway". A credential is never sent on a route because another route reported the same identity (research §5).

**Failover and failback.** Settings, Gateway lists the gateway's routes in an order the person can change, with "In use" on one:

- Clawtrate connects over the first route that answers and authenticates with its own token, and whose identity matches; one that doesn't answer within 3 s is skipped.
- While connected over a later route, it checks the earlier ones on a network change, on wake, and every minute, and moves back as soon as one works. The move keeps everything open, as a reconnect does.
- A route whose sign-in is refused is marked "Sign-in refused", with "Pair again".

**Adding a route** is a button, "Add route", that pairs over the new route. A route the gateway reports about itself (its Tailscale address) is offered as a suggestion, never added by itself.

## 16. Widths, themes, keyboard, screen readers, motion

| Concern                            | Rule                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1440 and 1100 px                   | The 360 px column centred on the stage, as `visual-language.md` §10; dialogs centred                                                                                                                                                                                                                                                                            |
| 800 px                             | The same; the bots along the foot scale as the connection screen's do                                                                                                                                                                                                                                                                                           |
| Phone (390 px, and the iPhone app) | The column fills the width less 16 px a side; rows are 64 px, buttons 48 px; the bots hide below 640 px of height; dialogs become sheets (`bots.md` §2); the QR is 176 px; fingerprints stack                                                                                                                                                                   |
| Light and dark                     | Tokens only; the QR stays black on white in both                                                                                                                                                                                                                                                                                                                |
| Keyboard                           | Section 2, Input: reading order, Up and Down in the choice list, Enter as the primary action, Escape as Back on a step screen and Cancel in a dialog, focus kept in a dialog and returned after it                                                                                                                                                              |
| Screen readers                     | Each screen's title is its heading and takes focus when it appears; the step list is a list with the running step `aria-current="step"` and each step's state in its name ("Asking the gateway, running"); failures are `role="alert"`, other notes `role="status"`; the countdown is announced once a minute; fingerprints and device codes are read in groups |
| Reduced motion                     | The running step's arc is a still ring; the waiting dot stops pulsing; nothing slides                                                                                                                                                                                                                                                                           |
| Branding                           | Clawtrate's mark and bots only; OpenClaw and Tailscale named in text, with no logo or colour of theirs                                                                                                                                                                                                                                                          |

## 17. What each fact drives

| Fact                                                                                        | Source (research) | Shown                                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| No program in the fixed places, no `~/.openclaw`, no service                                | §6.4, §6.9        | "OpenClaw isn't on this computer"                                                              |
| No program, but state or a service                                                          | §6.9              | "OpenClaw seems to be set up here, but Clawtrate can't find its program"                       |
| `openclaw --version`, `gateway.version` from `gateway status --json`                        | §6.4              | The version; tested, untested or too old                                                       |
| `service.label`, `loaded`, `runtime.status`                                                 | §6.4, §6.8        | The service fact, per system                                                                   |
| `gateway.port`, `bindMode`, `rpc.ok`                                                        | §6.4              | "OpenClaw is running", or "installed but not running"                                          |
| `extraServices` (with `--deep` only)                                                        | §6.9              | "Clawtrate also saw another OpenClaw service here"                                             |
| `ssh` exit 255 and its error output                                                         | §7                | The three failures; "key has changed"                                                          |
| The capture file written with `accept-new`, `PreferredAuthentications=none`                 | §7.2              | The fingerprint of first contact; "Presented now"                                              |
| `Found key in <file>:<line>`                                                                | §7.2              | A key the person already trusts, pinned silently                                               |
| `openclaw qr --json --voice-node`                                                           | §3                | Connect's code; a phone's code                                                                 |
| Granted scopes exactly `operator.read`                                                      | §1, §3            | Connected, read-only                                                                           |
| `AUTH_BOOTSTRAP_TOKEN_INVALID`                                                              | §3                | "The one-time code didn't work"                                                                |
| "Gateway is only bound to loopback"                                                         | §1                | "A phone can't reach this gateway yet"                                                         |
| `device.scopes.requestUpgrade` request id, pending; the same entry in `devices list --json` | §2                | The access bar's Requested state with "Approve from here"                                      |
| `Approved <deviceId> (<requestId>)`                                                         | §2                | The wait finds the approval                                                                    |
| A pending `gateway-client` request after the code, with its device id and scopes            | §3                | "iPhone · 7C41-D2E0"                                                                           |
| `device.pair.setupCode` refused below admin                                                 | §4                | The access bar on "Connect a phone"                                                            |
| `install-cli.sh` NDJSON, Node step `skip`                                                   | §6.2, §6.8        | The install's steps; "The installer didn't use the checked Node.js"                            |
| Installed `entry.js` equals the checked tarball's                                           | §6.8              | (a check of the builder's tests, not a screen)                                                 |
| Onboarding JSON `ok`, `classification`                                                      | §6.3              | "Set up the gateway" done or failed                                                            |
| What `uninstall` removed, and what is left                                                  | §6.5, §6.6, §6.8  | The removal report                                                                             |
| `tailscale status --json`, `tailscale serve status --json`                                  | §8                | The Tailscale row and its failures                                                             |
| `gateway.identity.get`                                                                      | §5                | Routes grouped; "leads to a different gateway"                                                 |
| HTTP 403 `proxy_attribution_required`                                                       | §3                | "The gateway only accepts connections through a proxy it trusts" (shown on Advanced's failure) |

## 18. Parity rows

The rows this design governs, and how they changed in this round, are in `docs/parity.md`. Statuses do not change. In short:

- **F-501 to F-505** are macOS and Linux only. **F-517** is new, for installing on Windows, `todo`, with what it needs first: a private runtime that leaves the computer's Node.js, npm and PATH alone, and a proven Scheduled Task registration and removal.
- **F-513** has ordered failover and failback again, with the rule for when a route may reuse a credential.
- **F-492, F-494, F-495, F-496, F-500, F-502, F-503, F-506, F-507, F-509, F-510 to F-512, F-514 to F-516** are reworded to what the research proved: voice-node codes, the host checking the granted scope, the host-key capture, the binding of approvals, ownership, the verified chain and its limit, and discovery with `--deep`.
- **F-003 and F-009** keep their `desktop done` scope for what the existing check drives, and point at the new rows for the new steps and failures.

## 19. For builders

### What each part uses

| Screen                          | Existing                                                    | New                             |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------- |
| First screen                    | The connection column, mark, bots, choice list, quiet links | none                            |
| Looking, connecting, setting up | The connection column, notes, disclosure                    | Step list                       |
| Another computer                | `.input`, notes, the copy button                            | Fingerprint                     |
| What the look found             | Fact block, notes, buttons                                  | Found card                      |
| Approve from here               | The access bar, the pairing screen                          | Device code                     |
| Settings, Gateway               | Settings frame (`bots.md`), switch, notes                   | none                            |
| Connect a phone                 | Dialog, notes, choice rows                                  | QR code, countdown, device code |
| iPhone first screen             | The connection column                                       | Device code                     |
| Every confirmation              | none                                                        | The host's native dialog        |

### What the host does

**Commands the interface may send.** Reads and the read-only connect run at once; everything else is a two-step operation that only the host's dialog completes.

| Command                                 | Kind              | Does                                                                                                                                      |
| --------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.look {where}`                    | read              | Section 4 or 5; returns the typed facts of section 17                                                                                     |
| `setup.cancel {lookId}`                 | read              | Ends that look's programs by PID                                                                                                          |
| `setup.connect {routeId}`               | read-only connect | Section 7                                                                                                                                 |
| `setup.readCode {text}`                 | read              | Decodes a pasted code in the host; returns its address kind, host, expiry and validity, never its token                                   |
| `setup.prepare {operation, routeId, …}` | prepare           | Builds the operation from the host's own state and shows the host's dialog; the interface gets only "confirmed", "cancelled" or "changed" |

Operations: `trustKey`, `replaceKey`, `start`, `install`, `cancelInstall`, `approve {requestId}`, `phoneCode`, `tailscale {on}`, `removeRoute {stopGateway}`, `uninstall {keepData}`.

**Validated arguments** (rule 2):

| Value             | Pattern                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH destination   | `^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$`: the user, when present, never starts with `-`; the host never starts with `-` or `.`; no `:`, `/`, spaces or quotes |
| Request id        | `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`                                                                                                                               |
| Port              | An integer from 1024 to 65535, read from `gateway status --json`                                                                                                                               |
| Fingerprint       | `^SHA256:[A-Za-z0-9+/]{43}$`, computed by the host from captured key bytes, never taken from the interface                                                                                     |
| Version           | `^OpenClaw (\d{4})\.(\d{1,2})\.(\d{1,3})( \([0-9a-f]{7,12}\))?$`                                                                                                                               |
| Address in a code | `ws://` or `wss://`; no user name or password; a host of letters, digits, `.` and `-`, or an IPv4 address; an optional port; no other path than `/`                                            |
| A remote path     | One of the fixed candidate paths, compared exactly                                                                                                                                             |

**SSH, the host's configuration.** The host writes one file per route:

```
Host clawtrate-route-<id>
  HostName <HostName from the person's block, or the typed host>
  User <User>           Port <Port>
  IdentityFile <each>   IdentitiesOnly <value>   CertificateFile <each>
  HostKeyAlias clawtrate-route-<id>
  UserKnownHostsFile <app data>/known_hosts
  GlobalKnownHostsFile none
  StrictHostKeyChecking yes        UpdateHostKeys no
  BatchMode yes                    ConnectTimeout 10
  ServerAliveInterval 15           ServerAliveCountMax 3
  ExitOnForwardFailure yes         ClearAllForwardings yes
  ForwardAgent no                  ForwardX11 no
  PermitLocalCommand no            ControlMaster no      ControlPath none
  RequestTTY no
```

It runs `ssh -F <that file> … clawtrate-route-<id>`. For first contact only, it uses `StrictHostKeyChecking accept-new`, `UserKnownHostsFile <a new empty capture file>`, `PreferredAuthentications none` and `NumberOfPasswordPrompts 0`. To find a key the person already trusts, it uses `UserKnownHostsFile <app file> <the person's ~/.ssh/known_hosts>` with `-v`, and reads only the lines `Server host key:`, `is known and matches`, `Found key in` and the failure lines, accepting `\r\n` line ends. File paths in `IdentityFile` and `CertificateFile` must be under the person's home and contain no `%` tokens. On Windows the program is `%WINDIR%\System32\OpenSSH\ssh.exe`.

**Programs**, each started with an argument array, never through a shell:

| Program                         | Arguments                                                                                                                   | When                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `ssh`                           | `-F <file> [-v] -- clawtrate-route-<id> /bin/sh -s`, a script on standard input                                             | Every remote step                                  |
| `ssh`                           | `-F <file> -N -L 127.0.0.1:<free port>:127.0.0.1:<port> -- clawtrate-route-<id>`                                            | The forward                                        |
| `ssh-keygen`                    | `-lf <capture file>`                                                                                                        | The fingerprint of captured key bytes              |
| `openclaw`                      | `--version`; `gateway status --json [--deep] [--profile clawtrate]`; `devices list --json`                                  | This computer, reads                               |
| `openclaw`                      | `qr --json --voice-node --url ws://127.0.0.1:<port>`; `qr --json --voice-node`                                              | This computer, Connect and a phone                 |
| `openclaw`                      | `devices approve <requestId>`; `gateway start`; `--profile clawtrate uninstall …`; `config set                              | unset gateway.tailscale…`; `gateway restart`       | This computer, after the host's dialog |
| `tailscale`                     | `status --json`; `serve status --json`                                                                                      | This computer, reads                               |
| `/bin/bash`                     | `<program folder>/install/install-cli.sh --json --runtime-only --npm --version <checked tarball> --prefix <program folder>` | Install, macOS and Linux, in its own process group |
| `<program folder>/bin/openclaw` | `--profile clawtrate onboard …` (section 10)                                                                                | Install                                            |

**The install's environment**: `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` each point at its own empty file (npm refuses one file for both, research §6.8); `npm_config_registry=https://registry.npmjs.org/`; `PATH` is the system's plus the prefix; nothing else of the person's environment is passed.

**Scripts over SSH**, constants in the host's source. Each is POSIX `sh`, starts with `set -eu`, takes its only values (a port of digits, a request id of hex and hyphens) from assignments the host writes after validating them, and prints one JSON line per fact.

- LOOK finds the program in the fixed places only; prints `uname -s`, `uname -m`, `uname -n`, whether `tar` and a SHA-256 tool exist, `--version`, `gateway status --json`, and whether `~/.openclaw` and a service exist.
- CODE runs `openclaw qr --json --voice-node --url "ws://127.0.0.1:$port"`.
- APPROVE runs `openclaw devices list --json`, then `openclaw devices approve "$request"` only when that request is still pending with the expected device and scopes, then prints both results.
- START, STOP, RESTART, TAILSCALE-READ, TAILSCALE-SET, PHONE, UNINSTALL and CANCEL follow the same pattern, one fixed OpenClaw command each.
- INSTALL receives the checked files on standard input as a tar stream into `mktemp -d`, checks the two hashes again there, and runs the installer in its own process group. It writes that group's id to the program folder.

**Remote output**: at most 64 KiB per script and 30 s (10 minutes for INSTALL), parsed line by line as JSON; a line that isn't valid JSON of the expected shape ends the step as "Can't tell".

**What the host keeps**: routes (section 2), each with its device token, its pinned key in Clawtrate's own known-hosts file, and the gateway's identity; the records of installs and started gateways; the Tailscale value it set and the value before it. Of a failed step it keeps only the typed record: step, exit status, and the last installer event as text.

**Telling a proxy refusal apart.** After a connect fails before any frame, the host sends one plain HTTP upgrade request to the same address and reads its status: `403` with `proxy_attribution_required` is the proxy refusal (research §3).

**`docs/decisions.md`** says, under "Connecting to the gateway", what changes with routes when package 2 is built: tokens kept per route, the SSH exception for an identical pinned endpoint, and the identity check after every connection, with the existing generation checks kept through every wait.

### What the engine supplies

| Need                                                           | Supplied by                                                                                                         | Notes                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Connect with a bootstrap token                                 | The host's client: `connect({url, bootstrapToken})`, passed to the pinned lifecycle's `buildPlan({bootstrapToken})` | Never in the interface; dropped after hello |
| Refuse a grant wider than asked                                | The host's client, after hello                                                                                      | Disconnects and keeps no token              |
| A device token per route                                       | The token store keyed by route                                                                                      | Section 15                                  |
| The gateway's identity per route                               | `gateway.identity.get`, already read                                                                                | Grouping and continuity                     |
| `PAIRING_REQUIRED`, the upgrade's request id, this device's id | As today                                                                                                            | Approve from here binds to them             |

### Order

The six packages, in this order, each with checks of its security and failure cases as well as its happy path:

1. **This computer, found** (F-491 to F-494, F-515, F-516): the first screen; the look and what "found" means; Connect with a voice-node code made and redeemed by the host; the scope check; Advanced.
2. **Another computer over SSH** (F-495 to F-500): the configuration subset and its refusals; the LOOK script; the three failures; first contact, an already trusted key, a changed key; the forward and its life; "Approve from here" with its binding, and its negative checks (a stale, a mismatched and a premature approval). Checks run against an `sshd` the test starts.
3. **Setting up, macOS and Linux** (F-501 to F-505, F-514): ownership; the verified chain; the steps; cancel and rollback of only what was made; removal and its report. A real install runs only on hosted runners.
4. **A phone or a computer without SSH** (F-506 to F-509): explicit codes; the address line; the loopback case and its commands; the phone's request and its device code; the desktop's pasted code and its pairing; the iPhone's screens.
5. **The Tailscale switch** (F-510 to F-512): reads, ownership, on, off, every failure and its rollback, with a stand-in `tailscale` on the test's own `PATH`.
6. **Several routes** (F-513), after the iPhone work: per-route pairing, grouping and continuity, failover and failback.

### The prototype's states and walks

`setup.html?screen=<id>`, with the shared `theme`, `width`, `motion` and `chrome` parameters, and `returning=1` for a return visit. The bar's "State" menu lists every state. The check walks these paths by clicking, and asserts each destination:

| Walk                            | From                    | Through                                                                          | To                                |
| ------------------------------- | ----------------------- | -------------------------------------------------------------------------------- | --------------------------------- |
| This computer, found            | `first`                 | `looking-here`, `found`, `connecting-here`                                       | the app, read-only                |
| Another computer, known key     | `there`                 | `looking-there`, `found-there`, `connecting-there`                               | the app, read-only                |
| Another computer, first contact | `there` (a new host)    | `hostkey`, the host's dialog, `looking-there`, `found-there`                     | the app                           |
| A changed key                   | `hostkey-changed`       | the host's dialog with its checkbox                                              | `looking-there`                   |
| Another computer, nothing there | `there` (an empty host) | `notfound-there`, `install-confirm-there`, the host's dialog, `installing-there` | the app                           |
| This computer, nothing there    | `notfound`              | `install-confirm`, the host's dialog, `installing`                               | the app                           |
| Windows, nothing there          | `notfound-windows`      | "Use another computer"                                                           | `there`                           |
| A pasted code                   | `code`                  | an invalid code (Connect unavailable), a valid one, `code-pairing`               | the app                           |
| A phone, from the desktop       | `phone`                 | the host's dialog, `phone-code`, `phone-request`, the host's dialog              | `phone-done`                      |
| The iPhone                      | `iphone`                | `iphone-review`, `iphone-waiting`                                                | `iphone-done`                     |
| Approve from here               | `approve`               | the host's dialog                                                                | `approve-done`                    |
| Tailscale on                    | `tailscale`             | the host's dialog, `tailscale-steps`                                             | `tailscale-on`                    |
| Tailscale off                   | `tailscale-on`          | the host's dialog                                                                | `tailscale`                       |
| Advanced                        | `first`                 | "Advanced"                                                                       | `connect.html`, the form as built |

## 20. Not covered here

- Setting OpenClaw up on Windows (F-517), on musl Linux or FreeBSD, or on any computer over SSH that isn't macOS or glibc Linux.
- SSH through a jump host (`ProxyJump`, `ProxyCommand`), and settings outside the subset of section 5. The person uses a setup code or Advanced.
- OpenClaw profiles other than the default and `clawtrate`: Advanced reaches them.
- Updating OpenClaw from Clawtrate, and changing the gateway's bind. The look and "Connect a phone" name the commands; the person runs them.
- A relay of Clawtrate's own: this design has none, and nothing in it depends on one.
- "Another computer" over SSH on iPhone.
- The pairing screen itself, which `visual-language.md` §10 keeps as it is.
