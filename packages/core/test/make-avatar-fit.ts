// Prints `AVATAR_FIT` for packages/core/src/avatar.ts: for each creature, the
// scale and shift that put every part, in every pose its states and motions
// reach, inside a circle of radius `FIT_RADIUS` in the middle of the grid.
// Run it after changing a creature's geometry or motion, and paste the result:
//
//   node packages/core/test/make-avatar-fit.ts
//
// avatar.test.ts fails when a creature leaves the circle.

/** Node's console, which the core's settings do not type. */
declare const console: { log(text: string): void };

import {
  AVATAR_FAMILIES,
  AVATAR_PARTS,
  AVATAR_STATES,
  avatarFitKey,
  avatarScene,
  avatarVariation,
  type AvatarChoice,
} from "../src/avatar.ts";
import { enclosing, hull, sceneReach, scenePoints } from "./avatar-bounds.ts";

/** A little inside the crop circle of radius 20, for the edge's antialiasing. */
export const FIT_RADIUS = 19.5;

const lines: string[] = [];
for (const family of AVATAR_FAMILIES) {
  let partial: Array<Record<string, string>> = [{ family }];
  for (const [key, values] of Object.entries(AVATAR_PARTS[family]))
    partial = partial.flatMap((each) => values.map((value: string) => ({ ...each, [key]: value })));
  for (const each of partial) {
    const choice = { ...each, color: "blue" } as AvatarChoice;
    const points: Array<[number, number]> = [];
    for (const state of AVATAR_STATES)
      for (const p of hull(scenePoints(avatarScene(choice, state, avatarVariation("fit")), false)))
        points.push(p);
    const circle = enclosing(points);
    let k = Math.min(1, FIT_RADIUS / circle.r);
    // A stroke kept a fixed width on screen does not shrink with the rest: shrink a little more
    // until the fitted creature is inside in every state.
    const reaches = () =>
      Math.max(
        ...AVATAR_STATES.map((state) =>
          sceneReach({
            ...avatarScene(choice, state, avatarVariation("fit")),
            fit: k,
            shift: [-k * (circle.x - 20), -k * (circle.y - 20)],
          }),
        ),
      );
    while (reaches() > FIT_RADIUS) k *= 0.995;
    const round = (n: number) => Math.round(n * 1000) / 1000 + 0;
    lines.push(
      `  "${avatarFitKey(choice)}": "${round(k)} ${round(-k * (circle.x - 20))} ${round(-k * (circle.y - 20))}",`,
    );
  }
}
console.log(lines.join("\n"));
