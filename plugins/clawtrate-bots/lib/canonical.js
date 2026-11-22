// The canonical form a record's digest covers: keys sorted, undefined left out.

import { createHash, randomBytes } from "node:crypto";

const sorted = (value) => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  }
  return value;
};

export const canonical = (value) => JSON.stringify(sorted(value));
export const digestOf = (value) => createHash("sha256").update(canonical(value)).digest("hex");
export const newId = (prefix) => `${prefix}_${randomBytes(8).toString("hex")}`;
/** The deciding device, hashed: records never hold a device id. */
export const hashDevice = (id) =>
  typeof id === "string" && id
    ? createHash("sha256").update(`clawtrate-bots\0${id}`).digest("hex").slice(0, 16)
    : null;
