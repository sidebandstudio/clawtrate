// A bot's chosen model on the model list that limits it (#799). OpenClaw checks every model a
// visible task is started on against the bot's model list (`modelPolicy.allow`), while the bot's
// own model runs its conversations off that list. So when the person chooses a bot's model, or
// presses "Allow <model>", the exact `<provider>/<model>` is appended to the one list that governs
// that bot, in the same `config.patch` as the model, and only when that list limits the bot and,
// read as the running version reads it, refuses the model. Undo takes that one entry out again,
// only from that list, held to the config revision read right after the addition. Nothing else is
// written: no pattern, no other model, no list where none was, no other bot's list, and nothing on
// the old `agents.defaults.models` layout. Where the app can't tell how the gateway reads a list,
// it claims nothing and writes nothing.

import { openClawAtLeast } from "./gateway-version.ts";
import { MAX_ALLOWLIST_ENTRIES, MAX_MODEL_ID_CHARS } from "./accounts.ts";
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

/** `<provider>/<model>` read as an exact reference, without its profile; null without a `/`. */
function exactRef(raw: string): AllowRef | null {
  const model = withoutProfile(raw);
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const provider = model.slice(0, slash).trim().toLowerCase();
  const id = model.slice(slash + 1).trim();
  return provider && id ? { provider, model: id } : null;
}

/** One alias of the config: its name, and the model it names, or null when the app can't place it. */
type Alias = { alias: string; ref: AllowRef | null };

/**
 * The aliases one lookup reads, as both versions build them: the gateway's
 * `agents.defaults.models`, then with `botId` the bot's own `models` (`listConfiguredModelMaps`:
 * 2026.10.6 `model-selection-shared-PnWvZr7n.mjs:210`, 2026.11.10
 * `model-selection-shared-PDwe2GYm.mjs:13`); only a row with an `alias` key, never a wildcard row
 * (`listModelAliasCandidates`, :213 and :13); the last row per model wins, and an empty alias
 * takes that model's away (`buildEffectiveModelAliases`, :223 and :13). A row keyed by a bare name
 * or anything else the app can't place is kept with no model, so a lookup it matches is unknown.
 */
function aliasesOf(config: Raw | null, botId: string | null): Alias[] {
  const agents = asRecord(asRecord(config?.config)?.agents);
  const maps = [
    asRecord(asRecord(agents?.defaults)?.models),
    ...(botId === null ? [] : [asRecord(asRecord(asRecord(agents?.entries)?.[botId])?.models)]),
  ];
  const byModel = new Map<string, Alias | null>();
  const unplaced: Alias[] = [];
  const rows = maps.flatMap((models) => Object.entries(models ?? {}));
  for (const [key, value] of rows.slice(0, MAX_ALLOWLIST_ENTRIES)) {
    const row = asRecord(value);
    if (!row || !Object.hasOwn(row, "alias")) continue;
    const alias = typeof row.alias === "string" ? row.alias.trim() : "";
    // A `*` may make it a wildcard row (none has an alias) or a model the app can't name; an `@`
    // in a key is read by a parser the app doesn't follow.
    const ref = /[*@]/.test(key) ? null : exactRef(key);
    if (!ref) {
      if (alias) unplaced.push({ alias, ref: null });
      continue;
    }
    const model = allowEntry(ref);
    byModel.delete(model);
    byModel.set(model, alias ? { alias, ref } : null);
  }
  return [...[...byModel.values()].filter((each) => each !== null), ...unplaced];
}

/**
 * Whether a provider the config sets up lists this exact model as a row of its own
 * (`hasExactConfiguredProviderModelRef`, 2026.10.6 `model-selection-shared-PnWvZr7n.mjs:32`,
 * 2026.11.10 `model-selection-shared-PDwe2GYm.mjs:3`): then aliases are passed over.
 */
function configuredRow(config: Raw | null, model: string): boolean {
  const slash = model.indexOf("/");
  if (slash <= 0) return false;
  const provider = model.slice(0, slash).trim().toLowerCase();
  const id = model.slice(slash + 1).trim();
  const providers = asRecord(asRecord(asRecord(config?.config)?.models)?.providers) ?? {};
  return Object.entries(providers).some(([key, value]) => {
    const rows = asRecord(value)?.models;
    return (
      key.trim().toLowerCase() === provider &&
      Array.isArray(rows) &&
      rows.some((row) => {
        const own = asRecord(row)?.id;
        return typeof own === "string" && own.trim() === id;
      })
    );
  });
}

