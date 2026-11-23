// The real update check (docs/development/releases.md, "Check that the previous release
// updates in place"). Run only on a disposable Mac, such as a GitHub-hosted runner: it
// starts a real signed Clawtrate, which writes to the login keychain, and lets it replace
// itself. It drives the app's own Settings → Updates calls over the Chrome DevTools
// protocol, the one way in that a release build's fuses leave open, and checks that the
// app downloads the feed's offer, inspects it, and restarts into it in place.
//
//   node e2e-packaged/real-update/check.ts --app /Applications/Clawtrate.app --out <dir>
//     [--expect <version>] [--probe <running-signature-probe binary>]
//
// It writes <out>/result.json and the app's output, and exits 0 only when the app at
// --app was replaced by the offered version and that copy's signature is valid.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    out: { type: "string" },
    expect: { type: "string" },
    probe: { type: "string" },
  },
});
if (!values.app || !values.out) throw new Error("--app and --out are required");
const app = values.app;
const out = values.out;
mkdirSync(out, { recursive: true });
const executable = join(app, "Contents", "MacOS", "Clawtrate");
const APP_ID = "dev.clawtrate.desktop";

const result: Record<string, unknown> = { startedAt: new Date().toISOString() };
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

function run(file: string, args: string[]): string {
  const ran = spawnSync(file, args, { encoding: "utf8" });
  return `$ ${[file, ...args].join(" ")}\nexit ${ran.status}${ran.signal ? ` signal ${ran.signal}` : ""}\n${ran.stdout}${ran.stderr}`;
}

function bundleVersion(): string {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", join(app, "Contents", "Info.plist")],
    { encoding: "utf8" },
  ).trim();
}

/** Processes started from this app's bundle, with their parents. */
function appProcesses(): { pid: number; ppid: number; command: string }[] {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m && m[3]!.startsWith(app + "/"))
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
}

function mainPid(): number | null {
  return (
    appProcesses().find((p) => p.command === executable || p.command.startsWith(executable + " "))
      ?.pid ?? null
  );
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | null> | T | null) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/** A minimal Chrome DevTools protocol client for one page. */
class Page {
  private next = 1;
  private readonly waiting = new Map<
    number,
    (message: { result?: unknown; error?: unknown }) => void
  >();
  private readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
    });
    // The app quits on a restart before it answers that call.
    socket.addEventListener("close", () => {
      for (const resolve of this.waiting.values()) resolve({ error: "the page closed" });
      this.waiting.clear();
    });
  }
  static async open(url: string): Promise<Page> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Page(socket);
  }
  /** Evaluates an expression in the page, awaiting a promise, and returns its value as JSON. */
  async evaluate<T>(expression: string): Promise<T> {
    const id = this.next++;
    const reply = await new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      this.waiting.set(id, resolve);
      this.socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    const evaluated = reply.result as
      { result?: { value?: T }; exceptionDetails?: unknown } | undefined;
    if (reply.error || evaluated?.exceptionDetails)
      throw new Error(JSON.stringify(reply.error ?? evaluated?.exceptionDetails));
    return evaluated!.result!.value as T;
  }
  close() {
    this.socket.close();
  }
}

type Snapshot = {
  revision: number;
  runningVersion: string | null;
  selectedTrack: string | null;
  state: { kind: string; offerId?: string; version?: string; reason?: string };
  install: { kind: string; reason?: string; offerId?: string };
  inspectionFailure?: unknown;
};

const updates = "window.clawtrateHost.desktopUpdates";

