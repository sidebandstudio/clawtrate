// A bot's chosen model on the model list that limits it (#799). OpenClaw checks every model a
// visible task is started on against the bot's model list (`modelPolicy.allow`), while the bot's
// own model runs its conversations off that list. So when Clawtrate sets a bot's model, or the
// person presses "Allow <model>", the exact `<provider>/<model>` is appended to the one list that
// governs that bot, in the same `config.patch` as the model, and only when that list limits the
// bot and doesn't already allow the model as the running version reads it. Undo takes that one
// entry out again, while it is still there, held to the config's hash. Nothing else is written:
// no wildcard, no other model, no list where none was, no other bot's list.

import { openClawAtLeast } from "./gateway-version.ts";
import { MAX_ALLOWLIST_ENTRIES } from "./accounts.ts";
import { asRecord } from "./mapping.ts";

type Raw = Record<string, unknown>;

/** Whose list limits the bot: its own, the gateway's default, or the old `agents.defaults.models`. */
export type AllowListPlace = "bot" | "gateway" | "models";

/** The list that governs one bot, as the gateway resolves it (`resolveConfiguredModelPolicyAllow`). */
type Governing = { place: AllowListPlace; path: string; raw: unknown[]; keys: string[] };

function governing(config: Raw | null, botId: string): Governing | null {
  const root = asRecord(config?.config);
  const agents = asRecord(root?.agents);
  const defaults = asRecord(agents?.defaults);
  const own = asRecord(asRecord(asRecord(agents?.entries)?.[botId])?.modelPolicy);
  const policy = asRecord(defaults?.modelPolicy);
  const migrated = asRecord(asRecord(root?.meta)?.migrations)?.modelPolicyAllowlist === true;
  let found: Omit<Governing, "keys"> | null = null;
  if (own && Object.hasOwn(own, "allow"))
    found = {
      place: "bot",
      path: `agents.entries.${botId}.modelPolicy.allow`,
      raw: Array.isArray(own.allow) ? own.allow : [],
    };
  else if (policy && Object.hasOwn(policy, "allow"))
    found = {
      place: "gateway",
      path: "agents.defaults.modelPolicy.allow",
      raw: Array.isArray(policy.allow) ? policy.allow : [],
    };
  else if (!policy && !migrated)
    found = {
      place: "models",
      path: "agents.defaults.models",
      raw: Object.keys(asRecord(defaults?.models) ?? {}),
    };
  if (!found) return null;
  const keys = found.raw
    .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
    .map((ref) => ref.trim());
  return { ...found, keys };
}

/** A model reference as a list entry names it: `<provider>/<model>`, with no account. */
export type AllowRef = { provider: string; model: string };

export const allowEntry = (ref: AllowRef): string => `${ref.provider}/${ref.model}`;

/**
 * Whether a list's entries allow the model, as the version the gateway reports reads them: an
 * exact entry (the provider in any case, the model as written), `<provider>/*`, and a wildcard
 * that ends in a whole `*` segment (`openrouter/anthropic/*`), on both versions; and from
 * 2026.11.10 a prefix (`openai/gpt-*`). Read narrowly: an entry this misreads as not allowing
 * makes one exact entry more, never a wider one.
 */
export function listAllows(keys: string[], ref: AllowRef, serverVersion: string | null): boolean {
  const provider = ref.provider.trim().toLowerCase();
  const key = `${provider}/${ref.model}`;
  const prefixes = openClawAtLeast(serverVersion, 2026, 11, 10);
  return keys.some((entry) => {
    const slash = entry.indexOf("/");
    if (slash <= 0) return false;
    const written = `${entry.slice(0, slash).trim().toLowerCase()}/${entry.slice(slash + 1)}`;
    if (!written.endsWith("*")) return written === key;
    const stem = written.slice(0, -1);
    // A whole last segment (`…/*`): both versions match any model under it.
    if (stem.endsWith("/")) return key.startsWith(stem) && key.length > stem.length;
    return prefixes && key.startsWith(stem);
  });
}

