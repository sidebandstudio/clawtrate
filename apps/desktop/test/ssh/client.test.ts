// Which `ssh` clients the transport uses, and the typed "not supported here"
// for the rest: Windows' bundled OpenSSH from the version the research ran,
// OpenSSH 8.4 or later elsewhere. The clients here are stand-ins that only
// print a version, so no real `ssh` runs.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDestination } from "../../src/main/ssh/destination.ts";
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
