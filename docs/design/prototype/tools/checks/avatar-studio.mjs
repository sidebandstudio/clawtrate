// Checks for avatar-studio.html (docs/design/avatar-studio.md): the Claw that
// follows the name in New bot, Create saving what is shown, the studio's tabs
// and choices, accessories on every family and how they fit their circle, what
// is dropped below 21 px, the palette guard, the saved picture through real PNG
// bytes and the pinned strict #300 reader, the version 2 grammar, the bounded
// Describe reply, focus, reduced motion, the phone width, both themes and the
// gallery's link.
// Run from the repository root:  node docs/design/prototype/tools/checks/avatar-studio.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("avatar-studio.html") + "?chrome=0";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
const open = async (query = "", viewport = { width: 1440, height: 900 }, options = {}) => {
  const context = await b.newContext({ viewport, ...options });
  await context.clock.install();
  await context.clock.pauseAt(Date.now());
  const p = await context.newPage();
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  p.on("console", (m) => {
    if (m.type() === "error" && !/fonts\.local\.css/.test(m.location().url || "")) out.push("CONSOLE " + m.text());
  });
  p.on("request", (r) => {
    if (/^https?:/.test(r.url())) out.push("NETWORK " + r.url());
  });
  p.close = () => context.close();
  await p.goto(base + (query ? "&" + query : ""));
  await p.clock.runFor(200);
  return p;
};
const parts = (p) => p.evaluate(() => [...document.querySelectorAll("#as-preview [data-part^='wear-']")].map((e) => e.dataset.part));
const shown = (p) => p.evaluate(() => window.ClawtrateAccessories.encodeChoice(window.CTStudio.S.choice));
const nameOf = (p, name) => p.evaluate((n) => window.ClawtrateAccessories.encodeChoice(window.ClawtrateAccessories.nameChoice(n)), name);

