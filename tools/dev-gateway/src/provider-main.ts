// Entry point for the scripted model server, started in the background by `start`.
// On an instance whose bots have browsers of their own it also serves the
// scripted pages (scripted-pages.ts), the only pages those browsers can open.

import { startFakeProvider } from "./fake-provider.ts";
import { startScriptedPages } from "./scripted-pages.ts";
import { PROVIDER_PORT } from "./env.ts";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const port = Number(process.env.SCRIPTED_PROVIDER_PORT ?? PROVIDER_PORT);
const pagesPort = process.env.SCRIPTED_PAGES_PORT ? Number(process.env.SCRIPTED_PAGES_PORT) : null;
const server = startFakeProvider({
  port,
  log,
  ...(process.env.SCRIPTED_STREAM_HOLD_FILE
    ? { streamHoldFile: process.env.SCRIPTED_STREAM_HOLD_FILE }
    : {}),
  ...(pagesPort ? { pagesOrigin: `http://127.0.0.1:${pagesPort}` } : {}),
  ...(process.env.SCRIPTED_SKILL_REVIEW === "1" ? { skillReview: true } : {}),
  ...(process.env.SCRIPTED_PROVIDER_DUMP ? { dumpPath: process.env.SCRIPTED_PROVIDER_DUMP } : {}),
});
server.on("listening", () => console.log(`scripted provider listening on 127.0.0.1:${port}`));
const pages = pagesPort ? startScriptedPages({ port: pagesPort, log }) : null;
pages?.on("listening", () => console.log(`scripted pages listening on 127.0.0.1:${pagesPort}`));
const shutdown = () => {
  pages?.close();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
