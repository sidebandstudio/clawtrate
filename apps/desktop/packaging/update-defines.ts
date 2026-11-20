// The two constants the build writes into the main process's bundle for the
// update engine (`src/main/update/build-info.ts`): the feed's address, from
// CLAWTRATE_UPDATE_FEED_URL at build time, and the build's own release date,
// from SOURCE_DATE_EPOCH or the time of the build. The packaged app cannot
// change either.

import { buildAddressProblem } from "../src/main/update/address.ts";

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
  if (nightly && !address) throw new Error("The nightly feed needs a stable feed.");
  return {
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
