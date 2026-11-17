// Generated avatars for the sample bots: a geometric motif on a soft gradient.
// Rendered with 4x4 supersampling straight into a PNG, no image assets involved.

import { encodePng } from "../../brand/src/png.ts";
import type { SeedBot } from "./seed-data.ts";

type Rgb = [number, number, number];

function hex(color: string): Rgb {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Returns the motif color weight (0..1) and which accent to use at a point in [-1, 1]². */
function motif(kind: SeedBot["avatar"]["motif"], x: number, y: number): [number, 0 | 1] {
  const r = Math.hypot(x, y);
  switch (kind) {
    case "rings": {
      // Concentric rings, offset toward the lower left like rising sap.
      const d = Math.hypot(x + 0.35, y - 0.35);
      const band = Math.floor(d / 0.22);
      return d < 1.2 && band % 2 === 0 ? [1, band % 4 === 0 ? 1 : 0] : [0, 0];
    }
    case "stripes": {
      // Diagonal ink strokes of varying width.
      const t = (x + y) * 2.2;
      const stripe = Math.floor(t);
      const frac = t - stripe;
      return frac < 0.42 + 0.1 * Math.sin(stripe) ? [1, stripe % 2 === 0 ? 1 : 0] : [0, 0];
    }
    case "petals": {
      // A six-petal rose curve, like a compass card.
      const theta = Math.atan2(y, x);
      const petal = Math.abs(Math.cos(3 * theta)) * 0.78;
      if (r < 0.16) return [1, 1];
      return r < petal ? [1, 0] : [0, 0];
    }
    case "grid": {
      // Rounded tiles, a few lit like status lights.
      const cell = 0.5;
      const cx = Math.floor((x + 1) / cell);
      const cy = Math.floor((y + 1) / cell);
      const lx = ((x + 1) % cell) / cell - 0.5;
      const ly = ((y + 1) % cell) / cell - 0.5;
      const inside = Math.max(Math.abs(lx), Math.abs(ly)) < 0.32;
      return inside ? [1, (cx * 3 + cy) % 5 === 1 ? 1 : 0] : [0, 0];
    }
  }
}

export function renderAvatar(bot: SeedBot, size = 256): Buffer {
  const [base, accent, highlight] = bot.avatar.colors.map(hex) as [Rgb, Rgb, Rgb];
  const deep = mix(base, [8, 10, 16], 0.45);
  const data = new Uint8Array(size * size * 4);
  const samples = 4;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let color: Rgb = [0, 0, 0];
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = ((px + (sx + 0.5) / samples) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / samples) / size) * 2 - 1;
          const background = mix(base, deep, (x + y + 2) / 4);
          const [weight, which] = motif(bot.avatar.motif, x, y);
          const ink = which === 1 ? highlight : accent;
          const sample = mix(background, ink, weight * 0.92);
          color = [color[0] + sample[0], color[1] + sample[1], color[2] + sample[2]];
        }
      }
      const n = samples * samples;
      const o = (py * size + px) * 4;
      data[o] = Math.round(color[0] / n);
      data[o + 1] = Math.round(color[1] / n);
      data[o + 2] = Math.round(color[2] / n);
      data[o + 3] = 255;
    }
  }
  return encodePng({ width: size, height: size, data });
}
