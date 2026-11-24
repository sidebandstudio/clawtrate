// Checks for avatars.html: every creature family in every state at every size,
// dark first and then light; the fine detail gone below 21 px; the motions
// playing, and with motion reduced, a still pose per state.
// Run from the repository root:  node docs/design/prototype/tools/checks/avatars.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("avatars.html") + "?chrome=0";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
const open = async (query = "") => {
  const context = await b.newContext({ viewport: { width: 1440, height: 900 } });
  // The page's timers run on a paused clock that each step moves on by the time it names (#278),
  // set before the context has a page, so it has no deadline to miss.
  await context.clock.install();
  await context.clock.pauseAt(Date.now());
  const p = await context.newPage();
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  p.on("request", (r) => {
    if (/^https?:/.test(r.url())) out.push("NETWORK " + r.url());
  });
  p.close = () => context.close();
  await p.goto(base + (query ? "&" + query : ""));
  await p.clock.runFor(150);
  return p;
};

let p = await open();
const boards = await p.evaluate(() => [...document.querySelectorAll("[data-board]")].map((x) => x.dataset.board));
check("AV-01 dark first, then light", JSON.stringify(boards) === '["dark","light"]', JSON.stringify(boards));
const cells = await p.evaluate(() =>
  [...document.querySelectorAll("[data-board] td")].map((td) => ({
    size: td.dataset.size,
    state: td.dataset.state,
    family: td.dataset.family,
    drawn: !!td.querySelector("svg.creature"),
  })),
);
const want = 2 * 4 * 6 * 5;
check("AV-02 every row in every state at every size, each drawn", cells.length === want && cells.every((c) => c.drawn), `${cells.length}/${want}`);
for (const family of ["clawling", "shellfolk", "lantern"])
  for (const size of ["18", "22", "32", "40", "56"])
    check(
      `AV-03 ${family} at ${size} px in all six states`,
      new Set(cells.filter((c) => c.family === family && c.size === size).map((c) => c.state)).size === 6,
    );
const fine = await p.evaluate(() => {
  const by = {};
  for (const td of document.querySelectorAll("[data-board] td")) {
    const size = td.dataset.size;
    by[size] ??= { shown: 0, all: 0 };
    for (const f of td.querySelectorAll(".av-fine")) {
      by[size].all += 1;
      if (getComputedStyle(f).display !== "none") by[size].shown += 1;
    }
  }
  return by;
});
check("AV-04 at 18 px the mouths, glints and shell lines are dropped", fine["18"].all > 0 && fine["18"].shown === 0, JSON.stringify(fine["18"]));
check("AV-04 from 22 px they are all drawn", ["22", "32", "40", "56"].every((s) => fine[s].shown === fine[s].all && fine[s].all > 0));
const playing = await p.evaluate(() => [...new Set(document.getAnimations().map((a) => a.animationName))].sort());
check(
  "AV-05 the states play their motions",
  ["av-blink", "av-bob", "av-conduct", "av-crawl", "av-glow", "av-hop", "av-lean", "av-lure-sway", "av-ping", "av-snap", "av-sway", "av-tilt", "av-wave"].every((n) => playing.includes(n)),
  playing.join(" "),
);
const colours = await p.evaluate(() => [...new Set([...document.querySelectorAll("svg.creature [fill], svg.creature [stroke]")].flatMap((e) => [e.getAttribute("fill"), e.getAttribute("stroke")]).filter((c) => c && c.startsWith("#")))]);
const guarded = await p.evaluate((list) => list.filter((c) => window.ClawtrateCreatures.isGuardedColor(c)), colours);
check("AV-06 no creature is drawn in a red-lobster or orange-crab colour", guarded.length === 0, guarded.join(" "));
await p.close();

p = await open("motion=reduce");
check("AV-07 with motion reduced nothing moves", await p.evaluate(() => document.getAnimations().length === 0));
const raised = await p.evaluate(() => [...document.querySelectorAll('td[data-state="waiting"][data-family="clawling"] .av-still')].map((e) => getComputedStyle(e).rotate));
check("AV-07 and a waiting Clawling holds its claw up, not mid-wave", raised.length > 0 && raised.every((r) => r === "-54deg"), [...new Set(raised)].join(" "));
const muted = await p.evaluate(() => [...document.querySelectorAll('td[data-state="blocked"] svg.creature')].every((s) => s.hasAttribute("data-muted")));
check("AV-08 blocked creatures lose their colour", muted);
await p.close();

await b.close();
console.log(out.join("\n"));
const oks = out.filter((l) => l.startsWith("ok")).length;
console.log(`\n${oks} ok, ${failed} not ok`);
process.exit(failed || out.some((l) => l.startsWith("PAGEERROR") || l.startsWith("NETWORK")) ? 1 : 0);
