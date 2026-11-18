// The words of the connection and pairing screens (docs/design/visual-language.md,
// section 10), and the setup steps they show. The desktop's `ConnectScreen.tsx`
// and the iOS app's screens both read them from here. Pure: no DOM and no React.

import type { ConnectionState } from "@clawtrate/core";
import { gatewayLabel } from "./format.ts";

export const PRODUCT_NAME = "Clawtrate";
export const SLOGAN = "Your OpenClaw agents, orchestrated.";

export const CONNECT_WORDS = {
  /** The welcome screen's one action (F-001), and the connect form's submit on the desktop. */
  connect: "Connect a gateway",
  connecting: "Connecting…",
  connectTitle: "Connect to your gateway",
  address: "Gateway address",
  token: "Token, for the first pairing only",
  tokenLabel: "Gateway token, needed for the first pairing only",
  devGateway: "Use the development gateway",
  hint: `${PRODUCT_NAME} works with an OpenClaw gateway you already run. It asks for read access only, and the token is used once.`,
  missingAddress: {
    title: "Enter the gateway's address",
    message: "It looks like ws://host:port or wss://host.",
  },
  tryAgain: "Try again",
  useAnother: "Use another gateway",
  approveTitle: "Approve this device",
  copyApprove: "Copy approve command",
  copied: "Copied.",
  scopesLabel: "This device asks to",
  checkNow: "Check now",
  checking: "Checking…",
  setupLabel: "Setting up",
  waitingStep: "Waiting for approval",
  waiting: "Waiting for approval, checking again",
  notYet: "Not approved yet, checking again",
  protocolTitle: "This gateway speaks another protocol",
  retry: "Retry",
  retrying: "Retrying…",
  chooseAnother: "Choose another gateway",
  preparingIdentity: "Preparing device identity…",
} as const;

/** A connection failure's title. */
export function failureTitle(code: string | null | undefined): string {
  switch (code) {
    case "PAIRING_ENDED":
      return "The pairing request is no longer pending";
    default:
      return "Could not connect";
  }
}

/** What a requested scope lets this device do, in plain words. */
const SCOPE_WORDS: Record<string, string> = {
  "operator.read": "Read bots, tasks and conversations",
};

/** A requested scope in plain words; an unknown scope shows its id. */
export function scopeWords(scope: string): string {
  return SCOPE_WORDS[scope] ?? scope;
}

/** The pairing screen's sentence under its title. */
export function pairingLede(gatewayUrl: string | null): string {
  return `${gatewayLabel(gatewayUrl)} has not seen this device before. Approve it once on the gateway's machine and ${PRODUCT_NAME} connects by itself.`;
}

/** The seconds until the host's next retry, after the waiting words: " in 4s", or " now". */
export function countdownWords(until: number | null, now: number): string {
  // No retry waiting means an attempt is under way.
  if (until === null) return " now";
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return seconds > 0 ? ` in ${seconds}s` : " now";
}

/** The protocol notice's sentence: both versions, and what to do. */
export function protocolLede(
  gatewayUrl: string | null,
  protocol: { gateway: number | null; client: number } | undefined,
): string {
  const gateway = gatewayLabel(gatewayUrl);
  return `${
    protocol?.gateway === null || protocol?.gateway === undefined
      ? `${gateway} does not speak protocol ${protocol?.client ?? ""}, the one this version of ${PRODUCT_NAME} speaks.`
      : `${gateway} speaks protocol ${protocol.gateway}. This version of ${PRODUCT_NAME} speaks protocol ${protocol.client}.`
  } Update the one that is older, then retry.`;
}

export type SetupStepState = "done" | "current" | "pending";

export type SetupStep = {
  state: SetupStepState;
  /** Null for the waiting step, whose words the screen writes with its countdown. */
  label: string | null;
  /** The pairing step while it waits for approval. */
  waiting?: boolean;
};

/**
 * Setting up a gateway, one step at a time: connecting, pairing this device,
 * loading its bots (F-003). The app opens as soon as the bots have loaded.
 */
export function setupSteps(connection: ConnectionState, loadingBots: boolean): SetupStep[] {
  const gateway = gatewayLabel(connection.gatewayUrl);
  const pairing = connection.status === "pairing";
  const reached = pairing || loadingBots;
  return [
    reached
      ? { state: "done", label: `Connected to ${gateway}` }
      : { state: "current", label: `Connecting to ${gateway}` },
    loadingBots || (connection.paired && !pairing)
      ? { state: "done", label: "This device is paired" }
      : pairing
        ? { state: "current", label: null, waiting: true }
        : { state: "pending", label: "Pair this device" },
    loadingBots
      ? { state: "current", label: "Loading bots" }
      : { state: "pending", label: "Load bots" },
  ];
}
