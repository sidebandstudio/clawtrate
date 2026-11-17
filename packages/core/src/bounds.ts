// Retention bounded by construction. Every field the host keeps has a named
// maximum and every collection a named count, declared once in a schema that
// is checked against the retained types: a field added to a type without a
// bound does not compile. The schema is enforced where state is written, and
// the worst case is arithmetic over it.
//
// The unit throughout is the JSON character: the length, in UTF-16 code
// units, of a value's `JSON.stringify` encoding, escapes and quotes included.

/**
 * A bound on one value. Every bound also admits null and absence; a value of
 * the wrong shape (an object where a string belongs, a string where a list
 * does) is replaced by null.
 */
export type Bound =
  /** A string, cut to `max` JSON characters. */
  | { kind: "text"; max: number }
  /**
   * An identifier: never cut, since a cut id would name something else. One
   * longer than `max` is replaced by a digest of itself (`#<digest>`), stable
   * for the same input.
   */
  | { kind: "id"; max: number }
  /** A number, boolean or short enum whose JSON form is at most `max`. */
  | { kind: "scalar"; max: number }
  /** Any value kept as received: kept whole if its JSON is at most `max`, otherwise null. */
  | { kind: "json"; max: number }
  /**
   * A list of at most `max` items, the newest kept. With `pool`, its items
   * also draw on a count shared by every such list under the nearest
   * enclosing list that declares that pool.
   */
  | { kind: "list"; max: number; item: Bound; pool?: string; pools?: Record<string, number> }
  /** A string-keyed record of at most `max` entries, keys at most `key` JSON characters. */
  | { kind: "map"; max: number; key: number; value: Bound }
  | { kind: "object"; fields: Record<string, Bound>; flags?: boolean }
  /** One of several object shapes, told apart by `tag`. */
  | { kind: "union"; tag: string; variants: Record<string, Bound> };

export const text = (max: number): Bound => ({ kind: "text", max });
export const id = (max: number): Bound => ({ kind: "id", max });
export const scalar = (max: number): Bound => ({ kind: "scalar", max });
export const json = (max: number): Bound => ({ kind: "json", max });
export const list = (
  max: number,
  item: Bound,
  options: { pool?: string; pools?: Record<string, number> } = {},
): Bound => ({ kind: "list", max, item, ...options });
export const map = (max: number, key: number, value: Bound): Bound => ({
  kind: "map",
  max,
  key,
  value,
});

/** Fields of `T` excluding the `cut` marker, each with its bound. */
type FieldBounds<T> = { [K in Exclude<keyof T, "cut">]-?: Bound };

/**
 * An object bound that names every field of `T`. A field added to `T`
 * without a bound here is a type error. When `T` has a `cut` field, the
 * paths of everything cut beneath it are recorded there.
 */
export function object<T>() {
  return (fields: FieldBounds<T>): Bound => ({
    kind: "object",
    fields: fields as Record<string, Bound>,
    flags: false,
  });
}

/** Like `object`, for a type that records what was cut beneath it in `cut`. */
export function flagged<T extends { cut?: string[] }>() {
  return (fields: FieldBounds<T>): Bound => ({
    kind: "object",
    fields: { ...(fields as Record<string, Bound>), cut: CUT_PATHS },
    flags: true,
  });
}

export function union<T extends Record<K, string>, K extends string>(tag: K) {
  return (variants: { [V in T[K]]: Bound }): Bound => ({
    kind: "union",
    tag,
    variants: variants as Record<string, Bound>,
  });
}

/** Paths of cut values recorded on one object, at most this many. */
export const MAX_CUT_PATHS = 8;
/** Longest recorded path of a cut value. */
export const MAX_CUT_PATH_CHARS = 96;
const CUT_PATHS: Bound = {
  kind: "list",
  max: MAX_CUT_PATHS,
  item: { kind: "text", max: MAX_CUT_PATH_CHARS },
};

// Measuring -----------------------------------------------------------------------

