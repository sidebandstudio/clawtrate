// Exposes a narrow, typed IPC surface to the renderer. No Node or Electron
// objects cross the bridge, only plain data, six functions and the platform name.

import type {
  DesktopUpdates,
  DesktopUpdateSnapshot,
  AttachmentInfo,
  BridgeCommand,
  ClawtrateState,
  HostInfo,
  SaveResult,
} from "@clawtrate/core";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export type DesktopHostApi = {
  desktopUpdates: DesktopUpdates;
  platform: string;
  hello(): Promise<{ info: HostInfo; state: ClawtrateState }>;
  /** Resolves with the command's answer (see `BridgeResultFor`). */
  send(command: BridgeCommand): Promise<unknown>;
  onState(listener: (state: ClawtrateState) => void): () => void;
  /** The number of unread tasks, for the dock or taskbar badge. */
  setBadge(count: number): void;
  /** Hand a file's bytes to the main process for a later message. */
  attach(file: { name: string; type: string; data: ArrayBuffer }): Promise<AttachmentInfo>;
  /** Save bytes the Work pane holds to a file the person chooses in the system's save dialog. */
  save(file: { name: string; data: ArrayBuffer }): Promise<SaveResult>;
};

function invokeUpdateTrack(
  channel: "clawtrate:update:check" | "clawtrate:update:track",
  track: unknown,
  ...revision: number[]
) {
  return track === "stable" || track === "nightly"
    ? ipcRenderer.invoke(channel, track, ...revision)
    : ipcRenderer.invoke(channel);
}

const api: DesktopHostApi = {
  platform: process.platform,
  desktopUpdates: {
    get: () => ipcRenderer.invoke("clawtrate:update:get"),
    check: (track, revision) =>
      typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0
        ? invokeUpdateTrack("clawtrate:update:check", track, revision)
        : ipcRenderer.invoke("clawtrate:update:check"),
    chooseTrack: (track) => invokeUpdateTrack("clawtrate:update:track", track),
    download: (id) =>
      typeof id === "string"
        ? ipcRenderer.invoke("clawtrate:update:download", id)
        : ipcRenderer.invoke("clawtrate:update:download"),
    subscribe(listener) {
      const changed = (_event: IpcRendererEvent, snapshot: DesktopUpdateSnapshot) => {
        try {
          listener(snapshot);
        } catch {
          // Deliver this revision to the remaining subscribers.
        }
      };
      ipcRenderer.on("clawtrate:update:changed", changed);
      return () => ipcRenderer.removeListener("clawtrate:update:changed", changed);
    },
  },
  hello: () => ipcRenderer.invoke("clawtrate:hello"),
  send: (command) => ipcRenderer.invoke("clawtrate:command", command),
  attach: (file) => ipcRenderer.invoke("clawtrate:attach", file),
  save: (file) => ipcRenderer.invoke("clawtrate:save", file),
  onState(listener) {
    const handler = (_event: IpcRendererEvent, state: ClawtrateState) => listener(state);
    ipcRenderer.on("clawtrate:state", handler);
    return () => ipcRenderer.removeListener("clawtrate:state", handler);
  },
  setBadge: (count) => ipcRenderer.send("clawtrate:badge", count),
};

contextBridge.exposeInMainWorld("clawtrateHost", api);