// New bot: the Claw follows the name ------------------------------------------------------
let p = await open("theme=dark");
check("AS-01 New bot opens with focus in the name field, and Next", await p.evaluate(() => document.activeElement.id === "as-name" && document.querySelector('[data-act="next"]')?.textContent === "Next"));
check("AS-01 with no name, the starter Clawling", (await shown(p)) === "v=1&family=clawling&body=dome&eyes=pair&claws=even&color=blue");
const names = ["Yuno", "Atlas", "Pip", "Marlowe", "Sol", "Ödön"];
const first = [];
for (const n of names) first.push(await nameOf(p, n));
check("AS-19 names give different Claws", new Set(first).size >= 5, first.join(" | "));
const variants = await p.evaluate(() => {
  const A = window.ClawtrateAccessories;
  const e = (n) => A.encodeChoice(A.nameChoice(n));
  return [e("Yuno") === e("  yuno "), e("Yuno") === e("YUNO"), e("Ödön") === e("Ödön"), e("") === e("   "), e("Yuno") !== e("Yuna")];
});
check("AS-19 the name is trimmed, case-folded and NFC first", variants.every(Boolean), JSON.stringify(variants));
const folded = await p.evaluate(() => {
  const A = window.ClawtrateAccessories;
  return {
    dotless: A.nameKey("I") !== A.nameKey("ı"),
    dotted: A.nameKey("İ") === "i\u0307",
    sharp: A.nameKey("Straße") === A.nameKey("STRASSE"),
    ligature: A.nameKey("ﬁn") === A.nameKey("FIN"),
    sigma: A.nameKey("ΣΟΦΟΣ") === A.nameKey("σοφος"),
    cherokee: A.nameKey("ꭰ") === A.nameKey("Ꭰ"),
  };
});
check("AS-19 the fold is Unicode's full default case fold: I and ı stay apart; ß, ﬁ, final sigma and Cherokee fold", Object.values(folded).every(Boolean), JSON.stringify(folded));
const salt = await p.evaluate(() => {
  const C = window.ClawtrateCreatures;
  const A = window.ClawtrateAccessories;
  // The id's default hashes `<id>:<field>`; the name's hash inputs are distinct. A match by chance is possible.
  let same = 0;
  for (const n of ["atlas", "juniper", "wren", "otto", "pip", "sol", "yuno", "marlowe"]) {
    const d = C.defaultAvatar(n);
    const c = A.nameChoice(n);
    if (c.family === "clawling" && c.body === d.body && c.eyes === d.eyes && c.claws === d.claws && c.color === d.color) same += 1;
  }
  return same;
});
check("AS-19 the name's Claw is salted apart from the id's default", salt <= 1, `${salt} of 8 match`);
const families = await p.evaluate(() => {
  const A = window.ClawtrateAccessories;
  const seen = new Set();
  let worn = 0;
  for (let i = 0; i < 300; i++) {
    const c = A.nameChoice(`bot ${i}`);
    seen.add(c.family);
    if (A.wears(c)) worn += 1;
  }
  return { families: seen.size, worn };
});
check("AS-19 a name may give any family, and about half wear one thing", families.families === 3 && families.worn > 100 && families.worn < 200, JSON.stringify(families));
// Typing: a look at the name, no flicker, then the name's Claw.
await p.click("#as-name");
await p.keyboard.type("Pi", { delay: 60 });
await p.clock.runFor(120);
check("AS-20 while typing, the Claw looks up at the name (waiting) and hasn't changed yet", (await p.evaluate(() => document.querySelector("#as-preview").dataset.state)) === "waiting" && (await shown(p)) === "v=1&family=clawling&body=dome&eyes=pair&claws=even&color=blue");
await p.keyboard.type("p");
await p.clock.runFor(300);
check("AS-20 after a 250 ms pause it becomes the name's Claw, with a transition", (await shown(p)) === (await nameOf(p, "Pip")) && (await p.evaluate(() => !!document.querySelector("#as-preview svg[data-swap]"))));
await p.clock.runFor(900);
check("AS-20 then it settles at rest, and says the Claw comes from the name", await p.evaluate(() => document.querySelector("#as-preview").dataset.state === "idle" && !document.querySelector("#as-preview [data-swap]") && !!document.querySelector('[data-testid="follows-name"]')));
// A manual pick wins; Match my name hands it back.
await p.click("#as-tab-colour");
await p.click('[data-act="color"][data-value="violet"]');
await p.click("#as-name");
await p.keyboard.press("End");
await p.keyboard.type("pa");
await p.clock.runFor(1200);
const manual = await shown(p);
check("AS-21 a manual pick stops the name changing the Claw", /color=violet/.test(manual) && manual !== (await nameOf(p, "Pippa")), manual);
check("AS-21 and offers Match my name", await p.isVisible('[data-act="match-name"]'));
await p.click('[data-act="match-name"]');
check("AS-21 Match my name gives the name's Claw back, and follows typing again", (await shown(p)) === (await nameOf(p, "Pippa")) && (await p.evaluate(() => window.CTStudio.S.source === "name")));
await p.click('[data-act="surprise"]');
check("AS-21 Surprise me takes it off the name", await p.evaluate(() => window.CTStudio.S.source === "manual"));
await p.click('[data-act="undo"]');
check("AS-21 Undo surprise puts back the whole draft, following the name included", (await shown(p)) === (await nameOf(p, "Pippa")) && (await p.evaluate(() => window.CTStudio.S.source === "name")));
// Races: a pick or Surprise inside the 250 ms window wins, and the late name timer does nothing.
await p.click("#as-name");
await p.keyboard.press("End");
await p.keyboard.type("x");
await p.clock.runFor(100);
await p.click("#as-tab-colour");
await p.click('[data-act="color"][data-value="lime"]');
await p.clock.runFor(1500);
const raced = await p.evaluate(() => ({ text: window.ClawtrateAccessories.encodeChoice(window.CTStudio.S.choice), source: window.CTStudio.S.source }));
check("AS-21 a pick made within 250 ms of typing stays: the pending name doesn't overwrite it", /color=lime/.test(raced.text) && raced.source === "manual" && raced.text !== (await nameOf(p, "Pippax")), JSON.stringify(raced));
await p.click('[data-act="match-name"]');
await p.click("#as-name");
await p.keyboard.type("y");
await p.clock.runFor(100);
await p.click('[data-act="surprise"]');
const surprised = await shown(p);
await p.clock.runFor(1500);
check("AS-21 Surprise within 250 ms stays too", (await shown(p)) === surprised && surprised !== (await nameOf(p, "Pippaxy")));
await p.click('[data-act="undo"]');
await p.click("#as-tab-creature");
await p.click("#as-name");
await p.keyboard.type("z");
await p.focus('[data-group="as-starters"] [role="radio"]');
await p.evaluate(() => (document.activeElement.__mark = true));
await p.clock.runFor(1200);
check("AS-24 the name's redraw keeps focus on the control it was on", await p.evaluate(() => document.activeElement.dataset.act === "starter" && document.activeElement.dataset.value === "0"));
await p.close();
p = await open("theme=dark");
await p.click("#as-name");
await p.keyboard.type("Atlas");
await p.clock.runFor(60);
await p.click('[data-act="next"]');
check("AS-22 Next within 250 ms of typing resolves the pending name first", (await shown(p)) === (await nameOf(p, "Atlas")) && (await p.evaluate(() => window.CTStudio.S.draft.shown === window.ClawtrateAccessories.encodeChoice(window.ClawtrateAccessories.nameChoice("Atlas")))));
check("AS-22 Account shows the name as text: no field to reach by pointer or keyboard", await p.evaluate(() => {
  const field = document.querySelector("#as-name");
  return document.querySelector('[data-testid="account-name"]').textContent === "Atlas" && field.offsetParent === null && field.closest("[hidden]") !== null;
}));
const reachable = [];
for (let i = 0; i < 30; i++) {
  await p.keyboard.press("Tab");
  reachable.push(await p.evaluate(() => document.activeElement.tagName + "#" + document.activeElement.id));
}
check("AS-22 Tab on Account never reaches the name field", !reachable.some((r) => /^INPUT#as-name$/.test(r)), [...new Set(reachable)].join(" "));
// An edit forced into the hidden field right before Create, and Create pressed within 250 ms.
await p.evaluate(() => {
  const field = document.querySelector("#as-name");
  field.value = "a";
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
await p.click('[data-act="create"]');
const during = await p.evaluate(() => document.querySelector("#as-preview").getAttribute("aria-label"));
for (let i = 0; i < 10 && !(await p.$('[data-testid="done"]')); i++) await p.clock.runFor(200);
const snap = await p.evaluate(() => {
  const d = window.CTStudio.S.done;
  const A = window.ClawtrateAccessories;
  return { name: d.name, shown: d.shown, back: A.encodeChoice(d.read.choice), atlas: A.encodeChoice(A.nameChoice("Atlas")), atlasWords: window.CTStudio.describe(A.nameChoice("Atlas")) };
});
check("AS-22 an edit on Account right before Create changes nothing: one snapshot is drawn, written and confirmed", snap.name === "Atlas" && snap.shown === snap.atlas && snap.back === snap.atlas && during === snap.atlasWords, JSON.stringify(snap));
await p.close();
p = await open("theme=dark");
await p.click("#as-name");
await p.keyboard.type("Pippa");
await p.clock.runFor(1200);

// Next, Account, Create: what is shown is what is saved.
const before = await shown(p);
await p.click('[data-act="next"]');
check("AS-22 Next goes to Account with the Claw kept in view", await p.evaluate(() => document.querySelector("#as-title").textContent === "Account" && document.activeElement.id === "as-title"));
await p.click('[data-act="create"]');
for (let i = 0; i < 10 && !(await p.$('[data-testid="done"]')); i++) await p.clock.runFor(200);
const created = await p.evaluate(() => {
  const d = window.CTStudio.S.done;
  return d && { shown: d.shown, kind: d.read.kind, back: d.read.kind === "creature" ? window.ClawtrateAccessories.encodeChoice(d.read.choice) : null, tags: d.tags, len: d.url.length, row: !!document.querySelector('[data-testid="created-row"]') };
});
check("AS-22 Create saves exactly the Claw shown, read back from the saved PNG", created && created.shown === before && created.back === before && created.row, JSON.stringify(created && { shown: created.shown, back: created.back }));
check("AS-22 the saved PNG carries one tag and stays under 32,768 characters", created && created.tags.length === 1 && created.len <= 32768, JSON.stringify(created?.tags));
check("AS-22 after Create, focus is on the way back in", await p.evaluate(() => document.activeElement.id === "as-opener"));
await p.close();

p = await open("theme=dark");
await p.click('[data-act="next"]');
check("AS-22 Next with no name asks for one and keeps focus in the field", await p.evaluate(() => /name first/.test(document.querySelector("#as-name-note").textContent) && document.activeElement.id === "as-name" && !!document.querySelector('[data-act="next"]')));
await p.close();

p = await open("theme=dark&motion=reduce");
await p.click("#as-name");
await p.keyboard.type("Marlowe");
await p.clock.runFor(30);
check("AS-23 with motion reduced, typing holds the still pose", (await p.evaluate(() => document.querySelector("#as-preview").dataset.state)) === "idle");
await p.clock.runFor(300);
check("AS-23 and the name's Claw arrives at once, without a transition or animation", (await shown(p)) === (await nameOf(p, "Marlowe")) && (await p.evaluate(() => !document.querySelector("#as-preview [data-swap]") && !document.querySelector(".as-swap-out") && document.getAnimations().length === 0)));
await p.close();

p = await open("theme=dark&mode=edit&name=Pip");
check("AS-23 Edit picture never takes a Claw from the bot's name, and opens on its title", await p.evaluate(() => window.CTStudio.S.source === "manual" && window.CTStudio.S.choice.family === "clawling" && window.CTStudio.S.choice.color === "green" && document.activeElement.id === "as-title"));
await p.close();

// The studio's choices --------------------------------------------------------------------
p = await open("theme=dark");
check("AS-02 four tabs, Creature chosen", (await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent + ":" + t.getAttribute("aria-selected")).join(" "))) === "Creature:true Colour:false Extras:false Custom:false");
await p.focus("#as-tab-creature");
await p.keyboard.press("ArrowRight");
check("AS-02 Right moves to Colour and focuses it", await p.evaluate(() => document.activeElement.id === "as-tab-colour" && document.querySelector("#as-tab-colour").getAttribute("aria-selected") === "true"));
check("AS-02 with nothing worn, the accessory colour waits", await p.evaluate(() => !!document.querySelector('[data-testid="trim-hint"]') && !document.querySelector('[data-group="as-trim"]')));
await p.click("#as-tab-extras");
await p.click('[data-act="wear"][data-slot="head"][data-value="beret"]');
await p.click('[data-act="wear"][data-slot="face"][data-value="glasses"]');
await p.clock.runFor(1500);
const worn = await parts(p);
check("AS-03 chosen accessories are drawn in the preview", worn.includes("wear-beret") && worn.filter((w) => w === "wear-glasses").length === 2 && worn.includes("wear-bridge"), worn.join(" "));
check("AS-03 and the preview's name says it", /wearing a beret and round glasses/.test(await p.getAttribute("#as-preview", "aria-label")));
check("AS-03 focus stays on the tile chosen after the panel redraws", await p.evaluate(() => document.activeElement.dataset.value === "glasses"));
await p.click('[data-act="wear"][data-slot="head"][data-value="none"]');
check("AS-03 None takes it off", !(await parts(p)).includes("wear-beret"));
await p.click('[data-act="wear"][data-slot="face"][data-value="none"]');
await p.click('[data-act="wear"][data-slot="head"][data-value="crown"]');
await p.click("#as-tab-colour");
check("AS-03 a crown alone offers no accessory colour, and says it is gold", await p.evaluate(() => !document.querySelector('[data-group="as-trim"]') && !!document.querySelector('[data-testid="crown-hint"]') && /wearing a gold crown$/.test(document.querySelector("#as-preview").getAttribute("aria-label"))));
await p.click("#as-tab-extras");
await p.click('[data-act="wear"][data-slot="face"][data-value="glasses"]');
await p.click("#as-tab-colour");
check("AS-03 with something else worn, the accessory colour is offered", await p.evaluate(() => !!document.querySelector('[data-group="as-trim"]')));
await p.click("#as-tab-creature");
await p.focus('[data-group="as-family"] [aria-checked="true"]');
await p.keyboard.press("ArrowRight");
check("AS-04 arrows choose in a radio group and keep focus there", await p.evaluate(() => window.CTStudio.S.choice.family === "shellfolk" && document.activeElement.dataset.value === "shellfolk"));
check("AS-04 a family change keeps what is worn", await p.evaluate(() => window.CTStudio.S.choice.face === "glasses"));
check("AS-05 a choice plays the done beat", await p.evaluate(() => document.querySelector("#as-preview").dataset.state === "done"));
check("AS-05 tiles hold still; only the preview moves", await p.evaluate(() => document.querySelector("#as-panel").getAnimations({ subtree: true }).length === 0 && document.querySelector("#as-preview").getAnimations({ subtree: true }).length > 0));
await p.clock.runFor(1500);
check("AS-05 and returns to idle", await p.evaluate(() => document.querySelector("#as-preview").dataset.state === "idle"));
const pre = await shown(p);
await p.click('[data-act="surprise"]');
const post = await shown(p);
check("AS-06 Surprise me changes the Claw", pre !== post, post);
await p.click('[data-act="undo"]');
check("AS-06 Undo surprise brings it back", (await shown(p)) === pre);
await p.click('[data-act="play"]');
const seen = new Set();
for (let i = 0; i < 6; i++) {
  seen.add(await p.evaluate(() => document.querySelector("#as-preview").dataset.state));
  await p.clock.runFor(1600);
}
check("AS-07 Play the states shows all six", seen.size === 6, [...seen].join(" "));
// Focus: the trap, Escape, and the way back.
await p.focus("#as-name");
const ring = [];
for (let i = 0; i < 60; i++) {
  await p.keyboard.press("Tab");
  ring.push(await p.evaluate(() => !!document.activeElement.closest(".as-dialog")));
}
check("AS-24 Tab stays inside the dialog", ring.every(Boolean));
await p.keyboard.press("Shift+Tab");
check("AS-24 Shift+Tab too", await p.evaluate(() => !!document.activeElement.closest(".as-dialog")));
await p.keyboard.press("Escape");
check("AS-24 Escape closes, keeps the draft, and puts focus on what opens it", await p.evaluate(() => !document.querySelector(".as-dialog") && document.activeElement.id === "as-opener"));
const kept = await shown(p);
await p.click("#as-opener");
check("AS-24 opening again starts in the name field with the draft kept", (await p.evaluate(() => document.activeElement.id === "as-name")) && (await shown(p)) === kept);
await p.close();

// Accessories on every family: fit, sizes, guard -------------------------------------------
p = await open("theme=dark&view=board");
const fit = await p.evaluate(() =>
  [...document.querySelectorAll("[data-board=dark] td[data-fit]")].map((td) => ({ want: td.dataset.fit, has: !!td.querySelector(`[data-part="wear-${td.dataset.fit}"]`) })),
);
check("AS-08 every accessory is drawn on every family's parts", fit.length === 8 * 14 && fit.every((f) => f.has), `${fit.filter((f) => f.has).length}/${fit.length}`);
check("AS-08 the board uses the app's Presence ring and badge at 18, 22, 32, 56, 120 and 152 px", await p.evaluate(() => [18, 22, 32, 56, 120, 152].every((s) => document.querySelector(`td[data-size="${s}"] .presence`)) && !!document.querySelector('td[data-state="waiting"] .presence > .glyph') && getComputedStyle(document.querySelector('td[data-state="working"] .presence'), "::before").opacity === "1"));
check("AS-08 the board's Presence has no legacy whole-SVG motion: only the creature's own", await p.evaluate(() => [...document.querySelectorAll("[data-board] .presence > .avatar svg")].every((svg) => getComputedStyle(svg).animationName === "none" && getComputedStyle(svg).transform === "none")));
const fine = await p.evaluate(() => {
  const by = {};
  for (const td of document.querySelectorAll("[data-board] td[data-size][data-state]")) {
    const s = td.dataset.size;
    by[s] ??= { shown: 0, all: 0, glasses: 0 };
    for (const f of td.querySelectorAll(".av-fine")) {
      by[s].all += 1;
      if (getComputedStyle(f).display !== "none") by[s].shown += 1;
    }
    for (const g of td.querySelectorAll('[data-part="wear-glasses"]')) if (getComputedStyle(g).display !== "none") by[s].glasses += 1;
  }
  return by;
});
check("AS-09 at 18 px fine detail is dropped, glasses with it", fine["18"].shown === 0 && fine["18"].glasses === 0, JSON.stringify(fine["18"]));
check("AS-09 from 22 px everything is drawn", ["22", "32", "56", "120", "152"].every((s) => fine[s].shown === fine[s].all && fine[s].glasses > 0));
const silhouettes = await p.evaluate(() => [...document.querySelectorAll('td[data-size="18"] [data-part^="wear-"]')].filter((e) => getComputedStyle(e).display !== "none").map((e) => e.dataset.part));
check("AS-09 at 18 px hats, shades, headphones and bow ties stay", ["wear-beret", "wear-party", "wear-beanie", "wear-headphones", "wear-crown", "wear-shades", "wear-bowtie"].every((w) => silhouettes.includes(w)));
const colours = await p.evaluate(() => [...new Set([...document.querySelectorAll("svg.creature [fill], svg.creature [stroke]")].flatMap((e) => [e.getAttribute("fill"), e.getAttribute("stroke")]).filter((c) => c && c.startsWith("#")))]);
const guarded = await p.evaluate((list) => list.filter((c) => window.ClawtrateCreatures.isGuardedColor(c)), colours);
check("AS-10 no accessory is drawn in a guarded colour", guarded.length === 0, guarded.join(" "));
const trims = await p.evaluate(() => {
  const C = window.ClawtrateCreatures;
  const A = window.ClawtrateAccessories;
  return C.AVATAR_COLOR_NAMES.flatMap((t) => [0, 0.18, 0.2, 0.22, 0.28, 0.3, 0.38].map((k) => (k ? C.shade(C.AVATAR_COLORS[t], k) : C.AVATAR_COLORS[t])))
    .concat([A.AVATAR_GOLD, C.shade(A.AVATAR_GOLD, 0.3)])
    .filter((c) => C.isGuardedColor(c));
});
check("AS-10 every trim, every shade used and the gold pass the guard", trims.length === 0, trims.join(" "));
const sweep = await p.evaluate(() => {
  const C = window.ClawtrateCreatures;
  const A = window.ClawtrateAccessories;
  let bases = [];
  for (const f of C.AVATAR_FAMILIES) {
    let combos = [{ family: f, color: "blue" }];
    for (const [k, vs] of Object.entries(C.AVATAR_PARTS[f])) combos = combos.flatMap((c) => vs.map((v) => ({ ...c, [k]: v })));
    bases = bases.concat(combos);
  }
  let n = 0;
  const bad = [];
  for (const base of bases)
    for (const head of [null, ...A.AVATAR_HEADWEAR])
      for (const face of [null, ...A.AVATAR_FACEWEAR])
        for (const neck of [null, "bowtie"])
          for (const state of C.AVATAR_STATES) {
            const choice = A.tidy({ ...base, ...(head ? { head } : {}), ...(face ? { face } : {}), ...(neck ? { neck } : {}) });
            try {
              const text = JSON.stringify(A.accessorize(C.avatarScene(choice, state, C.avatarVariation("x")), choice));
              if (/NaN|undefined|null/.test(text)) bad.push(A.encodeChoice(choice) + " " + state);
            } catch (e) {
              bad.push(A.encodeChoice(choice) + " " + state + " " + e.message);
            }
            n += 1;
          }
  return { n, bad: bad.slice(0, 3) };
});
check("AS-25 every part, slot combination and state builds without errors or NaN", sweep.n === 18144 && sweep.bad.length === 0, `${sweep.n} scenes ${sweep.bad.join(" | ")}`);
await p.close();

// The fit, measured on the drawn geometry: still poses inside the crop circle,
// motion peaks inside the Presence ring, bow ties clear of every mouth, glasses
// rims apart, Lantern hats clear of the lure ball.
p = await open("theme=dark&view=chat");
const geometry = await p.evaluate(() => {
  const C = window.ClawtrateCreatures;
  const A = window.ClawtrateAccessories;
  let bases = [];
  for (const f of C.AVATAR_FAMILIES) {
    let combos = [{ family: f, color: "blue" }];
    for (const [k, vs] of Object.entries(C.AVATAR_PARTS[f])) combos = combos.flatMap((c) => vs.map((v) => ({ ...c, [k]: v })));
    bases = bases.concat(combos);
  }
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:0;top:0";
  document.body.append(host);
  const WEAR = '[data-part^="wear-"] path,[data-part^="wear-"] circle,[data-part^="wear-"] rect';
  const xf = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  const points = (svg) => {
    const pts = [];
    for (const leaf of svg.querySelectorAll(WEAR)) {
      const m = leaf.getCTM();
      const s = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
      const stroke = leaf.getAttribute("stroke");
      const sw = stroke && stroke !== "none" ? (parseFloat(leaf.getAttribute("stroke-width") || 0) * s) / 2 : 0;
      let raw = [];
      if (leaf.tagName === "path") {
        const L = leaf.getTotalLength();
        for (let i = 0; i <= 32; i++) {
          const q = leaf.getPointAtLength((L * i) / 32);
          raw.push([q.x, q.y]);
        }
      } else if (leaf.tagName === "circle") {
        const [cx, cy, r] = ["cx", "cy", "r"].map((a) => +leaf.getAttribute(a));
        for (let i = 0; i < 16; i++) raw.push([cx + r * Math.cos((i * Math.PI) / 8), cy + r * Math.sin((i * Math.PI) / 8)]);
      } else {
        const [x, y, w, h] = ["x", "y", "width", "height"].map((a) => +leaf.getAttribute(a));
        raw = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
      }
      for (const [x, y] of raw) pts.push({ p: xf(m, x, y), sw });
    }
    return pts;
  };
  const far = (pts) => pts.reduce((m, { p, sw }) => Math.max(m, Math.hypot(p[0] - 20, p[1] - 20) + sw), 0);
  const draw = (choice, state, peak) => {
    host.innerHTML = window.CTStudio.creature(choice, state, "fit");
    const svg = host.firstElementChild;
    svg.style.cssText = "width:40px;height:40px";
    if (peak) window.CTStudio.holdPeaks(svg);
    else for (const a of svg.getAnimations({ subtree: true })) a.cancel();
    return svg;
  };
  const bad = { still: [], live: [], mouth: [], rims: [], lure: [] };
  let worstStill = 0;
  let worstLive = 0;
  for (const base of bases)
    for (const head of A.AVATAR_HEADWEAR)
      for (const state of C.AVATAR_STATES) {
        const choice = A.tidy({ ...base, head });
        let svg = draw(choice, state, false);
        const still = far(points(svg));
        worstStill = Math.max(worstStill, still);
        if (still > 20) bad.still.push(`${A.encodeChoice(choice)} ${state} ${still.toFixed(2)}`);
        const ball = svg.querySelector('[data-part="ball"]');
        if (choice.family === "lantern" && ball) {
          const m = ball.getCTM();
          const [cx, cy] = xf(m, +ball.getAttribute("cx"), +ball.getAttribute("cy"));
          const r = +ball.getAttribute("r") * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
          const near = points(svg).reduce((mm, { p, sw }) => Math.min(mm, Math.hypot(p[0] - cx, p[1] - cy) - sw), 99);
          if (near < r) bad.lure.push(`${A.encodeChoice(choice)} ${state}`);
        }
        svg = draw(choice, state, true);
        const live = far(points(svg));
        worstLive = Math.max(worstLive, live);
        // 32 px: 16 px of avatar, the ring from 18.5 px. 23.1 units is the ring's inner edge.
        if (live > 23.1) bad.live.push(`${A.encodeChoice(choice)} ${state} ${live.toFixed(2)}`);
      }
  for (const base of bases.filter((x) => x.family !== "shellfolk"))
    for (const state of C.AVATAR_STATES) {
      const svg = draw(A.tidy({ ...base, neck: "bowtie" }), state, false);
      const tie = svg.querySelector('[data-part="wear-bowtie"]').getBoundingClientRect();
      const mouthEl = svg.querySelector('[data-part="mouth"]');
      const mouth = mouthEl.getBoundingClientRect();
      const ink = mouthEl.getAttribute("stroke") ? 0.65 : 0;
      if (mouth.bottom + ink > tie.top && mouth.right > tie.left && mouth.left < tie.right) bad.mouth.push(`${JSON.stringify(base)} ${state}`);
    }
  for (const base of bases)
    for (const state of C.AVATAR_STATES) {
      const svg = draw(A.tidy({ ...base, face: "glasses" }), state, false);
      const rims = [...svg.querySelectorAll('[data-part="wear-glasses"] circle')].map((c) => {
        const m = c.getCTM();
        const s = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
        return { x: m.e, y: m.f, r: (+c.getAttribute("r") + 0.525) * s };
      });
      if (rims.length === 2 && Math.hypot(rims[0].x - rims[1].x, rims[0].y - rims[1].y) < rims[0].r + rims[1].r) bad.rims.push(`${JSON.stringify(base)} ${state}`);
    }
  return { bad, worstStill: +worstStill.toFixed(2), worstLive: +worstLive.toFixed(2), n: bases.length };
});
const g = geometry.bad;
const fitTable = await p.evaluate(() => {
  const fresh = window.ClawtrateFit.generate();
  const shipped = window.ClawtrateAccessories.fitTable();
  const keys = new Set([...Object.keys(fresh), ...Object.keys(shipped)]);
  return { n: Object.keys(fresh).length, differ: [...keys].filter((k) => fresh[k] !== shipped[k]).slice(0, 3), ring: window.ClawtrateFit.ringLimit() };
});
check("AS-26 the inset table is generated from the whole drawn outline (body, claws, lure, accessories) and is current", fitTable.differ.length === 0 && fitTable.n > 0, `${fitTable.n} insets; ring ${fitTable.ring.toFixed(2)} units ${fitTable.differ.join(" | ")}`);
const verified = await p.evaluate(() => window.ClawtrateFit.verify({ onlyInset: true }));
check("AS-26 drawn with their insets, every inset outfit keeps accessories in the crop circle, inside the app's real Presence ring at working peaks, and no wider than the bare art", verified.n > 0 && verified.bad.length === 0, `${verified.n} outfits ${verified.bad.slice(0, 2).join(" | ")}`);
const masks = await p.evaluate(async () => {
  const A = window.ClawtrateAccessories;
  const outside = (url) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = 128;
        const g2 = c.getContext("2d");
        g2.drawImage(img, 0, 0);
        const d = g2.getImageData(0, 0, 128, 128).data;
        let n = 0;
        for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) if (d[(y * 128 + x) * 4 + 3] > 24 && Math.hypot(x + 0.5 - 64, y + 0.5 - 64) > 64.5) n += 1;
        resolve(n);
      };
      img.src = url;
    });
  const bad = [];
  let n = 0;
  let bareSpill = 0;
  for (const base of window.ClawtrateFit.bases()) {
    const bare = await outside(await window.CTStudio.savedPicture(base));
    if (bare) bareSpill += 1;
    for (const head of [null, ...A.AVATAR_HEADWEAR])
      for (const face of [null, ...A.AVATAR_FACEWEAR]) {
        const choice = A.tidy({ ...base, ...(head ? { head } : {}), ...(face ? { face } : {}), neck: "bowtie", trim: "yellow" });
        const count = await outside(await window.CTStudio.savedPicture(choice));
        n += 1;
        if (count > bare) bad.push(`${A.encodeChoice(choice)} ${bare}→${count}`);
      }
  }
  return { n, bad, bareSpill };
});
check("AS-26 the saved still's circular mask: no outfit has more pixels outside it than its bare creature", masks.bad.length === 0, `${masks.n} outfits; ${masks.bareSpill} of 84 bare creatures spill already (#293's art, fixed in #300) ${masks.bad.slice(0, 2).join(" | ")}`);
const adapter = await p.evaluate(() => {
  const C = window.ClawtrateCreatures;
  const A = window.ClawtrateAccessories;
  const F = window.ClawtrateFit;
  const off = [];
  for (const base of F.bases())
    for (const state of C.AVATAR_STATES) {
      const svg = F.draw(base, state, false);
      // In the frame the eyes share, where their accessories are drawn: the root's slump and a Shellfolk's peek move that frame, not the eyes in it.
      const drawn = [...svg.querySelectorAll('[data-part="eye"]')]
        .map((g) => {
          const m = g.parentNode.getCTM().inverse().multiply(g.getCTM());
          return [m.e, m.f];
        })
        .sort((a, b) => a[0] - b[0]);
      const sockets = A.sceneSockets(base, C.avatarScene(base, state, C.avatarVariation("fit"))).eyes;
      if (drawn.length !== sockets.length || sockets.some((e, i) => Math.hypot(e.x - drawn[i][0], e.y - drawn[i][1]) > 0.01)) off.push(`${A.encodeChoice(base)} ${state}`);
    }
  return off;
});
check("AS-30 the prototype's eye sockets match where the builders drew each eye in the eyes' own frame, in every state", adapter.length === 0, adapter.slice(0, 2).join(" | "));
check("AS-26 the bow tie clears the mouth in every state, the open waiting mouth and the blocked frown included", g.mouth.length === 0, g.mouth.slice(0, 2).join(" | "));
check("AS-26 glasses rims never cross, the blocked Shellfolk's narrow peek included", g.rims.length === 0, g.rims.slice(0, 2).join(" | "));
check("AS-26 a Lantern's hat stays clear of its lure ball, drooped in blocked included", g.lure.length === 0, g.lure.slice(0, 2).join(" | "));