/**
 * A model reference as the gateway resolves it (`resolveModelRefFromString`, 2026.10.6
 * `model-selection-shared-PnWvZr7n.mjs:460`, 2026.11.10 `model-selection-shared-PDwe2GYm.mjs:13`;
 * a bot's model by `resolveConfiguredModelRef`, :509 and :13, which reads the same aliases): its
 * profile split off; an exact row of a configured provider as written; else a bare alias
 * (`byAlias`), or one qualified by the provider of the model it names (`providerAliasKey`, :109 and
 * :7: `openai/workhorse` for OpenAI's `workhorse`); else `<provider>/<model>` as written. Null when
 * the app can't tell: a bare name no alias names (it may be a provider's own), an alias row it
 * can't place, or an alias with a `/` or `@` of its own, which a version may read only qualified
 * (`createModelAliasScope`) or as a profile.
 */
function resolveRef(config: Raw | null, raw: string, aliases: Alias[]): AllowRef | null {
  const model = withoutProfile(raw);
  if (!model) return null;
  const literal = exactRef(model);
  if (literal && configuredRow(config, model)) return literal;
  const plain = new Set([model.toLowerCase(), raw.trim().toLowerCase()]);
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash).trim().toLowerCase() : null;
  const qualified = new Set(
    provider === null
      ? []
      : [raw.trim().slice(slash + 1), model.slice(slash + 1)].map((name) =>
          name.trim().toLowerCase(),
        ),
  );
  const matches = aliases.filter(({ alias, ref }) => {
    const name = alias.toLowerCase();
    if (plain.has(name)) return true;
    return qualified.has(name) && (ref === null || ref.provider === provider);
  });
  if (matches.length === 0) return literal;
  if (matches.some(({ alias, ref }) => ref === null || /[/@]/.test(alias))) return null;
  // The last row of the config that names it, as the gateway's maps keep the last one set.
  return matches.at(-1)!.ref;
}

/** A segment the gateway takes in a list entry (`hasValidSegments`, both versions). */
const validSegment = (segment: string) =>
  segment.length > 0 &&
  !segment.includes("*") &&
  !/\s/u.test(segment) &&
  ![...segment].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/** A provider id as the bridge carries one, and the longest. */
const PROVIDER_ID = /^[\w.-]+$/;
const MAX_PROVIDER_ID_CHARS = 128;

/**
 * Whether a model, as a gateway's config names it, can be carried by "Allow" and written as one
 * exact entry: the one rule the refusal and the bridge both use (#799). `long` when it is past
 * what the bridge carries (`MAX_PROVIDER_ID_CHARS`, `MAX_MODEL_ID_CHARS`); `other` when no exact
 * entry can name it (a `*`, a space, an empty segment) or the provider isn't one the bridge
 * carries; null when it can be.
 */
export function allowRefProblem(ref: AllowRef): "long" | "other" | null {
  if (![ref.provider, ...ref.model.split("/")].every(validSegment)) return "other";
  if (!PROVIDER_ID.test(ref.provider)) return "other";
  if (ref.provider.length > MAX_PROVIDER_ID_CHARS || ref.model.length > MAX_MODEL_ID_CHARS)
    return "long";
  return null;
}

