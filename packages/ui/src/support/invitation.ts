import { MAX_TRACKED_TASKS, MAX_OUTBOX, type Run, type Transcript } from "@clawtrate/core";

const KEY = "clawtrate.star-invitation";

export function canCountReply(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null || /^[0-5]$/.test(raw);
  } catch {
    return false;
  }
}

/** Six consumes the invitation before display. */
export function countReply(
  storage: () => Pick<Storage, "getItem" | "setItem"> = () => localStorage,
): boolean {
  try {
    const store = storage();
    const raw = store.getItem(KEY);
    if (raw !== null && !/^[0-5]$/.test(raw)) return false;
    const next = String(Number(raw) + 1);
    store.setItem(KEY, next);
    return store.getItem(KEY) === next && next === "6";
  } catch {
    return false;
  }
}

type Send = { key: string; messageId: string; runId: string | null };

/** A viewer owns its sends even when several viewers share the same web host. */
export class InvitationReplies extends EventTarget {
  private pending: Send[] = [];
  revision = 0;
  private readonly canCollect: () => boolean;
  constructor(canCollect: () => boolean = () => true) {
    super();
    this.canCollect = canCollect;
  }
  subscribe = (notify: () => void) => {
    this.addEventListener("change", notify);
    return () => this.removeEventListener("change", notify);
  };
  private collecting() {
    if (this.canCollect()) return true;
    this.pending = [];
    return false;
  }
  sent(key: string, messageId: string) {
    if (!this.collecting()) return;
    // Only unresolved acknowledgments. Old entries may lose their task on a reconnect.
    if (this.pending.some((send) => send.key === key && send.messageId === messageId)) return;
    this.pending = [
      ...this.pending.slice(1 - MAX_TRACKED_TASKS * MAX_OUTBOX),
      { key, messageId, runId: null },
    ];
    this.revision++;
    this.dispatchEvent(new Event("change"));
  }

  observe(
    transcripts: Record<string, Transcript>,
    openKey: string | null,
    rendered: (run: Run) => boolean,
    count = countReply,
    blocked = false,
  ): boolean {
    if (!this.pending.length || !this.collecting()) return false;
    let show = false;
    this.pending = this.pending.filter((send) => {
      const transcript = transcripts[send.key];
      if (!transcript) return true;
      const run = transcript.runs.find(
        (each) =>
          each.origin === "local" &&
          (send.runId === each.id ||
            send.messageId === each.messageId ||
            send.messageId === each.id),
      );
      if (!run) return true;
      send.runId = run.id;
      if (run.state === "failed" || run.state === "stopped" || run.state === "cancelled")
        return false;
      if (run.state !== "completed" || !run.bound) return true;
      if (
        send.key === openKey &&
        run.outcomeKnown &&
        !run.endFromRows &&
        run.textComplete &&
        run.text.trim()
      ) {
        // The foreground task can be waiting for its transcript to paint or a dialog to close.
        if (blocked || !rendered(run)) return true;
        show = count() || show;
      }
      return false;
    });
    if (show) this.pending = [];
    return show;
  }
}
