// What a Claw wears (avatar.ts; docs/design/avatar-studio.md, section 4).
import { describe, expect, it } from "vitest";
import {
  AVATAR_ACCESSORIES,
  AVATAR_COLOR_NAMES,
  AVATAR_COLORS,
  AVATAR_FACEWEAR,
  AVATAR_FAMILIES,
  AVATAR_HEADWEAR,
  AVATAR_MOTIONS,
  AVATAR_NECKWEAR,
  AVATAR_PARTS,
  AVATAR_STATES,
  AVATAR_TRIM_DEFAULT,
  avatarScene,
  avatarVariation,
  isGuardedColor,
  type AvatarChoice,
  type AvatarScene,
  type AvatarShape,
  type AvatarState,
} from "../src/avatar.ts";
import { outfitReach, sceneOutline, sceneReach } from "./avatar-bounds.ts";

/** Each family with every combination of its parts, in blue. */
function everyCreature(): AvatarChoice[] {
  const out: AvatarChoice[] = [];
  for (const family of AVATAR_FAMILIES) {
    let partial: Array<Record<string, string>> = [{ family }];
    for (const [key, values] of Object.entries(AVATAR_PARTS[family]))
      partial = partial.flatMap((each) =>
        values.map((value: string) => ({ ...each, [key]: value })),
      );
    for (const each of partial) out.push({ ...each, color: "blue" } as AvatarChoice);
  }
  return out;
}

const scene = (choice: AvatarChoice, state: AvatarState) =>
  avatarScene(choice, state, avatarVariation("atlas"));

function walk(shape: AvatarShape, visit: (shape: AvatarShape, parent: AvatarShape | null) => void) {
  const go = (each: AvatarShape, parent: AvatarShape | null) => {
    visit(each, parent);
    if (each.kind === "group") for (const child of each.children) go(child, each);
  };
  go(shape, null);
}

function shapes(choice: AvatarChoice, state: AvatarState): AvatarShape[] {
  const all: AvatarShape[] = [];
  walk(scene(choice, state).root, (each) => all.push(each));
  return all;
}

const named = (list: AvatarShape[], part: string) => list.filter((each) => each.part === part);

/** The scene's tree cut down to the shapes named `part` and the groups that hold them. */
function only(shape: AvatarShape, part: string): AvatarShape | null {
  if (shape.part === part) return shape;
  if (shape.kind !== "group") return null;
  const children = shape.children.map((child) => only(child, part)).filter((c) => c !== null);
  return children.length > 0 ? { ...shape, children } : null;
}

/** A part's outline on the grid before fitting, each point with its stroke's half width. */
function outlineOf(of: AvatarScene, part: string): Array<{ x: number; y: number; pad: number }> {
  const root = only(of.root, part);
  if (!root) return [];
  const out: Array<{ x: number; y: number; pad: number }> = [];
  for (const [pad, points] of sceneOutline({ ...of, root } as AvatarScene))
    for (const [x, y] of points) out.push({ x, y, pad: Math.abs(pad) });
  return out;
}

/** A path's subpaths as polygons, its curves sampled (the mouths and the bow tie use M, L, H, V, Q and Z). */
function polygons(d: string): Array<Array<[number, number]>> {
  const tokens = d.match(/[MLHVQZ]|-?[\d.]+/g)!;
  const out: Array<Array<[number, number]>> = [];
  let [x, y, i, command] = [0, 0, 0, ""];
  while (i < tokens.length) {
    if (/[MLHVQZ]/.test(tokens[i]!)) command = tokens[i++]!;
    if (command === "Z") continue;
    const n = () => Number(tokens[i++]);
    if (command === "M") {
      [x, y] = [n(), n()];
      out.push([]);
    } else if (command === "Q") {
      const [cx, cy, ex, ey] = [n(), n(), n(), n()];
      for (let t = 1 / 32; t < 1; t += 1 / 32) {
        const [u, v, w] = [(1 - t) ** 2, 2 * t * (1 - t), t * t];
        out.at(-1)!.push([u * x + v * cx + w * ex, u * y + v * cy + w * ey]);
      }
      [x, y] = [ex, ey];
    } else if (command === "L") [x, y] = [n(), n()];
    else if (command === "H") x = n();
    else y = n();
    out.at(-1)!.push([x, y]);
  }
  return out;
}

