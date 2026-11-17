// The reply text of `chat` delta frames, per run. A delta frame carries the
// whole message so far (`message`) or only what to add (`deltaText`, with
// `replace` to start over), so the text before it must be kept for the runs
// still streaming. Only that text is kept, never the message it came in, for
// at most `perTask` runs of each followed task, each at most `maxChars` JSON
// characters. The client retires a run's text when the run ends, leaves the
// transcript, or its task is resynced or released.

import { capId, jsonTextLength } from "./bounds.ts";
import { liveTextFromChatMessage, type RawRecord } from "./mapping.ts";
import { MAX_ID_CHARS } from "./state-bounds.ts";

type Baseline = { task: string; agentId: string | null; text: string };

export class ChatTextBaselines {
  /** By run id (capped), oldest first. */
  private readonly runs = new Map<string, Baseline>();
  private readonly perTask: number;
  private readonly maxChars: number;

  constructor(perTask: number, maxChars: number) {
    this.perTask = perTask;
    this.maxChars = maxChars;
  }

  /**
   * The run's reply text after this `chat` frame: for a delta, the whole text
   * so far, or null when it cannot be known (an addition with no text before
   * it). Final, aborted and error frames retire the run and return null.
   */
  project(payload: RawRecord): string | null {
    const runId = typeof payload.runId === "string" ? capId(payload.runId, MAX_ID_CHARS) : null;
    const task =
      typeof payload.sessionKey === "string" ? capId(payload.sessionKey, MAX_ID_CHARS) : null;
    if (!runId || !task) return null;
    if (payload.state !== "delta") {
      if (payload.state === "final" || payload.state === "error" || payload.state === "aborted")
        this.runs.delete(runId);
      return null;
    }
    const agentId =
      typeof payload.agentId === "string" ? capId(payload.agentId, MAX_ID_CHARS) : null;
    const kept = this.runs.get(runId);
    const previous = kept && kept.task === task && kept.agentId === agentId ? kept.text : null;
    let text: string | null;
    if (payload.message !== undefined) {
      text = liveTextFromChatMessage(payload.message);
    } else if (typeof payload.deltaText !== "string") {
      text = previous;
    } else if (payload.replace === true) {
      text = payload.deltaText;
    } else if (!payload.deltaText) {
      text = previous;
    } else {
      text = previous === null ? null : previous + payload.deltaText;
    }
    this.runs.delete(runId);
    if (text === null) return null;
    if (jsonTextLength(text) > this.maxChars) {
      // Past its bound the reply is not followed further here; the transcript will hold it whole.
      return text.slice(0, this.maxChars);
    }
    this.runs.set(runId, { task, agentId, text });
    // A task keeps the text of its newest `perTask` streaming runs.
    let count = 0;
    for (const [id, each] of [...this.runs].reverse()) {
      if (each.task !== task) continue;
      count += 1;
      if (count > this.perTask) this.runs.delete(id);
    }
    return text;
  }

  /** Retire the runs of a task (all of them, or those `keep` does not name). */
  retire(sessionKey: string, keep?: (runId: string) => boolean): void {
    const task = capId(sessionKey, MAX_ID_CHARS);
    for (const [runId, each] of this.runs) {
      if (each.task === task && !keep?.(runId)) this.runs.delete(runId);
    }
  }

  clear(): void {
    this.runs.clear();
  }

  /** Runs whose text is kept, for tests and the retention registry. */
  get size(): number {
    return this.runs.size;
  }
}
