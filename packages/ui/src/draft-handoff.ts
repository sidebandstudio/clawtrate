import { useCallback, useState, useSyncExternalStore, type SetStateAction } from "react";

export function createHandoffDraft<T>(
  hasContent: (value: T) => boolean,
  keepOnReturn?: (value: T) => boolean,
) {
  type Cell = { value: T; pending: number; version: number; listeners: Set<() => void> };
  const handoffs = new Map<string, Cell>();
  const releaseIfSettled = (key: string, cell: Cell) => {
    if (cell.pending || handoffs.get(key) !== cell) return;
    if (!hasContent(cell.value) || (cell.listeners.size > 0 && !keepOnReturn?.(cell.value)))
      handoffs.delete(key);
  };
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
        releaseIfSettled(key, cell);
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
        releaseIfSettled(key, cell);
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
        releaseIfSettled(key, cell);
        publish(cell);
      };
    }, [cell, key]);
    return [cell.value, change, cell.pending > 0, begin] as const;
  };
}
