// Versions are MAJOR.MINOR.PATCH and nothing else: no prerelease, no build
// metadata, no leading zeros. Anything else in a feed makes it malformed.

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export type Version = readonly [number, number, number];

export function parseVersion(text: unknown): Version | null {
  if (typeof text !== "string") return null;
  const match = VERSION.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True only when `candidate` is strictly greater than `current`. */
export function isNewer(candidate: Version, current: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (candidate[i]! !== current[i]!) return candidate[i]! > current[i]!;
  }
  return false;
}

export function formatVersion(version: Version): string {
  return version.join(".");
}
