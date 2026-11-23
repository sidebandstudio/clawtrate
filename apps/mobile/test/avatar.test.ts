import {
  AVATAR_COLORS,
  AVATAR_FAMILIES,
  AVATAR_FINE_MIN_PX,
  AVATAR_MOTIONS,
  AVATAR_STATES,
  avatarScene,
  avatarVariation,
  firstChoice,
  type AvatarMotionName,
  type AvatarShape,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import {
  avatarElement,
  avatarFrame,
  avatarHold,
  fitTransform,
} from "../src/presentation/avatar.ts";

const options = { size: 44, clipId: "test", muted: false, moving: false };
const linear = (progress: number) => progress;

function allShapes(shape: AvatarShape): AvatarShape[] {
  return shape.kind === "group" ? [shape, ...shape.children.flatMap(allShapes)] : [shape];
}

describe("the native avatar scene", () => {
  it("maps every family and pose to SVG elements, with the shared fit and native eye clips", () => {
    for (const family of AVATAR_FAMILIES) {
      for (const state of AVATAR_STATES) {
        const scene = avatarScene(firstChoice(family, "sky"), state, avatarVariation("pip"));
        expect(fitTransform(scene)).toBe(
          `translate(${scene.shift.join(" ")}) translate(20 20) scale(${scene.fit}) translate(-20 -20)`,
        );
        for (const shape of allShapes(scene.root)) {
          const element = avatarElement(shape, options);
          expect(element?.kind).toBe(shape.kind);
          if (shape.clip) expect(element?.props.clipPath).toBe(`url(#test-${shape.clip})`);
        }
      }
    }
    expect(
      avatarElement({ kind: "rect", x: 1, y: 2, width: 3, height: 4, rx: 1 }, options),
    ).toMatchObject({
      kind: "rect",
      props: { x: 1, y: 2, width: 3, height: 4, rx: 1 },
    });
  });

  it("drops only fine marks below the desktop threshold", () => {
    const scene = avatarScene(firstChoice("shellfolk", "sky"), "waiting", avatarVariation("otto"));
    const shapes = allShapes(scene.root);
    expect(shapes.filter((shape) => shape.fine).map((shape) => shape.part)).toEqual([
      "glint",
      "glint",
      "pattern",
    ]);
    for (const shape of shapes) {
      expect(avatarElement(shape, { ...options, size: AVATAR_FINE_MIN_PX - 1 }) === null).toBe(
        shape.fine === true,
      );
      expect(avatarElement(shape, { ...options, size: AVATAR_FINE_MIN_PX })).not.toBeNull();
    }
  });

  it("mutes fills and strokes while retaining the scene's opacity and paint inheritance", () => {
    expect(
      avatarElement(
        {
          kind: "path",
          d: "M2 3L4 5",
          fill: "none",
          stroke: AVATAR_COLORS.sky,
          strokeWidth: 2,
          round: true,
          opacity: 0.8,
        },
        { ...options, muted: true },
      ),
    ).toMatchObject({
      kind: "path",
      props: {
        d: "M2 3L4 5",
        fill: "none",
        stroke: "#6d96a9",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        opacity: 0.8,
      },
    });
  });

  it("uses the still rotation with Reduce Motion and places rotation and scale about the origin", () => {
    const arm: AvatarShape = {
      kind: "group",
      children: [],
      origin: [10, 20],
      rotate: 12,
      still: -54,
      motion: "wave",
      transform: "translate(4 5)",
    };
    expect(avatarElement(arm, options)?.props.transform).toBe(
      "translate(10 20) rotate(-54) translate(-10 -20) translate(4 5)",
    );
    expect(
      avatarElement(
        arm,
        { ...options, moving: true },
        { translate: [1, 2], rotate: 30, scale: 1.5 },
      )?.props.transform,
    ).toBe(
      "translate(1 2) translate(10 20) rotate(30) scale(1.5) translate(-10 -20) translate(4 5)",
    );
  });

  it("converts a snapping claw's normalized dashes and keeps a fixed-width lure ring", () => {
    const claw: AvatarShape = { kind: "circle", cx: 4, cy: 5, r: 3, dash: [78, 22] };
    const { props } = avatarElement(
      claw,
      { ...options, moving: true },
      { dash: [97, 3], dashOffset: 9.5 },
    )!;
    expect(props.strokeDasharray?.[0]).toBeCloseTo(0.97 * 2 * Math.PI * claw.r);
    expect(props.strokeDasharray?.[1]).toBeCloseTo(0.03 * 2 * Math.PI * claw.r);
    expect(props.strokeDashoffset).toBeCloseTo(0.095 * 2 * Math.PI * claw.r);
    expect(avatarElement({ ...claw, fixedStroke: true }, options)?.props.vectorEffect).toBe(
      "non-scaling-stroke",
    );
  });

  it("samples each shared motion through its loop, including delayed blinks and staggered claws", () => {
    for (const [name, motion] of Object.entries(AVATAR_MOTIONS)) {
      const key = name as AvatarMotionName;
      expect(avatarFrame(key, motion.duration, 0, linear)).toEqual(motion.frames[0]);
      const times = motion.frames
        .slice(1)
        .map((frame, i) => ((motion.frames[i]!.at + frame.at) / 2) * motion.duration);
      for (const time of times) {
        const frame = avatarFrame(key, time, 0, linear);
        expect(frame).toBeDefined();
        expect(
          Object.values(frame!)
            .flat()
            .filter((value) => value !== undefined)
            .every(Number.isFinite),
        ).toBe(true);
      }
    }
    expect(avatarFrame("blink", 800, 801, linear)).toBeUndefined();
    expect(avatarFrame("blink", 10, 0, linear)).toBe(avatarFrame("blink", 500, 0, linear));
    expect(avatarFrame("snap", 0, -300, linear)).toMatchObject({ dash: [97, 3], dashOffset: 9.5 });
    expect(avatarFrame("bob", 150, 0, (x) => x * x)?.translate).toEqual([0, -0.35]);
  });

  it("sleeps through a delay and a held pose, and not while a part moves", () => {
    const { duration } = AVATAR_MOTIONS.blink;
    // Before its delay, then the open eye until the lid starts down at 91%.
    expect(avatarHold("blink", 800, 1200)).toBe(400);
    expect(avatarHold("blink", 0, 0)).toBeCloseTo(0.91 * duration);
    expect(avatarHold("blink", 0.92 * duration, 0)).toBe(0);
    expect(avatarHold("blink", 0.98 * duration, 0)).toBeCloseTo(0.02 * duration);
    // The next loop starts held again.
    expect(avatarHold("blink", duration + 100, 0)).toBeCloseTo(0.91 * duration - 100);
    // A hop rests after landing; a bob and a snapping claw never rest.
    expect(avatarHold("hop", 0.5 * AVATAR_MOTIONS.hop.duration, 0)).toBeCloseTo(
      0.5 * AVATAR_MOTIONS.hop.duration,
    );
    expect(avatarHold("bob", 100, 0)).toBe(0);
    expect(avatarHold("snap", 0, -300)).toBe(0);
  });
});
