// The SSH transport against an sshd of the test's own (harness.ts): first
// contact and pin, the pinned key on the next connection, a key the person
// already trusts, a changed key reported and not replaced, the three failures,
// the LOOK under a hostile login environment, and the forward's life.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ForwardState } from "../../src/main/ssh/forward.ts";
import { serviceOnPort } from "../../src/main/ssh/look.ts";
import type { Spawn } from "../../src/main/ssh/run.ts";
import { defaultSpawn } from "../../src/main/ssh/run.ts";
import { type Route, SshTransport } from "../../src/main/ssh/transport.ts";
import {
  alive,
  assertSessionHome,
  echoServer,
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
  let gateway: Awaited<ReturnType<typeof echoServer>>;
  let route: Route;

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
    gateway = await echoServer();
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
    const check = await transport.checkHostKey(route);
    expect(check.ok && check.state).toBe("first-contact");
    if (!check.ok || check.state !== "first-contact") return;
    expect(check.presented.label).toBe("ED25519");
    expect(check.presented.fingerprint).toBe(fingerprintOfFile(`${sshd.hostKey}.pub`));
    // Nothing is pinned before the caller confirms.
    expect(() => readFileSync(join(t.world.appDir, "known_hosts"), "utf8")).toThrow();
    // The probe offered no key: the server saw no authentication attempt with one.
    const probe = started.at(-1)!;
    expect(probe.args).toContain("PreferredAuthentications=none");
    expect(probe.args).toContain("StrictHostKeyChecking=accept-new");

    const pinned = transport.trustCapturedKey(route, check.presented.captureId);
    expect(pinned).toEqual({
      ok: true,
      label: "ED25519",
      fingerprint: check.presented.fingerprint,
    });
    const line = readFileSync(join(t.world.appDir, "known_hosts"), "utf8").trim();
    const [alias, type, key] = line.split(" ");
    const [hostType, hostKeyBytes] = readFileSync(`${sshd.hostKey}.pub`, "utf8").trim().split(" ");
    expect([alias, type, key]).toEqual(["clawtrate-route-one", hostType, hostKeyBytes]);
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
    expect(run.args.slice(-4)).toEqual(["--", "clawtrate-route-one", "/bin/sh", "-s"]);
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
      expect(pinned).toContain(`clawtrate-route-two ${type} ${key} `);
      // The person's file is unchanged.
      expect(readFileSync(t.world.personKnownHosts, "utf8")).toBe(
        `# the person's own\n[127.0.0.1]:${sshd.port} ${type} ${key}\n`,
      );
      transport.forget(other);
    } finally {
      rmSync(t.world.personKnownHosts, { force: true });
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
    const forward = transport.openForward(route, gateway.port, found.service);
    const states: ForwardState[] = [];
    forward.onState((state) => states.push(state));
    const upNow = () => forward.state.phase === "up";
    await waitFor(upNow, 20000, "the forward to come up");
    const echo = async (port: number) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => socket.write("ping"));
        socket.setEncoding("utf8");
        socket.once("data", (data: string) => {
          socket.destroy();
          resolve(data);
        });
        socket.once("error", reject);
      });
    const first = forward.state;
    if (first.phase !== "up") throw new Error();
    expect(first.restored).toBe(false);
    expect(await echo(first.localPort)).toBe("ping");
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
    expect(await echo(again.localPort)).toBe("ping");

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
    const forward = transport.openForward(route, gateway.port, found.service);
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
    const forward = transport.openForward(route, gateway.port, found.service);
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

  it("a key changed under a running forward stops it for good", async () => {
    const look = await transport.look(route);
    if (!look.ok) throw new Error("look failed");
    const found = serviceOnPort(look.facts, gateway.port);
    if (!found.ok) throw new Error("no service");
    const forward = transport.openForward(route, gateway.port, found.service);
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

  it("every ssh ran with -F on the app's own file, no agent, and no SSH_AUTH_SOCK", () => {
    expect(started.length).toBeGreaterThan(10);
    for (const s of started) {
      expect(s.file).toBe(t.world.ssh);
      expect(s.env.SSH_AUTH_SOCK).toBeUndefined();
      if (s.args[0] === "-V") continue;
      expect(s.args[0]).toBe("-F");
      expect(s.args[1]!.startsWith(join(t.world.appDir, "route-"))).toBe(true);
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
