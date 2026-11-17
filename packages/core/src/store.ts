// A minimal observable value. Hosts subscribe and forward snapshots to the UI.

export type Listener<T> = (value: T) => void;

export type Store<T> = {
  get(): T;
  set(next: T): void;
  update(fn: (current: T) => T): void;
  subscribe(listener: Listener<T>): () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<Listener<T>>();
  const set = (next: T) => {
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
