// clawtrate-openclaw-stand-in
//
// The repository's stand-in for `openclaw`, for every look that runs in a
// sandbox (docs/development/setup.md). OpenClaw's own `gateway status`
// lists the user's whole launchd job list and chooses its probe itself, so a
// sandboxed look never runs it: this program answers `gateway status --json`
// from the development instance's recorded facts, probing only that
// instance's own port on loopback, and runs the real program only for its
// version, the auth mode and the one-time code, each for that instance alone.
// It refuses every other command, `--deep` included.
//
// It is started through a small shell wrapper the checks write (`standIn` in
// `e2e/setup-sandbox.ts`), which names a facts file of the run's own:
//   { "openclaw": <real program>, "instance": <name>, "stateDir": <its state>,
//     "version"?: <a version to report instead of the program's> }

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { readMarker } from "../tools/dev-gateway/src/state-guard.ts";
import { validateInstanceName } from "../tools/dev-gateway/src/instance.ts";

type Facts = { openclaw: string; instance: string; stateDir: string; version?: string };

const [factsPath, ...args] = process.argv.slice(2);
const facts = JSON.parse(readFileSync(factsPath!, "utf8")) as Facts;
const instance = validateInstanceName(facts.instance);
const profile = `clawtrate-dev-${instance}`;

function refuse(why: string): never {
  process.stderr.write(`openclaw stand-in: ${why}\n`);
  process.exit(2);
}

if (args[0] !== "--profile" || args[1] !== profile) refuse("only this run's instance is answered");
if (process.env.OPENCLAW_PROFILE !== profile || process.env.OPENCLAW_STATE_DIR !== facts.stateDir)
  refuse("the environment doesn't name this run's instance");
const command = args.slice(2).join(" ");

/** The real program, for this instance alone, with the look's own environment. */
function real(rest: string[]): { status: number; stdout: string } {
  const result = spawnSync(facts.openclaw, ["--profile", profile, ...rest], {
    // The real program's folder and this Node.js first: an npm install's `openclaw` needs `node`.
    env: {
      ...process.env,
      PATH: [dirname(facts.openclaw), dirname(process.execPath), process.env.PATH].join(":"),
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

const reportedVersion = (): string => {
  if (facts.version) return facts.version;
  const match = /^OpenClaw (\d{4}\.\d{1,2}\.\d{1,3})/.exec(real(["--version"]).stdout.trim());
  return match ? match[1]! : "";
};

/** Whether something listens on the instance's own port on loopback. */
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(2000, () => done(false));
  });

/** Whether the instance's gateway answers its own health check, on its own port. */
async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function status(): Promise<void> {
  const marker = readMarker(facts.stateDir);
  const port = marker?.instance === instance ? marker.gatewayPort : undefined;
  if (typeof port !== "number") refuse("the instance has no recorded port");
  const configPath = join(facts.stateDir, "openclaw.json");
  let bind = "loopback";
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { gateway?: { bind?: string } };
    if (typeof config.gateway?.bind === "string") bind = config.gateway.bind;
  } catch {
    // an unreadable config: reported as missing below
  }
  const busy = await listening(port);
  const ok = busy && (await answers(port));
  const version = ok ? reportedVersion() : null;
  const url = `ws://127.0.0.1:${port}`;
  process.stdout.write(
    JSON.stringify({
      service: {
        label: process.platform === "linux" ? "systemd" : "LaunchAgent",
        loaded: false,
        runtime: { status: "unknown", missingUnit: true },
      },
      config: { cli: { path: configPath, exists: existsSync(configPath) } },
      gateway: { bindMode: bind, port, probeUrl: url, version },
      port: { port, status: busy ? "busy" : "free" },
      rpc: ok ? { ok: true, version, url } : { ok: false, url },
    }),
  );
}

switch (command) {
  case "--version": {
    if (facts.version) {
      process.stdout.write(`OpenClaw ${facts.version}\n`);
      break;
    }
    const result = real(["--version"]);
    process.stdout.write(result.stdout);
    process.exitCode = result.status;
    break;
  }
  case "gateway status --json":
    await status();
    break;
  case "config get gateway.auth.mode --json":
  case `qr --json --voice-node --url ws://127.0.0.1:${readMarker(facts.stateDir)?.gatewayPort}`: {
    const result = real(args.slice(2));
    process.stdout.write(result.stdout);
    process.exitCode = result.status;
    break;
  }
  default:
    refuse(`the stand-in doesn't run "${command}"`);
}