/** Where a polygon's topmost edge is at x, or Infinity when the polygon doesn't reach x. */
function topAt(points: Array<[number, number]>, x: number): number {
  let top = Infinity;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length]!;
    if (p[0] !== q[0] && (p[0] - x) * (q[0] - x) <= 0)
      top = Math.min(top, p[1] + ((q[1] - p[1]) * (x - p[0])) / (q[0] - p[0]));
  });
  return top;
}

const clawling: AvatarChoice = {
  family: "clawling",
  body: "dome",
  eyes: "pair",
  claws: "even",
  color: "blue",
};
const oneEyed: AvatarChoice = { ...clawling, eyes: "single" };
const shellfolk: AvatarChoice = { family: "shellfolk", shell: "spiral", color: "blue" };
const lantern: AvatarChoice = {
  family: "lantern",
  body: "round",
  lure: "hook",
  eyes: "two",
  color: "sky",
};
const HATS = ["beanie", "beret", "party", "crown"] as const;

describe("the accessory lists", () => {
  it("offers five on the head, two over the eyes and a bow tie, in picker order", () => {
    expect(AVATAR_ACCESSORIES).toEqual({
      head: ["beanie", "beret", "party", "crown", "headphones"],
      face: ["glasses", "shades"],
      neck: ["bowtie"],
    });
  });

  it("defaults the trim to another of the eight colours, never the body's own", () => {
    for (const color of AVATAR_COLOR_NAMES) {
      expect(AVATAR_COLOR_NAMES).toContain(AVATAR_TRIM_DEFAULT[color]);
      expect(AVATAR_TRIM_DEFAULT[color]).not.toBe(color);
    }
    const hat = (choice: AvatarChoice) =>
      named(shapes(choice, "idle"), "wear-beret").flatMap((each) => {
        const fills: string[] = [];
        walk(each, (shape) => shape.fill && fills.push(shape.fill));
        return fills;
      });
    expect(hat({ ...clawling, head: "beret" })).toContain(AVATAR_COLORS.yellow);
    expect(hat({ ...clawling, head: "beret", trim: "pink" })).toContain(AVATAR_COLORS.pink);
  });
});

