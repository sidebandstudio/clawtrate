// The part of every Node host that is the same in Electron and the web host:
// one core client, the device's data directory, and development gateway detection.

import { ClawtrateClient, type BridgePolicy, type HostInfo } from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const APP_VERSION = "0.1.0";

export type DevGatewayConnection = { url: string; token: string };

/** Where `pnpm dev-gateway start` writes the local gateway's URL and bootstrap token. */
export function devConnectionPath(repoRoot: string): string {
  return (
    process.env.CLAWTRATE_DEV_CONNECTION ?? join(repoRoot, "tools/dev-gateway/.run/connection.json")
  );
}

export function readDevConnection(repoRoot: string): DevGatewayConnection | null {
  const path = devConnectionPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DevGatewayConnection>;
    return typeof parsed.url === "string" && typeof parsed.token === "string"
      ? { url: parsed.url, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

export type HostRuntime = {
  client: ClawtrateClient;
  info: HostInfo;
  policy: BridgePolicy;
};

export async function startHostRuntime(options: {
  kind: HostInfo["kind"];
  displayName: string;
  dataDir: string;
  devGateway: DevGatewayConnection | null;
  /** Connect to the development gateway at startup when nothing else is saved. */
  autoConnectDev?: boolean;
  allowGatewayUrl?: (url: string) => boolean;
}): Promise<HostRuntime> {
  const client = new ClawtrateClient(
    createNodeHost({
      dataDir: options.dataDir,
      client: {
        displayName: options.displayName,
        version: APP_VERSION,
        platform: process.platform,
      },
      log: (level, message) => {
        if (level !== "debug") console[level === "info" ? "log" : level](`[core] ${message}`);
      },
    }),
  );
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
    policy: {
      devGateway: options.devGateway,
      ...(options.allowGatewayUrl ? { allowGatewayUrl: options.allowGatewayUrl } : {}),
    },
  };
}
