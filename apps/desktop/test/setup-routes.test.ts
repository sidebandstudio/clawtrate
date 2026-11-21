// The parts of "Another computer" that run nothing: the route store with one
// token per route, the app-data privacy check, what the found card says from
// the LOOK's facts, and the approve command for a route's computer and profile.

import { approvalForPlace } from "@clawtrate/core";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { memoryStorage } from "../../../packages/core/test/fake-gateway.ts";
import type { LookFacts } from "../src/main/ssh/look.ts";
import { approvalInstructionsFor } from "../src/host/runtime.ts";
import { establishPrivateDir } from "../src/setup/private-dir.ts";
import { sshRouteKey } from "../src/setup/remote.ts";
import { RouteStore, routedStorage, type SshRouteRecord } from "../src/setup/routes.ts";
import { sshLook } from "../src/setup/ssh-look.ts";
import { tempDir } from "./ssh/harness.ts";

const dirs: string[] = [];
const fresh = (prefix: string) => {
  const dir = tempDir(prefix);
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const record = (patch: Partial<SshRouteRecord> = {}): SshRouteRecord => {
  const base = {
    kind: "ssh" as const,
    id: "r1",
    destination: "devbox",
    name: "devbox",
    account: "you@devbox.example",
    endpoint: "you@[devbox.example]:22",
    fingerprint: FINGERPRINT,
    profile: "default" as const,
    serviceLabel: "LaunchAgent" as const,
    configPath: "~/.openclaw/openclaw.json",
    gatewayPort: 18789,
    identity: null,
    startedByClawtrate: false,
    lastUsed: 1,
    ...patch,
  };
  return {
    ...base,
    key:
      patch.key ??
      sshRouteKey({
        fingerprint: base.fingerprint,
        endpoint: base.endpoint,
        gatewayPort: base.gatewayPort,
        profile: base.profile,
      }),
  };
};

describe("the route store", () => {
  const tokenKey = (key: string) => `deviceToken:route:${key}:device-1:operator`;

  it("keeps one token per route, only for a route it has a record of, and in its own file alone", async () => {
    const dir = fresh("clawtrate-routes-");
    const routes = new RouteStore(dir);
    const base = memoryStorage();
    const storage = routedStorage(base, routes);
    const one = record();
    await expect(storage.set(tokenKey(one.key), '{"token":"t-1"}')).rejects.toThrow();
    routes.put(one);
    await storage.set(tokenKey(one.key), '{"token":"t-1"}');
    await storage.set("connection", '{"url":"ws://127.0.0.1:5000"}');
    expect(await storage.get(tokenKey(one.key))).toBe('{"token":"t-1"}');
    expect(readFileSync(routes.path, "utf8")).toContain("t-1");
    expect([...base.data.keys()]).toEqual(["connection"]);
    // A second write replaces the one token; there is never a second.
    await storage.set(tokenKey(one.key), '{"token":"t-2"}');
    expect(readFileSync(routes.path, "utf8")).not.toContain("t-1");
    // Another device's or role's key reads nothing.
    expect(await storage.get(`deviceToken:route:${one.key}:device-2:operator`)).toBeNull();
    // The routes file is this account's alone.
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(routes.path).mode & 0o077).toBe(0);
    }
  });

  it("a route whose key changed, another pinned key, port or profile, loses its token; removing a route removes its token", async () => {
    const dir = fresh("clawtrate-routes-");
    const routes = new RouteStore(dir);
    const storage = routedStorage(memoryStorage(), routes);
    const one = record();
    routes.put(one);
    await storage.set(tokenKey(one.key), '{"token":"t-1"}');
    // Kept when the same route is saved again.
    routes.put({ ...one, lastUsed: 2 });
    expect(await storage.get(tokenKey(one.key))).toBe('{"token":"t-1"}');
    const replaced = record({ fingerprint: `SHA256:${"B".repeat(43)}` });
    expect(replaced.key).not.toBe(one.key);
    routes.put(replaced);
    expect(await storage.get(tokenKey(one.key))).toBeNull();
    expect(await storage.get(tokenKey(replaced.key))).toBeNull();
    expect(readFileSync(routes.path, "utf8")).not.toContain("t-1");
    await storage.set(tokenKey(replaced.key), '{"token":"t-3"}');
    routes.remove(replaced.id);
    expect(routes.list()).toEqual([]);
    expect(readFileSync(routes.path, "utf8")).not.toContain("t-3");
    // The key never names a forward's local port: only the pinned key, endpoint, gateway port, profile.
    expect(record({ gatewayPort: 18790 }).key).not.toBe(one.key);
    expect(record({ profile: "clawtrate" }).key).not.toBe(one.key);
  });
});

describe.skipIf(process.platform === "win32")("the app-data privacy check", () => {
  it("accepts a private folder below private folders, and refuses a link, a folder others can write and a leaf others can read", () => {
    const root = fresh("clawtrate-private-");
    mkdirSync(join(root, "a", "ssh"), { recursive: true, mode: 0o700 });
    expect(establishPrivateDir(join(root, "a", "ssh"), { root })).toEqual({
      ok: true,
      verified: "posix",
    });
    // A link anywhere on the way.
    symlinkSync(join(root, "a"), join(root, "link"));
    expect(establishPrivateDir(join(root, "link", "ssh"), { root })).toMatchObject({
      ok: false,
      reason: "resolves-elsewhere",
    });
    // A folder above it that others can write, without the sticky bit.
    mkdirSync(join(root, "open", "ssh"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, "open"), 0o777);
    expect(establishPrivateDir(join(root, "open", "ssh"), { root })).toMatchObject({
      ok: false,
      reason: "writable-by-others",
    });
    // The sticky bit over a folder of this account's own is accepted, as /tmp is.
    chmodSync(join(root, "open"), 0o1777);
    expect(establishPrivateDir(join(root, "open", "ssh"), { root }).ok).toBe(true);
    // The leaf itself readable by others.
    mkdirSync(join(root, "loose"), { mode: 0o755 });
    expect(establishPrivateDir(join(root, "loose"), { root })).toMatchObject({
      ok: false,
      reason: "writable-by-others",
    });
    // Another account's folder, as seen by a different uid.
    expect(establishPrivateDir(join(root, "a", "ssh"), { root, uid: 4242 })).toMatchObject({
      ok: false,
      reason: "another-account",
    });
  });
});

