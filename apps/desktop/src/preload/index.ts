// Exposes a narrow, typed IPC surface to the renderer. No Node or Electron
// objects cross the bridge, only plain data and four functions.

import type { BridgeCommand, ClawtrateState, HostInfo } from "@clawtrate/core";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export type DesktopHostApi = {
  platform: string;
  hello(): Promise<{ info: HostInfo; state: ClawtrateState }>;
  send(command: BridgeCommand): Promise<void>;
  onState(listener: (state: ClawtrateState) => void): () => void;
  /** The number of unread tasks, for the dock or taskbar badge. */
  setBadge(count: number): void;
};

const api: DesktopHostApi = {
  platform: process.platform,
  hello: () => ipcRenderer.invoke("clawtrate:hello"),
  send: (command) => ipcRenderer.invoke("clawtrate:command", command),
  onState(listener) {
    const handler = (_event: IpcRendererEvent, state: ClawtrateState) => listener(state);
    ipcRenderer.on("clawtrate:state", handler);
    return () => ipcRenderer.removeListener("clawtrate:state", handler);
  },
  setBadge: (count) => ipcRenderer.send("clawtrate:badge", count),
};

contextBridge.exposeInMainWorld("clawtrateHost", api);
