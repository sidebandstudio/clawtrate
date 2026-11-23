// A stand-in for the gateway's keyed stores and host, for the unit tests. As
// the SDK does, a comparison is the row's stored image, so two writes that
// leave the same JSON compare equal. Every operation yields once, as the real store's worker does, so
// concurrent callers interleave. compareAndApply refuses when the row changed
// since it was observed, as the real one does in one SQLite transaction.

import { createBots } from "../lib/bots.js";
import { Refusal } from "../lib/ledger.js";

type Row = { json: string; rev: number };
type Json = Record<string, unknown>;

export function memoryStore({ maxEntries = Infinity } = {}) {
  const rows = new Map<string, Row>();
  let rev = 0;
  // Microtask yield: concurrent callers still interleave at every await without libuv loop stalls under load.
  const tick = () => Promise.resolve();
  const read = (key: string) => (rows.has(key) ? JSON.parse(rows.get(key)!.json) : undefined);
  // The real store refuses a value that isn't JSON, such as one holding undefined.
  const json = (value: unknown): string => {
    const walk = (v: unknown): void => {
      if (v === undefined) throw new Error("plugin state value must be JSON-serializable");
      if (v && typeof v === "object")
        for (const k in v as Json) if (Object.hasOwn(v, k)) walk((v as Json)[k]);
    };
    walk(value);
    return JSON.stringify(value);
  };
  const mark = (key: string) => `${key}#${rows.get(key)?.json ?? "absent"}`;
  /**
   * Holds reads, writes or compare-and-apply calls of keys with a prefix
   * (and, for a compare-and-apply, an intent `when` accepts) until released;
   * `reached` resolves when one is held.
   */
  type Gate = {
    prefix: string;
    on: string;
    when: (value: unknown) => boolean;
    reach: () => void;
    wait: Promise<void>;
  };
  const gates: Gate[] = [];
  const pass = async (key: string, on: string, value?: unknown) => {
    for (const gate of gates.filter(
      (g) => g.on === on && key.startsWith(g.prefix) && g.when(value),
    )) {
      gate.reach();
      await gate.wait;
    }
  };
  const faults = {
    corrupt: new Set<string>(),
    beforeCommit: () => {},
    failNextDelete: false,
    /** Keys whose next writes fail, and how many times. */
    failWrites: new Map<string, number>(),
  };
  const stats = { conflicts: 0 };
  type Intent = { action: string; value?: unknown };
  const apply = (key: string, comparison: string, intent: Intent) => {
    if (mark(key) !== comparison) {
      stats.conflicts += 1;
      return { status: "conflict", current: { value: read(key), comparison: mark(key) } };
    }
    if (intent.action === "set") rows.set(key, { json: json(intent.value), rev: ++rev });
    return { status: "applied" };
  };
  const store = {
    rows,
    faults,
    stats,
    hold(
      prefix: string,
      on: "read" | "write" | "cas" = "write",
      when: (value: unknown) => boolean = () => true,
    ) {
      let reach = () => {};
      let release = () => {};
      const reached = new Promise<void>((resolve) => (reach = resolve));
      const wait = new Promise<void>((resolve) => (release = resolve));
      const gate = { prefix, on, when, reach, wait };
      gates.push(gate);
      const drop = () => gates.splice(gates.indexOf(gate), 1);
      // `drop` lets others pass and leaves the held caller waiting for good: a process that stopped.
      return { reached, release: () => (drop(), release()), drop };
    },
    async lookup(key: string) {
      await tick();
      await pass(key, "read");
      if (faults.corrupt.has(key))
        throw Object.assign(new Error("corrupt"), { code: "PLUGIN_STATE_CORRUPT" });
      return read(key);
    },
    async observe(key: string) {
      await tick();
      return { value: read(key), comparison: mark(key) };
    },
    async compareAndApply(key: string, comparison: string, intent: Intent) {
      await tick();
      await pass(key, "cas", intent.value);
      return apply(key, comparison, intent);
    },
    /** The assertion is checked at the transaction and again at commit, as the real store does. */
    withCurrent({ assertCurrent }: { assertCurrent: () => void }) {
      return {
        ...store,
        async compareAndApply(key: string, comparison: string, intent: Intent) {
          assertCurrent();
          await tick();
          await pass(key, "cas", intent.value);
          faults.beforeCommit();
          assertCurrent();
          return apply(key, comparison, intent);
        },
      };
    },
    async delete(key: string) {
      await tick();
      if (faults.failNextDelete) {
        faults.failNextDelete = false;
        throw new Error("the delete failed");
      }
      return rows.delete(key);
    },
    /**
     * As the pinned SDK does: the range must increase and the limit be
     * positive; the limit applies first, then each returned row is decoded,
     * and an unreadable one throws PLUGIN_STATE_CORRUPT with no key.
     */
    async entriesInKeyRange(range: {
      keyStartInclusive: string;
      keyEndExclusive: string;
      limit: number;
    }) {
      await tick();
      if (!(range.limit >= 1) || !(range.keyStartInclusive < range.keyEndExclusive))
        throw Object.assign(new Error("invalid range"), { code: "PLUGIN_STATE_INVALID_INPUT" });
      const keys = [...rows.keys()]
        .filter((k) => k >= range.keyStartInclusive && k < range.keyEndExclusive)
        .sort()
        .slice(0, range.limit);
      if (keys.some((k) => faults.corrupt.has(k)))
        throw Object.assign(new Error("corrupt"), { code: "PLUGIN_STATE_CORRUPT" });
      return keys.map((key) => ({ key, value: read(key), createdAt: 0 }));
    },
    /** A bounded namespace with overflowPolicy "reject-new" refuses new keys at its limit. */
    async registerIfAbsent(key: string, value: unknown) {
      await tick();
      await pass(key, "write");
      const failing = faults.failWrites.get(key) ?? 0;
      if (failing > 0) {
        faults.failWrites.set(key, failing - 1);
        throw new Error("the write failed");
      }
      if (rows.has(key)) return false;
      if (rows.size >= maxEntries)
        throw Object.assign(new Error("limit"), { code: "PLUGIN_STATE_LIMIT_EXCEEDED" });
      rows.set(key, { json: json(value), rev: ++rev });
      return true;
    },
  };
  return store;
}

