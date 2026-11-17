// The part of every Node host that is the same in Electron and the web host:
// one core client, the device's data directory, and development gateway detection.

import {
  AttachmentStore,
  ClawtrateClient,
  defaultApprovalInstructions,
  validateGatewayUrl,
  type ApprovalInstructions,
  type BridgePolicy,
  type HostInfo,
} from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const APP_VERSION = "0.1.0";

/** The only endpoint the development gateway ever uses (`openclaw --dev`, loopback). */
export const DEV_GATEWAY_URL = "ws://127.0.0.1:19001";

export type DevGatewayConnection = { url: string; token: string };

/** Where `pnpm dev-gateway start` writes the local gateway's bootstrap token. */
export function devConnectionPath(repoRoot: string): string {
  return join(repoRoot, "tools/dev-gateway/.run/connection.json");
}

/**
 * The development gateway's connection, if the dev tooling wrote one. The file
 * supplies only the token: any URL other than the fixed loopback endpoint is
 * rejected, so editing the file cannot relabel another gateway as development.
 */
export function readDevConnection(repoRoot: string, path = devConnectionPath(repoRoot)) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DevGatewayConnection>;
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string" || !parsed.token) {
      return null;
    }
    if (validateGatewayUrl(parsed.url) !== DEV_GATEWAY_URL) return null;
    return { url: DEV_GATEWAY_URL, token: parsed.token } satisfies DevGatewayConnection;
  } catch {
    return null;
  }
}

/** The approve command to show. Only the development gateway gets the dev tooling's command. */
export function approvalInstructionsFor(
  devGateway: DevGatewayConnection | null,
): (gatewayUrl: string, requestId: string) => ApprovalInstructions {
  return (gatewayUrl, requestId) =>
    devGateway && gatewayUrl === DEV_GATEWAY_URL
      ? { command: "pnpm dev-gateway approve", note: null }
      : defaultApprovalInstructions(gatewayUrl, requestId);
}

export type HostRuntime = {
  client: ClawtrateClient;
  info: HostInfo;
  policy: BridgePolicy;
};

export class SavedGatewayRefusedError extends Error {
  constructor(url: string) {
    super(
      `This host only connects to the development gateway, but its data directory remembers ${url}. ` +
        "Use a separate --data-dir for the development gateway, or start with an access token.",
    );
    this.name = "SavedGatewayRefusedError";
  }
}

export async function startHostRuntime(options: {
  kind: HostInfo["kind"];
  displayName: string;
  dataDir: string;
  devGateway: DevGatewayConnection | null;
  /** Connect to the development gateway at startup when nothing else is saved. */
  autoConnectDev?: boolean;
  /**
   * Only ever connect to the development gateway. Enforced by the client before
   * every connection, including a saved one, so token-free hosts cannot resume
   * another gateway.
   */
  devOnly?: boolean;
}): Promise<HostRuntime> {
  if (options.devOnly && !options.devGateway) {
    throw new Error(
      "Development-only mode needs the development gateway. Run `pnpm dev-gateway up`.",
    );
  }
  const client = new ClawtrateClient(
    createNodeHost({
      dataDir: options.dataDir,
      client: {
        displayName: options.displayName,
        version: APP_VERSION,
        platform: process.platform,
      },
      approvalInstructions: approvalInstructionsFor(options.devGateway),
      log: (level, message) => {
        if (level !== "debug") console[level === "info" ? "log" : level](`[core] ${message}`);
      },
    }),
    options.devOnly ? { allowGatewayUrl: (url) => url === DEV_GATEWAY_URL } : {},
  );
  if (options.devOnly) {
    const saved = await client.savedSettings();
    if (saved && saved.url !== DEV_GATEWAY_URL) throw new SavedGatewayRefusedError(saved.url);
  }
  await client.start();
  if (options.autoConnectDev && options.devGateway && client.state.connection.status === "idle") {
    await client.connect(options.devGateway);
  }
  return {
    client,
    info: {
      kind: options.kind,
      version: APP_VERSION,
      devGateway: options.devGateway ? { url: options.devGateway.url } : null,
    },
    // Files viewers add before sending, held in this process until a message takes them.
    policy: {
      devGateway: options.devGateway,
      attachments: new AttachmentStore({ newId: randomUUID }),
    },
  };
}
