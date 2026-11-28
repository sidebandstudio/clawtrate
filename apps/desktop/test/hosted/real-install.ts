// Real installation, local pairing and cleanup on a disposable GitHub-hosted Mac.
// OpenClaw's launchd setup requires the disposable runner's canonical account home.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { startHostRuntime } from "../../src/host/runtime.ts";
import { SetupController } from "../../src/setup/controller.ts";
import {
  computerPlace,
  Installer,
  layout,
  onHostedRunner,
  runsCheckedInstall,
  serviceArgv,
} from "../../src/setup/install.ts";
import { installTarget, PINS } from "../../src/setup/install-pins.ts";
import { InstallRunner } from "../../src/setup/install-runner.ts";
import { parseAuthMode, parseStatus } from "../../src/setup/parse.ts";
import { productionWorld } from "../../src/setup/world.ts";
import { FULL_SCOPES } from "@clawtrate/core";
import { localGatewayBuild } from "../../packaging/config.ts";
import { provedRouteFor, type LocalConnect } from "../../src/setup/local-connect.ts";

const hostedEnv = { ...process.env };
if (!onHostedRunner(hostedEnv) || !hostedEnv.RUNNER_TEMP) {
  console.error("Refusing: a real install runs only on a GitHub-hosted runner.");
  process.exit(2);
}
// Only the check's own messages go into the artifact. Child output can contain credentials.
const artifact = join(hostedEnv.RUNNER_TEMP, "clawtrate-setup-install");
mkdirSync(artifact, { mode: 0o700 });
const failures: string[] = [];
const say = (line: string) => {
  const message = `[hosted-install] ${line}`;
  console.log(message);
  appendFileSync(join(artifact, "check.log"), `${message}\n`, { mode: 0o600 });
};
process.on("exit", (code) => {
  writeFileSync(join(artifact, "result.json"), JSON.stringify({ code, failures }, null, 2), {
    mode: 0o600,
  });
});
function check(ok: boolean, what: string): void {
  say(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

const platform = process.platform;
if (platform !== "darwin") throw new Error("This check runs on a hosted Mac only.");
const target = installTarget(platform, process.arch, false);
if (!target) throw new Error("this runner's system isn't one the install supports");

const uid = String(process.getuid?.() ?? "");
/** This check's own folder: everything it makes of its own is in it, and it is removed at the end. */
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-hosted-")));
const home = userInfo().homedir;
if (
  ![join(home, ".openclaw"), join(home, ".openclaw-clawtrate")].every((path) => !existsSync(path))
)
  throw new Error("The disposable runner must start without either OpenClaw profile.");
const helper = join(scratch, "helper");
execFileSync("/usr/bin/xcrun", localGatewayBuild(helper), {
  env: { ...process.env, TMPDIR: scratch },
});
// The runner was checked above. Model the packaged launch metadata for the native proof in
// this test process only. The installer still checks the original hosted environment.
Object.defineProperty(process.versions, "electron", {
  value: "0.0.0-hosted-check",
  configurable: true,
});
delete process.env.CI;
const local: LocalConnect = { home, helper, platform, sandboxed: false, deadlineMs: 10_000 };
// Removed however the check ends, a failure or a throw included.
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
// A Mac's app data is "~/Library/Application Support/Clawtrate": a space in every path.
const appData = join(scratch, "Clawtrate App Data");
const deviceDir = join(scratch, "clawtrate-device");
mkdirSync(appData, { recursive: true });

/** Every file under a folder with its SHA-256: what must come through unchanged. */
function tree(dir: string): string {
  if (!existsSync(dir)) return "(absent)";
  const lines: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else
        lines.push(
          `${path.slice(dir.length)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
        );
    }
  };
  walk(dir);
  return lines.join("\n");
}
const decoy = join(home, ".openclaw");
const sentinel = join(home, "Library/LaunchAgents/ai.openclaw.gateway.plist");
const sentinelText =
  '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>ai.openclaw.gateway</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array></dict></plist>\n';
/**
 * The runner's shared log and cache places OpenClaw or npm could write to:
 * each listed before the install, so that afterwards only what this check's
 * install added is removed, by name, and the rest is as it was.
 */
const shared = [
  ...new Set([
    "/tmp/openclaw",
    join(tmpdir(), "openclaw"),
    join(home, ".npm"),
    join(home, "Library/Logs/openclaw"),
  ]),
];
/**
 * Every entry under a place, by its path, with what it is: a folder, or a
 * file's size and modification time, so that a file written to in place
 * shows too. `(absent)` for a place that isn't there.
 */
function listing(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return new Map([["(absent)", ""]]);
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const info = statSync(path, { throwIfNoEntry: false });
      out.set(path, info?.isDirectory() ? "folder" : `${info?.size}:${info?.mtimeMs}`);
      if (info?.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}
const sharedBefore = new Map(shared.map((root) => [root, listing(root)]));

const place = computerPlace({ home, appData, platform, target, env: process.env });
const at = layout(place, PINS);
const runner = new InstallRunner();
const makeInstaller = () =>
  new Installer({
    place,
    pins: PINS,
    run: (request, ask) => runner.run(request, ask),
    personsApp: false,
    env: hostedEnv,
    accountHome: home,
    log: say,
  });

// An ephemeral box exercises full pairing without reading or writing the runner's keychain.
const key = randomBytes(32);
const secretBox = {
  available: async () => true,
  async encrypt(text: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(text), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  async decrypt(data: Uint8Array) {
    const bytes = Buffer.from(data);
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
  },
};
const runtime = await startHostRuntime({
  kind: "desktop",
  displayName: "Clawtrate hosted install check",
  dataDir: deviceDir,
  devGateway: null,
  resume: false,
  secretBox,
  localConnect: provedRouteFor(local),
});
let confirmations = 0;
const steps: string[] = [];
const setup = new SetupController({
  client: runtime.client,
  open: async () => ({
    world: { ...productionWorld({ home, appData, platform, lang: "C" }), candidates: [] },
    run: async () => {
      throw new Error("Local setup must not run a discovered program.");
    },
    identify: () => ({ state: "exited", how: "absent" }),
  }),
  stopPrograms: () => {},
  confirm: async (confirmation) => {
    say(`dialog: ${confirmation.message}`);
    confirmations += 1;
    return true;
  },
  localConnect: { ...local, worker: new URL("../../src/setup/settings-parse.ts", import.meta.url) },
  log: say,
  installer: makeInstaller,
});
runtime.client.store.subscribe((state) => {
  const install = state.setup?.install;
  const line = `${state.setup?.phase} ${install ? `step ${install.step}${install.nodeChecked ? " node checked" : ""}` : ""}`;
  if (steps.at(-1) !== line) {
    steps.push(line);
    say(`state: ${line}`);
  }
});

// 1. An OpenClaw already there: found, no install offered, left byte for byte.
mkdirSync(decoy, { mode: 0o700 });
writeFileSync(join(decoy, "keep-me"), "the person's own\n");
const decoyBefore = tree(decoy);
await setup.look();
check(
  ["program-missing", "cant-tell"].includes(setup.current.look?.outcome ?? ""),
  `with a default OpenClaw home there, the look says it is set up (${setup.current.look?.outcome})`,
);
const offered = await setup.install().then(
  () => "ran",
  (error: unknown) => (error instanceof Error ? error.message : "refused"),
);
check(/nothing to set up/.test(offered), `no install is offered over it (${offered})`);
check(tree(decoy) === decoyBefore, "the default OpenClaw home there before is unchanged");
await rm(decoy, { recursive: true, force: true });
check(!existsSync(decoy), "the check's decoy is removed before the real setup");

// 2. The install, through the host's own installer, as its controller drives it.
const started = Date.now();
await setup.look();
check(
  setup.current.look?.outcome === "not-found",
  `the look finds nothing first (${setup.current.look?.outcome})`,
);
await setup.install();
say(`install and look took ${Math.round((Date.now() - started) / 1000)} s`);
const failure = steps.length ? setup.current.install?.failure : null;
check(!failure, `every step done${failure ? `: ${JSON.stringify(failure)}` : ""}`);
check(
  steps.some((line) => line.includes("node checked")),
  "the installer reported it used the checked Node.js (skip)",
);
const deadline = Date.now() + 60_000;
while (setup.current.phase === "connecting" && Date.now() < deadline)
  await new Promise((done) => setTimeout(done, 250));
const connection = runtime.client.state.connection;
check(confirmations === 1, "only the native install confirmation was requested");
check(
  setup.current.phase === "done" &&
    connection.status === "connected" &&
    connection.fullPairing &&
    JSON.stringify([...connection.scopes].sort()) === JSON.stringify([...FULL_SCOPES].sort()),
  `local proof and automatic full pairing ended in ${setup.current.phase} (${setup.current.failure?.reason ?? "no proof refusal"})`,
);
await runtime.client.disconnect();
runtime.client.stop();
await runner.close(5_000);

// 3. What was installed.
const unpacked = mkdtempSync(join(scratch, "tarball-"));
execFileSync("/usr/bin/tar", [
  "-xzf",
  at.tarball,
  "-C",
  unpacked,
  "package/dist/entry.js",
  "package/dist/index.js",
]);
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
check(
  existsSync(at.installedEntry) &&
    sha(at.installedEntry) === sha(join(unpacked, "package/dist/entry.js")) &&
    existsSync(at.installedIndex) &&
    sha(at.installedIndex) === sha(join(unpacked, "package/dist/index.js")),
  "the installed dist/entry.js and dist/index.js have the checked tarball's SHA-256",
);
check(
  existsSync(join(place.programDir, "tools/node")) &&
    realpathSync(join(place.programDir, "tools/node")) === realpathSync(at.nodeDir),
  "tools/node points at the checked Node.js",
);
check(existsSync(at.npmCache), "npm's cache is inside the program folder");
/** A record as JSON, or an empty object when it isn't there: a failed install is still cleaned up. */
const record = (file: string): { id?: string; port?: number; stage?: string } => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { id?: string; port?: number; stage?: string };
  } catch {
    return {};
  }
};
const own = record(place.recordFile);
const there = record(at.record);
const owner = record(at.owner);
check(
  own.id !== undefined && own.id === there.id && own.id === owner.id && own.stage === "installed",
  "one id in Clawtrate's record, the program folder's and the profile's owner file, and the stage installed in Clawtrate's",
);
const port = own.port ?? 0;
const serviceText = existsSync(place.serviceFile) ? readFileSync(place.serviceFile, "utf8") : "";
check(serviceText !== "", `the profile's own service file is there (${place.service})`);
const argv = serviceArgv(platform, serviceText);

check(
  argv !== null && runsCheckedInstall(argv, place, PINS, port),
  "the service file's command is exactly the checked Node.js, the installed, checked entrypoint and gateway --port <the install's port>",
);
check(
  argv !== null &&
    argv.some((arg) => existsSync(arg) && realpathSync(arg) === realpathSync(at.nodeBin)),
  `the service's runtime is the checked Node.js (${realpathSync(at.nodeBin)})`,
);
const env = { ...place.env, PATH: `${place.programDir}/bin:/usr/bin:/bin:/usr/sbin:/sbin` };
/** A command for the profile, with the install's environment. */
const openclaw = (...args: string[]) =>
  spawnSync(at.openclaw, ["--profile", "clawtrate", ...args], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
let mainPid: number | null;
/** The running process's own executable, as the system reports it. */
let mainExecutable: string | null = null;
{
  check(
    /<key>RunAtLoad<\/key>\s*<true\/>/.test(serviceText) &&
      /<key>KeepAlive<\/key>\s*<true\/>/.test(serviceText),
    "the LaunchAgent starts at login and is kept alive (RunAtLoad, KeepAlive)",
  );
  const job = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${place.service}`], {
    encoding: "utf8",
  });
  mainPid = Number(/^\s*pid = (\d+)/m.exec(job.stdout)?.[1] ?? NaN) || null;
  // The job launchd loaded, not the file: its program and its arguments, one per line.
  const block = /^\targuments = \{\n([\s\S]*?)\n\t\}/m.exec(job.stdout)?.[1] ?? null;
  const effective =
    block === null ? null : block.split("\n").map((line) => line.replace(/^\t\t/, ""));
  say(
    `launchd's job: program ${/^\tprogram = (.*)$/m.exec(job.stdout)?.[1]}, ${effective?.length ?? 0} arguments`,
  );
  check(
    effective !== null &&
      runsCheckedInstall(effective, place, PINS, port) &&
      JSON.stringify(effective) === JSON.stringify(argv) &&
      /^\tprogram = \/bin\/sh$/m.test(job.stdout),
    "launchd's loaded job runs exactly that command",
  );
  if (mainPid !== null) {
    const comm = spawnSync("/bin/ps", ["-o", "comm=", "-p", String(mainPid)], { encoding: "utf8" });
    mainExecutable = comm.stdout.trim() || null;
  }
}
check(
  mainExecutable !== null &&
    existsSync(mainExecutable) &&
    realpathSync(mainExecutable) === realpathSync(at.nodeBin),
  `the service's main process runs the checked Node.js (${mainExecutable})`,
);
const auth = openclaw("config", "get", "gateway.auth.mode", "--json");
check(
  auth.status === 0 && parseAuthMode(auth.stdout) === "token",
  "the profile's gateway signs in with a token",
);
const status = openclaw("gateway", "status", "--json");
const listener = status.status === 0 ? (parseStatus(status.stdout)?.listenerPid ?? null) : null;
/** The process and its parents, up to the service manager's. */
const ancestry = (pid: number): number[] => {
  const chain = [pid];
  for (let at = pid, hops = 0; hops < 6; hops += 1) {
    const parent = Number(
      execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(at)])
        .toString()
        .trim(),
    );
    if (!parent || parent <= 1) break;
    chain.push(parent);
    at = parent;
  }
  return chain;
};
check(
  listener !== null && mainPid !== null && ancestry(listener).includes(mainPid),
  `the listener on the install's port belongs to the service (listener ${listener}, service ${mainPid})`,
);

// 4. A person's own OpenClaw and service definition, then removal (§11; F-514 is later).
mkdirSync(decoy, { mode: 0o700 });
writeFileSync(join(decoy, "keep-me"), "the person's own\n");
mkdirSync(join(sentinel, ".."), { recursive: true });
// Made only where no definition is: a runner's own is never replaced or removed.
check(!existsSync(sentinel), "no default service definition was there before the sentinel");
writeFileSync(sentinel, sentinelText, { flag: "wx" });
const keptBefore = `${tree(decoy)}\n${sha(sentinel)}`;
const uninstall = spawnSync(
  at.openclaw,
  [
    "--profile",
    "clawtrate",
    "uninstall",
    "--service",
    "--state",
    "--workspace",
    "--yes",
    "--non-interactive",
  ],
  { env, stdio: ["ignore", "inherit", "inherit"], timeout: 180_000 },
);
check(
  uninstall.status === 0,
  `openclaw --profile clawtrate uninstall exits 0 (${uninstall.status})`,
);
await rm(place.programDir, { recursive: true, force: true });
await rm(place.recordFile, { force: true });
await rm(unpacked, { recursive: true, force: true });
await rm(deviceDir, { recursive: true, force: true });

// 5. Nothing of the install is left.
check(!existsSync(place.programDir), "the program folder, with npm's cache, is gone");
check(!existsSync(place.recordFile), "Clawtrate's record is gone");
check(!existsSync(place.stateDir), "~/.openclaw-clawtrate is gone");
check(!existsSync(place.serviceFile), "the profile's service definition is absent");
check(!existsSync(unpacked), "the check's unpacked tarball is gone");
check(!existsSync(deviceDir), "the check's device store is gone");
check(
  readdirSync(dirname(place.programDir)).length === 0,
  "nothing else of the install is in the app-data folder (no staging or removal folder)",
);
{
  /** `launchctl print` of a label: only exit 113 with launchd's own words is "no such job". */
  const noJob = (label: string) => {
    const job = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
    const text = `${job.stdout}${job.stderr}`;
    say(`launchctl print ${label}: exit ${job.status}`);
    return job.status === 113 && /Could not find service/i.test(text);
  };
  check(noJob(place.service), "launchd has no ai.openclaw.clawtrate job");
  check(
    noJob("ai.openclaw.gateway"),
    "the default profile's ai.openclaw.gateway is absent after uninstall",
  );
  // OpenClaw's own uninstall leaves these (research §6.8): asserted, then removed.
  const trash = join(home, ".Trash/ai.openclaw.clawtrate.plist");
  const log = join(home, "Library/Logs/openclaw/gateway-clawtrate.log");
  check(existsSync(trash), "OpenClaw's uninstall moved the profile's plist to the Trash, as known");
  check(existsSync(log), "OpenClaw's uninstall left the profile's service log, as known");
  await rm(trash, { force: true });
  await rm(log, { force: true });
  check(!existsSync(trash) && !existsSync(log), "those known leftovers are removed");
}
const listening = await new Promise<boolean>((done) => {
  if (!own.port) return done(false);
  const socket = connect({ host: "127.0.0.1", port: own.port });
  socket.once("connect", () => {
    socket.destroy();
    done(true);
  });
  socket.once("error", () => done(false));
});
check(!listening, `nothing listens on the install's port ${own.port}`);
// The shared log and cache places: what this check's install added, removed by name, deepest
// first; everything there before is kept, and each place is then exactly as it was.
for (const root of shared) {
  const before = sharedBefore.get(root)!;
  const added = [...listing(root).keys()].filter((path) => !before.has(path));
  say(
    `${root}: ${added.length} new entries${
      added.length
        ? `: ${added
            .slice(0, 12)
            .map((path) => path.slice(root.length + 1) || "(the folder)")
            .join(", ")}`
        : ""
    }`,
  );
  for (const path of added.sort((a, b) => b.length - a.length))
    await rm(path, { recursive: true, force: true });
  if (before.has("(absent)")) await rm(root, { recursive: true, force: true });
  const after = listing(root);
  const changed = [...after].filter(([path, what]) => before.get(path) !== what);
  check(
    after.size === before.size && changed.length === 0,
    `${root} is as it was before the install, each file there before unchanged in size and time (${changed.length} changed)`,
  );
}
check(
  `${tree(decoy)}\n${existsSync(sentinel) ? sha(sentinel) : "(absent)"}` === keptBefore,
  "the default OpenClaw home and the default service definition are unchanged",
);
await rm(decoy, { recursive: true, force: true });
await rm(sentinel, { force: true });
await rm(scratch, { recursive: true, force: true });
check(!existsSync(scratch), "the check's scratch folder is gone");

if (failures.length) {
  console.error(`[hosted-install] ${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
say("every check passed");
process.exit(0);