/** The JSON length of a string: quotes and escapes counted. */
export function jsonTextLength(value: string): number {
  let length = 2;
  for (let i = 0; i < value.length; i += 1) length += escapedLength(value.charCodeAt(i), value, i);
  return length;
}

function escapedLength(code: number, value: string, index: number): number {
  if (code === 0x22 || code === 0x5c) return 2;
  if (code < 0x20)
    return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
      ? 2
      : 6;
  // A lone surrogate is escaped by JSON.stringify.
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 1 : 6;
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const previous = value.charCodeAt(index - 1);
    return previous >= 0xd800 && previous <= 0xdbff ? 1 : 6;
  }
  return 1;
}

/** The longest prefix of `value` whose JSON form is at most `max`, never splitting a surrogate pair. */
export function cutText(value: string, max: number): string {
  let length = 2;
  for (let i = 0; i < value.length; i += 1) {
    const step = escapedLength(value.charCodeAt(i), value, i);
    if (length + step > max) {
      const code = value.charCodeAt(i - 1);
      return value.slice(0, code >= 0xd800 && code <= 0xdbff ? i - 1 : i);
    }
    length += step;
  }
  return value;
}

export function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? null)?.length ?? 4;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// Digests ---------------------------------------------------------------------------

/**
 * A running digest of text, extendable a piece at a time: two independent
 * 32-bit hashes over the UTF-16 code units. Evidence that two texts share a
 * prefix, not a security measure.
 */
export type Digest = { length: number; a: number; b: number };

export const emptyDigest: Digest = { length: 0, a: 0x811c9dc5, b: 5381 };

export function extendDigest(digest: Digest, piece: string): Digest {
  let a = digest.a;
  let b = digest.b;
  for (let i = 0; i < piece.length; i += 1) {
    const code = piece.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = (Math.imul(b, 33) + code) >>> 0;
  }
  return { length: digest.length + piece.length, a, b };
}

export const digestOf = (value: string): Digest => extendDigest(emptyDigest, value);

export function sameDigest(left: Digest, right: Digest): boolean {
  return left.length === right.length && left.a === right.a && left.b === right.b;
}

export const digestKey = (digest: Digest): string =>
  `${digest.length.toString(36)}.${digest.a.toString(36)}.${digest.b.toString(36)}`;

/**
 * An identifier within `max` JSON characters: itself when it fits, otherwise
 * `#<digest>` of itself, the same for the same input. Every id the host keeps,
 * in its state or as a key of its own maps, passes through this, so a
 * long id is the same short value wherever it is kept and looked up.
 */
export function capId(value: string, max: number): string {
  return jsonTextLength(value) <= max ? value : `#${digestKey(digestOf(value))}`;
}

// Enforcing -------------------------------------------------------------------------

type Pools = Map<string, number>;

/** Objects already known to satisfy a bound, so unchanged state is not walked again. */
const bounded = new WeakMap<object, Bound>();
const draws = new WeakMap<Bound, ReadonlySet<string>>();

/** The pools a bound's lists draw on that it does not declare itself. */
function drawsOn(bound: Bound): ReadonlySet<string> {
  const known = draws.get(bound);
  if (known) return known;
  const out = new Set<string>();
  const add = (inner: Bound) => {
    for (const name of drawsOn(inner)) out.add(name);
  };
  switch (bound.kind) {
    case "list":
      add(bound.item);
      if (bound.pool) out.add(bound.pool);
      for (const name of Object.keys(bound.pools ?? {})) out.delete(name);
      break;
    case "map":
      add(bound.value);
      break;
    case "object":
      Object.values(bound.fields).forEach(add);
      break;
    case "union":
      Object.values(bound.variants).forEach(add);
      break;
    default:
      break;
  }
  draws.set(bound, out);
  return out;
}

const drawsFrom = (bound: Bound, pools: Pools) =>
  pools.size > 0 && [...drawsOn(bound)].some((name) => pools.has(name));