async function main() {
  result.system = run("/usr/bin/sw_vers", []);
  result.previousVersion = bundleVersion();
  log(`previous version ${result.previousVersion as string}`);
  result.bundleSignature = run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    app,
  ]);

  const userData = mkdtempSync(join(tmpdir(), "clawtrate-real-update-"));
  // Through Launch Services, as a person opens it, with its own data folder and a debugging port.
  execFileSync("/usr/bin/open", [
    "-n",
    "-a",
    app,
    "--stdout",
    join(out, "app-stdout.txt"),
    "--stderr",
    join(out, "app-stderr.txt"),
    "--args",
    `--user-data-dir=${userData}`,
    "--remote-debugging-port=0",
  ]);
  const port = await until("the debugging port", 60_000, () => {
    try {
      const text = readFileSync(join(userData, "DevToolsActivePort"), "utf8");
      return text.includes("\n") ? Number(text.split("\n")[0]) : null;
    } catch {
      return null;
    }
  });
  const pid = await until("the app's main process", 30_000, mainPid);
  result.mainPid = pid;
  log(`app pid ${pid}, debugging port ${port}`);
  const target = await until("the app's window", 60_000, async () => {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    return targets.find((t) => t.type === "page") ?? null;
  });
  const page = await Page.open(target.webSocketDebuggerUrl);
  const snapshot = () => page.evaluate<Snapshot>(`${updates}.get()`);
  await until("the update bridge", 60_000, () =>
    page
      .evaluate<boolean>(`typeof window.clawtrateHost?.desktopUpdates?.get === "function"`)
      .then((ok) => (ok ? true : null)),
  );
  const first = await snapshot();
  result.initial = first;
  log(`initial ${JSON.stringify(first.state)} track ${first.selectedTrack}`);
  await page.evaluate(
    `${updates}.check(${JSON.stringify(first.selectedTrack)}, ${first.revision})`,
  );
  const offered = await until("the check", 120_000, async () => {
    const s = await snapshot();
    return s.state.kind === "checking" || s.state.kind === "not-checked" ? null : s;
  });
  result.checked = offered;
  log(`checked ${JSON.stringify(offered.state)}`);
  if (offered.state.kind !== "offered") throw new Error(`no offer: ${offered.state.kind}`);
  if (values.expect && offered.state.version !== values.expect)
    throw new Error(`offered ${offered.state.version}, expected ${values.expect}`);
  result.offeredVersion = offered.state.version;
  const started = Date.now();
  await page.evaluate(`${updates}.download(${JSON.stringify(offered.state.offerId)})`);
  const downloaded = await until("the download and inspection", 600_000, async () => {
    const s = await snapshot();
    return s.state.kind === "downloading" ? null : s;
  });
  result.downloaded = downloaded;
  result.downloadAndInspectMs = Date.now() - started;
  log(
    `downloaded ${JSON.stringify(downloaded.state)} install ${JSON.stringify(downloaded.install)}`,
  );
  save();

  // The running app as the helper saw it, while it still runs.
  const tree = appProcesses();
  writeFileSync(
    join(out, "running-signature.txt"),
    [
      tree.map((p) => `${p.pid} ${p.ppid} ${p.command}`).join("\n"),
      run("/usr/bin/codesign", ["-dvvv", String(pid)]),
      run("/usr/bin/codesign", ["--verify", "--verbose=4", String(pid)]),
      ...(values.probe ? [run(values.probe, [String(pid), APP_ID])] : []),
    ].join("\n\n"),
  );

  if (downloaded.install.kind !== "restart-available") {
    result.outcome = `not offered a restart: ${downloaded.install.reason ?? downloaded.install.kind}`;
    page.close();
    for (const p of appProcesses()) spawnSync("/bin/kill", [String(p.pid)]);
    return false;
  }
  log("restarting to update");
  await page
    .evaluate(`${updates}.restart(${JSON.stringify(downloaded.install.offerId)})`)
    .catch(() => {});
  page.close();
  // The app quits, the system updater replaces the bundle, then reopens it.
  await until("the previous app to quit", 180_000, () =>
    appProcesses().some((p) => p.pid === pid) ? null : true,
  );
  const replaced = await until("the bundle to be replaced", 180_000, () => {
    try {
      const version = bundleVersion();
      return version !== result.previousVersion ? version : null;
    } catch {
      return null;
    }
  }).catch(() => null);
  result.installedVersion = replaced ?? bundleVersion();
  result.replacedSignature = run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    app,
  ]);
  const reopened = await until("the updated app to reopen", 60_000, mainPid).catch(() => null);
  result.reopened = reopened !== null;
  if (reopened !== null) {
    await sleep(5000);
    // A runner is discarded afterwards; still, stop only what this check started.
    for (const p of appProcesses()) spawnSync("/bin/kill", [String(p.pid)]);
  }
  const ok =
    result.installedVersion === offered.state.version &&
    (result.replacedSignature as string).includes("\nexit 0\n");
  result.outcome = ok ? "updated in place" : "not updated in place";
  return ok;
}

main()
  .then((ok) => {
    result.finishedAt = new Date().toISOString();
    save();
    log(String(result.outcome));
    process.exitCode = ok ? 0 : 1;
  })
  .catch((error: unknown) => {
    result.error = String(error);
    result.finishedAt = new Date().toISOString();
    save();
    console.error(error);
    process.exitCode = 1;
  });
