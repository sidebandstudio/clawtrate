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
    ["a path climbing into it", { personConfig: join(realSsh, "..", ".ssh", "config") }],
    ["the folder in another case", { personConfig: join(realSsh.toUpperCase(), "config") }],
  ])("refuses %s inside the real home's .ssh, before anything is read", (_name, change) => {
    const bad = { ...world, ...change };
    if (bad.personConfig.toUpperCase() === bad.personConfig && process.platform === "linux") return;
    expect(() => guardWorld(bad)).toThrow(SshWorldRefused);
    // The transport refuses to start: it makes no folder and starts nothing.
    const appDir = join(root, "never-made");
    expect(
      () => new SshTransport({ ...bad, appDir: bad.appDir === world.appDir ? appDir : bad.appDir }),
    ).toThrow(SshWorldRefused);
    expect(existsSync(appDir)).toBe(false);
  });

  it("refuses the real agent", () => {
    expect(() => guardWorld({ ...world, agent: "inherit" })).toThrow(SshWorldRefused);
    expect(
      () => new SshTransport({ ...world, agent: "inherit", appDir: join(root, "never-made-2") }),
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

  it("refuses a relative path", () => {
    expect(() => guardWorld({ ...world, personConfig: "config" })).toThrow(SshWorldRefused);
  });

  it("is off outside an automated run, where the person's own .ssh and agent are what production uses", () => {
    expect(() =>
      guardWorld({ ...world, agent: "inherit", personConfig: join(realSsh, "config") }, [], {}),
    ).not.toThrow();
  });

  it("gives ssh no agent socket when the world has no agent", () => {
    const env = childEnv({
      ...world,
      env: { ...testEnv(), SSH_AUTH_SOCK: "/srv/agent.sock", SSH_AGENT_PID: "1" },
    });
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.SSH_AGENT_PID).toBeUndefined();
    expect(
      childEnv({ ...world, agent: "inherit", env: { SSH_AUTH_SOCK: "/srv/agent.sock" } })
        .SSH_AUTH_SOCK,
    ).toBe("/srv/agent.sock");
  });
});
