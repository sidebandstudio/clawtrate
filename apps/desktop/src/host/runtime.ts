// The part of every Node host that is the same in Electron and the web host:
// one core client, the device's data directory, and development gateway detection.

import {
  ClawtrateClient,
  defaultApprovalInstructions,
  validateGatewayUrl,
  type ApprovalInstructions,
  type BridgePolicy,
  type HostInfo,
} from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_GATEWAY_URL,
  namedGatewayUrl,
  runDirFor,
  validateInstanceName,
} from "../../../../tools/dev-gateway/src/instance.ts";

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

/** Where `pnpm dev-gateway start` writes an instance's bootstrap token in this checkout. */
export function devConnectionPath(repoRoot: string, instance: string | null = null): string {
  return join(runDirFor(instance, join(repoRoot, "tools/dev-gateway/.run")), "connection.json");
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

/**
 * The selected development instance's connection, if this checkout's dev
 * tooling wrote one. The file supplies only the token. The default instance's
 * endpoint is fixed. A named instance's endpoint must be a loopback address on
 * a port from the tool's named-instance range, equal to the gateway port the
 * tool recorded for that instance in its run file next to it. Anything else is
 * rejected, so editing the files cannot relabel another gateway as development.
 */
export function readDevConnection(
  repoRoot: string,
  options: { instance?: string | null; path?: string } = {},
): DevGatewayConnection | null {
  const instance = options.instance == null ? null : validateInstanceName(options.instance);
  const path = options.path ?? devConnectionPath(repoRoot, instance);
  try {
    const parsed = readJson(path);
    if (!parsed || typeof parsed.url !== "string") return null;
    if (typeof parsed.token !== "string" || !parsed.token) return null;
    if ((parsed.instance ?? null) !== instance) return null;
    let expected: string | null;
    if (instance === null) {
      expected = DEV_GATEWAY_URL;
    } else {
      const record = readJson(join(dirname(path), "state.json"));
      expected = namedGatewayUrl(record?.gatewayPort);
    }
    if (expected === null || validateGatewayUrl(parsed.url) !== expected) return null;
    return { url: expected, token: parsed.token, instance } satisfies DevGatewayConnection;
  } catch {
    return null;
  }
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
    devOnly ? { allowGatewayUrl: (url) => url === devOnly.url } : {},
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
