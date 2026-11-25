// A newer OpenClaw, as the gateway's own update check reports it: `hello-ok`
// `snapshot.updateAvailable` and the `update.available` event, both
// `{currentVersion, latestVersion, channel}` or null, sent to every connection
// (docs/research/model-catalog.md, section 7).

import { asRecord } from "./mapping.ts";

export type OpenClawUpdate = {
  /** The version the gateway runs. */
  current: string;
  /** The newest version on the gateway's update channel. */
  latest: string;
  /** That channel's npm tag: `latest` for stable, or `beta`, `dev`, `extended-stable`. */
  channel: string | null;
};

/** A channel's tag as OpenClaw writes one. */
const CHANNEL = /^[a-z][a-z-]{0,31}$/;

/**
 * A version as OpenClaw writes one: numbers joined by dots, then an optional pre-release part
 * and an optional build part, each on its own (`2026.11.6`, `2026.11.10-beta.1`,
 * `2026.11.6-beta.1+build.7`). A word such as `unknown` is not one.
 */
const VERSION = /^v?\d+(\.\d+){1,3}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** The longest version kept: a longer one is not a version this client shows. */
const MAX_VERSION_CHARS = 64;

/** Whether a string is a version as OpenClaw writes one, within `MAX_VERSION_CHARS`. */
export const isOpenClawVersion = (value: string) =>
  value.length <= MAX_VERSION_CHARS && VERSION.test(value);
const isVersion = isOpenClawVersion;

/** The gateway's `updateAvailable`, or null when it reports none or something else. */
export function readOpenClawUpdate(value: unknown): OpenClawUpdate | null {
  const record = asRecord(value);
  const current = record?.currentVersion;
  const latest = record?.latestVersion;
  if (typeof current !== "string" || typeof latest !== "string") return null;
  if (!isVersion(current) || !isVersion(latest) || current === latest) return null;
  const channel =
    typeof record?.channel === "string" && CHANNEL.test(record.channel) ? record.channel : null;
  return { current, latest, channel };
}
