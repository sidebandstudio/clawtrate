import type { AvatarChoice, AvatarVariation } from "@clawtrate/core";

/** The creatures along the foot of the connection screens, in desktop order. */
export const ENSEMBLE: Array<{
  choice: AvatarChoice;
  variation: AvatarVariation;
  size: number;
  sink: number;
  lean: number;
}> = [
  {
    choice: { family: "lantern", body: "round", lure: "hook", eyes: "two", color: "sky" },
    variation: { gaze: [0.3, 0.5], blink: 0 },
    size: 132,
    sink: -0.3,
    lean: -8,
  },
  {
    choice: { family: "clawling", body: "dome", eyes: "pair", claws: "even", color: "blue" },
    variation: { gaze: [-0.7, 0.3], blink: 0 },
    size: 176,
    sink: -0.26,
    lean: 5,
  },
  {
    choice: { family: "shellfolk", shell: "dome", color: "yellow" },
    variation: { gaze: [0.8, 0], blink: 0 },
    size: 118,
    sink: -0.2,
    lean: -4,
  },
  {
    choice: { family: "clawling", body: "tall", eyes: "splayed", claws: "fiddler", color: "green" },
    variation: { gaze: [0.82, 0.2], blink: 0 },
    size: 204,
    sink: -0.3,
    lean: 3,
  },
  {
    choice: { family: "lantern", body: "bell", lure: "flick", eyes: "one", color: "lime" },
    variation: { gaze: [0.6, -0.3], blink: 0 },
    size: 160,
    sink: -0.24,
    lean: -6,
  },
  {
    choice: { family: "shellfolk", shell: "spotted", color: "pink" },
    variation: { gaze: [-0.8, 0.2], blink: 0 },
    size: 124,
    sink: -0.26,
    lean: 7,
  },
  {
    choice: { family: "clawling", body: "round", eyes: "single", claws: "big", color: "violet" },
    variation: { gaze: [0, -0.5], blink: 0 },
    size: 186,
    sink: -0.28,
    lean: -3,
  },
  {
    choice: { family: "clawling", body: "wide", eyes: "short", claws: "even", color: "orchid" },
    variation: { gaze: [-0.4, -0.4], blink: 0 },
    size: 122,
    sink: -0.24,
    lean: 4,
  },
];

/** Below this window height, leave the full space for the form. */
export function showEnsemble(height: number): boolean {
  return height >= 640;
}
