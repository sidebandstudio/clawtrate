// Prints `AVATAR_FIT` and `AVATAR_FIT_INSET` for packages/core/src/avatar.ts:
// for each creature, the scale and shift that put every part, in every pose its
// states and motions reach, inside a circle of radius `FIT_RADIUS` in the middle
// of the grid; then the same for each outfit (a hat, eyewear, both or neither,
// with the bow tie on) that its creature's fit doesn't keep inside. Run it after changing
// a creature's or an accessory's geometry or motion, and paste the result:
//
//   node packages/core/test/make-avatar-fit.ts
//
// avatar.test.ts and avatar-accessories.test.ts fail when a creature or an outfit leaves the circle.

/** Node's console, which the core's settings do not type. */
declare const console: { log(text: string): void };

import {
  AVATAR_FACEWEAR,
  AVATAR_FAMILIES,
  AVATAR_HEADWEAR,
  AVATAR_PARTS,
  AVATAR_STATES,
  avatarFitKey,
  avatarOutfitKey,
  avatarScene,
  avatarVariation,
  type AvatarChoice,
} from "../src/avatar.ts";
import {
  enclosing,
  fittedReach,
  hull,
  sceneOutline,
  sceneReach,
  scenePoints,
} from "./avatar-bounds.ts";

/** A little inside the crop circle of radius 20, for the edge's antialiasing. */
export const FIT_RADIUS = 19.5;

const round = (n: number) => Math.round(n * 1000) / 1000 + 0;
const scenes = (choice: AvatarChoice) =>
  AVATAR_STATES.map((state) => avatarScene(choice, state, avatarVariation("fit")));

/** A creature's fit, as "scale dx dy", measured on every point of every pose (`sceneReach`). */
function creatureFit(choice: AvatarChoice): string {
  const points: Array<[number, number]> = [];
  for (const scene of scenes(choice))
    for (const p of hull(scenePoints(scene, false))) points.push(p);
  const circle = enclosing(points);
  let k = Math.min(1, FIT_RADIUS / circle.r);
  const reaches = () =>
    Math.max(
      ...scenes(choice).map((scene) =>
        sceneReach({ ...scene, fit: k, shift: [-k * (circle.x - 20), -k * (circle.y - 20)] }),
      ),
    );
  // A stroke kept a fixed width on screen does not shrink with the rest: shrink a little more
  // until the fitted creature is inside in every state.
  for (let reach = reaches(); reach > FIT_RADIUS || !Number.isFinite(reach); reach = reaches()) {
    // A reach that isn't a number would never shrink to fit: stop and name the creature.
    if (!Number.isFinite(reach)) throw new Error(`${avatarFitKey(choice)}: the reach is ${reach}`);
    k *= 0.995;
  }
  return `${round(k)} ${round(-k * (circle.x - 20))} ${round(-k * (circle.y - 20))}`;
}

/** How far a choice's outline reaches in its farthest state with this fit (`fittedReach`). */
function farthest(choice: AvatarChoice, fit: string): number {
  const [k, dx, dy] = fit.split(" ").map(Number) as [number, number, number];
  return Math.max(...scenes(choice).map((scene) => fittedReach(sceneOutline(scene), k, [dx, dy])));
}

/**
 * An outfit's own fit, by the same method on the whole outline, accessories
 * included (`fittedReach`), or null when its creature's fit already keeps it
 * as far in as the creature itself (whose fit, rounded, can be a hair outside).
 */
function outfitFit(choice: AvatarChoice, fit: string, bareReach: number): string | null {
  const outlines = scenes(choice).map(sceneOutline);
  const reach = (fit: number, shift: [number, number]) =>
    Math.max(...outlines.map((outline) => fittedReach(outline, fit, shift)));
  if (farthest(choice, fit) <= Math.max(FIT_RADIUS, bareReach)) return null;
  const circle = enclosing(outlines.flatMap((outline) => [...outline.values()].flat()));
  let k = Math.min(1, FIT_RADIUS / circle.r);
  const shift = (): [number, number] => [-k * (circle.x - 20), -k * (circle.y - 20)];
  // A reach that isn't a number stops the table here, never passes as inside the circle.
  for (let r = reach(k, shift()); !Number.isFinite(r) || r > FIT_RADIUS; r = reach(k, shift())) {
    if (!Number.isFinite(r)) throw new Error(`${avatarOutfitKey(choice)}: the reach is ${r}`);
    k *= 0.995;
  }
  return `${round(k)} ${round(shift()[0])} ${round(shift()[1])}`;
}

const fits: string[] = [];
const insets: string[] = [];
for (const family of AVATAR_FAMILIES) {
  let partial: Array<Record<string, string>> = [{ family }];
  for (const [key, values] of Object.entries(AVATAR_PARTS[family]))
    partial = partial.flatMap((each) => values.map((value: string) => ({ ...each, [key]: value })));
  for (const each of partial) {
    const bare = { ...each, color: "blue" } as AvatarChoice;
    const fit = creatureFit(bare);
    fits.push(`  "${avatarFitKey(bare)}": "${fit}",`);
    const bareReach = farthest(bare, fit);
    for (const head of [undefined, ...AVATAR_HEADWEAR])
      for (const face of [undefined, ...AVATAR_FACEWEAR]) {
        // Measured with the bow tie on, which only adds to the outline, so wearing it never changes the fit.
        const outfit = { ...bare, neck: "bowtie", ...(head && { head }), ...(face && { face }) };
        const own = outfitFit(outfit as AvatarChoice, fit, bareReach);
        if (own) insets.push(`  "${avatarOutfitKey(outfit as AvatarChoice)}": "${own}",`);
      }
  }
}
console.log(`// AVATAR_FIT\n${fits.join("\n")}\n// AVATAR_FIT_INSET\n${insets.join("\n")}`);
