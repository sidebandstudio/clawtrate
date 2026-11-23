// The target check shared by the provider-account probes. Research code for
// docs/research/provider-accounts-and-t3-code.md.
//
// A probe may only act on a named development instance that this checkout's
// `pnpm dev-gateway start --instance <name>` created and whose gateway is still
// the process that start recorded. Everything is read again from the instance's
// marker, this checkout's run files and the live process:
//   - CLAWTRATE_DEV_INSTANCE is a valid name other than the default;
//   - this checkout has run files for it, and the state folder is a real folder
//     with the tool's marker;
//   - instance name, run id and checkout agree across the marker and run files;
//   - the endpoint is ws://127.0.0.1:<port> with the port in 19200-19999 and
//     equal to the recorded gateway port;
//   - the recorded gateway PID is alive and started at the recorded time.
// The default instance (~/.openclaw-dev, port 19001) and the working profile
// (~/.openclaw) can never pass.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const checkout = path.resolve(here, "../../../..");

const refuse = (why) => {
  console.error(`probe refuses this target: ${why}`);
  process.exit(2);
};

export function resolveInstance() {
  const name = process.env.CLAWTRATE_DEV_INSTANCE ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(name) || name.includes("--") || ["default", "dev"].includes(name)) {
    console.error("Set CLAWTRATE_DEV_INSTANCE to a named development instance started from this checkout.");
    process.exit(2);
  }
  const runDir = path.join(checkout, "tools/dev-gateway/.run/instances", name);
  const stateDir = path.join(homedir(), `.openclaw-clawtrate-dev-${name}`);
  const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
  for (const file of ["connection.json", "state.json"]) if (!existsSync(path.join(runDir, file))) refuse(`no ${file} for this instance in this checkout`);
  if (!existsSync(stateDir) || lstatSync(stateDir).isSymbolicLink()) refuse("instance state folder missing or a link");
  const markerFile = path.join(stateDir, ".clawtrate-dev-gateway");
  if (!existsSync(markerFile)) refuse("instance state folder has no dev-gateway marker");
  const connection = readJson(path.join(runDir, "connection.json"));
  const runState = readJson(path.join(runDir, "state.json"));
  const marker = readJson(markerFile);
  if (connection.instance !== name || runState.instance !== name || marker.instance !== name) refuse("instance names disagree");
  if (connection.runId !== runState.runId || marker.runId !== runState.runId) refuse("run ids disagree");
  const real = (p) => realpathSync(p);
  if (real(marker.checkout ?? "/") !== real(checkout) || real(runState.checkout ?? "/") !== real(checkout)) refuse("the instance was started from another checkout");
  const url = new URL(connection.url);
  const gatewayPort = Number(url.port);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || gatewayPort < 19200 || gatewayPort > 19999 || gatewayPort !== runState.gatewayPort || gatewayPort !== marker.gatewayPort) refuse("endpoint is not this named instance");
  const pid = marker.gatewayPid;
  if (!Number.isInteger(pid) || pid <= 1) refuse("no gateway PID on record");
  // The tool records the start time in UTC as "2026-11-16T21:27:01Z" (tools/dev-gateway/src/state-guard.ts).
  const ps = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC" } });
  const [, month, day, time, year] = ps.stdout.trim().split(/\s+/);
  const monthIndex = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(month ?? "");
  const identity = monthIndex < 0 ? null : `${year}-${String(monthIndex + 1).padStart(2, "0")}-${(day ?? "").padStart(2, "0")}T${time}Z`;
  if (ps.status !== 0 || identity !== marker.gatewayIdentity) refuse("the recorded gateway is not running");
  return { name, runDir, stateDir, connection, runState, gatewayPort, scriptedPort: runState.providerPort };
}

/** OpenClaw's command line for this instance only: its profile, its state folder, an allowlisted environment. */
export function instanceCli(inst) {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), NO_COLOR: "1" };
  for (const key of ["TMPDIR", "LANG", "LC_ALL", "TZ", "USER"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    OPENCLAW_PROFILE: `clawtrate-dev-${inst.name}`,
    OPENCLAW_STATE_DIR: inst.stateDir,
    OPENCLAW_CONFIG_PATH: path.join(inst.stateDir, "openclaw.json"),
    OPENCLAW_GATEWAY_PORT: String(inst.gatewayPort),
  });
  // Asynchronous, so a probe's gateway connection keeps answering heartbeats meanwhile.
  return (args, input) =>
    new Promise((resolve) => {
      const child = spawn(process.env.OPENCLAW_BIN ?? "openclaw", ["--profile", `clawtrate-dev-${inst.name}`, ...args], { cwd: inst.stateDir, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() });
      });
      child.stdin.end(input ?? "");
    });
}

/** Stops and resets this instance through the tool (only its own processes and state folder). */
export function resetInstance(inst) {
  for (const command of ["stop", "reset"]) {
    const r = spawnSync("pnpm", ["dev-gateway", command, "--instance", inst.name], { cwd: checkout, encoding: "utf8" });
    console.log(`pnpm dev-gateway ${command} --instance ${inst.name}: exit ${r.status}`);
  }
}
