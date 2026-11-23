// A stand-in for the gateway's keyed stores and host. As the SDK does, a
// comparison is the row's stored image, so two writes that leave the same
// JSON compare equal. for the unit
// tests. Every operation yields once, as the real store's worker does, so
// concurrent callers interleave. compareAndApply refuses when the row changed
// since it was observed, as the real one does in one SQLite transaction.

import { createBots } from "../lib/bots.js";

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
  const faults = { corrupt: new Set<string>(), beforeCommit: () => {}, failNextDelete: false };
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
      return { reached, release: () => (gates.splice(gates.indexOf(gate), 1), release()) };
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
    now?: () => number;
    monotonic?: () => number;
    bots?: Json[];
    startService?: boolean;
  } = {},
) {
  const store = options.store ?? memoryStore();
  const versions = options.versions ?? memoryStore({ maxEntries: 512 });
  const handlers = new Map<string, { handler: (opts: Json) => Promise<void>; scope: string }>();
  const events: string[] = [];
  const dispatched: string[] = [];
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
    registerService: (registered: Service) => {
      service = registered;
      if (options.startService !== false) void start();
    },
  };
  type Service = { start(ctx: Json): Promise<void>; stop(): void };
  let service: Service | null = null;
  const start = () =>
    service!.start({ gatewayEvents: { emit: (name: string) => events.push(name) } });
  createBots(api, {
    store,
    versions,
    now: options.now,
    monotonic: options.monotonic,
    sdk: {
      dispatchGatewayMethod: async (method: string) => {
        dispatched.push(method);
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
    handlers,
    events,
    dispatched,
    call,
    bots,
    start,
    stop: () => service!.stop(),
  };
}
