import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FORBIDDEN_PORTS } from "../e2e/ports.ts";
export function appEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(CLAWTRATE_|ELECTRON_|NODE_OPTIONS$|OPENCLAW_)/.test(
          process.platform === "win32" ? key.toUpperCase() : key,
        ),
    ),
  );
}
/** Waits for Chromium to write the debugging port it chose into the data folder, and reads it. */
export async function debuggingPort(userData: string, app: ChildProcess): Promise<number> {
  const portFile = join(userData, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  let text: string;
  for (;;) {
    try {
      text = readFileSync(portFile, "utf8");
      // Chromium can create the file before writing it: wait for the port's line to end.
      if (text.includes("\n")) break;
    } catch (error) {
      // Chromium may still hold the file open on Windows after creating it.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EBUSY") throw error;
    }
    if (app.exitCode !== null) throw new Error(`the app exited with ${app.exitCode}`);
    if (Date.now() > deadline) throw new Error("the app did not open its debugging port");
    await sleep(200);
  }
  const port = Number(text.split("\n")[0]);
  if (!Number.isInteger(port) || port <= 0 || FORBIDDEN_PORTS.includes(port)) {
    throw new Error(`unexpected debugging port ${port}`);
  }
  return port;
}
