// Measuring how an equipped Claw fits (docs/design/avatar-studio.md, section 4,
// "Fit"), on the drawn geometry. Not product code. tools/make-fit-inset.mjs uses
// it to generate js/fit-inset.js, and the studio's check uses it to prove that
// table is current and that it holds. The product generates the same table from
// the scene builders.

(function () {
  const C = window.ClawtrateCreatures;
  const A = window.ClawtrateAccessories;

  /** The Presence sizes the app draws a ring at: message card, title pill, rail rows, pinned tile, Work pane. */
  const RING_SIZES = [18, 22, 32, 40, 44, 56, 64];
  const SAMPLES = 16;

  /** The ring's inner edge in grid units at its tightest size, read from the app's own Presence CSS. */
  function ringLimit() {
    let limit = Infinity;
    for (const size of RING_SIZES) {
      const el = document.createElement("span");
      el.className = "presence";
      el.dataset.state = "working";
      el.style.setProperty("--size", `${size}px`);
      document.body.append(el);
      const ring = getComputedStyle(el, "::before");
      const reach = -parseFloat(ring.top) - parseFloat(ring.paddingTop);
      el.remove();
      limit = Math.min(limit, ((size / 2 + reach) / (size / 2)) * 20);
    }
    return limit;
  }

  let host = null;
  /** A Claw drawn at 40 px, so a pixel is a grid unit, still or held at its motions' peaks. */
  function draw(choice, state, peak) {
    if (!host) {
      host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:40px;height:40px;pointer-events:none";
      document.body.append(host);
    }
    host.innerHTML = window.CTStudio.creature(choice, state, "fit");
    const svg = host.firstElementChild;
    svg.style.cssText = "width:40px;height:40px";
    if (peak) window.CTStudio.holdPeaks(svg);
    else for (const a of svg.getAnimations({ subtree: true })) a.cancel();
    return svg;
  }

  /** A shape's own outline points, before its transforms: the same for every scene that draws it, so cached. */
  const localCache = new Map();
  function localPoints(leaf) {
    let raw = [];
    const n = (a) => +leaf.getAttribute(a);
    if (leaf.tagName === "path") {
      const L = leaf.getTotalLength();
      for (let i = 0; i <= SAMPLES; i++) {
        const q = leaf.getPointAtLength((L * i) / SAMPLES);
        raw.push([q.x, q.y]);
      }
    } else if (leaf.tagName === "circle" || leaf.tagName === "ellipse") {
      const [cx, cy] = [n("cx"), n("cy")];
      const [rx, ry] = leaf.tagName === "circle" ? [n("r"), n("r")] : [n("rx"), n("ry")];
      for (let i = 0; i < SAMPLES; i++) raw.push([cx + rx * Math.cos((i * Math.PI * 2) / SAMPLES), cy + ry * Math.sin((i * Math.PI * 2) / SAMPLES)]);
    } else {
      const [x, y, w, h] = [n("x"), n("y"), n("width"), n("height")];
      const r = Math.min(n("rx") || 0, w / 2, h / 2);
      // A rounded rect's corners are arcs: sample them, not the box's corners.
      for (const [cx, cy, a0] of [[x + w - r, y + r, -90], [x + w - r, y + h - r, 0], [x + r, y + h - r, 90], [x + r, y + r, 180]])
        for (let i = 0; i <= 4; i++) {
          const a = ((a0 + i * 22.5) * Math.PI) / 180;
          raw.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
    }
    return raw;
  }

  /** Every drawn shape's outline as points in grid units, each with its half stroke and whether it is an accessory. */
  function outline(svg) {
    const pts = [];
    for (const leaf of svg.querySelectorAll("path, circle, ellipse, rect")) {
      if (leaf.closest("clipPath, defs")) continue;
      if (leaf.getAttribute("opacity") === "0") continue;
      const m = leaf.getCTM();
      const s = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
      const stroke = leaf.getAttribute("stroke") || leaf.closest("[stroke]")?.getAttribute("stroke");
      const sw = stroke && stroke !== "none" ? (parseFloat(leaf.getAttribute("stroke-width") || leaf.closest("[stroke-width]")?.getAttribute("stroke-width") || 0) * s) / 2 : 0;
      const wear = !!leaf.closest('[data-part^="wear-"]');
      const sig = leaf.tagName === "path" ? `p${leaf.getAttribute("d")}` : leaf.outerHTML.replace(/ (style|class|data-part|fill|stroke|stroke-width|opacity)="[^"]*"/g, "");
      let raw = localCache.get(sig);
      if (!raw) {
        raw = localPoints(leaf);
        localCache.set(sig, raw);
      }
      for (const [x, y] of raw) pts.push({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f, sw, wear });
    }
    return pts;
  }

  /** How far a point reaches from the centre once the scene is inset by k about the feet. */
  const reach = (p, k) => {
    const [px, py] = A.FIT.pivot;
    return Math.hypot(px + (p.x - px) * k - 20, py + (p.y - py) * k - 20) + p.sw * k;
  };
  const extent = (pts, k = 1) => pts.reduce((m, p) => Math.max(m, reach(p, k)), 0);

  const bareCache = new Map();
  /** The bare creature's own reach per state, still and at its peaks: #293's art, which an accessory may not extend. */
  function bare(base) {
    const key = A.encodeChoice(base);
    if (!bareCache.has(key)) {
      const out = {};
      for (const state of C.AVATAR_STATES) out[state] = { still: extent(outline(draw(base, state, false))), peak: extent(outline(draw(base, state, true))) };
      bareCache.set(key, out);
    }
    return bareCache.get(key);
  }

  /**
   * The rules an equipped Claw meets with inset k, from its whole outline
   * (body, claws, lure and accessories), drawn without an inset:
   * - still, every state: accessories inside the saved picture's circle (FIT.still),
   *   and the silhouette reaching no further than 20 or the bare creature does;
   * - working, at its motions' peaks: accessories inside the Presence ring, and the
   *   silhouette no further than the ring or the bare creature;
   * - other states at their peaks: accessories within FIT.other.
   */
  function samples(choice) {
    const base = A.parseBase(Object.fromEntries(Object.entries(choice).filter(([k]) => !A.SLOTS.includes(k) && k !== "trim")));
    const b = bare(base);
    const out = [];
    for (const state of C.AVATAR_STATES) {
      out.push({ state, kind: "still", pts: outline(draw(choice, state, false)), bare: b[state].still });
      out.push({ state, kind: "peak", pts: outline(draw(choice, state, true)), bare: b[state].peak });
    }
    return out;
  }

  function fails(list, k, ring) {
    const bad = [];
    for (const s of list) {
      const wear = s.pts.filter((p) => p.wear);
      if (s.kind === "still") {
        if (extent(wear, k) > A.FIT.still) bad.push(`${s.state} still: accessory ${extent(wear, k).toFixed(2)}`);
        if (extent(s.pts, k) > Math.max(20, s.bare) + 0.01) bad.push(`${s.state} still: silhouette ${extent(s.pts, k).toFixed(2)} > ${Math.max(20, s.bare).toFixed(2)}`);
      } else if (s.state === "working") {
        if (extent(wear, k) > ring) bad.push(`working peak: accessory ${extent(wear, k).toFixed(2)} > ring ${ring.toFixed(2)}`);
        if (extent(s.pts, k) > Math.max(ring, s.bare) + 0.01) bad.push(`working peak: silhouette ${extent(s.pts, k).toFixed(2)} > ${Math.max(ring, s.bare).toFixed(2)}`);
      } else if (extent(wear, k) > A.FIT.other) bad.push(`${s.state} peak: accessory ${extent(wear, k).toFixed(2)}`);
    }
    return bad;
  }

  /** Every base creature, in picker order. */
  function bases() {
    let all = [];
    for (const family of C.AVATAR_FAMILIES) {
      let combos = [{ family, color: "blue" }];
      for (const [k, vs] of Object.entries(C.AVATAR_PARTS[family])) combos = combos.flatMap((c) => vs.map((v) => ({ ...c, [k]: v })));
      all = all.concat(combos.map((c) => A.parseBase(c)));
    }
    return all;
  }

  /** The inset table: for each base, hat and eyewear, the largest k in 0.01 steps that meets the rules. Drawn with no inset. */
  function generate() {
    const saved = A.fitTable();
    A.setFitTable({});
    const ring = ringLimit();
    const table = {};
    try {
      for (const base of bases())
        for (const head of [null, ...A.AVATAR_HEADWEAR])
        for (const face of [null, ...A.AVATAR_FACEWEAR]) {
          if (!head && !face) continue;
          // With the bow tie on: the inset holds for the fullest outfit of this key.
          const choice = A.tidy({ ...base, ...(head ? { head } : {}), ...(face ? { face } : {}), neck: "bowtie", trim: "yellow" });
          const list = samples(choice);
          let k = 1;
          while (k > A.FIT.min && fails(list, k, ring).length) k = Math.round((k - 0.01) * 100) / 100;
          if (k < 1) table[A.fitKey(choice)] = k;
        }
    } finally {
      A.setFitTable(saved);
    }
    return table;
  }

  /**
   * With the shipped table applied and drawn: the rules, on every hat and
   * eyewear with the bow tie. `onlyInset` limits it to the outfits the table
   * insets; generating the table already proves the rest at k = 1.
   */
  function verify({ onlyInset = false } = {}) {
    const ring = ringLimit();
    const bad = [];
    let n = 0;
    for (const base of bases())
      for (const head of [null, ...A.AVATAR_HEADWEAR])
        for (const face of [null, ...A.AVATAR_FACEWEAR]) {
          const choice = A.tidy({ ...base, ...(head ? { head } : {}), ...(face ? { face } : {}), neck: "bowtie", trim: "yellow" });
          if (onlyInset && A.fitInset(choice) === 1) continue;
          n += 1;
          // Measured as drawn: the inset is already in the scene, so k = 1 here.
          for (const f of fails(samples(choice), 1, ring)) bad.push(`${A.encodeChoice(choice)}: ${f}`);
        }
    return { n, ring, bad };
  }

  window.ClawtrateFit = { RING_SIZES, ringLimit, draw, outline, extent, bases, generate, verify };
})();
