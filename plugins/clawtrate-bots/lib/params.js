// A tool call's parameters read the way OpenClaw's tools read them, so the
// plugin decides on what the tool will act on. Both versions read a string
// parameter with `readToolStringParam` (2026.10.6 dist/common-8Tuh4jUl.mjs:16-25;
// the same in 2026.11.10): the camelCase key when the call has it at all,
// else its snake_case twin (dist/param-key-BvJDza_v.mjs:3-15), trimmed, and
// absent when not a non-empty string. Where the two spellings are both given
// and differ, the plugin can't be sure which one a tool reads, and says so.

export class Ambiguous extends Error {}

/** `agentId` -> `agent_id`, as OpenClaw's `toSnakeCaseKey` does. */
export function snakeKey(key) {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * A string parameter, as the tool reads it. Throws `Ambiguous` when the
 * camelCase key and its snake_case twin are both present and differ.
 */
export function readParam(params, key) {
  if (!isRecord(params)) return undefined;
  const snake = snakeKey(key);
  const hasKey = Object.hasOwn(params, key);
  const hasSnake = snake !== key && Object.hasOwn(params, snake);
  if (hasKey && hasSnake && text(params[key]) !== text(params[snake]))
    throw new Ambiguous(`${key} and ${snake} name different things`);
  return text(hasKey ? params[key] : hasSnake ? params[snake] : undefined);
}

/** The first of several keys the tool reads in turn (`jobId`, then `id`), each in both spellings. */
export function readFirst(params, keys) {
  const found = keys.map((key) => readParam(params, key)).filter((v) => v !== undefined);
  if (new Set(found).size > 1) throw new Ambiguous(`${keys.join(" and ")} name different things`);
  return found[0];
}

/** The bot a session key names (`agent:<bot>:…`), lower case, or null. */
export const botOfKey = (key) => /^agent:([^:]+):/i.exec(key ?? "")?.[1]?.toLowerCase() ?? null;
