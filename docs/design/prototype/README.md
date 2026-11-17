# Clawtrate prototype

Static pages for the design in `docs/design/`. Open `index.html` in a browser. There is no build step and the pages make no network requests.

| Page | Shows |
|---|---|
| `connect.html` | The first screen. `?state=error` and `?state=busy` show a failed and a running attempt. |
| `pairing.html` | Waiting for the gateway's owner to approve this device. |
| `app.html` | The main view: bots with their tasks, a conversation, the Work pane. It runs on a small local model, so selecting, folding, the connection states and the Work pane all work. |
| `gallery.html` | Every conversation component in every state. |
| `conversation.html` | One scripted turn, played inside the shell. |

The dark bar at the top is prototype chrome, not part of the product. It switches the theme, the width of the frame the app sits in (full, 1100, 800, phone) and reduced motion.

## States from the address

Every setting can be given in the address, which is how the screenshots are taken. Add `chrome=0` to drop the bar and let the app fill the window.

| Parameter | Values |
|---|---|
| `theme` | `light`, `dark` |
| `width` | `full`, `1100`, `800`, `phone` |
| `motion` | `full`, `reduce` |
| `bot`, `task` | A bot and one of its tasks to open, for example `bot=juniper&task=j2` (app) |
| `unfold`, `fold` | Bots to unfold or fold, by id (app) |
| `showall` | A bot whose six-row cap is lifted (app) |
| `rail` | `pinned` (app) |
| `panel` | `open` (app) |
| `tab` | `details`, `files`, `computer` (app) |
| `view` | `list`, `detail` (app, one-pane layout) |
| `banner` | `reconnecting`, `offline`, `syncing`, `synced`, `failed` (app) |
| `state` | `empty`, `loading`, `readonly`, `newtask`, `loaderror` (app); `error`, `busy` (connect); `copied` (pairing) |
| `section` | One section of the gallery, by id (gallery) |

## Files

| File | What it is |
|---|---|
| `css/tokens.css` | The token set. A drop-in replacement for `packages/ui/src/styles/tokens.css`. |
| `css/app.css` | The shell's styles, written against the shell's own markup and in the order of the change list in `visual-language.md`. |
| `css/conversation.css` | The conversation components' styles. |
| `css/prototype.css` | The control bar, the frame and the gallery's layout. Not product code. |
| `js/icons.js` | The icon set and the bot characters, drawn for Clawtrate. |
| `js/prototype.js` | The theme, width and motion controls. |
| `js/app.js` | The local model behind `app.html`: bots, tasks, selection, folding, the connection, the Work pane. |
| `js/connect.js` | What the buttons on the connection screens do. |
| `js/components.js`, `js/samples.js`, `js/behaviors.js` | The conversation components' markup, sample content and small behaviours. |
| `js/gallery.js`, `js/run.js` | The gallery and the scripted run. |
| `tools/make-local-fonts.mjs` | Builds the ignored local font stylesheet. |

## Fonts

The design uses Figtree and JetBrains Mono. Both are under the SIL Open Font License 1.1. No font file is in this repository, so a fresh copy of the pages falls back to system fonts, and text widths and wrapping then differ from the design.

To render the pages in the design's faces, run this once from `docs/design/prototype/`:

```
node tools/make-local-fonts.mjs
```

It fetches `@fontsource-variable/figtree@5.3.0` and `@fontsource-variable/jetbrains-mono@5.3.0` from the npm registry with `npm pack`, and writes `fonts.local.css` beside the pages with both faces embedded. That file is ignored by git. The script is the only thing here that uses the network; the pages never do.

Before taking screenshots, check that the face loaded. In the browser's console:

```
document.fonts.check('15px "Figtree Variable"') && [...document.fonts].some((f) => f.family.includes("Figtree") && f.status === "loaded")
```

## The product mark

The connection screens show the product's own mark, `packages/ui/src/assets/logo-mark.png`, by relative path. It is never copied here or redrawn.

## What is drawn here and what is not

Every icon and avatar was drawn for this project. The product mark is the app's own file and is not copied here. Bot names come from the development gateway's seed data. The tasks, the machines and the text in the conversations are invented.
