// The stand-in image provider of an instance started with `--with-images`. The
// scripted model server answers the OpenAI-style endpoint the gateway's bundled
// LiteLLM image provider calls (`POST <baseUrl>/images/generations`, JSON
// `{model, prompt, n, size}`), with one fixed picture this file draws. No
// picture comes from anywhere else and nothing leaves the machine
// (docs/research/image-generation.md, research in #172).

import { crc32, deflateSync } from "node:zlib";

/** The bundled provider the gateway calls: its config entry is `models.providers.litellm`. */
export const IMAGE_PROVIDER_ID = "litellm";
export const IMAGE_MODEL_REF = `${IMAGE_PROVIDER_ID}/scripted-image-1`;
/** A made-up key: the provider sends no request without one. */
export const IMAGE_API_KEY = "example-image-key";
export const IMAGES_PATH = "/v1/images/generations";

/** The fixed picture's side, in pixels. */
export const PICTURE_SIZE = 256;

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG of solid shapes: a sky, a sun, a hill and the ground. The same bytes every time. */
export function scriptedPicture(size: number = PICTURE_SIZE): Buffer {
  const row = 1 + size * 3;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const hill = (x - size * 0.35) ** 2 + (y - size * 0.95) ** 2 < (size * 0.45) ** 2;
      const sun = (x - size * 0.7) ** 2 + (y - size * 0.3) ** 2 < (size * 0.12) ** 2;
      const color =
        y > size * 0.8
          ? [0x2b, 0x5e, 0x47]
          : hill
            ? [0x3f, 0x8f, 0x6b]
            : sun
              ? [0xf2, 0xb8, 0x3c]
              : [0x1f, 0x3a, 0x5f];
      raw.set(color, y * row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The answer to an image request: one picture for each of `n`, at most four, as LiteLLM's are. */
export function imagesAnswer(body: unknown, authorization: string | undefined) {
  if (authorization !== `Bearer ${IMAGE_API_KEY}`)
    return { status: 401, body: { error: { message: "Invalid API key (scripted)" } } };
  const request = (typeof body === "object" && body !== null ? body : {}) as { n?: unknown };
  const count = Math.min(Math.max(Math.trunc(Number(request.n) || 1), 1), 4);
  const picture = scriptedPicture().toString("base64");
  return {
    status: 200,
    body: {
      created: Math.floor(Date.now() / 1000),
      data: Array.from({ length: count }, () => ({ b64_json: picture })),
    },
  };
}
