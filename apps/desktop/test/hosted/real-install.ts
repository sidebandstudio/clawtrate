// F-501 F-503 F-504 F-505: a real install, through the host's own code, on a
// hosted runner only (docs/design/setup.md §19; .github/workflows/
// setup-install.yml). It refuses to run anywhere else. In order:
//
// 1. With a decoy default OpenClaw home there, the look finds it, no install
//    is offered, and the decoy comes through byte for byte; the decoy is
//    then removed, so the real setup starts clean.
// 2. The installer sets OpenClaw 2026.10.6 up as the `clawtrate` profile,
//    from an app-data folder whose name has a space, as a Mac's has. On Linux
//    the user manager runs without lingering, and lingering is the same
//    after as before.
// 3. What was installed: the checked tarball's `entry.js`, the checked
//    Node.js, one id in the three records, the service file's command, and
//    the service manager's own effective command and main process for the
//    job it loaded; start policy and runtime; token sign-in; the listener
//    belongs to the service; the look that follows and Connect run no command
//    of the default profile's, and the look finds the gateway running on the
//    install's port. Connect pairs read-only through the setup controller,
//    the host's dialog answered yes by this script, and the gateway grants
//    exactly `operator.read`. No restart or later login is exercised.
// 4. A decoy default home and a sentinel default service definition are put
//    in place; OpenClaw's own uninstall for the profile and the program
//    folder's removal; then nothing of the install is left: no definition,
//    job or listener; OpenClaw's own known leftovers are asserted and
//    removed; every shared log and cache path is as it was before the
//    install, the new entries this check's install made removed by name;
//    and the decoy and the sentinel are unchanged.
//
// Everything of its own is under one scratch folder, removed at the end.
//
// Run: node apps/desktop/test/hosted/real-install.ts

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { installTarget, PINS, runsOnGlibc } from "../../src/setup/install-pins.ts";
import { InstallRunner } from "../../src/setup/install-runner.ts";
import { parseAuthMode, parseStatus } from "../../src/setup/parse.ts";
import {
  checkRequest,
  ProgramRunner,
  sessionEnv,
  type ProgramRequest,
} from "../../src/setup/programs.ts";
import { productionWorld } from "../../src/setup/world.ts";
import { processIdentity } from "../../../../tools/dev-gateway/src/state-guard.ts";

const say = (line: string) => console.log(`[hosted-install] ${line}`);
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  say(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

if (!onHostedRunner(process.env)) {
  console.error(
    "Refusing: a real install runs only on a GitHub-hosted runner (CI, GITHUB_ACTIONS, RUNNER_ENVIRONMENT=github-hosted).",
  );
  process.exit(2);
}
const platform = process.platform;
if (platform !== "darwin" && platform !== "linux") throw new Error("macOS and Linux only");
const target = installTarget(platform, process.arch, platform === "linux" && runsOnGlibc());
if (!target) throw new Error("this runner's system isn't one the install supports");

const account = userInfo();
const home = account.homedir;
const uid = String(process.getuid?.() ?? "");
/** This check's own folder: everything it makes of its own is in it, and it is removed at the end. */
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "clawtrate-hosted-"));
// Removed however the check ends, a failure or a throw included.
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
// A Mac's app data is "~/Library/Application Support/Clawtrate": a space in every path.
const appData = join(scratch, "Clawtrate App Data");
const deviceDir = join(scratch, "clawtrate-device");
mkdirSync(appData, { recursive: true });
/** The session's bus, as a person's app reads it once in its main process. */
const session = sessionEnv(platform, process.env);

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
const sentinel =
  platform === "darwin"
    ? join(home, "Library/LaunchAgents/ai.openclaw.gateway.plist")
    : join(home, ".config/systemd/user/openclaw-gateway.service");
const sentinelText =
  platform === "darwin"
    ? '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>ai.openclaw.gateway</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array></dict></plist>\n'
    : "[Unit]\nDescription=the person's own gateway (sentinel)\n\n[Service]\nExecStart=/bin/true\n";
/** Linux lingering is stored as this file: its presence is the account's setting. */
const lingerFile = `/var/lib/systemd/linger/${account.username}`;
const lingerBefore = platform === "linux" ? existsSync(lingerFile) : false;
if (platform === "linux")
  check(!lingerBefore, "lingering is off for the runner's account before the install");
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
    ...(platform === "darwin" ? [join(home, "Library/Logs/openclaw")] : []),
  ]),
];
/** Every entry under a place, by its path: `(absent)` for a place that isn't there. */
function listing(root: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(root)) return new Set(["(absent)"]);
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      out.add(path);
      if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}
