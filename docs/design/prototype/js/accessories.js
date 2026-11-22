// Accessories for the creatures, and the choice's second version: the addition
// to the shared spec that docs/design/avatar-studio.md, section 4, proposes.
// Not product code. The production change adds these shapes inside the scene
// builders of packages/core/src/avatar.ts; this copy adds them to a finished
// scene from creatures.js, reading the eyes it finds there, so the prototype
// can draw them before the spec changes. The data (lists, anchors, shapes,
// colours) is what the spec would hold.

(function () {
  const C = window.ClawtrateCreatures;

  // The lists -------------------------------------------------------------------------

  /** One accessory per slot. Each slot is optional. */
  const AVATAR_HEADWEAR = ["beanie", "beret", "party", "crown", "headphones"];
  const AVATAR_FACEWEAR = ["glasses", "shades"];
  const AVATAR_NECKWEAR = ["bowtie"];
  const AVATAR_ACCESSORIES = { head: AVATAR_HEADWEAR, face: AVATAR_FACEWEAR, neck: AVATAR_NECKWEAR };
  const SLOTS = ["head", "face", "neck"];

  /**
   * The accessories' colour when the choice names none: a colour from the same
   * eight, never the body's own. Every one of them passes the palette guard,
   * and `shade` keeps a colour's hue, so their darker parts pass it too.
   */
  const AVATAR_TRIM_DEFAULT = {
    green: "violet",
    blue: "yellow",
    orchid: "sky",
    violet: "lime",
    yellow: "blue",
    pink: "sky",
    sky: "pink",
    lime: "violet",
  };
  /** The crown is gold whatever the trim: the palette's yellow, with a darker rim. */
  const AVATAR_GOLD = C.AVATAR_COLORS.yellow;

  const trimOf = (choice) => C.AVATAR_COLORS[choice.trim || AVATAR_TRIM_DEFAULT[choice.color]];
  const wears = (choice) => SLOTS.some((slot) => choice[slot]);

  // Motion ----------------------------------------------------------------------------

  /** A hat lifts and tips on the creature's done hop: the same loop, the same peak. */
  const ACCESSORY_MOTIONS = {
    tip: {
      duration: 3200,
      easing: [0.3, 0, 0.2, 1],
      frames: [
        { at: 0, translate: [0, 0], rotate: 0 },
        { at: 0.05, translate: [0, 0], rotate: 0 },
        { at: 0.11, translate: [0, -1.6], rotate: -12 },
        { at: 0.18, translate: [0, 0], rotate: 0 },
        { at: 1, translate: [0, 0], rotate: 0 },
      ],
    },
  };

  // Anchors, on the 40-unit grid ------------------------------------------------------

  /**
   * Where a hat sits: the middle of its brim, the brim's width, and its tilt.
   * A Clawling with one eye wears its hat on the eye (computed from the eye);
   * a Shellfolk on its shell, which stays put while the critter acts and
   * hides; a Lantern to the left of its crown, clear of the lure.
   */
  const HAT_ANCHORS = {
    clawling: {
      dome: { at: [20, 18], w: 11, tilt: 0 },
      tall: { at: [20, 16.5], w: 10.6, tilt: 0 },
      wide: { at: [20, 22], w: 11.6, tilt: 0 },
      round: { at: [20, 19.5], w: 11, tilt: 0 },
    },
    shellfolk: {
      spiral: { at: [24.6, 9], w: 10, tilt: 4 },
      turret: { at: [30.2, 8.6], w: 7, tilt: 30 },
      dome: { at: [25.2, 13.9], w: 10, tilt: 0 },
      spotted: { at: [24.8, 11.9], w: 10, tilt: 3 },
    },
    lantern: {
      round: { at: [13.7, 16.6], w: 9.2, tilt: -30 },
      bell: { at: [14.4, 16.2], w: 9, tilt: -28 },
      oval: { at: [13.6, 18.4], w: 9.2, tilt: -24 },
      box: { at: [13.6, 16.4], w: 9.4, tilt: -16 },
    },
  };

  /** Headphones on a Lantern: the cups at the body's sides, and the top of the band. */
  const LANTERN_HEADPHONES = {
    round: { left: [8.4, 23.4], right: [31.6, 23.4], apex: 12.2 },
    bell: { left: [8.6, 25.2], right: [31.4, 25.2], apex: 12.4 },
    oval: { left: [7.4, 26.2], right: [32.6, 24.2], apex: 14 },
    box: { left: [8, 24.4], right: [32, 24.4], apex: 13.4 },
  };

  /** A bow tie: its centre and scale, under the mouth. */
  const BOWTIE_ANCHORS = {
    clawling: {
      dome: { at: [20, 31.1], s: 1 },
      tall: { at: [20, 30.6], s: 0.9 },
      wide: { at: [20, 31.7], s: 1 },
      round: { at: [20, 31.6], s: 1 },
    },
    shellfolk: { at: [10.4, 28.6], s: 0.9 },
    lantern: {
      round: { at: [20, 32.9], s: 0.95 },
      bell: { at: [20, 33.3], s: 1 },
      oval: { at: [20.4, 33.8], s: 0.92 },
      box: { at: [20, 32.8], s: 1 },
    },
  };

  // Shapes, in each accessory's own frame ---------------------------------------------

  const r2 = (n) => Math.round(n * 100) / 100;
  const group = (children, extra = {}) => ({ kind: "group", children, ...extra });
  const path = (d, extra = {}) => ({ kind: "path", d, ...extra });
  const circle = (cx, cy, r, extra = {}) => ({ kind: "circle", cx: r2(cx), cy: r2(cy), r: r2(r), ...extra });
  const ball = (cx, cy, r) =>
    circle(cx, cy, r, { fill: C.AVATAR_BALL, stroke: C.AVATAR_BALL_RIM, strokeWidth: 0.5, part: "pom" });

  /** Hats on a 10-unit brim, its middle at 0,0, the crown upward. */
  function hatShapes(name, trim) {
    switch (name) {
      case "beanie":
        return [
          path("M-5 .2C-5.2-4.6-2.6-7 0-7S5.2-4.6 5 .2Z", { fill: trim }),
          path("M-2.6-1.2V-4.6M0-1.2V-6M2.6-1.2V-4.6", {
            stroke: C.shade(trim, 0.22),
            strokeWidth: 0.7,
            round: true,
            fill: "none",
            fine: true,
          }),
          { kind: "rect", x: -5.6, y: -1.5, width: 11.2, height: 3, rx: 1.5, fill: C.shade(trim, 0.18) },
          ball(0, -7.2, 1.7),
        ];
      case "beret":
        return [
          path("M.8-4.3L1.3-6", { stroke: C.shade(trim, 0.2), strokeWidth: 1.3, round: true, fine: true }),
          path("M-5.6.2C-6.6-2.4-3.4-4.6 1-4.4C5.4-4.2 7.4-2 6.2.2C3.4 1.2-2.8 1.2-5.6.2Z", { fill: trim }),
          path("M-5 .3C-2.4.9 3 .9 5.6.3", {
            stroke: C.shade(trim, 0.28),
            strokeWidth: 0.9,
            round: true,
            fill: "none",
            fine: true,
          }),
        ];
      case "party":
        return [
          path("M-4.2.2L0-10.4L4.2.2Q0 1.4-4.2.2Z", { fill: trim, round: true }),
          path("M-2.9-3.3Q0-2.3 2.9-3.3M-1.7-6.6Q0-6 1.7-6.6", {
            stroke: C.AVATAR_BALL,
            strokeWidth: 0.9,
            round: true,
            fill: "none",
            fine: true,
          }),
          ball(0, -10.5, 1.6),
        ];
      case "crown":
        return [
          path("M-4.8.2V-5.2L-2.4-2.6L0-6.4L2.4-2.6L4.8-5.2V.2Q0 1-4.8.2Z", {
            fill: AVATAR_GOLD,
            stroke: C.shade(AVATAR_GOLD, 0.3),
            strokeWidth: 0.6,
            round: true,
          }),
          circle(0, -1.6, 0.95, { fill: C.AVATAR_BALL, fine: true, part: "jewel" }),
        ];
      default:
        return [];
    }
  }

  function hat(name, trim, anchor, state) {
    const s = r2(anchor.w / 10);
    return group(
      [group(hatShapes(name, trim), { transform: `scale(${s})` })],
      {
        transform: `translate(${r2(anchor.at[0])} ${r2(anchor.at[1])}) rotate(${anchor.tilt})`,
        part: `wear-${name}`,
        // The motion turns about the brim's middle, in the creature's own units.
        ...(state === "done" ? { motion: "tip", origin: [r2(anchor.at[0]), r2(anchor.at[1])] } : {}),
      },
    );
  }

  function headphones(trim, left, right, apex) {
    // A cubic whose two handles share one height peaks a quarter of the way
    // from its ends to that height: put the handles where the band tops out at `apex`.
    const ly = left[1] - 2;
    const ry = right[1] - 2;
    const top = r2((apex - 0.125 * (ly + ry)) / 0.75);
    const cup = ([x, y]) => ({ kind: "rect", x: r2(x - 1.6), y: r2(y - 2.6), width: 3.2, height: 5.2, rx: 1.6, fill: trim });
    return group(
      [
        path(`M${r2(left[0])} ${r2(ly)}C${r2(left[0])} ${top} ${r2(right[0])} ${top} ${r2(right[0])} ${r2(ry)}`, {
          stroke: C.shade(trim, 0.3),
          strokeWidth: 1.5,
          round: true,
          fill: "none",
        }),
        cup(left),
        cup(right),
      ],
      { part: "wear-headphones" },
    );
  }

  /** What goes inside one eye's own group: a ring for glasses, a lens for shades. */
  function lens(name, trim, k) {
    if (name === "glasses")
      return group([circle(0, 0, 3.75 * k, { fill: "none", stroke: trim, strokeWidth: 1.05 })], {
        fine: true,
        part: "wear-glasses",
      });
    const r = 3.55 * k;
    const top = r2(-0.75 * k);
    return group(
      [
        path(`M${r2(-r)} ${top}H${r2(r)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(-r)} ${top}Z`, {
          fill: C.AVATAR_INK,
          stroke: trim,
          strokeWidth: 0.85,
          round: true,
        }),
        path(`M${r2(-1.9 * k)} ${r2(0.5 * k)}L${r2(-0.9 * k)} ${r2(1.5 * k)}`, {
          stroke: C.AVATAR_WHITE,
          strokeWidth: 0.6,
          round: true,
          opacity: 0.7,
          fine: true,
        }),
      ],
      { part: "wear-shades" },
    );
  }

  function bowtie(trim, anchor) {
    return group(
      [
        path(
          "M-.9-.7L-3.6-2.3Q-4.3-2.5-4.3-1.8V1.8Q-4.3 2.5-3.6 2.3L-.9.7ZM.9-.7L3.6-2.3Q4.3-2.5 4.3-1.8V1.8Q4.3 2.5 3.6 2.3L.9.7Z",
          { fill: trim, stroke: trim, strokeWidth: 0.5, round: true },
        ),
        { kind: "rect", x: -1.2, y: -1.2, width: 2.4, height: 2.4, rx: 0.9, fill: C.shade(trim, 0.22) },
      ],
      {
        transform: `translate(${anchor.at[0]} ${anchor.at[1]}) scale(${anchor.s})`,
        part: "wear-bowtie",
      },
    );
  }

  // Reading a scene -------------------------------------------------------------------

  /** An eye group's centre, scale and size, from its transform and its white. */
  function eyeInfo(shape) {
    const m = /translate\(([-\d.]+) ([-\d.]+)\)(?: scale\(([\d.]+)\))?/.exec(shape.transform || "");
    const white = shape.children.find((c) => c.kind === "circle" && c.fill === C.AVATAR_WHITE);
    return {
      x: Number(m[1]),
      y: Number(m[2]),
      scale: m[3] ? Number(m[3]) : 1,
      k: white ? white.r / 3.1 : 1,
    };
  }

  const isEye = (shape) => shape.kind === "group" && shape.part === "eye";

  /** The group that holds the eyes, depth first. */
  function eyeParent(shape) {
    if (shape.kind !== "group") return null;
    if (shape.children.some(isEye)) return shape;
    for (const child of shape.children) {
      const found = eyeParent(child);
      if (found) return found;
    }
    return null;
  }

  function findPart(shape, part) {
    if (shape.part === part) return shape;
    if (shape.kind !== "group") return null;
    for (const child of shape.children) {
      const found = findPart(child, part);
      if (found) return found;
    }
    return null;
  }

  const clone = (shape) => JSON.parse(JSON.stringify(shape));

  /** Glasses and shades in each eye, and their bridge between two eyes. */
  function addFacewear(parent, name, trim) {
    const eyes = parent.children.filter(isEye);
    for (const eye of eyes) eye.children.push(lens(name, trim, eyeInfo(eye).k));
    if (eyes.length !== 2) return;
    const [a, b] = eyes.map(eyeInfo).sort((p, q) => p.x - q.x);
    const ra = (name === "glasses" ? 3.75 : 3.55) * a.k * a.scale;
    const rb = (name === "glasses" ? 3.75 : 3.55) * b.k * b.scale;
    const from = [a.x + ra, a.y - (name === "shades" ? 0.2 : 0)];
    const to = [b.x - rb, b.y - (name === "shades" ? 0.2 : 0)];
    if (to[0] - from[0] < 0.6) return; // the rims already meet
    const mid = [(from[0] + to[0]) / 2, Math.min(from[1], to[1]) - 1.1];
    const bridge = path(
      `M${r2(from[0])} ${r2(from[1])}Q${r2(mid[0])} ${r2(mid[1])} ${r2(to[0])} ${r2(to[1])}`,
      { stroke: trim, strokeWidth: 1, round: true, fill: "none", fine: true, part: "wear-bridge" },
    );
    const last = parent.children.lastIndexOf(eyes[eyes.length - 1]);
    parent.children.splice(last + 1, 0, bridge);
  }

  /**
   * The scene with the choice's accessories added. `scene` comes from
   * `avatarScene`; the result is drawn the same way.
   */
  function accessorize(scene, choice) {
    if (!wears(choice)) return scene;
    const out = { ...scene, root: clone(scene.root) };
    const root = out.root;
    const state = scene.state;
    const trim = trimOf(choice);
    const family = choice.family;
    const hiding = family === "shellfolk" && state === "blocked";
    const eyesAt = eyeParent(root);

    if (choice.face && eyesAt) addFacewear(eyesAt, choice.face, trim);

    if (choice.head === "headphones" && !hiding) {
      if (family === "lantern") {
        const a = LANTERN_HEADPHONES[choice.body];
        const at = root.children.findIndex((c) => c.part === "body");
        root.children.splice(at + 1, 0, headphones(trim, a.left, a.right, a.apex));
      } else if (eyesAt) {
        const eyes = eyesAt.children.filter(isEye).map(eyeInfo).sort((p, q) => p.x - q.x);
        const first = eyes[0];
        const last = eyes[eyes.length - 1];
        const reach = (e) => 4.35 * e.k * e.scale + 1.2;
        const apex = Math.min(...eyes.map((e) => e.y - reach(e))) - 1.6;
        const band = headphones(trim, [first.x - reach(first), first.y], [last.x + reach(last), last.y], apex);
        const at = eyesAt.children.findIndex(isEye);
        eyesAt.children.splice(at, 0, band);
      }
    } else if (choice.head && choice.head !== "headphones") {
      let anchor;
      const parent = root;
      let at = root.children.length;
      if (family === "clawling") {
        if (choice.eyes === "single" && eyesAt) {
          const e = eyeInfo(eyesAt.children.find(isEye));
          anchor = { at: [e.x, e.y - 4.35 * e.k * e.scale + 0.5], w: 8, tilt: 0 };
          at = root.children.length;
        } else {
          anchor = HAT_ANCHORS.clawling[choice.body];
          at = root.children.findIndex((c) => c.part === "body") + 1;
        }
      } else if (family === "shellfolk") {
        anchor = HAT_ANCHORS.shellfolk[choice.shell];
        // On the shell: after the shell's own shapes, before the opening it hides in.
        const opening = root.children.findIndex((c) => c.part === "opening");
        at = opening >= 0 ? opening : root.children.length;
      } else {
        anchor = HAT_ANCHORS.lantern[choice.body];
        at = root.children.findIndex((c) => c.part === "body") + 1;
      }
      parent.children.splice(at, 0, hat(choice.head, trim, anchor, state));
    }

    if (choice.neck && !hiding) {
      if (family === "shellfolk") {
        const neck = findPart(root, "neck");
        neck.children.splice(1, 0, bowtie(trim, BOWTIE_ANCHORS.shellfolk));
      } else {
        const anchor = BOWTIE_ANCHORS[family][choice.body];
        const at = root.children.findIndex((c) => c.part === "mouth");
        root.children.splice(at >= 0 ? at + 1 : root.children.length, 0, bowtie(trim, anchor));
      }
    }
    return out;
  }

  // The choice's text form, version 2 -------------------------------------------------

  const oneOf = (list, value) => typeof value === "string" && list.includes(value);

  /**
   * Version 1 when nothing is worn, exactly as today, so an older Clawtrate
   * still draws the creature; version 2 when anything is. The trim is written
   * whenever something is worn, so a reader never has to know the default.
   */
  function encodeChoice(choice) {
    const base = C.encodeAvatarChoice(choice);
    if (!wears(choice)) return base;
    const fields = [base.replace(/^v=1/, "v=2")];
    for (const slot of SLOTS) if (choice[slot]) fields.push(`${slot}=${choice[slot]}`);
    fields.push(`trim=${choice.trim || AVATAR_TRIM_DEFAULT[choice.color]}`);
    return fields.join("&");
  }

  /** Untrusted input to a choice: the family's fields, and any of head, face, neck and trim. */
  function parseChoice(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const rest = {};
    const worn = {};
    for (const [key, value] of Object.entries(input)) {
      if (SLOTS.includes(key)) {
        if (value === null || value === undefined || value === "none") continue;
        if (!oneOf(AVATAR_ACCESSORIES[key], value)) return null;
        worn[key] = value;
      } else if (key === "trim") {
        if (value === null || value === undefined) continue;
        if (!oneOf(C.AVATAR_COLOR_NAMES, value)) return null;
        worn.trim = value;
      } else rest[key] = value;
    }
    const base = C.parseAvatarChoice(rest);
    if (!base) return null;
    // A trim with nothing to colour is dropped, not refused.
    if (!SLOTS.some((slot) => worn[slot])) return base;
    return { ...base, ...worn };
  }

  /** The text form back to a choice: version 1 or 2; anything else is null. */
  function decodeChoice(text) {
    if (typeof text !== "string" || text.length > 200) return null;
    if (text.startsWith("v=1&")) return C.decodeAvatarChoice(text);
    if (!text.startsWith("v=2&")) return null;
    const fields = {};
    for (const pair of text.slice(4).split("&")) {
      const at = pair.indexOf("=");
      if (at <= 0) return null;
      fields[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const choice = parseChoice(fields);
    return choice && wears(choice) ? choice : null;
  }

  window.ClawtrateAccessories = {
    AVATAR_HEADWEAR,
    AVATAR_FACEWEAR,
    AVATAR_NECKWEAR,
    AVATAR_ACCESSORIES,
    AVATAR_TRIM_DEFAULT,
    AVATAR_GOLD,
    ACCESSORY_MOTIONS,
    HAT_ANCHORS,
    LANTERN_HEADPHONES,
    BOWTIE_ANCHORS,
    SLOTS,
    trimOf,
    wears,
    accessorize,
    encodeChoice,
    decodeChoice,
    parseChoice,
  };
})();
