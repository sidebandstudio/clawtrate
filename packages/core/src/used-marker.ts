// "This person has used Clawtrate with this gateway": one key in the person's own preferences on
// the gateway (`users.prefs`, key `clawtrate.used`), holding only the version of the app that first
// wrote it. The first run reads it to tell someone who already works in Clawtrate from someone new
// (`docs/design/main-bot-onboarding.md` section 15.7): a marker older than the build that ships the
// first run means "before", and one written by that build or later never does. So it is written
// once, when missing, from before the first run ships, and never changed, wherever this connection
// may write the person's preferences: it holds `operator.write` and isn't a read-only viewer. A read-only connection writes nothing; the
// device's own record of the gateway stands in for it. Reading is `operator.read` on OpenClaw
// 2026.10.6 and 2026.11.10. A connection with no durable user (a shared token) has no preferences,
// and nothing is written.

import { asRecord } from "./mapping.ts";

export const USED_PREF_KEY = "clawtrate.used";
/** The longest version written: a version string is far shorter; anything longer isn't one. */
export const MAX_USED_VERSION_CHARS = 64;

type Context = {
  request: (method: string, params: unknown) => Promise<unknown>;
  /** Whether this connection may write the person's preferences now. */
  canWrite: () => boolean;
};

export type UsedMark = "current" | "written" | "not-written";

/**
 * Read the marker, and write it when it is missing and this connection may write. A
 * compare-and-set against its absence: another device writing at the same moment wins, and
 * nothing is retried, since its value says the same.
 */
export async function markUsed(ctx: Context, version: string): Promise<UsedMark> {
  if (!version || version.length > MAX_USED_VERSION_CHARS) return "not-written";
  const read = asRecord(await ctx.request("users.prefs.get", { keys: [USED_PREF_KEY] }));
  if (read?.status !== "ok") return "not-written";
  const entries = asRecord(read.entries) ?? {};
  const raw = Object.hasOwn(entries, USED_PREF_KEY) ? entries[USED_PREF_KEY] : null;
  // Any value at all is a marker kept: what first wrote it is never overwritten.
  if (raw !== null && raw !== undefined) return "current";
  if (!ctx.canWrite()) return "not-written";
  const result = asRecord(
    await ctx.request("users.prefs.set", {
      entries: { [USED_PREF_KEY]: { version } },
      expectedEntries: { [USED_PREF_KEY]: null },
    }),
  );
  return result?.status === "ok" ? "written" : "not-written";
}
