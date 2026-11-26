# The title bar, the update button, Settings and the gateway's name

Four changes to the app's frame: a title bar with Clawtrate's mark, wordmark and a Beta pill; the update button moved into it; a gear for Settings; and a name for the gateway connection.

It rewrote two earlier decisions: the Brand entry in `docs/decisions.md`, where the mark had appeared only on the connection and pairing screens, and section 7 of [visual-language.md](visual-language.md), where the rail had no product name.

## 1. Where things are

- **The update button** is `UpdateButton` in [`TitleBar.tsx`](../../packages/ui/src/TitleBar.tsx): in the title row on the desktop, and in its round form at the start of `.rail-top` in the one-pane layout. [`update-entry.ts`](../../packages/ui/src/update-entry.ts) maps the host's update snapshot to its words and what a press does. The rail's footer no longer has an update button.
- **Settings** has a gear of its own, `GearIcon`, beside the connection card in the rail's footer, at every width. The gateway menu keeps its Settings item, and ⌘, (Ctrl+, elsewhere) opens it. `SettingsIcon`, the two sliders, stays for the iPhone app, which draws the desktop's icons from it.
- **Gateway names** are kept in the host's storage under `gateway-names` ([`gateway-names.ts`](../../packages/core/src/gateway-names.ts)), beside the saved connection `{ url, token, suspended? }`, which has no label of its own. Section 4 says how.
- **The macOS window** uses `titleBarStyle: "hiddenInset"` with `trafficLightPosition: { x: 13, y: 12 }` ([`main/index.ts`](../../apps/desktop/src/main/index.ts)), which centres the window controls in the 40 px title row. The title row is the drag band; `.rail-top` no longer pads for the controls.
- **The track.** Beta is `nightly` in code. `DesktopUpdateSnapshot.runningTrack` comes from the validated running version. It is null in a development build or when the version can't be read.

## 2. Layout

### Two panes (the desktop app and a wide browser)

```
┌ ● ● ●  [mark] Clawtrate (Beta)  [⟳ Restart to Update]  ··· drag ··· ┐  title bar, 40 px
├ rail-top: routines sort search +  ┬  conversation header            ┤
│ bots …                            │  transcript                     │
│ [● Devbox                ] [⚙]    │  composer                       │
└ [  devbox…:8443          ]        ┴─────────────────────────────────┘
```

- **The title bar** is a new row above the whole shell, 40 px tall, in `--bg-rail`. Every part of it drags the window except its buttons, which are `no-drag`. Double-clicking it zooms the window, as macOS does. On the macOS desktop app it starts 80 px in, after the window controls. `hiddenInset` alone put their centre line at 18.75 px, so the window sets `trafficLightPosition` to `{ x: 13, y: 12 }`. Measured in a capture of the window, that centres them at 19.75 px, 14 px in from the left, 14.5 px clear of the mark. Elsewhere it starts 12 px in.
- **The brand:** the in-app mark (`packages/ui/src/assets/logo-mark.png`) at 20 px with a 5 px radius, the word "Clawtrate" at 14/600, and the Beta pill. It is text and an image, not a control.
- **The Beta pill** shows only when `runningTrack === "nightly"`. A Stable build, a development build or an unreadable version shows no pill. The pill never infers a channel from anything else. It is neutral: outlined in `--border-strong`, 12/500 text in `--text-muted`, 20 px tall. The accent stays on the things `decisions.md` lists.
- **The update button** comes straight after the brand, near the top left, as asked. It is a 26 px pill (section 3).
- **`.rail-top`** loses its 84 px window-control padding, because the controls now sit in the title bar. It keeps Routines, Sort, Search and "+".
- **The gear** sits in the rail's footer, to the right of the connection card, where the update button was. It is a standard 32 px raised `icon-button`, so it reads as a target. It sits beside the gateway it configures, which is where people look for app settings in a sidebar app.
- **The connection card** is unchanged in size. Its first line is the name, its second the address (section 4).

The title bar costs 40 px of height. The brand can't share `.rail-top`: at the rail's 280 px, the window controls take 84 px and the four rail buttons take 152, which leaves 32 px. Moving the rail buttons would change more than was asked.

On Windows the native title bar stays, so the brand appears under it. That is redundant but harmless. Windows chrome belongs to another contributor, and `[data-platform="win32"]` can hide the row later.

### One pane (below 688 px: the phone, a narrow browser)