export type Store = ReturnType<typeof memoryStore>;
export type Answer = {
  ok: boolean;
  payload?: Json | undefined;
  error?: { message: string; details?: Json } | undefined;
};

/** The plugin on a fake host: its methods, the events it emitted, and every method it dispatched. */
export function load(
  options: {
    store?: Store;
    versions?: Store;
    journal?: Store;
    effects?: unknown;
    config?: Json;
    now?: () => number;
    monotonic?: () => number;
    bots?: Json[];
    startService?: boolean;
  } = {},
) {
  const store = options.store ?? memoryStore();
  const versions = options.versions ?? memoryStore({ maxEntries: 512 });
  const journal = options.journal ?? memoryStore();
  // The gateway's config as config.get shows it, and the config.patch calls it was sent.
  const config = { value: options.config ?? {}, hash: "h0", patches: [] as Json[] };
  const handlers = new Map<string, { handler: (opts: Json) => Promise<void>; scope: string }>();
  const events: string[] = [];
  const dispatched: string[] = [];
  const reloads: unknown[] = [];
  const bots: Json[] = options.bots ?? [
    { id: "main", createdAt: 1 },
    { id: "pip", createdAt: 2 },
  ];
  const api = {
    registerGatewayMethod: (
      name: string,
      handler: (opts: Json) => Promise<void>,
      opts: { scope: string },
    ) => handlers.set(name, { handler, scope: opts.scope }),
    registerReload: (registration: unknown) => reloads.push(registration),
    registerService: (registered: Service) => {
      service = registered;
      if (options.startService !== false) void start();
    },
  };
  type Service = { start(ctx: Json): Promise<void>; stop(): void };
  let service: Service | null = null;
  const start = () =>
    service!.start({ gatewayEvents: { emit: (name: string) => events.push(name) } });
  const { records } = createBots(api, {
    store,
    versions,
    journal,
    effects: options.effects,
    now: options.now,
    monotonic: options.monotonic,
    sdk: {
      dispatchGatewayMethod: async (method: string, params: Json) => {
        dispatched.push(method);
        if (method === "config.get")
          return { ok: true, payload: { config: config.value, hash: config.hash } };
        if (method === "config.patch") {
          config.patches.push(params);
          if (params.baseHash !== config.hash)
            return { ok: false, error: { message: "config changed since last load" } };
          const patch = JSON.parse(params.raw as string) as Json;
          config.value = merge(config.value, patch);
          config.hash = `h${config.patches.length}`;
          return { ok: true, payload: {} };
        }
        return { ok: true, payload: { agents: bots } };
      },
    },
  });
  /** A direct operator request by default; `inProcess` drops the host's socket flag, `synthetic` marks the client. */
  async function call(
    name: string,
    params: Json = {},
    { device = "device-a", inProcess = false, synthetic = false } = {},
  ): Promise<Answer> {
    const entry = handlers.get(`clawtrate-bots.${name}`);
    if (!entry) throw new Error(`no method ${name}`);
    let answer: Answer = { ok: false };
    await entry.handler({
      params,
      ...(inProcess ? {} : { acceptsSerializedJson: true }),
      client: {
        connect: { role: "operator", device: { id: device } },
        ...(synthetic ? { internal: { syntheticClient: true } } : {}),
      },
      respond: (ok: boolean, payload?: Json, error?: Answer["error"]) =>
        (answer = { ok, payload, error }),
    });
    return answer;
  }
  return {
    store,
    versions,
    journal,
    config,
    records,
    handlers,
    events,
    dispatched,
    reloads,
    call,
    bots,
    start,
    stop: () => service!.stop(),
  };
}

