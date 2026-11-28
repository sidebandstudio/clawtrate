import { once } from "node:events";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { MODEL_ID, MODEL_REF, PROVIDER_ID } from "../../tools/dev-gateway/src/env.ts";
import { startFakeProvider } from "../../tools/dev-gateway/src/fake-provider.ts";

export const FIRST_MESSAGE = "Hello from the packaged first-run check.";
export const SCRIPTED_REPLY = "This is the scripted development model.";

export async function scriptedProvider(profile: string) {
  const configFile = join(profile, "openclaw.json");
  if (!lstatSync(profile).isDirectory() || !lstatSync(configFile).isFile()) {
    throw new Error("The installed profile has no regular gateway config.");
  }
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  if (config.gateway?.mode !== "local" || config.gateway?.bind !== "loopback") {
    throw new Error("The installed gateway is not configured for loopback.");
  }

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
        providers: {
          [PROVIDER_ID]: {
            baseUrl: `${base}/v1`,
            api: "openai-completions",
            apiKey: "scripted-dev-provider",
            models: [
              {
                id: MODEL_ID,
                name: "Scripted dev model",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          model: { primary: MODEL_REF },
        },
      },
    };
    // Atomic replacement lets OpenClaw's config watcher see a complete file.
    const staged = join(profile, ".first-run-config.json");
    writeFileSync(staged, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(staged, configFile);
    return server;
  } catch (error) {
    server.close();
    throw error;
  }
}
