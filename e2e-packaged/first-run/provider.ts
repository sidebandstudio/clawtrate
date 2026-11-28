import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import {
  accountProviders,
  saveAccountCommand,
  SCRIPTED_ACCOUNTS,
} from "../../tools/dev-gateway/src/accounts.ts";
import { MODEL_ID } from "../../tools/dev-gateway/src/env.ts";
import { startFakeProvider } from "../../tools/dev-gateway/src/fake-provider.ts";
import type { RequestRecord } from "../../tools/dev-gateway/src/scripted-accounts.ts";

export const FIRST_MESSAGE = "Hello from the packaged first-run check.";
export const SCRIPTED_REPLY = "This is the scripted development model.";

export async function successfulScriptedRequests(server: Server): Promise<number> {
  const { port } = server.address() as AddressInfo;
  const reply = await fetch(`http://127.0.0.1:${port}/scripted/requests`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!reply.ok) throw new Error("The scripted provider did not return its request receipt.");
  const { requests } = (await reply.json()) as { requests: RequestRecord[] };
  return requests.filter(
    ({ account, model, status }) =>
      account === SCRIPTED_ACCOUNTS[0]!.id && model === MODEL_ID && status === 200,
  ).length;
}

export async function scriptedProvider(
  profile: string,
  appData: string,
  note: (text: string) => void,
) {
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
    note(`Started the scripted development provider on ${base}.`);
    function applyConfig() {
      const current = JSON.parse(readFileSync(configFile, "utf8"));
      if (current.gateway?.mode !== "local" || current.gateway?.bind !== "loopback") {
        throw new Error("The installed gateway is no longer configured for loopback.");
      }
      const next = {
        ...current,
        proxy: { proxyUrl: base },
        update: { ...current.update, checkOnStart: false },
        models: {
          ...current.models,
          mode: "merge",
          providers: {
            ...current.models?.providers,
            [account.provider]: accountProviders(port)[account.provider],
          },
        },
      };
      // Atomic replacement lets OpenClaw's config watcher see a complete file.
      const staged = join(profile, ".first-run-config.json");
      writeFileSync(staged, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(staged, configFile);
      note(
        `Advertised the scripted ${account.provider}/${MODEL_ID} model and set its loopback proxy. Kept the existing default model through the restart.`,
      );
    }

    // Use the same fake account as the development gateway. Its key takes
    // the gateway's normal save path, so a new bot sees the shared account.
    function prepareAccountSave() {
      const { args, stdin } = saveAccountCommand(account);
      const installed = join(appData, "openclaw", "bin", "openclaw");
      const writer = spawn(installed, ["--profile", "clawtrate", ...args], {
        env: { HOME: dirname(profile), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 180_000,
      });
      const saved = new Promise<void>((resolve, reject) => {
        writer.once("error", reject);
        writer.stdin.once("error", reject);
        writer.once("close", (status) =>
          status === 0
            ? resolve()
            : reject(new Error("OpenClaw did not save the scripted account.")),
        );
      });
      void saved.catch(() => undefined);
      return {
        async save() {
          writer.stdin.end(stdin);
          await saved;
          note(
            `Saved the synthetic ${account.id} account to the shared main store with the gateway's own account command.`,
          );
        },
        cancel() {
          if (writer.exitCode === null && writer.signalCode === null) writer.kill();
        },
      };
    }
    return { server, applyConfig, prepareAccountSave };
  } catch (error) {
    server.close();
    throw error;
  }
}