describe("accessories at their sockets, in every family and state", () => {
  it("wears each one in every pose that has room for it, and none on a hiding Shellfolk's critter", () => {
    const problems: string[] = [];
    for (const base of everyCreature())
      for (const state of AVATAR_STATES)
        for (const head of AVATAR_HEADWEAR)
          for (const face of AVATAR_FACEWEAR) {
            const choice = { ...base, head, face, neck: "bowtie" } as AvatarChoice;
            const all = shapes(choice, state);
            const where = `${head} ${face} on ${JSON.stringify(base)} ${state}`;
            const hiding = base.family === "shellfolk" && state === "blocked";
            const count = (part: string) => named(all, part).length;
            const eyes = named(all, "eye");
            if (count(`wear-${head}`) !== (hiding && head === "headphones" ? 0 : 1))
              problems.push(`${where}: ${count(`wear-${head}`)} ${head}`);
            if (count("wear-bowtie") !== (hiding ? 0 : 1)) problems.push(`${where}: bow tie`);
            // A lens in every eye, inside the eye's own group, so it follows the eye.
            const inEyes = eyes.filter(
              (eye) => eye.kind === "group" && eye.children.some((c) => c.part === `wear-${face}`),
            );
            if (
              eyes.length === 0 ||
              inEyes.length !== eyes.length ||
              count(`wear-${face}`) !== eyes.length
            )
              problems.push(`${where}: ${inEyes.length} of ${eyes.length} eyes wear ${face}`);
          }
    expect(problems).toEqual([]);
  }, 60_000);

  it("gives the sockets where the eyes are drawn, in every state", () => {
    const problems: string[] = [];
    for (const base of everyCreature())
      for (const state of AVATAR_STATES) {
        const of = scene(base, state);
        const drawn: Array<[number, number, number]> = [];
        walk(of.root, (each) => {
          if (each.part !== "eye") return;
          const m = /^translate\(([-\d.]+) ([-\d.]+)\)(?: scale\(([\d.]+)\))?$/.exec(
            each.transform!,
          )!;
          drawn.push([Number(m[1]), Number(m[2]), Number(m[3] ?? 1)]);
        });
        const sockets = of.sockets.eyes.map((e) => [e.x, e.y, e.scale]);
        if (JSON.stringify(sockets) !== JSON.stringify(drawn))
          problems.push(`${JSON.stringify(base)} ${state}: ${JSON.stringify(sockets)}`);
      }
    expect(problems).toEqual([]);
  });

  it("moves each accessory as its socket moves: hats tip on the hop, a one-eyed hat rides its eye", () => {
    // Hats sit still on their socket in every state but done, which lifts and tips them.
    for (const choice of [clawling, oneEyed, shellfolk, lantern])
      for (const head of HATS)
        for (const state of AVATAR_STATES) {
          const motion = named(shapes({ ...choice, head }, state), "hat-motion")[0]!;
          expect(motion.motion).toBe(state === "done" ? "tip" : undefined);
        }
    // A one-eyed Clawling's hat is on its eye's rim, so it rises with the eye in waiting.
    const eyeHat = (state: AvatarState) => scene(oneEyed, state).sockets.head!;
    expect(eyeHat("idle")).toMatchObject({ x: 20, layer: "on-top", scale: 0.8 });
    expect(eyeHat("waiting").y).toBeLessThan(eyeHat("idle").y);
    expect(eyeHat("blocked").y).toBeGreaterThan(eyeHat("idle").y);
    // A two-eyed Clawling's hat is on its body, between the stalks.
    expect(scene(clawling, "thinking").sockets.head).toEqual({
      x: 20,
      y: 18,
      scale: 1.1,
      tilt: 0,
      layer: "after-body",
    });
    // A Shellfolk's hat stays on its shell, hiding or not.
    for (const state of AVATAR_STATES)
      expect(scene(shellfolk, state).sockets.head).toEqual(scene(shellfolk, "idle").sockets.head);
    expect(scene(shellfolk, "blocked").sockets).toMatchObject({ band: null, neck: null });
    // A Lantern's hat slips down its side when the lure droops onto it.
    expect(scene(lantern, "blocked").sockets.head).toEqual({
      x: 11,
      y: 20.2,
      scale: 0.9,
      tilt: -62,
      layer: "after-body",
    });
    // The bow tie stays in one place in every state.
    for (const choice of [clawling, shellfolk, lantern])
      for (const state of AVATAR_STATES)
        if (!(choice.family === "shellfolk" && state === "blocked"))
          expect(scene(choice, state).sockets.neck).toEqual(scene(choice, "idle").sockets.neck);
    // Headphones follow the eyes: wider in waiting, where the eyes are drawn larger.
    const band = (state: AvatarState) => scene(clawling, state).sockets.band!;
    expect(band("waiting").right[0] - band("waiting").left[0]).toBeGreaterThan(
      band("idle").right[0] - band("idle").left[0],
    );
    expect(scene(lantern, "waiting").sockets.band).toEqual(scene(lantern, "idle").sockets.band);
  });

  it("keeps the bow tie below every mouth, rims apart, and a Lantern's hat clear of its drooped lure", () => {
    const problems: string[] = [];
    for (const base of everyCreature())
      for (const state of AVATAR_STATES) {
        const of = scene({ ...base, face: "glasses", neck: "bowtie" }, state);
        const where = `${JSON.stringify(base)} ${state}`;
        if (base.family !== "shellfolk") {
          // In the creature's own frame, which carries both.
          const mouth = named(shapes(of.choice, state), "mouth")[0]!;
          const line = mouth.stroke ? (mouth.strokeWidth ?? 1) / 2 : 0;
          const lips =
            mouth.kind === "circle"
              ? [
                  [mouth.cx - mouth.r, mouth.cy + mouth.r] as [number, number],
                  [mouth.cx + mouth.r, mouth.cy + mouth.r] as [number, number],
                ]
              : mouth.kind === "path"
                ? polygons(mouth.d).flat()
                : [];
          // The bow tie's wings and knot as drawn, at its socket, each with its edge.
          const { x: tx, y: ty, scale } = of.sockets.neck!;
          const [wings, knot] = (
            named(shapes(of.choice, state), "wear-bowtie")[0] as AvatarShape & { kind: "group" }
          ).children;
          const knotBox = knot!.kind === "rect" ? knot! : null;
          const parts = [
            ...(wings!.kind === "path" ? polygons(wings!.d) : []),
            knotBox
              ? ([
                  [knotBox.x, knotBox.y],
                  [knotBox.x + knotBox.width, knotBox.y],
                  [knotBox.x + knotBox.width, knotBox.y + knotBox.height],
                  [knotBox.x, knotBox.y + knotBox.height],
                ] as Array<[number, number]>)
              : [],
          ].map((polygon) =>
            polygon.map(([px, py]): [number, number] => [tx + px * scale, ty + py * scale]),
          );
          const edge = 0.25 * scale;
          // Every point of the mouth, with its line's width, is above the bow tie in its column.
          for (const [x, y] of lips)
            for (const polygon of parts)
              for (const at of [x - line - edge, x, x + line + edge])
                if (!(topAt(polygon, at) - edge > y + line))
                  problems.push(`${where}: the bow tie meets the mouth at ${at.toFixed(2)}`);
        }
        const [a, b] = of.sockets.eyes;
        if (a && b) {
          // Each ring's outer edge, with its 1.05 stroke, stays within half the gap.
          const rim = (e: typeof a) => (e.ring + 0.525) * e.scale;
          if (!(rim(a) + rim(b) < Math.abs(b.x - a.x))) problems.push(`${where}: rims cross`);
        }
      }
    for (const body of AVATAR_PARTS.lantern.body)
      for (const lure of AVATAR_PARTS.lantern.lure)
        for (const head of HATS) {
          const of = scene({ ...lantern, body, lure, head }, "blocked");
          const hat = outlineOf(of, `wear-${head}`);
          const ball = outlineOf(of, "ball");
          let gap = Infinity;
          for (const p of hat)
            for (const q of ball)
              gap = Math.min(gap, Math.hypot(p.x - q.x, p.y - q.y) - p.pad - q.pad);
          if (!(gap > 0)) problems.push(`${body} ${lure} ${head}: the hat touches the ball`);
        }
    expect(problems).toEqual([]);
  });
});

