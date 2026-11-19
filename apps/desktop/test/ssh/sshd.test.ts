// The SSH transport against an sshd of the test's own (harness.ts): first
// contact and pin, the pinned key on the next connection, a key the person
// already trusts, a changed key reported and not replaced, the three failures,
// the LOOK under a hostile login environment, and the forward's life.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ForwardState } from "../../src/main/ssh/forward.ts";
import { type FoundService, serviceOnPort } from "../../src/main/ssh/look.ts";
import type { Spawn } from "../../src/main/ssh/run.ts";
import { defaultSpawn } from "../../src/main/ssh/run.ts";
import { forwardNote, type Route, SshTransport } from "../../src/main/ssh/transport.ts";
import {
  alive,
  assertSessionHome,
  httpGateway,
  httpGet,
  freePort,
  installStubOpenclaw,
  KEYGEN,
  keygen,
  makeWorld,
  SSH,
  sshdAvailability,
  startSshd,
  statusJson,
  tempDir,
  type TestSshd,
  type TestWorld,
  testEnv,
  waitFor,
} from "./harness.ts";

const availability = sshdAvailability();
const title = availability.ok
  ? "SSH transport against the test's own sshd"
  : `SSH transport against the test's own sshd (skipped: ${availability.reason})`;

/** Every program the transport starts, with its arguments and environment. */
type Started = {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  pid: number | undefined;
  /** The configuration file's text when the program started. */
  config: string | null;
};

const fingerprintOfFile = (path: string) =>
  execFileSync(KEYGEN, ["-lf", path], { env: testEnv(), encoding: "utf8" }).split(" ")[1]!;