const facts = (patch: Partial<LookFacts> = {}): LookFacts => ({
  system: { os: "Darwin", machine: "arm64", nodeName: "devbox" },
  program: "~/.openclaw/bin/openclaw",
  version: { year: 2026, month: 10, day: 6, build: "fe06181" },
  gateways: [],
  signs: {
    defaultState: true,
    defaultService: true,
    clawtrateState: false,
    clawtrateService: false,
  },
  ...patch,
});
const gateway = (patch: Record<string, unknown> = {}) => ({
  profile: "default" as const,
  exit: 0,
  service: { label: "LaunchAgent" as const, loaded: true, running: true, pid: 7 },
  configPath: "~/.openclaw/openclaw.json",
  port: 18789,
  bindMode: "loopback" as const,
  version: { year: 2026, month: 10, day: 6, build: null },
  rpcOk: true,
  listenerPids: [7],
  ...patch,
});

describe("what the found card says over SSH", () => {
  it("names only what the LOOK established: running, untested, too old, proven stopped, missing, not found", () => {
    expect(sshLook(facts({ gateways: [gateway()] })).look).toMatchObject({
      outcome: "running",
      version: "2026.10.6",
      profile: "default",
      listens: "loopback",
      service: "launchagent",
      port: 18789,
      authMode: null,
      others: [],
    });
    expect(
      sshLook(
        facts({ gateways: [gateway({ version: { year: 2026, month: 9, day: 37, build: null } })] }),
      ).look.outcome,
    ).toBe("untested");
    expect(
      sshLook(
        facts({ gateways: [gateway({ version: { year: 2026, month: 6, day: 2, build: null } })] }),
      ).look.outcome,
    ).toBe("too-old");
    const stopped = sshLook(
      facts({
        gateways: [
          gateway({
            service: { label: "LaunchAgent", loaded: true, running: false, pid: null },
            rpcOk: false,
            listenerPids: [],
          }),
        ],
      }),
    );
    expect(stopped.look).toMatchObject({ outcome: "stopped", service: "launchagent-stopped" });
    expect(stopped.stopped).toMatchObject({ profile: "default", port: 18789 });
    // Stopped, but something else holds the port: not proven stopped, so no Start.
    const held = sshLook(
      facts({
        gateways: [
          gateway({
            service: { label: "LaunchAgent", loaded: true, running: false, pid: null },
            listenerPids: [99],
          }),
        ],
      }),
    );
    expect(held.stopped).toBeNull();
    expect(held.look.outcome).toBe("cant-tell");
    expect(sshLook(facts({ program: null })).look.outcome).toBe("program-missing");
    expect(
      sshLook(
        facts({
          program: null,
          signs: {
            defaultState: false,
            defaultService: false,
            clawtrateState: false,
            clawtrateService: false,
          },
        }),
      ).look.outcome,
    ).toBe("not-found");
    // A listener that isn't the service's own process: Clawtrate can't tell, and offers no Connect.
    const foreign = sshLook(facts({ gateways: [gateway({ listenerPids: [7, 8] })] }));
    expect(foreign.found).toBeNull();
    expect(foreign.look.outcome).toBe("cant-tell");
  });
});

describe("the approve command for a route's computer and profile", () => {
  const instructions = approvalInstructionsFor(null, (url) =>
    url === "ws://127.0.0.1:50123"
      ? { route: "ssh", where: "devbox", profile: "default" }
      : url === "ws://127.0.0.1:50124"
        ? { route: "ssh", where: "devbox", profile: "clawtrate" }
        : url === "ws://127.0.0.1:18789"
          ? { route: "this-computer", where: "this computer", profile: "default" }
          : null,
  );
  const id = "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942";

  it("names the computer to run it on and the profile, for SSH and this computer; an address route keeps the general line", () => {
    expect(instructions("ws://127.0.0.1:50123", id)).toEqual({
      command: `openclaw devices approve ${id}`,
      note: "On devbox, approve this request for the default profile:",
    });
    expect(instructions("ws://127.0.0.1:50124", id)).toEqual({
      command: `openclaw --profile clawtrate devices approve ${id}`,
      note: "On devbox, approve this request for the clawtrate profile:",
    });
    expect(instructions("ws://127.0.0.1:18789", id)).toEqual({
      command: `openclaw devices approve ${id}`,
      note: "On this computer, approve this request for the default profile:",
    });
    expect(instructions("wss://gateway.example", id)).toEqual({
      command: `openclaw devices approve ${id}`,
      note: "The gateway's owner runs this on the machine where the gateway runs.",
    });
    expect(approvalForPlace({ route: "ssh", where: "devbox", profile: "default" }, "")).toEqual({
      command: "openclaw devices list",
      note: "On devbox, approve this device for the default profile from the requests this lists.",
    });
  });
});