- There is no title bar row. The mark (24 px, without the wordmark) and the Beta pill sit at the left of `.rail-top` in the list view. Without the wordmark, the mark still says which app this is.
- The update button follows them in its round form: 32 px, or 44 px on touch, the tap minimum. Its words are in its tooltip and accessible name. Routines, Sort, Search and "+" stay at the right. At 390 px that is 24 + 42 px of brand, the 44 px button and four 40 px ones, which fits in 366 px.
- **The footer card and the gear now show on the phone too.** The round gear-with-dot button at the top left goes. A round button with a gear on it that opens a menu would contradict the new gear, and the card now carries the name, which is worth showing. The gateway menu opens upward from the card, as on the desktop.
- The conversation (detail) view is unchanged: Back, the title pill and Work.

## 3. The update button's states

The button reads the same `DesktopUpdateSnapshot` that Settings → Updates reads (`useDesktopUpdateSnapshot`). It shows exactly when `showUpdateFooter` is true today. Each state's words are visible, and the accessible name starts with them.

| Snapshot                                                                                                                      | Button                                                                      | Press                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No snapshot, no source, a development build, not checked, checking, nothing newer, a track change pending, a settings failure | none                                                                        | —                                                                                                                                                                                                                                  |
| `offered`                                                                                                                     | ↓ "Update available"                                                        | Opens Settings → Updates, where Download is. Nothing downloads without that choice.                                                                                                                                                |
| `downloading`, bytes still arriving                                                                                           | ↓ "Downloading 42%", with a 2 px bar along its foot                         | Opens Updates                                                                                                                                                                                                                      |
| `downloading`, all bytes received                                                                                             | ↓ "Checking download…"                                                      | Opens Updates                                                                                                                                                                                                                      |
| `verified` and `restartCapability`                                                                                            | ⟳ **"Restart to Update"**, filled with `--bg-inverse` like a primary button | Opens the existing "Restart to update?" confirmation, with the waiting-messages details. Restart calls `restart(offerId)`. If the host refuses (busy, stale, invalid) or the request fails, Settings → Updates opens and says why. |
| `verified`, no restart from here                                                                                              | ↓ "Update downloaded"                                                       | Opens Updates, which says why                                                                                                                                                                                                      |
| `preparing`, `handing-off`                                                                                                    | a turning ring and "Restarting…", `aria-disabled`                           | Nothing                                                                                                                                                                                                                            |
| `handed-to-system`                                                                                                            | 🕓 "Installs on quit"                                                       | Opens Updates                                                                                                                                                                                                                      |
| `handoff-unconfirmed`                                                                                                         | ⚠ "Update unconfirmed", in warn                                             | Opens Updates                                                                                                                                                                                                                      |
| `failed`, stage `check`                                                                                                       | ⚠ "Couldn't check", in warn                                                 | Opens Updates                                                                                                                                                                                                                      |
| `failed`, stage `download`                                                                                                    | ⚠ "Download failed", in warn                                                | Opens Updates                                                                                                                                                                                                                      |
| `handoff-failed`                                                                                                              | ⚠ "Couldn't install", in warn                                               | Opens Updates                                                                                                                                                                                                                      |

- "Restart to Update" uses the updater's own words and capitals, as the button in Settings does.
- The percentage is rounded down to 10s, as the existing announcement does, so it doesn't jitter.
- The title bar never downloads or restarts on its own. Restart always passes through the same confirmation as Settings.
- While a download or another update action runs, a press opens Updates, where its progress shows; "Restart to Update" asks to confirm only once nothing else runs.
- A restart the host refuses, or whose request gets no reply, opens Updates with the reason. That includes a refusal that arrives after the offer itself is gone, as long as no restart began instead.

## 4. The gateway's name

### What shows

| Name | Connection    | First line  | Second line                                                                               |
| ---- | ------------- | ----------- | ----------------------------------------------------------------------------------------- |
| set  | connected     | the name    | the address (`host:port`)                                                                 |
| set  | anything else | the name    | the state: "Reconnecting…", "Can't reach the gateway", "Awaiting approval", "Catching up" |
| none | any           | the address | the state, as today                                                                       |

The dot is unchanged. The name also replaces the address as the gateway menu's head title. The head's line keeps "Connected · address" and the OpenClaw version. The name appears too in Settings' gateway lines that today say `gatewayLabel(url)`, in the reconnect screen, and in the card's accessible name: "Devbox, connected. Open the gateway menu."

### Renaming: a small dialog from the gateway menu

The gateway menu gets "Rename gateway…" (or "Name this gateway…" when there is no name) right under its head. It opens the rail's existing `RailDialog` with a field:

- **Title:** "Rename gateway" or "Name this gateway".
- **Body:** "The name shows in the sidebar instead of the address. It stays on this device and is never sent to the gateway." The full address follows in mono.
- **Field:** "Name", prefilled with the current name and selected. Placeholder "For example, Devbox". At most 40 characters. Text is trimmed, and line breaks, control and format characters, and lone surrogates are removed.
- **Hint:** "Leave it empty to show the address." Save with an empty field removes the name.
- **Actions:** Cancel and Save. Enter saves; Escape cancels. Focus returns to the card.