// The saved picture, through real PNG bytes ------------------------------------------------
const png = await p.evaluate(async () => {
  const C = window.ClawtrateCreatures;
  const A = window.ClawtrateAccessories;
  const P = window.ClawtratePicture;
  const S = window.CTStudio;
  const bad = [];
  let n = 0;
  let longest = 0;
  let outside = 0;
  const pixelsOutside = (url) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = 128;
        const g2 = c.getContext("2d");
        g2.drawImage(img, 0, 0);
        const d = g2.getImageData(0, 0, 128, 128).data;
        let count = 0;
        for (let y = 0; y < 128; y++)
          for (let x = 0; x < 128; x++) if (d[(y * 128 + x) * 4 + 3] > 24 && Math.hypot(x + 0.5 - 64, y + 0.5 - 64) > 64.5) count += 1;
        resolve({ count, width: img.naturalWidth });
      };
      img.onerror = () => resolve({ count: -1, width: 0 });
      img.src = url;
    });
  for (const family of C.AVATAR_FAMILIES)
    for (const [slot, list] of Object.entries(A.AVATAR_ACCESSORIES))
      for (const wear of ["none", ...list]) {
        const choice = A.tidy({ ...C.firstChoice(family, "pink"), ...(wear !== "none" ? { [slot]: wear, trim: "sky" } : {}) });
        // The bare creature's own spill past the circle is #293's; an accessory may add none.
        const bare = await pixelsOutside(await S.savedPicture(A.tidy(C.firstChoice(family, "pink"))));
        const url = await S.savedPicture(choice);
        n += 1;
        longest = Math.max(longest, url.length);
        const now = P.readPicture(url);
        const old = P.readPictureV1(url);
        const tags = P.tags(url);
        const loaded = await pixelsOutside(url);
        outside += Math.max(loaded.count - bare.count, 0);
        if (loaded.width !== 128) bad.push(`not decoded ${A.encodeChoice(choice)}`);
        if (now.kind !== "creature" || A.encodeChoice(now.choice) !== A.encodeChoice(choice)) bad.push(`round trip ${A.encodeChoice(choice)}`);
        if (tags.length !== 1) bad.push(`tags ${tags.length}`);
        if (wear === "none") {
          if (tags[0][0] !== P.KEYWORD_V1 || tags[0][1] !== C.encodeAvatarChoice(choice)) bad.push(`v1 bytes ${tags[0]}`);
          if (old.kind !== "creature") bad.push(`old reader ${old.kind} for v1`);
        } else {
          if (tags[0][0] !== P.KEYWORD_V2) bad.push(`keyword ${tags[0][0]}`);
          if (old.kind !== "plain") bad.push(`old reader ${old.kind} for v2`);
        }
      }
  return { n, longest, outside, bad: bad.slice(0, 4) };
});
check("AS-11 every family with every accessory round-trips through a real PNG, decoded by the browser", png.bad.length === 0, `${png.n} pictures ${png.bad.join(" | ")}`);
check("AS-11 nothing worn: the old keyword and unchanged v1 bytes, read by the pinned #300 reader", !png.bad.some((x) => /v1 bytes|for v1/.test(x)));
check("AS-11 something worn: clawtrate-avatar-v2, which the pinned strict #300 reader shows as a plain picture", !png.bad.some((x) => /keyword|for v2/.test(x)));
check("AS-11 every saved still fits the 32,768-character limit, and no accessory adds a pixel outside its circular crop", png.longest <= 32768 && png.outside === 0, `longest ${png.longest}, ${png.outside} pixels added outside the circle`);
const tagged = await p.evaluate(async () => {
  const A = window.ClawtrateAccessories;
  const P = window.ClawtratePicture;
  const choice = A.tidy({ family: "lantern", body: "round", lure: "hook", eyes: "two", color: "sky", head: "beret", face: "glasses", trim: "yellow" });
  const url = await window.CTStudio.savedPicture(choice);
  const text = A.encodeChoice(choice);
  const plain = P.withChunks(url, []).replace(/./, (c) => c); // same bytes
  const stripped = await new Promise((resolve) => {
    // An ordinary upload: redrawn through a canvas, so every text chunk is gone.
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      c.getContext("2d").drawImage(img, 0, 0);
      resolve(c.toDataURL("image/png"));
    };
    img.src = url;
  });
  const bytes = atob(url.slice(22));
  const corrupt = "data:image/png;base64," + btoa(bytes.slice(0, 40) + String.fromCharCode(bytes.charCodeAt(40) ^ 1) + bytes.slice(41));
  const trailing = "data:image/png;base64," + btoa(bytes + "\0\0\0\0");
  const both = P.withChunks(stripped, [[P.KEYWORD_V1, "v=1&family=lantern&body=round&lure=hook&eyes=two&color=sky"], [P.KEYWORD_V2, text]]);
  const twice = P.withChunks(stripped, [[P.KEYWORD_V2, text], [P.KEYWORD_V2, text]]);
  const v2UnderOld = P.withChunks(stripped, [[P.KEYWORD_V1, text]]);
  const withMeta = P.withChunks(stripped, [["Comment", "made somewhere else"], ["Software", "an editor"]]);
  const rewritten = P.pictureWithChoice(withMeta, choice);
  return {
    stripped: P.readPicture(stripped).kind,
    corrupt: P.readPicture(corrupt).kind,
    trailing: P.readPicture(trailing).kind,
    both: P.readPicture(both).kind,
    twice: P.readPicture(twice).kind,
    v2UnderOldNew: P.readPicture(v2UnderOld).kind,
    v2UnderOldOld: P.readPictureV1(v2UnderOld).kind,
    rewritten: P.readPicture(rewritten).kind === "creature" && P.tags(rewritten).filter(([k]) => k.startsWith("clawtrate")).length === 1 && P.tags(rewritten)[0][0] === P.KEYWORD_V2,
    metaKept: P.tags(rewritten).length === 3,
    plain: P.readPicture(plain).kind,
  };
});
check("AS-27 an upload redrawn through a canvas carries no tag and reads as a plain picture", tagged.stripped === "plain");
check("AS-27 a bad CRC or bytes after IEND is invalid", tagged.corrupt === "invalid" && tagged.trailing === "invalid", JSON.stringify([tagged.corrupt, tagged.trailing]));
check("AS-27 both keywords together, or the v2 tag twice, is invalid", tagged.both === "invalid" && tagged.twice === "invalid");
check("AS-27 v2 text under the old keyword is invalid to both readers (why v2 has its own keyword)", tagged.v2UnderOldNew === "invalid" && tagged.v2UnderOldOld === "invalid");
check("AS-27 writing after other metadata keeps it and leaves one tag, just after IHDR", tagged.rewritten && tagged.metaKept);
const limits = await p.evaluate(async () => {
  const A = window.ClawtrateAccessories;
  const P = window.ClawtratePicture;
  const choice = A.tidy({ family: "shellfolk", shell: "dome", color: "pink", head: "crown" });
  const stripped = await new Promise((resolve) => {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    c.getContext("2d").fillRect(2, 2, 8, 8);
    resolve(c.toDataURL("image/png"));
  });
  const base = P.chunkCount(stripped);
  const fill = (total) => P.withChunks(stripped, Array.from({ length: total - base }, (_, i) => ["Comment", `note ${i}`]));
  const at128 = fill(128);
  const at127 = fill(127);
  const written127 = P.pictureWithChoice(at127, choice);
  const broken = P.withChunks(stripped, [[P.KEYWORD_V2, null]]);
  const brokenText = P.withChunks(stripped, [[P.KEYWORD_V2 + "v=2&family=shellfolk", null]]);
  const brokenOld = P.withChunks(stripped, [[P.KEYWORD_V1, null]]);
  const withValid = P.withChunks(stripped, [[P.KEYWORD_V2, null], [P.KEYWORD_V2, A.encodeChoice(choice)]]);
  return {
    full: P.chunkCount(at128) === 128 && P.readPicture(at128).kind === "plain" && P.readPictureV1(at128).kind === "plain",
    refused: P.pictureWithChoice(at128, choice) === null,
    oneLess: written127 !== null && P.chunkCount(written127) === 128 && P.readPicture(written127).kind === "creature",
    broken: P.readPicture(broken).kind === "invalid" && P.readPicture(brokenText).kind === "invalid",
    brokenWithValid: P.readPicture(withValid).kind === "invalid",
    v1Kept: P.readPictureV1(broken).kind === "plain" && P.readPictureV1(brokenOld).kind === "plain" && P.readPicture(brokenOld).kind === "plain",
    rewritesBroken: P.readPicture(P.pictureWithChoice(broken, choice)).kind === "creature",
  };
});
check("AS-27 a PNG already at 128 chunks reads as plain, but writing a tag into it is refused (it would be 129)", limits.full && limits.refused, JSON.stringify(limits));
check("AS-27 at 127 chunks the tag is written, making 128", limits.oneLess);
check("AS-27 the v2 keyword with no separator is a broken tag: invalid alone and beside a valid tag; writing replaces it", limits.broken && limits.brokenWithValid && limits.rewritesBroken);
check("AS-27 #300's v1 reading is unchanged: the same chunks are plain to it", limits.v1Kept);
const grammar = await p.evaluate(() => {
  const A = window.ClawtrateAccessories;
  const ok = "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&head=beret&face=glasses&neck=bowtie&trim=yellow";
  const refuse = [
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&head=beret", // no trim
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&head=beret&head=crown&trim=yellow", // repeated
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&head=beret&__proto__=x&trim=yellow", // extra
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&face=glasses&head=beret&trim=yellow", // order
    "v=2&family=clawling&eyes=pair&body=dome&claws=even&color=blue&head=beret&trim=yellow", // base order
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&head=none&trim=yellow", // none
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&head=null&trim=yellow", // null
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&head=&trim=yellow", // empty
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&head=beret &trim=yellow", // space
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&head=ber%65t&trim=yellow", // escape
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&head=Beret&trim=yellow", // case
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&head=bérét&trim=yellow", // non-ASCII
    "v=2&family=clawling&body=dome&eyes=pair&claws=even&color=blue&trim=yellow", // nothing worn
    "v=2&family=shellfolk&shell=spiral&color=red&head=crown&trim=yellow", // guarded colour
    "v=2&family=shellfolk&shell=spiral&color=pink&head=tophat&trim=yellow", // unknown
    "v=2&family=shellfolk&shell=spiral&color=pink&head=crown&trim=yellow&", // trailing
    "v=3&family=shellfolk&shell=spiral&color=pink&head=crown&trim=yellow", // version
  ];
  const back = A.decodeV2(ok);
  return { ok: !!back && A.encodeChoice(back) === ok && Object.getPrototypeOf(back) === Object.prototype, refused: refuse.filter((t) => A.decodeV2(t) === null).length, total: refuse.length };
});
check("AS-12 the v2 grammar reads its exact form into a fresh choice", grammar.ok);
check("AS-12 and refuses missing trim, repeats, extras, order, none, null, empties, spaces, escapes, case, non-ASCII, nothing worn", grammar.refused === grammar.total, `${grammar.refused}/${grammar.total}`);
const strict = await p.evaluate(() => {
  const A = window.ClawtrateAccessories;
  const base = { family: "lantern", body: "round", lure: "hook", eyes: "two", color: "sky" };
  const inherited = Object.create({ head: "beret" });
  Object.assign(inherited, base);
  return [
    A.parseChoice({ ...base, head: "tophat" }) === null,
    A.parseChoice({ ...base, hat: "beret" }) === null,
    A.parseChoice({ ...base, trim: "red" }) === null,
    A.parseChoice({ ...base, color: "red" }) === null,
    A.parseChoice({ ...base, head: "none" }) === null,
    A.parseChoice({ ...base, head: null }) === null,
    A.parseChoice({ ...base, trim: "pink" }) === null,
    A.parseChoice(inherited) === null,
    A.parseChoice({ ...base, head: "beret", face: "glasses" })?.face === "glasses",
  ];
});
check("AS-12 a bot's proposal is parsed strictly: unknown, none, null, a lone trim or inherited keys are refused", strict.every(Boolean), JSON.stringify(strict));
const reply = await p.evaluate(() => {
  const A = window.ClawtrateAccessories;
  const idea = { family: "lantern", body: "round", lure: "hook", eyes: "two", color: "sky", head: "headphones", trim: "violet" };
  const j = (x) => JSON.stringify(x);
  const r = (t) => A.parseIdeasReply(t);
  return {
    good: r(j({ ideas: [idea] })).ok,
    normalized: (() => {
      const x = r(j({ ideas: [{ ...idea, face: null, neck: "none" }, { family: "shellfolk", shell: "dome", color: "pink", trim: "lime" }, { family: "clawling", body: "dome", eyes: "pair", claws: "even", color: "blue", head: "beret" }] }));
      return x.ok && x.ideas.length === 3 && !("face" in x.ideas[0]) && !("trim" in x.ideas[1]) && x.ideas[2].trim === "yellow";
    })(),
    deduped: r(j({ ideas: [idea, idea, { ...idea, color: "pink" }] })).ideas?.length === 2,
    partial: r(j({ ideas: [idea, { ...idea, head: "tophat" }, { ...idea, shell: "dome" }] })).ideas?.length === 1,
    prose: r(`Here you go: ${j({ ideas: [idea] })}`).ok === false,
    extraKey: r(j({ ideas: [idea], note: "hi" })).ok === false,
    duplicateKey: r('{"ideas":[{"family":"shellfolk","shell":"dome","shell":"spiral","color":"pink"}]}').ok === false,
    nested: r(j({ ideas: [{ ...idea, head: { name: "beret" } }] })).ok === false,
    number: r(j({ ideas: [{ ...idea, color: 3 }] })).ok === false,
    tooMany: r(j({ ideas: [idea, idea, idea, idea] })).ok === false,
    none: r(j({ ideas: [] })).ok === false,
    tooLong: r(j({ ideas: [{ ...idea, pad: "x".repeat(4100) }] })).reason === "too-long",
    allBad: r(j({ ideas: [{ family: "lobster", color: "red" }] })).ok === false,
    proto: r('{"ideas":[{"family":"shellfolk","shell":"dome","color":"pink","__proto__":"x"}]}').ok === false,
    nullTrim: r(j({ ideas: [{ ...idea, trim: null }] })).ok === false,
    mixed: (() => {
      const x = r('{"ideas":[{"family":"shellfolk","shell":"dome","color":"pink","__proto__":"x"},' + j({ ...idea, trim: null }) + "," + j(idea) + "]}");
      return x.ok && x.ideas.length === 1 && x.ideas[0].head === "headphones" && Object.getPrototypeOf(x.ideas[0]) === Object.prototype;
    })(),
  };
});
check("AS-28 a valid reply gives its ideas", reply.good);
check("AS-28 null and none slots, a lone trim and a missing trim are normalized only at this boundary", reply.normalized);
check("AS-28 repeats collapse; only the valid ideas of a well-formed reply are shown", reply.deduped && reply.partial);
check("AS-28 prose, extra keys, duplicate keys, nesting, numbers, wrong counts, over 4 KiB and no valid idea are refused", ["prose", "extraKey", "duplicateKey", "nested", "number", "tooMany", "none", "tooLong", "allBad"].every((k) => reply[k]), JSON.stringify(reply));
check("AS-28 an idea with a __proto__ key or a null trim is dropped before anything is copied", reply.proto && reply.nullTrim);
check("AS-28 in a mixed reply the valid idea survives, as a plain fresh object", reply.mixed);
await p.close();

