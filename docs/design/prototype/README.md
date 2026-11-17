# Clawtrate prototype

Static pages for the design in `docs/design/`. Open `index.html` in a browser. There is no build step and the pages make no network requests.

| Page | Shows |
|---|---|
| `connect.html` | The first screen. `?state=error` and `?state=busy` show a failed and a running attempt. |
| `pairing.html` | Waiting for the gateway's owner to approve this device. `?state=copied` and `?state=selected` show the copy button's two outcomes. |
| `app.html` | The main view: bots with their tasks, a conversation, the Work pane. It runs on a small local model, so selecting, folding, pinning, the menus, sending, the connection states and the Work pane all work. Right-click a bot for its menu. |
| `gallery.html` | Every conversation component in every state. Steps and cards work as they do in the app: they open, Raw opens, copy copies, approvals and questions resolve. The composer, the access bar and the rail rows are pictures of each state there. |
| `conversation.html` | One scripted turn, played inside the shell: Play, Step, Drop the connection and Restart are in the bar. The approval and the question pause it until you answer; Stop, steer, queue, hold and the send menu work at any point. "Start read-only" plays it on a read-only connection, with the access bar and the request for access. |

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
| `pin`, `pinopen` | Bots to pin, by id, and the pinned bot whose tasks show, for example `pin=pip,juniper,otto&pinopen=pip`; `rail=pinned` pins Pip and Juniper (app) |
| `menu` | `new`, `gateway`, or `bot` with `menubot=<id>` (app) |
| `panel` | `open` (app) |
| `tab` | `details`, `files`, `computer` (app) |
| `view` | `list`, `detail` (app, one-pane layout) |
| `banner` | `reconnecting`, `offline`, `syncing`, `synced`, `failed` (app) |
| `state` | `empty`, `loading`, `readonly`, `newtask`, `loaderror`, `nobots`, `discovering`, `zerotasks` (app); `error`, `busy` (connect); `copied`, `selected` (pairing) |
| `section` | One section of the gallery, by id (gallery) |
| `tier` | `read`, to start the scripted run on a read-only connection (scripted run) |
| `stopfail` | `1`, to make the first Stop request fail (scripted run) |

## Checks

The pages' behaviour is checked in a headless browser, from disk, with no server and no network. From the repository root, after `pnpm install` and, once, `pnpm exec playwright install chromium`:

```
node docs/design/prototype/tools/checks/shell.mjs
node docs/design/prototype/tools/checks/conversation.mjs
```

Each prints one line for every check, `ok` or `FAIL`, then a count, and exits with a failure when any check fails. `shell.mjs` covers the rail, tasks, pins, menus, the Work pane, the status strip and the pairing screen. `conversation.mjs` plays the scripted run through its visible controls and covers steps and Raw, copy, the Messaged cards, approvals and their form, questions, held and queued messages, Stop, a lost connection, the read-only tier, the phone width and the gallery.

## Files

| File | What it is |
|---|---|
| `css/tokens.css` | The token set to copy into `packages/ui/src/styles/tokens.css`. Step 2 of the change list in `visual-language.md` names the four layout sizes that change later. |
| `css/app.css` | The shell's styles, written against the shell's own markup and in the order of the change list in `visual-language.md`. |
| `css/conversation.css` | The conversation components' styles. |
| `css/prototype.css` | The control bar, the frame and the gallery's layout. Not product code. |
| `js/icons.js` | The icon set and the bot characters, drawn for Clawtrate. |
| `js/prototype.js` | The theme, width and motion controls. |
| `js/app.js` | The local model behind `app.html`: bots, tasks, selection, folding, pins, menus, sending, the connection, the Work pane. |
| `js/connect.js` | What the buttons on the connection screens do. |
| `js/components.js`, `js/samples.js`, `js/behaviors.js` | The conversation components' markup, their sample content, and their behaviour: the two views of a step, Raw, copy, the approval form, question cards and the keyboard paths. |
| `js/gallery.js`, `js/run.js` | The gallery and the scripted run. |
| `tools/make-local-fonts.mjs` | Builds the ignored local font stylesheet. |
| `tools/checks/` | Headless checks of the pages' behaviour: `shell.mjs` for the app and pairing pages, `conversation.mjs` for the scripted run and the gallery. |

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
