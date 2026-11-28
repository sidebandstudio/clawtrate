import { execFile, execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { Element, Step } from "./verdict.ts";

type Window = {
  id: number;
  pid: number;
  owner: string | null;
  title: string | null;
  layer: number;
  bounds: { X: number; Y: number; Width: number; Height: number };
};
type Installer = { name: string; pid: number };
type Observation = { windows: Window[]; installerProcesses: Installer[] };
type Sample = Observation & { step: Step; seconds: number };

const run = promisify(execFile);
const installerName = /(?:install )?command line developer tools/i;
const permissionOwner = /^(?:UserNotificationCenter|CoreServicesUIAgent|Local Network Privacy)$/i;

/** Capture process identity and windows independently of the application's AX tree. */
export function observeMac(out: string) {
  const began = new Date();
  const samples: Sample[] = [];
  const installers = new Map<number, Installer>();
  const alerts = new Map<number, Window>();
  const execs: { seconds: number; executable: string }[] = [];
  let auditReady = false;
  let auditReadyBeforeLaunch = false;
  let auditError = "";
  let auditExecEvents = 0;
  let samplesTaken = 0;
  let installerDialogFromAccessibility = false;
  // eslogger excludes its own process group from the event stream.
  const audit = spawn("/usr/bin/sudo", ["-n", "/usr/bin/eslogger", "exec"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  audit.on("error", (error) => (auditError = error.message));
  audit.stderr.on("data", (chunk: Buffer) => {
    auditError = (auditError + chunk.toString()).slice(0, 1000);
  });
  const input = createInterface({ input: audit.stdout });
  input.on("line", (line) => {
    try {
      const { target, args } = JSON.parse(line).event?.exec ?? {};
      const path = target?.executable?.path;
      if (typeof path === "string") auditExecEvents += 1;
      if (path === "/usr/bin/true") auditReady = true;
      const stub =
        path === "/usr/bin/git" || (path === "/usr/bin/xcrun" && args?.includes("/usr/bin/git"));
      if (stub || (typeof path === "string" && installerName.test(path))) {
        execs.push({ seconds: (Date.now() - began.getTime()) / 1000, executable: path });
      }
    } catch {
      // A monitor that never emits the probe does not establish a negative.
    }
  });

  async function probeAudit() {
    auditReady = false;
    for (let i = 0; i < 20 && !auditReady && audit.exitCode === null; i += 1) {
      execFileSync("/usr/bin/true");
      await sleep(250);
    }
    return auditReady;
  }

  async function confirmAudit() {
    auditReadyBeforeLaunch = await probeAudit();
  }

  async function sample(
    step: Step,
    appPid: number | undefined,
    atStep = false,
  ): Promise<Element[]> {
    const [windowList, processList] = await Promise.all([
      run(
        "/usr/bin/osascript",
        ["-l", "JavaScript", join(import.meta.dirname, "window-server.js")],
        { timeout: 10_000 },
      ),
      run("/bin/ps", ["-axww", "-o", "pid=,comm="], { timeout: 5000 }),
    ]);
    const processes = new Map<number, string>();
    for (const line of processList.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (match) processes.set(Number(match[1]), basename(match[2]!));
    }
    const installerProcesses = [...processes].flatMap(([pid, name]) =>
      installerName.test(name) ? [{ pid, name }] : [],
    );
    for (const process of installerProcesses) installers.set(process.pid, process);
    const windows = (JSON.parse(windowList.stdout) as Window[]).map((window) => ({
      ...window,
      owner: window.owner ?? processes.get(window.pid) ?? null,
    }));
    samplesTaken += 1;
    if (atStep) {
      samples.push({
        step,
        seconds: (Date.now() - began.getTime()) / 1000,
        windows,
        installerProcesses,
      });
    }
    return windows.flatMap((window) => {
      if (window.pid === appPid || !window.owner) return [];
      const isInstaller = installers.has(window.pid) || installerName.test(window.owner);
      const isPermissionWindow =
        permissionOwner.test(window.owner) &&
        window.bounds.Width >= 180 &&
        window.bounds.Height >= 100;
      if (!isInstaller && !isPermissionWindow) return [];
      alerts.set(window.id, window);
      return [
        {
          role: "SystemPermissionWindow",
          text: isInstaller
            ? `macOS command line developer tools installer (${window.owner})`
            : `macOS permission window owned by ${window.owner}${window.title ? `: ${window.title}` : ""}`,
        },
      ];
    });
  }

  function notePrompt(text: string) {
    if (installerName.test(text)) installerDialogFromAccessibility = true;
  }

  async function finish() {
    const auditReadyAfterWalk = auditReadyBeforeLaunch && (await probeAudit());
    if (audit.pid && audit.exitCode === null && audit.signalCode === null) {
      await run("/usr/bin/sudo", ["-n", "/bin/kill", "-TERM", String(audit.pid)], {
        timeout: 5000,
      }).catch((error: unknown) => {
        auditError = (auditError + String(error)).slice(0, 1000);
      });
    }
    input.close();
    audit.stdout.destroy();
    audit.stderr.destroy();
    const stamp = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");
    const predicate = [
      'process == "xcode-select"',
      'process == "xcrun"',
      'process == "Install Command Line Developer Tools"',
      'eventMessage CONTAINS[c] "command line developer tools"',
      'eventMessage CONTAINS[c] "CommandLineTools"',
    ].join(" OR ");
    const log = await run(
      "/usr/bin/log",
      [
        "show",
        "--style",
        "compact",
        "--start",
        stamp(began),
        "--end",
        stamp(new Date()),
        "--info",
        "--debug",
        "--predicate",
        predicate,
      ],
      { env: { PATH: "/usr/bin:/bin", TZ: "UTC" }, timeout: 25_000 },
    ).then(
      ({ stdout }) => stdout,
      (error: unknown) => `Unified log unavailable: ${String(error)}\n`,
    );
    writeFileSync(join(out, "developer-tools-unified-log.txt"), log);
    writeFileSync(
      join(out, "window-server.json"),
      JSON.stringify(
        {
          samplesTaken,
          samples,
          installerProcesses: [...installers.values()],
          alerts: [...alerts.values()],
          execs,
          auditError,
          auditExecEvents,
          auditReadyBeforeLaunch,
          auditReadyAfterWalk,
        },
        null,
        2,
      ) + "\n",
    );
    return {
      stubCalled: execs.some(
        ({ executable }) => executable === "/usr/bin/git" || executable === "/usr/bin/xcrun",
      )
        ? "called"
        : auditReadyAfterWalk
          ? "not-called"
          : "unverified",
      dialogShown:
        installerDialogFromAccessibility ||
        [...alerts.values()].some(
          ({ pid, owner }) => installers.has(pid) || installerName.test(owner ?? ""),
        )
          ? "shown"
          : samplesTaken > 0
            ? "not-observed"
            : "unverified",
      installerProcessObserved:
        installers.size > 0 || execs.some(({ executable }) => installerName.test(executable)),
      permissionWindowOwners: [
        ...new Set([...alerts.values()].flatMap(({ owner }) => (owner ? [owner] : []))),
      ],
    };
  }

  return { confirmAudit, sample, notePrompt, finish };
}
