// A stand-in for the gateway's retained keyed store and host, for the unit
// tests. Every operation yields once, as the real store's worker does, so
// concurrent callers interleave. compareAndApply refuses when the row changed
// since it was observed, as the real one does in one SQLite transaction.

import { createBots } from "../lib/bots.js";

type Row = { json: string; rev: number };
type Json = Record<string, unknown>;

export function memoryStore() {
  const rows = new Map<string, Row>();
  let rev = 0;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const read = (key: string) => (rows.has(key) ? JSON.parse(rows.get(key)!.json) : undefined);
  // The real store refuses a value that isn't JSON, such as one holding undefined.
  const json = (value: unknown): string => {
    const walk = (v: unknown): void => {
      if (v === undefined) throw new Error("plugin state value must be JSON-serializable");
      if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(value);
    return JSON.stringify(value);
  };
  const mark = (key: string) => `${key}#${rows.get(key)?.rev ?? "absent"}`;
  return {
    rows,
    async lookup(key: string) {
      await tick();
      return read(key);
    },
    async observe(key: string) {
      await tick();
      return { value: read(key), comparison: mark(key) };
    },
    async compareAndApply(
      key: string,
      comparison: string,
      intent: { action: string; value?: unknown },
    ) {
      await tick();
      if (mark(key) !== comparison)
        return { status: "conflict", current: { value: read(key), comparison: mark(key) } };
      if (intent.action === "set") rows.set(key, { json: json(intent.value), rev: ++rev });
      return { status: "applied" };
    },
    async registerIfAbsent(key: string, value: unknown) {
      await tick();
      if (rows.has(key)) return false;
      rows.set(key, { json: json(value), rev: ++rev });
      return true;
    },
    async delete(key: string) {
      await tick();
      return rows.delete(key);
    },
    async entriesInKeyRange(range: {
      keyStartInclusive: string;
      keyEndExclusive: string;
      limit: number;
    }) {
      await tick();
      return [...rows.keys()]
        .filter((k) => k >= range.keyStartInclusive && k < range.keyEndExclusive)
        .sort()
        .slice(0, range.limit)
        .map((key) => ({ key, value: read(key), createdAt: 0 }));
    },
  };
}

export type Store = ReturnType<typeof memoryStore>;
export type Answer = {
  ok: boolean;
  payload?: Json | undefined;
  error?: { message: string; details?: Json } | undefined;
};

/** The plugin on a fake host: its methods, the events it emitted, and every method it dispatched. */
export function load(options: { store?: Store; now?: () => number; bots?: Json[] } = {}) {
  const store = options.store ?? memoryStore();
  const handlers = new Map<string, { handler: (opts: Json) => Promise<void>; scope: string }>();
  const events: string[] = [];
  const dispatched: string[] = [];
  const bots = options.bots ?? [
    { id: "main", createdAt: 1 },
    { id: "pip", createdAt: 2 },
  ];
  const api = {
    registerGatewayMethod: (
      name: string,
      handler: (opts: Json) => Promise<void>,
      opts: { scope: string },
    ) => handlers.set(name, { handler, scope: opts.scope }),
    registerService: (service: { start(ctx: Json): Promise<void> }) =>
      service.start({ gatewayEvents: { emit: (name: string) => events.push(name) } }),
  };
  createBots(api, {
    store,
    now: options.now,
    sdk: {
      dispatchGatewayMethod: async (method: string) => {
        dispatched.push(method);
        return { ok: true, payload: { agents: bots } };
      },
    },
  });
  async function call(name: string, params: Json = {}, device = "device-a"): Promise<Answer> {
    const entry = handlers.get(`clawtrate-bots.${name}`);
    if (!entry) throw new Error(`no method ${name}`);
    let answer: Answer = { ok: false };
    await entry.handler({
      params,
      client: { connect: { device: { id: device } } },
      respond: (ok: boolean, payload?: Json, error?: Answer["error"]) =>
        (answer = { ok, payload, error }),
    });
    return answer;
  }
  return { store, handlers, events, dispatched, call };
}
