// Reads the fuses of a packaged binary and compares them with what packaging
// asks for (`fuses` in config.ts). Used by the launch check, on the app as it
// was built or installed: an app whose fuses were not flipped starts just the
// same, so its starting says nothing about them.

import { FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import { open } from "node:fs/promises";
import { fuses } from "./config.ts";

/** How a fuse wire marks a fuse: the characters "1" and "0". */
const ENABLE = "1".charCodeAt(0);
const DISABLE = "0".charCodeAt(0);
const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const FUSE_HEADER_SIZE = 2;

async function windowsFuseWire(binary: string): Promise<Uint8Array> {
  const file = await open(binary, "r");
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let position = 0;
    let retained = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, retained, buffer.length - retained, position);
      if (bytesRead === 0)
        throw new Error("Could not find the fuse marker in the Windows executable");
      const chunk = buffer.subarray(0, retained + bytesRead);
      const marker = chunk.indexOf(FUSE_SENTINEL);
      if (marker !== -1) {
        const wire = Buffer.alloc(FUSE_HEADER_SIZE + 255);
        const wirePosition = position - retained + marker + FUSE_SENTINEL.length;
        const { bytesRead: wireBytes } = await file.read(wire, 0, wire.length, wirePosition);
        const end = FUSE_HEADER_SIZE + wire.readUInt8(1);
        if (wireBytes < end) throw new Error("The Windows executable's fuse wire is truncated");
        if (wire.readUInt8(0) !== Number(FuseVersion.V1)) {
          throw new Error("The Windows executable has an unsupported fuse wire version");
        }
        return wire.subarray(FUSE_HEADER_SIZE, end);
      }
      position += bytesRead;
      retained = Math.min(chunk.length, FUSE_SENTINEL.length - 1);
      chunk.copy(buffer, 0, chunk.length - retained);
    }
  } finally {
    await file.close();
  }
}

/** The names of the fuses whose state in the binary is not the one packaging sets. */
export async function fuseMismatches(binary: string, platform: string): Promise<string[]> {
  const wire =
    platform === "win32"
      ? await windowsFuseWire(binary)
      : ((await getCurrentFuseWire(binary)) as unknown as Record<number, number>);
  const wanted = fuses(platform) as unknown as Record<string, unknown>;
  return Object.entries(wanted).flatMap(([key, on]) => {
    if (!/^\d+$/.test(key)) return [];
    const option = Number(key);
    return wire[option] === (on ? ENABLE : DISABLE) ? [] : [FuseV1Options[option]!];
  });
}
