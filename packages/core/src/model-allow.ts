// A bot's chosen model on the model list that limits it (#799). OpenClaw checks every model a
// visible task is started on against the bot's model list (`modelPolicy.allow`), while the bot's
// own model runs its conversations off that list. So when the person chooses a bot's model, or
// presses "Allow <model>", the exact `<provider>/<model>` is appended to the one list that governs
// that bot, in the same `config.patch` as the model, and only when that list limits the bot and,
// read as the running version reads it, refuses the model. Undo takes that one entry out again,
// only from that list, only while the list is as Clawtrate left it, held to the config's hash.
// Nothing else is written: no pattern, no other model, no list where none was, no other bot's
// list. Where the app can't tell how the gateway reads a list, it claims nothing and writes
// nothing.

import { sha256Hex, utf8Bytes } from "./bytes.ts";
import { openClawAtLeast } from "./gateway-version.ts";
import { MAX_ALLOWLIST_ENTRIES } from "./accounts.ts";
import { asRecord } from "./mapping.ts";

type Raw = Record<string, unknown>;

/** Whose list limits the bot: its own, the gateway's default, or the old `agents.defaults.models`. */
export type AllowListPlace = "bot" | "gateway" | "models";

/** One list in the config: where it is, its raw value, and its non-empty string entries. */
type List = { place: AllowListPlace; path: string; raw: unknown[]; keys: string[] };

function listAt(config: Raw | null, botId: string, place: AllowListPlace): List | null {
  const agents = asRecord(asRecord(config?.config)?.agents);
  const defaults = asRecord(agents?.defaults);
  let path: string;
  let holder: Raw | null;
  if (place === "models") {
    const models = asRecord(defaults?.models);
    if (!models) return null;
    return withKeys({ place, path: "agents.defaults.models", raw: Object.keys(models) });
  }
  if (place === "bot") {
    path = `agents.entries.${botId}.modelPolicy.allow`;
    holder = asRecord(asRecord(asRecord(agents?.entries)?.[botId])?.modelPolicy);
  } else {
    path = "agents.defaults.modelPolicy.allow";
    holder = asRecord(defaults?.modelPolicy);
  }
  if (!holder || !Object.hasOwn(holder, "allow")) return null;
  return withKeys({ place, path, raw: Array.isArray(holder.allow) ? holder.allow : [] });
}

function withKeys(list: Omit<List, "keys">): List {
  const keys = list.raw
    .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
    .map((ref) => ref.trim());
  return { ...list, keys };
}

/** The list that governs one bot, as the gateway resolves it (`resolveConfiguredModelPolicyAllow`). */
function governing(config: Raw | null, botId: string): List | null {
  const root = asRecord(config?.config);
  const defaults = asRecord(asRecord(root?.agents)?.defaults);
  const migrated = asRecord(asRecord(root?.meta)?.migrations)?.modelPolicyAllowlist === true;
  return (
    listAt(config, botId, "bot") ??
    listAt(config, botId, "gateway") ??
    // The old map, only while there is no default policy and the config was never migrated.
    (!asRecord(defaults?.modelPolicy) && !migrated ? listAt(config, botId, "models") : null)
  );
}

/**
 * What a list held, as one digest: the entries an addition left, which its Undo needs to find
 * unchanged, so it never takes out an entry a later hand put back.
 */
function digestOf(list: List | null): string | null {
  if (!list) return null;
  const value = list.place === "models" ? [...list.keys].sort() : list.raw;
  return sha256Hex(utf8Bytes(JSON.stringify(value)));
}

/** A model as a list entry names it: `<provider>/<model>`, the provider as the gateway lowercases it. */
export type AllowRef = { provider: string; model: string };

export const allowEntry = (ref: AllowRef): string => `${ref.provider}/${ref.model}`;

