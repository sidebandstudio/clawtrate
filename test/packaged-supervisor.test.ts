import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

if (process.platform === "win32") {
  it.each(["worker failure", "supervisor death"])(
    "contains the Windows worker on %s",
    async (mode) => {
      const fixture = mkdtempSync(join(tmpdir(), "clawtrate-supervisor-"));
      const root = mkdtempSync(join(tmpdir(), "clawtrate-pairing-"));
      const pidFile = join(fixture, "pid");
      const supervisor = join(fixture, "windows-job.ps1");
      copyFileSync(
        fileURLToPath(new URL("../e2e-packaged/windows-job.ps1", import.meta.url)),
        supervisor,
      );
      const finalizer = new URL("../e2e-packaged/windows-gateway.ts", import.meta.url).href;
      writeFileSync(
        join(fixture, "windows-gateway.ts"),
        `import {removeDrainedRoot} from ${JSON.stringify(finalizer)}; await removeDrainedRoot(${JSON.stringify(root)}, 'e2e-fedcba98', '0'.repeat(48));`,
      );
      writeFileSync(
        join(fixture, "windows-worker.ts"),
        `
      import { readSync, writeFileSync } from 'node:fs';
      const permit = Buffer.alloc(1);
      if (readSync(0, permit) !== 1 || permit[0] !== 1) process.exit(2);
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      ${mode === "worker failure" ? "process.exit(23);" : "setTimeout(() => {}, 15000);"}
    `,
      );
      const run = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", supervisor], {
        windowsHide: true,
        env: {
          ...process.env,
          CLAWTRATE_PACKAGED_HOME: join(root, "home"),
          CLAWTRATE_PACKAGED_NODE: process.execPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [run.stdout, run.stderr])
        stream.on("data", (chunk) => {
          output += chunk;
        });
      const exit = once(run, "exit");
      try {
        if (mode === "worker failure") {
          expect((await exit)[0], output).toBe(23);
          expect(existsSync(root)).toBe(false);
        } else {
          const deadline = Date.now() + 10000;
          while (!existsSync(pidFile) && run.exitCode === null && Date.now() < deadline)
            await sleep(25);
          expect(existsSync(pidFile), output).toBe(true);
          const pid = Number(readFileSync(pidFile, "utf8"));
          process.kill(pid, 0);
          run.kill();
          await exit;
          await expect
            .poll(
              () => {
                try {
                  process.kill(pid, 0);
                  return "alive";
                } catch (error) {
                  return (error as NodeJS.ErrnoException).code;
                }
              },
              { timeout: 2000 },
            )
            .toBe("ESRCH");
        }
      } finally {
        run.stdin.end();
        if (run.exitCode === null && run.signalCode === null) run.kill();
        for (const path of [fixture, root]) rmSync(path, { recursive: true, force: true });
      }
    },
    20000,
  );
} else {
  it("delivers SIGTERM sent to the launcher PID directly to the CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-launcher-"));
    const cli = join(dir, "cli.mjs");
    writeFileSync(cli, "process.send(process.pid); setInterval(() => {}, 1000);");
    const launcher = new URL("../e2e-packaged/run-cli.ts", import.meta.url).href;
    const run = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {runCli} from ${JSON.stringify(launcher)}; await runCli([${JSON.stringify(cli)}]);`,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    try {
      expect((await once(run, "message"))[0]).toBe(run.pid);
      const exit = once(run, "exit");
      run.kill("SIGTERM");
      expect((await exit)[1]).toBe("SIGTERM");
    } finally {
      run.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