**Why a dialog, not inline editing.** The card is a menu button. Its text is `aria-hidden`, and its accessible name is built from the name and the state. A field swapped in where the button was breaks that, and it has to fit a status dot, two lines and the gear in a 248 px rail. A dialog can say where the name lives and show the whole address it belongs to, which the card truncates. It works the same on the phone. `RailDialog` already exists. It needs three small options: an initial value, allowing an empty field, and a hint under it.

### Where it is stored

- In the **host's storage**, the place that holds the saved connection, under its own key `gateway-names`: a map from address to name, at most 32 entries, oldest dropped first. On the desktop that is Electron's main process. In the web preview it is the preview host, shared by that host's viewers like the saved connection. It is never in `localStorage`, never in a gateway request, and never in `users.prefs`.
- A bridge command `nameGateway { gatewayUrl, name }` writes it. The engine refuses it unless `gatewayUrl` is the address now selected, as `disconnect` does. The state carries `connection.gatewayName: string | null` for the current address.
- **The key is the address**, normalised: scheme, lowercase host, port and path without a trailing slash. A host holds one saved connection at a time, so two connections to the same address are the same saved connection and show the same name. That holds across Disconnect and reconnecting, across windows, and across viewers of one web preview host. If a different gateway later answers at the same address, it shows the same name until it is renamed; the dialog shows the address, so this is visible. The pairing steps show the address beside the name for the same reason. The same gateway reached at two addresses, such as a LAN address and a Tailscale name, has two names.
- **Names are saved one at a time**, in order, and the startup read of them takes its place in the same line, so two quick renames both keep their names.
- **Disconnect keeps the name**, as it keeps the device token for that address, so reconnecting to "Devbox" shows "Devbox" again. Removing the name is Rename with an empty field.

## 5. Copy

| Where               | Words                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pill                | Beta                                                                                                                                                                                                        |
| Pill tooltip        | This copy is a Beta build                                                                                                                                                                                   |
| Update button       | Update available · Downloading 42% · Checking download… · Restart to Update · Update downloaded · Restarting… · Installs on quit · Update unconfirmed · Couldn't check · Download failed · Couldn't install |
| Its accessible name | The words, the version, then "Open Updates" when it opens Settings: "Update available: Clawtrate 0.1.2-beta.20261124.1. Open Updates"                                                                       |
| Gear                | Settings, with the tooltip "Settings (⌘,)" ("Ctrl+," on Windows and Linux)                                                                                                                                  |
| Menu item           | Rename gateway… / Name this gateway…                                                                                                                                                                        |
| Dialog              | Rename gateway · Name this gateway · Name · For example, Devbox · Leave it empty to show the address. · Save · Cancel                                                                                       |

## 6. Accessibility

- **Names.** The gear is a `button` named "Settings". The update button is a `button` whose name starts with its visible words, so voice control can say what it sees. The mark's image has `alt=""` because the word "Clawtrate" follows it. In the one-pane layout, where the word is hidden, the brand carries a visually hidden "Clawtrate".
- **Focus.** The app's `:focus-visible` ring (2 px `--accent-line`, offset 2) applies to the update button and the gear. Neither has its own outline rules. Tab order: title bar, rail top, bots, the card, the gear, then the conversation.
- **Not colour alone.** "Beta" is written. The ready button is filled and also says "Restart to Update". Warning states carry the warning mark and their own words. The card's state is in words whenever it isn't "Connected".
- **Announcements.** One polite live region, outside the title bar so the phone has it too, speaks when the button appears and on each change of state, with the button's name less "Open Updates": "Update available: Clawtrate 0.2.0", "Restart to Update: Clawtrate 0.2.0", "Couldn't check". It never speaks progress ticks; Updates in Settings keeps its own 10% announcements.
- **Restarting** is `aria-disabled`, not `disabled`, so it stays focusable and readable.
- **Focus with nowhere to return.** When Settings closes and the control that opened it is gone, focus goes to the first control that is shown, never to the title bar's buttons hidden on a phone.
- **Touch.** The round form is 40 px on touch, like the rail's other buttons. The card's row is at least 44 px.

## 7. Motion

Only Restarting moves: a 12 px ring turns once every 900 ms. With `prefers-reduced-motion` or the app's `data-motion="reduce"`, it stands still; the word "Restarting…" still says what is happening. The download bar's width follows progress with no transition. Nothing in the title bar pulses or slides in.
