// "Another computer" as the host runs it (apps/desktop/src/setup/remote.ts),
// against an sshd of the test's own (harness.ts), a stand-in `openclaw` in the
// test's home, a loopback HTTP server for the gateway's port, and the core's
// fake gateway for the client's socket. Nothing of this machine's own SSH
// setup is read or used, and no OpenClaw program runs.
//
// The test's alias, "devbox", resolves to 127.0.0.1 on the sshd's own port,
// which is never 22: every prompt and title is checked to name the account as
// resolved and that SSH port, never the alias alone.

import { ClawtrateClient, type ClawtrateState, type SetupState } from "@clawtrate/core";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FakeGateway,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  until,
} from "../../../../packages/core/test/fake-gateway.ts";
import { defaultSpawn, type Spawn } from "../../src/main/ssh/run.ts";
import { SshTransport } from "../../src/main/ssh/transport.ts";
import { SetupSlice } from "../../src/setup/host.ts";
import { sshTransportFor } from "../../src/setup/private-dir.ts";
import {
  isChannelUrl,
  RemoteSetup,
  type HostAnswer,
  type HostQuestion,
} from "../../src/setup/remote.ts";
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
  testSeal,
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

describe.skipIf(!availability.ok)(title, { timeout: 120_000 }, () => {
  let root: string;
  let t: TestWorld;
  let sshd: TestSshd;
  let gateway: Awaited<ReturnType<typeof httpGateway>>;
  let stub: ReturnType<typeof installStubOpenclaw>;
  /** "you@127.0.0.1 (SSH port N)": the alias "devbox", as resolved. */
  let account: string;
  /** Every `ssh` the transports started, with its arguments. */
  const started: Array<{ args: readonly string[]; pid: number | undefined }> = [];
  /** Told of every `ssh` as it starts, for a case that acts at a moment of the flow. */
  let onSpawn: ((args: readonly string[]) => void) | null = null;
  const spawn: Spawn = (file, args, env) => {
    onSpawn?.(args);
    const child = defaultSpawn(file, args, env);
    started.push({ args, pid: child.pid });
    return child;
  };
  const made: Array<{ remote: RemoteSetup; transport: SshTransport }> = [];
  let count = 0;

  /** A fresh host: its own app folder, route store, client and fake gateway. */
  function host(
    options: {
      answer?: (question: HostQuestion) => HostAnswer | Promise<HostAnswer>;
      transport?: () => SshTransport | { refused: "app-files-unsafe" | "not-supported" };
      dir?: string;
      now?: () => number;
      /** The client's store, kept across a restart of the same host folder. */
      storage?: ReturnType<typeof memoryStorage>;
      identity?: string;
      /** Whether OpenClaw there may run, asked before each script: the test's stand-in by default. */
      launcher?: () => boolean;
    } = {},
  ) {
    const dir = options.dir ?? join(root, `host-${(count += 1)}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const world = {
      ...t.world,
      appDir: join(dir, "ssh"),
      ...(options.launcher ? { launcher: options.launcher } : {}),
    };
    const transport = new SshTransport(world, { spawn });
    let remote: RemoteSetup | null = null;
    const routes = new RouteStore(dir, {
      seal: testSeal,
      onEvict: (record) => remote?.forgetEvicted(record),
    });
    const storage = options.storage ?? memoryStorage();
    const fake = new FakeGateway();
    let identity = options.identity ?? "gateway-identity-1";
    fake.handlers["gateway.identity.get"] = () => ({ deviceId: identity, publicKey: "key" });
    fake.connectReply = () => ({ ok: true, payload: helloOk(["operator.read"], DEVICE_TOKEN) });
    const testing = testHost(fake);
    testing.storage = routedStorage(storage, routes);
    // As the app: a channel's address only while it is current, and Reconnect through the host.
    const client = new ClawtrateClient(testing, {
      reconnect: { initialMs: 50, maxMs: 200 },
      allowGatewayUrl: (url) => remote?.allows(url) ?? true,
      reopenRoute: async (route) => remote?.reopen(route),
    });
    const slice = new SetupSlice(client);
    const questions: HostQuestion[] = [];
    const states: SetupState[] = [];
    client.store.subscribe((state: ClawtrateState) => {
      if (state.setup) states.push(state.setup);
    });
    remote = new RemoteSetup({
      client,
      transport: options.transport ?? (() => transport),
      routes,
      ask: async (question) => {
        questions.push(question);
        return (await options.answer?.(question)) ?? { confirmed: true, checked: false };
      },
      publish: (next) => slice.setMain(next),
      publishRoute: (route) => slice.setRoute(route),
      restoredMs: 300,
      forwardWaitMs: 30_000,
      ...(options.now ? { now: options.now } : {}),
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
      pins: () =>
        (existsSync(join(world.appDir, "known_hosts"))
          ? readFileSync(join(world.appDir, "known_hosts"), "utf8")
          : ""
        )
          .split("\n")
          .filter((line) => line.trim() !== "" && !line.startsWith("#")),
    };
  }

  const running = () => statusJson({ port: gateway.port, home: t.home });

  beforeAll(async () => {
    root = tempDir("clawtrate-ssh-route-");
    t = makeWorld(root);
    sshd = await startSshd(root, t.home, t.userKey);
    assertSessionHome(root, sshd, t.world, t.userKey);
    account = `${t.world.localUser}@127.0.0.1 (SSH port ${sshd.port})`;
    expect(sshd.port).not.toBe(22);
    gateway = await httpGateway();
    stub = installStubOpenclaw(t.home);
    stub.setVersion("OpenClaw 2026.10.6 (fe06181)\n");
    stub.setStatus("default", running());
    stub.setCode(
      "default",
      JSON.parse(qrJson(`ws://127.0.0.1:${gateway.port}`, BOOTSTRAP, Date.now() + 590_000)),
    );
    const closed = await freePort();
    keygen(join(t.home, ".ssh", "stranger"));
    t.writeConfig(
      [
        "Host devbox devbox-again",
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
        "Host algorithms",
        "  HostName 127.0.0.1",
        "  HostKeyAlgorithms ssh-rsa",
        "Host nobody-home",
        "  HostName 127.0.0.1",
        `  Port ${closed}`,
        `  User ${t.world.localUser}`,
        `  IdentityFile ${t.userKey}`,
        "  IdentitiesOnly yes",
        "Host devbox-local",
        "  HostName localhost",
        `  Port ${sshd.port}`,
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
  async function lookOnDevbox(h: ReturnType<typeof host>, destination = "devbox") {
    await h.remote.there(destination);
    if (h.setup().phase === "key") await h.remote.trustKey();
    expect(h.setup().phase, JSON.stringify(h.setup().there?.failure)).toBe("found");
  }

  /** Looks, connects and waits until the route is the app's. */
  async function connected(h: ReturnType<typeof host>) {
    await lookOnDevbox(h);
    await h.remote.connect();
    await until(() => h.setup().phase === "done", 30_000);
    await until(() => h.setup().route?.phase === "up", 10_000);
  }

  it("F-495: a host whose settings use a jump host, a command, a forward or host-key settings is refused by naming the setting before anything connects", async () => {
    const h = host();
    const before = started.length;
    for (const [name, setting, category, heading] of [
      ["jumpy", "ProxyJump", "jump-host", "The SSH settings for jumpy include ProxyJump."],
      [
        "commanding",
        "RemoteCommand",
        "command-or-forward",
        "Clawtrate can't use RemoteCommand in the SSH settings for commanding.",
      ],
      [
        "forwarding",
        "LocalForward",
        "command-or-forward",
        "Clawtrate can't use LocalForward in the SSH settings for forwarding.",
      ],
      [
        "keyed",
        "StrictHostKeyChecking",
        "host-key",
        "Clawtrate can't use StrictHostKeyChecking in the SSH settings for keyed.",
      ],
      [
        "algorithms",
        "HostKeyAlgorithms",
        "host-key",
        "Clawtrate can't use HostKeyAlgorithms in the SSH settings for algorithms.",
      ],
    ] as const) {
      await h.remote.there(name);
      const there = h.setup().there!;
      expect(there.refusal).toMatchObject({ setting, category, title: heading });
      expect(h.setup().phase).toBe("idle");
    }
    await h.remote.there("-oProxyCommand=touch");
    expect(h.setup().there!.invalid).toBe(true);
    // Nothing connected and nothing was asked.
    expect(started.length).toBe(before);
    expect(h.questions).toEqual([]);
  });

  it("F-495: every routing, trust and sign-in setting outside the subset is refused by name, directly, in a matched Include, a nested one and in any case, with no ssh started", async () => {
    // A configuration of its own: a refused global Include refuses every host in its file.
    const own = makeWorld(join(root, "config-matrix"));
    const ownTransport = new SshTransport(own.world, { spawn });
    const h = host({
      transport: () => ownTransport,
      answer: () => ({ confirmed: false, checked: false }),
    });
    const dotSsh = join(own.home, ".ssh");
    mkdirSync(join(dotSsh, "conf.d"), { recursive: true });
    writeFileSync(
      join(dotSsh, "conf.d", "a.conf"),
      "Host matched\n  HostName 127.0.0.1\n  HashKnownHosts yes\n",
    );
    writeFileSync(join(dotSsh, "conf.d", "b.conf"), "Include ~/.ssh/deeper.conf\n");
    writeFileSync(
      join(dotSsh, "deeper.conf"),
      "Host nested\n  HostName 127.0.0.1\n  Ciphers aes128-ctr\n",
    );
    // Matched as spelt: `*.conf` doesn't name this file, so its block doesn't apply.
    writeFileSync(join(dotSsh, "conf.d", "UPPER.CONF"), "Host upper\n  ProxyJump elsewhere\n");
    own.writeConfig(
      [
        "Include conf.d/*.conf",
        "Host directed",
        "  HostName 127.0.0.1",
        "  kExAlGoRiThMs curve25519-sha256",
        "Host trusted-x",
        "  HostName 127.0.0.1",
        "  ForwardX11Trusted yes",
        "Host macs",
        "  HostName 127.0.0.1",
        "  MACs hmac-sha2-256",
        "Host keychained",
        "  HostName 127.0.0.1",
        "  UseKeychain yes",
        "  AddKeysToAgent yes",
        "  BatchMode yes",
        "",
      ].join("\n"),
    );
    const before = started.length;
    for (const [name, setting, category] of [
      ["directed", "KexAlgorithms", "host-key"],
      ["matched", "HashKnownHosts", "host-key"],
      ["nested", "Ciphers", "host-key"],
      ["trusted-x", "ForwardX11Trusted", "command-or-forward"],
      ["macs", "MACs", "host-key"],
    ] as const) {
      await h.remote.there(name);
      expect(h.setup().there!.refusal, name).toMatchObject({ setting, category });
      expect(h.setup().there!.refusal!.title).toContain(setting);
    }
    // Agent and keychain loading, and BatchMode, choose nothing: no refusal, the account is asked.
    await h.remote.there("keychained");
    expect(h.setup().there!.refusal).toBeNull();
    await h.remote.there("upper");
    expect(h.setup().there!.refusal).toBeNull();
    expect(h.questions.map((q) => q.confirm)).toEqual(["Look", "Look"]);
    // Only the Include grammar Clawtrate follows: a class, an escape or braces are refused as Include.
    for (const include of [
      "Include ~/.ssh/odd[ab].conf",
      "Include ~/.ssh/back\\slash.conf",
      "Include ~/.ssh/{a,b}.conf",
    ]) {
      own.writeConfig(`${include}\nHost devbox\n  HostName 127.0.0.1\n`);
      await h.remote.there("devbox");
      expect(h.setup().there!.refusal, include).toMatchObject({ setting: "Include" });
    }
    expect(started.length).toBe(before);
    await ownTransport.closeAll();
  });

  it("F-495: a fresh Look at the live route's name reads the configuration first, and reuses the live route only while it resolves to the same target", async () => {
    const h = host();
    await connected(h);
    const config = readFileSync(t.world.personConfig, "utf8");
    try {
      // The live name now goes through a jump host: refused by name, and nothing started.
      t.writeConfig(
        config.replace(
          "Host devbox devbox-again\n",
          "Host devbox devbox-again\n  ProxyJump elsewhere\n",
        ),
      );
      const before = started.length;
      const asked = h.questions.length;
      await h.remote.there("devbox");
      expect(h.setup().there!.refusal).toMatchObject({ setting: "ProxyJump" });
      expect(started.length).toBe(before);
      expect(h.questions.length).toBe(asked);
      // Another user for the same name: not the live route; its own account is asked.
      t.writeConfig(config.replace(`  User ${t.world.localUser}\n`, "  User someone-else\n"));
      await h.remote.there("devbox");
      expect(h.questions.at(-1)!.message).toContain("someone-else@127.0.0.1");
    } finally {
      t.writeConfig(config);
      await h.remote.closeAll();
    }
  });

  it("F-495: the full account and SSH port are confirmed in the host's dialog before anything runs there; Cancel runs nothing", async () => {
    const h = host({ answer: () => ({ confirmed: false, checked: false }) });
    const before = started.length;
    await h.remote.there("devbox");
    expect(h.questions).toEqual([
      {
        message: `Look for OpenClaw as ${account}?`,
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
    expect(h.knownHosts()).toBe("");
    await h.remote.trustKey();
    expect(h.questions.at(-1)).toMatchObject({
      message: `Trust the key ${account} presented?`,
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

  it("F-495 F-499: a changed key is shown with both algorithms and fingerprints and replaced only with its box ticked: unticked, the dialog asks again; the old key's token goes when the new one is pinned", async () => {
    let tick = false;
    const h = host({
      answer: (question) => ({ confirmed: true, checked: question.checkbox ? tick : false }),
    });
    await connected(h);
    const [record] = h.routes.list();
    expect(h.routes.hasToken(record!.key)).toBe(true);
    const trusted = fingerprintOf(`${sshd.hostKey}.pub`);
    const old = sshd.hostKey;
    const fresh = join(root, `host-key-${count}`);
    keygen(fresh);
    await sshd.stop();
    await sshd.start(fresh);
    try {
      // The live route reconnects, meets the new key, stops and says so: nothing is sent.
      const connects = h.fake.connects.length;
      await until(() => h.setup().route?.phase === "key-changed", 30_000);
      expect(h.fake.connects.length).toBe(connects);
      await h.remote.there("devbox");
      const key = h.setup().there!.key!;
      expect(h.setup().phase).toBe("key");
      expect(key.state).toBe("changed");
      expect(key.trusted).toMatchObject({ label: "ED25519", fingerprint: trusted });
      expect(key.presented).toMatchObject({
        label: "ED25519",
        fingerprint: fingerprintOf(`${fresh}.pub`),
      });
      const pinned = h.knownHosts();
      const asked = h.questions.length;
      await h.remote.replaceKey();
      // Confirmed without the box: asked again, three times in all, and nothing replaced.
      const replaces = h.questions.slice(asked);
      expect(replaces).toHaveLength(3);
      expect(replaces[0]).toMatchObject({
        message: `Replace the saved key for ${account}?`,
        checkbox: `I checked the new key on ${t.world.localUser}@127.0.0.1 itself`,
      });
      expect(replaces[1]!.detail).toMatch(/^Tick the box to replace the key, or Cancel\./);
      expect(h.knownHosts()).toBe(pinned);
      expect(h.setup().phase).toBe("key");
      // And the screen says nothing was replaced, rather than going quiet.
      expect(h.setup().there?.notice).toBe("replace-unticked");
      expect(h.routes.hasToken(record!.key)).toBe(true);
      tick = true;
      await h.remote.replaceKey();
      expect(h.knownHosts()).toContain(readFileSync(`${fresh}.pub`, "utf8").split(" ")[1]!);
      // Still one pin for the endpoint, and the old key's token is gone with it.
      expect(h.pins()).toHaveLength(1);
      expect(h.routes.hasToken(record!.key)).toBe(false);
      expect(h.setup().phase).toBe("found");
    } finally {
      await sshd.stop();
      await sshd.start(old);
    }
  });

  it("F-495: a failure says which it was, naming the classified cause only, or the sign-in refused for the account and port", async () => {
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
    expect(s.setup().there).toMatchObject({
      account: `${t.world.localUser}@127.0.0.1`,
      port: sshd.port,
    });
  });

  it("F-496 F-494: Connect makes a --voice-node code there through the pinned connection, forwards to a private local socket, never a TCP port, and pairs read-only through that channel alone, with the token kept sealed in the route store only", async () => {
    const h = host();
    await lookOnDevbox(h);
    const calls = stub.calls().length;
    const before = started.length;
    await h.remote.connect();
    expect(h.questions.at(-1)).toMatchObject({
      message: `Pair this device read-only with the default gateway on ${account}?`,
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
    // The forward listens on a fresh socket in the private SSH folder, made closed to others.
    const forward = started.slice(before).find((run) => run.args.includes("-L"))!;
    const spec = forward.args[forward.args.indexOf("-L") + 1]!;
    const local = spec.slice(0, spec.indexOf(":"));
    expect(spec).toBe(`${local}:127.0.0.1:${gateway.port}`);
    expect(dirname(local)).toBe(h.world.appDir);
    expect(basename(local)).toMatch(/^f[0-9a-f]{12}\.s$/);
    expect(forward.args).toContain("StreamLocalBindMask=0177");
    expect(forward.args).toContain("StreamLocalBindUnlink=no");
    expect(forward.args.some((arg) => /^127\.0\.0\.1:\d+:/.test(arg))).toBe(false);
    // The client's socket was given the channel's address, which resolves nowhere.
    const url = h.fake.sockets.at(-1)!.url;
    expect(isChannelUrl(url)).toBe(true);
    expect(h.remote.allows(url)).toBe(true);
    expect(h.remote.placeFor(url)).toEqual({
      route: "ssh",
      account: `${t.world.localUser}@127.0.0.1`,
      port: sshd.port,
      profile: "default",
    });
    const connect = h.fake.connects.at(-1) as {
      scopes: string[];
      auth?: { bootstrapToken?: string; token?: string };
    };
    expect(connect.scopes).toEqual(["operator.read"]);
    expect(connect.auth?.bootstrapToken).toBe(BOOTSTRAP);
    expect(h.client.state.connection).toMatchObject({
      status: "connected",
      scopes: ["operator.read"],
      gatewayId: "gateway-identity-1",
    });
    // The device token is in the route store, sealed, under the route, and nowhere else.
    const routes = readFileSync(h.routes.path, "utf8");
    expect(routes).not.toContain(DEVICE_TOKEN);
    expect(h.routes.getToken(h.routes.list()[0]!.key, "device-1", "operator")).toContain(
      DEVICE_TOKEN,
    );
    expect([...h.storage.data.values()].join("\n")).not.toContain(DEVICE_TOKEN);
    expect([...h.storage.data.keys()].some((key) => key.startsWith("deviceToken"))).toBe(false);
    // The one-time code went nowhere: not the store, the state, the app's SSH files.
    expect(routes).not.toContain(BOOTSTRAP);
    expect(JSON.stringify(h.client.state)).not.toContain(BOOTSTRAP);
    expect(h.knownHosts()).not.toContain(BOOTSTRAP);
    // The route's record names what identifies it and the identity the client read, never the socket.
    const [record] = h.routes.list();
    expect(record).toMatchObject({
      destination: "devbox",
      account: `${t.world.localUser}@127.0.0.1`,
      sshPort: sshd.port,
      gatewayPort: gateway.port,
      profile: "default",
      identity: "gateway-identity-1",
    });
    expect(JSON.stringify(record)).not.toContain(local);
    expect(h.client.state.setup!.route).toMatchObject({ name: "devbox", phase: "up" });
    await h.remote.closeAll();
    // Closed: the socket went with its process, and the old channel is refused.
    expect(existsSync(local)).toBe(false);
    expect(h.remote.allows(url)).toBe(false);
    expect(() => h.remote.socketFor(url)).toThrow();
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
  });

  it("F-496: the gateway's identity is read before the setup connection allows anything; another identity than the route's is refused", async () => {
    const h = host();
    await connected(h);
    // The same route paired again after its token went: the route keeps the identity it recorded.
    const [record] = h.routes.list();
    h.routes.deleteToken(record!.key);
    h.setIdentity("gateway-identity-other");
    await h.remote.there("devbox");
    expect(h.setup().look?.access).toBe("new");
    const asked = h.fake.requests.length;
    await h.remote.connect();
    await until(() => h.setup().phase === "failed", 30_000);
    expect(h.setup().failure?.kind).toBe("identity");
    // Nothing but the identity was read from it.
    expect(h.fake.requests.slice(asked).map((r) => r.method)).toEqual(["gateway.identity.get"]);
    expect(h.client.state.connection.status).not.toBe("connected");
    await h.remote.closeAll();
  });

  it("F-496 F-497: Pair re-reads what its dialog named: a changed LOOK, a program file changed since, or an expired dialog runs nothing there", async () => {
    // The LOOK changes while the dialog is open: another version answers.
    let during: () => void = () => {};
    const h = host({
      answer: (question) => {
        if (question.confirm === "Pair") during();
        return { confirmed: true, checked: false };
      },
    });
    await lookOnDevbox(h);
    const calls = stub.calls().length;
    const changedVersion = JSON.parse(JSON.stringify(running())) as {
      gateway: { version: string };
    };
    changedVersion.gateway.version = "2026.10.7";
    during = () => stub.setStatus("default", changedVersion);
    try {
      await h.remote.connect();
      expect(h.setup().phase).toBe("failed");
      expect(h.setup().failure?.kind).toBe("changed");
      expect(
        stub
          .calls()
          .slice(calls)
          .some((call) => call.startsWith("qr ")),
      ).toBe(false);
    } finally {
      stub.setStatus("default", running());
    }
    // The program file is replaced while the dialog is open: same place, another checksum.
    const program = join(t.home, ".openclaw", "bin", "openclaw");
    const saved = join(root, "openclaw-saved");
    copyFileSync(program, saved);
    await lookOnDevbox(h);
    during = () => {
      writeFileSync(program, `${readFileSync(saved, "utf8")}\n# changed\n`);
      chmodSync(program, 0o755);
    };
    const before = stub.calls().length;
    try {
      await h.remote.connect();
      expect(h.setup().failure?.kind).toBe("changed");
      expect(
        stub
          .calls()
          .slice(before)
          .some((call) => call.startsWith("qr ")),
      ).toBe(false);
    } finally {
      copyFileSync(saved, program);
      chmodSync(program, 0o755);
    }
    // A dialog answered after its lifetime: nothing runs there.
    let clock = Date.now();
    const late = host({
      now: () => clock,
      answer: (question) => {
        if (question.confirm === "Pair") clock += 3 * 60_000;
        return { confirmed: true, checked: false };
      },
    });
    during = () => {};
    await lookOnDevbox(late);
    const lateCalls = stub.calls().length;
    await late.remote.connect();
    expect(late.setup().failure?.kind).toBe("changed");
    expect(
      stub
        .calls()
        .slice(lateCalls)
        .some((call) => call.startsWith("qr ")),
    ).toBe(false);
  });

  it("F-496 F-497: a consent holds only until its action starts: a deadline passing while the facts are read again, or a stopped service whose configuration changed, runs nothing there", async () => {
    // Pair: the clock passes the dialog's lifetime during the LOOK that reads its facts again.
    let clock = Date.now();
    let armed = false;
    const h = host({
      now: () => clock,
      answer: (question) => {
        if (question.confirm === "Pair" || question.confirm === "Start") armed = true;
        return { confirmed: true, checked: false };
      },
    });
    await lookOnDevbox(h);
    onSpawn = (args) => {
      if (armed && args.includes("/bin/sh")) {
        armed = false;
        clock += 3 * 60_000;
      }
    };
    try {
      const calls = stub.calls().length;
      await h.remote.connect();
      expect(h.setup().failure?.kind).toBe("changed");
      expect(
        stub
          .calls()
          .slice(calls)
          .some((call) => call.startsWith("qr ")),
      ).toBe(false);
      // Start: the same, between its re-read and START.
      const stopped = statusJson({ port: gateway.port, home: t.home, running: false });
      stub.setStatus("default", stopped);
      await lookOnDevbox(h);
      const before = stub.calls().length;
      await h.remote.start();
      expect(h.setup().failure?.kind).toBe("changed");
      expect(stub.calls().slice(before)).not.toContain("gateway start");
      // Start: the stopped service's configuration file changes while the dialog is open.
      onSpawn = null;
      const g = host({
        answer: (question) => {
          if (question.confirm === "Start")
            stub.setStatus(
              "default",
              statusJson({
                port: gateway.port,
                home: t.home,
                running: false,
                configPath: `${t.home}/.openclaw/elsewhere.json`,
              }),
            );
          return { confirmed: true, checked: false };
        },
      });
      stub.setStatus("default", stopped);
      await lookOnDevbox(g);
      const changed = stub.calls().length;
      await g.remote.start();
      expect(g.setup().failure?.kind).toBe("changed");
      expect(stub.calls().slice(changed)).not.toContain("gateway start");
    } finally {
      onSpawn = null;
      stub.setStatus("default", running());
    }
  });

  it("F-498 F-499: Disconnect kept across a restart stays disconnected and Reconnect opens the route through the host; Remove offline also forgets the saved connection", async () => {
    const h = host();
    await connected(h);
    await h.client.suspend();
    await until(() => h.setup().route?.phase === "disconnected", 10_000);
    await h.remote.closeAll();
    // The app opens again on the same folder and store.
    const again = host({ dir: h.dir, storage: h.storage });
    await again.client.start();
    await again.remote.resume();
    expect(again.setup().route?.phase).toBe("disconnected");
    expect(again.client.state.connection.status).toBe("disconnected");
    expect(again.fake.sockets).toEqual([]);
    await again.client.retryNow();
    await until(() => again.client.state.connection.status === "connected", 30_000);
    expect(again.fake.sockets.length).toBeGreaterThan(0);
    await again.remote.closeAll();
    // Offline: the computer can't be reached at launch, and Remove still forgets everything.
    const offline = host({ dir: h.dir, storage: h.storage });
    await sshd.stop();
    try {
      await offline.client.start();
      await offline.remote.resume();
      expect(offline.client.state.connection.status).not.toBe("connected");
      expect(h.storage.data.has("connection")).toBe(true);
      await offline.remote.removeRoute();
      expect(h.storage.data.has("connection")).toBe(false);
      expect(offline.routes.list()).toEqual([]);
      expect(offline.knownHosts()).toBe("");
    } finally {
      await sshd.start();
      await offline.remote.closeAll();
    }
  });

  it("F-498: a gateway that isn't the route's at launch gets the same cleanup as on a restore: forward closed, token dropped, record kept for Review", async () => {
    const h = host();
    const before = started.length;
    await connected(h);
    await h.remote.closeAll();
    const other = host({ dir: h.dir, storage: h.storage, identity: "gateway-identity-2" });
    await other.client.start();
    await other.remote.resume();
    await until(() => other.setup().route?.phase === "different-gateway", 30_000);
    const key = other.routes.list()[0]!.key;
    expect(other.routes.list()).toHaveLength(1);
    await until(() => !other.routes.hasToken(key), 5_000);
    const forwards = started.slice(before).filter((run) => run.args.includes("-L"));
    await until(() => forwards.every((run) => !alive(run.pid!)), 10_000);
    await other.remote.closeAll();
  });

  it("F-499: a pinned key Remove can't delete is a failed Remove: it says so and keeps the route", async () => {
    const h = host();
    await connected(h);
    const knownHosts = join(h.world.appDir, "known_hosts");
    const elsewhere = join(h.dir, "elsewhere");
    writeFileSync(elsewhere, readFileSync(knownHosts, "utf8"));
    rmSync(knownHosts);
    symlinkSync(elsewhere, knownHosts);
    await h.remote.removeRoute();
    expect(h.setup().there?.failure?.kind).toBe("remove-failed");
    expect(h.routes.list()).toHaveLength(1);
    expect(h.setup().route?.phase).toBe("failed");
    await h.remote.closeAll();
  });

  it("F-496: a first forward that finds another service, or the service stopped, says which, and connects nothing", async () => {
    const stopped = statusJson({ port: gateway.port, home: t.home, running: false });
    const other = statusJson({
      port: gateway.port,
      home: t.home,
      configPath: `${t.home}/.openclaw/other.json`,
    });
    try {
      for (const [status, kind] of [
        [other, "service-changed"],
        [stopped, "gateway-stopped"],
      ] as const) {
        const h = host();
        await lookOnDevbox(h);
        // When the forward starts, its own LOOK finds this instead of what the card named.
        onSpawn = (args) => {
          if (args.includes("-L")) stub.setStatus("default", status);
        };
        const sockets = h.fake.sockets.length;
        await h.remote.connect();
        await until(() => h.setup().phase === "failed", 60_000);
        expect(h.setup().there?.failure?.kind, kind).toBe(kind);
        expect(h.fake.sockets.length).toBe(sockets);
        onSpawn = null;
        stub.setStatus("default", running());
        await h.remote.closeAll();
      }
    } finally {
      onSpawn = null;
      stub.setStatus("default", running());
    }
  });

  it("F-495 F-499: at launch, settings refused by name or a name that now leads elsewhere are said on the field, and the saved route's Remove stays", async () => {
    const h = host();
    await connected(h);
    await h.remote.closeAll();
    const config = readFileSync(t.world.personConfig, "utf8");
    try {
      t.writeConfig(
        config.replace(
          "Host devbox devbox-again\n",
          "Host devbox devbox-again\n  ProxyJump elsewhere\n",
        ),
      );
      const refused = host({ dir: h.dir, storage: h.storage });
      await refused.client.start();
      await refused.remote.resume();
      expect(refused.setup().there?.refusal).toMatchObject({ setting: "ProxyJump" });
      expect(refused.setup().route).not.toBeNull();
      await refused.remote.closeAll();
      const closed = await freePort();
      t.writeConfig(config.replace(`  Port ${sshd.port}\n`, `  Port ${closed}\n`));
      const moved = host({ dir: h.dir, storage: h.storage });
      await moved.client.start();
      await moved.remote.resume();
      expect(moved.setup().there?.notice).toBe("endpoint-changed");
      expect(moved.setup().route).not.toBeNull();
      await moved.remote.closeAll();
    } finally {
      t.writeConfig(config);
    }
  });

  it("F-497: Start says which it was: refused before its command ran, the command failing, or a start Clawtrate couldn't confirm", async () => {
    const stopped = statusJson({ port: gateway.port, home: t.home, running: false });
    const program = join(t.home, ".openclaw", "bin", "openclaw");
    const saved = join(root, "openclaw-saved-start");
    copyFileSync(program, saved);
    try {
      // The program changes between the re-read and START: the script refuses, nothing ran.
      stub.setStatus("default", stopped);
      let armed = false;
      let scripts = 0;
      const h = host({
        answer: (question) => {
          if (question.confirm === "Start") armed = true;
          return { confirmed: true, checked: false };
        },
      });
      await lookOnDevbox(h);
      onSpawn = (args) => {
        if (!armed || !args.includes("/bin/sh")) return;
        scripts += 1;
        if (scripts === 2) {
          writeFileSync(program, `${readFileSync(saved, "utf8")}\n# changed\n`);
          chmodSync(program, 0o755);
        }
      };
      const calls = stub.calls().length;
      await h.remote.start();
      expect(h.setup().there?.failure?.kind).toBe("start-not-run");
      expect(stub.calls().slice(calls)).not.toContain("gateway start");
      onSpawn = null;
      copyFileSync(saved, program);
      chmodSync(program, 0o755);
      // The command runs and exits 3.
      stub.setStart("default", 3);
      await lookOnDevbox(h);
      await h.remote.start();
      expect(h.setup().there?.failure).toMatchObject({ kind: "start-failed", exit: 3 });
      // It runs and exits 0, and the gateway never shows as running.
      stub.setStart("default", 0);
      await lookOnDevbox(h);
      await h.remote.start();
      expect(h.setup().there?.failure?.kind).toBe("start-unconfirmed");
      await h.remote.closeAll();
    } finally {
      onSpawn = null;
      copyFileSync(saved, program);
      chmodSync(program, 0o755);
      stub.setStart("default", 0);
      stub.setStatus("default", running());
    }
  });

  it("F-498: a forward that drops comes back by itself, the strip says restoring until the gateway answered there with the route's identity, then that it is back", async () => {
    const h = host();
    await connected(h);
    const sockets = h.fake.sockets.length;
    const firstUrl = h.fake.sockets.at(-1)!.url;
    const phases: string[] = [];
    const atRestored: string[] = [];
    h.client.store.subscribe((state) => {
      const phase = state.setup?.route?.phase;
      if (phase && phases.at(-1) !== phase) {
        phases.push(phase);
        if (phase === "restored")
          atRestored.push(`${state.connection.status} ${state.connection.gatewayId}`);
      }
    });
    await sshd.dropSessions();
    await until(() => phases.includes("restoring"), 15_000);
    await until(
      () => h.client.state.setup?.route?.phase === "up" && phases.includes("restored"),
      30_000,
    );
    expect(phases).toEqual(["up", "restoring", "restored", "up"]);
    // Said back only once the client was connected again and the identity matched.
    expect(atRestored).toEqual(["connected gateway-identity-1"]);
    // Back over the route's own token, through a new channel, and only there.
    const connect = h.fake.connects.at(-1) as { auth?: { bootstrapToken?: string } };
    expect(connect.auth?.bootstrapToken).toBeUndefined();
    expect(JSON.stringify(connect.auth)).toContain(DEVICE_TOKEN);
    expect(h.fake.sockets.length).toBeGreaterThan(sockets);
    expect(h.fake.sockets.at(-1)!.url).not.toBe(firstUrl);
    expect(h.remote.allows(firstUrl)).toBe(false);
    await h.remote.closeAll();
  });

  it("F-498: a stalled identity read keeps the strip at restoring, and a rejected hello says the connection couldn't be restored", async () => {
    const h = host();
    await connected(h);
    // The gateway answers the hello and never says who it is.
    h.fake.handlers["gateway.identity.get"] = () => new Promise(() => {});
    await sshd.dropSessions();
    await until(() => h.setup().route?.phase === "restoring", 15_000);
    await until(() => h.fake.requests.at(-1)?.method === "gateway.identity.get", 30_000);
    await sleep(1_500);
    expect(h.setup().route?.phase).toBe("restoring");
    // Waiting for the gateway to say who it is: the host has nothing for Retry to do, so it isn't offered.
    expect(h.setup().route?.retry).toBe(false);
    expect(h.client.state.connection.status).not.toBe("connected");
    // A gateway that refuses the route's token: "Couldn't restore", never "back".
    h.fake.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-identity-1" });
    h.fake.connectReply = () => ({
      ok: false,
      error: { code: "AUTH_TOKEN_MISMATCH", message: "token mismatch" },
    });
    const phases: string[] = [];
    h.client.store.subscribe((state) => {
      const phase = state.setup?.route?.phase;
      if (phase && phases.at(-1) !== phase) phases.push(phase);
    });
    await sshd.dropSessions();
    await until(() => h.setup().route?.phase === "failed", 30_000);
    expect(phases).not.toContain("restored");
    await h.remote.closeAll();
  });

  it("F-498: a route whose gateway reports another identity after a restore is disconnected and its token dropped", async () => {
    const h = host();
    await connected(h);
    h.setIdentity("gateway-identity-2");
    await sshd.dropSessions();
    await until(() => h.client.state.setup?.route?.phase === "different-gateway", 30_000);
    expect(h.routes.hasToken(h.routes.list()[0]!.key)).toBe(false);
    expect(h.client.state.connection.status).not.toBe("connected");
    await h.remote.closeAll();
  });

  it("F-498: Disconnect is honoured: the forward closes, nothing reconnects or speaks over the app, and only Reconnect opens the route again", async () => {
    const h = host();
    const before = started.length;
    await connected(h);
    const forward = started.slice(before).find((run) => run.args.includes("-L"))!;
    await h.client.suspend();
    await until(() => !alive(forward.pid!), 10_000);
    expect(h.setup().route?.phase).toBe("disconnected");
    const sockets = h.fake.sockets.length;
    await sshd.dropSessions();
    await sleep(1_500);
    expect(h.fake.sockets.length).toBe(sockets);
    expect(h.client.state.connection.status).toBe("disconnected");
    // Reconnect: the host opens the route again, with its own token and its identity checked.
    await h.client.retryNow();
    await until(() => h.client.state.connection.status === "connected", 30_000);
    expect(h.client.state.connection.gatewayId).toBe("gateway-identity-1");
    expect(h.fake.sockets.length).toBeGreaterThan(sockets);
    // Disconnect for good: the route is retired and its strip goes.
    await h.client.disconnect();
    await until(() => h.setup().route === null, 10_000);
    await h.remote.closeAll();
  });

  it("F-499: Remove is local only: it closes the forward and deletes the route, its pin and its token, runs nothing there, and the dialog says the device stays listed", async () => {
    const h = host();
    const before = started.length;
    await connected(h);
    const forward = started.slice(before).find((run) => run.args.includes("-L"))!;
    expect(alive(forward.pid!)).toBe(true);
    const calls = stub.calls().length;
    const runs = started.length;
    await h.remote.removeRoute();
    expect(h.questions.at(-1)).toEqual({
      message: `Remove ${account} from Clawtrate?`,
      detail:
        "Clawtrate disconnects and deletes its saved route, key and token. The device remains listed in OpenClaw.",
      confirm: "Remove",
    });
    expect(alive(forward.pid!)).toBe(false);
    expect(h.pins()).toEqual([]);
    expect(h.routes.list()).toEqual([]);
    expect(readdirSync(h.world.appDir).filter((name) => name.startsWith("route-"))).toEqual([]);
    // Nothing ran on the other computer: no script, no stop.
    expect(stub.calls().slice(calls)).toEqual([]);
    expect(started.slice(runs).filter((run) => run.args.includes("/bin/sh"))).toEqual([]);
    expect(h.client.state.connection.status).toBe("idle");
    expect(h.client.state.setup!.route).toBeNull();
  });

  it("F-499: a saved route removed at launch while its computer is offline: the strip and the screen keep it, and Remove deletes it with no connection", async () => {
    const dir = join(root, "offline-host");
    const first = host({ dir });
    await connected(first);
    await first.remote.closeAll();
    const saved = await first.client.savedSettings();
    expect(saved?.route).toBeTruthy();
    // A restart while the other computer is off.
    await sshd.stop();
    try {
      const again = host({ dir });
      // The new client remembers the same saved connection.
      for (const [key, value] of first.storage.data) again.storage.data.set(key, value);
      await again.remote.resume();
      expect(again.setup().phase).toBe("failed");
      expect(again.setup().there?.failure?.kind).toBe("unreachable");
      expect(again.setup().route).toMatchObject({
        account: `${t.world.localUser}@127.0.0.1`,
        port: sshd.port,
      });
      expect(["unreachable", "failed"]).toContain(again.setup().route!.phase);
      await again.remote.removeRoute();
      expect(again.questions.at(-1)!.message).toBe(`Remove ${account} from Clawtrate?`);
      expect(again.routes.list()).toEqual([]);
      expect(again.pins()).toEqual([]);
      expect(again.setup().route).toBeNull();
    } finally {
      await sshd.start();
    }
  });

  it("F-499: one saved endpoint has one route id and one pin: looking at the live destination again, or another alias for it, adds no second pin", async () => {
    const h = host();
    await connected(h);
    const [record] = h.routes.list();
    await h.remote.there("devbox");
    expect(h.setup().phase).toBe("found");
    await h.remote.there("devbox-again");
    expect(h.setup().phase).toBe("found");
    expect(h.pins()).toHaveLength(1);
    expect(h.routes.list().map((each) => each.id)).toEqual([record!.id]);
    // The live route is still the app's.
    expect(h.client.state.connection.status).toBe("connected");
    await h.remote.closeAll();
  });

  it("F-495: another alias for the live route's endpoint, with its own sign-in settings, is looked at with those settings, and the live route stays", async () => {
    const h = host();
    await connected(h);
    // "stranger" leads to the same account, host and port with a key that isn't authorized there.
    await h.remote.there("stranger");
    if (h.setup().phase === "key") await h.remote.trustKey();
    expect(h.setup().phase).toBe("failed");
    expect(h.setup().there!.failure).toMatchObject({ kind: "sign-in-refused" });
    expect(h.client.state.connection.status).toBe("connected");
    await h.remote.closeAll();
  });

  it("F-496: a pairing the gateway accepted stays when Back is pressed while the bots load, and the next Connect reuses it", async () => {
    const h = host();
    await lookOnDevbox(h);
    // The bots never load: Connect waits on its last step.
    const agents = h.fake.handlers["agents.list"];
    h.fake.handlers["agents.list"] = () => new Promise(() => {});
    try {
      await h.remote.connect();
      await until(() => h.client.state.connection.status === "connected", 30_000);
      const key = h.client.route!;
      await until(() => h.routes.byKey(key)?.identity === "gateway-identity-1", 10_000);
      h.remote.cancel();
      await until(() => h.client.state.connection.status === "idle", 10_000);
      expect(h.routes.byKey(key)).toMatchObject({ identity: "gateway-identity-1" });
      expect(h.routes.hasToken(key)).toBe(true);
    } finally {
      h.fake.handlers["agents.list"] = agents!;
    }
    await h.remote.there("devbox");
    expect(h.setup().look?.access).toBe("paired");
    await h.remote.closeAll();
  });

  it("F-498: a saved pairing with no gateway identity recorded beside it is not restored by itself, and the next Pair makes a fresh pairing instead of reusing its token", async () => {
    const h = host();
    await connected(h);
    await h.remote.closeAll();
    const [record] = h.routes.list();
    h.routes.put({ ...record!, identity: null });
    expect(h.routes.hasToken(record!.key)).toBe(true);
    const again = host({ dir: h.dir, storage: h.storage });
    await again.client.start();
    await again.remote.resume();
    expect(again.setup().phase).toBe("found");
    expect(again.client.state.connection.status).not.toBe("connected");
    expect(again.fake.sockets).toEqual([]);
    // The card offers Pair, not a reuse, and Pair makes a code there and pairs afresh.
    expect(again.setup().look?.access).toBe("new");
    const calls = stub.calls().length;
    await again.remote.connect();
    expect(again.questions.at(-1)?.confirm).toBe("Pair");
    await until(() => again.setup().phase === "done", 30_000);
    expect(
      stub
        .calls()
        .slice(calls)
        .some((call) => call.startsWith("qr ")),
    ).toBe(true);
    const first = again.fake.connects[0] as { auth?: { bootstrapToken?: string; token?: string } };
    expect(first.auth?.bootstrapToken).toBe(BOOTSTRAP);
    expect(JSON.stringify(first.auth)).not.toContain(DEVICE_TOKEN);
    expect(again.routes.byKey(record!.key)).toMatchObject({ identity: "gateway-identity-1" });
    expect(again.routes.hasToken(record!.key)).toBe(true);
    // Looked at again, the route is paired now, with its identity recorded.
    await again.remote.there("devbox");
    expect(again.setup().look?.access).toBe("paired");
    await again.remote.closeAll();
  });

  it("F-496: Back while a failed first forward closes stays where it went: the failure isn't shown after it", async () => {
    const h = host();
    await lookOnDevbox(h);
    const stopped = statusJson({ port: gateway.port, home: t.home, running: false });
    onSpawn = (args) => {
      if (args.includes("-L")) stub.setStatus("default", stopped);
    };
    const r = h.remote as unknown as { letGoPending: () => Promise<void> };
    const letGo = r.letGoPending.bind(h.remote);
    let backed = false;
    r.letGoPending = async () => {
      // The person goes Back just as the failed forward is let go.
      if (!backed) {
        backed = true;
        h.remote.cancel();
      }
      return letGo();
    };
    try {
      await h.remote.connect();
      expect(backed).toBe(true);
      expect(h.setup().phase).toBe("found");
      expect(h.setup().there?.failure ?? null).toBeNull();
    } finally {
      onSpawn = null;
      stub.setStatus("default", running());
      await h.remote.closeAll();
    }
  });

  it("F-496: the cleanup of a Connect whose gateway couldn't say who it is never lets go of a Connect started meanwhile", async () => {
    const h = host();
    await lookOnDevbox(h);
    const identity = h.fake.handlers["gateway.identity.get"]!;
    h.fake.handlers["gateway.identity.get"] = () => {
      throw new Error("no identity");
    };
    const r = h.remote as unknown as {
      retireIdentity: (...args: unknown[]) => Promise<void>;
      pending: unknown;
    };
    const retire = r.retireIdentity.bind(h.remote);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first: unknown = null;
    r.retireIdentity = async (...args: unknown[]) => {
      first = r.pending;
      await retire(...args);
      await gate;
    };
    await h.remote.connect();
    await until(() => h.setup().phase === "failed", 30_000);
    expect(h.setup().there?.failure?.kind ?? h.setup().failure?.kind).toBe("identity-unread");
    h.fake.handlers["gateway.identity.get"] = identity;
    const second = h.remote.connect();
    await until(() => r.pending !== null && r.pending !== first, 30_000);
    release();
    await second;
    await until(() => h.setup().phase === "done", 30_000);
    await until(() => h.setup().route?.phase === "up", 10_000);
    await h.remote.closeAll();
  });

  it("F-496: Connect to another computer while a route is live pairs through its own channel's hello and keeps its own token", async () => {
    const h = host();
    await connected(h);
    const first = h.client.route!;
    const connects = h.fake.connects.length;
    await h.remote.there("devbox-local");
    if (h.setup().phase === "key") await h.remote.trustKey();
    expect(h.setup().phase, JSON.stringify(h.setup().there?.failure)).toBe("found");
    await h.remote.connect();
    await until(() => h.setup().phase === "done", 30_000);
    const second = h.client.route!;
    expect(second).not.toBe(first);
    // The new route went live on its own hello, not on what the store still said of the first.
    expect(h.fake.connects.length).toBeGreaterThan(connects);
    expect(h.routes.hasToken(second)).toBe(true);
    expect(h.remote.allows(h.client.state.connection.gatewayUrl!)).toBe(true);
    await h.remote.closeAll();
  });

  it("F-498: at launch, a changed key shows the key screen with both keys, not the first screen", async () => {
    const dir = join(root, "relaunch-host");
    const first = host({ dir });
    await connected(first);
    await first.remote.closeAll();
    const old = sshd.hostKey;
    const fresh = join(root, `relaunch-key-${count}`);
    keygen(fresh);
    await sshd.stop();
    await sshd.start(fresh);
    try {
      const again = host({ dir });
      for (const [key, value] of first.storage.data) again.storage.data.set(key, value);
      await again.remote.resume();
      expect(again.setup().phase).toBe("key");
      expect(again.setup().there?.key).toMatchObject({
        state: "changed",
        presented: { fingerprint: fingerprintOf(`${fresh}.pub`) },
      });
      expect(again.setup().route?.phase).toBe("key-changed");
    } finally {
      await sshd.stop();
      await sshd.start(old);
    }
  });

  it("F-497: a gateway proven stopped there is started only after the host's dialog, which re-reads the stopped service: one started meanwhile runs no Start", async () => {
    let start = false;
    let during: () => void = () => {};
    const h = host({
      answer: (question) => {
        if (question.confirm === "Start") during();
        return { confirmed: question.confirm === "Start" ? start : true, checked: false };
      },
    });
    const stopped = statusJson({ port: gateway.port, home: t.home, running: false });
    stub.setStatus("default", stopped);
    try {
      await lookOnDevbox(h);
      expect(h.setup().look).toMatchObject({ outcome: "stopped", profile: "default" });
      const calls = stub.calls().length;
      await h.remote.start();
      expect(h.questions.at(-1)).toMatchObject({
        message: `Start OpenClaw on ${account}?`,
        detail: "Clawtrate will ask the default profile's LaunchAgent to start.",
        confirm: "Start",
      });
      expect(stub.calls().slice(calls)).not.toContain("gateway start");
      // Started by someone else while the dialog is open: Start runs nothing.
      start = true;
      during = () => stub.setStatus("default", running());
      await h.remote.start();
      expect(h.setup().failure?.kind).toBe("changed");
      expect(stub.calls().slice(calls)).not.toContain("gateway start");
      // Still stopped after the answer: Start runs, and the gateway answers once started.
      during = () => {};
      stub.setStatus("default", stopped);
      await lookOnDevbox(h);
      // This Start's own call, not one an earlier case left in the stand-in's log.
      const sent = stub.calls().length;
      const starting = h.remote.start();
      await until(() => stub.calls().slice(sent).includes("gateway start"), 20_000);
      stub.setStatus("default", running());
      await starting;
      expect(h.setup().look).toMatchObject({ outcome: "running" });
    } finally {
      stub.setStatus("default", running());
    }
  });

  it("F-497: a stopped service with no port data and an RPC that answered is not offered Start", async () => {
    const h = host();
    const unclear = statusJson({
      port: gateway.port,
      home: t.home,
      running: false,
      rpcOk: true,
    }) as {
      port?: unknown;
    };
    delete unclear.port;
    stub.setStatus("default", unclear);
    try {
      await lookOnDevbox(h).catch(() => undefined);
      expect(h.setup().look).toMatchObject({ outcome: "cant-tell", reason: "contradictory" });
    } finally {
      stub.setStatus("default", running());
    }
  });

  it("before the setup host makes a transport, its data folder must be proven private at the host's own entry point: a redirected SSH folder goes to Advanced, and no transport is made", async () => {
    const synthetic = tempDir("clawtrate-private-root-");
    const outside = tempDir("clawtrate-outside-");
    try {
      mkdirSync(join(synthetic, "data"), { mode: 0o700 });
      symlinkSync(outside, join(synthetic, "data", "ssh"));
      let makes = 0;
      const factory = () =>
        sshTransportFor(
          join(synthetic, "data"),
          (dir) => {
            makes += 1;
            return new SshTransport({ ...t.world, appDir: dir }, { spawn });
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
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(synthetic, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  describe("the read-only rule over SSH: with no verified launcher, OpenClaw there never runs", () => {
    /** The LOOKs started since `from`: each is one `ssh … /bin/sh -s`. */
    const looks = (from: number) =>
      started.slice(from).filter((run) => run.args.includes("/bin/sh"));
    const readOnly = { outcome: "cant-tell", reason: "read-only" };

    it("the look and a saved route's restore at launch run nothing there, and the card offers Advanced", async () => {
      let launcher = true;
      const gate = () => launcher;
      // A route connected while the stand-in may run, for the restore below.
      const h = host({ launcher: gate });
      await connected(h);
      await h.remote.closeAll();
      launcher = false;
      // The look.
      const fresh = host({ launcher: gate });
      let calls = stub.calls().length;
      let from = started.length;
      await fresh.remote.there("devbox");
      if (fresh.setup().phase === "key") await fresh.remote.trustKey();
      expect(fresh.setup().phase).toBe("found");
      expect(fresh.setup().look).toMatchObject(readOnly);
      expect(looks(from).length).toBeGreaterThan(0);
      expect(stub.calls().slice(calls)).toEqual([]);
      // No Connect and no Start for it.
      await expect(fresh.remote.connect()).rejects.toThrow();
      await expect(fresh.remote.start()).rejects.toThrow();
      // The saved route at launch: its LOOK runs nothing, so nothing is connected or sent.
      const again = host({ dir: h.dir, storage: h.storage, launcher: gate });
      calls = stub.calls().length;
      from = started.length;
      await again.client.start();
      await again.remote.resume();
      expect(looks(from).length).toBeGreaterThan(0);
      expect(stub.calls().slice(calls)).toEqual([]);
      expect(again.setup().look).toMatchObject(readOnly);
      expect(again.fake.sockets).toEqual([]);
      expect(again.client.state.connection.status).not.toBe("connected");
      await again.remote.closeAll();
      await fresh.remote.closeAll();
    });

    it("Pair's and Start's rechecks run nothing there, and CODE and START are refused before ssh starts", async () => {
      let launcher = true;
      const gate = () => launcher;
      // Pair: the rule applies from the dialog on; its recheck's LOOK runs nothing.
      let onAnswer = () => {};
      const h = host({
        launcher: gate,
        answer: () => {
          onAnswer();
          return { confirmed: true, checked: false };
        },
      });
      await lookOnDevbox(h);
      onAnswer = () => (launcher = false);
      let calls = stub.calls().length;
      let from = started.length;
      await h.remote.connect();
      expect(h.setup().failure?.kind).toBe("changed");
      expect(looks(from).length).toBeGreaterThan(0);
      expect(stub.calls().slice(calls)).toEqual([]);
      expect(h.routes.list()).toEqual([]);
      // Start: the same.
      const stopped = statusJson({ port: gateway.port, home: t.home, running: false });
      stub.setStatus("default", stopped);
      try {
        launcher = true;
        onAnswer = () => {};
        await lookOnDevbox(h);
        expect(h.setup().look?.outcome).toBe("stopped");
        onAnswer = () => (launcher = false);
        calls = stub.calls().length;
        from = started.length;
        await h.remote.start();
        expect(h.setup().failure?.kind).toBe("changed");
        expect(looks(from).length).toBeGreaterThan(0);
        expect(stub.calls().slice(calls)).toEqual([]);
        // The rule applying just after a recheck that ran: START itself is refused, nothing runs.
        launcher = true;
        onAnswer = () => {};
        await lookOnDevbox(h);
        let armed = false;
        onAnswer = () => (armed = true);
        onSpawn = (args) => {
          if (armed && args.includes("/bin/sh")) {
            armed = false;
            launcher = false;
          }
        };
        from = started.length;
        await h.remote.start();
        expect(h.setup().look).toMatchObject(readOnly);
        expect(stub.calls().slice(calls)).not.toContain("gateway start");
        // One script ran there, the recheck's LOOK: none for START.
        expect(looks(from)).toHaveLength(1);
      } finally {
        onSpawn = null;
        stub.setStatus("default", running());
      }
      // CODE, the same way.
      launcher = true;
      onAnswer = () => {};
      await lookOnDevbox(h);
      let armed = false;
      onAnswer = () => (armed = true);
      onSpawn = (args) => {
        if (armed && args.includes("/bin/sh")) {
          armed = false;
          launcher = false;
        }
      };
      try {
        calls = stub.calls().length;
        from = started.length;
        const connects = h.fake.connects.length;
        await h.remote.connect();
        expect(h.setup().look).toMatchObject(readOnly);
        expect(
          stub
            .calls()
            .slice(calls)
            .some((call) => call.startsWith("qr ")),
        ).toBe(false);
        expect(looks(from)).toHaveLength(1);
        expect(h.fake.connects.length).toBe(connects);
        expect(h.routes.list()).toEqual([]);
      } finally {
        onSpawn = null;
      }
      await h.remote.closeAll();
    });

    it("the forward's verification and its recovery run nothing there: the forward is never up, and the strip never says back", async () => {
      let launcher = true;
      const gate = () => launcher;
      // A first forward whose verifying LOOK may not run OpenClaw: Connect fails and sends nothing.
      const h = host({ launcher: gate });
      await lookOnDevbox(h);
      let calls = -1;
      let from = -1;
      onSpawn = (args) => {
        if (args.includes("-L") && calls === -1) {
          launcher = false;
          calls = stub.calls().length;
          from = started.length;
        }
      };
      const connects = h.fake.connects.length;
      try {
        await h.remote.connect();
      } finally {
        onSpawn = null;
      }
      expect(h.setup().there?.failure?.kind).toBe("service-cant-tell");
      expect(looks(from).length).toBeGreaterThan(0);
      expect(stub.calls().slice(calls)).toEqual([]);
      expect(h.fake.connects.length).toBe(connects);
      expect(h.routes.list()).toEqual([]);
      // A live route whose forward drops: each LOOK of its recovery runs nothing, and it isn't back.
      launcher = true;
      const r = host({ launcher: gate });
      await connected(r);
      const phases: string[] = [];
      r.client.store.subscribe((state) => {
        const phase = state.setup?.route?.phase;
        if (phase && phases.at(-1) !== phase) phases.push(phase);
      });
      launcher = false;
      calls = stub.calls().length;
      from = started.length;
      const sockets = r.fake.sockets.length;
      await sshd.dropSessions();
      // Two of the recovery's LOOKs: the first has ended when the second starts.
      await until(() => looks(from).length >= 2, 30_000);
      expect(stub.calls().slice(calls)).toEqual([]);
      expect(phases).not.toContain("restored");
      expect(r.setup().route?.phase).not.toBe("up");
      expect(r.fake.sockets.length).toBe(sockets);
      await r.remote.closeAll();
    });
  });

  describe("consent and route ownership hold through the forward and the bots", () => {
    it("a cancelled Connect sends and saves nothing: Back while the forward opens, or while the gateway says who it is, keeps no token, record or saved connection", async () => {
      // Back while the forward opens: nothing is recorded and no code is sent.
      const h = host();
      await lookOnDevbox(h);
      const connects = h.fake.connects.length;
      onSpawn = (args) => {
        if (args.includes("-L")) {
          onSpawn = null;
          h.remote.cancel();
        }
      };
      try {
        await h.remote.connect();
      } finally {
        onSpawn = null;
      }
      expect(h.fake.connects.length).toBe(connects);
      expect(h.routes.list()).toEqual([]);
      expect(h.storage.data.has("connection")).toBe(false);
      await h.remote.closeAll();
      // Back while the gateway's identity is read after the hello, with the queued disconnect
      // slow: what the hello brought (the token, the saved connection) is never kept.
      const storage = memoryStorage();
      const remove = storage.delete;
      let holding = false;
      let releaseDelete = () => {};
      storage.delete = async (key) => {
        if (holding && key === "connection")
          await new Promise<void>((resolve) => (releaseDelete = resolve));
        return remove(key);
      };
      const g = host({ storage });
      await lookOnDevbox(g);
      let releaseIdentity = () => {};
      g.fake.handlers["gateway.identity.get"] = () =>
        new Promise((resolve) => {
          releaseIdentity = () => resolve({ deviceId: "gateway-identity-1", publicKey: "key" });
        });
      const connecting = g.remote.connect();
      await until(
        () => g.fake.requests.some((request) => request.method === "gateway.identity.get"),
        30_000,
      );
      const key = g.client.route!;
      expect(g.fake.connects.length).toBeGreaterThan(0);
      holding = true;
      g.remote.cancel();
      releaseIdentity();
      await sleep(500);
      expect(g.routes.hasToken(key)).toBe(false);
      expect(storage.data.has("connection")).toBe(false);
      expect(g.client.state.connection.gatewayId ?? null).toBeNull();
      holding = false;
      releaseDelete();
      await connecting;
      await until(() => g.client.state.connection.status === "idle", 10_000);
      expect(g.routes.list()).toEqual([]);
      expect(g.routes.hasToken(key)).toBe(false);
      expect(storage.data.has("connection")).toBe(false);
      await g.remote.closeAll();
    });

    it("a late Back lets go only of its own selection: a gateway chosen meanwhile stays selected and saved, and the attempt's forward still closes", async () => {
      const h = host();
      const before = started.length;
      await lookOnDevbox(h);
      // The bots never load: Connect waits on its last step.
      const agents = h.fake.handlers["agents.list"];
      h.fake.handlers["agents.list"] = () => new Promise(() => {});
      const other = "ws://127.0.0.1:51999";
      try {
        await h.remote.connect();
        await until(() => h.client.state.connection.status === "connected", 30_000);
        // Another gateway is chosen (Advanced), and Back is pressed before that choice applied:
        // Back's disconnect waits behind it in the queue.
        const replacing = h.client.connect({ url: other, token: "shared-token-for-the-test" });
        h.remote.cancel();
        await replacing;
        await sleep(500);
      } finally {
        h.fake.handlers["agents.list"] = agents!;
      }
      expect(h.client.route).toBeNull();
      expect(h.client.state.connection.gatewayUrl).toBe(other);
      expect(JSON.parse(h.storage.data.get("connection")!)).toMatchObject({ url: other });
      const forwards = started.slice(before).filter((run) => run.args.includes("-L"));
      expect(forwards.length).toBeGreaterThan(0);
      await until(() => forwards.every((run) => !alive(run.pid!)), 10_000);
      await h.remote.closeAll();
    });

    it("a Pair on another gateway port of a saved route's computer that can't be kept gives the saved route back as it was, with its token", async () => {
      const h = host();
      await connected(h);
      const [saved] = h.routes.list();
      const token = h.routes.getToken(saved!.key, "device-1", "operator");
      expect(token).not.toBeNull();
      await h.remote.closeAll();
      // The same computer now runs its gateway on another port: the same route id, another key.
      const second = await httpGateway();
      stub.setStatus("default", statusJson({ port: second.port, home: t.home }));
      const code = (port: number) =>
        JSON.parse(qrJson(`ws://127.0.0.1:${port}`, BOOTSTRAP, Date.now() + 590_000));
      stub.setCode("default", code(second.port));
      const g = host({ dir: h.dir, storage: h.storage });
      const put = g.routes.put.bind(g.routes);
      g.routes.put = (record) => {
        if (record.identity !== null) throw new Error("the disk is full");
        return put(record);
      };
      try {
        await g.remote.there("devbox");
        expect(g.setup().look).toMatchObject({ outcome: "running", port: second.port });
        await g.remote.connect();
        await until(() => g.setup().phase === "failed", 30_000);
      } finally {
        g.routes.put = put;
        stub.setStatus("default", running());
        stub.setCode("default", code(gateway.port));
        await second.close();
      }
      expect(g.setup().there?.failure?.kind).toBe("pairing-not-kept");
      expect(g.routes.list()).toEqual([saved]);
      expect(g.routes.getToken(saved!.key, "device-1", "operator")).toBe(token);
      await g.remote.closeAll();
    });

    it("a route the store can't write is never half saved: before pairing nothing is sent, after the gateway accepted Done isn't said, and either way the forward goes and nothing is kept", async () => {
      const forwardsSince = (from: number) =>
        started.slice(from).filter((run) => run.args.includes("-L"));
      // The first write, after the forward opened and before anything is sent.
      const h = host();
      const before = started.length;
      await lookOnDevbox(h);
      const put = h.routes.put.bind(h.routes);
      h.routes.put = () => {
        throw new Error("the disk is full");
      };
      const connects = h.fake.connects.length;
      try {
        await h.remote.connect();
      } finally {
        h.routes.put = put;
      }
      expect(h.setup().phase).toBe("failed");
      expect(h.setup().there?.failure?.kind).toBe("route-not-saved");
      expect(h.fake.connects.length).toBe(connects);
      expect(h.routes.list()).toEqual([]);
      expect(h.client.route).toBeNull();
      expect(forwardsSince(before).length).toBeGreaterThan(0);
      await until(() => forwardsSince(before).every((run) => !alive(run.pid!)), 10_000);
      await h.remote.closeAll();
      // The promotion's write, once the gateway accepted this device and the bots were read.
      const g = host();
      const from = started.length;
      await lookOnDevbox(g);
      const gput = g.routes.put.bind(g.routes);
      let key: string | null = null;
      g.routes.put = (record) => {
        key = record.key;
        if (record.identity !== null) throw new Error("the disk is full");
        return gput(record);
      };
      const phases: string[] = [];
      g.client.store.subscribe((state) => {
        const phase = state.setup?.phase;
        if (phase && phases.at(-1) !== phase) phases.push(phase);
      });
      try {
        await g.remote.connect();
        await until(() => g.setup().phase === "failed", 30_000);
      } finally {
        g.routes.put = gput;
      }
      expect(g.setup().there?.failure?.kind).toBe("pairing-not-kept");
      expect(phases).not.toContain("done");
      expect(g.setup().route ?? null).toBeNull();
      await until(() => g.client.state.connection.status === "idle", 10_000);
      expect(g.client.route).toBeNull();
      expect(g.storage.data.has("connection")).toBe(false);
      expect(g.routes.list()).toEqual([]);
      expect(key).not.toBeNull();
      expect(g.routes.hasToken(key!)).toBe(false);
      expect(forwardsSince(from).length).toBeGreaterThan(0);
      await until(() => forwardsSince(from).every((run) => !alive(run.pid!)), 10_000);
      await g.remote.closeAll();
    });

    it("F-496: a saved pairing that appears during the Pair dialog gets its own consent", async () => {
      const first = host();
      await connected(first);
      const [record] = first.routes.list();
      const key = record!.key;
      const token = first.routes.getToken(key, "device-1", "operator")!;
      await first.remote.closeAll();
      first.routes.deleteToken(key);
      let restorePairing = () => {};
      const again = host({
        dir: first.dir,
        storage: first.storage,
        answer: (question) => {
          if (question.confirm === "Pair") restorePairing();
          return { confirmed: true, checked: false };
        },
      });
      restorePairing = () => again.routes.setToken(key, "device-1", "operator", token);
      await again.remote.there("devbox");
      expect(again.setup().look?.access).toBe("new");
      const start = stub.calls().length;
      await again.remote.connect();
      expect(again.setup().phase).toBe("found");
      expect(again.setup().look?.access).toBe("paired");
      expect(again.routes.getToken(key, "device-1", "operator")).toBe(token);
      expect(
        stub
          .calls()
          .slice(start)
          .filter((call) => call.startsWith("qr ")),
      ).toEqual([]);
      expect(again.fake.connects).toEqual([]);
      await again.remote.closeAll();
    });

    it("F-498: a remembered pairing survives a failed route update on restore", async () => {
      const first = host();
      await connected(first);
      const [saved] = first.routes.list();
      await first.remote.closeAll();
      const again = host({ dir: first.dir, storage: first.storage });
      await again.client.start();
      const put = again.routes.put.bind(again.routes);
      again.routes.put = () => {
        throw new Error("route update failed");
      };
      try {
        await again.remote.resume();
        await until(() => again.setup().phase === "failed", 30_000);
        expect(again.routes.byKey(saved!.key)?.identity).toBe(saved!.identity);
        expect(again.routes.hasToken(saved!.key)).toBe(true);
        expect(again.setup().there?.failure?.kind).toBe("route-not-saved");
        expect(again.setup().route?.phase).toBe("failed");
      } finally {
        again.routes.put = put;
      }
      await again.remote.there("devbox");
      expect(again.setup().look?.access).toBe("paired");
      await again.remote.closeAll();
    });

    it("an expired Connect sends and saves nothing: the dialog's lifetime passing while the forward opens records no route and sends no code", async () => {
      let clock = Date.now();
      const h = host({ now: () => clock });
      await lookOnDevbox(h);
      const connects = h.fake.connects.length;
      const sockets = h.fake.sockets.length;
      onSpawn = (args) => {
        if (args.includes("-L")) {
          onSpawn = null;
          clock += 3 * 60_000;
        }
      };
      try {
        await h.remote.connect();
      } finally {
        onSpawn = null;
      }
      expect(h.setup().phase).toBe("failed");
      expect(h.setup().failure?.kind).toBe("changed");
      expect(h.fake.sockets.length).toBe(sockets);
      expect(h.fake.connects.length).toBe(connects);
      expect(h.routes.list()).toEqual([]);
      expect(h.storage.data.has("connection")).toBe(false);
      expect(h.client.route).toBeNull();
      await h.remote.closeAll();
    });
  });

  it("closing waits for every forward's ssh to end", async () => {
    const h = host();
    const before = started.length;
    await connected(h);
    const pids = started
      .slice(before)
      .filter((run) => run.args.includes("-L"))
      .map((run) => run.pid!);
    await h.remote.closeAll();
    expect(pids.filter((pid) => alive(pid))).toEqual([]);
  });
});
