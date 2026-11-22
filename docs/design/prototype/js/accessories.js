// Accessories for the creatures, the choice's second version, the bounded
// reply from Describe a Claw, and a Claw from a bot's name: the addition to the
// shared spec that docs/design/avatar-studio.md, sections 2, 4, 5 and 7, proposes.
// Not product code. In the product each family's scene builder returns typed
// sockets (position, scale, tilt and layer) and draws the accessories itself.
// creatures.js is generated from the spec and has no sockets yet, so
// `sceneSockets` below stands in for them: it is the one place that reads a
// finished scene (where the eyes ended up), and everything after it works
// from the typed sockets alone.

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

  const trimName = (choice) => choice.trim || AVATAR_TRIM_DEFAULT[choice.color];
  const trimOf = (choice) => C.AVATAR_COLORS[trimName(choice)];
  const wears = (choice) => SLOTS.some((slot) => choice[slot]);
  /** A crown and nothing else: nothing takes the trim, so the studio offers none. */
  const onlyCrown = (choice) => choice.head === "crown" && !choice.face && !choice.neck;

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
  const TIP_PEAK = { translate: [0, -1.6], rotate: -12 };

  /** Each state's whole-body motion at its extremes (creatures.js `rootFor`), about the feet. */
  const ROOT_ORIGIN = [20, 35];
  function rootPeaks(family, state) {
    const still = state === "blocked" ? [{ rotate: 6 }] : [{}];
    if (state === "thinking" && family === "clawling") return [...still, { rotate: -4 }, { rotate: 4 }];
    if (state === "working") return [...still, family === "shellfolk" ? { translate: [-1, -0.6] } : { translate: [0, -1.4] }];
    if (state === "waiting") return [...still, { scale: 1.07 }];
    if (state === "done") return [...still, { translate: [0, -2.8] }];
    return still;
  }

  // Sockets, on the 40-unit grid ------------------------------------------------------

  /**
   * A socket is `{ x, y, scale, tilt, layer }`: where an accessory's own origin
   * goes, how large it is, its turn in degrees, and where in the scene it is
   * drawn (`layer`, one of LAYERS). Hats are drawn on a 10-unit brim, so a
   * hat's `scale` is its brim width / 10.
   */
  const LAYERS = ["after-body", "before-opening", "on-top", "before-eyes", "in-eye", "after-mouth", "in-neck"];

  /** Hats: on a two-eyed Clawling's body, on a Shellfolk's shell, left of a Lantern's crown. */
  const HEAD_SOCKETS = {
    clawling: {
      dome: { x: 20, y: 18, scale: 1.1, tilt: 0, layer: "after-body" },
      tall: { x: 20, y: 16.5, scale: 1.06, tilt: 0, layer: "after-body" },
      wide: { x: 20, y: 22, scale: 1.16, tilt: 0, layer: "after-body" },
      round: { x: 20, y: 19.5, scale: 1.1, tilt: 0, layer: "after-body" },
    },
    shellfolk: {
      spiral: { x: 24.6, y: 9, scale: 1, tilt: 4, layer: "before-opening" },
      turret: { x: 30.2, y: 8.6, scale: 0.7, tilt: 30, layer: "before-opening" },
      dome: { x: 25.2, y: 13.9, scale: 1, tilt: 0, layer: "before-opening" },
      spotted: { x: 24.8, y: 11.9, scale: 1, tilt: 3, layer: "before-opening" },
    },
    lantern: {
      round: { x: 13.4, y: 17, scale: 0.9, tilt: -32, layer: "after-body" },
      bell: { x: 13.9, y: 17, scale: 0.86, tilt: -32, layer: "after-body" },
      oval: { x: 13.4, y: 18.8, scale: 0.9, tilt: -26, layer: "after-body" },
      box: { x: 13.4, y: 16.8, scale: 0.92, tilt: -18, layer: "after-body" },
    },
  };
  /**
   * Blocked, a Lantern's lure droops to its left, where its hat sits: the hat
   * slips down the body's side, clear of the dimmed ball.
   */
  const LANTERN_BLOCKED_SLIP = { dx: -2.4, dy: 3.2, tilt: -30 };
  /** A one-eyed Clawling wears its hat on the eye: on the socket's rim, 8 units wide, riding the stalk. */
  const EYE_HAT = { lift: 0.5, scale: 0.8 };

  /** Headphones on a Lantern: the cups at the body's sides, and the top of the band. */
  const LANTERN_HEADPHONES = {
    round: { left: [8.4, 23.4], right: [31.6, 23.4], apex: 12.2 },
    bell: { left: [8.6, 25.2], right: [31.4, 25.2], apex: 12.4 },
    oval: { left: [7.4, 26.2], right: [32.6, 24.2], apex: 14 },
    box: { left: [8, 24.4], right: [32, 24.4], apex: 13.4 },
  };

  /**
   * The bow tie, below the lowest mouth any state draws (the open waiting
   * mouth reaches the mouth line + 2.8), so it never covers a mouth. One
   * place in every state: it doesn't jump when the state changes.
   */
  const NECK_SOCKETS = {
    clawling: {
      dome: { x: 20, y: 32.8, scale: 0.85, tilt: 0, layer: "after-mouth" },
      tall: { x: 20, y: 31.8, scale: 0.8, tilt: 0, layer: "after-mouth" },
      wide: { x: 20, y: 33.6, scale: 0.85, tilt: 0, layer: "after-mouth" },
      round: { x: 20, y: 32.8, scale: 0.85, tilt: 0, layer: "after-mouth" },
    },
    shellfolk: { x: 10.4, y: 28.6, scale: 0.9, tilt: 0, layer: "in-neck" },
    lantern: {
      round: { x: 20, y: 34.4, scale: 0.85, tilt: 0, layer: "after-mouth" },
      bell: { x: 20, y: 35, scale: 0.85, tilt: 0, layer: "after-mouth" },
      oval: { x: 20.3, y: 35.6, scale: 0.8, tilt: 0, layer: "after-mouth" },
      box: { x: 20, y: 34.8, scale: 0.85, tilt: 0, layer: "after-mouth" },
    },
  };

  /**
   * Where a hat reaches in its own frame: the points of its outline, used to
   * fit the equipped Claw inside the circle (`fitInset`).
   */
  const HAT_OUTLINE = {
    beanie: [[-5.8, -1.7], [5.8, -1.7], [-5.8, 1.7], [5.8, 1.7], [-4.7, -3.8], [4.7, -3.8], [0, -7.95], [-1.7, -6.3], [1.7, -6.3]],
    beret: [[-6.7, -1.1], [6.6, -0.2], [-3.6, -4.6], [1.2, -4.7], [5, -3.4], [1.5, -6.4], [-5.8, 0.8], [6.3, 0.8]],
    party: [[-4.3, 0.5], [4.3, 0.5], [0, -10.2], [-1.6, -8.7], [1.6, -8.7], [-2.2, -4.6], [2.2, -4.6]],
    crown: [[-5.1, 0.6], [5.1, 0.6], [-5.1, -5.5], [5.1, -5.5], [0, -6.8]],
  };

  /** The circle a still Claw must stay inside (the saved picture is cropped to it), and the live limit inside the ring. */
  const FIT = { centre: [20, 20], still: 19.6, live: 22.4, pivot: [20, 36], min: 0.7 };

  // Shapes, in each accessory's own frame ---------------------------------------------

  const r2 = (n) => Math.round(n * 100) / 100;
  const group = (children, extra = {}) => ({ kind: "group", children, ...extra });
  const path = (d, extra = {}) => ({ kind: "path", d, ...extra });
  const circle = (cx, cy, r, extra = {}) => ({ kind: "circle", cx: r2(cx), cy: r2(cy), r: r2(r), ...extra });
  const ball = (cx, cy, r) =>
    circle(cx, cy, r, { fill: C.AVATAR_BALL, stroke: C.AVATAR_BALL_RIM, strokeWidth: 0.5, part: "pom" });
  /** A silhouette's edge: a darker shade of its own colour, so it holds against a body of the same colour. */
  const edge = (trim) => ({ stroke: C.shade(trim, 0.38), strokeWidth: 0.5, round: true });

  /** Hats on a 10-unit brim, its middle at 0,0, the crown upward. */
  function hatShapes(name, trim) {
    switch (name) {
      case "beanie":
        return [
          path("M-5 .2C-5.2-3.9-2.6-6 0-6S5.2-3.9 5 .2Z", { fill: trim, ...edge(trim) }),
          path("M-2.6-1.2V-4.1M0-1.2V-5.2M2.6-1.2V-4.1", {
            stroke: C.shade(trim, 0.22),
            strokeWidth: 0.7,
            round: true,
            fill: "none",
            fine: true,
          }),
          { kind: "rect", x: -5.6, y: -1.5, width: 11.2, height: 3, rx: 1.5, fill: C.shade(trim, 0.18), ...edge(trim) },
          ball(0, -6.2, 1.5),
        ];
      case "beret":
        return [
          path("M.8-4.3L1.3-6", { stroke: C.shade(trim, 0.2), strokeWidth: 1.3, round: true, fine: true }),
          path("M-5.6.2C-6.6-2.4-3.4-4.6 1-4.4C5.4-4.2 7.4-2 6.2.2C3.4 1.2-2.8 1.2-5.6.2Z", { fill: trim, ...edge(trim) }),
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
          path("M-4 .2L0-8.6L4 .2Q0 1.3-4 .2Z", { fill: trim, ...edge(trim) }),
          path("M-2.7-2.8Q0-1.9 2.7-2.8M-1.6-5.6Q0-5 1.6-5.6", {
            stroke: C.AVATAR_BALL,
            strokeWidth: 0.9,
            round: true,
            fill: "none",
            fine: true,
          }),
          ball(0, -8.7, 1.4),
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

  /**
   * A hat at its socket. Three groups: the socket's place and turn, then the
   * motion about the brim's own middle (0,0), then the brim's scale.
   */
  function hat(name, trim, socket, state) {
    const scaled = group(hatShapes(name, trim), { transform: `scale(${r2(socket.scale)})` });
    const moving = group([scaled], state === "done" ? { motion: "tip", origin: [0, 0], part: "hat-motion" } : { part: "hat-motion" });
    return group([moving], {
      transform: `translate(${r2(socket.x)} ${r2(socket.y)}) rotate(${socket.tilt})`,
      part: `wear-${name}`,
    });
  }

  function headphones(trim, band) {
    // A cubic whose two handles share one height peaks a quarter of the way
    // from its ends to that height: put the handles where the band tops out at `apex`.
    const { left, right, apex } = band;
    const ly = left[1] - 2;
    const ry = right[1] - 2;
    const top = r2((apex - 0.125 * (ly + ry)) / 0.75);
    const cup = ([x, y]) => ({ kind: "rect", x: r2(x - 1.6), y: r2(y - 2.6), width: 3.2, height: 5.2, rx: 1.6, fill: trim, ...edge(trim) });
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

  /**
   * What goes inside one eye's own group: a ring for glasses, a lens for
   * shades. `ring` is the ring's radius in the eye's units, already fitted to
   * the room between the eyes. Thinking, working, blocked and done carry their
   * look in the lids and the happy eye, so there the lens sits lower and lets
   * the eye through.
   */
  function lens(name, trim, k, ring, state) {
    if (name === "glasses")
      return group([circle(0, 0, ring, { fill: "none", stroke: trim, strokeWidth: 1.05 })], {
        fine: true,
        part: "wear-glasses",
      });
    const r = 3.55 * k;
    const showing = ["thinking", "working", "blocked", "done"].includes(state);
    const top = r2((showing ? 0.6 : -0.75) * k);
    const half = Math.sqrt(Math.max(r * r - top * top, 0));
    return group(
      [
        path(`M${r2(-half)} ${top}H${r2(half)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(-half)} ${top}Z`, {
          fill: C.AVATAR_INK,
          ...(showing ? { opacity: 0.72 } : {}),
          stroke: trim,
          strokeWidth: 0.85,
          round: true,
        }),
        path(`M${r2(-1.9 * k)} ${r2(Math.max(0.5, top + 0.9) * k)}L${r2(-0.9 * k)} ${r2(Math.max(1.5, top + 1.9) * k)}`, {
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

  function bowtie(trim, socket) {
    return group(
      [
        path(
          "M-.9-.7L-3.6-2.3Q-4.3-2.5-4.3-1.8V1.8Q-4.3 2.5-3.6 2.3L-.9.7ZM.9-.7L3.6-2.3Q4.3-2.5 4.3-1.8V1.8Q4.3 2.5 3.6 2.3L.9.7Z",
          { fill: trim, ...edge(trim) },
        ),
        { kind: "rect", x: -1.2, y: -1.2, width: 2.4, height: 2.4, rx: 0.9, fill: C.shade(trim, 0.22) },
      ],
      {
        transform: `translate(${r2(socket.x)} ${r2(socket.y)}) scale(${r2(socket.scale)})`,
        part: "wear-bowtie",
      },
    );
  }

  // Sockets for a scene ------------------------------------------------------------------

  const isEye = (shape) => shape.kind === "group" && shape.part === "eye";

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

  /**
   * The stand-in for the builders' sockets: where each eye ended up. The eye
   * builder places an eye with `translate(x y) scale(s)`; this reads that once.
   * In the product the builder returns `{ x, y, scale, k }` for each eye.
   */
  function eyePlacement(shape) {
    const m = /translate\(([-\d.]+) ([-\d.]+)\)(?: scale\(([\d.]+)\))?/.exec(shape.transform || "");
    const white = shape.children.find((c) => c.kind === "circle" && c.fill === C.AVATAR_WHITE);
    return { x: Number(m[1]), y: Number(m[2]), scale: m[3] ? Number(m[3]) : 1, k: white ? white.r / 3.1 : 1, shape };
  }

  /** Every socket of a scene, typed. Production: returned by the family's scene builder. */
  function sceneSockets(choice, scene) {
    const family = choice.family;
    const state = scene.state;
    const eyesAt = eyeParent(scene.root);
    const eyes = eyesAt ? eyesAt.children.filter(isEye).map(eyePlacement).sort((p, q) => p.x - q.x) : [];
    const sockets = { eyes, head: null, band: null, neck: null };

    // Hats.
    if (family === "clawling" && choice.eyes === "single" && eyes[0]) {
      const e = eyes[0];
      sockets.head = { x: e.x, y: e.y - 4.35 * e.k * e.scale + EYE_HAT.lift, scale: EYE_HAT.scale, tilt: 0, layer: "on-top" };
    } else if (family === "clawling") sockets.head = HEAD_SOCKETS.clawling[choice.body];
    else if (family === "shellfolk") sockets.head = HEAD_SOCKETS.shellfolk[choice.shell];
    else {
      const seat = HEAD_SOCKETS.lantern[choice.body];
      const slip = state === "blocked" ? LANTERN_BLOCKED_SLIP : { dx: 0, dy: 0, tilt: 0 };
      sockets.head = { ...seat, x: seat.x + slip.dx, y: seat.y + slip.dy, tilt: seat.tilt + slip.tilt };
    }

    // Headphones' band: from the eyes on a Clawling or a Shellfolk, from the body on a Lantern.
    if (family === "lantern") sockets.band = { ...LANTERN_HEADPHONES[choice.body], layer: "after-body" };
    else if (eyes.length) {
      const reach = (e) => 4.35 * e.k * e.scale + 1.2;
      const first = eyes[0];
      const last = eyes[eyes.length - 1];
      sockets.band = {
        left: [first.x - reach(first), first.y],
        right: [last.x + reach(last), last.y],
        apex: Math.min(...eyes.map((e) => e.y - reach(e))) - 1.6,
        layer: "before-eyes",
      };
    }

    // Glasses: each ring as large as the room between the eyes allows.
    const gap = eyes.length === 2 ? eyes[1].x - eyes[0].x : Infinity;
    sockets.rings = eyes.map((e) => Math.min(3.75 * e.k, (gap / 2 - 0.6) / e.scale));

    sockets.neck = family === "shellfolk" ? NECK_SOCKETS.shellfolk : NECK_SOCKETS[family][choice.body];
    return sockets;
  }

  /** Put a shape at a socket's layer. */
  function place(root, layer, shape) {
    const at = (part) => root.children.findIndex((c) => c.part === part);
    if (layer === "after-body") root.children.splice(at("body") + 1, 0, shape);
    else if (layer === "before-opening") {
      const opening = at("opening");
      root.children.splice(opening >= 0 ? opening : root.children.length, 0, shape);
    } else if (layer === "on-top") root.children.push(shape);
    else if (layer === "before-eyes") {
      const parent = eyeParent(root);
      parent.children.splice(parent.children.findIndex(isEye), 0, shape);
    } else if (layer === "after-mouth") {
      const mouth = at("mouth");
      root.children.splice(mouth >= 0 ? mouth + 1 : root.children.length, 0, shape);
    } else if (layer === "in-neck") findPart(root, "neck").children.splice(1, 0, shape);
    else if (layer === "in-eye") {
      const parent = eyeParent(root);
      const eyes = parent.children.filter(isEye);
      eyes.forEach((eye, i) => eye.children.push(shape(i)));
    }
  }

  /** Glasses' bridge between two eyes, unless the rims already meet. */
  function bridge(name, trim, sockets) {
    if (sockets.eyes.length !== 2) return null;
    const [a, b] = sockets.eyes;
    const ra = (name === "glasses" ? sockets.rings[0] : 3.55 * a.k) * a.scale;
    const rb = (name === "glasses" ? sockets.rings[1] : 3.55 * b.k) * b.scale;
    const drop = name === "shades" ? 0.2 : 0;
    const from = [a.x + ra, a.y - drop];
    const to = [b.x - rb, b.y - drop];
    if (to[0] - from[0] < 0.6) return null;
    const mid = [(from[0] + to[0]) / 2, Math.min(from[1], to[1]) - 1.1];
    return path(`M${r2(from[0])} ${r2(from[1])}Q${r2(mid[0])} ${r2(mid[1])} ${r2(to[0])} ${r2(to[1])}`, {
      stroke: trim,
      strokeWidth: 1,
      round: true,
      fill: "none",
      fine: true,
      part: "wear-bridge",
    });
  }

  // Fitting the equipped Claw in its circle ----------------------------------------------

  const rotateAbout = ([x, y], [ox, oy], deg) => {
    const a = (deg * Math.PI) / 180;
    const dx = x - ox;
    const dy = y - oy;
    return [ox + dx * Math.cos(a) - dy * Math.sin(a), oy + dx * Math.sin(a) + dy * Math.cos(a)];
  };
  const applyRoot = (p, m) => {
    let q = p;
    if (m.scale) q = [ROOT_ORIGIN[0] + (q[0] - ROOT_ORIGIN[0]) * m.scale, ROOT_ORIGIN[1] + (q[1] - ROOT_ORIGIN[1]) * m.scale];
    if (m.rotate) q = rotateAbout(q, ROOT_ORIGIN, m.rotate);
    if (m.translate) q = [q[0] + m.translate[0], q[1] + m.translate[1]];
    return q;
  };

  /** The head accessory's outline in the scene, seated and (in done) at the tip's peak. */
  function headOutline(choice, sockets, state) {
    if (choice.head === "headphones") {
      const b = sockets.band;
      if (!b) return { seated: [], peak: [] };
      const pts = [b.left, b.right].flatMap(([x, y]) => [[x - 2.1, y - 3.1], [x + 2.1, y - 3.1], [x - 2.1, y + 3.1], [x + 2.1, y + 3.1]]);
      pts.push([(b.left[0] + b.right[0]) / 2, b.apex - 0.75]);
      return { seated: pts, peak: [] };
    }
    const s = sockets.head;
    const local = HAT_OUTLINE[choice.head].map(([x, y]) => [x * s.scale, y * s.scale]);
    const out = (pts) => pts.map((q) => rotateAbout([s.x + q[0], s.y + q[1]], [s.x, s.y], s.tilt));
    const seated = out(local);
    if (state !== "done") return { seated, peak: [] };
    const tipped = local.map((q) => {
      const r = rotateAbout(q, [0, 0], TIP_PEAK.rotate);
      return [r[0] + TIP_PEAK.translate[0], r[1] + TIP_PEAK.translate[1]];
    });
    return { seated, peak: out(tipped) };
  }

  const fitCache = new Map();

  /**
   * How much the equipped Claw is drawn smaller, about its feet, so its head
   * accessory stays inside the circle in every still pose (the saved picture
   * is cropped to it) and inside the Presence ring at every motion's peak.
   * 1 when it already fits. The same in every state, so the Claw doesn't
   * change size between states. In the product: a table generated from the
   * builders and checked by a test.
   */
  function fitInset(choice) {
    if (!choice.head) return 1;
    const key = [choice.family, ...Object.keys(C.AVATAR_PARTS[choice.family]).map((k) => choice[k]), choice.head].join(":");
    if (fitCache.has(key)) return fitCache.get(key);
    const stillPts = [];
    const livePts = [];
    for (const state of C.AVATAR_STATES) {
      if (choice.family === "shellfolk" && state === "blocked" && choice.head === "headphones") continue;
      const scene = C.avatarScene(choice, state, { gaze: [0, 0.25], blink: 0 });
      const sockets = sceneSockets(choice, scene);
      const { seated, peak } = headOutline(choice, sockets, state);
      const peaks = rootPeaks(choice.family, state);
      for (const p of seated) stillPts.push(applyRoot(p, peaks[0]));
      for (const m of peaks) for (const p of [...seated, ...peak]) livePts.push(applyRoot(p, m));
    }
    const dist = (p, k) => {
      const q = [FIT.pivot[0] + (p[0] - FIT.pivot[0]) * k, FIT.pivot[1] + (p[1] - FIT.pivot[1]) * k];
      return Math.hypot(q[0] - FIT.centre[0], q[1] - FIT.centre[1]);
    };
    let k = 1;
    while (k > FIT.min && (stillPts.some((p) => dist(p, k) > FIT.still) || livePts.some((p) => dist(p, k) > FIT.live))) k = r2(k - 0.01);
    fitCache.set(key, k);
    return k;
  }

  // Dressing a scene ---------------------------------------------------------------------

  const clone = (shape) => JSON.parse(JSON.stringify(shape));

  /**
   * The scene with the choice's accessories added at its sockets, inset to
   * fit its circle when its hat needs it. `scene` comes from `avatarScene`;
   * the result is drawn the same way, live and in the saved picture.
   */
  function accessorize(scene, choice) {
    if (!wears(choice)) return scene;
    const root = clone(scene.root);
    const out = { ...scene, root };
    const state = scene.state;
    const trim = trimOf(choice);
    const family = choice.family;
    const hiding = family === "shellfolk" && state === "blocked";
    const sockets = sceneSockets(choice, { ...scene, root });

    if (choice.face && sockets.eyes.length) {
      const b = bridge(choice.face, trim, sockets);
      place(root, "in-eye", (i) => lens(choice.face, trim, sockets.eyes[i].k, sockets.rings[i], state));
      if (b) {
        const parent = eyeParent(root);
        const last = parent.children.map(isEye).lastIndexOf(true);
        parent.children.splice(last + 1, 0, b);
      }
    }
    if (choice.head === "headphones" && !hiding && sockets.band) place(root, sockets.band.layer, headphones(trim, sockets.band));
    else if (choice.head && choice.head !== "headphones") place(root, sockets.head.layer, hat(choice.head, trim, sockets.head, state));
    if (choice.neck && !hiding) place(root, sockets.neck.layer, bowtie(trim, sockets.neck));

    const k = fitInset(choice);
    if (k < 1) {
      const [px, py] = FIT.pivot;
      out.root = group([root], { transform: `translate(${r2(px * (1 - k))} ${r2(py * (1 - k))}) scale(${k})`, part: "fit" });
    }
    return out;
  }

  // The choice's text form, version 2 -------------------------------------------------

  const oneOf = (list, value) => typeof value === "string" && list.includes(value);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const alt = (list) => `(?:${list.join("|")})`;
  const COLOR = alt(C.AVATAR_COLOR_NAMES);

  /**
   * The exact grammar of version 2: the family's own fields in their order,
   * then any of head, face and neck in that order, then trim, always. At least
   * one of head, face or neck. Nothing else: no repeats, extras, empties,
   * `none`, spaces, escapes, other case or bytes outside ASCII.
   */
  const V2_GRAMMAR = new RegExp(
    "^v=2&(?:" +
      [
        `family=clawling&body=${alt(C.CLAWLING_BODIES)}&eyes=${alt(C.CLAWLING_EYES)}&claws=${alt(C.CLAWLING_CLAWS)}&color=${COLOR}`,
        `family=shellfolk&shell=${alt(C.SHELLFOLK_SHELLS)}&color=${COLOR}`,
        `family=lantern&body=${alt(C.LANTERN_BODIES)}&lure=${alt(C.LANTERN_LURES)}&eyes=${alt(C.LANTERN_EYES)}&color=${COLOR}`,
      ].join("|") +
      `)(?:&head=${alt(AVATAR_HEADWEAR)})?(?:&face=${alt(AVATAR_FACEWEAR)})?(?:&neck=bowtie)?&trim=${COLOR}$`,
  );

  /**
   * The text a choice is kept as. Version 1, exactly as today, when nothing is
   * worn; version 2 when anything is, with the trim always written.
   */
  function encodeChoice(choice) {
    const base = C.encodeAvatarChoice(choice);
    if (!wears(choice)) return base;
    const fields = [base.replace(/^v=1/, "v=2")];
    for (const slot of SLOTS) if (choice[slot]) fields.push(`${slot}=${choice[slot]}`);
    fields.push(`trim=${trimName(choice)}`);
    return fields.join("&");
  }

  /** A version 2 text back to a fresh choice, or null unless it matches the grammar exactly. */
  function decodeV2(text) {
    if (typeof text !== "string" || text.length > 200 || !V2_GRAMMAR.test(text)) return null;
    const fields = text.slice(4).split("&").map((pair) => pair.split("="));
    if (!fields.some(([key]) => SLOTS.includes(key))) return null;
    const choice = {};
    for (const [key, value] of fields) choice[key] = value;
    return choice;
  }

  /**
   * A choice from untrusted input that is already a choice, such as a bot's
   * `clawtrate_avatar_propose` call: the family's own fields exactly, and any
   * of head, face, neck and trim from their lists. Own keys only; anything
   * else, `none` and null included, refuses the whole input. A trim needs
   * something to colour. The result is a fresh object.
   */
  function parseChoice(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const base = Object.create(null);
    const worn = {};
    for (const key of Object.keys(input)) {
      const value = input[key];
      if (SLOTS.includes(key)) {
        if (!oneOf(AVATAR_ACCESSORIES[key], value)) return null;
        worn[key] = value;
      } else if (key === "trim") {
        if (!oneOf(C.AVATAR_COLOR_NAMES, value)) return null;
        worn.trim = value;
      } else base[key] = value;
    }
    const parsed = strictBase(base);
    if (!parsed) return null;
    if (worn.trim && !SLOTS.some((slot) => worn[slot])) return null;
    const out = { ...parsed };
    for (const slot of SLOTS) if (worn[slot]) out[slot] = worn[slot];
    if (worn.trim) out.trim = worn.trim;
    return out;
  }

  /** The family's own fields, exactly: #300's strict `parseAvatarChoice`. */
  function strictBase(value) {
    const family = own(value, "family") ? value.family : undefined;
    const color = own(value, "color") ? value.color : undefined;
    if (!oneOf(C.AVATAR_FAMILIES, family) || !oneOf(C.AVATAR_COLOR_NAMES, color)) return null;
    const parts = C.AVATAR_PARTS[family];
    const keys = Object.keys(value);
    if (keys.length !== Object.keys(parts).length + 2) return null;
    const choice = { family };
    for (const key of Object.keys(parts)) {
      if (!own(value, key) || !oneOf(parts[key], value[key])) return null;
      choice[key] = value[key];
    }
    choice.color = color;
    return choice;
  }

  /**
   * The studio's own edits, tidied before they are parsed: a trim with nothing
   * to colour goes, and a crown alone takes the default trim (it is gold
   * whatever the trim, so nothing else would be saved for it).
   */
  function tidy(choice) {
    const out = { ...choice };
    for (const slot of SLOTS) if (!out[slot]) delete out[slot];
    if (!wears(out)) delete out.trim;
    else if (onlyCrown(out)) out.trim = AVATAR_TRIM_DEFAULT[out.color];
    return parseChoice(out);
  }

  // Describe a Claw: the model's reply, bounded -----------------------------------------

  const MAX_REPLY_BYTES = 4096;

  /**
   * JSON with duplicate keys refused and at most three levels:
   * the envelope, its array, and flat objects of strings and nulls.
   * Null for anything else, prose around it included.
   */
  function strictJson(text) {
    let at = 0;
    const ws = () => {
      while (at < text.length && " \t\n\r".includes(text[at])) at += 1;
    };
    const fail = () => {
      throw new Error("invalid");
    };
    const str = () => {
      if (text[at] !== '"') fail();
      const start = at;
      at += 1;
      while (at < text.length && text[at] !== '"') {
        if (text.charCodeAt(at) < 0x20) fail();
        at += text[at] === "\\" ? 2 : 1;
      }
      if (text[at] !== '"') fail();
      at += 1;
      return JSON.parse(text.slice(start, at));
    };
    const value = (depth) => {
      ws();
      const ch = text[at];
      if (ch === "{") {
        if (depth >= 3) fail();
        at += 1;
        const obj = Object.create(null);
        ws();
        if (text[at] === "}") {
          at += 1;
          return obj;
        }
        for (;;) {
          ws();
          const key = str();
          if (Object.prototype.hasOwnProperty.call(obj, key)) fail();
          ws();
          if (text[at] !== ":") fail();
          at += 1;
          obj[key] = value(depth + 1);
          ws();
          if (text[at] === ",") at += 1;
          else if (text[at] === "}") {
            at += 1;
            return obj;
          } else fail();
        }
      }
      if (ch === "[") {
        if (depth >= 2) fail();
        at += 1;
        const list = [];
        ws();
        if (text[at] === "]") {
          at += 1;
          return list;
        }
        for (;;) {
          list.push(value(depth + 1));
          ws();
          if (text[at] === ",") at += 1;
          else if (text[at] === "]") {
            at += 1;
            return list;
          } else fail();
        }
      }
      if (ch === '"') return str();
      if (text.startsWith("null", at)) {
        at += 4;
        return null;
      }
      // Numbers, booleans and anything else are not values this reply has.
      return fail();
    };
    try {
      const out = value(0);
      ws();
      return at === text.length ? out : null;
    } catch {
      return null;
    }
  }

  /**
   * One idea from the model, normalized at this boundary only: an absent, null
   * or "none" slot is nothing worn, a null trim is no trim, a lone trim goes,
   * and an equipped idea without a trim takes the default. Then the strict
   * parse. Null when the idea isn't one.
   */
  function normalizeIdea(idea) {
    const out = {};
    for (const key of Object.keys(idea)) {
      const value = idea[key];
      if (SLOTS.includes(key)) {
        if (value === null || value === "none") continue;
      } else if (key === "trim") {
        if (value === null) continue;
        if (!oneOf(C.AVATAR_COLOR_NAMES, value)) return null;
      } else if (typeof value !== "string") return null;
      out[key] = value;
    }
    if (!wears(out)) delete out.trim;
    else if (!out.trim) out.trim = AVATAR_TRIM_DEFAULT[out.color];
    const choice = parseChoice(out);
    return choice ? tidy(choice) : null;
  }

  /**
   * The model's reply to Describe a Claw: at most 4 KiB of UTF-8, exactly one
   * JSON object with one key, `ideas`, holding one to three flat choices. A
   * reply that isn't that shape is `{ ok: false }` and gets the one retry; from
   * a reply that is, the valid ideas, without repeats. Nothing the model writes
   * is shown as words.
   */
  function parseIdeasReply(text) {
    if (typeof text !== "string") return { ok: false, reason: "not-text" };
    if (new TextEncoder().encode(text).length > MAX_REPLY_BYTES) return { ok: false, reason: "too-long" };
    const envelope = strictJson(text);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { ok: false, reason: "not-one-object" };
    const keys = Object.keys(envelope);
    if (keys.length !== 1 || keys[0] !== "ideas") return { ok: false, reason: "keys" };
    const list = envelope.ideas;
    if (!Array.isArray(list) || list.length < 1 || list.length > 3) return { ok: false, reason: "ideas" };
    if (!list.every((idea) => idea && typeof idea === "object" && !Array.isArray(idea))) return { ok: false, reason: "ideas" };
    const seen = new Set();
    const ideas = [];
    for (const idea of list) {
      const choice = normalizeIdea(idea);
      if (!choice) continue;
      const key = encodeChoice(choice);
      if (seen.has(key)) continue;
      seen.add(key);
      ideas.push(choice);
    }
    return ideas.length ? { ok: true, ideas } : { ok: false, reason: "no-valid-idea" };
  }

  // A Claw from a bot's name ----------------------------------------------------------------

  /** Kept apart from the id's default (`<id>:<field>`) by the NUL bytes no id has. */
  const NAME_SALT = "clawtrate-name";

  /**
   * The name a Claw is drawn from: trimmed, NFC, case-folded. The prototype
   * folds with toUpperCase then toLowerCase; core carries one fold table so
   * every device gets the same key.
   */
  const nameKey = (name) => String(name ?? "").trim().normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");

  /** The starter: what New bot shows before a name is typed. */
  const STARTER = () => C.firstChoice("clawling", "blue");

  /**
   * The Claw a name gives: any family, its parts and colour, and about half
   * the time one accessory in another colour. The same name gives the same
   * Claw on every device, every time. An empty name gives the starter.
   */
  function nameChoice(name) {
    const key = nameKey(name);
    if (!key) return STARTER();
    const h = (field) => C.avatarHash(`${NAME_SALT}\u0000${key}\u0000${field}`);
    const family = C.AVATAR_FAMILIES[h("family") % C.AVATAR_FAMILIES.length];
    const choice = { family };
    for (const [part, values] of Object.entries(C.AVATAR_PARTS[family])) choice[part] = values[h(part) % values.length];
    choice.color = C.AVATAR_COLOR_NAMES[h("color") % C.AVATAR_COLOR_NAMES.length];
    if (h("wear") % 2 === 0) {
      const all = SLOTS.flatMap((slot) => AVATAR_ACCESSORIES[slot].map((value) => [slot, value]));
      const [slot, value] = all[h("accessory") % all.length];
      choice[slot] = value;
      const others = C.AVATAR_COLOR_NAMES.filter((c) => c !== choice.color);
      choice.trim = others[h("trim") % others.length];
    }
    return tidy(choice);
  }

  window.ClawtrateAccessories = {
    AVATAR_HEADWEAR,
    AVATAR_FACEWEAR,
    AVATAR_NECKWEAR,
    AVATAR_ACCESSORIES,
    AVATAR_TRIM_DEFAULT,
    AVATAR_GOLD,
    ACCESSORY_MOTIONS,
    TIP_PEAK,
    LAYERS,
    HEAD_SOCKETS,
    NECK_SOCKETS,
    LANTERN_HEADPHONES,
    LANTERN_BLOCKED_SLIP,
    HAT_OUTLINE,
    FIT,
    SLOTS,
    V2_GRAMMAR,
    MAX_REPLY_BYTES,
    NAME_SALT,
    trimName,
    trimOf,
    wears,
    onlyCrown,
    sceneSockets,
    fitInset,
    rootPeaks,
    accessorize,
    encodeChoice,
    decodeV2,
    parseChoice,
    parseBase: (value) => (value && typeof value === "object" ? strictBase(value) : null),
    tidy,
    strictJson,
    normalizeIdea,
    parseIdeasReply,
    nameKey,
    nameChoice,
    STARTER,
  };
})();
