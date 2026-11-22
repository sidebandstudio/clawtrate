# Build your own Claw: the avatar studio

Issue #302. This turns the picture picker of `bots.md` section 3 into a studio where a person builds a bot's Claw with a large live preview: family, parts, colour and accessories, a "Surprise me", and a Custom row for their own pictures and for Claws described in words. In New bot the Claw follows the name as it is typed. A bot can also propose its own picture from chat.

It builds on #293 and draft PR #300: the shared spec in `packages/core/src/avatar.ts`, the renderer in `packages/ui/src/Avatar.tsx` and the picker in `packages/ui/src/bots/AvatarPicker.tsx`. It names every field it adds to that spec. The conversational tools of path (c), and the gateway route Describe needs, come from #292's self-management plugin.

The prototype is `prototype/avatar-studio.html`: New bot through Account and Create, Edit picture through Save, building with accessories, Surprise me, the Custom row, a simulated Describe a Claw, the chat proposal, and a board of every family wearing accessories in each state at each size inside the app's Presence ring. Dark is the default; light is shown too. `prototype/tools/checks/avatar-studio.mjs` checks it.

## Contents

1. Where the studio appears
2. The studio
3. Layout at desktop and phone width
4. Accessories as spec data
5. The saved picture and its two keywords
6. Pictures from a prompt: the rules all three paths share
7. Path (a): Describe a Claw
8. Path (b): a raster picture, behind a capability gate
9. Path (c): a bot proposes its own picture in chat
10. Which path to build first
11. Privacy and safety
12. Keyboard, screen readers and reduced motion
13. The iPhone app
14. For builders
15. The prototype's states

## 1. Where the studio appears

| Place            | Opened by                                         | Title             | Name field                 | Foot                                   |
| ---------------- | ------------------------------------------------- | ----------------- | -------------------------- | -------------------------------------- |
| New bot          | "+" then "New bot", or ⌘N                         | "New bot"         | yes, as in `bots.md` §3    | "Next" (the Account step), then Create |
| Edit picture     | a bot's menu or its Settings tab                  | "<Bot>'s picture" | no; the name shows as text | "Save", enabled once something changed |
| A bot's proposal | "Open in studio" on the proposal card (section 9) | "<Bot>'s picture" | no                         | "Save"                                 |

The studio replaces the first step of New bot in `bots.md` §3. The Account step and Create stay as they are, except for what Create writes as the picture (section 2, "The name's Claw"). Both places need admin access, as today (`agents.create` and `agents.update` are `operator.admin`). Below admin, the access bar of `bots.md` §2 takes the foot's place, and the studio still shows every choice.

## 2. The studio

From top to bottom:

1. **The head**: the title, centred, and Close.
2. **The stage**: the live preview at `--avatar-studio` (new token: 152 px in the dialog, 120 px in the sheet). On its left is a round "Play the states" button, and on its right a round "Surprise me" button (a die).
3. **The name** (New bot only): the 52 px pill of `bots.md` §3, and under it one line: what the Claw follows, or "Match my name".
4. **Four tabs**: Creature, Colour, Extras, Custom.
5. **The chosen tab's panel**, the only part that scrolls.
6. **The foot**: Next or Save. After a surprise, "Undo surprise" sits above it. While something is pending, a line says why the foot waits.

### The name's Claw (New bot)

New bot starts on the starter Clawling (`firstChoice("clawling", "blue")`). As soon as a name is typed, the Claw comes from the name.

- **One name, one Claw.** The name is trimmed, normalized to NFC and case-folded (Unicode default full case folding). Core carries the whole CaseFolding table (statuses C and F), so every platform and engine gets the same key; the prototype carries the 297 characters where that fold differs from a character's own `toLowerCase` (Unicode 17.0), so `I` and `ı` stay apart while `ß`, `ﬁ`, final sigma and Cherokee fold. The key is hashed with `avatarHash`, the id default's FNV-1a, once per field, as `clawtrate-name␀<key>␀<field>`. Bot ids hash as `<id>:<field>`, so the two hash inputs are always distinct. The set of Claws is finite, so a name and an id can still land on the same Claw by chance.
- **What it chooses.** Any family, that family's parts and a body colour. For about half of names, one accessory from all eight, in a colour other than the body's (`nameChoice` in `accessories.js`). It draws only from accessories that pass the fit and legibility checks of section 4; today that is all eight. An empty name, or only spaces, gives the starter.
- **"Default is a Clawling" still holds** for a bot with no picture: that rule is the id default of #293, used when `avatar` is absent. A name can choose any family because the name's Claw is saved as an explicit choice.
- **While typing**, the Claw takes the waiting pose and looks up toward the name. About 250 ms after the last keystroke it becomes the name's Claw: a 300 ms pop when the family changes, and a cross-fade of the old Claw over the new one when the family stays and a part or colour changes, which reads as a morph. 900 ms after the last keystroke it settles at rest, and the live region says once "From the name: Violet Lantern: …". Nothing changes between keystrokes faster than the pause, so it never flickers, and each settle is announced at most once.
- **Reduced motion**: no waiting look and no transition. After the same pause the new Claw is simply there, in its still pose.
- **A manual choice wins.** Choosing a starter, family, part, colour, trim or accessory, Surprise me, a Custom item, an idea from Describe, or an upload takes the Claw off the name. The line under the name becomes a quiet "Match my name" button, which gives the name's Claw back, with the same transition, and follows typing again. Undo surprise puts back the whole draft as it was, including whether it followed the name.
- **Edit picture** never takes a Claw from the bot's name, and neither does a proposal opened in the studio.
- **Leaving the name cancels it.** The moment the draft stops following the name (any manual choice above), the pending name and settle timers are cancelled, and a timer that fires late finds itself stale and does nothing. A pick made inside the 250 ms window stays.
- **Next** needs a name. Without one it says "Give your bot a name first." under the field and keeps focus there. Next first resolves a name still pending, then freezes one snapshot: the name and the Claw (or picture) shown. Account shows that name as text, not a field, so neither pointer nor keyboard can change it there; Back returns to the editable studio.

**What Create saves.** In the studio there is no untouched state: the name always picks a Claw, and Create cannot run without a name. Create saves exactly the Claw shown: the snapshot frozen at Next is what Account draws, what Create writes at 128 px with its tag (section 5), and what the read-back is confirmed against. Nothing changes the draft while it is written, so the bot looks the same after creation as in the dialog, on every device. This replaces, for the studio, #300's rule that an untouched New bot sends `avatar: null`. That rule belongs to #300's basic picker, which exists before the studio. When the studio ships, `NewBot` stops sending `null` for an untouched picker; a bot made by other means (the CLI, another client) still has no picture and still gets its id's Clawling.

### The live preview

- It draws the Claw being built, wearing its accessories, at rest (`idle`) and moving.
- **The happy beat.** Each manual choice plays the `done` pose for 1.1 s: the hop with the ball held up, and a hat lifting on the hop (section 4, "Motion"). Then the preview returns to rest. A choice made during the beat starts it again. The beat is skipped when motion is reduced, while the states play, and for a change that comes from the name.
- **Play the states** steps through idle, thinking, working, waiting, blocked and done, 1.6 s each. The state's word shows under the preview and is announced. Pressing the button again, or Escape, stops it. With motion reduced, it steps through the still poses. That counts as motion the person asked for, because nothing moves inside a pose.
- When the person's own picture is chosen (Custom), it shows cropped to a circle. While an idea from Describe a Claw is being looked at, the idea shows (section 7).
- Only the preview moves. Tiles in the panels show their Claw still.

