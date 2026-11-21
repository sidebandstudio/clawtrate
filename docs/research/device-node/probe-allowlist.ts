import { asRecord } from "../../../packages/core/src/mapping.ts";

/** Read the stored allowlist and its revision from a confirmed config snapshot. */
export function readProbeAllowlist(snapshot: unknown): { hash: string; allow: string[] } {
  const answer = asRecord(snapshot);
  if (answer?.valid !== true)
    throw new Error("config.get did not confirm a valid configuration; stopping this experiment");
  if (typeof answer.hash !== "string" || !answer.hash.trim())
    throw new Error("config.get did not return a configuration hash; stopping this experiment");

  const hash = answer.hash;
  let section = asRecord(answer.config);
  if (!section) throw new Error("config.get did not return a configuration object");

  for (const key of ["gateway", "nodes", "commands"]) {
    if (!Object.hasOwn(section, key)) return { hash, allow: [] };
    section = asRecord(section[key]);
    if (!section) throw new Error("config.get returned an invalid gateway node configuration");
  }

  if (!Object.hasOwn(section, "allow")) return { hash, allow: [] };
  const allow = section.allow;
  if (!Array.isArray(allow) || !allow.every((command) => typeof command === "string"))
    throw new Error("config.get returned an invalid node command allowlist");
  return { hash, allow };
}
