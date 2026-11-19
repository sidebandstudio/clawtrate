// Reads the fuses of a packaged binary and compares them with what packaging
// asks for (`fuses` in config.ts). Used by the launch check, on the app as it
// was built or installed: an app whose fuses were not flipped starts just the
// same, so its starting says nothing about them.

import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { fuses } from "./config.ts";

/** How a fuse wire marks a fuse: the characters "1" and "0". */
const ENABLE = "1".charCodeAt(0);
const DISABLE = "0".charCodeAt(0);

/** The names of the fuses whose state in the binary is not the one packaging sets. */
export async function fuseMismatches(binary: string, platform: string): Promise<string[]> {
  const wire = (await getCurrentFuseWire(binary)) as unknown as Record<number, number>;
  const wanted = fuses(platform) as unknown as Record<string, unknown>;
  return Object.entries(wanted).flatMap(([key, on]) => {
    if (!/^\d+$/.test(key)) return [];
    const option = Number(key);
    return wire[option] === (on ? ENABLE : DISABLE) ? [] : [FuseV1Options[option]!];
  });
}