### Creature

- **Starters**: eight ready-made Claws, each already wearing something, as 56 px tiles. They're quick picks, not characters: they have no names. Each one's accessible name describes it ("Violet Clawling: round, one eye, even claws, wearing a beret, round glasses and a bow tie in sky"). Choosing one replaces the whole choice. As soon as anything changes, no starter is chosen any more.
- **Family**: Clawlings, Shellfolk and Lanterns as 104 × 96 px tiles. Changing family keeps the colour and the accessories, and starts on that family's first parts (`firstChoice`).
- **The family's parts**, one radio group each, as in `bots.md` §3.

### Colour

- **Body**: the eight colours.
- **Accessories**: the same eight, offered once something that takes a colour is worn. Until then a line says "Accessories take a colour of their own once one is on (Extras)." The body's own colour is allowed, and its accessible name says it's the body's colour. The default is never the body's colour (section 4).
- **A crown alone** takes no colour: there's no picker, and a line says "The crown is always gold, so it takes no colour of its own." With a crown and something else, the picker colours the rest and a line says the crown stays gold. The words say "a gold crown".
- One line explains that none of the colours is red or orange.

### Extras

Three radio groups, each starting with "None":

| Group          | Slot   | Choices                                     |
| -------------- | ------ | ------------------------------------------- |
| On its head    | `head` | Beanie, Beret, Party hat, Crown, Headphones |
| Over its eyes  | `face` | Round glasses, Sunglasses                   |
| Round its neck | `neck` | Bow tie                                     |

Each tile draws the current Claw wearing that choice, with its word under it (72 × 76 px).

### Custom

