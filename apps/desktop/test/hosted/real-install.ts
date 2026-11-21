// F-501 F-503 F-504 F-505: a real install, through the host's own code, on a
// hosted runner only (docs/design/setup.md §19; .github/workflows/
// setup-install.yml). It refuses to run anywhere else. In order: the
// installer sets OpenClaw 2026.10.6 up as the `clawtrate` profile; the
// installed `entry.js` is the checked tarball's; the look finds the gateway
// running; Connect pairs read-only through the setup controller and the
// gateway grants exactly `operator.read`; then OpenClaw's own uninstall and
// the program folder's removal, and nothing of the install is left. A decoy
// default OpenClaw home, made after the first look and before the install,
// must come through unchanged.
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
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { connect } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { startHostRuntime } from "../../src/host/runtime.ts";
import { SetupController } from "../../src/setup/controller.ts";
import { computerPlace, Installer, layout, onHostedRunner } from "../../src/setup/install.ts";
import { installTarget, PINS, runsOnGlibc } from "../../src/setup/install-pins.ts";
import { InstallRunner } from "../../src/setup/install-runner.ts";
import { ProgramRunner } from "../../src/setup/programs.ts";
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

const home = userInfo().homedir;
const temp = process.env.RUNNER_TEMP ?? mkdtempSync("/tmp/clawtrate-hosted-");
const appData = join(temp, "clawtrate-app-data");
mkdirSync(appData, { recursive: true });

/** Every file under a folder with its SHA-256, to prove the decoy came through unchanged. */
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

const place = computerPlace({ home, appData, platform, target, env: process.env });
const at = layout(place, PINS);
const runner = new InstallRunner();
const installer = new Installer({
  place,
  pins: PINS,
  run: (request, ask) => runner.run(request, ask),
  personsApp: false,
  accountHome: home,
  log: say,
});

// 1. The install, through the host's own installer, as its controller drives it.
const programs = new ProgramRunner();
const runtime = await startHostRuntime({
  kind: "desktop",
  displayName: "Clawtrate hosted install check",
  dataDir: join(temp, "clawtrate-device"),
  devGateway: null,
  resume: false,
});
const steps: string[] = [];
const setup = new SetupController({
  client: runtime.client,
  open: async () => ({
    world: productionWorld({ home, appData, platform, lang: "C" }),
    run: programs.run,
    identify: processIdentity,
  }),
  stopPrograms: () => programs.stopAll(),
  // The host's dialog, answered yes, as a person would.
  confirm: async (confirmation) => {
    say(`dialog: ${confirmation.message}`);
    return true;
  },
  log: say,
  installer: () => installer,
});
runtime.client.store.subscribe((state) => {
  const install = state.setup?.install;
  const line = `${state.setup?.phase} ${install ? `step ${install.step}${install.nodeChecked ? " node checked" : ""}` : ""}`;
  if (steps.at(-1) !== line) {
    steps.push(line);
    say(`state: ${line}`);
  }
});

const started = Date.now();
await setup.look();
check(
  setup.current.look?.outcome === "not-found",
  `the look finds nothing first (${setup.current.look?.outcome})`,
);
// The decoy stands for a person's own default OpenClaw, made after the look (with it, the look
// rightly says "set up, program missing" and offers no install) and before the install.
mkdirSync(decoy);
writeFileSync(join(decoy, "keep-me"), "the person's own\n");
const decoyBefore = tree(decoy);
await setup.install();
say(`install and look took ${Math.round((Date.now() - started) / 1000)} s`);
const failure = steps.length ? setup.current.install?.failure : null;
check(!failure, `every step done${failure ? `: ${JSON.stringify(failure)}` : ""}`);
check(
  steps.some((line) => line.includes("node checked")),
  "the installer reported it used the checked Node.js (skip)",
);

// 2. What was installed: the checked tarball's entry.js, the checked Node.js.
const unpacked = mkdtempSync(join(temp, "tarball-"));
execFileSync("/usr/bin/tar", ["-xzf", at.tarball, "-C", unpacked, "package/dist/entry.js"]);
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const installedEntry = join(at.nodeDir, "lib/node_modules/openclaw/dist/entry.js");
check(
  existsSync(installedEntry) &&
    sha(installedEntry) === sha(join(unpacked, "package/dist/entry.js")),
  "the installed dist/entry.js has the checked tarball's SHA-256",
);
check(
  existsSync(join(place.programDir, "tools/node")) &&
    execFileSync("/usr/bin/readlink", [join(place.programDir, "tools/node")])
      .toString()
      .trim() === at.nodeDir,
  "tools/node points at the checked Node.js",
);
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
  "one id in Clawtrate's record, the program folder's and the profile's owner file",
);
check(existsSync(place.serviceFile), `the profile's own service file is there (${place.service})`);

// 3. The look finds it running; Connect pairs read-only.
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
if (look?.outcome === "running") {
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
  await runtime.client.disconnect();
}
runtime.client.stop();
programs.stopAll();

// 4. Removed with OpenClaw's own uninstall for the profile, then the program folder (§11; F-514 is later).
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
  {
    env: {
      HOME: home,
      PATH: `${place.programDir}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      ...place.env,
    },
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 180_000,
  },
);
check(
  uninstall.status === 0,
  `openclaw --profile clawtrate uninstall exits 0 (${uninstall.status})`,
);
await rm(place.programDir, { recursive: true, force: true });
await rm(place.recordFile, { force: true });

// 5. Nothing of the install is left; the decoy is unchanged.
check(!existsSync(place.programDir), "the program folder is gone");
check(!existsSync(place.stateDir), "~/.openclaw-clawtrate is gone");
check(!existsSync(place.serviceFile), "the profile's service file is gone");
if (platform === "darwin") {
  const uid = String(process.getuid?.() ?? "");
  const job = spawnSync("/bin/launchctl", ["print", `gui/${uid}/ai.openclaw.clawtrate`], {
    stdio: "ignore",
  });
  check(job.status !== 0, "launchd has no ai.openclaw.clawtrate job");
  const gateway = spawnSync("/bin/launchctl", ["print", `gui/${uid}/ai.openclaw.gateway`], {
    stdio: "ignore",
  });
  check(gateway.status !== 0, "the default profile's ai.openclaw.gateway was never loaded");
  say(
    `left, as research §6.8 found: Trash plist ${existsSync(join(home, ".Trash/ai.openclaw.clawtrate.plist")) ? "present" : "absent"}, log ${existsSync(join(home, "Library/Logs/openclaw/gateway-clawtrate.log")) ? "present" : "absent"}`,
  );
} else {
  const unit = spawnSync("systemctl", ["--user", "status", "openclaw-gateway-clawtrate.service"], {
    stdio: "ignore",
    env: { ...process.env },
  });
  check(
    unit.status === 4,
    `systemd has no openclaw-gateway-clawtrate unit (status exit ${unit.status})`,
  );
  const gateway = spawnSync("systemctl", ["--user", "is-active", "openclaw-gateway.service"], {
    stdio: "ignore",
    env: { ...process.env },
  });
  check(gateway.status !== 0, "the default profile's openclaw-gateway.service is not active");
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
check(tree(decoy) === decoyBefore, "the decoy default OpenClaw home is unchanged");

if (failures.length) {
  console.error(`[hosted-install] ${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
say("every check passed");
process.exit(0);
