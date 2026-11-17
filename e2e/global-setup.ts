// Starts what the end-to-end test needs and returns the teardown that stops it:
// a fresh, seeded development gateway (unless one this tool started is already
// running) and a preview host with a fresh device identity.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
export const E2E_PORT = 5317;

function devGateway(...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8" });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Stop a child we started: SIGTERM, a bounded wait, then SIGKILL. */
async function stopChild(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs),
  );
  if ((await Promise.race([exited, timer])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

export default async function globalSetup() {
  const startedGateway = !devGateway("status").includes("healthy     yes");
  if (startedGateway) {
    if (await portOpen(19001))
      throw new Error("port 19001 is in use by something this tool did not start");
    // Every start is a fresh, seeded gateway.
    devGateway("start");
  } else {
    // Reusing the gateway this tool is running: seeding verifies what exists.
    devGateway("seed");
  }

  execFileSync("pnpm", ["--filter", "@clawtrate/desktop", "build:web"], {
    cwd: ROOT,
    stdio: "ignore",
  });

  const dataDir = mkdtempSync(join(tmpdir(), "clawtrate-e2e-"));
  const host = spawn(
    process.execPath,
    [
      join(ROOT, "apps/desktop/src/web-host/main.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(E2E_PORT),
      "--data-dir",
      dataDir,
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`preview host did not start:\n${output}`)),
      20_000,
    );
    host.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /Local\s+(http:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    host.once("exit", (code) => reject(new Error(`preview host exited with ${code}:\n${output}`)));
  });
  process.env.CLAWTRATE_E2E_URL = url.replace("localhost", "127.0.0.1");

  return async () => {
    await stopChild(host);
    rmSync(dataDir, { recursive: true, force: true });
    if (startedGateway) devGateway("stop");
  };
}
