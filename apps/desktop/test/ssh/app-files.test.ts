// The app's own SSH files: made exclusively, never through a link, tightened
// to the owner on every write and read, also when they were there before, and
// replaced or removed without following what is in their place.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createOwn,
  readOwn,
  removeOwn,
  secureDir,
  UnsafeAppFile,
  writeOwn,
} from "../../src/main/ssh/app-files.ts";
import { AppKnownHosts } from "../../src/main/ssh/known-hosts.ts";
import { SshTransport } from "../../src/main/ssh/transport.ts";
import type { SshWorld } from "../../src/main/ssh/world.ts";
import { SSH, tempDir, testEnv } from "./harness.ts";

const unix = process.platform !== "win32";
const mode = (path: string) => statSync(path).mode & 0o777;
// A well-formed ED25519 public key blob (its type, then 32 bytes), made here.
const KEY = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]).toString("base64");
const hostKey = { type: "ssh-ed25519", key: KEY, fingerprint: "" };

let root: string;
let world: SshWorld;

beforeEach(() => {
  root = tempDir("clawtrate-app-files-");
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

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!unix)("the app's SSH folder and files", () => {
  it("tightens a folder that was already there, and refuses one that is a link", () => {
    mkdirSync(world.appDir, { mode: 0o755 });
    chmodSync(world.appDir, 0o755);
    new SshTransport(world);
    expect(mode(world.appDir)).toBe(0o700);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "linked"), "dir");
    expect(() => secureDir(join(root, "linked"))).toThrow(UnsafeAppFile);
  });

  it("tightens a known-hosts file that was there before, on read and on write", async () => {
    const { fingerprintOf } = await import("../../src/main/ssh/known-hosts.ts");
    const key = { ...hostKey, fingerprint: fingerprintOf(KEY) };
    secureDir(world.appDir);
    const file = join(world.appDir, "known_hosts");
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    const known = new AppKnownHosts(file);
    expect(known.get("clawtrate-route-1")).toBeNull();
    expect(mode(file)).toBe(0o600);
    chmodSync(file, 0o644);
    known.pin("clawtrate-route-1", key, "[127.0.0.1]:22", new Date(0), false);
    expect(mode(file)).toBe(0o600);
    chmodSync(file, 0o666);
    known.remove("clawtrate-route-1");
    expect(mode(file)).toBe(0o600);
  });

  it("replaces a link in a file's place instead of writing through it", () => {
    secureDir(world.appDir);
    const victim = join(root, "victim");
    writeFileSync(victim, "keep me\n");
    const file = join(world.appDir, "known_hosts");
    symlinkSync(victim, file);
    writeOwn(file, "new\n");
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("new\n");
    expect(mode(file)).toBe(0o600);
  });

  it("refuses to read trust from a link, and the transport says so instead of throwing", async () => {
    secureDir(world.appDir);
    const planted = join(root, "planted");
    writeFileSync(planted, `clawtrate-route-1 ssh-ed25519 ${KEY}\n`);
    symlinkSync(planted, join(world.appDir, "known_hosts"));
    expect(() => readOwn(join(world.appDir, "known_hosts"), 1024)).toThrow(UnsafeAppFile);
    const transport = new SshTransport(world);
    writeFileSync(world.personConfig, "Host devbox\n  HostName 127.0.0.1\n");
    const route = transport.prepareRoute("1", "devbox");
    if (!route.ok) throw new Error(JSON.stringify(route));
    expect(await transport.look(route)).toEqual({ ok: false, kind: "app-files-unsafe" });
    expect(readlinkSync(join(world.appDir, "known_hosts"))).toBe(planted);
  });

  it("replaces a route's configuration that a link stands in for, leaving its target alone", () => {
    const transport = new SshTransport(world);
    writeFileSync(world.personConfig, "Host devbox\n  HostName 127.0.0.1\n");
    const first = transport.prepareRoute("1", "devbox");
    if (!first.ok) throw new Error();
    const config = transport.configPath(first);
    rmSync(config);
    const victim = join(root, "victim.conf");
    writeFileSync(victim, "Host x\n  ProxyCommand touch pwned\n");
    symlinkSync(victim, config);
    const again = transport.prepareRoute("1", "devbox");
    if (!again.ok) throw new Error();
    expect(readFileSync(victim, "utf8")).toBe("Host x\n  ProxyCommand touch pwned\n");
    expect(lstatSync(transport.configPath(again)).isSymbolicLink()).toBe(false);
    expect(mode(transport.configPath(again))).toBe(0o600);
  });

  it("makes a new file only where nothing is, a link included", () => {
    secureDir(world.appDir);
    const target = join(root, "target");
    symlinkSync(target, join(world.appDir, "capture-x"));
    expect(() => createOwn(join(world.appDir, "capture-x"), "")).toThrow();
    expect(() => statSync(target)).toThrow();
    createOwn(join(world.appDir, "capture-y"), "");
    expect(mode(join(world.appDir, "capture-y"))).toBe(0o600);
  });

  it("removes a link itself, never what it points at", () => {
    secureDir(world.appDir);
    const victim = join(root, "victim");
    writeFileSync(victim, "keep me\n");
    symlinkSync(victim, join(world.appDir, "route-1.conf"));
    removeOwn(join(world.appDir, "route-1.conf"));
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
    expect(() => lstatSync(join(world.appDir, "route-1.conf"))).toThrow();
  });
});
