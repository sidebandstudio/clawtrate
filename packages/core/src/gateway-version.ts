// The gateway's OpenClaw version as it reports it (`hello-ok` `server.version`), compared by its
// year, month and patch. A version that is missing or isn't in that form compares as older: a
// behaviour that needs a newer gateway stays off rather than being guessed.
export function openClawAtLeast(
  version: string | null | undefined,
  year: number,
  month: number,
  patch = 0,
): boolean {
  const match = /^v?(\d{4})\.(\d{1,2})\.(\d{1,3})(?![\d])/.exec(version ?? "");
  if (!match) return false;
  const [y, m, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y !== year) return y > year;
  if (m !== month) return m > month;
  return p >= patch;
}