/**
 * A model reference without its auth profile, as both versions split one
 * (`splitTrailingAuthProfile`: 2026.10.6 `model-ref-profile-BNjB2hED.mjs:3`, 2026.11.10
 * `model-ref-profile-DFGpvDZX.mjs:2`): at the first `@` after the last `/`, passing over a date
 * (`@20250101`) or a quantization (`@q4_k_m`, `@8bit`) that is part of the model's own id.
 */
export function withoutProfile(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let at = trimmed.indexOf("@", trimmed.lastIndexOf("/") + 1);
  if (at <= 0) return trimmed;
  for (const own of [/^\d{8}(?:@|$)/, /^(?:i?q\d+(?:_[a-z0-9]+)*|\d+bit)(?:@|$)/i]) {
    if (!own.test(trimmed.slice(at + 1))) continue;
    const next = trimmed.indexOf("@", at + 1);
    if (next < 0) return trimmed;
    at = next;
  }
  const model = trimmed.slice(0, at).trim();
  return model && trimmed.slice(at + 1).trim() ? model : trimmed;
}

/** The config's own aliases (`agents.defaults.models.<ref>.alias`), lowercased, to their model. */
function aliasesOf(config: Raw | null): Map<string, AllowRef> {
  const out = new Map<string, AllowRef>();
  const models = asRecord(asRecord(asRecord(asRecord(config?.config)?.agents)?.defaults)?.models);
  for (const [key, value] of Object.entries(models ?? {}).slice(0, MAX_ALLOWLIST_ENTRIES)) {
    const alias = asRecord(value)?.alias;
    const ref = exactRef(key);
    if (typeof alias === "string" && alias.trim() && ref) out.set(alias.trim().toLowerCase(), ref);
  }
  return out;
}

/** `<provider>/<model>` read as an exact reference, without its profile; null without a `/`. */
function exactRef(raw: string): AllowRef | null {
  const model = withoutProfile(raw);
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const provider = model.slice(0, slash).trim().toLowerCase();
  const id = model.slice(slash + 1).trim();
  return provider && id ? { provider, model: id } : null;
}

/** A segment the gateway takes in a list entry (`hasValidSegments`, both versions). */
const validSegment = (segment: string) =>
  segment.length > 0 &&
  !segment.includes("*") &&
  !/\s/u.test(segment) &&
  ![...segment].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/**
 * A wildcard entry's stem, the start a model's `<provider>/<model>` must have to match, as one
 * version reads it (`parseModelPolicyWildcardRef`): 2026.10.6 (`agent-scope-config-CtLA1__T.mjs:47`)
 * takes only a whole last segment `*`, its segments trimmed; 2026.11.10
 * (`model-policy-allowlist-migration-BDJYmlL9.mjs:10`) any trailing `*`, a prefix such as
 * `openai/gpt-*` too. Null when that version doesn't read the entry as a wildcard.
 */
function stemOf(entry: string, prefixes: boolean): string | null {
  const trimmed = entry.trim();
  if (!trimmed.endsWith("*")) return null;
  if (!prefixes) {
    const segments = trimmed.split("/").map((segment) => segment.trim());
    const before = segments.slice(0, -1);
    if (segments.at(-1) !== "*" || before.length < 1 || !before.every(validSegment)) return null;
    return `${[before[0]!.toLowerCase(), ...before.slice(1)].join("/")}/`;
  }
  const pieces = trimmed.slice(0, -1).split("/");
  const last = (pieces.pop() ?? "").trimStart();
  const before = pieces.map((piece) => piece.trim());
  if (before.length < 1 || !before.every(validSegment) || (last && !validSegment(last)))
    return null;
  return [before[0]!.toLowerCase(), ...before.slice(1), last].join("/");
}

