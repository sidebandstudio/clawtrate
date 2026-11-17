// A minimal observable value. Hosts subscribe and forward snapshots to the UI.

export type Listener<T> = (value: T) => void;

export type Store<T> = {
  get(): T;
  set(next: T): void;
  update(fn: (current: T) => T): void;
  subscribe(listener: Listener<T>): () => void;
};

/**
 * Listeners one store holds at once. A host subscribes once per window or web
 * viewer (`MAX_WEB_VIEWERS`, 8); past this, `subscribe` throws.
 */
export const MAX_STORE_LISTENERS = 32;

/**
 * The store. Its state and listeners are own properties, so the retention
 * registry (`owners.ts`) names them; its methods are bound, so a host may pass
 * `store.subscribe` on its own.
 */
class ObservableStore<T> implements Store<T> {
  private value: T;
  /** At most `MAX_STORE_LISTENERS`. */
  private readonly listeners = new Set<Listener<T>>();
  private readonly normalize: (next: T) => T;

  constructor(initial: T, normalize: (next: T) => T) {
    this.normalize = normalize;
    this.value = normalize(initial);
  }

  readonly get = (): T => this.value;

  readonly set = (written: T): void => {
    if (Object.is(written, this.value)) return;
    const next = this.normalize(written);
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener(this.value);
  };

  readonly update = (fn: (current: T) => T): void => this.set(fn(this.value));

  readonly subscribe = (listener: Listener<T>): (() => void) => {
    if (!this.listeners.has(listener) && this.listeners.size >= MAX_STORE_LISTENERS)
      throw new Error(`A store holds at most ${MAX_STORE_LISTENERS} listeners.`);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/**
 * `normalize` runs on every value written, before listeners see it: the
 * client uses it to bring state within its bounds where it enters.
 */
export function createStore<T>(initial: T, normalize: (next: T) => T = (next) => next): Store<T> {
  return new ObservableStore(initial, normalize);
}