const sharedBefore = new Map(shared.map((root) => [root, listing(root)]));

const place = computerPlace({ home, appData, platform, target, env: process.env, session });
const at = layout(place, PINS);
const runner = new InstallRunner();
const makeInstaller = () =>
  new Installer({
    place,
    pins: PINS,
    run: (request, ask) => runner.run(request, ask),
    personsApp: false,
    accountHome: home,
    log: say,
  });

// The host's own controller, its look's runner recorded and checked as a person's app checks it.
const programs = new ProgramRunner({ check: (request) => checkRequest(request, session) });
const asked: ProgramRequest[] = [];
/** What each look command was asked and gave, for the log when the look after the install can't tell. */
type Seen = { args: string; env: string; exit?: number | null; stdout?: string; refused?: string };
const ran: Seen[] = [];
/** A program's output for the log: bounded, with anything shaped like a token or a code blanked. */
const bounded = (text: string) =>
  text
    .replace(/"(token|password|bootstrapToken|secret|key)"\s*:\s*"[^"]*"/gi, '"$1":"<blanked>"')
    .replace(/[A-Za-z0-9_-]{32,}/g, "<long value>")
    .slice(0, 4000);
const runtime = await startHostRuntime({
  kind: "desktop",
  displayName: "Clawtrate hosted install check",
  dataDir: deviceDir,
  devGateway: null,
  resume: false,
});
const steps: string[] = [];
const setup = new SetupController({
  client: runtime.client,
  open: async () => ({
    world: productionWorld({ home, appData, platform, lang: "C" }),
    run: async (request) => {
      asked.push(request);
      const seen: Seen = {
        args: request.args.join(" "),
        env: Object.keys(request.env).sort().join(","),
      };
      ran.push(seen);
      try {
        const result = await programs.run(request);
        seen.exit = result.exitCode;
        seen.stdout = result.stdout;
        return result;
      } catch (error) {
        // The host's own check refused it: its words are fixed.
        seen.refused = error instanceof Error ? error.message : "refused";
        throw error;
      }
    },
    identify: processIdentity,
  }),
  stopPrograms: () => programs.stopAll(),
  // The host's dialog, answered yes, as a person would.
  confirm: async (confirmation) => {
    say(`dialog: ${confirmation.message}`);
    return true;
  },
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
mkdirSync(decoy);
writeFileSync(join(decoy, "keep-me"), "the person's own\n");
const decoyBefore = tree(decoy);
await setup.look();
check(
  setup.current.look?.outcome === "program-missing",
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
const fromInstall = asked.length;
const ranFromInstall = ran.length;
await setup.install();
say(`install and look took ${Math.round((Date.now() - started) / 1000)} s`);
const failure = steps.length ? setup.current.install?.failure : null;
check(!failure, `every step done${failure ? `: ${JSON.stringify(failure)}` : ""}`);
check(
  steps.some((line) => line.includes("node checked")),
  "the installer reported it used the checked Node.js (skip)",
);
/** Every command of a slice: the installed program, the clawtrate profile, no deep status, the session's bus. */
const installedOnly = (slice: ProgramRequest[]) =>
  slice.length > 0 &&
  slice.every(
    (request) =>
      request.program === at.openclaw &&
      request.args[0] === "--profile" &&
      request.args[1] === "clawtrate" &&
      !request.args.includes("--deep") &&
      Object.entries(session).every(([key, value]) => request.env[key] === value),
  );
const lookAsked = asked.slice(fromInstall);
check(
  installedOnly(lookAsked),
  `the look after the install ran the installed program for the clawtrate profile only (${lookAsked.length} commands)`,
);

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
say(`service command: ${JSON.stringify(argv)}`);
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
if (platform === "darwin") {
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
} else {
  const enabled = spawnSync("systemctl", ["--user", "is-enabled", place.service], {
    encoding: "utf8",
    env: { ...process.env },
  });
  check(
    enabled.stdout.trim() === "enabled" &&
      /^Restart=always$/m.test(serviceText) &&
      /^WantedBy=default\.target$/m.test(serviceText),
    `the unit is enabled for the user's session and restarts always (${enabled.stdout.trim()})`,
  );
  const shown = spawnSync(
    "systemctl",
    ["--user", "show", place.service, "--property=MainPID", "--value"],
    { encoding: "utf8", env: { ...process.env } },
  );
  mainPid = Number(shown.stdout.trim()) || null;
  // The unit systemd loaded, not the file: its effective ExecStart (drop-ins included).
  const exec = spawnSync(
    "systemctl",
    ["--user", "show", place.service, "--property=ExecStart", "--value"],
    { encoding: "utf8", env: { ...process.env } },
  );
  const effective = exec.stdout.trim();
  say(`systemd's ExecStart: ${effective.length} characters`);
  // Read as systemd prints it, with any quoting of a spaced argument taken away.
  const plain = effective.replace(/"/g, "");
  check(
    argv !== null &&
      plain.startsWith(`{ path=${argv[0]} ; argv[]=${argv.join(" ")} ; `) &&
      plain.split("path=").length === 2,
    "systemd's loaded unit has exactly one ExecStart, that command",
  );
  if (mainPid !== null) {
    try {
      mainExecutable = realpathSync(`/proc/${mainPid}/exe`);
    } catch {
      mainExecutable = null;
    }
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

// The look that followed finds it running; Connect pairs read-only.
const look = setup.current.look;
check(
  setup.current.phase === "found" &&
    look?.outcome === "running" &&
    look.profile === "clawtrate" &&
    look.version === PINS.version &&
    look.listens === "loopback" &&
    look.port === own.port,
  `the look shows the clawtrate gateway running on its port (${JSON.stringify(look)})`,
);
check(
  look !== undefined && look !== null && !Object.hasOwn(look, "managed"),
  "the running card says nothing of who installed it",
);
if (look?.outcome !== "running") {
  // Exactly what the look after the install ran and what each command gave.
  for (const seen of ran.slice(ranFromInstall))
    say(
      `look command: openclaw ${seen.args} (env ${seen.env}) ${seen.refused ? `refused: ${seen.refused}` : `exit ${seen.exit}\n${bounded(seen.stdout ?? "")}`}`,
    );
}
if (look?.outcome === "running") {
  const fromConnect = asked.length;
  await setup.connect();
  const deadline = Date.now() + 60_000;
  while (
    setup.current.phase !== "done" &&
    setup.current.phase !== "failed" &&
    Date.now() < deadline
  )
    await new Promise((done) => setTimeout(done, 250));
  const connection = runtime.client.state.connection;
  check(
    setup.current.phase === "done",
    `Connect ends connected (${setup.current.phase} ${JSON.stringify(setup.current.failure)})`,
  );
  check(
    connection.status === "connected" &&
      JSON.stringify([...connection.scopes].sort()) === JSON.stringify(["operator.read"]),
    `the gateway granted exactly operator.read (${JSON.stringify(connection.scopes)})`,
  );
  const connectAsked = asked.slice(fromConnect);
  check(
    installedOnly(connectAsked),
    `Connect's rechecks and code ran the installed program for the clawtrate profile only, with the session's bus (${connectAsked.length} commands)`,
  );
  await runtime.client.disconnect();
}
runtime.client.stop();
programs.stopAll();
await runner.close(5_000);

// 4. A person's own OpenClaw and service definition, then removal (§11; F-514 is later).
mkdirSync(decoy);
writeFileSync(join(decoy, "keep-me"), "the person's own\n");
mkdirSync(join(sentinel, ".."), { recursive: true });
writeFileSync(sentinel, sentinelText);
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
if (platform === "darwin") {
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
} else {
  const loadState = spawnSync(
    "systemctl",
    ["--user", "show", place.service, "--property=LoadState", "--value"],
    { encoding: "utf8", env: { ...process.env } },
  );
  check(
    loadState.stdout.trim() === "not-found",
    `systemd has no ${place.service} unit (LoadState ${loadState.stdout.trim()})`,
  );
  const unit = spawnSync("systemctl", ["--user", "status", place.service], {
    stdio: "ignore",
    env: { ...process.env },
  });
  check(unit.status === 4, `systemctl status says no such unit (exit ${unit.status})`);
  const gateway = spawnSync("systemctl", ["--user", "is-active", "openclaw-gateway.service"], {
    stdio: "ignore",
    env: { ...process.env },
  });
  check(gateway.status !== 0, "the default profile's openclaw-gateway.service is not active");
  check(existsSync(lingerFile) === lingerBefore, "lingering for the account is as it was before");
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
  const added = [...listing(root)].filter((path) => !before.has(path));
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
  check(
    after.size === before.size && [...after].every((path) => before.has(path)),
    `${root} is as it was before the install`,
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
