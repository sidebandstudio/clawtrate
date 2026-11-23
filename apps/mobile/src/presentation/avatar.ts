// The shared creature scene as react-native-svg props, and its keyframes
// sampled over time: what the desktop leaves to SVG attributes and CSS. Pure:
// no React, so the unit tests read it directly.

import {
  AVATAR_FINE_MIN_PX,
  AVATAR_MOTIONS,
  type AvatarKeyframe,
  type AvatarMotionName,
  type AvatarScene,
  type AvatarShape,
} from "@clawtrate/core";

type FrameValues = Omit<AvatarKeyframe, "at">;
export type AvatarFrame = { [Key in keyof FrameValues]: FrameValues[Key] | undefined };

const samePair = (a?: [number, number], b?: [number, number]) =>
  a?.[0] === b?.[0] && a?.[1] === b?.[1];

/** The keyframes either side of this moment, and whether the motion holds still between them. */
function segment(name: AvatarMotionName, elapsed: number, delay: number) {
  const { duration, frames } = AVATAR_MOTIONS[name];
  const progress = ((elapsed - delay) % duration) / duration;
  const next = frames.findIndex(({ at }) => at > progress);
  const from = frames[next - 1]!;
  const to = frames[next]!;
  const holds =
    samePair(from.translate, to.translate) &&
    from.rotate === to.rotate &&
    from.scale === to.scale &&
    from.opacity === to.opacity &&
    samePair(from.dash, to.dash) &&
    from.dashOffset === to.dashOffset;
  return { duration, progress, from, to, holds };
}

/** Sample the same eased intervals and signed delays as the desktop's CSS keyframes. */
export function avatarFrame(
  name: AvatarMotionName,
  elapsed: number,
  delay: number,
  ease: (progress: number) => number,
): AvatarFrame | undefined {
  if (elapsed < delay) return;
  const { progress, from, to, holds } = segment(name, elapsed, delay);
  // Blinks and hops spend most of their loop holding a pose.
  if (holds || progress === from.at) return from;
  const amount = ease((progress - from.at) / (to.at - from.at));
  const mix = (a: number, b: number) => a + (b - a) * amount;
  const pair = (a: [number, number], b: [number, number]): [number, number] => [
    mix(a[0], b[0]),
    mix(a[1], b[1]),
  ];
  return {
    translate: from.translate && pair(from.translate, to.translate!),
    rotate: from.rotate === undefined ? undefined : mix(from.rotate, to.rotate!),
    scale: from.scale === undefined ? undefined : mix(from.scale, to.scale!),
    opacity: from.opacity === undefined ? undefined : mix(from.opacity, to.opacity!),
    dash: from.dash && pair(from.dash, to.dash!),
    dashOffset: from.dashOffset === undefined ? undefined : mix(from.dashOffset, to.dashOffset!),
  };
}

/**
 * How many milliseconds the frame stays as it is: until the delay ends, or
 * until the end of a held pose. 0 while the motion moves.
 */
export function avatarHold(name: AvatarMotionName, elapsed: number, delay: number): number {
  if (elapsed < delay) return delay - elapsed;
  const { duration, progress, to, holds } = segment(name, elapsed, delay);
  return holds ? (to.at - progress) * duration : 0;
}

export function fitTransform({ fit, shift: [x, y] }: Pick<AvatarScene, "fit" | "shift">): string {
  return `translate(${x} ${y}) translate(20 20) scale(${fit}) translate(-20 -20)`;
}

/** CSS saturate(0.4) brightness(0.85) in sRGB. Both are linear RGB operations,
 * so applying them to the scene's solid fills and strokes preserves blending. */
function mutedPaint(paint: string | undefined): string | undefined {
  if (!paint?.startsWith("#")) return paint;
  const hex = Number.parseInt(paint.slice(1), 16);
  const channels = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  const luminance = 0.213 * channels[0]! + 0.715 * channels[1]! + 0.072 * channels[2]!;
  return (
    "#" +
    channels
      .map((channel) =>
        Math.round(0.85 * (0.4 * channel + 0.6 * luminance))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

export type AvatarSvgOptions = { size: number; clipId: string; muted: boolean; moving: boolean };

/** Adapt the shared shapes to react-native-svg props. Its dash lengths are in user units. */
export function avatarElement(
  shape: AvatarShape,
  { size, clipId, muted, moving }: AvatarSvgOptions,
  frame?: AvatarFrame,
) {
  if (shape.fine && size < AVATAR_FINE_MIN_PX) return null;

  const [ox, oy] = shape.origin ?? [0, 0];
  const rotate = moving ? (frame?.rotate ?? shape.rotate) : (shape.still ?? shape.rotate);
  const transforms: string[] = [];
  if (frame?.translate) transforms.push(`translate(${frame.translate.join(" ")})`);
  if (rotate || frame?.scale !== undefined) {
    transforms.push(`translate(${ox} ${oy})`);
    if (rotate) transforms.push(`rotate(${rotate})`);
    if (frame?.scale !== undefined) transforms.push(`scale(${frame.scale})`);
    transforms.push(`translate(${-ox} ${-oy})`);
  }
  if (shape.transform) transforms.push(shape.transform);

  const dash = frame?.dash ?? shape.dash;
  // The spec's pincer is a circle with SVG pathLength=100. Native SVG has no
  // pathLength prop, so convert the percentages to its actual circumference.
  const unit = shape.kind === "circle" ? (2 * Math.PI * shape.r) / 100 : 1;
  const fill = muted ? mutedPaint(shape.fill) : shape.fill;
  const stroke = muted ? mutedPaint(shape.stroke) : shape.stroke;
  const opacity = frame?.opacity ?? shape.opacity;
  const props = {
    ...(fill !== undefined ? { fill } : {}),
    ...(stroke !== undefined ? { stroke } : {}),
    ...(shape.strokeWidth !== undefined ? { strokeWidth: shape.strokeWidth } : {}),
    ...(shape.round ? { strokeLinecap: "round" as const, strokeLinejoin: "round" as const } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
    ...(dash ? { strokeDasharray: dash.map((length) => length * unit) } : {}),
    ...(frame?.dashOffset !== undefined ? { strokeDashoffset: frame.dashOffset * unit } : {}),
    ...(shape.fixedStroke ? { vectorEffect: "non-scaling-stroke" as const } : {}),
    ...(transforms.length ? { transform: transforms.join(" ") } : {}),
    ...(shape.clip ? { clipPath: `url(#${clipId}-${shape.clip})` } : {}),
  };
  switch (shape.kind) {
    case "group":
      return { kind: shape.kind, props };
    case "path":
      return { kind: shape.kind, props: { ...props, d: shape.d } };
    case "circle":
      return { kind: shape.kind, props: { ...props, cx: shape.cx, cy: shape.cy, r: shape.r } };
    case "ellipse":
      return {
        kind: shape.kind,
        props: { ...props, cx: shape.cx, cy: shape.cy, rx: shape.rx, ry: shape.ry },
      };
    case "rect":
      return {
        kind: shape.kind,
        props: {
          ...props,
          x: shape.x,
          y: shape.y,
          width: shape.width,
          height: shape.height,
          ...(shape.rx !== undefined ? { rx: shape.rx } : {}),
        },
      };
  }
}
