// A minimal observable value. Hosts subscribe and forward snapshots to the UI.

export type Listener<T> = (value: T) => void;

export type Store<T> = {
  get(): T;
  set(next: T): void;
  update(fn: (current: T) => T): void;
  subscribe(listener: Listener<T>): () => void;
};

/**
 * `normalize` runs on every value written, before listeners see it: the
 * client uses it to bring state within its bounds where it enters.
 */
export function createStore<T>(initial: T, normalize: (next: T) => T = (next) => next): Store<T> {
  let value = normalize(initial);
  const listeners = new Set<Listener<T>>();
  const set = (written: T) => {
    if (Object.is(written, value)) return;
    const next = normalize(written);
    if (Object.is(next, value)) return;
    value = next;
    for (const listener of [...listeners]) listener(value);
  };
  return {
    get: () => value,
    set,
    update: (fn) => set(fn(value)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