/** What one write adds to a bot's model list, beside the model it sets. */
export type AllowAddition = {
  patch: Raw;
  replacePaths: string[];
  entry: string;
  place: AllowListPlace;
};

/**
 * The addition that makes `ref` allowed for `botId`, read from the same `config.get` answer the
 * write is held to; null when no list limits the bot, the list already allows it, or the list is
 * past what Clawtrate writes back whole.
 */
export function allowAddition(
  config: Raw | null,
  botId: string,
  ref: AllowRef,
  serverVersion: string | null,
): AllowAddition | null {
  const list = governing(config, botId);
  // An empty list limits nothing: never one created, never one filled.
  if (!list || list.keys.length === 0) return null;
  if (listAllows(list.keys, ref, serverVersion)) return null;
  if (list.raw.length >= MAX_ALLOWLIST_ENTRIES) return null;
  const entry = allowEntry(ref);
  if (list.place === "models")
    return {
      patch: { agents: { defaults: { models: { [entry]: {} } } } },
      replacePaths: [],
      entry,
      place: list.place,
    };
  const allow = [...list.raw, entry];
  return {
    patch:
      list.place === "bot"
        ? { agents: { entries: { [botId]: { modelPolicy: { allow } } } } }
        : { agents: { defaults: { modelPolicy: { allow } } } },
    replacePaths: [list.path],
    entry,
    place: list.place,
  };
}

/**
 * Taking the entry out again: the patch, or why not. `gone` when the list that governs the bot
 * no longer holds it (someone changed it since, or it moved); `last` when it is the list's only
 * entry left, since taking it out would lift the limit instead of narrowing it.
 */
export function allowRemoval(
  config: Raw | null,
  botId: string,
  entry: string,
): { patch: Raw; replacePaths: string[] } | "gone" | "last" {
  const list = governing(config, botId);
  if (!list) return "gone";
  if (list.place === "models") {
    if (!list.raw.includes(entry)) return "gone";
    if (list.keys.filter((key) => key !== entry).length === 0) return "last";
    return { patch: { agents: { defaults: { models: { [entry]: null } } } }, replacePaths: [] };
  }
  const at = list.raw.lastIndexOf(entry);
  if (at < 0) return "gone";
  const allow = list.raw.filter((_, i) => i !== at);
  if (!allow.some((ref) => typeof ref === "string" && ref.trim().length > 0)) return "last";
  return {
    patch:
      list.place === "bot"
        ? { agents: { entries: { [botId]: { modelPolicy: { allow } } } } }
        : { agents: { defaults: { modelPolicy: { allow } } } },
    replacePaths: [list.path],
  };
}

/**
 * The model a bot runs on, as the config names it: its own `model.primary` (a string or
 * `{primary}`), else the gateway's default; without its account suffix.
 */
export function botModelRef(config: Raw | null, botId: string): AllowRef | null {
  const agents = asRecord(asRecord(config?.config)?.agents);
  const primary = (value: unknown) =>
    typeof value === "string" ? value : asRecord(value)?.primary;
  const own = primary(asRecord(asRecord(agents?.entries)?.[botId])?.model);
  const value = typeof own === "string" && own ? own : primary(asRecord(agents?.defaults)?.model);
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const rest = value.slice(slash + 1);
  const provider = value.slice(0, slash);
  const at = rest.lastIndexOf("@");
  const model = at > 0 && rest.slice(at + 1).startsWith(`${provider}:`) ? rest.slice(0, at) : rest;
  return model ? { provider, model } : null;
}

/** Whether the bot's own model (or the default it runs on) is one its model list refuses. */
export function ownModelRefused(
  config: Raw | null,
  botId: string,
  serverVersion: string | null,
): AllowRef | null {
  const ref = botModelRef(config, botId);
  return ref && allowAddition(config, botId, ref, serverVersion) ? ref : null;
}
