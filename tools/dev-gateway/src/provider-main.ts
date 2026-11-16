// Entry point for the scripted model server, started in the background by `start`.

import { startFakeProvider } from "./fake-provider.ts";
import { PROVIDER_PORT } from "./env.ts";

const port = Number(process.env.SCRIPTED_PROVIDER_PORT ?? PROVIDER_PORT);
const server = startFakeProvider({
  port,
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  ...(process.env.SCRIPTED_PROVIDER_DUMP ? { dumpPath: process.env.SCRIPTED_PROVIDER_DUMP } : {}),
});
server.on("listening", () => console.log(`scripted provider listening on 127.0.0.1:${port}`));
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
