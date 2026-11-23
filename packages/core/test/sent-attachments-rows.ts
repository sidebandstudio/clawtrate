// A person's message with files, as OpenClaw 2026.10.6 keeps it, recorded on a
// development gateway: Clawtrate's web client attached the files and sent them
// with `chat.send` (#451). The row's text is a plain string; each file is a
// `__openclaw.media` entry, in the order sent, naming a `media://inbound`
// reference that no method or route serves. `artifacts.list` for these tasks
// was empty. The same row arrived in the live `session.message` event. Sender
// fields and other values unrelated to the files are left out; ids are the
// development gateway's own.

import { deflateSync } from "node:zlib";

/** A user row for the message `id` sent, with these `__openclaw.media` entries. */
export function sentRow(
  id: string,
  text: string,
  media: Record<string, unknown>[],
  seq = 1,
): Record<string, unknown> {
  const pictures = media.flatMap((entry, factIndex) =>
    entry.kind === "image" ? [{ kind: "offloaded", factIndex }] : [],
  );
  return {
    role: "user",
    content: text,
    timestamp: 1_795_474_912_358,
    idempotencyKey: `${id}:user`,
    __openclaw: {
      transport: { clients: [{ id: "gateway-client", mode: "ui", displayName: "Clawtrate Web" }] },
      media,
      ...(pictures.length > 0 ? { mediaImageLayout: { slots: pictures } } : {}),
      id: `row-${id}`,
      idempotencyKey: `${id}:user`,
      seq,
    },
  };
}

export const SHOT = {
  url: "media://inbound/shot---73854bc7-ae01-4c53-8af5-f02e678613b1.png",
  contentType: "image/png",
  kind: "image",
  fileName: "shot.png",
  sizeBytes: 111,
};
export const NOTES = {
  url: "media://inbound/notes---39760378-90b0-4849-a402-b70adcbafdce.txt",
  contentType: "text/plain",
  kind: "document",
  fileName: "notes.txt",
  sizeBytes: 10,
  hydrationSuppressed: true,
};
export const FIRST = {
  url: "media://inbound/first---77e53ce8-8f25-46ff-9ba6-ce305f02107c.png",
  contentType: "image/png",
  kind: "image",
  fileName: "first.png",
  sizeBytes: 111,
};
export const SECOND = {
  url: "media://inbound/second---6708cf71-c136-429f-9d4f-516f031cd050.png",
  contentType: "image/png",
  kind: "image",
  fileName: "second.png",
  sizeBytes: 88,
};

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** A PNG of one colour, made here: no one's picture. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) raw.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
