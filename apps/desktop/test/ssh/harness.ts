// A world and an `sshd` of the test's own: a temporary home with its own SSH
// configuration, known-hosts file and key, and an `sshd` started as the current
// user on a loopback port, with its own host key, authorized keys and
// configuration, stopped by its PID. Nothing of this machine's own SSH setup is
// read or used: every `ssh` here runs with `-F` on a generated file, the test's
// key, `IdentitiesOnly`, no agent and `SSH_AUTH_SOCK` removed.

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { PROGRAM_PLACES } from "../../src/main/ssh/look.ts";
import type { SshWorld } from "../../src/main/ssh/world.ts";

export const SSHD = "/usr/sbin/sshd";
export const SSH = process.platform === "win32" ? "" : "/usr/bin/ssh";
export const KEYGEN = "/usr/bin/ssh-keygen";

/** The environment every program of these tests runs with: no agent. */
export function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.SSH_AUTH_SOCK;
  delete env.SSH_AGENT_PID;
  return env;
}

export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function keygen(path: string, type: "ed25519" | "ecdsa" = "ed25519"): void {
  execFileSync(KEYGEN, ["-q", "-t", type, "-N", "", "-C", "clawtrate-test", "-f", path], {
    env: testEnv(),
    stdio: "ignore",
  });
}

