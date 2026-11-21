// "Another computer" as the host runs it (apps/desktop/src/setup/remote.ts),
// against an sshd of the test's own (harness.ts), a stand-in `openclaw` in the
// test's home, a loopback HTTP server for the gateway's port, and the core's
// fake gateway for the client's socket. Nothing of this machine's own SSH
// setup is read or used, and no OpenClaw program runs.

import { ClawtrateClient, type ClawtrateState, type SetupState } from "@clawtrate/core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FakeGateway,
  helloOk,
  memoryStorage,
  testHost,
  until,
} from "../../../../packages/core/test/fake-gateway.ts";
import { defaultSpawn, type Spawn } from "../../src/main/ssh/run.ts";
import { SshTransport } from "../../src/main/ssh/transport.ts";
import { SetupSlice } from "../../src/setup/host.ts";
import { afterPrivacyCheck } from "../../src/setup/private-dir.ts";
import { RemoteSetup, type HostAnswer, type HostQuestion } from "../../src/setup/remote.ts";
import { RouteStore, routedStorage } from "../../src/setup/routes.ts";
import { qrJson } from "../fixtures/openclaw-outputs.ts";
import {
  alive,
  assertSessionHome,
  freePort,
  httpGateway,
  installStubOpenclaw,
  KEYGEN,
  keygen,
  makeWorld,
  sshdAvailability,
  startSshd,
  statusJson,
  tempDir,
  testEnv,
  type TestSshd,
  type TestWorld,
} from "./harness.ts";

const availability = sshdAvailability();
const title = availability.ok
  ? "Another computer, the host's flow, against the test's own sshd"
  : `Another computer, the host's flow, against the test's own sshd (skipped: ${availability.reason})`;

const BOOTSTRAP = "B".repeat(43);
const DEVICE_TOKEN = "device-token-route-1";
const fingerprintOf = (pub: string) =>
  execFileSync(KEYGEN, ["-lf", pub], { env: testEnv(), encoding: "utf8" }).split(" ")[1]!;