describe.skipIf(!availability.ok)(title, { timeout: 60000 }, () => {
  let root: string;
  let t: TestWorld;
  let sshd: TestSshd;
  let transport: SshTransport;
  const started: Started[] = [];
  const recordingSpawn: Spawn = (file, args, env) => {
    const config = args[0] === "-F" && args[1] ? readFileSync(args[1], "utf8") : null;
    const child = defaultSpawn(file, args, env);
    started.push({ file, args, env, pid: child.pid, config });
    return child;
  };
  let stub: ReturnType<typeof installStubOpenclaw>;
  let gateway: Awaited<ReturnType<typeof httpGateway>>;
  let route: Route;

  const openForward = async (r: Route, found: FoundService) => {
    const opened = await transport.openForward(r, found);
    if (!opened.ok) throw new Error(`forward refused: ${opened.kind}`);
    return opened.forward;
  };

  const prepare = (id: string, typed: string): Route => {
    const result = transport.prepareRoute(id, typed);
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
    return result;
  };

  beforeAll(async () => {
    root = tempDir("clawtrate-ssh-it-");
    t = makeWorld(root);
    sshd = await startSshd(root, t.home, t.userKey);
    assertSessionHome(root, sshd, t.world, t.userKey);
    gateway = await httpGateway();
    stub = installStubOpenclaw(t.home);
    stub.setVersion("OpenClaw 2026.10.6 (fe06181)\n");
    stub.setStatus("default", statusJson({ port: gateway.port, home: t.home }));
    t.writeConfig(
      [
        "Host devbox",
        "  HostName 127.0.0.1",
        `  Port ${sshd.port}`,
        "  IdentityFile ~/.ssh/id_ed25519",
        "  IdentitiesOnly yes",
        "",
      ].join("\n"),
    );
    transport = new SshTransport(t.world, { spawn: recordingSpawn });
    route = prepare("one", "devbox");
  });

  afterAll(async () => {
    await transport?.closeAll();
    await sshd?.stop();
    await gateway?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("first contact: the key is captured without signing in, shown, and exactly those bytes are pinned", async () => {
    const startedBefore = started.length;
    const check = await transport.checkHostKey(route);
    expect(check.ok && check.state).toBe("first-contact");
    if (!check.ok || check.state !== "first-contact") return;
    expect(check.presented.label).toBe("ED25519");
    expect(check.presented.fingerprint).toBe(fingerprintOfFile(`${sshd.hostKey}.pub`));
    // Nothing is pinned before the caller confirms.
    expect(() => readFileSync(join(t.world.appDir, "known_hosts"), "utf8")).toThrow();
    // The probe offered no key, and the key was read from exactly one connection: one capture, no second read.
    const captures = started
      .slice(startedBefore)
      .filter((s) => s.config?.includes("  StrictHostKeyChecking accept-new\n"));
    expect(captures).toHaveLength(1);
    expect(captures[0]!.args).toContain("PreferredAuthentications=none");
    expect(captures[0]!.args).toContain("NumberOfPasswordPrompts=0");

    const pinned = transport.trustCapturedKey(route, check.presented.captureId);
    expect(pinned).toEqual({
      ok: true,
      label: "ED25519",
      fingerprint: check.presented.fingerprint,
    });
    const line = readFileSync(join(t.world.appDir, "known_hosts"), "utf8").trim();
    const [alias, type, key] = line.split(" ");
    const [hostType, hostKeyBytes] = readFileSync(`${sshd.hostKey}.pub`, "utf8").trim().split(" ");
    expect([alias, type, key]).toEqual([route.alias, hostType, hostKeyBytes]);
    // A capture is used once.
    expect(transport.trustCapturedKey(route, check.presented.captureId)).toEqual({
      ok: false,
      kind: "already-pinned",
    });
  });

  it("the pinned key is used on the next connection", async () => {
    const check = await transport.checkHostKey(route);
    expect(check).toMatchObject({
      ok: true,
      state: "pinned",
      fingerprint: fingerprintOfFile(`${sshd.hostKey}.pub`),
    });
  });

  it("the LOOK runs as /bin/sh -s through the pinned connection, and its facts are typed", async () => {
    const look = await transport.look(route);
    expect(look.ok).toBe(true);
    if (!look.ok) return;
    expect(look.facts.program).toBe("~/.openclaw/bin/openclaw");
    expect(look.facts.version).toEqual({ year: 2026, month: 10, day: 6, build: "fe06181" });
    expect(look.facts.system?.os).toMatch(/^(Darwin|Linux)$/);
    const found = serviceOnPort(look.facts, gateway.port);
    expect(found).toMatchObject({
      ok: true,
      holdsPort: true,
      service: { profile: "default", port: gateway.port },
    });
    const run = started.at(-1)!;
    expect(run.args.slice(-4)).toEqual(["--", route.alias, "/bin/sh", "-s"]);
  });

  it("the LOOK holds under a hostile login environment: start-up files that print, fake facts among them", async () => {
    const noise = [
      "echo 'Welcome to devbox'",
      `echo '{"k":"begin","id":"00000000-0000-0000-0000-000000000000"}'`,
      `echo '{"k":"program","i":1}'`,
      // By /dev/stderr: csh takes `>&2` for a file named 2, and a session starts in the account's own home.
      "echo 'noise on stderr' > /dev/stderr",
      "",
    ].join("\n");
    for (const file of [
      ".zshenv",
      ".bashrc",
      ".profile",
      ".bash_profile",
      ".cshrc",
      ".tcshrc",
      ".kshrc",
    ]) {
      writeFileSync(join(t.home, file), noise);
    }
    try {
      const look = await transport.look(route);
      expect(look.ok).toBe(true);
      if (look.ok) expect(look.facts.program).toBe("~/.openclaw/bin/openclaw");
    } finally {
      for (const file of [
        ".zshenv",
        ".bashrc",
        ".profile",
        ".bash_profile",
        ".cshrc",
        ".tcshrc",
        ".kshrc",
      ]) {
        rmSync(join(t.home, file), { force: true });
      }
    }
  });

  it("works from folders whose names have spaces and the other characters a profile name can have", async () => {
    const odd = join(root, "Jane O'Neil (Work) & Co, #1 é");
    const key = join(t.home, ".ssh", "Jane O'Neil key");
    copyFileSync(t.userKey, key);
    chmodSync(key, 0o600);
    copyFileSync(`${t.userKey}.pub`, `${key}.pub`);
    const before = readFileSync(t.world.personConfig, "utf8");
    t.writeConfig(
      `Host oddbox\n  HostName 127.0.0.1\n  Port ${sshd.port}\n  IdentityFile "~/.ssh/Jane O'Neil key"\n  IdentitiesOnly yes\n`,
    );
    const oddTransport = new SshTransport(
      { ...t.world, appDir: join(odd, "app") },
      { spawn: recordingSpawn },
    );
    try {
      const oddRoute = oddTransport.prepareRoute("odd", "oddbox");
      if (!oddRoute.ok) throw new Error(JSON.stringify(oddRoute));
      const check = await oddTransport.checkHostKey(oddRoute);
      expect(check).toMatchObject({ ok: true, state: "first-contact" });
      if (!check.ok || check.state !== "first-contact") return;
      expect(check.presented.fingerprint).toBe(fingerprintOfFile(`${sshd.hostKey}.pub`));
      // The key landed in the file the app read, inside the folder: nothing was written beside it.
      expect(readdirSync(odd)).toEqual(["app"]);
      expect(oddTransport.trustCapturedKey(oddRoute, check.presented.captureId).ok).toBe(true);
      expect(await oddTransport.checkHostKey(oddRoute)).toMatchObject({
        ok: true,
        state: "pinned",
      });
      expect((await oddTransport.look(oddRoute)).ok).toBe(true);
    } finally {
      await oddTransport.closeAll();
      t.writeConfig(before);
    }
  });

  it("a route is one endpoint: prepared again for another, its earlier objects, capture and pin don't carry over", async () => {
    const second = await startSshd(join(root, "second"), t.home, t.userKey);
    const before = readFileSync(t.world.personConfig, "utf8");
    const block = (port: number) =>
      `Host movebox\n  HostName 127.0.0.1\n  Port ${port}\n  IdentityFile ~/.ssh/id_ed25519\n  IdentitiesOnly yes\n`;
    try {
      t.writeConfig(block(sshd.port));
      const first = prepare("move", "movebox");
      const contact = await transport.checkHostKey(first);
      if (!contact.ok || contact.state !== "first-contact")
        throw new Error("expected first contact");
      expect(transport.trustCapturedKey(first, contact.presented.captureId).ok).toBe(true);
      // A capture of the first endpoint, waiting for a decision when the route moves.
      const firstConfig = transport.configPath(first);
      const pending = await transport.checkHostKey(prepare("move", "movebox"));
      expect(pending).toMatchObject({ ok: true, state: "pinned" });

      t.writeConfig(block(second.port));
      const moved = prepare("move", "movebox");
      expect(moved.alias).not.toBe(first.alias);
      expect(moved.endpoint).toBe(`${t.world.localUser}@[127.0.0.1]:${second.port}`);
      expect(transport.configPath(moved)).not.toBe(firstConfig);
      expect(existsSync(firstConfig)).toBe(false);
      // The earlier object is stale for every call.
      expect(await transport.look(first)).toEqual({ ok: false, kind: "stale-route" });
      expect(await transport.checkHostKey(first)).toEqual({ ok: false, kind: "stale-route" });
      expect(transport.trustCapturedKey(first, contact.presented.captureId)).toEqual({
        ok: false,
        kind: "stale-route",
      });
      // The new endpoint is not trusted by the old pin: it is first contact, with the second server's key.
      const fresh = await transport.checkHostKey(moved);
      expect(fresh).toMatchObject({
        ok: true,
        state: "first-contact",
        presented: { fingerprint: fingerprintOfFile(`${second.hostKey}.pub`) },
      });
      expect(await transport.look(moved)).toEqual({ ok: false, kind: "not-pinned" });
      // A capture made on the earlier preparation can't be used on this one.
      expect(transport.trustCapturedKey(moved, contact.presented.captureId)).toEqual({
        ok: false,
        kind: "no-such-capture",
      });
      if (!fresh.ok || fresh.state !== "first-contact") return;
      expect(transport.trustCapturedKey(moved, fresh.presented.captureId).ok).toBe(true);
      expect((await transport.look(moved)).ok).toBe(true);
      transport.forget(moved);
    } finally {
      await second.stop();
      t.writeConfig(before);
    }
  });

  it("a key the person already trusts is found by the resolved host and port and pinned without first contact", async () => {
    const [type, key] = readFileSync(`${sshd.hostKey}.pub`, "utf8").trim().split(" ");
    writeFileSync(
      t.world.personKnownHosts,
      `# the person's own\n[127.0.0.1]:${sshd.port} ${type} ${key}\n`,
    );
    try {
      const other = prepare("two", "devbox");
      const check = await transport.checkHostKey(other);
      expect(check).toMatchObject({ ok: true, state: "pinned-from-known-hosts", label: "ED25519" });
      const pinned = readFileSync(join(t.world.appDir, "known_hosts"), "utf8");
      expect(pinned).toContain(`${other.alias} ${type} ${key} `);
      // The person's file is unchanged.
      expect(readFileSync(t.world.personKnownHosts, "utf8")).toBe(
        `# the person's own\n[127.0.0.1]:${sshd.port} ${type} ${key}\n`,
      );
      transport.forget(other);
    } finally {
      rmSync(t.world.personKnownHosts, { force: true });
    }
  });

  it("pins an earlier hashed entry for another key type, and reports a rotation of several keys", async () => {
    const multi = await startSshd(join(root, "multi"), t.home, t.userKey);
    const before = readFileSync(t.world.personConfig, "utf8");
    try {
      const ecdsa = join(root, "multi", "sshd", "host_ecdsa");
      keygen(ecdsa, "ecdsa");
      await multi.stop();
      await multi.start(undefined, [ecdsa]);
      t.writeConfig(
        `Host multibox\n  HostName 127.0.0.1\n  Port ${multi.port}\n  IdentityFile ~/.ssh/id_ed25519\n  IdentitiesOnly yes\n`,
      );
      // The person trusts only the ECDSA key, in a hashed entry, as ssh-keygen -H writes it.
      const [type, key] = readFileSync(`${ecdsa}.pub`, "utf8").trim().split(" ");
      writeFileSync(t.world.personKnownHosts, `[127.0.0.1]:${multi.port} ${type} ${key}\n`);
      execFileSync(KEYGEN, ["-H", "-f", t.world.personKnownHosts], {
        env: testEnv(),
        stdio: "ignore",
      });
      rmSync(`${t.world.personKnownHosts}.old`, { force: true });
      expect(readFileSync(t.world.personKnownHosts, "utf8")).toMatch(/^\|1\|/);

      const route2 = prepare("multi", "multibox");
      const check = await transport.checkHostKey(route2);
      expect(check).toMatchObject({
        ok: true,
        state: "pinned-from-known-hosts",
        label: "ECDSA",
        fingerprint: fingerprintOfFile(`${ecdsa}.pub`),
      });
      expect(readFileSync(join(t.world.appDir, "known_hosts"), "utf8")).toContain(
        `${route2.alias} ${type} ${key} `,
      );
      expect((await transport.look(route2)).ok).toBe(true);

      // Both keys replaced: the change is reported, and what is presented is the key captured now.
      const newEd = join(root, "multi", "sshd", "host_ed25519_new");
      const newEcdsa = join(root, "multi", "sshd", "host_ecdsa_new");
      keygen(newEd);
      keygen(newEcdsa, "ecdsa");
      await multi.stop();
      await multi.start(newEd, [newEcdsa]);
      const changed = await transport.checkHostKey(route2);
      expect(changed.ok && changed.state).toBe("changed");
      if (!changed.ok || changed.state !== "changed") return;
      expect(changed.trusted).toMatchObject({
        label: "ECDSA",
        fingerprint: fingerprintOfFile(`${ecdsa}.pub`),
      });
      expect([fingerprintOfFile(`${newEd}.pub`), fingerprintOfFile(`${newEcdsa}.pub`)]).toContain(
        changed.presented.fingerprint,
      );
      expect(transport.replaceTrustedKey(route2, changed.presented.captureId)).toMatchObject({
        ok: true,
        fingerprint: changed.presented.fingerprint,
      });
      expect((await transport.look(route2)).ok).toBe(true);
      transport.forget(route2);
    } finally {
      rmSync(t.world.personKnownHosts, { force: true });
      await multi.stop();
      t.writeConfig(before);
    }
  });

  it("a certificate-authority line is never pinned: such a host goes through first contact", async () => {
    const [type, key] = readFileSync(`${sshd.hostKey}.pub`, "utf8").trim().split(" ");
    writeFileSync(
      t.world.personKnownHosts,
      `@cert-authority [127.0.0.1]:${sshd.port} ${type} ${key}\n`,
    );
    try {
      const other = prepare("three", "devbox");
      const check = await transport.checkHostKey(other);
      expect(check.ok && check.state).toBe("first-contact");
      transport.forget(other);
    } finally {
      rmSync(t.world.personKnownHosts, { force: true });
    }
  });

  it("each of the three failures is told apart, with fixed copy and nothing of ssh's output", async () => {
    // Cannot be reached: a loopback port where nothing listens.
    const closed = await freePort();
    t.writeConfig(
      [
        "Host devbox",
        "  HostName 127.0.0.1",
        `  Port ${sshd.port}`,
        "  IdentityFile ~/.ssh/id_ed25519",
        "  IdentitiesOnly yes",
        "Host nothing",
        "  HostName 127.0.0.1",
        `  Port ${closed}`,
        "Host stranger",
        "  HostName 127.0.0.1",
        `  Port ${sshd.port}`,
        "  IdentityFile ~/.ssh/other_ed25519",
        "  IdentitiesOnly yes",
        "",
      ].join("\n"),
    );
    const unreachable = await transport.checkHostKey(prepare("four", "nothing"));
    expect(unreachable).toMatchObject({
      ok: false,
      kind: "failed",
      failure: { kind: "unreachable", cause: "connection refused", exit: 255 },
      note: {
        title: `Can't reach ${t.world.localUser}@127.0.0.1`,
        sentence: `Nothing answered at 127.0.0.1, port ${closed} (connection refused).`,
      },
    });

    // Sign-in refused: a key the test's sshd doesn't know, on a route whose key is pinned.
    keygen(join(t.home, ".ssh", "other_ed25519"));
    const stranger = prepare("five", "stranger");
    const first = await transport.checkHostKey(stranger);
    if (!first.ok || first.state !== "first-contact") throw new Error("expected first contact");
    transport.trustCapturedKey(stranger, first.presented.captureId);
    const refused = await transport.look(stranger);
    expect(refused).toMatchObject({
      ok: false,
      kind: "failed",
      failure: { kind: "sign-in-refused", exit: 255 },
      note: { title: `${t.world.localUser}@127.0.0.1 didn't accept your key` },
    });

    // Host key not trusted: first contact is how it shows (above); a LOOK without a pin never runs.
    const unpinned = prepare("six", "devbox");
    expect(await transport.look(unpinned)).toEqual({ ok: false, kind: "not-pinned" });
    for (const r of [stranger, unpinned]) transport.forget(r);
  });

  it("a changed key is reported with both keys and is not replaced until the separate call", async () => {
    const before = readFileSync(join(t.world.appDir, "known_hosts"), "utf8");
    const oldPrint = fingerprintOfFile(`${sshd.hostKey}.pub`);
    const original = sshd.hostKey;
    const newKey = join(root, "sshd", "host_new_ed25519");
    keygen(newKey);
    await sshd.stop();
    await sshd.start(newKey);
    try {
      const look = await transport.look(route);
      expect(look).toMatchObject({
        ok: false,
        kind: "failed",
        failure: { kind: "host-key-changed" },
      });
      const check = await transport.checkHostKey(route);
      expect(check.ok && check.state).toBe("changed");
      if (!check.ok || check.state !== "changed") return;
      expect(check.trusted.fingerprint).toBe(oldPrint);
      expect(check.trusted.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(check.presented.fingerprint).toBe(fingerprintOfFile(`${newKey}.pub`));
      // Nothing changed by itself, and trusting is not replacing.
      expect(readFileSync(join(t.world.appDir, "known_hosts"), "utf8")).toBe(before);
      expect(transport.trustCapturedKey(route, check.presented.captureId)).toEqual({
        ok: false,
        kind: "already-pinned",
      });
      // The capture is still there for the explicit call.
      const replaced = transport.replaceTrustedKey(route, check.presented.captureId);
      expect(replaced).toMatchObject({ ok: true, fingerprint: check.presented.fingerprint });
      expect((await transport.look(route)).ok).toBe(true);
    } finally {
      // Back to the first key, pinned again by an explicit replacement.
      await sshd.stop();
      await sshd.start(original);
      const back = await transport.checkHostKey(route);
      if (back.ok && back.state === "changed")
        transport.replaceTrustedKey(route, back.presented.captureId);
    }
  });

  it("the forward comes up after the LOOK names the gateway, drops, comes back by itself, and closes leaving nothing", async () => {
    const look = await transport.look(route);
    if (!look.ok) throw new Error("look failed");
    const found = serviceOnPort(look.facts, gateway.port);
    if (!found.ok) throw new Error("no service");
    const forward = await openForward(route, found);
    const states: ForwardState[] = [];
    forward.onState((state) => states.push(state));
    const upNow = () => forward.state.phase === "up";
    await waitFor(upNow, 20000, "the forward to come up");
    const first = forward.state;
    if (first.phase !== "up") throw new Error();
    expect(first.restored).toBe(false);
    expect(await httpGet(first.localPort)).toBe(200);
    // The check before "up" was one plain request through the forward, with no credential.
    expect(gateway.requests[0]).toMatch(/^GET \/healthz /);
    expect(gateway.requests[0]).not.toMatch(/authorization|cookie|token/i);
    const forwardPid = started.findLast((s) => s.args.includes("-L"))!.pid!;

    // Dropped: the connection's session ends; the forward reports it and comes back by itself.
    const looksBefore = started.filter((s) => s.args.includes("/bin/sh")).length;
    await sshd.dropSessions();
    await waitFor(
      () => states.some((s) => s.phase === "waiting"),
      20000,
      "the drop to be reported",
    );
    expect(states.find((s) => s.phase === "waiting")).toMatchObject({
      cause: { kind: "dropped" },
      retryInMs: 1000,
    });
    expect(alive(forwardPid)).toBe(false);
    await waitFor(upNow, 20000, "the forward to come back");
    const again = forward.state;
    if (again.phase !== "up") throw new Error();
    expect(again.restored).toBe(true);
    // The LOOK ran again before the route was usable.
    expect(started.filter((s) => s.args.includes("/bin/sh")).length).toBe(looksBefore + 1);
    expect(states.slice(-2).map((s) => s.phase)).toEqual(["verifying", "up"]);
    expect(await httpGet(again.localPort)).toBe(200);

    // The computer stops answering: sshd is down; the forward waits with the cause, then comes back.
    await sshd.stop();
    await waitFor(
      () => forward.state.phase === "waiting" && forward.state.cause.kind === "unreachable",
      30000,
      "the outage to be reported",
    );
    await sshd.start();
    forward.retryNow();
    await waitFor(upNow, 30000, "the forward to come back after the outage");

    // Closing ends the process and nothing restarts it.
    await forward.close();
    expect(forward.state).toEqual({ phase: "closed", reason: "closed" });
    for (const s of started) if (s.pid) expect(alive(s.pid), `${s.args.join(" ")}`).toBe(false);
    expect(transport.processes.running.size).toBe(0);
  });

  it("a forward whose repeated LOOK names another gateway service on that port is closed", async () => {
    const look = await transport.look(route);
    if (!look.ok) throw new Error("look failed");
    const found = serviceOnPort(look.facts, gateway.port);
    if (!found.ok) throw new Error("no service");
    const forward = await openForward(route, found);
    await waitFor(() => forward.state.phase === "up", 20000, "the forward to come up");
    // Another gateway now answers on that port: another configuration behind it.
    stub.setStatus(
      "default",
      statusJson({ port: gateway.port, home: t.home, configPath: "/srv/other/openclaw.json" }),
    );
    try {
      await sshd.dropSessions();
      await waitFor(() => forward.state.phase === "closed", 20000, "the forward to close");
      expect(forward.state).toEqual({ phase: "closed", reason: "different-gateway" });
    } finally {
      stub.setStatus("default", statusJson({ port: gateway.port, home: t.home }));
    }
  });

  it("a forward whose gateway stopped is not reported usable, and waits for it", async () => {
    const look = await transport.look(route);
    if (!look.ok) throw new Error("look failed");
    const found = serviceOnPort(look.facts, gateway.port);
    if (!found.ok) throw new Error("no service");
    stub.setStatus(
      "default",
      statusJson({ port: gateway.port, home: t.home, running: false, rpcOk: false }),
    );
    const forward = await openForward(route, found);
    try {
      await waitFor(() => forward.state.phase === "waiting", 20000, "the forward to wait");
      expect(forward.state).toMatchObject({
        phase: "waiting",
        cause: { kind: "gateway-not-running" },
      });
      stub.setStatus("default", statusJson({ port: gateway.port, home: t.home }));
      forward.retryNow();
      await waitFor(() => forward.state.phase === "up", 20000, "the forward to come up");
    } finally {
      await forward.close();
    }
  });

  it("a server that refuses forwarding is its own state, and the forward is never up", async () => {
    const strict = await startSshd(join(root, "noforward"), t.home, t.userKey, {
      forwarding: "no",
    });
    const before = readFileSync(t.world.personConfig, "utf8");
    t.writeConfig(
      `Host strict\n  HostName 127.0.0.1\n  Port ${strict.port}\n  IdentityFile ~/.ssh/id_ed25519\n  IdentitiesOnly yes\n`,
    );
    try {
      const strictRoute = prepare("strict", "strict");
      const contact = await transport.checkHostKey(strictRoute);
      if (!contact.ok || contact.state !== "first-contact")
        throw new Error("expected first contact");
      transport.trustCapturedKey(strictRoute, contact.presented.captureId);
      const look = await transport.look(strictRoute);
      if (!look.ok) throw new Error("look failed");
      const found = serviceOnPort(look.facts, gateway.port);
      if (!found.ok) throw new Error("no service");
      const forward = await openForward(strictRoute, found);
      const states: ForwardState[] = [];
      forward.onState((state) => states.push(state));
      await waitFor(() => forward.state.phase === "waiting", 20000, "the refusal");
      expect(forward.state).toMatchObject({
        phase: "waiting",
        cause: { kind: "forwarding-refused" },
      });
      expect(states.some((s) => s.phase === "up")).toBe(false);
      expect(forwardNote({ kind: "forwarding-refused" }, strictRoute)).toEqual({
        title: "strict doesn't allow forwarding",
        sentence:
          "The SSH server on strict refused to open a connection to the gateway. Its sshd needs AllowTcpForwarding set to yes or local.",
      });
      await forward.close();
      transport.forget(strictRoute);
    } finally {
      await strict.stop();
      t.writeConfig(before);
    }
  });

  it("a key changed under a running forward stops it for good", async () => {
    const look = await transport.look(route);
    if (!look.ok) throw new Error("look failed");
    const found = serviceOnPort(look.facts, gateway.port);
    if (!found.ok) throw new Error("no service");
    const forward = await openForward(route, found);
    await waitFor(() => forward.state.phase === "up", 20000, "the forward to come up");
    const original = sshd.hostKey;
    const other = join(root, "sshd", "host_other_ed25519");
    keygen(other);
    await sshd.stop();
    await sshd.start(other);
    try {
      await waitFor(() => forward.state.phase === "waiting", 20000, "the drop");
      forward.retryNow();
      await waitFor(() => forward.state.phase === "closed", 20000, "the forward to stop");
      expect(forward.state).toEqual({ phase: "closed", reason: "key-changed" });
    } finally {
      await sshd.stop();
      await sshd.start(original);
    }
  });

  it("keeps one forward per route, and closeAll ends every process and LOOK it started", async () => {
    const look = await transport.look(route);
    if (!look.ok) throw new Error("look failed");
    const found = serviceOnPort(look.facts, gateway.port);
    if (!found.ok) throw new Error("no service");
    const forward = await openForward(route, found);
    expect(await transport.openForward(route, found)).toEqual({ ok: true, forward });
    expect(
      await transport.openForward(route, {
        ...found,
        service: { ...found.service, configPath: "/srv/other.json" },
      }),
    ).toEqual({ ok: false, kind: "forward-open" });
    // A LOOK and the forward in flight, and closeAll at once.
    const startedBefore = started.length;
    const inFlight = transport.look(route);
    let lookDone = false;
    void inFlight.then(() => (lookDone = true));
    await transport.closeAll();
    expect(lookDone).toBe(true);
    expect(forward.state).toEqual({ phase: "closed", reason: "closed" });
    expect(transport.processes.running.size).toBe(0);
    for (const s of started.slice(startedBefore))
      if (s.pid) expect(alive(s.pid), s.args.join(" ")).toBe(false);
    for (const s of started) if (s.pid) expect(alive(s.pid)).toBe(false);
    // The transport works again afterwards.
    expect((await transport.look(route)).ok).toBe(true);
  });

  it("every ssh ran with -F on the app's own file, no agent, and no SSH_AUTH_SOCK", () => {
    expect(started.length).toBeGreaterThan(10);
    for (const s of started) {
      expect(s.file).toBe(t.world.ssh);
      expect(s.env.SSH_AUTH_SOCK).toBeUndefined();
      if (s.args[0] === "-V") continue;
      expect(s.args[0]).toBe("-F");
      // A file the transport wrote in an app folder of this test's: a route's, or a capture's.
      expect(s.args[1]!.startsWith(`${root}/`), s.args[1]).toBe(true);
      expect(basename(s.args[1]!)).toMatch(/^(route|capture)-[^/]+\.conf$/);
      expect(s.config).toContain("  IdentityAgent none\n");
    }
  });

  it("every configuration it ran, read back by ssh -G, offers only the test's keys and no agent", () => {
    const texts = [...new Set(started.map((s) => s.config).filter((c): c is string => c !== null))];
    expect(texts.length).toBeGreaterThan(1);
    const realHomeSsh = join(userInfo().homedir, ".ssh");
    for (const [i, text] of texts.entries()) {
      const file = join(root, `readback-${i}.conf`);
      writeFileSync(file, text);
      const alias = /^Host (\S+)$/m.exec(text)![1]!;
      // `-G` reads the file and connects nowhere.
      const lines = execFileSync(SSH, ["-G", "-F", file, "--", alias], {
        env: testEnv(),
        encoding: "utf8",
      }).split("\n");
      const keys = lines.filter((line) => /^(identityfile|certificatefile) /.test(line));
      expect(keys.length, text).toBeGreaterThan(0);
      for (const line of keys) {
        const path = line.slice(line.indexOf(" ") + 1);
        expect(path === "none" || path.startsWith(`${t.home}/`), line).toBe(true);
      }
      expect(lines).toContain("identityagent none");
      expect(lines.filter((line) => line.includes("~/.ssh") || line.includes(realHomeSsh))).toEqual(
        [],
      );
    }
  });
});
