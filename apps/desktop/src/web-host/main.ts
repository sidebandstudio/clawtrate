// pnpm preview:web [--dev-gateway] [--no-access-token] [--instance <name>]
//                  [--port 5310] [--host 0.0.0.0] [--data-dir <dir>]
//
// Serves the Clawtrate renderer to a browser on another machine. The gateway
// connection, the device key and pairing all stay in this process.
// `--instance` (or CLAWTRATE_DEV_INSTANCE) selects the development instance
// whose gateway the development-only modes accept; the default instance otherwise.

import type { AddressInfo } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readDevConnection, selectInstance, startHostRuntime } from "../host/runtime.ts";
import { createAccessToken, startWebHost } from "./server.ts";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = join(APP_ROOT, "../..");

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "0.0.0.0" },
    port: { type: "string", default: "5310" },
    "data-dir": { type: "string" },
    "static-dir": { type: "string", default: join(APP_ROOT, "out/web") },
    "dev-gateway": { type: "boolean", default: false },
    "no-access-token": { type: "boolean", default: false },
    instance: { type: "string" },
  },
  allowPositionals: false,
});

function defaultDataDir(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "clawtrate", "web-host");
}

function networkUrls(port: number, query: string): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => `http://${entry!.address}:${port}/${query}`);
}

async function main(): Promise<void> {
  const instance = selectInstance(values.instance, process.env);
  const devGateway = readDevConnection(REPO_ROOT, { instance });
  const tokenDisabled = values["no-access-token"];
  if (tokenDisabled && !devGateway) {
    const flag = instance === null ? "" : ` --instance ${instance}`;
    throw new Error(
      `--no-access-token is only allowed with the development gateway. Run \`pnpm dev-gateway up${flag}\` first.`,
    );
  }
  const port = Number(values.port);
  const runtime = await startHostRuntime({
    kind: "web",
    displayName: "Clawtrate Web",
    dataDir: values["data-dir"] ?? defaultDataDir(),
    devGateway,
    autoConnectDev: values["dev-gateway"] || tokenDisabled,
    // Without an access token, anyone who can reach the port can use this host,
    // so it may only ever talk to the local development gateway: saved, typed,
    // retried or otherwise.
    devOnly: tokenDisabled,
  });
  const accessToken = tokenDisabled ? null : createAccessToken();
  const host = startWebHost({
    runtime,
    staticDir: values["static-dir"]!,
    host: values.host!,
    port,
    accessToken,
  });

  host.server.once("listening", () => {
    // With --port 0 the system chooses; print the port actually bound.
    const bound = (host.server.address() as AddressInfo).port;
    const query = accessToken ? `?token=${accessToken}` : "";
    console.log("\nClawtrate web preview");
    console.log(`  Local    http://localhost:${bound}/${query}`);
    for (const url of networkUrls(bound, query)) console.log(`  Network  ${url}`);
    console.log(
      accessToken
        ? "\nThe access token is shown once. Anyone with this link can read the connected gateway's sessions."
        : "\nAccess token disabled: this host only connects to the development gateway.",
    );
    if (devGateway) {
      const which = devGateway.instance === null ? "default" : `instance ${devGateway.instance}`;
      console.log(`Development gateway: ${devGateway.url} (${which})`);
    }
  });

  const shutdown = () => {
    runtime.client.stop();
    void host.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
