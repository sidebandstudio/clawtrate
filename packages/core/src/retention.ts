// One accounting of what the host keeps on its viewers' behalf. Each task's
// retained material (its activity, its mapped history page, its raw payloads
// and the files held for its outgoing messages) is charged to that task's
// budget, and everything the host keeps (every task, files still uploading or
// waiting, bytes queued on viewers' sockets) to the host's. The unit is a
// character of JSON or a byte of base64, whichever the material is kept as.

/** What one task may keep: activity, history page, raw payloads and its outgoing messages' files. */
export const MAX_TASK_RETAINED = 32 * 1024 * 1024;
/** What the host may keep in all, across tasks, uploads and viewers' socket buffers. */
export const MAX_HOST_RETAINED = 256 * 1024 * 1024;

/** The base64 length of a file of `bytes` bytes: what the host holds once it has the file. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * The host's budget. Each part of the host that keeps material on a viewer's
 * behalf registers a measure of what it holds now; admission asks for room
 * against the sum before keeping anything more.
 */
export class HostLedger {
  readonly limit: number;
  private readonly measures = new Map<object, { name: string; measure: () => number }>();

  constructor(limit: number = MAX_HOST_RETAINED) {
    this.limit = limit;
  }

  /** Count what `measure` reports from now on; the returned function stops counting it. */
  track(name: string, measure: () => number): () => void {
    const handle = {};
    this.measures.set(handle, { name, measure });
    return () => {
      this.measures.delete(handle);
    };
  }

  used(): number {
    let total = 0;
    for (const { measure } of this.measures.values()) total += measure();
    return total;
  }

  /** What each part holds, by name, for diagnostics and tests. */
  usage(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const { name, measure } of this.measures.values()) {
      out[name] = (out[name] ?? 0) + measure();
    }
    return out;
  }

  available(): number {
    return Math.max(0, this.limit - this.used());
  }

  /** Whether `amount` more fits. */
  admits(amount: number): boolean {
    return this.used() + amount <= this.limit;
  }
}

/** The retention state a task shows: what it keeps, against what, and whether new material was refused or reduced. */
export type TaskRetention = {
  used: number;
  limit: number;
  /**
   * Closed material was not enough to stay within the task's or the host's
   * budget: live work was reduced (each reduced item says so) or new material
   * was refused.
   */
  full: boolean;
  /** Oldest history items dropped from this task's page; they can be read again. */
  itemsOmitted: number;
  /** Raw payloads dropped from the host's table for this task; `readStepRaw` answers null for them. */
  rawOmitted: number;
};

export const emptyRetention: TaskRetention = {
  used: 0,
  limit: MAX_TASK_RETAINED,
  full: false,
  itemsOmitted: 0,
  rawOmitted: 0,
};

/** The host's retention state. */
export type HostRetention = { used: number; limit: number; full: boolean };