// Describe a Claw, simulated ----------------------------------------------------------------
p = await open("theme=dark&mode=edit&tab=custom");
check("AS-13 Edit picture shows the bot's name and a Save that waits for a change", await p.evaluate(() => !document.querySelector("#as-name") && document.querySelector('[data-act="save"]').disabled));
check("AS-24 the Custom row has a tab stop before anything is chosen", await p.evaluate(() => document.querySelectorAll('.as-custom-items [tabindex="0"]').length === 1));
await p.click('[data-act="describe-open"]');
check("AS-13 Describe is labelled as simulated and names the route and its cost", (await p.isVisible('[data-testid="simulated"]')) && /anthropic\/claude-sonnet-5\.5.*model usage.*no tools/.test(await p.textContent('[data-testid="route"]')));
await p.fill("#as-words", "A slow night owl who loves jazz records, prose");
await p.focus('[data-act="describe-go"]');
await p.keyboard.press("Enter");
check("AS-13 while it waits, focus moves to Cancel and the Claw thinks", await p.evaluate(() => document.activeElement.dataset.act === "describe-cancel" && /Juniper is imagining it/.test(document.querySelector('[data-testid="waiting"]')?.textContent || "") && document.querySelector("#as-preview").dataset.state === "thinking"));
check("AS-13 Save is blocked while it waits", await p.evaluate(() => document.querySelector('[data-act="save"]').disabled));
await p.evaluate(() => (document.activeElement.__mark = true));
await p.clock.runFor(2400);
check("AS-13 the slow notice appears in place: Cancel stays mounted and focused", await p.evaluate(() => !document.querySelector('[data-testid="slow"]').hidden && document.activeElement.__mark === true && document.activeElement.dataset.act === "describe-cancel"));
await p.clock.runFor(2000);
check("AS-13 a reply wrapped in words gets the one retry, and Cancel is still the same focused control", await p.evaluate(() => /Asking once more/.test(document.querySelector('[data-testid="waiting"]')?.textContent || "") && document.activeElement.__mark === true));
await p.clock.runFor(1300);
const ideas = await p.evaluate(() => document.querySelectorAll(".as-idea").length);
check("AS-13 then ideas come back, the first in the preview and focused", ideas === 3 && (await p.evaluate(() => /^Idea: /.test(document.querySelector("#as-preview").getAttribute("aria-label")) && document.activeElement.classList.contains("as-idea"))));
check("AS-13 the caption is Clawtrate's own words for the idea, nothing the model wrote", await p.evaluate(() => /^Idea 1 of 3: /.test(document.querySelector('[data-testid="idea-caption"]').textContent)));
check("AS-13 nothing is saved yet, and Save waits for Use this", await p.evaluate(() => window.CTStudio.S.choice.family === "clawling" && window.CTStudio.S.choice.color === "green" && document.querySelector('[data-act="save"]').disabled));
await p.click('[data-act="idea-use"]');
check("AS-13 Use this puts the idea in the build and the Custom row, and Save is offered", await p.evaluate(() => window.CTStudio.S.choice.head === "headphones" && document.querySelectorAll('.as-custom-item[data-kind="claw"]').length >= 3 && !document.querySelector('[data-act="save"]').disabled));
check("AS-13 the Custom row keeps the Claw, not the words", await p.evaluate(() => !JSON.stringify(window.CTStudio.S.custom).includes("night owl")));
await p.click('[data-act="describe-open"]');
await p.fill("#as-words", "fail");
await p.click('[data-act="describe-go"]');
await p.clock.runFor(3500);
check("AS-14 two unusable replies say so, change nothing, and focus Try again", await p.evaluate(() => /Nothing changed/.test(document.querySelector('.as-describe [role="alert"]')?.textContent || "") && window.CTStudio.S.choice.head === "headphones" && document.activeElement.dataset.act === "describe-go"));
await p.click('[data-act="describe-edit"]');
await p.fill("#as-words", "A red lobster on the beach");
await p.click('[data-act="describe-go"]');
await p.clock.runFor(2000);
check("AS-14 red or orange words get Clawtrate's note and palette colours", await p.evaluate(() => !!document.querySelector('[data-testid="guard-note"]') && window.CTStudio.S.describe.ideas.every((i) => !window.ClawtrateCreatures.isGuardedColor(window.ClawtrateCreatures.AVATAR_COLORS[i.color]))));
await p.click('[data-act="idea-use"]');
await p.click('[data-act="save"]');
for (let i = 0; i < 10 && !(await p.$('[data-testid="done"]')); i++) await p.clock.runFor(200);
check("AS-14 Save writes the picture and reads it back", await p.evaluate(() => window.CTStudio.S.done?.read.kind === "creature" && window.ClawtrateAccessories.encodeChoice(window.CTStudio.S.done.read.choice) === window.CTStudio.S.done.shown));
await p.close();
p = await open("theme=dark&mode=edit&tab=extras&save=fail");
await p.click('[data-act="wear"][data-slot="head"][data-value="beret"]');
await p.click('[data-act="save"]');
await p.clock.runFor(1500);
check("AS-14 a failed save keeps the draft and says so", await p.evaluate(() => /Your changes are still here/.test(document.querySelector('[data-testid="save-error"]')?.textContent || "") && window.CTStudio.S.choice.head === "beret" && !!document.querySelector(".as-dialog")));
await p.close();
p = await open("theme=dark&tab=custom&describe=unavailable");
check("AS-14 without a tool-free route, Describe says it isn't available", await p.isVisible('[data-testid="describe-unavailable"]'));
await p.close();

