import { createHash } from "node:crypto";
import { buildAddressProblem } from "../src/main/update/address.ts";
import { updateDefines, type Env } from "./update-defines.ts";

export function localFeedAddress(text: string) {
  if (buildAddressProblem(text)) return null;
  const url = new URL(text);
  if (
    url.href !== text ||
    url.hostname.endsWith(".") ||
    url.search ||
    url.hash ||
    text.includes("?") ||
    text.includes("#") ||
    !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/.test(url.pathname)
  )
    return null;
  return url;
}

export function feedFingerprint(url: string) {
  return createHash("sha256").update(url).digest("hex");
}

export function feedAddresses(track: string, selected: string, other?: string) {
  if (
    !localFeedAddress(selected) ||
    (other !== undefined && (!localFeedAddress(other) || other === selected))
  )
    return null;
  const a = feedFingerprint(selected),
    b = other === undefined ? null : feedFingerprint(other);
  return track === "nightly" ? { stable: b, nightly: a } : { stable: a, nightly: b };
}

export function compiledAddresses(track: string, env: Env) {
  const defs = updateDefines(env, new Date());
  const stable: string | null = JSON.parse(defs.__CLAWTRATE_UPDATE_FEED__!);
  const nightly: string | null = JSON.parse(defs.__CLAWTRATE_NIGHTLY_UPDATE_FEED__!);
  const selected = track === "nightly" ? nightly : stable;
  const other = track === "nightly" ? stable : nightly;
  const pair = selected && feedAddresses(track, selected, other ?? undefined);
  if (!pair) throw new Error("Expected canonical, distinct track feed addresses.");
  return pair;
}
