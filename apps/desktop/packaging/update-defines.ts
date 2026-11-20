// The build fixes each track’s optional address and the build’s own release date.

import { buildAddressProblem } from "../src/main/update/address.ts";

import { macSigningRequested, windowsSigningRequested } from "./signing.ts";

export type Env = Record<string, string | undefined>;

export function updateDefines(env: Env, now: Date): Record<string, string> {
  function feed(key: string) {
    const address = env[key]?.trim() || null;
    if (address) {
      const problem = buildAddressProblem(address);
      if (problem) throw new Error(`${key} ${problem}.`);
    }
    return address;
  }
  const address = feed("CLAWTRATE_UPDATE_FEED_URL");
  const nightly = feed("CLAWTRATE_NIGHTLY_UPDATE_FEED_URL");
  const pin = env.CLAWTRATE_WINDOWS_UPDATE_CERT_SHA256?.trim().toUpperCase();
  if (pin && !/^[A-F0-9]{64}$/.test(pin))
    throw Error("Invalid Windows update publisher fingerprint");
  return {
    __CLAWTRATE_SIGNED_MAC__: JSON.stringify(macSigningRequested(env)),
    __CLAWTRATE_WINDOWS_PUBLISHER__: JSON.stringify(
      windowsSigningRequested(env) ? (pin ?? null) : null,
    ),
    __CLAWTRATE_NIGHTLY_UPDATE_FEED__: JSON.stringify(nightly),
    __CLAWTRATE_UPDATE_FEED__: JSON.stringify(address),
    __CLAWTRATE_RELEASE_DATE__: JSON.stringify(releaseDate(env, now)),
  };
}

/** SOURCE_DATE_EPOCH (whole seconds) when set, otherwise `now`, as an ISO time. */
export function releaseDate(env: Env, now: Date): string {
  const epoch = env.SOURCE_DATE_EPOCH?.trim();
  if (!epoch) return now.toISOString();
  if (!/^\d{1,11}$/.test(epoch)) throw new Error("SOURCE_DATE_EPOCH must be whole seconds.");
  return new Date(Number(epoch) * 1000).toISOString();
}