/** How one entry reads a model: it allows it, it doesn't, or the app can't tell. */
function entryReads(
  entry: string,
  ref: AllowRef,
  prefixes: boolean,
  aliases: Map<string, AllowRef>,
): "allows" | "no" | "unknown" {
  const key = allowEntry(ref);
  const stem = stemOf(entry, prefixes);
  if (stem !== null) return key.startsWith(stem) && key.length > stem.length ? "allows" : "no";
  // Not a wildcard to this version: an entry with a `*` left is no valid reference at all.
  if (entry.includes("*")) return "no";
  const exact = exactRef(entry) ?? aliases.get(withoutProfile(entry).toLowerCase()) ?? null;
  // A bare name the config doesn't alias may be a provider's own alias: the app can't tell.
  if (!exact) return "unknown";
  return exact.provider === ref.provider && exact.model === ref.model ? "allows" : "no";
}

/**
 * Whether a list's entries allow the model, as the version the gateway reports reads them: an
 * exact entry (the provider in any case, the model as written, the profile split off), a config
 * alias of it, a whole-segment wildcard (`openai/*`, `openrouter/anthropic/*`) on both versions,
 * and from 2026.11.10 a prefix (`openai/gpt-*`). `unknown` when it can't tell: an entry that may be
 * a provider's alias, or a prefix on a version it doesn't know, which only 2026.11.10 reads so.
 */
export function listVerdict(
  keys: string[],
  ref: AllowRef,
  serverVersion: string | null,
  aliases: Map<string, AllowRef> = new Map(),
): "allows" | "refuses" | "unknown" {
  const known = serverVersion !== null && /^v?\d{4}\.\d{1,2}\.\d{1,3}/.test(serverVersion);
  const prefixes = openClawAtLeast(serverVersion, 2026, 11, 10);
  let unknown = false;
  for (const entry of keys) {
    const read = entryReads(entry, ref, prefixes, aliases);
    if (read === "allows") return "allows";
    if (read === "unknown") unknown = true;
    // A version it doesn't know may read a prefix that 2026.10.6 doesn't.
    else if (!known && entryReads(entry, ref, true, aliases) === "allows") unknown = true;
  }
  return unknown ? "unknown" : "refuses";
}

/** Whether a list's entries allow the model, as above; `unknown` counts as not shown to allow. */
export const listAllows = (keys: string[], ref: AllowRef, serverVersion: string | null) =>
  listVerdict(keys, ref, serverVersion) === "allows";

/** An entry the gateway reads as exactly this model and nothing wider: what Clawtrate may write. */
function writable(ref: AllowRef): boolean {
  return [ref.provider, ...ref.model.split("/")].every(validSegment);
}

/** What one write adds to a bot's model list, beside the model it sets. */
export type AllowAddition = {
  patch: Raw;
  replacePaths: string[];
  entry: string;
  place: AllowListPlace;
  /** The list as this write leaves it (`digestOf`): what its Undo needs to find unchanged. */
  digest: string;
};

/**
 * The addition that makes `ref` allowed for `botId`, read from the same `config.get` answer the
 * write is held to; null when no list limits the bot, the list doesn't refuse it as the running
 * version reads it, the app can't tell, or the entry would be anything but this exact model;
 * `"full"` when the list refuses it but is past what Clawtrate writes back whole.
 */
export function allowAddition(
  config: Raw | null,
  botId: string,
  ref: AllowRef,
  serverVersion: string | null,
): AllowAddition | "full" | null {
  const list = governing(config, botId);
  if (!list || verdictOf(config, list, ref, serverVersion) !== "refuses") return null;
  if (!writable(ref)) return null;
  if (list.raw.length >= MAX_ALLOWLIST_ENTRIES) return "full";
  const entry = allowEntry(ref);
  if (list.place === "models") {
    const after = withKeys({ ...list, raw: [...list.raw, entry] });
    return {
      patch: { agents: { defaults: { models: { [entry]: {} } } } },
      replacePaths: [],
      entry,
      place: list.place,
      digest: digestOf(after)!,
    };
  }
  const allow = [...list.raw, entry];
  return {
    patch:
      list.place === "bot"
        ? { agents: { entries: { [botId]: { modelPolicy: { allow } } } } }
        : { agents: { defaults: { modelPolicy: { allow } } } },
    replacePaths: [list.path],
    entry,
    place: list.place,
    digest: digestOf({ ...list, raw: allow })!,
  };
}

