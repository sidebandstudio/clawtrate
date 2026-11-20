import type {
  DesktopUpdates,
  DesktopUpdateSnapshot,
  DesktopUpdateReply,
  UpdateTrack,
} from "@clawtrate/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";

type Reading = {
  snapshot: DesktopUpdateSnapshot | null;
  localChoice: UpdateTrack | null;
  working: boolean;
  message: string | null;
};

type Command =
  { kind: "check" | "choose"; track: UpdateTrack } | { kind: "download"; offerId: string };

const failure = {
  check: "Couldn't start the update check.",
  download: "Couldn't start the download.",
  choose: "Couldn't change the update track.",
};

/** One host session. Revision orders host facts; a command owns only its local feedback. */
export class UpdateReading {
  private value: Reading = { snapshot: null, localChoice: null, working: false, message: null };
  private listeners = new Set<() => void>();
  private work: Command | null = null;
  private readonly host: DesktopUpdates;
  constructor(host: DesktopUpdates) {
    this.host = host;
  }
  get = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<Reading>) {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }
  private accept = (next: DesktopUpdateSnapshot) => {
    if (next.revision <= (this.value.snapshot?.revision ?? -1)) return;
    if (next.pendingTrack) this.work = null;
    this.set({ snapshot: next, message: null, working: this.work !== null });
  };
  connect = () => {
    let live = true;
    const stop = this.host.subscribe(this.accept);
    void this.host
      .get()
      .then((s) => {
        if (live) this.accept(s);
      })
      .catch(() => {
        if (live && !this.value.snapshot) this.set({ message: "Couldn't read update settings." });
      });
    return () => {
      live = false;
      stop();
    };
  };
  private async send(command: Command) {
    const { snapshot, localChoice } = this.value;
    if (!snapshot || localChoice || snapshot.pendingTrack) return;
    const choosing = command.kind === "choose";
    if (choosing) {
      if (command.track === snapshot.selectedTrack) return;
      this.work = null;
      this.set({ localChoice: command.track, working: false, message: null });
    } else {
      if (this.work) return;
      this.work = command;
      this.set({ working: true, message: null });
    }
    try {
      let reply: DesktopUpdateReply;
      switch (command.kind) {
        case "check":
          reply = await this.host.check(command.track);
          break;
        case "download":
          reply = await this.host.download(command.offerId);
          break;
        case "choose":
          reply = await this.host.chooseTrack(command.track);
          break;
      }
      this.accept(reply.snapshot);
      const current = this.value.snapshot!;
      if (
        (!choosing && this.work !== command) ||
        current.revision !== reply.snapshot.revision ||
        current.pendingTrack ||
        current.preferenceIssue ||
        (current.state.kind !== "not-checked" && current.revision !== snapshot.revision)
      )
        return;
      if (reply.outcome === "stale" || reply.outcome === "superseded") {
        this.set({
          message:
            command.kind === "download"
              ? "This offer is no longer current."
              : "The update track changed. Check the selected source again.",
        });
      } else if (reply.outcome === "invalid") this.set({ message: failure[command.kind] });
    } catch {
      if (
        (choosing || this.work === command) &&
        snapshot.revision === this.value.snapshot?.revision
      )
        this.set({ message: failure[command.kind] });
    } finally {
      if (choosing) this.set({ localChoice: null });
      else if (this.work === command) {
        this.work = null;
        this.set({ working: false });
      }
    }
  }
  check = (track: UpdateTrack) => this.send({ kind: "check", track });
  chooseTrack = (track: UpdateTrack) => this.send({ kind: "choose", track });
  download = (offerId: string) => this.send({ kind: "download", offerId });
}

export function useDesktopUpdateSnapshot(host: DesktopUpdates) {
  const store = useMemo(() => new UpdateReading(host), [host]);
  const reading = useSyncExternalStore(store.subscribe, store.get, store.get);
  useEffect(() => store.connect(), [store]);
  return {
    ...reading,
    pending: reading.localChoice ?? reading.snapshot?.pendingTrack ?? null,
    check: store.check,
    download: store.download,
    chooseTrack: store.chooseTrack,
  };
}