describe.skipIf(!availability.ok)(title, { timeout: 90_000 }, () => {
  let root: string;
  let t: TestWorld;
  let sshd: TestSshd;
  let gateway: Awaited<ReturnType<typeof httpGateway>>;
  let stub: ReturnType<typeof installStubOpenclaw>;
  /** Every `ssh` the transports started, with its arguments. */
  const started: Array<{ args: readonly string[]; pid: number | undefined }> = [];
  const spawn: Spawn = (file, args, env) => {
    const child = defaultSpawn(file, args, env);
    started.push({ args, pid: child.pid });
    return child;
  };
  const made: Array<{ remote: RemoteSetup; transport: SshTransport }> = [];
  let count = 0;

  /** A fresh host: its own app folder, route store, client and fake gateway. */
  function host(
    options: {
      answer?: (question: HostQuestion) => HostAnswer;
      transport?: () => SshTransport | { refused: "app-files-unsafe" };
    } = {},
  ) {
    const dir = join(root, `host-${(count += 1)}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const world = { ...t.world, appDir: join(dir, "ssh") };
    const transport = new SshTransport(world, { spawn });
    const routes = new RouteStore(dir);
    const storage = memoryStorage();
    const fake = new FakeGateway();
    let identity = "gateway-identity-1";
    fake.handlers["gateway.identity.get"] = () => ({ deviceId: identity, publicKey: "key" });
    fake.connectReply = () => ({ ok: true, payload: helloOk(["operator.read"], DEVICE_TOKEN) });
    const host = testHost(fake);
    host.storage = routedStorage(storage, routes);
    const client = new ClawtrateClient(host, {
      reconnect: { initialMs: 50, maxMs: 200 },
    });
    const slice = new SetupSlice(client);
    const questions: HostQuestion[] = [];
    const states: SetupState[] = [];
    client.store.subscribe((state: ClawtrateState) => {
      if (state.setup) states.push(state.setup);
    });
    const remote = new RemoteSetup({
      client,
      transport: options.transport ?? (() => transport),
      routes,
      ask: async (question) => {
        questions.push(question);
        return options.answer?.(question) ?? { confirmed: true, checked: false };
      },
      publish: (next) => slice.setMain(next),
      publishRoute: (route) => slice.setRoute(route),
      restoredMs: 300,
      forwardWaitMs: 30_000,
    });
    made.push({ remote, transport });
    const setup = () => client.state.setup!;
    return {
      dir,
      world,
      transport,
      routes,
      storage,
      fake,
      client,
      remote,
      questions,
      states,
      setup,
      setIdentity: (next: string) => (identity = next),
      knownHosts: () =>
        existsSync(join(world.appDir, "known_hosts"))
          ? readFileSync(join(world.appDir, "known_hosts"), "utf8")
          : "",
    };
  }

  beforeAll(async () => {
    root = tempDir("clawtrate-ssh-route-");
    t = makeWorld(root);
    sshd = await startSshd(root, t.home, t.userKey);
    assertSessionHome(root, sshd, t.world, t.userKey);
    gateway = await httpGateway();
    stub = installStubOpenclaw(t.home);
    stub.setVersion("OpenClaw 2026.10.6 (fe06181)\n");
    stub.setStatus("default", statusJson({ port: gateway.port, home: t.home }));
    stub.setCode(
      "default",
      JSON.parse(qrJson(`ws://127.0.0.1:${gateway.port}`, BOOTSTRAP, Date.now() + 590_000)),
    );
    const closed = await freePort();
    keygen(join(t.home, ".ssh", "stranger"));
    t.writeConfig(
      [
        "Host devbox",
        "  HostName 127.0.0.1",
        `  Port ${sshd.port}`,
        `  User ${t.world.localUser}`,
        `  IdentityFile ${t.userKey}`,
        "  IdentitiesOnly yes",
        "Host jumpy",
        "  HostName 127.0.0.1",
        "  ProxyJump elsewhere",
        "Host commanding",
        "  HostName 127.0.0.1",
        "  RemoteCommand true",
        "Host forwarding",
        "  HostName 127.0.0.1",
        "  LocalForward 9999 127.0.0.1:9999",
        "Host keyed",
        "  HostName 127.0.0.1",
        "  StrictHostKeyChecking no",
        "Host nobody-home",
        "  HostName 127.0.0.1",
        `  Port ${closed}`,
        `  User ${t.world.localUser}`,
        `  IdentityFile ${t.userKey}`,
        "  IdentitiesOnly yes",
        "Host stranger",
        "  HostName 127.0.0.1",
        `  Port ${sshd.port}`,
        `  User ${t.world.localUser}`,
        `  IdentityFile ${join(t.home, ".ssh", "stranger")}`,
        "  IdentitiesOnly yes",
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    for (const each of made) {
      await each.remote.closeAll();
      await each.transport.closeAll();
    }
    await gateway?.close();
    await sshd?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Looks on devbox and trusts its key at first contact, ending on the found card. */
  async function lookOnDevbox(h: ReturnType<typeof host>) {
    await h.remote.there("devbox");
    if (h.setup().phase === "key") await h.remote.trustKey();
    expect(h.setup().phase).toBe("found");
  }

  it("F-495: a host whose settings use a jump host, a command, a forward or host-key settings is refused by name before anything connects", async () => {
    const h = host();
    const before = started.length;
    for (const [name, setting, category] of [
      ["jumpy", "ProxyJump", "jump-host"],
      ["commanding", "RemoteCommand", "command-or-forward"],
      ["forwarding", "LocalForward", "command-or-forward"],
      ["keyed", "StrictHostKeyChecking", "host-key"],
    ] as const) {
      await h.remote.there(name);
      const there = h.setup().there!;
      expect(there.refusal).toMatchObject({ setting, category });
      expect(there.refusal!.title).toContain(name);
      expect(h.setup().phase).toBe("idle");
    }
    await h.remote.there("-oProxyCommand=touch");
    expect(h.setup().there!.invalid).toBe(true);
    // Nothing connected and nothing was asked.
    expect(started.length).toBe(before);
    expect(h.questions).toEqual([]);
  });

  it("F-495: the full account is confirmed in the host's dialog before anything runs there; Cancel runs nothing", async () => {
    const h = host({ answer: () => ({ confirmed: false, checked: false }) });
    const before = started.length;
    await h.remote.there("devbox");
    expect(h.questions).toEqual([
      {
        message: `Look for OpenClaw as ${t.world.localUser}@127.0.0.1, port ${sshd.port}?`,
        detail: "This uses the remote account's SSH login environment.",
        confirm: "Look",
      },
    ]);
    expect(started.length).toBe(before);
    // Back on the field, with what was typed still there.
    expect(h.setup().phase).toBe("idle");
    expect(h.setup().there?.destination).toBe("devbox");
  });

  it("F-495: a first contact's key is captured without signing in, shown, and pinned only after the host's own dialog, as one act", async () => {
    let trust = false;
    const h = host({
      answer: (question) => ({
        confirmed: question.confirm === "Trust" ? trust : true,
        checked: false,
      }),
    });
    await h.remote.there("devbox");
    const key = h.setup().there!.key!;
    expect(h.setup().phase).toBe("key");
    expect(key.state).toBe("first-contact");
    expect(key.presented.fingerprint).toBe(fingerprintOf(`${sshd.hostKey}.pub`));
    // The capture offered no credentials: none of its runs named a key or a session.
    expect(h.knownHosts()).toBe("");
    await h.remote.trustKey();
    expect(h.questions.at(-1)).toMatchObject({
      message: "Trust devbox's key?",
      confirm: "Trust",
    });
    expect(h.questions.at(-1)!.detail).toContain(key.presented.fingerprint);
    expect(h.knownHosts()).toBe("");
    expect(h.setup().phase).toBe("key");
    trust = true;
    await h.remote.trustKey();
    expect(h.knownHosts()).toContain(readFileSync(`${sshd.hostKey}.pub`, "utf8").split(" ")[1]!);
    expect(h.setup().phase).toBe("found");
    expect(h.setup().look).toMatchObject({
      outcome: "running",
      version: "2026.10.6",
      profile: "default",
      listens: "loopback",
      service: "launchagent",
      access: "new",
    });
  });

  it("F-495: a key the person already trusts is pinned without being asked again", async () => {
    const h = host();
    const pub = readFileSync(`${sshd.hostKey}.pub`, "utf8").trim().split(" ");
    writeFileSync(t.world.personKnownHosts, `[127.0.0.1]:${sshd.port} ${pub[0]} ${pub[1]}\n`);
    try {
      await h.remote.there("devbox");
      expect(h.setup().phase).toBe("found");
      expect(h.questions.map((q) => q.confirm)).toEqual(["Look"]);
      expect(h.knownHosts()).toContain(pub[1]);
    } finally {
      rmSync(t.world.personKnownHosts, { force: true });
    }
  });

  it("F-495: a changed key is shown beside the trusted one and replaced only through the host's dialog, after its box is ticked", async () => {
    let tick = false;
    const h = host({
      answer: (question) => ({ confirmed: true, checked: question.checkbox ? tick : false }),
    });
    await lookOnDevbox(h);
    const trusted = fingerprintOf(`${sshd.hostKey}.pub`);
    const old = sshd.hostKey;
    const fresh = join(root, `host-key-${count}`);
    keygen(fresh);
    await sshd.stop();
    await sshd.start(fresh);
    try {
      await h.remote.there("devbox");
      const key = h.setup().there!.key!;
      expect(h.setup().phase).toBe("key");
      expect(key.state).toBe("changed");
      expect(key.trusted!.fingerprint).toBe(trusted);
      expect(key.presented.fingerprint).toBe(fingerprintOf(`${fresh}.pub`));
      const pinned = h.knownHosts();
      await h.remote.replaceKey();
      expect(h.questions.at(-1)).toMatchObject({
        message: "Replace devbox's trusted key?",
        checkbox: "I checked the new key on devbox itself",
      });
      // Confirmed without the box: nothing replaced.
      expect(h.knownHosts()).toBe(pinned);
      expect(h.setup().phase).toBe("key");
      tick = true;
      await h.remote.replaceKey();
      expect(h.knownHosts()).toContain(readFileSync(`${fresh}.pub`, "utf8").split(" ")[1]!);
      expect(h.setup().phase).toBe("found");
    } finally {
      await sshd.stop();
      await sshd.start(old);
    }
  });

  it("F-495: a failure says which it was: cannot be reached, or sign-in refused", async () => {
    const h = host();
    await h.remote.there("nobody-home");
    expect(h.setup().phase).toBe("failed");
    expect(h.setup().there!.failure).toMatchObject({
      kind: "unreachable",
      cause: "connection refused",
    });
    const s = host();
    await s.remote.there("stranger");
    if (s.setup().phase === "key") await s.remote.trustKey();
    expect(s.setup().phase).toBe("failed");
    expect(s.setup().there!.failure).toMatchObject({ kind: "sign-in-refused" });
  });

  it("F-496 F-494: Connect makes a --voice-node code there through the pinned connection, forwards a free local port and pairs read-only, with nothing typed and the token kept only in the route store", async () => {
    const h = host();
    await lookOnDevbox(h);
    const calls = stub.calls().length;
    const before = started.length;
    await h.remote.connect();
    expect(h.questions.at(-1)).toMatchObject({
      message: `Pair this device read-only with the default gateway on ${t.world.localUser}@127.0.0.1?`,
      confirm: "Pair",
    });
    await until(() => h.setup().phase === "done", 30_000);
    // On the other computer: the one fixed command, for the profile and port the look found.
    expect(stub.calls().slice(calls)).toContain(
      `qr --json --voice-node --url ws://127.0.0.1:${gateway.port}`,
    );
    // The remote command is always the constant `/bin/sh -s`; the forward has no command at all.
    for (const run of started.slice(before)) {
      const alias = run.args.indexOf("--");
      if (alias === -1) continue;
      expect(run.args.slice(alias + 2)).toEqual(
        run.args.includes("-L") || run.args.includes("-N") ? [] : ["/bin/sh", "-s"],
      );
    }
    const forward = started.slice(before).find((run) => run.args.includes("-L"))!;
    const spec = forward.args[forward.args.indexOf("-L") + 1]!;
    const local = Number(spec.split(":")[1]);
    expect(spec).toBe(`127.0.0.1:${local}:127.0.0.1:${gateway.port}`);
    expect(local).not.toBe(gateway.port);
    // The client connected through the forward, with the code, for read alone.
    const connect = h.fake.connects.at(-1) as {
      scopes: string[];
      auth?: { bootstrapToken?: string; token?: string };
    };
    expect(h.fake.sockets.at(-1)!.url).toBe(`ws://127.0.0.1:${local}`);
    expect(connect.scopes).toEqual(["operator.read"]);
    expect(connect.auth?.bootstrapToken).toBe(BOOTSTRAP);
    expect(h.client.state.connection).toMatchObject({
      status: "connected",
      scopes: ["operator.read"],
    });
    // The device token is in the route store, under the route, and nowhere else.
    const routes = readFileSync(h.routes.path, "utf8");
    expect(routes).toContain(DEVICE_TOKEN);
    expect([...h.storage.data.values()].join("\n")).not.toContain(DEVICE_TOKEN);
    expect([...h.storage.data.keys()].some((key) => key.startsWith("deviceToken"))).toBe(false);
    // The one-time code went nowhere: not the store, the state, the app's SSH files.
    expect(routes).not.toContain(BOOTSTRAP);
    expect(JSON.stringify(h.client.state)).not.toContain(BOOTSTRAP);
    expect([...h.storage.data.values()].join("\n")).not.toContain(BOOTSTRAP);
    expect(h.knownHosts()).not.toContain(BOOTSTRAP);
    // The route's record names what identifies it, never the forward's local port.
    const [record] = h.routes.list();
    expect(record).toMatchObject({
      destination: "devbox",
      gatewayPort: gateway.port,
      profile: "default",
      identity: "gateway-identity-1",
    });
    expect(JSON.stringify(record)).not.toContain(String(local));
    expect(h.client.state.setup!.route).toMatchObject({ name: "devbox", phase: "up" });
    await h.remote.closeAll();
  });

  it("F-496: a grant other than exactly read writes no token and lets the route go", async () => {
    const h = host();
    h.fake.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read", "operator.write"], DEVICE_TOKEN),
    });
    await lookOnDevbox(h);
    await h.remote.connect();
    await until(() => h.setup().phase === "failed", 30_000);
    expect(h.setup().failure?.kind).toBe("grant");
    await until(() => h.routes.list().length === 0, 5_000);
    expect(existsSync(h.routes.path) ? readFileSync(h.routes.path, "utf8") : "").not.toContain(
      DEVICE_TOKEN,
    );
  });

  it("F-498: a forward that drops comes back by itself, and the status strip says it is being restored, then back", async () => {
    const h = host();
    await lookOnDevbox(h);
    await h.remote.connect();
    await until(() => h.setup().phase === "done", 30_000);
    const sockets = h.fake.sockets.length;
    const phases: string[] = [];
    h.client.store.subscribe((state) => {
      const phase = state.setup?.route?.phase;
      if (phase && phases.at(-1) !== phase) phases.push(phase);
    });
    await sshd.dropSessions();
    await until(() => phases.includes("restoring"), 15_000);
    await until(
      () => h.client.state.setup?.route?.phase === "up" && phases.includes("restored"),
      30_000,
    );
    expect(phases).toEqual(["up", "restoring", "restored", "up"]);
    await until(() => h.client.state.connection.status === "connected", 10_000);
    // Back over the route's own token, through the new forward, and only there.
    const connect = h.fake.connects.at(-1) as {
      auth?: { bootstrapToken?: string; deviceToken?: string };
    };
    expect(connect.auth?.bootstrapToken).toBeUndefined();
    expect(JSON.stringify(connect.auth)).toContain(DEVICE_TOKEN);
    expect(h.fake.sockets.length).toBeGreaterThan(sockets);
    await h.remote.closeAll();
  });

  it("F-499: removing the route closes its forward, forgets its pin and token, and leaves the gateway it didn't start running", async () => {
    const h = host();
    await lookOnDevbox(h);
    const before = started.length;
    await h.remote.connect();
    await until(() => h.setup().phase === "done", 30_000);
    const forward = started.slice(before).find((run) => run.args.includes("-L"))!;
    expect(alive(forward.pid!)).toBe(true);
    const calls = stub.calls().length;
    await h.remote.removeRoute();
    expect(h.questions.at(-1)).toEqual({
      message: "Remove devbox from Clawtrate?",
      detail:
        "Clawtrate disconnects, forgets this route and its pinned key, and leaves OpenClaw on devbox running.",
      confirm: "Remove",
    });
    expect(alive(forward.pid!)).toBe(false);
    expect(h.knownHosts()).toBe("");
    expect(h.routes.list()).toEqual([]);
    expect(readFileSync(h.routes.path, "utf8")).not.toContain(DEVICE_TOKEN);
    expect(stub.calls().slice(calls)).not.toContain("gateway stop");
    expect(h.client.state.connection.status).toBe("idle");
    expect(h.client.state.setup!.route).toBeNull();
  });

  it("F-497 F-499: a gateway proven stopped there is started only after the host's dialog, and Remove stops it only when Clawtrate started it and the box is ticked", async () => {
    let start = false;
    let stopIt = true;
    const h = host({
      answer: (question) => ({
        confirmed: question.confirm === "Start" ? start : true,
        checked: question.checkbox ? stopIt : false,
      }),
    });
    stub.setStatus(
      "default",
      statusJson({ port: gateway.port, home: t.home, running: false, rpcOk: false }),
    );
    const status = statusJson({
      port: gateway.port,
      home: t.home,
      running: false,
      rpcOk: false,
    }) as {
      port: { listeners: unknown[] };
    };
    status.port.listeners = [];
    stub.setStatus("default", status);
    try {
      await lookOnDevbox(h);
      expect(h.setup().look).toMatchObject({ outcome: "stopped", profile: "default" });
      const calls = stub.calls().length;
      await h.remote.start();
      expect(h.questions.at(-1)).toMatchObject({
        message: "Start OpenClaw on devbox?",
        confirm: "Start",
      });
      expect(stub.calls().slice(calls)).not.toContain("gateway start");
      start = true;
      // The gateway answers once started.
      const starting = h.remote.start();
      await until(() => stub.calls().includes("gateway start"), 20_000);
      stub.setStatus("default", statusJson({ port: gateway.port, home: t.home }));
      await starting;
      expect(h.setup().look).toMatchObject({ outcome: "running" });
      await h.remote.connect();
      await until(() => h.setup().phase === "done", 30_000);
      expect(h.client.state.setup!.route!.startedByClawtrate).toBe(true);
      const before = stub.calls().length;
      await h.remote.removeRoute();
      expect(h.questions.at(-1)!.checkbox).toBe(
        "Also stop OpenClaw on devbox (Clawtrate started it).",
      );
      expect(stub.calls().slice(before)).toContain("gateway stop");
    } finally {
      stub.setStatus("default", statusJson({ port: gateway.port, home: t.home }));
    }
    // Unticked, nothing is stopped.
    stopIt = false;
    const g = host({
      answer: (question) => ({ confirmed: true, checked: question.checkbox ? stopIt : false }),
    });
    await lookOnDevbox(g);
    await g.remote.connect();
    await until(() => g.setup().phase === "done", 30_000);
    const before = stub.calls().length;
    await g.remote.removeRoute();
    expect(g.questions.at(-1)!.checkbox).toBeUndefined();
    expect(stub.calls().slice(before)).not.toContain("gateway stop");
  });

  it("a route whose gateway reports another identity after a restore is disconnected and its token dropped", async () => {
    const h = host();
    await lookOnDevbox(h);
    await h.remote.connect();
    await until(() => h.setup().phase === "done", 30_000);
    h.setIdentity("gateway-identity-2");
    await sshd.dropSessions();
    await until(() => h.client.state.setup?.route?.phase === "different-gateway", 30_000);
    expect(readFileSync(h.routes.path, "utf8")).not.toContain(DEVICE_TOKEN);
    expect(h.client.state.connection.status).not.toBe("connected");
    await h.remote.closeAll();
  });

  it("before the setup host makes a transport, its app-data folder must be private: one whose parent resolves outside a private, synthetic root goes to Advanced, and no transport is made", async () => {
    const synthetic = tempDir("clawtrate-private-root-");
    const outside = tempDir("clawtrate-outside-");
    try {
      mkdirSync(join(outside, "data", "ssh"), { recursive: true, mode: 0o700 });
      symlinkSync(join(outside, "data"), join(synthetic, "data"));
      let makes = 0;
      const factory = () =>
        afterPrivacyCheck(
          join(synthetic, "data", "ssh"),
          () => {
            makes += 1;
            return new SshTransport(
              { ...t.world, appDir: join(synthetic, "data", "ssh") },
              { spawn },
            );
          },
          { root: synthetic },
        );
      const h = host({ transport: factory });
      const before = started.length;
      await h.remote.there("devbox");
      expect(h.setup().phase).toBe("failed");
      expect(h.setup().there!.failure).toMatchObject({ kind: "app-files-unsafe" });
      expect(makes).toBe(0);
      expect(started.length).toBe(before);
      expect(h.questions).toEqual([]);
      // The same folder, inside the root and private, is accepted.
      mkdirSync(join(synthetic, "real", "ssh"), { recursive: true, mode: 0o700 });
      expect(
        afterPrivacyCheck(join(synthetic, "real", "ssh"), () => "made", { root: synthetic }),
      ).toBe("made");
    } finally {
      rmSync(synthetic, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
