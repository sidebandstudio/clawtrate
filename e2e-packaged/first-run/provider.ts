import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import {
  accountProviders,
  saveAccountCommand,
  SCRIPTED_ACCOUNTS,
} from "../../tools/dev-gateway/src/accounts.ts";
import { MODEL_ID } from "../../tools/dev-gateway/src/env.ts";
import { startFakeProvider } from "../../tools/dev-gateway/src/fake-provider.ts";

export const FIRST_MESSAGE = "Hello from the packaged first-run check.";
export const SCRIPTED_REPLY = "This is the scripted development model.";

export async function scriptedProvider(profile: string, appData: string) {
  const configFile = join(profile, "openclaw.json");
  if (!lstatSync(profile).isDirectory() || !lstatSync(configFile).isFile()) {
    throw new Error("The installed profile has no regular gateway config.");
  }
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  if (config.gateway?.mode !== "local" || config.gateway?.bind !== "loopback") {
    throw new Error("The installed gateway is not configured for loopback.");
  }
  const account = SCRIPTED_ACCOUNTS[0]!;

  const server = startFakeProvider({ port: 0 });
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error("The scripted provider did not answer its health check.");
    const next = {
      ...config,
      proxy: { proxyUrl: base },
      models: {
        mode: "replace",
        providers: { [account.provider]: accountProviders(port)[account.provider] },
      },
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          model: { primary: `${account.provider}/${MODEL_ID}` },
        },
      },
    };
    // Atomic replacement lets OpenClaw's config watcher see a complete file.
    const staged = join(profile, ".first-run-config.json");
    writeFileSync(staged, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(staged, configFile);

    // Use the same fake account as the development gateway. Its key takes
    // the gateway's normal save path, so a new bot sees the shared account.
    const { args, stdin } = saveAccountCommand(account);
    const installed = join(appData, "openclaw", "bin", "openclaw");
    const saved = spawnSync(installed, ["--profile", "clawtrate", ...args], {
      env: { HOME: dirname(profile), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      input: stdin,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 60_000,
    });
    if (saved.status !== 0) throw new Error("OpenClaw did not save the scripted account.");
    return server;
  } catch (error) {
    server.close();
    throw error;
  }
}