// The chat proposal --------------------------------------------------------------------------
p = await open("theme=dark&view=chat");
check("AS-15 the bot's proposal shows now and proposed, in words, and waits", await p.evaluate(() => document.querySelectorAll('[data-testid="proposal"] .as-pair .avatar').length === 2 && /wearing headphones/.test(document.querySelector('[data-testid="proposal-fields"]').textContent) && /Nothing changes until you choose/.test(document.querySelector('[data-testid="proposal"]').textContent)));
await p.click('[data-act="chat-use"]');
check("AS-15 Use it saves, says so, and offers Undo", await p.evaluate(() => /picture changed/.test(document.querySelector('[data-testid="proposal"]').textContent) && !!document.querySelector('[data-act="chat-undo"]')));
await p.click('[data-act="chat-undo"]');
await p.click('[data-act="chat-no"]');
check("AS-15 Not now keeps the picture", await p.evaluate(() => /Kept its picture/.test(document.querySelector('[data-testid="proposal"]').textContent)));
await p.close();
const ends = {};
for (const state of ["admin", "expired", "superseded", "elsewhere", "unconfirmed"]) {
  p = await open(`theme=dark&view=chat&chat=${state}`);
  ends[state] = await p.evaluate(() => document.querySelector('[data-testid="proposal"]').textContent);
  await p.close();
}
check("AS-15 without admin, the card asks for it", /Admin access needed/.test(ends.admin));
check("AS-15 expired, superseded, changed elsewhere and unconfirmed each have their own words", /expired after 24 hours/.test(ends.expired) && /newer picture/.test(ends.superseded) && /changed somewhere else/.test(ends.elsewhere) && /Couldn't confirm the save/.test(ends.unconfirmed));

// Reduced motion: the app's setting and the system's ---------------------------------------
p = await open("theme=dark&motion=reduce&tab=extras");
check("AS-16 with the app's reduced motion nothing moves", await p.evaluate(() => document.getAnimations().length === 0));
await p.click('[data-act="wear"][data-slot="head"][data-value="crown"]');
check("AS-16 and a choice plays no beat", await p.evaluate(() => document.querySelector("#as-preview").dataset.state === "idle" && document.getAnimations().length === 0));
await p.close();
p = await open("theme=dark", { width: 1440, height: 900 }, { reducedMotion: "reduce" });
check("AS-16 with the system's reduced motion nothing moves either", await p.evaluate(() => document.documentElement.dataset.motion === "reduce" && document.getAnimations().length === 0));
await p.close();

// Phone width and themes ------------------------------------------------------------------
for (const theme of ["dark", "light"])
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    for (const q of ["", "&tab=extras", "&tab=custom&describe=result", "&view=chat"]) {
      p = await open(`theme=${theme}${q}`, { width: w, height: h });
      const m = await p.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        sideways: document.documentElement.scrollWidth > innerWidth + 1,
        dialog: document.querySelector(".as-dialog")?.getBoundingClientRect().width ?? null,
      }));
      check(`AS-17 ${theme} at ${w}${q || " (studio)"}: drawn in its theme, no sideways scroll`, m.theme === theme && !m.sideways, JSON.stringify(m));
      if (w === 390 && m.dialog !== null) check(`AS-17 ${theme} at 390${q}: the studio is a full-width sheet`, Math.round(m.dialog) === 390, String(m.dialog));
      await p.close();
    }
  }