/**
 * A wildcard entry's stem, the start a model's `<provider>/<model>` must have to match, as one
 * version reads it (`parseModelPolicyWildcardRef`): 2026.10.6 (`agent-scope-config-CtLA1__T.mjs:47`)
 * takes only a whole last segment `*`, its segments trimmed; 2026.11.10
 * (`model-policy-allowlist-migration-BDJYmlL9.mjs:10`) any trailing `*`, a prefix such as
 * `openai/gpt-*` too, which matches what starts with it (`modelPolicyWildcardMatches`), the
 * prefix itself included. Null when that version doesn't read the entry as a wildcard.
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
  resolve: (entry: string) => AllowRef | null,
): "allows" | "no" | "unknown" {
  const stem = stemOf(entry, prefixes);
  if (stem !== null) return allowEntry(ref).startsWith(stem) ? "allows" : "no";
  // Not a wildcard to this version: an entry with a `*` left is no valid reference at all.
  if (entry.includes("*")) return "no";
  const exact = resolve(entry);
  if (!exact) return "unknown";
  return exact.provider === ref.provider && exact.model === ref.model ? "allows" : "no";
}

/**
 * Whether a list's entries allow the model, as the version the gateway reports reads them: an
 * exact entry (the provider in any case, the model as written, the profile split off), an alias
 * of it (`resolve`, `resolveRef` for a config), a whole-segment wildcard (`openai/*`,
 * `openrouter/anthropic/*`) on both versions, and from 2026.11.10 a prefix (`openai/gpt-*`).
 * `unknown` when it can't tell: an entry it can't place, or a prefix on a version it doesn't know,
 * which only 2026.11.10 reads so.
 */
export function listVerdict(
  keys: string[],
  ref: AllowRef,
  serverVersion: string | null,
  resolve: (entry: string) => AllowRef | null = (entry) => resolveRef(null, entry, []),
): "allows" | "refuses" | "unknown" {
  const known = serverVersion !== null && /^v?\d{4}\.\d{1,2}\.\d{1,3}/.test(serverVersion);
  const prefixes = openClawAtLeast(serverVersion, 2026, 11, 10);
  let unknown = false;
  for (const entry of keys) {
    const read = entryReads(entry, ref, prefixes, resolve);
    if (read === "allows") return "allows";
    if (read === "unknown") unknown = true;
    // A version it doesn't know may read a prefix that 2026.10.6 doesn't.
    else if (!known && entryReads(entry, ref, true, resolve) === "allows") unknown = true;
  }
  return unknown ? "unknown" : "refuses";
}

/** Whether a list's entries allow the model, as above; `unknown` counts as not shown to allow. */
export const listAllows = (keys: string[], ref: AllowRef, serverVersion: string | null) =>
  listVerdict(keys, ref, serverVersion) === "allows";

/** What one write adds to a bot's model list, beside the model it sets. */
export type AllowAddition = {
  patch: Raw;
  replacePaths: string[];
  entry: string;
  place: "bot" | "gateway";
};

/**
 * Why a list that refuses a model gets no Allow: `full`, past the entries Clawtrate writes back
 * whole; `long`, a model id past what Clawtrate carries (`allowRefProblem`); `layout`, the old
 * `agents.defaults.models` of a config never migrated, which Clawtrate doesn't change. On that
 * layout every config write migrates the map to `agents.defaults.modelPolicy.allow` from the
 * config before the write, unless one of its keys fails the gateway's own check
 * (`materializeModelPolicyAllowlist`, 2026.10.6 `agent-scope-config-CtLA1__T.mjs:83`, 2026.11.10
 * `model-policy-allowlist-migration-BDJYmlL9.mjs:5`, run on each write by `io.meta-C_ryXAjc.mjs:47`
 * and `io.meta-BronQyfK.mjs:3`), so a key added there may never take effect; the gateway's own
 * writer picks the map or the policy by that check (`auth-model-policy-bNk2kMh2.mjs:115`,
 * `auth-api-key-BCubeQ0x.mjs:3`), which reads provider plugins the app can't.
 */
export type NoAllow = "full" | "long" | "layout";

/**
 * The list that governs the bot, read as the running version reads it: its verdict on `ref`, and
 * whether the exact entry Clawtrate would write for it names `ref` there, which an alias of another
 * model under that name would not.
 */
function verdictOf(
  config: Raw | null,
  botId: string,
  ref: AllowRef,
  serverVersion: string | null,
): { list: List; verdict: "allows" | "refuses" | "unknown"; names: boolean } | null {
  const list = governing(config, botId);
  if (!list) return null;
  // The bot's own aliases count for its own list only (`prepareModelPolicy`, 2026.10.6
  // `model-selection-shared-PnWvZr7n.mjs:617`, 2026.11.10 `model-selection-shared-PDwe2GYm.mjs:13`).
  const aliases = aliasesOf(config, list.place === "bot" ? botId : null);
  const resolve = (entry: string) => resolveRef(config, entry, aliases);
  const named = resolve(allowEntry(ref));
  const names = named?.provider === ref.provider && named.model === ref.model;
  // An empty list limits nothing: never one created, never one filled.
  if (list.keys.length === 0) return { list, verdict: "allows", names };
  return { list, verdict: listVerdict(list.keys, ref, serverVersion, resolve), names };
}

