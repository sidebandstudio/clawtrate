// Checks for avatar-studio.html (docs/design/avatar-studio.md): the studio's
// tabs and choices, accessories on every family, what is dropped below 21 px,
// the palette guard, the choice's round trip through its text form, Surprise
// me and Undo, the simulated Describe a Claw, the chat proposal, reduced
// motion, the phone width, both themes and the gallery's link.
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
const open = async (query = "", viewport = { width: 1440, height: 900 }) => {
  const context = await b.newContext({ viewport });
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

// The studio, New bot.
let p = await open("theme=dark");
check("AS-01 New bot opens with the name field and Next", await p.evaluate(() => !!document.querySelector("#as-name") && document.querySelector('[data-act="next"]')?.textContent === "Next"));
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
await p.click('[data-act="wear"][data-slot="head"][data-value="none"]');
check("AS-03 None takes it off", !(await parts(p)).includes("wear-beret"));
await p.click("#as-tab-colour");
check("AS-03 with something worn, the accessory colour is offered", await p.evaluate(() => !!document.querySelector('[data-group="as-trim"]')));
// Keyboard on a radio group: one tab stop, arrows choose.
await p.click("#as-tab-creature");
await p.focus('[data-group="as-family"] [aria-checked="true"]');
await p.keyboard.press("ArrowRight");
check("AS-04 arrows choose in a radio group and keep focus there", await p.evaluate(() => window.CTStudio.S.choice.family === "shellfolk" && document.activeElement.dataset.value === "shellfolk"));
check("AS-04 a family change keeps what is worn", await p.evaluate(() => window.CTStudio.S.choice.face === "glasses"));
// The happy beat, then rest.
check("AS-05 a choice plays the done beat", await p.evaluate(() => document.querySelector("#as-preview").dataset.state === "done"));
await p.clock.runFor(1500);
check("AS-05 and returns to idle", await p.evaluate(() => document.querySelector("#as-preview").dataset.state === "idle"));
// Surprise me and Undo.
const before = await p.evaluate(() => window.ClawtrateAccessories.encodeChoice(window.CTStudio.S.choice));
await p.click('[data-act="surprise"]');
const after = await p.evaluate(() => window.ClawtrateAccessories.encodeChoice(window.CTStudio.S.choice));
check("AS-06 Surprise me changes the Claw", before !== after, after);
await p.click('[data-act="undo"]');
check("AS-06 Undo surprise brings it back", (await p.evaluate(() => window.ClawtrateAccessories.encodeChoice(window.CTStudio.S.choice))) === before);
// Play the states.
await p.click('[data-act="play"]');
const seen = new Set();
for (let i = 0; i < 6; i++) {
  seen.add(await p.evaluate(() => document.querySelector("#as-preview").dataset.state));
  await p.clock.runFor(1600);
}
check("AS-07 Play the states shows all six", seen.size === 6, [...seen].join(" "));
await p.close();

// Accessories on every family, at every size; the guard; the round trip.
p = await open("theme=dark&view=board");
const fit = await p.evaluate(() =>
  [...document.querySelectorAll("[data-board=dark] td[data-fit]")].map((td) => ({
    want: td.dataset.fit,
    family: td.dataset.family,
    has: !!td.querySelector(`[data-part="wear-${td.dataset.fit}"]`),
  })),
);
check("AS-08 every accessory is drawn on every family's parts", fit.length === 8 * 14 && fit.every((f) => f.has), `${fit.filter((f) => f.has).length}/${fit.length}`);
const fine = await p.evaluate(() => {
  const by = {};
  for (const td of document.querySelectorAll("[data-board] td[data-size]")) {
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
check("AS-09 from 22 px everything is drawn", ["22", "32", "56", "152"].every((s) => fine[s].shown === fine[s].all && fine[s].glasses > 0));
const silhouettes = await p.evaluate(() => [...document.querySelectorAll('td[data-size="18"] [data-part^="wear-"]')].filter((e) => getComputedStyle(e).display !== "none").map((e) => e.dataset.part));
check("AS-09 at 18 px hats, shades, headphones and bow ties stay", ["wear-beret", "wear-party", "wear-beanie", "wear-headphones", "wear-crown", "wear-shades", "wear-bowtie"].every((w) => silhouettes.includes(w)));
const colours = await p.evaluate(() => [...new Set([...document.querySelectorAll("svg.creature [fill], svg.creature [stroke]")].flatMap((e) => [e.getAttribute("fill"), e.getAttribute("stroke")]).filter((c) => c && c.startsWith("#")))]);
const guarded = await p.evaluate((list) => list.filter((c) => window.ClawtrateCreatures.isGuardedColor(c)), colours);
check("AS-10 no accessory is drawn in a guarded colour", guarded.length === 0, guarded.join(" "));
const trims = await p.evaluate(() => {
  const C = window.ClawtrateCreatures;
  const A = window.ClawtrateAccessories;
  return C.AVATAR_COLOR_NAMES.flatMap((t) => [C.AVATAR_COLORS[t], C.shade(C.AVATAR_COLORS[t], 0.18), C.shade(C.AVATAR_COLORS[t], 0.22), C.shade(C.AVATAR_COLORS[t], 0.28), C.shade(C.AVATAR_COLORS[t], 0.3)]).filter((c) => C.isGuardedColor(c)).concat(C.isGuardedColor(A.AVATAR_GOLD) ? [A.AVATAR_GOLD] : []);
});
check("AS-10 every trim and its shades pass the guard", trims.length === 0, trims.join(" "));
const trip = await p.evaluate(() => {
  const C = window.ClawtrateCreatures;
  const A = window.ClawtrateAccessories;
  const bad = [];
  let n = 0;
  for (const family of C.AVATAR_FAMILIES)
    for (const [slot, list] of Object.entries(A.AVATAR_ACCESSORIES))
      for (const wear of ["none", ...list])
        for (const color of C.AVATAR_COLOR_NAMES) {
          const choice = { ...C.firstChoice(family, color) };
          if (wear !== "none") choice[slot] = wear;
          const text = A.encodeChoice(choice);
          const back = A.decodeChoice(text);
          n += 1;
          if (!back || A.encodeChoice(back) !== text) bad.push(text);
          if (wear === "none" && text !== C.encodeAvatarChoice(choice)) bad.push("v1 differs: " + text);
          if (wear !== "none" && C.decodeAvatarChoice(text) !== null) bad.push("old reader accepts " + text);
        }
  return { n, bad };
});
check("AS-11 every family with every accessory round-trips; nothing worn stays v=1; a v=1 reader refuses v=2", trip.bad.length === 0, `${trip.n} choices ${trip.bad.slice(0, 3).join(" | ")}`);
const strict = await p.evaluate(() => {
  const A = window.ClawtrateAccessories;
  const base = { family: "lantern", body: "round", lure: "hook", eyes: "two", color: "sky" };
  return [
    A.parseChoice({ ...base, head: "tophat" }) === null,
    A.parseChoice({ ...base, hat: "beret" }) === null,
    A.parseChoice({ ...base, trim: "red" }) === null,
    A.parseChoice({ ...base, color: "red" }) === null,
    A.parseChoice({ ...base, head: "beret", face: "glasses" })?.face === "glasses",
    A.parseChoice({ ...base, trim: "pink" })?.trim === undefined,
    A.decodeChoice("v=3&family=lantern") === null,
  ];
});
check("AS-12 untrusted fields: unknown accessories, keys and colours are refused; a lone trim is dropped", strict.every(Boolean), JSON.stringify(strict));
await p.close();

// Describe a Claw, simulated.
p = await open("theme=dark&mode=edit&tab=custom");
check("AS-13 Edit picture shows the bot's name and a Save that waits for a change", await p.evaluate(() => !document.querySelector("#as-name") && document.querySelector('[data-act="save"]').disabled));
await p.click('[data-act="describe-open"]');
check("AS-13 Describe is labelled as simulated", await p.isVisible('[data-testid="simulated"]'));
await p.fill("#as-words", "A night owl who loves jazz records");
await p.click('[data-act="describe-go"]');
check("AS-13 while it waits, the bot is named and the Claw thinks", await p.evaluate(() => /Juniper is imagining it/.test(document.querySelector(".as-wait")?.textContent || "") && document.querySelector("#as-preview").dataset.state === "thinking"));
await p.clock.runFor(2000);
const ideas = await p.evaluate(() => document.querySelectorAll(".as-idea").length);
check("AS-13 three ideas come back, the first in the preview", ideas === 3 && (await p.evaluate(() => /^Idea: /.test(document.querySelector("#as-preview").getAttribute("aria-label")))));
check("AS-13 nothing is saved yet", await p.evaluate(() => window.CTStudio.S.choice.family === "clawling" && window.CTStudio.S.choice.color === "green"));
await p.click('[data-act="idea-use"]');
check("AS-13 Use this puts the idea in the build and the Custom row, and Save is offered", await p.evaluate(() => window.CTStudio.S.choice.head === "headphones" && document.querySelectorAll('.as-custom-item[data-kind="claw"]').length >= 3 && !document.querySelector('[data-act="save"]').disabled));
await p.click('[data-act="describe-open"]');
await p.fill("#as-words", "fail");
await p.click('[data-act="describe-go"]');
check("AS-14 a failure says so and changes nothing", await p.evaluate(() => /Nothing changed/.test(document.querySelector('.as-describe [role="alert"]')?.textContent || "") && window.CTStudio.S.choice.head === "headphones"));
await p.click('[data-act="describe-edit"]');
await p.fill("#as-words", "A red lobster on the beach");
await p.click('[data-act="describe-go"]');
await p.clock.runFor(2000);
check("AS-14 red or orange words get the guard's note and a palette colour", await p.evaluate(() => !!document.querySelector('[data-testid="guard-note"]') && window.CTStudio.S.describe.ideas.every((i) => !window.ClawtrateCreatures.isGuardedColor(window.ClawtrateCreatures.AVATAR_COLORS[i.color]))));
await p.close();

// The chat proposal.
p = await open("theme=dark&view=chat");
check("AS-15 the bot's proposal shows now and proposed, in words, and waits", await p.evaluate(() => document.querySelectorAll('[data-testid="proposal"] .as-pair .avatar').length === 2 && /wearing headphones/.test(document.querySelector('[data-testid="proposal-fields"]').textContent) && /Nothing changes until you choose/.test(document.querySelector('[data-testid="proposal"]').textContent)));
await p.click('[data-act="chat-use"]');
check("AS-15 Use it saves, says so, and offers Undo", await p.evaluate(() => /picture changed/.test(document.querySelector('[data-testid="proposal"]').textContent) && !!document.querySelector('[data-act="chat-undo"]')));
await p.click('[data-act="chat-undo"]');
await p.click('[data-act="chat-no"]');
check("AS-15 Not now keeps the picture", await p.evaluate(() => /Kept its picture/.test(document.querySelector('[data-testid="proposal"]').textContent)));
await p.close();
p = await open("theme=dark&view=chat&chat=admin");
check("AS-15 without admin, the card asks for it", await p.evaluate(() => /Admin access needed/.test(document.querySelector('[data-testid="proposal"]').textContent)));
await p.close();

// Reduced motion.
p = await open("theme=dark&motion=reduce&tab=extras");
check("AS-16 with motion reduced nothing moves", await p.evaluate(() => document.getAnimations().length === 0));
await p.click('[data-act="wear"][data-slot="head"][data-value="crown"]');
check("AS-16 and a choice plays no beat", await p.evaluate(() => document.querySelector("#as-preview").dataset.state === "idle" && document.getAnimations().length === 0));
await p.close();

// Phone width and themes.
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

// The gallery links here.
const g = await b.newPage();
await g.goto(pageUrl("gallery.html") + "?chrome=0");
check("AS-18 the gallery links to the studio", await g.evaluate(() => !!document.querySelector('a[href^="avatar-studio.html"]')));
await g.close();

await b.close();
console.log(out.join("\n"));
const oks = out.filter((l) => l.startsWith("ok")).length;
console.log(`\n${oks} ok, ${failed} not ok`);
process.exit(failed || out.some((l) => /^(PAGEERROR|CONSOLE|NETWORK)/.test(l)) ? 1 : 0);