/** An empty list limits nothing: never one created, never one filled. */
function verdictOf(
  config: Raw | null,
  list: List,
  ref: AllowRef,
  serverVersion: string | null,
): "allows" | "refuses" | "unknown" {
  if (list.keys.length === 0) return "allows";
  return listVerdict(list.keys, ref, serverVersion, aliasesOf(config));
}

/**
 * Taking an addition out again, only from the list it went on and only while that list is as the
 * addition left it: the patch, or why not. `moved` when another list now governs the bot; `gone`
 * when its list no longer holds the entry; `changed` when the list has changed since, so the entry
 * there may be someone else's; `last` when it is the list's only entry, since taking it out would
 * lift the limit instead of narrowing it.
 */
export function allowRemoval(
  config: Raw | null,
  botId: string,
  addition: { entry: string; place: AllowListPlace; digest: string },
): { patch: Raw; replacePaths: string[] } | "moved" | "gone" | "changed" | "last" {
  const now = governing(config, botId);
  if (!now || now.place !== addition.place) return "moved";
  if (!now.raw.includes(addition.entry)) return "gone";
  if (digestOf(now) !== addition.digest) return "changed";
  if (now.place === "models") {
    if (now.keys.filter((key) => key !== addition.entry).length === 0) return "last";
    return {
      patch: { agents: { defaults: { models: { [addition.entry]: null } } } },
      replacePaths: [],
    };
  }
  const at = now.raw.lastIndexOf(addition.entry);
  const allow = now.raw.filter((_, i) => i !== at);
  if (!allow.some((ref) => typeof ref === "string" && ref.trim().length > 0)) return "last";
  return {
    patch:
      now.place === "bot"
        ? { agents: { entries: { [botId]: { modelPolicy: { allow } } } } }
        : { agents: { defaults: { modelPolicy: { allow } } } },
    replacePaths: [now.path],
  };
}

/**
 * The model a bot runs on, as the config names it and the gateway resolves it: its own
 * `model.primary` (a string or `{primary}`), else the gateway's default; its profile split off as
 * the gateway splits it; a bare name through the config's aliases. Null when it can't tell.
 */
export function botModelRef(config: Raw | null, botId: string): AllowRef | null {
  const agents = asRecord(asRecord(config?.config)?.agents);
  const primary = (value: unknown) =>
    typeof value === "string" ? value : asRecord(value)?.primary;
  const own = primary(asRecord(asRecord(agents?.entries)?.[botId])?.model);
  const value = typeof own === "string" && own ? own : primary(asRecord(agents?.defaults)?.model);
  if (typeof value !== "string" || !value.trim()) return null;
  return exactRef(value) ?? aliasesOf(config).get(withoutProfile(value).toLowerCase()) ?? null;
}

/**
 * The bot's own model (or the default it runs on) when its list refuses it, as the running
 * version reads the list; `full` when the list is past what Clawtrate writes back, so it can't
 * offer to change it. Null when it doesn't refuse it, or the app can't tell.
 */
export function ownModelRefusal(
  config: Raw | null,
  botId: string,
  serverVersion: string | null,
): (AllowRef & { full: boolean }) | null {
  const ref = botModelRef(config, botId);
  const list = governing(config, botId);
  // A model no exact entry can name (a `*`, a space) is none the app can speak for.
  if (!ref || !writable(ref) || !list) return null;
  if (verdictOf(config, list, ref, serverVersion) !== "refuses") return null;
  return { ...ref, full: list.raw.length >= MAX_ALLOWLIST_ENTRIES };
}
