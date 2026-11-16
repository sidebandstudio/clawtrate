# Clawtrate prototype

Static pages for the design in `docs/design/`. Open `index.html` in a browser. There is no build step and the pages make no network requests.

| Page | Shows |
|---|---|
| `connect.html` | The first screen. `?state=error` and `?state=busy` show a failed and a running attempt. |
| `pairing.html` | Waiting for the gateway's owner to approve this device. |
| `app.html` | The main view: bots with their tasks, a conversation, the Work pane. |

The dark bar at the top is prototype chrome, not part of the product. It switches the theme, the width of the frame the app sits in (full, 1100, 800, phone) and reduced motion.

## States from the address

Every setting can be given in the address, which is how the screenshots are taken. Add `chrome=0` to drop the bar and let the app fill the window.

| Parameter | Values |
|---|---|
| `theme` | `light`, `dark` |
| `width` | `full`, `1100`, `800`, `phone` |
| `motion` | `full`, `reduce` |
| `panel` | `open` (app) |
| `tab` | `details`, `files`, `computer` (app) |
| `view` | `list`, `detail` (app, one-pane layout) |
| `banner` | `reconnecting`, `offline`, `syncing`, `synced`, `failed` (app) |
| `state` | `empty`, `loading`, `readonly` (app); `error`, `busy` (connect) |
| `rail` | `pinned` (app) |

## Files

| File | What it is |
|---|---|
| `css/tokens.css` | The token set. A drop-in replacement for `packages/ui/src/styles/tokens.css`. |
| `css/app.css` | The shell's styles. A drop-in replacement for `packages/ui/src/styles/app.css`. |
| `css/prototype.css` | The control bar and the frame. Not product code. |
| `js/icons.js` | The icon set and the bot characters, drawn for Clawtrate. |
| `js/prototype.js` | The theme, width and motion controls. |
| `js/app.js` | The few behaviours `app.html` needs. |

## Fonts

The design uses Figtree and JetBrains Mono, both open-licensed. The pages name them in the font stack and fall back to the system fonts, so they stand alone without font files in the repository.

To see the real faces, create `fonts.local.css` next to `index.html` with `@font-face` rules for `"Figtree Variable"` and `"JetBrains Mono Variable"` that point at font files on your machine, for example the ones `@fontsource-variable/figtree` and `@fontsource-variable/jetbrains-mono` install. The pages load that file if it exists, and it is ignored by git.

## What is drawn here and what is not

Every icon and avatar was drawn for this project. The product mark in these pages is a stand-in; the app uses `assets/brand/logo.png`. Bot names come from the development gateway's seed data. The text in the conversations is invented.