/** Unknown keys remembered at most; past it, more are not kept. */
export const MAX_UNKNOWN_KEYS = 64;
/**
 * Keys found on retained objects that the schema does not name, a
 * programming error, kept for tests: at most `MAX_UNKNOWN_KEYS`, each cut to
 * 96 characters.
 */
export const unknownKeys = new Set<string>();

/**
 * Bring a value within its bound. Unchanged values are returned as they
 * are; a value that had to be cut is a new value, with the paths cut recorded
 * on the nearest object that keeps a `cut` list.
 */
export function enforce<T>(bound: Bound, value: T): T {
  return walk(bound, value, "", new Map(), []) as T;
}

function walk(bound: Bound, value: unknown, path: string, pools: Pools, cuts: string[]): unknown {
  if (value === null || value === undefined) return value;
  switch (bound.kind) {
    case "text": {
      if (typeof value !== "string")
        return walk({ kind: "json", max: bound.max }, value, path, pools, cuts);
      if (jsonTextLength(value) <= bound.max) return value;
      cuts.push(path);
      return cutText(value, bound.max);
    }
    case "id": {
      if (typeof value !== "string") return wrongShape(value, bound.max, path, cuts);
      if (jsonTextLength(value) <= bound.max) return value;
      cuts.push(path);
      return capId(value, bound.max);
    }
    case "scalar": {
      if (typeof value !== "string") return wrongShape(value, bound.max, path, cuts);
      if (jsonTextLength(value) <= bound.max) return value;
      cuts.push(path);
      return cutText(value, bound.max);
    }
    case "json": {
      if (jsonLength(value) <= bound.max) return value;
      cuts.push(path);
      return null;
    }
    case "list": {
      if (!Array.isArray(value)) return dropped(path, cuts);
      const scope = bound.pools ? new Map([...pools, ...Object.entries(bound.pools)]) : pools;
      let items = value;
      if (items.length > bound.max) {
        cuts.push(`${path}[${items.length - bound.max}<]`);
        items = items.slice(-bound.max);
      }
      // Newest first, so a shared pool keeps the newest items.
      const out: unknown[] = [];
      let changed = items !== value;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (bound.pool) {
          const left = scope.get(bound.pool) ?? 0;
          if (left <= 0) {
            cuts.push(`${path}[${i + 1}<]`);
            changed = true;
            break;
          }
          scope.set(bound.pool, left - 1);
        }
        const next = walk(bound.item, items[i], `${path}[${i}]`, scope, cuts);
        if (next !== items[i]) changed = true;
        out.push(next);
      }
      return changed ? out.reverse() : value;
    }
    case "map": {
      if (typeof value !== "object" || Array.isArray(value)) return dropped(path, cuts);
      const entries = Object.entries(value as Record<string, unknown>);
      let changed = false;
      let kept = entries;
      if (entries.length > bound.max) {
        cuts.push(`${path}{${entries.length - bound.max}<}`);
        kept = entries.slice(-bound.max);
        changed = true;
      }
      const out: Record<string, unknown> = {};
      for (const [key, entry] of kept) {
        if (jsonTextLength(key) > bound.key) {
          cuts.push(`${path}{key}`);
          changed = true;
          continue;
        }
        const next = walk(bound.value, entry, `${path}.${key.slice(0, 32)}`, pools, cuts);
        if (next !== entry) changed = true;
        out[key] = next;
      }
      return changed ? out : value;
    }
    case "union": {
      if (typeof value !== "object" || Array.isArray(value)) return dropped(path, cuts);
      const tag = (value as Record<string, unknown>)[bound.tag];
      const variant = typeof tag === "string" ? bound.variants[tag] : undefined;
      if (!variant) {
        cuts.push(path);
        return null;
      }
      return walk(variant, value, path, pools, cuts);
    }
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return dropped(path, cuts);
      const known = bounded.get(value as object);
      const pooled = drawsFrom(bound, pools);
      if (known === bound && !pooled) return value;
      const record = value as Record<string, unknown>;
      const own: string[] = bound.flags ? [] : cuts;
      const out: Record<string, unknown> = {};
      let changed = false;
      for (const key of Object.keys(record)) {
        if (key === "cut" && bound.flags) continue;
        const field = bound.fields[key];
        if (!field) {
          if (unknownKeys.size < MAX_UNKNOWN_KEYS) unknownKeys.add(key.slice(0, 96));
          changed = true;
          continue;
        }
        const next = walk(field, record[key], path ? `${path}.${key}` : key, pools, own);
        if (next !== record[key]) changed = true;
        out[key] = next;
      }
      if (bound.flags) {
        const previous: unknown[] = Array.isArray(record.cut) ? record.cut : [];
        // Only strings are paths: anything else in a `cut` list is dropped, never kept as it is.
        const kept = previous.filter((each): each is string => typeof each === "string");
        const fresh = own.map((each) =>
          path && each.startsWith(path) ? each.slice(path.length + 1) : each,
        );
        if (fresh.length > 0 || previous.length > 0) {
          const merged = [...new Set([...kept, ...fresh])]
            .map((each) => cutText(each, MAX_CUT_PATH_CHARS))
            .slice(-MAX_CUT_PATHS);
          if (merged.length !== previous.length || merged.some((each, i) => each !== previous[i]))
            changed = true;
          out.cut = merged;
        }
        if (fresh.length > 0 && path) cuts.push(path);
      }
      const result = changed ? out : value;
      if (!pooled) bounded.set(result as object, bound);
      return result;
    }
  }
}

