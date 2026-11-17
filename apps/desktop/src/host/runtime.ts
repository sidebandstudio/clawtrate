// The part of every Node host that is the same in Electron and the web host:
// one core client, the device's data directory, and development gateway detection.

import {
  ClawtrateClient,
  defaultApprovalInstructions,
  type ApprovalInstructions,
  type BridgePolicy,
  type HostInfo,
} from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { provenEndpoint } from "../../../../tools/dev-gateway/src/endpoint.ts";
import {
  DEFAULT_GATEWAY_URL,
  runDirFor,
  validateInstanceName,
} from "../../../../tools/dev-gateway/src/instance.ts";
import type { Identify } from "../../../../tools/dev-gateway/src/state-guard.ts";

export { selectInstance } from "../../../../tools/dev-gateway/src/instance.ts";

export const APP_VERSION = "0.1.0";

/** The default development instance's endpoint (`openclaw --dev`, loopback). */
export const DEV_GATEWAY_URL = DEFAULT_GATEWAY_URL;

export type DevGatewayConnection = {
  url: string;
  token: string;
  /** The dev-gateway instance; null is the default instance. */
  instance: string | null;
};

/** This checkout's run folder for an instance, where `pnpm dev-gateway start` writes its files. */
export function devRunDir(repoRoot: string, instance: string | null = null): string {
  return runDirFor(instance, join(repoRoot, "tools/dev-gateway/.run"));
}

/**
 * The selected development instance's connection, only when this checkout
 * started that instance and its gateway is running now: the instance's
 * marker, run id, checkout, port and live gateway process must all agree with
 * this checkout's run and connection files (`provenEndpoint`). Anything stale,
 * incomplete, linked or mismatched gives null.
 */
export function readDevConnection(
  repoRoot: string,
  options: { instance?: string | null; home?: string; identify?: Identify } = {},
): DevGatewayConnection | null {
  // The name is validated before any path is built from it.
  const instance = options.instance == null ? null : validateInstanceName(options.instance);
  let checkout: string;
  try {
    checkout = realpathSync(repoRoot);
  } catch {
    return null;
  }
  const proof = provenEndpoint({
    instance,
    home: options.home ?? homedir(),
    runDir: devRunDir(repoRoot, instance),
    checkout,
    ...(options.identify ? { identify: options.identify } : {}),
  });
  return "refusal" in proof ? null : proof;
}

/** The approve command to show. Only the development gateway gets the dev tooling's command. */
export function approvalInstructionsFor(
  devGateway: DevGatewayConnection | null,
): (gatewayUrl: string, requestId: string) => ApprovalInstructions {
  return (gatewayUrl, requestId) =>
    devGateway && gatewayUrl === devGateway.url
      ? {
          command:
            devGateway.instance === null
              ? "pnpm dev-gateway approve"
              : `pnpm dev-gateway approve --instance ${devGateway.instance}`,
          note: null,
        }
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
   * Only ever connect to the development gateway, and only while `recheckDevGateway`
   * still proves it. Enforced by the client before every connection, including a
   * saved one and every retry, so token-free hosts cannot resume another gateway
   * or follow a port that a different process has taken over.
   */
  devOnly?: boolean;
  /** Proves the development gateway again; usually `readDevConnection` with the same options. */
  recheckDevGateway?: () => DevGatewayConnection | null;
}): Promise<HostRuntime> {
  if (options.devOnly && (!options.devGateway || !options.recheckDevGateway)) {
    throw new Error(
      "Development-only mode needs the development gateway. Run `pnpm dev-gateway up`.",
    );
  }
  // The one gateway a development-only host may open: the selected instance's.
  const devOnly = options.devOnly ? options.devGateway : null;
  const devGateway = options.devGateway
    ? { url: options.devGateway.url, token: options.devGateway.token }
    : null;
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
    devOnly
      ? {
          allowGatewayUrl: (url) => {
            if (url !== devOnly.url) return false;
            const proof = options.recheckDevGateway!();
            return proof !== null && proof.url === devOnly.url && proof.token === devOnly.token;
          },
        }
      : {},
  );
  if (devOnly) {
    const saved = await client.savedSettings();
    if (saved && saved.url !== devOnly.url) throw new SavedGatewayRefusedError(saved.url);
  }
  await client.start();
  if (options.autoConnectDev && devGateway && client.state.connection.status === "idle") {
    await client.connect(devGateway);
  }
  return {
    client,
    info: {
      kind: options.kind,
      version: APP_VERSION,
      devGateway: devGateway ? { url: devGateway.url } : null,
    },
    policy: { devGateway },
  };
}
