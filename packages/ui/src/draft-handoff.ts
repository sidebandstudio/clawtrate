import { useCallback, useState, useSyncExternalStore, type SetStateAction } from "react";

export function createHandoffDraft<T>(
  hasWords: (value: T) => boolean,
  save?: (key: string, value: T) => void,
) {
  type Cell = { value: T; pending: number; version: number; listeners: Set<() => void> };
  const handoffs = new Map<string, Cell>();
  const publish = (cell: Cell) => {
    cell.version++;
    for (const notify of cell.listeners) notify();
  };
  return function useHandoffDraft(key: string, initial: () => T) {
    const [cell] = useState<Cell>(
      () => handoffs.get(key) ?? { value: initial(), pending: 0, version: 0, listeners: new Set() },
    );
    const subscribe = useCallback(
      (notify: () => void) => {
        cell.listeners.add(notify);
        if (!cell.pending) handoffs.delete(key);
        return () => {
          cell.listeners.delete(notify);
        };
      },
      [cell, key],
    );
    const version = () => cell.version;
    useSyncExternalStore(subscribe, version, version);
    const change = useCallback(
      (next: SetStateAction<T>) => {
        cell.value = typeof next === "function" ? (next as (current: T) => T)(cell.value) : next;
        save?.(key, cell.value);
        publish(cell);
      },
      [cell, key],
    );
    const begin = useCallback(() => {
      handoffs.set(key, cell);
      cell.pending++;
      publish(cell);
      return () => {
        cell.pending--;
        if (!cell.pending && (cell.listeners.size || !hasWords(cell.value))) handoffs.delete(key);
        publish(cell);
      };
    }, [cell, key]);
    return [cell.value, change, cell.pending > 0, begin] as const;
  };
}
