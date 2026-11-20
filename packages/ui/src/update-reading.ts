import type {
  DesktopUpdates,
  DesktopUpdateSnapshot,
  DesktopUpdateReply,
  UpdateTrack,
} from "@clawtrate/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { handoffLocked, restartCapability } from "./update-restart.ts";

type Reading = {
  snapshot: DesktopUpdateSnapshot | null;
  localChoice: UpdateTrack | null;
  working: boolean;
  message: string | null;
};

type Command =
  | { kind: "check"; track: UpdateTrack; revision: number }
  | { kind: "choose"; track: UpdateTrack }
  | { kind: "restart"; offerId: string }
  | { kind: "download"; offerId: string };

const unanswered = {
  restart: "Couldn't get a reply to the restart request.",
  check: "Couldn't get a reply to the update check.",
  download: "Couldn't get a reply to the download request.",
  choose: "Couldn't get a reply to the track change.",
};

const failure = {
  restart: "Couldn't start the restart.",
  check: "Couldn't start the update check.",
  download: "Couldn't start the download.",
  choose: "Couldn't change the update track.",
};

/** One host session. Revision orders host facts; a command owns only its local feedback. */
export class UpdateReading {
  private value: Reading = { snapshot: null, localChoice: null, working: false, message: null };
  private listeners = new Set<() => void>();
  private choice: Extract<Command, { kind: "choose" }> | null = null;
  private work: Command | null = null;
  private readRequest: symbol | null = null;
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
    if (
      this.choice &&
      (next.pendingTrack === this.choice.track ||
        (next.pendingTrack === null && next.selectedTrack === this.choice.track))
    )
      this.choice = null;
    if (next.pendingTrack) this.work = null;
    this.set({
      snapshot: next,
      localChoice: this.choice?.track ?? null,
      message: null,
      working: this.work !== null,
    });
  };
  private async read() {
    const request = Symbol();
    this.readRequest = request;
    try {
      const snapshot = await this.host.get();
      if (this.readRequest === request) this.accept(snapshot);
    } catch {
      if (this.readRequest === request && !this.value.snapshot)
        this.set({ message: "Couldn't read update settings.", working: false });
    } finally {
      if (this.readRequest === request) this.readRequest = null;
    }
  }
  retryRead = () => {
    if (this.readRequest || this.value.working || this.value.snapshot || !this.value.message)
      return;
    this.set({ working: true });
    return this.read();
  };
  connect = () => {
    const stop = this.host.subscribe(this.accept);
    void this.read();
    return () => {
      this.readRequest = null;
      stop();
    };
  };
  private async send(command: Command) {
    const { snapshot, localChoice } = this.value;
    if (
      !snapshot ||
      localChoice ||
      snapshot.pendingTrack ||
      handoffLocked(snapshot.state) ||
      this.work?.kind === "restart"
    )
      return;
    if (command.kind === "restart" && restartCapability(snapshot)?.offerId !== command.offerId)
      return;
    const choosing = command.kind === "choose";
    if (choosing) {
      if (command.track === snapshot.selectedTrack) return;
      this.work = null;
      this.choice = command;
      this.set({ localChoice: command.track, working: false, message: null });
    } else {
      if (this.work) return;
      this.work = command;
      this.set({ working: true, message: null });
    }
    try {
      let reply: DesktopUpdateReply;
      switch (command.kind) {
        case "restart":
          reply = await this.host.restart(command.offerId);
          break;
        case "check":
          reply = await this.host.check(command.track, command.revision);
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
        (choosing ? this.choice : this.work) !== command ||
        current.revision !== reply.snapshot.revision ||
        current.pendingTrack ||
        (current.state.kind !== "not-checked" &&
          current.revision !== snapshot.revision &&
          !(command.kind === "restart" && restartCapability(current)?.offerId === command.offerId))
      )
        return;
      if (reply.outcome === "stale" || reply.outcome === "superseded") {
        this.set({
          message:
            command.kind === "download" || command.kind === "restart"
              ? "This offer is no longer current."
              : command.kind === "choose"
                ? "This update track choice is no longer current."
                : current.selectedTrack !== command.track
                  ? "The update track changed. Check the selected source again."
                  : "The update result changed. Review it before checking again.",
        });
      } else if (reply.outcome === "busy" && command.kind === "restart")
        this.set({ message: "Another update action is in progress." });
      else if (reply.outcome === "invalid") this.set({ message: failure[command.kind] });
    } catch {
      if (
        (choosing ? this.choice : this.work) === command &&
        snapshot.revision === this.value.snapshot?.revision
      )
        this.set({ message: unanswered[command.kind] });
    } finally {
      if (choosing && this.choice === command) {
        this.choice = null;
        this.set({ localChoice: null });
      } else if (this.work === command) {
        this.work = null;
        this.set({ working: false });
      }
    }
  }
  check = (track: UpdateTrack, revision: number) => this.send({ kind: "check", track, revision });
  chooseTrack = (track: UpdateTrack) => this.send({ kind: "choose", track });
  restart = (offerId: string) => this.send({ kind: "restart", offerId });
  download = (offerId: string) => this.send({ kind: "download", offerId });
}

export function useDesktopUpdateSnapshot(host: DesktopUpdates) {
  const store = useMemo(() => new UpdateReading(host), [host]);
  const reading = useSyncExternalStore(store.subscribe, store.get, store.get);
  useEffect(() => store.connect(), [store]);
  return {
    ...reading,
    pending: reading.snapshot?.pendingTrack ?? reading.localChoice,
    retryRead: store.retryRead,
    check: store.check,
    download: store.download,
    restart: store.restart,
    chooseTrack: store.chooseTrack,
  };
}
