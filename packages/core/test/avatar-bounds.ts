// How far a creature reaches from the centre of its 40-unit grid, in every pose
// its motions pass through: the circle the app and its saved picture crop to
// has radius 20. Conservative: a curve is bounded by its control points, a
// stroke by half its width all round, and a part clipped to an eye is left to
// the eye that clips it.
import {
  AVATAR_MOTIONS,
  type AvatarKeyframe,
  type AvatarScene,
  type AvatarShape,
} from "../src/avatar.ts";

type M = [number, number, number, number, number, number]; // a b c d e f, as SVG
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5],
];
const translate = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const scale = (k: number): M => [k, 0, 0, k, 0, 0];
const rotate = (deg: number): M => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};
const about = (x: number, y: number, m: M) => mul(translate(x, y), mul(m, translate(-x, -y)));
const apply = (m: M, [x, y]: [number, number]): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
/** How much a matrix can stretch a length: its largest singular value. */
const stretch = (m: M) => {
  const [a, b, c, d] = m;
  const s = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  return Math.sqrt((s + Math.sqrt(Math.max(0, s * s - 4 * det * det))) / 2);
};

function parseTransform(text: string): M {
  let m = I;
  for (const [, name, args] of text.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const n = args!
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (name === "translate") m = mul(m, translate(n[0]!, n[1] ?? 0));
    else if (name === "scale") m = mul(m, scale(n[0]!));
    else if (name === "rotate")
      m = mul(m, n.length === 3 ? about(n[1]!, n[2]!, rotate(n[0]!)) : rotate(n[0]!));
    else throw new Error(`transform ${name}`);
  }
  return m;
}

/** Every end and control point of a path. */
function pathPoints(d: string): Array<[number, number]> {
  const tokens = d.match(/[MLQCSHVZ]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi)!;
  const out: Array<[number, number]> = [];
  let command = "";
  let x = 0;
  let y = 0;
  let control: [number, number] = [0, 0];
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i]!)) command = tokens[i++]!;
    if (command === "Z") continue;
    if (command === "H") x = num();
    else if (command === "V") y = num();
    else if (command === "M" || command === "L") [x, y] = [num(), num()];
    else if (command === "Q") {
      out.push([num(), num()]);
      [x, y] = [num(), num()];
    } else if (command === "C") {
      out.push([num(), num()]);
      control = [num(), num()];
      out.push(control);
      [x, y] = [num(), num()];
    } else if (command === "S") {
      out.push([2 * x - control[0], 2 * y - control[1]]);
      control = [num(), num()];
      out.push(control);
      [x, y] = [num(), num()];
    } else throw new Error(`path ${command}`);
    out.push([x, y]);
  }
  return out;
}

