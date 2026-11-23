// A development gateway of a test's own for local connect's checks
// (docs/design/setup-effortless.md §3, "In development"): OpenClaw 2026.10.6
// from `OPENCLAW_BIN`, run with `--profile clawtrate` in a temporary home of
// its own, on a port of its own, with its token auth on loopback. It is
// started and stopped by its PID only. Nothing here reads, names or dials the
// account's own OpenClaw: the home, the state folder and the config are all
// inside the temporary folder, and the port is never OpenClaw's default.
// Also the stand-ins the boundary checks put in front of it.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const OPENCLAW_DEFAULT_PORT = 18789;
export const FOLDER = ".openclaw-clawtrate";

/** The OpenClaw program the checks run, or null: never a system-wide Homebrew copy. */
export function openclawBin(): string | null {
  const bin = process.env.OPENCLAW_BIN;
  if (!bin || process.env.CLAWTRATE_LOCAL_GATEWAY !== "1") return null;
  const real = realpathSync(bin);
  if (real.startsWith("/opt/homebrew/lib/node_modules/openclaw/"))
    throw new Error("OPENCLAW_BIN must be a copy of OpenClaw of the test's own.");
  return bin;
}

/** A free loopback port, never OpenClaw's default. */
export async function freePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    await new Promise((done) => server.close(done));
    if (port !== OPENCLAW_DEFAULT_PORT) return port;
  }
}

const reachable = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });

/** Whether the gateway at `port` answers a WebSocket with its `connect.challenge`, sending nothing. */
const challenges = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => finish(false), 5_000);
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      socket.close();
      done(ready);
    };
    socket.onmessage = (event) => finish(String(event.data).includes('"connect.challenge"'));
    socket.onerror = () => finish(false);
  });

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export type DevGateway = {
  home: string;
  port: number;
  token: string;
  pid: number;
  /** OpenClaw's own command line against this instance, as `devices approve` needs. */
  run: (args: string[]) => { status: number | null; stdout: string };
  stop: () => Promise<void>;
  /** Stops it if running and deletes its home. */
  remove: () => Promise<void>;
};

/**
 * Starts the instance and waits until it listens. `approval`: the gateway's
 * local auto-approval off, as every development instance has it; otherwise
 * at OpenClaw's own default, as `--default-local-pairing` leaves it.
 */
export async function startGateway(
  bin: string,
  options: { approval: boolean },
): Promise<DevGateway> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-local-gateway-")));
  chmodSync(home, 0o700);
  const state = join(home, FOLDER);
  mkdirSync(state, { mode: 0o700 });
  const port = await freePort();
  const token = randomBytes(24).toString("hex");
  const config = join(state, "openclaw.json");
  writeFileSync(
    config,
    JSON.stringify({
      gateway: {
        mode: "local",
        port,
        bind: "loopback",
        auth: { mode: "token", token },
        ...(options.approval ? { nodes: { pairing: { autoApproveLocal: false } } } : {}),
      },
      discovery: { mdns: { mode: "off" } },
      update: { checkOnStart: false },
    }),
    { mode: 0o600 },
  );
  const node = process.env.OPENCLAW_NODE ?? process.execPath;
  const env = {
    HOME: home,
    PATH: `${dirname(node)}:/usr/bin:/bin`,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    NO_COLOR: "1",
  };
  const profile = ["--profile", "clawtrate"];
  const log = openSync(join(home, "gateway.log"), "w");
  let child: ChildProcess | null = spawn(
    bin,
    [...profile, "gateway", "run", "--port", String(port), "--bind", "loopback"],
    { env, stdio: ["ignore", log, log] },
  );
  closeSync(log);
  let exited = false;
  child.once("exit", () => (exited = true));
  const stop = async () => {
    if (!child || exited) return;
    child.kill("SIGTERM");
    for (let waited = 0; !exited && waited < 15_000; waited += 100) await sleep(100);
    if (!exited) child.kill("SIGKILL");
    for (let waited = 0; (await reachable(port)) && waited < 15_000; waited += 100)
      await sleep(100);
    child = null;
  };
  const remove = async () => {
    await stop();
    rmSync(home, { recursive: true, force: true });
  };
  const run = (args: string[]) => {
    const result = spawnSync(bin, [...profile, ...args], {
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: result.status, stdout: result.stdout };
  };
  try {
    // A cold start has taken more than a minute on a busy machine. It listens, and answers a
    // WebSocket, before it has finished starting; it is ready once its health call answers, as
    // `pnpm dev-gateway` waits for it.
    const started = Date.now();
    for (;;) {
      if (exited || Date.now() - started > 240_000)
        throw new Error("the development gateway didn't start");
      if (
        (await challenges(port)) &&
        run(["gateway", "call", "health", "--json", "--timeout", "3000"]).status === 0
      )
        break;
      await sleep(250);
    }
  } catch (error) {
    await remove();
    throw error;
  }
  return {
    home,
    port,
    token,
    pid: child.pid!,
    run,
    stop,
    remove,
  };
}

/** A program of the test's own, in a process of its own: a listener that counts what it is sent. */
const LISTENER = `
const net = require("node:net");
const [listen, target] = process.argv.slice(1).map(Number);
let bytes = 0;
net.createServer((socket) => {
  socket.on("error", () => {});
  socket.on("data", (data) => { bytes += data.length; process.stdout.write("bytes " + bytes + "\\n"); });
  if (target) {
    const onward = net.connect(target, "127.0.0.1");
    onward.on("error", () => socket.destroy());
    socket.pipe(onward);
    onward.pipe(socket);
  }
  process.stdout.write("accepted\\n");
}).listen(listen, "127.0.0.1", () => process.stdout.write("ready\\n"));
`;

export type StandIn = { accepted: () => number; bytes: () => number; stop: () => Promise<void> };

/**
 * A listener at `port` in a process of its own, forwarding every byte to
 * `target` when given one; `wrap` runs it under another program
 * (`sandbox-exec`). It reports what it accepted and was sent.
 */
export async function standIn(
  port: number,
  target: number | null,
  wrap: string[] = [],
): Promise<StandIn> {
  const [program, ...args] = [
    ...wrap,
    process.execPath,
    "-e",
    LISTENER,
    String(port),
    String(target ?? 0),
  ];
  const child = spawn(program!, args, { stdio: ["ignore", "pipe", "inherit"] });
  let accepted = 0;
  let bytes = 0;
  let ready = false;
  let exited = false;
  child.once("exit", () => (exited = true));
  child.stdout!.setEncoding("utf8").on("data", (text: string) => {
    for (const line of text.split("\n")) {
      if (line === "ready") ready = true;
      if (line === "accepted") accepted += 1;
      if (line.startsWith("bytes ")) bytes = Number(line.slice(6));
    }
  });
  for (let waited = 0; !ready; waited += 50) {
    if (exited || waited > 20_000) throw new Error("the stand-in didn't start");
    await sleep(50);
  }
  return {
    accepted: () => accepted,
    bytes: () => bytes,
    stop: async () => {
      if (exited) return;
      child.kill("SIGKILL");
      for (let waited = 0; !exited && waited < 5_000; waited += 50) await sleep(50);
    },
  };
}
