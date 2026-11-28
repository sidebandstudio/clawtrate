// The connection's state and its problem, as Settings' Gateway pane names them
// (F-227).

import type { ConnectionState } from "@clawtrate/core";
import { gatewayLabel } from "../../../../packages/ui/src/format.ts";
import { failureTitle } from "./connect-words.ts";

export const GATEWAY_APPEARANCE = {
  connected: { label: "Connected", dot: "connected" },
  pairing: { label: "Pairing pending", dot: "connecting" },
  disconnected: { label: "Disconnected", dot: "disconnected" },
  idle: { label: "Not connected", dot: "disconnected" },
  offline: { label: "Offline", dot: "error" },
  connecting: { label: "Connecting", dot: "connecting" },
} as const;

/** The connection's state as understood by the Gateway pane. */
export function gatewayState(connection: ConnectionState): keyof typeof GATEWAY_APPEARANCE {
  switch (connection.status) {
    case "connected":
      // Re-pairing: the gateway holds this device's new authorization until its owner decides.
      return connection.upgrade.status === "requesting" || connection.upgrade.status === "pending"
        ? "pairing"
        : "connected";
    case "pairing":
      return "pairing";
    case "disconnected":
      return "disconnected";
    case "idle":
      return "idle";
    case "error":
      return "offline";
    case "connecting":
    case "reconnecting":
      // An attempt under way is connecting; waiting for the next one is offline.
      return connection.retryAt === null ? "connecting" : "offline";
  }
}

/** The pane's error line: pairing rejected or expired, unreachable, protocol incompatible. */
export function gatewayProblem(
  connection: ConnectionState,
): { title: string; message: string } | null {
  const error = connection.error;
  if (!error) return null;
  if (error.code === "PROTOCOL_MISMATCH") {
    return { title: "This gateway speaks another protocol", message: error.message };
  }
  if (error.code === "PAIRING_ENDED") {
    return { title: failureTitle(error.code), message: error.message };
  }
  if (connection.status === "connected") return null;
  return {
    title: "Can't reach the gateway",
    message: [error.message, error.hint].filter(Boolean).join(" "),
  };
}

/** The Gateway, Conversation and Advanced sections' words. */
export const SETTINGS_WORDS = {
  title: "Settings",
  close: "Close settings",
  gateway: "Gateway",
  address: "Address",
  noAddress: "None yet",
  state: "State",
  device: "This device",
  scopes: "Scopes in use",
  noScopes: "None while not connected",
  noneGranted: "None granted",
  server: "Gateway",
  reconnect: "Reconnect",
  disconnect: "Disconnect",
  useAnother: "Use another gateway",
  conversation: "Conversation",
  channelChats: "Show external channel chats",
  advanced: "Advanced",
  gatewayBot: "Show the gateway's own bot",
} as const;

/** The desktop's note under the switch, in three parts; the middle one names a gateway setting. */
export const CHANNEL_CHATS_NOTE = [
  "Off by default. Chats that reach a bot through Discord, Telegram, Slack, iMessage, WhatsApp, Signal or another channel stay out of the task list, its previews and its unread marks. A bot's main conversation always shows. If the gateway sends a channel's direct messages to it, which it does unless its ",
  "session.dmScope",
  " setting gives each channel conversation its own session, those messages still appear there.",
] as const;

/** Settings binds these device preferences to core state and bridge commands. */
export const DEVICE_SWITCHES = [
  {
    id: "channel-chats",
    heading: SETTINGS_WORDS.conversation,
    headingId: "settings-conversation",
    label: SETTINGS_WORDS.channelChats,
    note: CHANNEL_CHATS_NOTE,
    stateKey: "showChannelChats",
    command: "setShowChannelChats",
  },
  {
    id: "gateway-bot",
    heading: SETTINGS_WORDS.advanced,
    headingId: "settings-advanced",
    label: SETTINGS_WORDS.gatewayBot,
    note: "The gateway's own bot handles channel messages, other tools' calls and scheduled runs that name no bot. While the switch is off and you have another bot, the gateway's own bot stays off Home unless it is waiting on you.",
    stateKey: "showGatewayBot",
    command: "setShowGatewayBot",
  },
] as const;

export type DeviceSwitch = (typeof DEVICE_SWITCHES)[number];

/**
 * What the pane offers: Reconnect from Offline or Disconnected, Disconnect
 * (which keeps the pairing) while connected or trying to be, and Use another
 * gateway (which forgets this one) whenever there is a gateway.
 */
export function gatewayActions(connection: ConnectionState): {
  reconnect: boolean;
  disconnect: boolean;
  forget: boolean;
} {
  const state = gatewayState(connection);
  return {
    reconnect: state === "offline" || state === "disconnected",
    disconnect:
      connection.status === "connected" ||
      connection.status === "connecting" ||
      connection.status === "reconnecting",
    forget: connection.gatewayUrl !== null,
  };
}

/** The gateway's version and protocol, once the hello said them. */
export function serverWords(connection: ConnectionState): string | null {
  if (!connection.serverVersion) return null;
  return `OpenClaw ${connection.serverVersion}${connection.protocol !== null ? ` · protocol ${connection.protocol}` : ""}`;
}

/** The scopes the gateway granted, while connected. */
export function grantedWords(connection: ConnectionState): string {
  if (connection.status !== "connected") return SETTINGS_WORDS.noScopes;
  return connection.scopes.length > 0 ? connection.scopes.join(", ") : SETTINGS_WORDS.noneGranted;
}

/**
 * The gateway's address as Settings shows it: scheme, host, port and path, never
 * a user name, a password, a query or a fragment someone put in the address.
 */
export function addressWords(url: string | null): string {
  if (!url) return SETTINGS_WORDS.noAddress;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return url.replace(/[?#].*$/, "").replace(/\/\/[^/@]*@/, "//");
  }
}

/** The read-only pairing note, once the gateway has confirmed the pairing. */
export function pairingNote(connection: ConnectionState): string | null {
  if (!connection.paired || connection.gatewayUrl === null) return null;
  return `${gatewayLabel(connection.gatewayUrl)} keeps this device's pairing while it is disconnected. This device asks for read access only.`;
}
