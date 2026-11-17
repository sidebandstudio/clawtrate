// Minimal PNG codec for build scripts: 8-bit RGB/RGBA, non-interlaced.
// Enough to read the logo and write icons without a native image dependency.

import { deflateSync, inflateSync } from "node:zlib";

export type Image = { width: number; height: number; data: Uint8Array /* RGBA */ };

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng(image: Image): Buffer {
  const { width, height, data } = image;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(file: Uint8Array): Image {
  const buf = Buffer.from(file);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < buf.length;) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colorType = body[9]!;
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) {
        throw new Error("only 8-bit, non-interlaced RGB or RGBA PNG files are supported");
      }
    } else if (type === "IDAT") {
      idat.push(body);
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x]!;
      const left = x >= channels ? pixels[dst + x - channels]! : 0;
      const up = y > 0 ? pixels[dst - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[dst - stride + x - channels]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + left;
          break;
        case 2:
          out = value + up;
          break;
        case 3:
          out = value + ((left + up) >> 1);
          break;
        case 4:
          out = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      pixels[dst + x] = out & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i += 1, j += channels) {
    data[i * 4] = pixels[j]!;
    data[i * 4 + 1] = pixels[j + 1]!;
    data[i * 4 + 2] = pixels[j + 2]!;
    data[i * 4 + 3] = channels === 4 ? pixels[j + 3]! : 255;
  }
  return { width, height, data };
}

/** Area-average downscale. Each output pixel averages the source area it covers. */
export function resize(image: Image, width: number, height: number): Image {
  const out = new Uint8Array(width * height * 4);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < width; x += 1) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let coverage = 0;
      let total = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py += 1) {
        const wy = Math.min(py + 1, y1) - Math.max(py, y0);
        for (let px = Math.floor(x0); px < Math.ceil(x1); px += 1) {
          const w = wy * (Math.min(px + 1, x1) - Math.max(px, x0));
          const i = (py * image.width + px) * 4;
          const alpha = image.data[i + 3]! / 255;
          // Premultiply so transparent pixels do not darken edges.
          r += image.data[i]! * alpha * w;
          g += image.data[i + 1]! * alpha * w;
          b += image.data[i + 2]! * alpha * w;
          coverage += alpha * w;
          total += w;
        }
      }
      const o = (y * width + x) * 4;
      if (coverage > 0) {
        out[o] = Math.round(r / coverage);
        out[o + 1] = Math.round(g / coverage);
        out[o + 2] = Math.round(b / coverage);
      }
      out[o + 3] = Math.round((coverage / total) * 255);
    }
  }
  return { width, height, data: out };
}

/**
 * Chunks that carry provenance, text or camera metadata rather than pixels.
 * The logo must not publish any of them.
 */
export const METADATA_CHUNKS = ["caBX", "tEXt", "iTXt", "zTXt", "eXIf"] as const;

/** Chunk types in file order. */
export function listChunks(file: Uint8Array): string[] {
  const buf = Buffer.from(file);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  const types: string[] = [];
  for (let offset = 8; offset < buf.length;) {
    const length = buf.readUInt32BE(offset);
    types.push(buf.toString("ascii", offset + 4, offset + 8));
    offset += 12 + length;
  }
  return types;
}

/**
 * Copy a PNG without its metadata chunks. Every other chunk, including the
 * image data, is copied byte for byte, so the pixels are unchanged.
 */
export function stripMetadataChunks(file: Uint8Array): Buffer {
  const buf = Buffer.from(file);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  const kept: Buffer[] = [SIGNATURE];
  for (let offset = 8; offset < buf.length;) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (!(METADATA_CHUNKS as readonly string[]).includes(type))
      kept.push(buf.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(kept);
}
