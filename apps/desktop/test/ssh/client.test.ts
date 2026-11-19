// Which `ssh` clients the transport uses, and the typed "not supported here"
// for the rest: Windows' bundled OpenSSH from the version the research ran,
// OpenSSH 8.4 or later elsewhere. The clients here are stand-ins that only
// print a version, so no real `ssh` runs.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDestination } from "../../src/main/ssh/destination.ts";
import { AppKnownHosts, fingerprintOf } from "../../src/main/ssh/known-hosts.ts";
import { routeConfigText } from "../../src/main/ssh/route-config.ts";
import { SshTransport } from "../../src/main/ssh/transport.ts";
import { productionWorld, type SshWorld } from "../../src/main/ssh/world.ts";
import { tempDir, testEnv } from "./harness.ts";

let root: string;

beforeAll(() => {
  root = tempDir("clawtrate-ssh-client-");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function worldWith(version: string | null, platform: NodeJS.Platform, name: string): SshWorld {
  const dir = join(root, name);
  mkdirSync(join(dir, "home", ".ssh"), { recursive: true });
  const ssh = join(dir, "fake-ssh");
  if (version !== null) {
    writeFileSync(ssh, `#!/bin/sh\necho '${version}' >&2\n`);
    chmodSync(ssh, 0o755);
  }
  return {
    home: join(dir, "home"),
    personConfig: join(dir, "home", ".ssh", "config"),
    personKnownHosts: join(dir, "home", ".ssh", "known_hosts"),
    ssh,
    appDir: join(dir, "app"),
    localUser: "you",
    agent: "none",
    platform,
    env: testEnv(),
  };
}

describe.skipIf(process.platform === "win32")("the ssh client", () => {
  it.each([
    ["macOS's client", "OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", { ok: true }],
    [
      "Ubuntu's client",
      "OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024",
      "linux",
      { ok: true },
    ],
    [
      "the oldest client with known-hosts none",
      "OpenSSH_8.4p1, OpenSSL 1.1.1",
      "linux",
      { ok: true },
    ],
    ["Windows' bundled 9.5", "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2", "win32", { ok: true }],
    [
      "Windows 10's bundled 8.1",
      "OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2",
      "win32",
      { ok: false, kind: "not-supported-here", reason: "ssh-version" },
    ],
    [
      "a client too old for known-hosts none",
      "OpenSSH_7.4p1, OpenSSL 1.0.2k-fips",
      "linux",
      { ok: false, kind: "not-supported-here", reason: "ssh-version" },
    ],
    [
      "another program on Windows",
      "OpenSSH_9.9p2, LibreSSL 3.3.6",
      "win32",
      { ok: false, kind: "not-supported-here", reason: "ssh-version" },
    ],
    [
      "something else",
      "PuTTY Release 0.81",
      "linux",
      { ok: false, kind: "not-supported-here", reason: "ssh-version" },
    ],
    [
      "another system",
      "OpenSSH_9.9p2",
      "freebsd",
      { ok: false, kind: "not-supported-here", reason: "platform" },
    ],
  ] as const)("%s", async (_name, version, platform, expected) => {
    const transport = new SshTransport(
      worldWith(version, platform, `${platform}-${version.length}-${Math.random()}`),
    );
    expect(await transport.checkClient()).toEqual(expected);
  });

  it("needs the version command to have worked, not only printed a version", async () => {
    const world = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", "fails");
    writeFileSync(world.ssh, "#!/bin/sh\necho 'OpenSSH_9.9p2, LibreSSL 3.3.6' >&2\nexit 1\n", {
      mode: 0o755,
    });
    expect(await new SshTransport(world).checkClient()).toEqual({
      ok: false,
      kind: "not-supported-here",
      reason: "ssh-version",
    });
  });

  it("opens a forward only through the same gates as every other call", async () => {
    const found = {
      ok: true as const,
      holdsPort: true as const,
      service: {
        profile: "default" as const,
        serviceLabel: "LaunchAgent" as const,
        configPath: "/srv/you/.openclaw/openclaw.json",
        port: 18789,
      },
    };
    // An unsupported client: nothing but the version command runs.
    const started: string[][] = [];
    const old = worldWith("OpenSSH_7.4p1, OpenSSL 1.0.2k-fips", "linux", "gate-old");
    const oldTransport = new SshTransport(old, {
      spawn: (file, args, env) => {
        started.push([...args]);
        return spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      },
    });
    writeFileSync(old.personConfig, "Host devbox\n  HostName devbox.example\n");
    const oldRoute = oldTransport.prepareRoute("1", "devbox");
    if (!oldRoute.ok) throw new Error();
    expect(await oldTransport.openForward(oldRoute, found)).toEqual({
      ok: false,
      kind: "not-supported-here",
      reason: "ssh-version",
    });
    expect(started).toEqual([["-V"]]);
    // A supported client: no pin, no forward; a stale route or a service not found, no forward.
    const world = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", "gate-new");
    const transport = new SshTransport(world);
    writeFileSync(world.personConfig, "Host devbox\n  HostName devbox.example\n");
    const route = transport.prepareRoute("1", "devbox");
    if (!route.ok) throw new Error();
    expect(await transport.openForward(route, found)).toEqual({ ok: false, kind: "not-pinned" });
    expect(
      await transport.openForward(route, { ...found, holdsPort: false } as unknown as typeof found),
    ).toEqual({ ok: false, kind: "not-a-found-service" });
    transport.prepareRoute("1", "devbox");
    expect(await transport.openForward(route, found)).toEqual({ ok: false, kind: "stale-route" });
  });

  it("turns a spawn that fails into a typed result, never an exception", async () => {
    const world = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", "spawn");
    const transport = new SshTransport(world, {
      spawn: (file, args, env) => {
        if (args[0] === "-V") return spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
        throw new Error("spawn EAGAIN");
      },
    });
    writeFileSync(world.personConfig, "Host devbox\n  HostName devbox.example\n");
    const route = transport.prepareRoute("1", "devbox");
    if (!route.ok) throw new Error();
    expect(await transport.checkHostKey(route)).toMatchObject({
      ok: false,
      kind: "failed",
      failure: { kind: "spawn-failed" },
      note: { title: "ssh couldn't start" },
    });
    // A program that isn't there, started after the version was read.
    const gone = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", "gone");
    const goneTransport = new SshTransport(gone);
    expect(await goneTransport.checkClient()).toEqual({ ok: true });
    rmSync(gone.ssh);
    writeFileSync(gone.personConfig, "Host devbox\n  HostName devbox.example\n");
    const goneRoute = goneTransport.prepareRoute("1", "devbox");
    if (!goneRoute.ok) throw new Error();
    expect(await goneTransport.checkHostKey(goneRoute)).toMatchObject({
      ok: false,
      failure: { kind: "spawn-failed" },
    });
  });

  it("is not supported here when the program is missing, and nothing else runs", async () => {
    const started: string[][] = [];
    const transport = new SshTransport(worldWith(null, "win32", "missing"), {
      spawn: (_file, args) => {
        started.push([...args]);
        throw new Error("nothing may start");
      },
    });
    writeFileSync(transport.world.personConfig, "Host devbox\n  HostName devbox.example\n");
    const route = transport.prepareRoute("1", "devbox");
    if (!route.ok) throw new Error();
    expect(await transport.checkHostKey(route)).toEqual({
      ok: false,
      kind: "not-supported-here",
      reason: "ssh-missing",
    });
    expect(await transport.look(route)).toEqual({
      ok: false,
      kind: "not-supported-here",
      reason: "ssh-missing",
    });
    expect(started).toEqual([]);
  });

  it("reads the script's own exit status: a whole answer from a script that failed is not a LOOK", async () => {
    // A stand-in ssh: answers -V, and otherwise prints a whole, well-formed LOOK for the id it is sent.
    const make = (exit: number) => {
      const world = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", `exit-${exit}`);
      const b64 = (text: string) => Buffer.from(text).toString("base64");
      writeFileSync(
        world.ssh,
        [
          "#!/bin/sh",
          'if [ "$1" = "-V" ]; then echo "OpenSSH_9.9p2, LibreSSL 3.3.6" >&2; exit 0; fi',
          "id=$(head -n 1 | sed \"s/^request_id='\\(.*\\)'$/\\1/\")",
          "cat >/dev/null",
          `printf '{"k":"begin","id":"%s"}\\n' "$id"`,
          `printf '{"k":"uname","s":"${b64("Linux")}","m":"${b64("x86_64")}","n":"${b64("devbox")}"}\\n'`,
          `printf '{"k":"signs","state":0,"launchd":0,"systemd":0,"cstate":0,"claunchd":0,"csystemd":0}\\n'`,
          `printf '{"k":"end","id":"%s"}\\n' "$id"`,
          `exit ${exit}`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const transport = new SshTransport(world);
      writeFileSync(world.personConfig, "Host devbox\n  HostName devbox.example\n");
      const route = transport.prepareRoute("1", "devbox");
      if (!route.ok) throw new Error(JSON.stringify(route));
      const key = Buffer.concat([
        Buffer.from([0, 0, 0, 11]),
        Buffer.from("ssh-ed25519"),
        Buffer.from([0, 0, 0, 32]),
        Buffer.alloc(32, 1),
      ]).toString("base64");
      new AppKnownHosts(join(world.appDir, "known_hosts")).pin(
        route.alias,
        { type: "ssh-ed25519", key, fingerprint: fingerprintOf(key) },
        route.endpoint,
        new Date(0),
        false,
      );
      return { transport, route };
    };
    const good = make(0);
    expect(await good.transport.look(good.route)).toMatchObject({
      ok: true,
      facts: { program: null },
    });
    const failed = make(3);
    expect(await failed.transport.look(failed.route)).toEqual({
      ok: false,
      kind: "cant-tell",
      reason: "script-failed",
    });
  });

  it("counts the LOOK's output in bytes: multibyte noise past 64 KiB is too much", async () => {
    const world = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", "bytes");
    // 40,000 two-byte characters: 80,000 bytes, though fewer than 65,536 characters.
    writeFileSync(
      world.ssh,
      [
        "#!/bin/sh",
        'if [ "$1" = "-V" ]; then echo "OpenSSH_9.9p2, LibreSSL 3.3.6" >&2; exit 0; fi',
        "cat >/dev/null",
        `printf '${"é".repeat(40000)}\\n'`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const transport = new SshTransport(world);
    writeFileSync(world.personConfig, "Host devbox\n  HostName devbox.example\n");
    const route = transport.prepareRoute("1", "devbox");
    if (!route.ok) throw new Error();
    const key = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from("ssh-ed25519"),
      Buffer.from([0, 0, 0, 32]),
      Buffer.alloc(32, 2),
    ]).toString("base64");
    new AppKnownHosts(join(world.appDir, "known_hosts")).pin(
      route.alias,
      { type: "ssh-ed25519", key, fingerprint: fingerprintOf(key) },
      route.endpoint,
      new Date(0),
      false,
    );
    expect(await transport.look(route)).toEqual({
      ok: false,
      kind: "cant-tell",
      reason: "too-large",
    });
  });

  it("writes Windows paths with forward slashes, and uses Windows' bundled ssh in production", () => {
    const world = { ...worldWith("x", "win32", "paths"), platform: "win32" as const };
    const text = routeConfigText(
      "1",
      {
        ok: true,
        destination: parseDestination("devbox")!,
        name: "devbox",
        hostName: "devbox.example",
        user: "you",
        port: 22,
        identityFiles: ["C:\\ProgramData\\you\\.ssh\\id_ed25519"],
        identitiesOnly: true,
        certificateFiles: [],
        identityAgent: "world",
        pubkeyAuthentication: null,
      },
      world,
      "C:\\ProgramData\\Clawtrate\\ssh\\known_hosts",
    );
    expect(text).toContain('  IdentityFile "C:/ProgramData/you/.ssh/id_ed25519"\n');
    expect(text).toContain('  UserKnownHostsFile "C:/ProgramData/Clawtrate/ssh/known_hosts"\n');
    const production = productionWorld(join(root, "prod"), { SSH_AUTH_SOCK: "/srv/agent.sock" });
    expect(production.agent).toEqual(
      process.platform === "win32" ? "windows-pipe" : { socket: "/srv/agent.sock" },
    );
    expect(productionWorld(join(root, "prod"), {}).agent).toEqual(
      process.platform === "win32" ? "windows-pipe" : "none",
    );
    expect(production.ssh).toBe(process.platform === "win32" ? production.ssh : "/usr/bin/ssh");
  });
});
