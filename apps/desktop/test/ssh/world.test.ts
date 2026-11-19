// The guard: under an automated run, the transport refuses a world whose paths
// resolve inside the real home's .ssh folder, or that would use the real key
// agent, before it reads or starts anything. The real paths below are only
// built as strings; nothing at them is read, listed or changed.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SshTransport } from "../../src/main/ssh/transport.ts";
import {
  childEnv,
  guardPaths,
  guardWorld,
  isAutomatedRun,
  type SshWorld,
  SshWorldRefused,
} from "../../src/main/ssh/world.ts";
import { SSH, tempDir, testEnv } from "./harness.ts";

const realSsh = join(userInfo().homedir, ".ssh");
let root: string;
let world: SshWorld;

beforeAll(() => {
  root = tempDir("clawtrate-ssh-guard-");
  mkdirSync(join(root, "home", ".ssh"), { recursive: true });
  world = {
    home: join(root, "home"),
    personConfig: join(root, "home", ".ssh", "config"),
    personKnownHosts: join(root, "home", ".ssh", "known_hosts"),
    ssh: SSH,
    appDir: join(root, "app"),
    localUser: "you",
    agent: "none",
    platform: process.platform,
    env: testEnv(),
  };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the guard", () => {
  it("knows this is an automated run", () => {
    expect(isAutomatedRun()).toBe(true);
    expect(isAutomatedRun({})).toBe(false);
    expect(isAutomatedRun({ CI: "true" })).toBe(true);
  });

  it("lets the test's own world through", () => {
    expect(() => guardWorld(world)).not.toThrow();
  });

  it.each([
    ["the configuration", { personConfig: join(realSsh, "config") }],
    ["the known-hosts file", { personKnownHosts: join(realSsh, "known_hosts") }],
    ["the app's folder", { appDir: join(realSsh, "clawtrate") }],
    ["the home itself", { home: realSsh }],
    ["a path climbing into it", { personConfig: `${realSsh}/../.ssh/config` }],
  ])("refuses %s inside the real home's .ssh, before anything is read", (_name, change) => {
    const bad = { ...world, ...change };
    expect(() => guardWorld(bad)).toThrow(SshWorldRefused);
    // The transport refuses to start: it makes no folder and starts nothing.
    const appDir = join(root, "never-made");
    expect(
      () => new SshTransport({ ...bad, appDir: bad.appDir === world.appDir ? appDir : bad.appDir }),
    ).toThrow(SshWorldRefused);
    expect(existsSync(appDir)).toBe(false);
  });

  it("compares names as this platform's file system does", () => {
    const upper = { ...world, personConfig: join(realSsh.toUpperCase(), "CONFIG") };
    if (process.platform === "linux") {
      // Another folder on Linux, where names differ by case: nothing to refuse.
      expect(() => guardWorld(upper)).not.toThrow();
    } else {
      expect(() => guardWorld(upper)).toThrow(SshWorldRefused);
    }
  });

  it("folds case on macOS and Windows only, whichever system runs the test", () => {
    const dir = join(root, "guarded", ".ssh");
    const other = join(root, "GUARDED", ".SSH", "config");
    expect(() => guardPaths([other], dir, "darwin")).toThrow(SshWorldRefused);
    expect(() => guardPaths([other], dir, "win32")).toThrow(SshWorldRefused);
    expect(() => guardPaths([other], dir, "linux")).not.toThrow();
  });

  it("refuses the real agent", () => {
    expect(() => guardWorld({ ...world, agent: { socket: "/srv/agent.sock" } })).toThrow(
      SshWorldRefused,
    );
    expect(
      () =>
        new SshTransport({
          ...world,
          agent: { socket: "/srv/agent.sock" },
          appDir: join(root, "never-made-2"),
        }),
    ).toThrow(SshWorldRefused);
    expect(existsSync(join(root, "never-made-2"))).toBe(false);
  });

  it("refuses a key that the person's configuration names in the real .ssh, before any ssh runs", () => {
    const started: string[][] = [];
    const transport = new SshTransport(
      { ...world, home: userInfo().homedir },
      {
        spawn: (_file, args) => {
          started.push([...args]);
          throw new Error("nothing may start");
        },
      },
    );
    writeFileSync(world.personConfig, "Host devbox\n  IdentityFile ~/.ssh/id_ed25519\n");
    expect(() => transport.prepareRoute("1", "devbox")).toThrow(SshWorldRefused);
    expect(started).toEqual([]);
  });

  it("refuses an agent the person's configuration names, under a test run", () => {
    const transport = new SshTransport({ ...world, appDir: join(root, "agent-app") });
    writeFileSync(world.personConfig, 'Host devbox\n  IdentityAgent "~/agent.sock"\n');
    expect(() => transport.prepareRoute("1", "devbox")).toThrow(SshWorldRefused);
  });

  it("refuses a relative path", () => {
    expect(() => guardWorld({ ...world, personConfig: "config" })).toThrow(SshWorldRefused);
  });

  it("is off outside an automated run, where the person's own .ssh and agent are what production uses", () => {
    expect(() =>
      guardWorld(
        { ...world, agent: { socket: "/srv/agent.sock" }, personConfig: join(realSsh, "config") },
        [],
        {},
      ),
    ).not.toThrow();
  });

  it("gives ssh no agent socket when the world has no agent", () => {
    const env = childEnv({
      ...world,
      env: { ...testEnv(), SSH_AUTH_SOCK: "/srv/agent.sock", SSH_AGENT_PID: "1" },
    });
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.SSH_AGENT_PID).toBeUndefined();
  });

  it("starts ssh with a minimal environment of its own choosing, whatever the app's holds", () => {
    const busy = {
      HOME: "/srv/you",
      SSH_AUTH_SOCK: "/srv/agent.sock",
      LD_PRELOAD: "/srv/x.so",
      PATH: "/srv/bin",
    };
    // macOS and Linux, whatever system runs the test; Windows below.
    for (const platform of ["linux", "darwin"] as const) {
      expect(
        childEnv({ ...world, platform, agent: { socket: "/srv/agent.sock" }, env: busy }),
        platform,
      ).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    }
    expect(
      childEnv({
        ...world,
        platform: "win32",
        agent: "windows-pipe",
        env: {
          ...busy,
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\ProgramData\\you",
          NODE_OPTIONS: "--x",
        },
      }),
    ).toEqual({
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\ProgramData\\you",
      PATH: join("C:\\Windows", "System32"),
    });
  });
});
