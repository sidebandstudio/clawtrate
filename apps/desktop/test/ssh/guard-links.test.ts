// The guard against a synthetic account: the account database is replaced, so
// the protected `.ssh` folder is one this test makes, and links into it can be
// made and followed without the real one ever being near. Every path is
// compared as the file system walks it, and each file is checked before it is
// opened: the configuration, each Include, the keys it names or the defaults.

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type * as os from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof os>();
  return { ...real, userInfo: () => ({ ...real.userInfo(), homedir: account.home }) };
});

import { parseDestination } from "../../src/main/ssh/destination.ts";
import { resolveTarget } from "../../src/main/ssh/person-config.ts";
import { SshTransport } from "../../src/main/ssh/transport.ts";
import {
  guardPaths,
  guardWorld,
  type SshWorld,
  SshWorldRefused,
} from "../../src/main/ssh/world.ts";
import { tempDir, testEnv } from "./harness.ts";

let root: string;
let guarded: string;
let world: SshWorld;
let toNested: string;

beforeAll(() => {
  root = tempDir("clawtrate-guard-links-");
  account.home = join(root, "account");
  guarded = join(account.home, ".ssh");
  mkdirSync(join(guarded, "nested"), { recursive: true });
  writeFileSync(join(guarded, "config"), "Host devbox\n  Port 2222\n");
  writeFileSync(join(guarded, "id_ed25519"), "not a key\n");
  const home = join(root, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  toNested = join(home, "to-nested");
  symlinkSync(join(guarded, "nested"), toNested, "dir");
  symlinkSync(guarded, join(home, "to-guarded"), "dir");
  world = {
    home,
    personConfig: join(home, ".ssh", "config"),
    personKnownHosts: join(home, ".ssh", "known_hosts"),
    ssh: "/usr/bin/ssh",
    appDir: join(root, "app"),
    localUser: "you",
    agent: "none",
    platform: process.platform,
    env: testEnv(),
  };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the guard, as the file system walks a path", () => {
  it("refuses a link into the folder, and a `..` taken from where a link led", () => {
    const check = (path: string) => () => guardPaths([path], guarded, process.platform);
    expect(check(join(toNested, "config"))).toThrow(SshWorldRefused);
    // Spelled, this is the home's own config; walked, it is the guarded folder's.
    expect(check(`${toNested}/../config`)).toThrow(SshWorldRefused);
    // Walked back up and out of the account, to the test home's own file.
    // Built from parts, unnormalized: the `..`s are walked by the file system, not folded here.
    expect(check([toNested, "..", "..", "..", "home", ".ssh", "config"].join("/"))).not.toThrow();
    expect(check(join(world.home, "to-guarded"))).toThrow(SshWorldRefused);
    expect(check(join(world.home, ".ssh", "config"))).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "refuses a path inside the folder an account's .ssh link leads to",
    () => {
      const other = join(root, "other-account");
      const relocated = join(root, "relocated-ssh");
      mkdirSync(other);
      mkdirSync(relocated);
      // The account's .ssh is a link; the path names where it leads, not the link.
      symlinkSync(relocated, join(other, ".ssh"), "dir");
      const check = (path: string) => () =>
        guardPaths([path], join(other, ".ssh"), process.platform);
      expect(check(join(relocated, "config"))).toThrow(SshWorldRefused);
      expect(check(relocated)).toThrow(SshWorldRefused);
      expect(check(join(other, ".ssh", "config"))).toThrow(SshWorldRefused);
      expect(check(join(other, "config"))).not.toThrow();
    },
  );

  it("refuses an Include that leads into the folder, before the file is opened", () => {
    writeFileSync(world.personConfig, `Include ${toNested}/../config\n`);
    const opened: string[] = [];
    const read = (path: string) => {
      opened.push(path);
      return path === world.personConfig ? `Include ${toNested}/../config\n` : "";
    };
    expect(() => resolveTarget(world, parseDestination("devbox")!, read)).toThrow(SshWorldRefused);
    expect(opened).toEqual([world.personConfig]);
  });

  it("refuses a configuration file reached through a link", () => {
    expect(() =>
      guardWorld({ ...world, personConfig: join(world.home, "to-guarded", "config") }),
    ).toThrow(SshWorldRefused);
  });

  it("refuses the default keys of a home whose .ssh is the guarded one, before looking for them", () => {
    const opened: string[] = [];
    const read = (path: string) => {
      opened.push(path);
      return "Host devbox\n  HostName devbox.example\n";
    };
    const inAccount = { ...world, home: account.home, personConfig: world.personConfig };
    expect(() => resolveTarget(inAccount, parseDestination("devbox")!, read)).toThrow(
      SshWorldRefused,
    );
  });

  it("refuses a key path that a link leads into the folder", () => {
    writeFileSync(world.personConfig, "Host devbox\n  IdentityFile ~/to-guarded/id_ed25519\n");
    expect(() => resolveTarget(world, parseDestination("devbox")!)).toThrow(SshWorldRefused);
  });

  it("refuses a plain key whose .pub or -cert.pub beside it is a link into the folder, before any ssh starts", () => {
    const key = join(world.home, ".ssh", "plain_key");
    writeFileSync(key, "");
    const started: string[][] = [];
    const transport = new SshTransport(world, {
      spawn: (_file, args) => {
        started.push([...args]);
        throw new Error("no ssh in this test");
      },
    });
    try {
      for (const suffix of [".pub", "-cert.pub"]) {
        symlinkSync(join(guarded, "id_ed25519"), key + suffix);
        try {
          writeFileSync(world.personConfig, "Host devbox\n  IdentityFile ~/.ssh/plain_key\n");
          expect(() => transport.prepareRoute("1", "devbox"), suffix).toThrow(SshWorldRefused);
        } finally {
          rmSync(key + suffix);
        }
      }
      expect(started).toEqual([]);
    } finally {
      rmSync(key);
    }
  });
});