One row: **Describe** and **Upload** as tiles, then the Custom items. An item is a Claw from Describe or a picture uploaded earlier, kept on this device: at most 12, newest first, normalized (a Claw's fields, or the 128 px redrawn picture). The description and the original file are not kept. Items are not synced and not sent anywhere. Choosing a Claw item puts its fields in the build. Choosing a picture shows it in the preview. A chosen item offers "Remove from this device". A line under the row says "Kept on this device, at most 12: the Claws and pictures only, not your words or files. The picture you save is kept with the bot on your gateway."

- **Upload** is "Use your own picture" from `bots.md` §3 with #300's checks (`imageHeader` in `AvatarPicker.tsx`), all before anything is decoded: under 25 MB; the real format and size from the first 256 KiB for all four formats (PNG's IHDR, GIF's screen, WebP's VP8, VP8L or VP8X chunk, JPEG's first frame header); at most 8,192 px a side and under 16 million pixels; with #300's fixed words. Then the decoded size again. It is cropped to its centre square and redrawn at 128 px, stepping down to 56 px to stay within 32,768 characters as a data URL. Only the latest upload may finish; a slower earlier one is dropped.
- **Describe** opens Describe a Claw inside the tab (section 7). It is disabled, with a line saying why, on a gateway without the route.
- **Picture** (section 8) is a third tile, disabled with "Image generation isn't available on this gateway" until its gate opens. It isn't in the first build.

### What is kept, and saving

- Closing keeps the draft until the app quits, bound to that gateway and bot; switching gateway or bot, or losing access, clears it. Create or Save clears it (`bots.md` §3).
- **Create** (New bot) and **Save** (Edit picture) draw the still pose at 128 px with the same scene, sockets and fit as the live preview, write the choice's one tag (section 5), and send `agents.create` or `agents.update`. Save rechecks admin first. The dialog closes once `agents.list` reads the picture back and the reader returns the same choice.
- **What blocks the foot**: a save in progress (no double submit), an upload still decoding, Describe still waiting, or ideas not yet used or closed ("Use an idea or close the ideas first.").
- **Failures** keep the draft and the dialog: "**Couldn't save the picture.** Your changes are still here." Refused access shows the access bar. A lost read-back says the save couldn't be confirmed and reads again before offering to retry, so a write is never sent twice blind.
- The live region announces: "Beret on", "Round glasses off", "Pink", "Surprise: a pink Lantern…", "Back to…", "From the name: …", "Matches the name again: …", the state names while they play, "<Bot> is imagining it", "Asking once more for a reply Clawtrate can read", "Three ideas from <Bot>", "Couldn't make a Claw from that. Nothing changed.", "Created <Bot>", "Saved <Bot>'s picture".

### Surprise me

Surprise me picks a random family, parts and body colour. Four times in five it adds one or two accessories in a colour other than the body's. It never repeats the current Claw. It plays the beat and offers "Undo surprise", which restores the complete draft from before, including a chosen picture and whether the Claw followed the name. Undo goes after the next choice of any kind.

## 3. Layout at desktop and phone width

|         | Desktop (688 px and wider)                                          | Phone (below 688 px, and the iPhone app)                                                                |
| ------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Frame   | A dialog, 600 px wide, up to 780 px tall, radius 18, over the scrim | A sheet over the whole screen, 8 px from the top, radius 18 on its top corners                          |
| Preview | 152 px, with 40 px round buttons beside it                          | 120 px, with 44 px round buttons beside it                                                              |
| Tabs    | Centred pills, 32 px                                                | They share the width equally, 44 px tall                                                                |
| Tiles   | 56 px; accessories 72 × 76                                          | The same; rows wrap and stay centred                                                                    |
| Targets | Pointer sizes                                                       | 44 px for every control, with or without a pointer: Close, the round buttons, compact actions, swatches |
| Foot    | The primary button full width, 48 px                                | The same, above the home indicator                                                                      |

The stage, the name and the tabs never scroll away, so the preview is always in view while choosing. The Account step keeps the preview and the name in view and hides the tabs.

**The ideas' actions** ("Use this", "Try again", "Change the words") are their own row between the panel and the foot, outside the panel's scrolling, so they stay whole and in reach on a phone with the panel at any position, including with the keyboard up. The check hit-tests a 44 px target on every control at 390 × 844 and 390 × 520, with the panel scrolled to its top and its bottom.

Screenshots: `studio-new-1440-dark.png`, `-1440-light.png`, `-390-dark.png`, `-390-light.png` and the rest in the review folder (the report lists them).

## 4. Accessories as spec data

Everything in this section is data in `packages/core/src/avatar.ts`, on the same 40-unit grid, and is drawn by the same renderer. `prototype/js/accessories.js` holds the same data.

### Sockets

Each family's scene builder returns typed **sockets** with its scene, and draws the accessories at them itself. A socket is `{ x, y, scale, tilt, layer }`: where the accessory's own origin goes, its size, its turn in degrees, and where in the drawing order it goes. Readers and the renderer never parse an SVG transform string to find one.

| Socket  | Per   | What it holds                                                                                                      |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `head`  | scene | A hat's brim middle, `scale` = brim width / 10, tilt, layer                                                        |
| `band`  | scene | Headphones: `left` and `right` cup centres, the band's `apex`, layer                                               |
| `eyes`  | eye   | Each eye's centre, scale (1.1 in waiting) and `k` (1, or 3.7/3.1 for a large eye); glasses and shades go inside it |
| `rings` | eye   | The round glasses' radius for that eye, fitted to the room between the eyes                                        |
| `neck`  | scene | The bow tie's centre and scale, layer                                                                              |

Layers: `after-body`, `before-opening` (a Shellfolk's hat, on the shell, before the opening it hides in), `on-top` (a one-eyed Clawling's hat), `before-eyes` (the headphone band passes behind a socket), `in-eye`, `after-mouth`, `in-neck`.

_The prototype_: `creatures.js` is generated from `avatar.ts`, and a test fails when it is edited by hand, so in this design round its builders can't return sockets. One function, `sceneSockets`, stands in for them: it reads each eye's placement once, and everything after it works from typed sockets. The check AS-30 compares those sockets with where every eye is drawn, in every state, so the stand-in can't drift. Returning sockets from the builders is part of build step 2.

### New names in the spec

| Name                                                 | What it is                                                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AVATAR_HEADWEAR`                                    | `["beanie", "beret", "party", "crown", "headphones"]`                                                                                                            |
| `AVATAR_FACEWEAR`                                    | `["glasses", "shades"]`                                                                                                                                          |
| `AVATAR_NECKWEAR`                                    | `["bowtie"]`                                                                                                                                                     |
| `AVATAR_ACCESSORIES`                                 | `{ head, face, neck }`: the three lists by slot, in picker order                                                                                                 |
| `AvatarAccessories`                                  | `{ head?: AvatarHeadwear; face?: AvatarFacewear; neck?: AvatarNeckwear; trim?: AvatarColor }`, joined to every member of `AvatarChoice`                          |
| `AvatarSocket`, `AvatarSockets`                      | The typed sockets above, returned with `AvatarScene`                                                                                                             |
| `AVATAR_TRIM_DEFAULT`                                | The accessories' colour when `trim` is absent, per body colour: green→violet, blue→yellow, orchid→sky, violet→lime, yellow→blue, pink→sky, sky→pink, lime→violet |
| `AVATAR_GOLD`                                        | The crown's colour: the palette's yellow `#f6bd3b`, whatever the trim, with a rim of `shade(gold, 0.3)`                                                          |
| `HEAD_SOCKETS`, `NECK_SOCKETS`, `LANTERN_HEADPHONES` | The socket tables below                                                                                                                                          |
| `AVATAR_FIT_INSET`                                   | The equipped scene's inset per family, parts, hat and eyewear (below), generated from the builders' whole outline and checked by a test                          |
| `"tip"` in `AvatarMotionName` and `AVATAR_MOTIONS`   | A hat's lift on the done hop                                                                                                                                     |
| `AVATAR_PNG_KEYWORD_V2`                              | `"clawtrate-avatar-v2"` (section 5)                                                                                                                              |
| `avatarNameChoice(name)`                             | The name's Claw (section 2)                                                                                                                                      |

`ShapeCommon.part` gains `wear-<name>`, `wear-bridge`, `hat-motion` and `fit`, for tests and readers.

### The shapes

Each hat is drawn in its own frame, with the middle of its brim at 0,0, a 10-unit brim, and the crown upward. Hats, cups and bow-tie wings carry an edge of `shade(trim, .38)`, 0.5 units wide, so a trim in the body's own colour still reads as its own shape.

| Accessory     | Shapes                                                                                 | Colours                                                                           | Fine (dropped below 21 px)          |
| ------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------- |
| Beanie        | A dome 6 units tall, a cuff (a rounded rect), a pom (r 1.5)                            | Trim; cuff `shade(trim, .18)`; the pom is the logo's ball (`AVATAR_BALL`, rimmed) | Three ribs                          |
| Beret         | A slanted flat cap                                                                     | Trim                                                                              | The band and the stalk on top       |
| Party hat     | A cone 8.6 units tall with the logo's ball (r 1.4) at its tip                          | Trim; the ball                                                                    | Two stripes in `AVATAR_BALL`        |
| Crown         | Three points on a band                                                                 | `AVATAR_GOLD`, rim `shade(gold, .3)`                                              | The jewel in its middle             |
| Headphones    | A band over the top and two 3.2 × 5.2 cups                                             | Cups trim; band `shade(trim, .3)`                                                 | none                                |
| Round glasses | A ring inside each eye (its `rings` radius, at most 3.75·k, stroke 1.05), and a bridge | Trim                                                                              | All of it: the rings and the bridge |
| Sunglasses    | A flat-topped lens over the lower part of each eye, and a bridge                       | Lens `AVATAR_INK`, rim trim                                                       | The bridge and the glint            |
| Bow tie       | Two wings and a knot, 8.6 units wide                                                   | Trim; knot `shade(trim, .22)`                                                     | none                                |

A lens or ring is drawn inside each eye's own group, so it follows the eye in every state: the lean, the droop, the 1.1 scale of waiting, and the peek from inside a shell. The bridge runs between the two eyes' sockets in their shared parent and is left out when the rims already meet.

- **Glasses' room.** A ring's radius is the smaller of 3.75·k and half the gap between the two eye centres less 0.6, so rims never cross, including in a blocked Shellfolk's narrow peek.
- **Sunglasses and the face.** In idle and waiting the lens covers the eye from 0.75 units above its centre down. In thinking, working, blocked and done, which carry their look in the lids and the happy eye, the lens starts 0.6 units below the centre and is 72 % opaque, so the lid line, the pupil and the happy arc still read with one eye.

### Socket tables

**Hats** (beanie, beret, party hat, crown), `head`:

| Family             | Where                                                                            | Socket (x, y), brim width, tilt                                                                        |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Clawling, two eyes | On the body's top, between the stalks; `after-body`, so the eyes stay in front   | dome (20, 18) 11 0°; tall (20, 16.5) 10.6 0°; wide (20, 22) 11.6 0°; round (20, 19.5) 11 0°            |
| Clawling, one eye  | On the eye's socket rim, 8 wide, riding the stalk; `on-top`                      | (eye x, eye y − 4.35·k·scale + 0.5)                                                                    |
| Shellfolk          | On the shell, which stays put while the critter acts and hides; `before-opening` | spiral (24.6, 9) 10 4°; turret (30.2, 8.6) 7 30°; dome (25.2, 13.9) 10 0°; spotted (24.8, 11.9) 10 3°  |
| Lantern            | Left of the crown, clear of the lure, at a jaunty tilt; `after-body`             | round (13.4, 17) 9 −32°; bell (13.9, 17) 8.6 −32°; oval (13.4, 18.8) 9 −26°; box (13.4, 16.8) 9.2 −18° |

Blocked, a Lantern's lure droops to its left, where the hat sits. The hat slips down the body's side by (−2.4, +3.2) and turns a further −30°, clear of the dimmed ball.

**Headphones**, `band`:

| Family              | Where                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clawling, Shellfolk | Over the eyes: a cup 1.2 units outside each outer eye's socket, and the band's top 1.6 units above the higher socket, from the eye sockets, so they follow them. One eye wears both cups. `before-eyes`. |
| Lantern             | At the body's sides: round (8.4, 23.4)–(31.6, 23.4), top 12.2; bell (8.6, 25.2)–(31.4, 25.2), top 12.4; oval (7.4, 26.2)–(32.6, 24.2), top 14; box (8, 24.4)–(32, 24.4), top 13.4. `after-body`.         |

The band is a cubic from cup to cup. Both handles sit at the height that puts its top at the socket's apex.

**Bow tie**, `neck`, below the lowest mouth any state draws (the open waiting mouth reaches the mouth line + 2.8), in one place in every state so it doesn't jump between states: Clawling dome (20, 32.8) ×0.85, tall (20, 31.8) ×0.8, wide (20, 33.6) ×0.85, round (20, 32.8) ×0.85; Shellfolk at the front of the neck (10.4, 28.6) ×0.9, `in-neck`; Lantern round (20, 34.4) ×0.85, bell (20, 35) ×0.85, oval (20.3, 35.6) ×0.8, box (20, 34.8) ×0.85. All `after-mouth` but the Shellfolk's.

### Fit

The saved picture is cropped to a circle by other apps, and the Presence ring sits just outside the avatar while working. The rules, measured on the whole drawn outline (body, claws, lure and accessories) of every base creature with every hat and eyewear and the bow tie:

- **Still poses**, every state: accessories stay within 19.6 units of the centre (the 40-unit circle less a pixel at 128 px), and the silhouette reaches no further than 20 units or the bare creature already does.
- **Working, at its motions' peaks**: accessories stay inside the Presence ring's inner edge, and the silhouette no further than the ring or the bare creature. The ring is read from the app's own Presence CSS at the sizes it is drawn (18, 22, 32, 40, 44, 56 and 64 px); its tightest inner edge is 21.56 units, at 64 px.
- **Other states, at their peaks** (sway, lean, hop and the hat's tip): accessories within 22.4 units. No ring is drawn then.
- **The inset.** Where an outfit would break a rule, the whole equipped scene is drawn smaller about its feet (20, 36), by the largest factor that meets them all, in 0.01 steps. It is one factor for the outfit in every state, so the Claw doesn't change size between states. It depends on the family, the parts, the hat and the eyewear; colour and the bow tie don't change it. Today 294 outfits are inset, the smallest factor is 0.83 (a dome Shellfolk in headphones), and Lanterns need none. In the product `AVATAR_FIT_INSET` is generated from the builders the same way, and a test fails when a builder change makes it stale. In the prototype `tools/make-fit-inset.mjs` writes `js/fit-inset.js` from `js/fit-measure.js`, and the check regenerates it and fails on any difference.
- **The saved still's mask.** No outfit's 128 px still has more pixels outside the circle than its bare creature has.
- **Bare art.** 40 of the 84 bare creatures (Shellfolk shells, mostly) already reach a little past the circle in the saved still. That is #293's art and is being fixed in #300. The rules above compare against the bare creature, so an accessory adds no overflow either way.
- **Presence motion.** In the product a creature's Presence moves only by the creature's own motion, with the ring and the badge. The older characters' whole-SVG sway, bob, lean and slump don't apply to creatures; the board leaves them out.

The board shows every family wearing things in each state at 18, 22, 32, 56, 120 and 152 px inside the app's real Presence wrapper, with the working ring and the waiting and blocked badges, and the saved still beside each row. `?peak=1` holds every motion at its peak. Its rows include the extremes: the tallest Clawling (tall, splayed, big claws) in a party hat, sunglasses and bow tie; a one-eyed Clawling in a beanie; the turret Shellfolk in a party hat; a bell Lantern with the wave lure and a crown.

### Colour rules and the palette guard

- Accessories take one colour, `trim`, from the same eight colours, plus darker shades of it made with `shade()`. The crown is always gold. Lenses are ink. Poms and stripes are the logo's ball.
- `shade()` keeps a colour's hue. Every palette colour sits outside 345°–38° (yellow is at 41.7°), so every shade passes `isGuardedColor`. The check AS-10 tests every trim at every shade used (0.18, 0.2, 0.22, 0.28, 0.3 and 0.38) and the gold with its rim. Nothing about an accessory is ever red or orange.
- `trim` defaults through `AVATAR_TRIM_DEFAULT`, never to the body's colour. The person may choose the body's colour; the edge keeps the shape readable.
- A crown alone always carries the default trim, because nothing else would be saved for it.
- Colours are the same in light and dark.

### States

The whole Claw, accessories included, mutes when blocked (`data-muted`).

| State    | Hats                                                                                      | Headphones                                    | Glasses and shades                                                        | Bow tie                                       |
| -------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| idle     | Seated                                                                                    | On                                            | Blink with the eyes; the lid shows above a lens                           | On                                            |
| thinking | Sway with a Clawling; stay on a Shellfolk's shell; stay on a Lantern while its lure sways | Lean with a Clawling's or Shellfolk's eyes    | Follow the eyes looking up; the lens drops and lets the lid through       | On                                            |
| working  | Bob with the body; a Shellfolk's crawl carries the shell                                  | Bob                                           | Follow the eyes; the lens drops                                           | Bobs                                          |
| waiting  | Seated; a one-eyed Clawling's hat rises with its eye                                      | Widen with the eyes (1.1)                     | Scale with the eyes                                                       | Below the open mouth                          |
| blocked  | Stay on, muted. On a hiding Shellfolk the hat stays on its shell; a Lantern's hat slips   | Hidden on a hiding Shellfolk; muted elsewhere | Droop with a Clawling's stalks; peek with a Shellfolk's eyes, rims fitted | Hidden on a hiding Shellfolk; below the frown |
| done     | Lift 1.6 units and tip −12° at the hop's peak (`tip`)                                     | Hop                                           | The lens drops below the happy eyes                                       | Hops                                          |

### Motion

A hat is three groups: the socket's place and turn, then the motion about the brim's own middle (0, 0, in the hat's frame), then the brim's scale. `tip` animates the middle group. It loops at 3,200 ms on the hop's own easing, so the two peak together: 0 at 0 and 0.05, then `translate(0, −1.6)` with `rotate(−12°)` at 0.11, then 0 again from 0.18 to the end. The fit is measured at the tip's peak and when it has settled. With motion reduced, the hat stays seated: a still pose, never a frame from inside the lift.

### Sizes

| Size         | Where                                                                                                        | What is drawn                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18 px        | Message card                                                                                                 | Hat silhouettes with their edges, poms, the crown's band, headphones, sunglass lenses, the bow tie. **Dropped**: round glasses entirely, every bridge, ribs, stripes, the beret's band and stalk, the crown's jewel, the lens glint. They are all under half a pixel wide there. |
| 22 px and up | Title pill (22), rail row (32, 40/44), pinned tile (56), Work pane (64), studio (152 / 120), the board's 120 | Everything                                                                                                                                                                                                                                                                       |

The rule is the existing one, `fine` below `AVATAR_FINE_MIN_PX` (21).

**The first release keeps only accessories that pass the fit and legibility checks** (open question 8). In this round all eight pass the measured checks (AS-26: still crop, ring at peaks, mouth, rims, lure) and the board's visual review at 18, 22 and 32 px, so all eight ship. An accessory that fails a later builder change leaves the pickers, the name's Claw and Surprise me until it passes again; saved choices wearing it still read and draw.

## 5. The saved picture and its two keywords

The choice is kept as it is today: a 128 px PNG of the still pose, sent as the bot's `avatar` through `agents.create` or `agents.update`, with the choice in one `tEXt` chunk. The still pose shows the accessories, so any client sees them.

### Two keywords

| Choice        | Keyword               | Text                                       |
| ------------- | --------------------- | ------------------------------------------ |
| Nothing worn  | `clawtrate-avatar`    | Version 1, byte for byte as #300 writes it |
| Anything worn | `clawtrate-avatar-v2` | Version 2, the grammar below               |

Why a new keyword: #300's strict reader at `59aeea0a` treats a `clawtrate-avatar` chunk it cannot parse as an invalid picture and draws the bot's id Clawling instead. A version 2 text under the old keyword would make every older Clawtrate replace a hat-wearing Claw with a different creature. Under a keyword it doesn't know, #300's reader sees a plain picture and shows the PNG, accessories included, still. Standard PNG consumers ignore the ancillary text and decode the pixels. Any future format a strict version 2 reader cannot parse takes another new keyword.

### The version 2 grammar

Literal characters and case; the family's fields in this order:

```text
base = "family=clawling&body=" clawlingBody "&eyes=" clawlingEyes "&claws=" clawlingClaws "&color=" color
     | "family=shellfolk&shell=" shell "&color=" color
     | "family=lantern&body=" lanternBody "&lure=" lure "&eyes=" lanternEyes "&color=" color

clawlingBody = "dome" | "tall" | "wide" | "round"
clawlingEyes = "pair" | "splayed" | "short" | "single"
clawlingClaws = "even" | "fiddler" | "big"
shell = "spiral" | "turret" | "dome" | "spotted"
lanternBody = "round" | "bell" | "oval" | "box"
lure = "hook" | "flick" | "wave" | "reach"
lanternEyes = "two" | "one"
color = "green" | "blue" | "orchid" | "violet" | "yellow" | "pink" | "sky" | "lime"

v1 = "v=1&" base
v2 = "v=2&" base ["&head=" head] ["&face=" face] ["&neck=bowtie"] "&trim=" color
head = "beanie" | "beret" | "party" | "crown" | "headphones"
face = "glasses" | "shades"
```

At least one of head, face and neck. The longest text is 123 bytes.

### Writing

- One tag per PNG, just after IHDR. Writing removes any chunk under either keyword (and any broken version 2 tag, below) first, and keeps every other chunk. The result must stay within #300's 128 chunks: a picture that already has 128 can't take the tag, and writing is refused rather than producing a file both readers reject.
- Unequipped: the old keyword and unchanged version 1 bytes. Equipped: the new keyword and version 2, always with an explicit `trim`.
- The 128 px still is drawn from the same scene, sockets and fit as the live Claw. A result over 32,768 characters steps down to 96 px, as uploads do; none comes close today (the longest saved still in the check is 11,982 characters).

### Reading

- **No recognized tag**: a plain picture, shown as it is.
- **Exactly one recognized tag**: `clawtrate-avatar` is read by #300's strict version 1 rules, unchanged; `clawtrate-avatar-v2` must match the grammar exactly. Only the grammar's own keys are projected into a fresh choice.
- **Duplicate recognized tags, both keywords together, or a tag that doesn't parse**: the strict invalid-picture path, as #300 does (the bot's id Clawling).
- **A broken version 2 tag**: a `tEXt` chunk that starts with `clawtrate-avatar-v2` and has no separator at all is malformed, so the picture is invalid, alone or beside a valid tag. The version 1 keyword keeps #300's reading, where such a chunk is ignored.
- Refused in version 2: duplicate or extra keys, empty values, `none`, `null`, whitespace, escapes, other case, non-ASCII bytes, out-of-order fields, a missing `trim`, and nothing worn.
- Kept from #300: canonical base64, the 200-byte text limit, 128 chunks, 32,768 characters, CRCs, the header rules, IEND last with nothing after it.

### Compatibility

| Reader                 | Version 1 picture | Version 2 picture                                                |
| ---------------------- | ----------------- | ---------------------------------------------------------------- |
| #300 (strict v1)       | The Claw, moving  | A plain picture: the still PNG in a circle, accessories included |
| This design            | The Claw, moving  | The Claw with its accessories, moving                            |
| Any other PNG consumer | The still         | The still                                                        |

Existing pictures, version 1 and uploads, are read in place. There is no bulk migration on the gateway. A client that can only show the still never rewrites a picture it didn't change.

The checks (AS-11, AS-27) run real PNGs from the browser's canvas through both readers: every family with every accessory, the image-load path, writes after other metadata, an upload redrawn with its metadata stripped, a bad CRC, trailing bytes, both keywords, a doubled tag, and version 2 text under the old keyword.

### Untrusted choices

`parseAvatarChoice` stays exact for the family's own keys. A bot's proposal (path c) is parsed strictly too: the family's fields exactly, and `head`, `face`, `neck` and `trim` each checked against its closed list. Own keys only; `none`, `null`, a lone trim or an inherited key refuses the whole input, and the bot sees a tool error it can correct. Normalizing absent, null or `"none"` slots happens only at the model-reply boundary of section 7.

## 6. Pictures from a prompt: the rules all three paths share

- **Nothing leaves the gateway the bot already uses.** Clawtrate sends a description only to that gateway, over its existing connection, and never calls a model or image provider itself. The studio names the provider and model before anything is sent.
- **Nothing is saved until the person confirms.** Every path ends in a preview of the result, the person's choice ("Use this", "Use it"), and then the same Save as Edit picture.
- **Input is untrusted.** What a model writes is parsed against fixed lists, never run and never shown as words. A Claw is only fields that pass section 5's parse. A picture is only an image that decodes, is redrawn by Clawtrate onto a 128 px canvas, and is then sent as a PNG (section 11).
- **The bot's agent loop is not involved for (a) and (b).** Describe runs with no callable tools; a raster picture needs a purpose-bound gateway result. Path (c) is a conversation the person started themselves, under the bot's normal policy.

## 7. Path (a): Describe a Claw

The person writes a description. The bot's model turns it into spec fields through a tool-free route. The studio shows the ideas to use, tweak or retry. It works with any model, and the result is always a Claw.

### Flow

1. Custom → Describe. A field labelled "Describe a Claw" (up to 200 characters, placeholder "A sleepy lantern who loves jazz") and "Make it". Enter makes it, and Shift+Enter adds a line. Under the field, before anything is sent: "Sent through your gateway to <Bot>'s model, <provider/model>. This uses that account's model usage. The model gets no tools and none of the bot's memory or conversations. A reply in the wrong shape gets one short retry, which can use a second turn."
   - **New bot**: the bot doesn't exist yet. Describe is offered only through an explicit, named route the operator can check before sending: "Sent through your gateway with <Main bot>'s model, <provider/model>, because this bot doesn't exist yet." Without that route, the tile says "Describe works once the bot exists" and stays disabled.
2. **Waiting**: the preview's Claw plays `thinking`. A waiting line says "<Bot> is imagining it…", and Cancel sits beside it, outside the status. After 10 s: "Still imagining. It stops after 45 seconds." During the retry: "Asking once more for a reply Clawtrate can read…".
3. **Ideas**: one to three tiles under "<Bot>'s ideas", the first chosen and shown in the preview. Under them, Clawtrate's own words for the chosen idea, from its fields: "Idea 1 of 3: Sky Lantern: round, hook, two eyes, wearing headphones in violet". Nothing the model wrote is shown. Actions: "Use this", "Try again" (same words, new ideas) and "Change the words".
   - Words asking for red or orange (Clawtrate reads them locally) get a fixed note: "There's no red or orange: Claws keep clear of lobster and crab colours. Pink is the closest."
4. **Use this** puts the idea's fields into the build and adds the Claw (not the words) to the Custom row. The person can then change anything in the other tabs. Nothing is saved until Next or Save.
5. **Failure**: a danger note says "**Couldn't make a Claw from that.** <Bot>'s reply didn't name parts the studio has, twice. Nothing changed.", with "Try again" and "Change the words". Other reasons use the same note: "<Bot> didn't answer in 45 seconds.", "The connection dropped.", "<Bot>'s model refused." and "<Bot>'s account couldn't run it (<the account notice of bots.md §13>)."
6. **Unavailable**: on a gateway without the route, the Describe tile is disabled and the panel says: "**Describe a Claw isn't available on this gateway.** It needs a way to send your words to the model with no tools, and this gateway doesn't offer one yet."

### Where it runs: a tool-free route

A normal chat turn can't carry Describe. In OpenClaw 2026.10.6, `sessions.create { message }` (`sessions-create-BBtQVEho.mjs`) sends the first message through normal chat, so the bot's tools could run before Clawtrate sees the reply, and rejecting the reply afterwards cannot undo a call. The pinned schema's `toolOverrides` covers MCP, skills and web search, and `read-only` is a permission mode; neither gives a verified empty tool surface.

So Describe uses a **gateway-owned text generation route** that admits a request only with:

- zero callable tools, provider-native tools (web search, code execution) included;
- no bot workspace, memory, conversation history, or live hooks;
- the bot's own authorized provider account and model on that gateway;
- the description serialized as data in a dedicated request field, never spliced into instructions.

**It is a first-release dependency in #292's self-management plugin**, as a client method (proposed `clawtrate-bots.describeAvatar`, `operator.admin` like the rest of the studio, **unverified**):

- Request: `{ agentId, attemptId, description, schema }`, bound to gateway, bot, route and attempt.
- One 45-second deadline across at most two text turns (the reply and one formatting retry). The result is matched to the returned run id; late replies are discarded.
- `clawtrate-bots.describeAvatar.cancel { attemptId }` aborts on Cancel or the deadline, and the plugin cleans up if the client disconnects.
- A capability read (`operator.read`) says whether the route exists and which provider and model it would use. Describe is unavailable when it is absent.

Why #292's plugin and not the local plugin used for relay pairing: #292's plugin must already be installed for path (c), and it owns the proposal records and the admin commit (section 9), so one Clawtrate plugin carries the whole picture surface and its review. The relay-pairing plugin isn't in this repository's `plugins/`, so its install base and trust boundary can't be checked from here, and pairing has no reason to hold a model route.

**Only if the isolation probe proves it**, a session could stand in: a fresh, unforked incognito session per press, with no parent, delivery target or conversation history, with the bindings, deadline, run-id match and cancellation above, deleted on every exit through the delete handler's incognito delete-without-archive path. The source grants admins access to incognito targets, so incognito alone establishes neither invisibility nor confidentiality: the probe must show, with a second client, that the session stays out of `sessions.list`, history and events, and that the tool surface is empty. There is no ordinary hidden-session fallback.

### What the model is asked

One request, in this shape (the builder owns the exact words). The schema and the tool policy supply the boundary, whatever the description says:

> Turn the description into Claws, Clawtrate's bot avatars. Reply with one JSON object only: `{"ideas":[1 to 3 objects]}`. Each object has `family`, that family's parts, `color`, and optionally `head`, `face`, `neck` and `trim`, using only these values: <the lists from the spec>. There is no red or orange.
>
> `description`: "<the words, as a JSON string>"

### The reply, bounded

1. At most 4 KiB of UTF-8, measured before parsing.
2. Exactly one JSON object, with surrounding whitespace only: no prose before or after it.
3. A duplicate-aware parse, capped at three levels: the envelope, its array, flat idea objects. Any duplicate key, deeper nesting, number or boolean refuses the reply.
4. The envelope has one own key, `ideas`, holding one to three objects.
5. Each idea, at this boundary only: its own keys must be its family's fields, `head`, `face`, `neck` and `trim`, checked before anything is copied (a `"__proto__"` key included), and the copy goes into a null-prototype object. A `null` or `"none"` head, face or neck is nothing worn; `trim` may not be `null`; a palette-valid lone trim is dropped; an equipped idea without a trim takes the default. Then section 5's strict parse. An idea with an unknown or wrong-family key, a value outside its list, a null trim or another non-string value is dropped; the rest of the reply is still read.
6. Ideas are deduplicated by their canonical text. The valid ones are shown.
7. A reply refused at steps 1–4, or with no valid idea, gets the single bounded retry ("That wasn't one JSON object with the listed values. Reply again with JSON only."). A second refusal is the failure note.

AS-28 tests each of these.

## 8. Path (b): a raster picture, behind a capability gate

### What OpenClaw 2026.10.6 offers

This was read from the installed package and the pinned protocol schema. No gateway was run. The report gives file paths and line numbers.

- **The tool**: `image_generate`, a core agent tool. It exists only when the gateway has an image model (`agents.defaults.mediaModels.image`, a provider key, or an OpenAI ChatGPT/Codex sign-in). Providers include OpenAI, Google Gemini, OpenRouter, fal, DeepInfra, LiteLLM, Microsoft Foundry, MiniMax, xAI, Vydra and ComfyUI; these are examples, and the route actually used is the gateway's.
- **Calling it from a client.** `operator.write` is the right minimum for the WebSocket `tools.invoke` method (`core-method-policy-DkntKRY_.mjs`). `tools-invoke-shared-ytTKyozQ.mjs` defaults to `main`, resolves the HTTP tool surface, then checks session authority, tool policy and approval hooks. `image_generate` is absent from the default HTTP deny list, but a catalog entry is not execution permission, and the development gateway's fixture denies it explicitly.
- **What comes back.** `openclaw-tools-DV-z1IAc.mjs` normally detaches for a session with a requester transcript and delivers later, into that conversation. Inline execution returns media paths and attachment metadata on the gateway host, with no bytes and no artifact id. `artifacts-CVcZMNpQ.mjs` needs an artifact id and resolves it among authorized records. `action: "list"` gives possible routes and readiness, but generation can pick another route.
- **Cost.** Provider fees or quotas depend on the route. The source exposes no quote, and the 180-second timeout in the docs is a configuration example.

### The gate

The **Picture** tile stays disabled, with "Image generation isn't available on this gateway", until a development-gateway probe establishes all of these for a purpose-bound gateway result:

- It yields bounded bytes, or a minted short-lived asset id authorized for this request, over the existing gateway connection. Never a raw local path or a model-supplied URL.
- One image per confirmed press; type, size and decode limits; cleanup; cancel semantics; and no retry after an uncertain accepted request.
- The actually permitted route, or the configured fallbacks, can be shown before sending: "Made by <provider/model> through your gateway. Your provider may charge for each picture."

A read-only capability check can use `operator.read`. Creating any side session and writing the avatar still need `operator.admin`. Once open, the view follows the design of the first round: the same field as Describe, one picture per press, a placeholder while waiting, the result centre-cropped and redrawn at 128 px with "A picture, not a Claw: it won't act out states.", and failures that each say "Nothing changed."

## 9. Path (c): a bot proposes its own picture in chat

For example, "Make an avatar for yourself based on something you know about me." The bot uses #292's self-management tools.

### The tool contract

The #292 plugin offers the bot one tool, `clawtrate_avatar_propose`. The bot never writes its own picture. Its argument is `{ choice: { family, …parts, color, head?, face?, neck?, trim? } }`, parsed strictly as in section 5; an invalid choice is a tool error the bot sees and can correct. The tool returns `{ status: "proposed", proposalId }` and says plainly that nothing has changed until a person chooses. Raster proposals (`{ picture: { artifactId } }`, limited to a verified same-bot, same-run image artifact) wait for section 8's gate.

### Proposal records, owned by the gateway

- **Keyed** by gateway, bot, source session and run, and an opaque proposal id.
- **Authority** comes from the authenticated tool context: the proposer and the target bot are never taken from the arguments. #292's self-management boundaries apply.
- **Bound** to the current picture's version or digest when proposed.
- **Expiry**: 24 hours on the gateway's clock. A newer proposal from the same bot supersedes the older; a change to the picture invalidates it at once.
- **Client actions**: list, read, accept, decline and undo, each idempotent by proposal id, with one outcome shared across devices.
- **One commit.** "Use it" on the card and Save from "Open in studio" go through the same admin commit, which carries the proposal id and the expected current picture. Undo uses the same condition.
- **Stale writes.** `agents.update` followed by `agents.list` confirms a result but cannot stop two writers racing. Until the gateway offers a compare-and-write (or equivalent), the design promises no protection against a concurrent change, only detection afterwards. A lost acknowledgement is reconciled by reading before any retry.

If #292's plugin does not already provide these records and the commit, they are their own piece of work, before the card (section 14).

### What the person sees

The conversation draws the tool call as a card, the way action cards are drawn from tool events (`conversation.md`). The card is "A new picture for <Bot>", "Proposed by <Bot>". It shows the current picture and the proposed one at 64 px, side by side, then the proposal in words ("Sky Lantern: round, hook, two eyes, wearing headphones in violet"), then "Nothing changes until you choose." It has three actions:

| Action             | Then                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Use it**         | The admin commit. The card says "<Bot>'s picture changed" with Undo, and a centred event line records the change. Undo is offered until the next change. |
| **Open in studio** | The studio opens as Edit picture, starting from the proposal; its Save is the same commit                                                                |
| **Not now**        | "Kept its picture." Nothing is written                                                                                                                   |

Other states, each with its own words:

- **Below admin**: "**Admin access needed.** Changing <Bot>'s picture needs admin access."
- **Expired**: "This proposal expired after 24 hours. Ask <Bot> again for a new one."
- **Superseded**: "<Bot> proposed a newer picture, so this one no longer applies."
- **Changed elsewhere**: "<Bot>'s picture was changed somewhere else since this was proposed, so it no longer applies."
- **Save unconfirmed**: "**Couldn't confirm the save.** <Bot>'s picture may or may not have changed. Checking again reads it from the gateway before anything is sent twice." with "Check again".
- **Used or declined on another device**: the shared outcome, as if chosen here.

The outcome lives on the card; no synthetic chat message is added. Before promising that the bot sees its new picture, that has to be verified.

### Asking before saving, and #292's autonomy choice

A picture is the bot's identity, shown on every device, and #302 requires that the person sees and confirms it. So **a picture change from chat is always a proposal, under either autonomy choice**: the tool has no way to write. An explicit request to make a picture already authorizes preparing the proposal within the bot's policy, so the bot doesn't ask "Want me to make one?" first. #292's approval policy still governs any preparatory tool that needs approval (reading memory, for example).

### Where it runs

- In the conversation the person is having, because they asked there. The bot may read its memory, which is the point of "something you know about me".
- Channel and MCP delivery of proposals wait until their authorization and their delivery and read-back are established.

## 10. Which path to build first

**Build (a), Describe a Claw, first, after its route exists.**

- It works with every model on every gateway that has the route. (b) needs an image model and a purpose-bound result that don't exist yet.
- Its result is always a Claw: on-brand, moving, under the palette guard, saved with the version 2 keyword, and drawn the same on the iPhone.
- Its reply boundary and confirm step are what (c) needs.
- It costs one short model turn, or two with the retry, and no image fees.

Then (c), once #292's proposal records and commit exist. (b) stays behind its gate.

## 11. Privacy and safety

- **Descriptions** go only to the bot's own gateway, through the tool-free route. Clawtrate keeps them out of its logs and out of the Custom row; the row keeps the resulting Claw only. The gateway and the provider control their own logging and retention, and the route line says which provider.
- **Model output** is bounded (4 KiB, one object, three levels), parsed against fixed lists, never run, never shown as words and never followed as an instruction.
- **Pictures** from an upload, and later a raster result, are decoded by the platform's image decoder only after #300's header and size limits, and redrawn by Clawtrate onto a 128 px canvas. The picture's own bytes, including any metadata and text chunks, are never sent on. The only tag in a saved picture is the one Clawtrate writes.
- **A picture never carries a Clawtrate tag from elsewhere**: the redraw drops it. A tag is only ever written from a parsed choice.
- **Confirmation** comes before every save. Undo is offered after a save from chat.
- **Admin**: saving needs `operator.admin`, as `agents.update` does; so does the Describe route. Below admin, the access bar asks first.

## 12. Keyboard, screen readers and reduced motion

- **The dialog** is modal: what's behind it is inert, Tab and Shift+Tab stay inside, Escape stops the states first, then cancels a waiting Describe, then closes. Focus returns to what opened it.
- **Initial focus**: the name field in New bot; the title in Edit picture and in the Account step.
- **Redraws**: when a panel redraws, including when the name's Claw arrives, focus returns to the same control (the same act, value, slot or part), or in a radio group to its chosen tile.
- **Tabs**: Left and Right move and choose, Home and End go to the ends, and the panel is focusable so it can be scrolled.
- **Every group** is a radio group with one tab stop: the chosen tile, or the first when none is chosen, the Custom row included. Arrows move and choose, Home and End go to the ends. Each tile's name is plain words: "Beret", "Round glasses", "None", "Sky".
- **The preview** is `role="img"` and named in words: "Blue Clawling: dome, two eyes, even claws, wearing a beret and round glasses in yellow". An idea is named "Idea: …". The round buttons are "Play the states" (pressed while playing), "Stop playing the states" and "Surprise me".
- **The name's line** is the field's description. "Match my name" is a button.
- **Announcements**: section 2's list, through one polite live region outside everything that redraws.
- **Describe**: the field is labelled. When the pressed control disappears into waiting, focus moves once to Cancel. When ideas arrive, focus moves to the first idea; on failure, to "Try again". The waiting line and Cancel are separate, and stay mounted while waiting: the slow notice and the retry line change in place, so focus on Cancel is never lost. The failure is an `alert`, and the ideas are a radio group named "<Bot>'s ideas".
- **The proposal card** is an `article` labelled by its title. Its outcome line is a `status`.
- **Reduced motion** (the system's setting or the app's): nothing moves. Each state holds its still pose, hats stay seated, there's no happy beat, no waiting look or transition while typing a name, and the waiting dot holds still. Play the states steps through still poses only when pressed. The check tests both settings.
- **Contrast**: the studio's text uses the existing text tokens. The accessories' colours are creature colours and follow `visual-language.md` §5, not the text rules.

## 13. The iPhone app

The app consumes the same spec through `react-native-svg`, so nothing here is drawn twice:

- Accessories are spec shapes placed at the builders' typed sockets, so the app reads numbers, not transform strings. The fit inset, colours and `fine` flags come from the spec, and the app drops `fine` shapes below 21 px as it already must.
- `tip` is a keyframe track like the others, on the hat's motion group. With Reduce Motion on (`AccessibilityInfo.isReduceMotionEnabled`) it holds the still pose.
- The name's Claw comes from the shared core's `avatarNameChoice` and its fold table, so a name gives the same Claw on the phone as on the desktop.
- The studio is the sheet of section 3, with the same tabs and groups, 44 pt targets, and a light haptic tap on the happy beat (none with Reduce Motion). Upload uses the photo picker and the same limits and crop. Describe uses the same plugin method through the shared client.
- The two keywords' reader and writer are the shared core's. An older app build shows a version 2 picture as a picture.
- `apps/mobile` doesn't exist in this tree yet; it belongs to its own coordinator thread. Phone parity is claimed only when the release criteria below pass on the phone.

## 14. For builders

**When.** Implementation starts after Beta 1, once Ali has signed off this design. The development-gateway probes below are part of the schedule, not extra to it.

### Order

The report has an estimate for each step.

1. **Probes** (development gateway, about half a day each): the Describe route's isolation (an empty tool surface, provider-native tools included; no workspace, memory, history or hooks; visibility to a second client; cancellation and cleanup); whether #292's plugin already has proposal records and a commit; and, separately and later, the raster result of section 8.
2. **Spec, renderer and the picture together**: the lists, sockets, shapes, fit inset and `tip` in `avatar.ts`; accessories inside the three scene builders; the two keywords' writer and reader; `avatarNameChoice`; `fine` at 18 px; accessories in `avatars.html`. PNG reading, writing and rendering ship in one change, or version 2 writing stays switched off until the renderer and the fit tests land. `pnpm brand:creatures` regenerates the prototype's copy, and `accessories.js` and `avatar-picture.js` then go.
3. **The studio** on desktop and web: it replaces `AvatarPicker`. The name's Claw and Match my name, tabs, starters, Extras, trim, Surprise and Undo, Play the states, the beat, the Custom row kept on the device, Create and Save with read-back and failures, focus and the phone sheet. `NewBot` stops sending `avatar: null`.
4. **The Describe route** in #292's plugin, after probe 1 finds it can be built.
5. **Describe a Claw** in the studio: the client for that route, the bounded reply, the retry, cancel, and a development-gateway scenario whose scripted model answers valid, prose-wrapped, invalid, slow and silent.
6. **Proposal records and the admin commit**, if #292 doesn't provide them, then **the proposal card** and `clawtrate_avatar_propose`. Raster is not in this PR.
7. **The iPhone app** (section 13).
8. **Raster pictures**, after the raster probe.

### Release criteria

- **Interoperability**: a version 1 and a version 2 picture written by the new build, read by #300's strict reader (version 1 draws, version 2 shows as a picture) and by the new build; uploads read in place.
- **iOS**: the app consumes the spec, the sockets and the name's Claw, and draws the same Claws; Reduce Motion holds still poses; VoiceOver reads the preview, the groups and the name's line.
- **Desktop**: VoiceOver (macOS) and NVDA read the same; the system and app Reduce Motion settings both hold.
- Parity rows: F-035, F-037 and F-270 are checked through the normal create, edit and upload entry points; F-269 stays open with its disabled copy; F-518 (the name's Claw), F-519 (Describe), F-520 (chat confirmation) and F-521 (interoperability) get their own checks.

### Tests that fail without each behaviour

- The spec: an accessory at each socket in each family and state; none on a hiding Shellfolk's critter; the fit inset keeps every still pose in the circle and every peak inside the ring; bow ties clear every mouth; rims never cross; a Lantern's hat clears its lure; glasses and bridges marked `fine`; every accessory colour outside the guard; the version 2 grammar accepts its form and refuses every case in section 5; version 1 bytes unchanged when nothing is worn; #300's reader shows a version 2 picture as plain; the name's Claw is stable for a name and its case, space and NFC variants.
- The studio: the name's Claw while typing, with debounce and no flicker; a manual pick stops it; Match my name; Edit never derives; Create sends exactly the Claw shown and reads it back; each tab's groups and their keys; the beat present with motion and absent without; Surprise never repeats and Undo restores the whole draft; Save disabled until something changes and while anything is pending; focus trap, return and redraw; 44 px targets on a phone.
- Describe: against the scripted model, a valid reply gives ideas and saves nothing; a prose-wrapped reply leads to one retry and then ideas; two refusals lead to the failure note; silence leads to the 45 s failure and the cancel method; nothing reaches the bot's sessions; the route line names the provider and model.
- The card: Use it commits once and reads back; Not now writes nothing; below admin it shows the access bar; expired, superseded and changed elsewhere each show their words; an accept on one device shows on another.

## 15. The prototype's states

`avatar-studio.html` takes `theme`, `width`, `motion` and `chrome`, and:

| Parameter                                                                                   | Values                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`                                                                                      | `studio` (default), `chat`, `board`                                                                                                                                                                                         |
| `mode`                                                                                      | `new` (default), `edit`                                                                                                                                                                                                     |
| `name`                                                                                      | New bot's starting name; its Claw follows it                                                                                                                                                                                |
| `tab`                                                                                       | `creature`, `colour`, `extras`, `custom`                                                                                                                                                                                    |
| `family`, `body`, `eyes`, `claws`, `shell`, `lure`, `color`, `head`, `face`, `neck`, `trim` | A starting Claw chosen by hand, for example `family=lantern&head=headphones`                                                                                                                                                |
| `state`                                                                                     | The preview's state: `idle` … `done`                                                                                                                                                                                        |
| `describe`, `words`                                                                         | `typing`, `waiting`, `slow`, `retry`, `result`, `guard`, `failed`, `unavailable`; and the description. Words with "slow" wait longer, "prose" use the retry, "fail" fail twice, "twice" repeat an idea, "red" get the note. |
| `save`                                                                                      | `fail`: Create or Save fails and keeps the draft                                                                                                                                                                            |
| `chat`                                                                                      | `proposed` (default), `saved`, `declined`, `expired`, `superseded`, `elsewhere`, `unconfirmed`, `admin`, `picture` (a raster proposal, with stand-in art, behind section 8's gate)                                          |
| `peak`                                                                                      | `1` on the board: every motion held at its peak                                                                                                                                                                             |

Describe a Claw is simulated: a small word table writes the model's reply as JSON text, which goes through the real reply boundary, and the panel says so. The raster picture in `chat=picture` is Clawtrate's own creature, drawn small and enlarged as a stand-in. No model or image provider runs anywhere in the prototype. Create and Save draw the real 128 px still, tag it, and read it back with the proposed reader; the rail shows the new bot from that read-back.
