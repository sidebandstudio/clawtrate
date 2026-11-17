// Exposes a narrow, typed IPC surface to the renderer. No Node or Electron
// objects cross the bridge, only plain data, four functions and the platform name.

import type { AttachmentInfo, BridgeCommand, ClawtrateState, HostInfo } from "@clawtrate/core";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export type DesktopHostApi = {
  platform: string;
  hello(): Promise<{ info: HostInfo; state: ClawtrateState }>;
  /** Resolves with the command's answer (see `BridgeResultFor`). */
  send(command: BridgeCommand): Promise<unknown>;
  onState(listener: (state: ClawtrateState) => void): () => void;
  /** Hand a file's bytes to the main process for a later message. */
  attach(file: { name: string; type: string; data: ArrayBuffer }): Promise<AttachmentInfo>;
};

const api: DesktopHostApi = {
  platform: process.platform,
  hello: () => ipcRenderer.invoke("clawtrate:hello"),
  send: (command) => ipcRenderer.invoke("clawtrate:command", command),
  attach: (file) => ipcRenderer.invoke("clawtrate:attach", file),
  onState(listener) {
    const handler = (_event: IpcRendererEvent, state: ClawtrateState) => listener(state);
    ipcRenderer.on("clawtrate:state", handler);
    return () => ipcRenderer.removeListener("clawtrate:state", handler);
  },
};

contextBridge.exposeInMainWorld("clawtrateHost", api);
