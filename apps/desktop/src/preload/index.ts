// Exposes a narrow, typed IPC surface to the renderer. No Node or Electron
// objects cross the bridge, only plain data, seven functions and the platform name.

import type {
  DesktopUpdates,
  DesktopUpdateSnapshot,
  AttachmentInfo,
  BridgeCommand,
  ChatLinkDelivery,
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
  /** Each Clawtrate link the app receives, validated by the main process, once. */
  onChatLink(listener: (link: ChatLinkDelivery) => void): () => void;
};

// Clawtrate links. One take at a time goes to the main process; a new subscription or an
// announced link while it is on its way asks for one more take after it, however many come.
// A link taken waits here until a listener has it, and a newer one replaces it.
const linkListeners = new Set<(link: ChatLinkDelivery) => void>();
let taking = false;
let takeAgain = false;
let waitingLink: ChatLinkDelivery | null = null;

/** Ask for the link the main process holds now, or once more after the take on its way. */
function askForLink(): void {
  if (taking) {
    takeAgain = true;
    return;
  }
  taking = true;
  ipcRenderer.invoke("clawtrate:link:take").then(
    (link: ChatLinkDelivery | null) => linkAnswered(link),
    // Nothing was taken: a link the main process holds waits there for the next ask.
    () => linkAnswered(null),
  );
}

/**
 * A take answered. When more was asked for meanwhile, the link taken waits for that take,
 * which may bring a newer one. Otherwise the waiting link goes to the listeners there are,
 * also when this take brought nothing or failed, so a link taken earlier is not left behind.
 */
function linkAnswered(link: ChatLinkDelivery | null): void {
  taking = false;
  if (link) waitingLink = link;
  if (takeAgain) {
    takeAgain = false;
    askForLink();
  } else handOverLink();
}

/**
 * Give the waiting link, once, to the listeners subscribed as this starts: one closed by an
 * earlier listener's call gets nothing, and one added by a call does not get this link.
 */
function handOverLink(): void {
  const link = waitingLink;
  if (!link || linkListeners.size === 0) return;
  waitingLink = null;
  for (const listener of [...linkListeners]) {
    if (!linkListeners.has(listener)) continue;
    try {
      listener(link);
    } catch {
      // Deliver this link to the remaining listeners.
    }
  }
}

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
    restart: (id) =>
      typeof id === "string"
        ? ipcRenderer.invoke("clawtrate:update:restart", id)
        : ipcRenderer.invoke("clawtrate:update:restart"),
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
  onChatLink(listener) {
    // Each subscription is its own, even for a listener given twice.
    const subscribed = (link: ChatLinkDelivery) => listener(link);
    linkListeners.add(subscribed);
    if (linkListeners.size === 1) ipcRenderer.on("clawtrate:link", askForLink);
    // The link that opened the app may be waiting, newer than any taken before: ask first.
    // Later ones are announced.
    askForLink();
    return () => {
      if (linkListeners.delete(subscribed) && linkListeners.size === 0)
        ipcRenderer.removeListener("clawtrate:link", askForLink);
    };
  },
};

contextBridge.exposeInMainWorld("clawtrateHost", api);