/** A JSON merge patch, as config.patch applies one; the plugin names its list in replacePaths. */
function merge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (value && typeof value === "object" && !Array.isArray(value))
      out[key] = merge((out[key] as Json) ?? {}, value as Json);
    else out[key] = value;
  }
  return out;
}

/**
 * A test-only Apply: the conditional writes bound to a bot's incarnation that
 * OpenClaw 2026.10.6 lacks. Each field holds a value and a token that changes
 * on every write; a write under another token is refused inside it, as
 * config.patch {baseHash} and agents.files.set {expectedHash} refuse.
 * `faults` lose a write's answer after it lands, run code before or after a
 * write or a read, or stop there for good.
 */
export function standInApply(initial: Record<string, unknown> = {}) {
  const fields = new Map<string, { value: unknown; token: string }>();
  let n = 0;
  const keyOf = (bot: { id: string }, step: string) => `${bot.id}/${step}`;
  const get = (bot: { id: string }, step: string) =>
    fields.get(keyOf(bot, step)) ?? { value: initial[step] ?? null, token: `t0-${step}` };
  const writes: { bot: string; step: string; value: unknown }[] = [];
  const faults = {
    lose: new Set<string>(),
    /** Before a write lands; a promise that never settles stands for the process stopping there. */
    before: (_step: string): unknown => undefined,
    /** After a write lands, before its answer. */
    after: (_step: string) => {},
    read: (_step: string): unknown => undefined,
  };
  const set = (bot: { id: string }, step: string, value: unknown) =>
    fields.set(keyOf(bot, step), { value, token: `t${++n}` });
  return {
    writes,
    faults,
    set,
    get,
    conditional: (step: string) => step !== "name",
    async read(bot: { id: string }, step: string) {
      await new Promise((resolve) => setImmediate(resolve));
      await faults.read(step);
      return { ...get(bot, step) };
    },
    async write(bot: { id: string }, step: string, value: unknown, token: string) {
      await new Promise((resolve) => setImmediate(resolve));
      await faults.before(step);
      const current = get(bot, step);
      if (current.token !== token)
        throw new Refusal("precondition", "The field changed since it was read.");
      set(bot, step, value);
      writes.push({ bot: bot.id, step, value });
      faults.after(step);
      if (faults.lose.has(step)) throw new Error("the answer was lost");
      return { before: current.value, after: value };
    },
  };
}