// Hit-tested: a 44 px round target on each control's centre lands on that control, at both
// phone heights, with the panel at its top and at its bottom. Panel controls count
// when their square is inside the panel's visible part.
const hitTest = () =>
  document.defaultView.eval(`(() => {
    const panel = document.querySelector("#as-panel").getBoundingClientRect();
    const misses = [];
    for (const el of document.querySelectorAll(".as-dialog button, .as-dialog [role='tab'], .as-dialog input, .as-dialog textarea")) {
      if (el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const inPanel = !!el.closest("#as-panel");
      if (inPanel && (cy - 22 < panel.top || cy + 22 > panel.bottom)) continue;
      for (const [dx, dy] of [[0, 0], ...Array.from({ length: 8 }, (_, i) => [21 * Math.cos((i * Math.PI) / 4), 21 * Math.sin((i * Math.PI) / 4)])]) {
        const hit = document.elementFromPoint(cx + dx, cy + dy);
        if (!hit || (hit !== el && !el.contains(hit))) {
          misses.push((el.dataset.act || el.id || el.textContent.trim()) + " " + Math.round(r.width) + "x" + Math.round(r.height));
          break;
        }
      }
    }
    return misses;
  })()`);
for (const q of ["", "tab=colour", "tab=extras", "tab=custom&describe=result", "mode=edit&tab=custom&describe=typing"])
  for (const h of [844, 520]) {
    p = await open(`theme=dark&${q}`, { width: 390, height: h });
    const misses = [];
    for (const end of ["top", "bottom"]) {
      await p.evaluate((e) => {
        const panel = document.querySelector("#as-panel");
        panel.scrollTop = e === "top" ? 0 : panel.scrollHeight;
      }, end);
      misses.push(...(await p.evaluate(hitTest)).map((m) => `${end}: ${m}`));
    }
    check(`AS-29 at 390 × ${h}${q ? " " + q : ""}: every control's 44 px target hits it, panel scrolled both ways`, misses.length === 0, misses.slice(0, 4).join(", "));
    await p.close();
  }