/** Whether these tests can start an `sshd` of their own here, and why not. */
export function sshdAvailability(): { ok: true } | { ok: false; reason: string } {
  if (process.platform === "win32")
    return { ok: false, reason: "no sshd for the current user on Windows" };
  for (const program of [SSHD, SSH, KEYGEN]) {
    if (!existsSync(program)) return { ok: false, reason: `${program} is not installed` };
  }
  const dir = tempDir("clawtrate-sshd-check-");
  try {
    keygen(join(dir, "host"));
    writeFileSync(
      join(dir, "config"),
      `Port 22\nListenAddress 127.0.0.1\nHostKey ${join(dir, "host")}\nPidFile none\nUsePAM no\nSetEnv HOME=${dir}\n`,
    );
    const check = spawnSync(SSHD, ["-t", "-f", join(dir, "config")], {
      env: testEnv(),
      encoding: "utf8",
    });
    if (check.status !== 0)
      return { ok: false, reason: `sshd -t refused a test configuration (exit ${check.status})` };
    return { ok: true };
  } catch {
    return { ok: false, reason: "ssh-keygen failed" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The fixed places of the LOOK script that exist on this machine outside any home. */
export function absolutePlacesHere(): string[] {
  return PROGRAM_PLACES.filter((place) => place.startsWith("/") && existsSync(place));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export type TestWorld = {
  root: string;
  home: string;
  world: SshWorld;
  userKey: string;
  /** Writes the person's SSH configuration in the test home. */
  writeConfig(text: string): void;
};

export function makeWorld(root: string): TestWorld {
  const home = join(root, "home");
  const dotSsh = join(home, ".ssh");
  mkdirSync(dotSsh, { recursive: true, mode: 0o700 });
  const userKey = join(dotSsh, "id_ed25519");
  keygen(userKey);
  const world: SshWorld = {
    home,
    personConfig: join(dotSsh, "config"),
    personKnownHosts: join(dotSsh, "known_hosts"),
    ssh: SSH,
    appDir: join(root, "app"),
    localUser: userInfo().username,
    agent: "none",
    platform: process.platform,
    env: testEnv(),
  };
  return {
    root,
    home,
    world,
    userKey,
    writeConfig: (text) => writeFileSync(world.personConfig, text, { mode: 0o600 }),
  };
}

/** A stand-in `openclaw` in the test home's first fixed place, answering from files the test writes. */
export function installStubOpenclaw(home: string): {
  setVersion(text: string): void;
  setStatus(profile: "default" | "clawtrate", json: unknown, exit?: number): void;
} {
  const bin = join(home, ".openclaw", "bin");
  const stub = join(home, ".openclaw", "stub");
  mkdirSync(bin, { recursive: true });
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    join(bin, "openclaw"),
    [
      "#!/bin/sh",
      'd="$HOME/.openclaw/stub"',
      'case "$*" in',
      '  --version) cat "$d/version" ;;',
      '  "gateway status --json") cat "$d/status-default.json"; exit "$(cat "$d/exit-default")" ;;',
      '  "--profile clawtrate gateway status --json") cat "$d/status-clawtrate.json"; exit "$(cat "$d/exit-clawtrate")" ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    setVersion: (text) => writeFileSync(join(stub, "version"), text),
    setStatus: (profile, json, exit = 0) => {
      writeFileSync(join(stub, `status-${profile}.json`), JSON.stringify(json, null, 2));
      writeFileSync(join(stub, `exit-${profile}`), String(exit));
    },
  };
}

/** A `gateway status --json` shaped as OpenClaw 2026.10.6 prints it, reduced to what the parser reads. */
export function statusJson(options: {
  port: number;
  home: string;
  running?: boolean;
  rpcOk?: boolean;
  pid?: number;
  configPath?: string;
}): unknown {
  const pid = options.pid ?? 4242;
  return {
    cli: { version: "2026.10.6" },
    service: {
      label: "LaunchAgent",
      loaded: true,
      runtime: { status: options.running === false ? "stopped" : "running", pid },
    },
    config: {
      daemon: {
        path: options.configPath ?? `${options.home}/.openclaw/openclaw.json`,
        exists: true,
      },
    },
    gateway: {
      bindMode: "loopback",
      bindHost: "127.0.0.1",
      port: options.port,
      version: "2026.10.6",
    },
    port: { port: options.port, status: "busy", listeners: [{ pid }] },
    rpc: { ok: options.rpcOk ?? true, url: `ws://127.0.0.1:${options.port}` },
    extraServices: [],
  };
}

/** The PIDs of every descendant of `pid`, read from the process table. */
export function descendants(pid: number): number[] {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const walk = (p: number) => {
    for (const c of children.get(p) ?? []) {
      found.push(c);
      walk(c);
    }
  };
  walk(pid);
  return found;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export type TestSshd = {
  port: number;
  pid: number;
  hostKey: string;
  /** Ends every connection's session processes, leaving the listener. */
  dropSessions(): Promise<void>;
  stop(): Promise<void>;
  /** Starts again on the same port, with `hostKey` or a new one. */
  start(hostKey?: string): Promise<void>;
};

/** An `sshd` of the test's own, as the current user, on a loopback port, with `home` as its sessions' HOME. */
export async function startSshd(
  root: string,
  home: string,
  authorizedKey: string,
): Promise<TestSshd> {
  const dir = join(root, "sshd");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  let hostKey = join(dir, "host_ed25519");
  keygen(hostKey);
  writeFileSync(join(dir, "authorized_keys"), readFileSync(`${authorizedKey}.pub`), {
    mode: 0o600,
  });
  let child: ChildProcess | null = null;
  let log = "";
  const config = () =>
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKey}`,
      "PidFile none",
      `AuthorizedKeysFile ${join(dir, "authorized_keys")}`,
      "StrictModes no",
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "PermitUserRC no",
      "PermitUserEnvironment no",
      "AllowAgentForwarding no",
      "AllowTcpForwarding local",
      "X11Forwarding no",
      // Sessions see the test's home, not the account's: their start-up files and the LOOK's places.
      `SetEnv HOME=${home} ZDOTDIR=${home}`,
      "LogLevel VERBOSE",
      "",
    ].join("\n");
  const sshd: TestSshd = {
    port,
    pid: 0,
    get hostKey() {
      return hostKey;
    },
    async start(key) {
      if (key) hostKey = key;
      writeFileSync(join(dir, "sshd_config"), config());
      log = "";
      const started = spawn(SSHD, ["-D", "-e", "-f", join(dir, "sshd_config")], {
        env: testEnv(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      child = started;
      started.stderr?.setEncoding("utf8");
      started.stderr?.on("data", (chunk: string) => {
        log = (log + chunk).slice(-65536);
      });
      sshd.pid = started.pid ?? 0;
      await waitFor(
        () =>
          log.includes(`Server listening on 127.0.0.1 port ${port}`) || started.exitCode !== null,
        10000,
        "sshd to listen",
      );
      if (started.exitCode !== null) throw new Error(`sshd exited (${started.exitCode})`);
    },
    async dropSessions() {
      if (!sshd.pid) return;
      for (const pid of descendants(sshd.pid).reverse()) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      await waitFor(() => descendants(sshd.pid).length === 0, 5000, "sshd sessions to end");
    },
    async stop() {
      const running = child;
      if (!running || !sshd.pid) return;
      await sshd.dropSessions().catch(() => {});
      const done = new Promise<void>((resolve) => {
        if (running.exitCode !== null || running.signalCode !== null) resolve();
        else running.once("close", () => resolve());
      });
      running.kill("SIGTERM");
      await done;
      child = null;
    },
  };
  await sshd.start();
  return sshd;
}

/**
 * Proves, with a plain `ssh` of the test's own, that a session of this `sshd`
 * sees the test's home as HOME. Every LOOK depends on it: the script's first
 * fixed place is then the test's stand-in, and `~/.openclaw` is the test's.
 */
export function assertSessionHome(
  root: string,
  sshd: TestSshd,
  world: SshWorld,
  userKey: string,
): void {
  const config = join(root, "home-check.conf");
  const knownHosts = join(root, "home-check.known_hosts");
  writeFileSync(knownHosts, "");
  writeFileSync(
    config,
    [
      "Host home-check",
      "  HostName 127.0.0.1",
      `  Port ${sshd.port}`,
      `  User ${world.localUser}`,
      `  IdentityFile ${userKey}`,
      "  IdentitiesOnly yes",
      "  IdentityAgent none",
      `  UserKnownHostsFile ${knownHosts}`,
      "  GlobalKnownHostsFile none",
      "  StrictHostKeyChecking accept-new",
      "  BatchMode yes",
      "",
    ].join("\n"),
  );
  const run = spawnSync(SSH, ["-F", config, "--", "home-check", "/bin/sh", "-s"], {
    input: 'printf "%s" "$HOME"\n',
    env: testEnv(),
    encoding: "utf8",
    timeout: 15000,
  });
  const lines = run.stdout.split("\n");
  if (run.status !== 0 || lines[lines.length - 1] !== world.home) {
    throw new Error(
      "The test sshd's sessions do not see the test home as HOME; refusing to run the LOOK.",
    );
  }
}

/** A loopback TCP echo server standing in for the gateway's port. */
export function echoServer(): Promise<{ port: number; server: Server; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.pipe(socket);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            for (const socket of sockets) socket.destroy();
          }),
      });
    });
  });
}
