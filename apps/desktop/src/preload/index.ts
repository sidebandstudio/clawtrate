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

const api: DesktopHostApi = {
  platform: process.platform,
  desktopUpdates: {
    get: () => ipcRenderer.invoke("clawtrate:update:get"),
    check: (track) => ipcRenderer.invoke("clawtrate:update:check", track),
    chooseTrack: (track) => ipcRenderer.invoke("clawtrate:update:track", track),
    download: (id) => ipcRenderer.invoke("clawtrate:update:download", id),
    subscribe(listener) {
      const changed = (_event: IpcRendererEvent, snapshot: DesktopUpdateSnapshot) =>
        listener(snapshot);
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