for (const h of [844, 520]) {
  p = await open("theme=dark&tab=custom&describe=result", { width: 390, height: h });
  const whole = [];
  for (const end of ["top", "bottom"]) {
    await p.evaluate((e) => {
      const panel = document.querySelector("#as-panel");
      panel.scrollTop = e === "top" ? 0 : panel.scrollHeight;
    }, end);
    whole.push(
      await p.evaluate(() => {
        const bar = document.querySelector('[data-testid="result-actions"]');
        const panel = document.querySelector("#as-panel").getBoundingClientRect();
        const foot = document.querySelector("#as-foot").getBoundingClientRect();
        return [...bar.querySelectorAll("button")].every((b) => {
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return r.height >= 44 && r.top >= panel.bottom - 1 && r.bottom <= foot.top + 1 && (hit === b || b.contains(hit));
        });
      }),
    );
  }
  check(`AS-29 at 390 × ${h} the ideas' actions sit whole between the panel and the foot, outside the scroll, panel at top and bottom`, whole.every(Boolean), JSON.stringify(whole));
  await p.close();
}

// Uploads: #300's header check for all four formats, before anything is decoded.
p = await open("theme=dark&tab=custom");
const le16 = (n) => [n & 255, (n >> 8) & 255];
const be16 = (n) => [(n >> 8) & 255, n & 255];
const be32 = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const ascii = (t) => [...t].map((c) => c.charCodeAt(0));
const files = {
  png: [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, ...ascii("IHDR"), ...be32(4100), ...be32(4100), 8, 6, 0, 0, 0, 0, 0, 0, 0],
  gif: [...ascii("GIF89a"), ...le16(8193), ...le16(10), 0, 0, 0, 0, 0, 0],
  webp: [...ascii("RIFF"), 30, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...[4999 & 255, (4999 >> 8) & 255, 0], ...[4999 & 255, (4999 >> 8) & 255, 0], 0, 0],
  jpeg: [0xff, 0xd8, 0xff, 0xe0, ...be16(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, ...be16(17), 8, ...be16(9000), ...be16(9000), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0, 0, 0, 0],
  text: ascii("not an image at all, just words"),
};
await p.evaluate(() => {
  window.__decoded = 0;
  const original = window.createImageBitmap;
  window.createImageBitmap = (...args) => {
    window.__decoded += 1;
    return original(...args);
  };
});
const refusals = {};
for (const [kind, bytes] of Object.entries(files)) {
  await p.setInputFiles("#as-file", { name: `big.${kind}`, mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
  for (let i = 0; i < 5; i++) await p.clock.runFor(50);
  refusals[kind] = await p.evaluate(() => document.querySelector("#as-upload-error")?.textContent || "");
}
const decoded = await p.evaluate(() => window.__decoded);
check("AS-31 oversized PNG, GIF, WebP and JPEG headers are refused with #300's words before any decode", ["png", "gif", "webp", "jpeg"].every((k) => /under 16 million pixels/.test(refusals[k])) && decoded === 0, JSON.stringify({ ...refusals, decoded }));
check("AS-31 a file that is none of the four is refused by its bytes", /PNG, JPEG, WebP or GIF/.test(refusals.text));
const headers = await p.evaluate(() => {
  const H = window.CTStudio.imageHeader;
  const u = (a) => new Uint8Array(a);
  return [H(u([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3, 1, 0x22, 0, 0, 0, 0])), H(u([0, 1, 2]))];
});
check("AS-31 the header reader is #300's: a JPEG frame's sides, and unknown bytes", headers[0]?.width === 200 && headers[0]?.height === 100 && headers[1] === "unknown", JSON.stringify(headers));
await p.close();

// The gallery links here.
const gp = await b.newPage();
await gp.goto(pageUrl("gallery.html") + "?chrome=0");
check("AS-18 the gallery links to the studio", await gp.evaluate(() => !!document.querySelector('a[href^="avatar-studio.html"]')));
await gp.close();

await b.close();
console.log(out.join("\n"));
const oks = out.filter((l) => l.startsWith("ok")).length;
console.log(`\n${oks} ok, ${failed} not ok`);
process.exit(failed || out.some((l) => /^(PAGEERROR|CONSOLE|NETWORK)/.test(l)) ? 1 : 0);