/** Why the list that refuses `ref` gets no Allow, or null when it can. */
function noAllow(list: List, ref: AllowRef): NoAllow | null {
  if (list.place === "models") return "layout";
  if (allowRefProblem(ref) === "long") return "long";
  if (list.raw.length >= MAX_ALLOWLIST_ENTRIES) return "full";
  return null;
}

/**
 * The addition that makes `ref` allowed for `botId`, read from the same `config.get` answer the
 * write is held to; null when no list limits the bot, the list doesn't refuse it as the running
 * version reads it, the app can't tell, or the entry would be anything but this exact model; why
 * not (`NoAllow`) when the list refuses it but Clawtrate doesn't change it.
 */
export function allowAddition(
  config: Raw | null,
  botId: string,
  ref: AllowRef,
  serverVersion: string | null,
): AllowAddition | NoAllow | null {
  const read = verdictOf(config, botId, ref, serverVersion);
  if (!read || read.verdict !== "refuses" || !read.names || allowRefProblem(ref) === "other")
    return null;
  const { list } = read;
  if (list.place === "models") return "layout";
  const why = noAllow(list, ref);
  if (why !== null) return why;
  const entry = allowEntry(ref);
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

/** Whether `config` holds an addition: its entry on its list, which governs the bot. */
export function holdsAddition(
  config: Raw | null,
  botId: string,
  addition: { entry: string; place: "bot" | "gateway" },
): boolean {
  const now = governing(config, botId);
  return now?.place === addition.place && now.raw.includes(addition.entry);
}

/**
 * Taking an addition out again: its last copy of the entry out of the list it went on, from the
 * config revision the addition left (`ModelAllowed.revision`), which the caller holds it to. Null
 * when that config doesn't hold it so, or taking it out would leave the list with no entry, which
 * would lift the limit instead of narrowing it.
 */
export function allowRemoval(
  config: Raw | null,
  botId: string,
  addition: { entry: string; place: "bot" | "gateway" },
): { patch: Raw; replacePaths: string[] } | null {
  const now = governing(config, botId);
  if (!now || !holdsAddition(config, botId, addition)) return null;
  const at = now.raw.lastIndexOf(addition.entry);
  const allow = now.raw.filter((_, i) => i !== at);
  if (!allow.some((ref) => typeof ref === "string" && ref.trim().length > 0)) return null;
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
 * the gateway splits it; an alias, bare or qualified, through the gateway's and the bot's own
 * aliases (`resolveRef`). Null when it can't tell.
 */
export function botModelRef(config: Raw | null, botId: string): AllowRef | null {
  const agents = asRecord(asRecord(config?.config)?.agents);
  const primary = (value: unknown) =>
    typeof value === "string" ? value : asRecord(value)?.primary;
  const own = primary(asRecord(asRecord(agents?.entries)?.[botId])?.model);
  const value = typeof own === "string" && own ? own : primary(asRecord(agents?.defaults)?.model);
  if (typeof value !== "string" || !value.trim()) return null;
  return resolveRef(config, value, aliasesOf(config, botId));
}

/**
 * The bot's own model (or the default it runs on) when its list refuses it, as the running
 * version reads the list, with why Clawtrate can't offer to change that list (`NoAllow`), if it
 * can't. Null when it doesn't refuse it, the app can't tell, or no exact entry can name it there.
 */
export function ownModelRefusal(
  config: Raw | null,
  botId: string,
  serverVersion: string | null,
): (AllowRef & { why: NoAllow | null }) | null {
  const ref = botModelRef(config, botId);
  if (!ref || allowRefProblem(ref) === "other") return null;
  const read = verdictOf(config, botId, ref, serverVersion);
  // An entry that would name another model is none the app can offer.
  if (!read || read.verdict !== "refuses" || !read.names) return null;
  return { ...ref, why: noAllow(read.list, ref) };
}