/** Points on a shape's outline in its own space, and the stroke's half width. */
function outline(shape: AvatarShape): { points: Array<[number, number]>; pad: number } {
  const pad = shape.stroke && shape.stroke !== "none" ? (shape.strokeWidth ?? 1) / 2 : 0;
  const ring = (cx: number, cy: number, rx: number, ry: number) =>
    Array.from({ length: 48 }, (_, k): [number, number] => {
      const t = (k / 48) * Math.PI * 2;
      return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
    });
  switch (shape.kind) {
    case "circle":
      return { points: ring(shape.cx, shape.cy, shape.r, shape.r), pad };
    case "ellipse":
      return { points: ring(shape.cx, shape.cy, shape.rx, shape.ry), pad };
    case "rect":
      return {
        points: [
          [shape.x, shape.y],
          [shape.x + shape.width, shape.y],
          [shape.x, shape.y + shape.height],
          [shape.x + shape.width, shape.y + shape.height],
        ],
        pad,
      };
    case "path":
      return { points: pathPoints(shape.d), pad };
    default:
      return { points: [], pad };
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The poses a motion passes through, sampled between its keyframes, each with its opacity. */
function poses(name: keyof typeof AVATAR_MOTIONS, origin: [number, number]) {
  const frames = AVATAR_MOTIONS[name].frames;
  const out: Array<{ m: M; opacity: number }> = [];
  const at = (f: AvatarKeyframe, g: AvatarKeyframe, t: number) => {
    const r = lerp(f.rotate ?? 0, g.rotate ?? 0, t);
    const k = lerp(f.scale ?? 1, g.scale ?? 1, t);
    const tx = lerp(f.translate?.[0] ?? 0, g.translate?.[0] ?? 0, t);
    const ty = lerp(f.translate?.[1] ?? 0, g.translate?.[1] ?? 0, t);
    const opacity = lerp(f.opacity ?? 1, g.opacity ?? 1, t);
    // CSS order: translate, rotate, scale, all about the origin.
    return {
      m: about(origin[0], origin[1], mul(translate(tx, ty), mul(rotate(r), scale(k)))),
      opacity,
    };
  };
  for (let n = 0; n + 1 < frames.length; n++)
    for (let s = 0; s <= 8; s++) {
      const pose = at(frames[n]!, frames[n + 1]!, s / 8);
      // A pose takes the opacity of the stretch just before it too: a ring fading to nothing as
      // it grows is still faintly there right up to its widest.
      const before = s > 0 ? at(frames[n]!, frames[n + 1]!, (s - 1) / 8).opacity : pose.opacity;
      out.push({ m: pose.m, opacity: Math.max(pose.opacity, before) });
    }
  return out;
}

/** The poses a shape's own placement takes: its pose rotation, or its motion, or its still pose. */
function placements(shape: AvatarShape): Array<{ m: M; opacity: number }> {
  const origin = shape.origin ?? [0, 0];
  const base = shape.transform ? parseTransform(shape.transform) : I;
  const own = (m: M) => mul(m, base);
  const list: Array<{ m: M; opacity: number }> = [];
  if (shape.motion)
    for (const pose of poses(shape.motion, origin))
      list.push({ m: own(pose.m), opacity: pose.opacity });
  else
    list.push({
      m: own(shape.rotate ? about(origin[0], origin[1], rotate(shape.rotate)) : I),
      opacity: 1,
    });
  if (shape.still !== undefined)
    list.push({ m: own(about(origin[0], origin[1], rotate(shape.still))), opacity: 1 });
  return list;
}

/**
 * Every visible point of the scene, fitted as the renderer fits it, with
 * strokes widened out in eight directions. Every pose with any opacity at all
 * counts, however faint.
 */
export function scenePoints(scene: AvatarScene, fitted = true): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const fit = fitted ? about(20, 20, scale(scene.fit)) : I;
  const shift = fitted && scene.shift ? translate(scene.shift[0], scene.shift[1]) : I;
  const walk = (shape: AvatarShape, parents: Array<{ m: M; opacity: number }>) => {
    if (shape.clip) return;
    const mine: Array<{ m: M; opacity: number }> = [];
    for (const parent of parents)
      for (const p of placements(shape))
        mine.push({ m: mul(parent.m, p.m), opacity: parent.opacity * p.opacity });
    if (shape.kind === "group") {
      for (const child of shape.children) walk(child, mine);
      return;
    }
    const { points, pad } = outline(shape);
    for (const { m, opacity } of mine) {
      if (opacity * (shape.opacity ?? 1) <= 0) continue;
      // A stroke that keeps its width on screen: at 18 px one pixel is 40/18 grid units.
      const width = shape.fixedStroke ? ((shape.strokeWidth ?? 1) * 40) / 18 / 2 : pad * stretch(m);
      for (const point of points) {
        const [x, y] = apply(m, point);
        if (width === 0) out.push([x, y]);
        else
          for (let k = 0; k < 8; k++) {
            const t = (k / 8) * Math.PI * 2;
            out.push([
              x + (width / Math.cos(Math.PI / 8)) * Math.cos(t),
              y + (width / Math.cos(Math.PI / 8)) * Math.sin(t),
            ]);
          }
      }
    }
  };
  walk(scene.root, [{ m: mul(shift, fit), opacity: 1 }]);
  return out;
}

/** The farthest any visible point of the scene, fitted, reaches from the grid's centre (20, 20). */
export function sceneReach(scene: AvatarScene): number {
  let reach = 0;
  for (const [x, y] of scenePoints(scene)) reach = Math.max(reach, Math.hypot(x - 20, y - 20));
  return reach;
}

/** The convex hull of some points: all the smallest enclosing circle needs. */
export function hull(points: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Array<[number, number]>) => {
    const out: Array<[number, number]> = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0)
        out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

/** The smallest circle round some points, near enough: its centre and radius. */
export function enclosing(all: Array<[number, number]>): { x: number; y: number; r: number } {
  const points = hull(all);
  let x = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  let y = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  let step = 1;
  for (let n = 0; n < 4000; n++) {
    let far = points[0]!;
    let best = 0;
    for (const p of points) {
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d > best) [best, far] = [d, p];
    }
    x += (far[0] - x) * step;
    y += (far[1] - y) * step;
    step *= 0.995;
  }
  let r = 0;
  for (const p of points) r = Math.max(r, Math.hypot(p[0] - x, p[1] - y));
  return { x, y, r };
}