describe("what an accessory drops at small sizes, and its colours", () => {
  it("marks only the fine detail: glasses whole, bridges, ribs, stripes, the beret's band and stalk, the jewel, the glint", () => {
    const fine = new Map<string, Set<string>>();
    for (const head of AVATAR_HEADWEAR)
      for (const face of AVATAR_FACEWEAR)
        for (const state of AVATAR_STATES) {
          const choice = { ...clawling, head, face, neck: "bowtie" } as AvatarChoice;
          walk(scene(choice, state).root, (each) => {
            if (!each.fine) return;
            const set = fine.get(each.part ?? "?") ?? new Set();
            fine.set(each.part ?? "?", set.add(state));
          });
        }
    // The creature's own fine parts (mouth, glint, pattern) are #300's; the rest are the accessories'.
    expect([...fine.keys()].sort()).toEqual(
      [
        "beret-band",
        "beret-stalk",
        "glint",
        "jewel",
        "mouth",
        "ribs",
        "stripes",
        "wear-bridge",
        "wear-glasses",
      ].sort(),
    );
    // Silhouettes stay at every size: hats, poms, cups, lenses and the bow tie.
    for (const state of AVATAR_STATES)
      for (const each of shapes(
        { ...clawling, head: "party", face: "shades", neck: "bowtie" },
        state,
      ))
        if (["wear-party", "pom", "wear-shades", "wear-bowtie", "knot"].includes(each.part ?? ""))
          expect(each.fine).toBeFalsy();
  });

  it("draws every accessory in every trim outside the palette guard, the crown always gold", () => {
    const colours = new Set<string>();
    for (const trim of AVATAR_COLOR_NAMES)
      for (const base of [clawling, oneEyed, shellfolk, lantern])
        for (const head of AVATAR_HEADWEAR)
          for (const face of AVATAR_FACEWEAR)
            for (const state of AVATAR_STATES)
              walk(scene({ ...base, head, face, neck: "bowtie", trim }, state).root, (each) => {
                for (const colour of [each.fill, each.stroke])
                  if (colour?.startsWith("#")) colours.add(colour);
              });
    expect(colours.size).toBeGreaterThan(40);
    expect([...colours].filter(isGuardedColor)).toEqual([]);
    const crown = named(
      shapes({ ...lantern, head: "crown", trim: "violet" }, "idle"),
      "wear-crown",
    );
    const fills: string[] = [];
    walk(crown[0]!, (each) => each.fill && fills.push(each.fill));
    expect(fills[0]).toBe(AVATAR_COLORS.yellow);
    expect(fills).not.toContain(AVATAR_COLORS.violet);
  });
});