function dropped(path: string, cuts: string[]): null {
  cuts.push(path);
  return null;
}

/** A number or boolean where a string id or scalar belongs is kept if short enough; anything else is dropped. */
function wrongShape(value: unknown, max: number, path: string, cuts: string[]): unknown {
  if ((typeof value === "number" || typeof value === "boolean") && jsonLength(value) <= max)
    return value;
  return dropped(path, cuts);
}

// Worst case --------------------------------------------------------------------------

/**
 * The most JSON characters a value within `bound` can take, without
 * whitespace: the arithmetic the documented totals are computed with.
 */
export function worstCase(bound: Bound, pools: Map<string, number> = new Map()): number {
  switch (bound.kind) {
    case "text":
    case "id":
    case "scalar":
    case "json":
      return Math.max(bound.max, 4);
    case "map":
      return 2 + bound.max * (bound.key + 1 + worstCase(bound.value, pools) + 1);
    case "union":
      return Math.max(...Object.values(bound.variants).map((each) => worstCase(each, pools)));
    case "object": {
      let total = 2;
      for (const [key, field] of Object.entries(bound.fields)) {
        total += key.length + 3 + worstCase(field, pools) + 1;
      }
      return total;
    }
    case "list": {
      if (bound.pools) {
        // Items without their pooled lists, then each pool's items once.
        const inner = new Map(pools);
        for (const name of Object.keys(bound.pools)) inner.set(name, 0);
        const items = bound.max * (worstCase(bound.item, inner) + 1);
        let pooled = 0;
        for (const [name, count] of Object.entries(bound.pools)) {
          pooled += count * (worstCase(pooledItem(bound.item, name)!, pools) + 1);
        }
        return 2 + items + pooled;
      }
      if (bound.pool && pools.get(bound.pool) === 0) return 2;
      return 2 + bound.max * (worstCase(bound.item, pools) + 1);
    }
  }
}

/** The item bound of the first list drawing on `pool` beneath `bound`. */
function pooledItem(bound: Bound, pool: string): Bound | null {
  switch (bound.kind) {
    case "list":
      return bound.pool === pool ? bound.item : pooledItem(bound.item, pool);
    case "object":
      for (const field of Object.values(bound.fields)) {
        const found = pooledItem(field, pool);
        if (found) return found;
      }
      return null;
    case "union":
      for (const variant of Object.values(bound.variants)) {
        const found = pooledItem(variant, pool);
        if (found) return found;
      }
      return null;
    case "map":
      return pooledItem(bound.value, pool);
    default:
      return null;
  }
}