describe("the hat's tip on the done hop", () => {
  it("loops with the hop, peaks with it, and rests seated, so reduced motion shows the hat on", () => {
    const { tip, hop } = AVATAR_MOTIONS;
    expect([tip.duration, tip.easing]).toEqual([hop.duration, hop.easing]);
    const peak = tip.frames.find((frame) => frame.translate?.[1] === -1.6)!;
    expect(peak).toEqual({ at: 0.11, translate: [0, -1.6], rotate: -12 });
    const hopPeak = hop.frames.reduce((a, b) =>
      (b.translate?.[1] ?? 0) < (a.translate?.[1] ?? 0) ? b : a,
    );
    expect(Math.abs(peak.at - hopPeak.at)).toBeLessThanOrEqual(0.02);
    expect(tip.frames[0]).toEqual({ at: 0, translate: [0, 0], rotate: 0 });
    const moving = named(shapes({ ...clawling, head: "beanie" }, "done"), "hat-motion")[0]!;
    expect(moving).toMatchObject({ motion: "tip", origin: [0, 0] });
    expect(moving.still).toBeUndefined();
  });
});

describe("every outfit stays inside the circle an avatar is cropped to", () => {
  it("measures outfits as #300 measures creatures, a little tighter on strokes", () => {
    for (const choice of [
      { ...clawling, head: "party", face: "shades", neck: "bowtie" },
      { ...oneEyed, head: "headphones", face: "glasses" },
      { ...lantern, eyes: "one", head: "crown", face: "shades" },
      { ...shellfolk, head: "beanie", face: "glasses", neck: "bowtie" },
    ] as AvatarChoice[])
      for (const state of AVATAR_STATES) {
        const each = scene(choice, state);
        expect(outfitReach(each)).toBeLessThanOrEqual(sceneReach(each) + 1e-9);
        expect(outfitReach(each)).toBeGreaterThan(sceneReach(each) - 0.2);
      }
  }, 60_000);

  it("with every creature in every outfit, in every state and every pose its motions reach", () => {
    const outside: string[] = [];
    let outfits = 0;
    let smallest = 1;
    for (const base of everyCreature()) {
      const bare = AVATAR_STATES.map((state) => outfitReach(scene(base, state)));
      // Within #300's radius of the drawn outline, or no farther than the creature alone, whose rounded
      // fit can be a hair outside. Strokes count as the round bands they are: #300's `sceneReach`
      // counts them as octagons and puts some outfits up to 19.6, inside its own 19.75 test limit.
      const limit = Math.max(19.5, ...bare) + 0.02;
      for (const head of [undefined, ...AVATAR_HEADWEAR])
        for (const face of [undefined, ...AVATAR_FACEWEAR])
          for (const neck of [undefined, ...AVATAR_NECKWEAR]) {
            const choice = {
              ...base,
              ...(head && { head }),
              ...(face && { face }),
              ...(neck && { neck }),
            } as AvatarChoice;
            outfits += 1;
            const fits = new Set<string>();
            for (const state of AVATAR_STATES) {
              const each = scene(choice, state);
              fits.add(`${each.fit} ${each.shift.join(" ")}`);
              smallest = Math.min(smallest, each.fit);
              const reach = outfitReach(each);
              if (!(reach <= limit))
                outside.push(`${JSON.stringify(choice)} ${state}: ${reach.toFixed(2)}`);
            }
            // One fit in every state, so the Claw keeps its size and place while it acts; colour,
            // trim and the bow tie don't change it.
            // A bare creature keeps #300's fit, so only an outfit is compared with its bow tie on.
            const tie = head || face || neck ? { neck: "bowtie" as const } : {};
            const other = scene({ ...choice, color: "pink", trim: "lime", ...tie }, "idle");
            fits.add(`${other.fit} ${other.shift.join(" ")}`);
            if (fits.size !== 1) outside.push(`${JSON.stringify(choice)}: ${[...fits].join(", ")}`);
          }
    }
    expect(outfits).toBe(84 * 6 * 3 * 2);
    expect(outside).toEqual([]);
    expect(smallest).toBeGreaterThan(0.65);
  }, 240_000);
});
