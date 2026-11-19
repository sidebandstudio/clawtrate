// Connect, with nothing typed (docs/design/setup.md §2, §7): the host's own
// dialog before anything is minted, the one-time code it makes and redeems
// itself for read alone, and the places that code never reaches. A fake
// runner stands in for `openclaw`, and the core's fake gateway for the gateway.

import { ClawtrateClient, type ClawtrateState } from "@clawtrate/core";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeGateway,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "../../../packages/core/test/fake-gateway.ts";
import {
  OPERATION_LIFETIME_MS,
  SetupController,
  type Confirmation,
} from "../src/setup/controller.ts";
import {
  checkRequest,
  ProgramRunner,
  type ProgramRequest,
  type ProgramResult,
} from "../src/setup/programs.ts";
import {
  productionWorld,
  sandboxWorld,
  STAND_IN_MARK,
  type LookWorld,
} from "../src/setup/world.ts";
import { MARKER_FILE } from "../../../tools/dev-gateway/src/state-guard.ts";
import { authJson, qrJson, statusJson, VERSION_LINE } from "./fixtures/openclaw-outputs.ts";

const PORT = 19940;
const URL = `ws://127.0.0.1:${PORT}`;
const CODE = "Xq3v8Lw0eXk2Rj9TaNf5Hc1UbYm7Pd4GsZi6Ko2EaVr";
const PROFILE = "--profile clawtrate-dev-su1-test";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-connect-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function world(): LookWorld {
  const program = join(dir, "bin/openclaw");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(program, `#!/bin/sh\n# ${STAND_IN_MARK}\nexit 1\n`);
  chmodSync(program, 0o755);
  mkdirSync(join(dir, "home"), { recursive: true });
  // The instance's marker, as `pnpm dev-gateway start` writes it: its port is the only one allowed.
  const stateDir = join(dir, ".openclaw-clawtrate-dev-su1-test");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, MARKER_FILE),
    JSON.stringify({
      createdBy: "clawtrate tools/dev-gateway",
      instance: "su1-test",
      gatewayPort: PORT,
    }),
  );
  return sandboxWorld(
    {
      home: join(dir, "home"),
      openclaw: program,
      instance: "su1-test",
      stateDir: join(dir, ".openclaw-clawtrate-dev-su1-test"),
    },
    "darwin",
  );
}

type Reply =
  Partial<ProgramResult> | (() => Partial<ProgramResult> | Promise<Partial<ProgramResult>>);

function harness(
  options: {
    replies?: Record<string, Reply>;
    confirm?: ((confirmation: Confirmation) => Promise<boolean>) | null;
    gateway?: FakeGateway;
    world?: LookWorld;
    now?: () => number;
  } = {},
) {
  const timeline: string[] = [];
  const requests: ProgramRequest[] = [];
  const replies: Record<string, Reply> = {
    "--version": { stdout: VERSION_LINE },
    "gateway status --json": { stdout: statusJson({ port: PORT }) },
    "gateway status --json --deep": { stdout: statusJson({ port: PORT }) },
    "config get gateway.auth.mode --json": { stdout: authJson() },
    [`qr --json --voice-node --url ${URL}`]: { stdout: qrJson(URL, CODE, Date.now() + 600_000) },
    ...options.replies,
  };
  const run = async (request: ProgramRequest): Promise<ProgramResult> => {
    checkRequest(request);
    requests.push(request);
    const key = request.args.join(" ").replace(`${PROFILE} `, "");
    timeline.push(`run ${key}`);
    const reply = replies[key];
    const result = typeof reply === "function" ? await reply() : reply;
    return {
      exitCode: 0,
      stdout: "",
      timedOut: false,
      tooLarge: false,
      failed: false,
      ...(result ?? { exitCode: 1 }),
    };
  };
  const gateway = options.gateway ?? new FakeGateway();
  if (!options.gateway) {
    gateway.connectReply = (params) => {
      const auth = (params as { auth?: { bootstrapToken?: string } }).auth;
      return auth?.bootstrapToken === CODE
        ? { ok: true, payload: helloOk(["operator.read"], "device-token") }
        : { ok: false, error: { code: "INVALID_REQUEST", message: "unauthorized" } };
    };
  }
  const storage = memoryStorage();
  const logs: string[] = [];
  const host = {
    ...testHost(gateway, storage),
    log: (_level: string, line: string) => void logs.push(line),
  };
  const client = new ClawtrateClient(host, { reconnect: { initialMs: 20, maxMs: 40 } });
  const snapshots: string[] = [];
  client.store.subscribe((state: ClawtrateState) => snapshots.push(JSON.stringify(state)));
  const dialogs: Confirmation[] = [];
  let stopped = 0;
  const confirm =
    options.confirm === null
      ? null
      : async (confirmation: Confirmation) => {
          dialogs.push(confirmation);
          timeline.push("dialog");
          return options.confirm ? options.confirm(confirmation) : true;
        };
  const setup = new SetupController({
    client,
    world: options.world ?? world(),
    sandboxed: true,
    realHome: join(dir, "real-home"),
    run,
    stopPrograms: () => void (stopped += 1),
    confirm,
    log: (line) => logs.push(line),
    ...(options.now ? { now: options.now } : {}),
  });
  /** Everything the code must never reach, as one string. */
  const everywhere = () =>
    [
      ...snapshots,
      JSON.stringify(client.state),
      ...logs,
      ...requests.map((request) => JSON.stringify({ args: request.args, env: request.env })),
      JSON.stringify([...storage.data.entries()]),
      JSON.stringify(dialogs),
    ].join("\n");
  return {
    setup,
    client,
    gateway,
    storage,
    requests,
    timeline,
    dialogs,
    logs,
    everywhere,
    stopped: () => stopped,
  };
}

/** Every file under the temporary folder changed since `since`, as text, a few levels deep. */
function temporaryFiles(since: number): string[] {
  const found: string[] = [];
  const walk = (path: string, depth: number) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.mtimeMs < since) return;
    if (stat.isDirectory() && depth < 4) {
      let entries: string[];
      try {
        entries = readdirSync(path);
      } catch {
        return;
      }
      for (const entry of entries) walk(join(path, entry), depth + 1);
    } else if (stat.isFile() && stat.size < 1024 * 1024) {
      try {
        found.push(readFileSync(path, "utf8"));
      } catch {
        // not readable: not written by this test
      }
    }
  };
  for (const entry of readdirSync(tmpdir())) walk(join(tmpdir(), entry), 0);
  return found;
}

const minted = (requests: ProgramRequest[]) =>
  requests.filter((request) => request.args.includes("qr"));

describe("Connect on this computer", () => {
  it("F-492 F-494: Connect asks the host's dialog first, then redeems a voice-node code for read alone, and the code reaches no state, snapshot, log, argument, environment, storage or dialog", async () => {
    const started = Date.now();
    const h = harness();
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current.phase).toBe("found");
    expect(h.setup.current.look?.outcome).toBe("running");
    await h.setup.connect();
    await until(() => h.setup.current.phase === "done");

    expect(h.dialogs).toEqual([
      {
        message:
          "Pair this device read-only with the clawtrate-dev-su1-test gateway on this computer?",
        detail: "The gateway saves this device.",
        confirm: "Pair",
      },
    ]);
    // Nothing is minted before the answer; the facts are read again after it.
    const dialogAt = h.timeline.indexOf("dialog");
    const qrAt = h.timeline.findIndex((line) => line.includes(" qr "));
    expect(dialogAt).toBeGreaterThan(-1);
    expect(qrAt).toBeGreaterThan(dialogAt);
    expect(h.timeline.slice(dialogAt + 1, qrAt)).toEqual(
      expect.arrayContaining([
        "run gateway status --json",
        "run config get gateway.auth.mode --json",
      ]),
    );
    expect(minted(h.requests)).toHaveLength(1);
    expect(minted(h.requests)[0]!.args).toEqual([
      "--profile",
      "clawtrate-dev-su1-test",
      "qr",
      "--json",
      "--voice-node",
      "--url",
      URL,
    ]);
    const sent = h.gateway.connects[0] as { scopes: string[]; auth: Record<string, string> };
    expect(sent.scopes).toEqual(["operator.read"]);
    expect(sent.auth).toEqual({ bootstrapToken: CODE });
    expect(h.client.state.connection.status).toBe("connected");
    expect(JSON.parse(h.storage.data.get(tokenKey(URL))!).heldScopes).toEqual(["operator.read"]);
    expect(h.everywhere()).not.toContain(CODE);
    expect(temporaryFiles(started).filter((text) => text.includes(CODE))).toEqual([]);
    // The shared token is never asked for: no command reads it or the config file.
    for (const request of h.requests) {
      expect(request.args.join(" ")).not.toMatch(/auth-token|gateway\.auth\.token|openclaw\.json/);
    }
    h.client.stop();
    // The temporary folder is scanned, which takes a while on a busy machine.
  }, 60_000);

  it("F-492: declining the host's dialog mints nothing and pairs nothing", async () => {
    const h = harness({ confirm: async () => false });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.phase).toBe("found");
    expect(minted(h.requests)).toEqual([]);
    await sleep(50);
    expect(h.gateway.connects).toEqual([]);
    expect([...h.storage.data.keys()]).toEqual([]);
    h.client.stop();
  });

  it("F-494: a host with no dialog of its own, the web preview, pairs nothing", async () => {
    const h = harness({ confirm: null });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("no-dialog");
    expect(minted(h.requests)).toEqual([]);
    expect(h.gateway.connects).toEqual([]);
    h.client.stop();
  });

  it("F-492: facts that changed between the dialog and its answer run nothing", async () => {
    let port = PORT;
    const h = harness({
      replies: { "gateway status --json": () => ({ stdout: statusJson({ port }) }) },
      confirm: async () => {
        port = 19960;
        return true;
      },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("changed");
    expect(minted(h.requests)).toEqual([]);
    expect(h.gateway.connects).toEqual([]);
    h.client.stop();
  });

  it("F-492: an answer after the operation's two minutes runs nothing", async () => {
    let now = 1_000_000;
    const h = harness({
      now: () => now,
      confirm: async () => {
        now += OPERATION_LIFETIME_MS + 1;
        return true;
      },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("changed");
    expect(minted(h.requests)).toEqual([]);
    h.client.stop();
  });

  it("F-492: a code that can't be made ends in its own state, with the exit code", async () => {
    const h = harness({
      replies: { [`qr --json --voice-node --url ${URL}`]: { exitCode: 1, stdout: "" } },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current).toMatchObject({
      phase: "failed",
      failure: { kind: "code-failed", exitCode: 1 },
    });
    expect(h.gateway.connects).toEqual([]);
    h.client.stop();
  });

  it("F-492 F-494: a code for another address is refused before it is sent", async () => {
    const h = harness({
      replies: {
        [`qr --json --voice-node --url ${URL}`]: {
          stdout: qrJson("ws://192.0.2.10:19940", CODE, Date.now() + 600_000),
        },
      },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("code-failed");
    expect(h.gateway.connects).toEqual([]);
    expect(h.everywhere()).not.toContain(CODE);
    h.client.stop();
  });

  it("F-492: a code the gateway refuses ends in its own state", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized: setup code invalid, expired, revoked, or already used",
        details: { code: "AUTH_BOOTSTRAP_TOKEN_INVALID" },
      },
    });
    const h = harness({ gateway });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.setup.current.phase === "failed");
    expect(h.setup.current.failure?.kind).toBe("code-refused");
    expect(h.everywhere()).not.toContain(CODE);
    h.client.stop();
  });

  it("F-492: a grant wider than read ends in its own state and writes no token", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read", "operator.write"], "wide-token"),
    });
    const h = harness({ gateway });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.setup.current.phase === "failed");
    expect(h.setup.current.failure?.kind).toBe("grant");
    expect(h.storage.data.has(tokenKey(URL))).toBe(false);
    expect(h.everywhere()).not.toContain("wide-token");
    h.client.stop();
  });

  it("F-492: a gateway that asks before every device ends on the pairing screen", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "device pairing required",
        details: {
          code: "PAIRING_REQUIRED",
          requestId: "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942",
          deviceId: "device-1",
          requestedScopes: ["operator.read"],
        },
      },
    });
    const h = harness({ gateway });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.client.state.connection.status === "pairing");
    expect(h.client.state.connection.pairing?.requestedScopes).toEqual(["operator.read"]);
    expect(h.setup.current.phase).toBe("connecting");
    h.client.stop();
  });

  it("F-515: Connect is refused for anything but a found gateway of the tested version, without a dialog", async () => {
    const h = harness({
      replies: {
        "gateway status --json": { stdout: statusJson({ port: PORT, answered: "2026.9.37" }) },
      },
    });
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current.look?.outcome).toBe("untested");
    await expect(h.setup.connect()).rejects.toThrow(/nothing to connect to/);
    expect(h.dialogs).toEqual([]);
    expect(minted(h.requests)).toEqual([]);
    h.client.stop();
  });

  it("Back during the look ends its programs and returns to the first screen", async () => {
    let release!: () => void;
    const h = harness({
      replies: {
        "gateway status --json": () =>
          new Promise((resolve) => {
            release = () => resolve({ stdout: statusJson({ port: PORT }) });
          }),
      },
    });
    await h.client.start();
    const looking = h.setup.look();
    await until(() => h.setup.current.step === 2);
    h.setup.cancel();
    expect(h.stopped()).toBe(1);
    expect(h.setup.current.phase).toBe("idle");
    release();
    await looking;
    expect(h.setup.current.phase).toBe("idle");
    h.client.stop();
  });

  it("an automated run with no sandbox refuses the real computer loudly, finds nothing and starts no program", async () => {
    // A home that holds an OpenClaw and its program: the look must see none of it.
    mkdirSync(join(dir, ".openclaw"));
    const real = productionWorld({ home: dir, appData: dir, platform: "darwin" });
    const h = harness({
      world: { ...real, candidates: [...real.candidates, world().candidates[0]!] },
    });
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current).toMatchObject({ phase: "found", look: { outcome: "not-found" } });
    expect(h.logs.some((line) => line.includes("refused to start"))).toBe(true);
    expect(h.requests).toEqual([]);
    h.client.stop();
  });

  it("a sandbox that reaches the real home folder is refused, loudly, and starts no program", async () => {
    mkdirSync(join(dir, "real-home"));
    const reaching = sandboxWorld(
      {
        home: join(dir, "real-home"),
        openclaw: join(dir, "bin/openclaw"),
        instance: "su1-test",
        stateDir: join(dir, ".openclaw-clawtrate-dev-su1-test"),
      },
      "darwin",
    );
    const h = harness({ world: reaching });
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current).toMatchObject({ phase: "failed", failure: { kind: "refused" } });
    expect(h.logs.some((line) => line.includes("real home folder"))).toBe(true);
    expect(h.requests).toEqual([]);
    h.client.stop();
  });

  it("F-492: a device already paired with that gateway reconnects with its own token and mints no code", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const h = harness({ gateway });
    await h.storage.set(
      tokenKey(URL),
      JSON.stringify({
        token: "device-token",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      }),
    );
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.setup.current.phase === "done");
    expect(minted(h.requests)).toEqual([]);
    expect((h.gateway.connects[0] as { auth: unknown }).auth).toEqual({
      deviceToken: "device-token",
    });
    h.client.stop();
  });
});

describe("the programs setup starts", () => {
  const base = {
    program: "/usr/bin/true",
    env: {},
    cwd: "/tmp",
    timeoutMs: 1000,
    maxBytes: 1024,
  };
  const ok = (args: string[]) => () => checkRequest({ ...base, args });

  it("F-494: starts only the exact commands the look and Connect use", () => {
    for (const args of [
      ["--version"],
      ["gateway", "status", "--json"],
      ["gateway", "status", "--json", "--deep"],
      ["config", "get", "gateway.auth.mode", "--json"],
      ["--profile", "clawtrate", "gateway", "status", "--json"],
      ["--profile", "clawtrate-dev-su1-test", "qr", "--json", "--voice-node", "--url", URL],
    ]) {
      expect(ok(args), args.join(" ")).not.toThrow();
    }
    for (const args of [
      ["gateway", "status", "--json", "--no-probe"],
      ["gateway", "status", "--json", "--url", URL],
      ["gateway", "start"],
      ["config", "get", "gateway.auth.token"],
      ["--profile", "work", "gateway", "status", "--json"],
      ["--profile", "clawtrate-dev-Bad", "--version"],
      ["qr", "--json", "--voice-node", "--url", "ws://192.0.2.10:19940"],
      ["qr", "--json", "--voice-node", "--url", "wss://127.0.0.1:19940"],
      ["qr", "--json", "--url", URL],
      ["--version", "--json"],
      [],
    ]) {
      expect(ok(args), args.join(" ")).toThrow();
    }
  });

  it("F-494: passes only the look's variables, and needs a working folder of its own", () => {
    expect(() => checkRequest({ ...base, args: ["--version"], env: { TOKEN: "x" } })).toThrow();
    expect(() => checkRequest({ ...base, args: ["--version"], env: { HOME: "a'b" } })).toThrow();
    expect(() => checkRequest({ ...base, args: ["--version"], cwd: "relative" })).toThrow();
    expect(() =>
      checkRequest({ ...base, args: ["--version"], program: "relative/openclaw" }),
    ).toThrow();
    expect(() =>
      checkRequest({ ...base, args: ["--version"], env: { HOME: "/tmp", OPENCLAW_PROFILE: "x" } }),
    ).not.toThrow();
  });

  /** A runner for real system programs, with the look's own command check set aside. */
  const loose = () => new ProgramRunner({ check: () => {}, graceMs: 300 });

  it("F-494: a program gets exactly the environment and the working folder it is given, and its errors are not kept", async () => {
    const runner = loose();
    const result = await runner.run({
      ...base,
      program: "/usr/bin/env",
      args: [],
      env: { ONLY: "this" },
      timeoutMs: 5000,
      maxBytes: 4096,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ONLY=this");
    const where = await runner.run({
      ...base,
      program: "/bin/pwd",
      args: [],
      cwd: dir,
      timeoutMs: 5000,
      maxBytes: 4096,
    });
    expect(realpathSync(where.stdout.trim())).toBe(realpathSync(dir));
    const failing = await runner.run({
      ...base,
      program: "/bin/ls",
      args: ["nonexistent-clawtrate-path"],
      timeoutMs: 5000,
      maxBytes: 4096,
    });
    expect(failing.exitCode).not.toBe(0);
    expect(JSON.stringify(failing)).not.toContain("nonexistent");
  });

  it("ends a program at its time limit and its output limit, and kills one that ignores the request to stop", async () => {
    const runner = loose();
    const slow = await runner.run({
      ...base,
      program: "/bin/sleep",
      args: ["5"],
      timeoutMs: 100,
      maxBytes: 4096,
    });
    expect(slow.timedOut).toBe(true);
    const large = await runner.run({
      ...base,
      program: "/usr/bin/yes",
      args: [],
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    expect(large).toMatchObject({ tooLarge: true, stdout: "" });
    const started = Date.now();
    const stubborn = await runner.run({
      ...base,
      program: "/bin/sh",
      args: ["-c", "trap '' TERM; while :; do sleep 1; done"],
      timeoutMs: 100,
      maxBytes: 4096,
    });
    expect(stubborn.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(runner.running()).toEqual([]);
  }, 20_000);

  it("the host's runner refuses anything but the look's commands before it starts", async () => {
    const runner = new ProgramRunner();
    expect(() => runner.run({ ...base, program: "/usr/bin/env", args: [] })).toThrow();
  });
});

describe("Connect goes only to the gateway that answered, and says what is true", () => {
  const changedAfterDialog = async (change: Record<string, Reply>) => {
    let answered = false;
    const replies: Record<string, Reply> = {};
    for (const [key, reply] of Object.entries(change)) {
      const before = {
        "gateway status --json": { stdout: statusJson({ port: PORT }) },
        "config get gateway.auth.mode --json": { stdout: authJson() },
      }[key];
      replies[key] = () => (answered ? (typeof reply === "function" ? reply() : reply) : before!);
    }
    const h = harness({
      replies,
      confirm: async () => {
        answered = true;
        return true;
      },
    });
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current.look?.outcome).toBe("running");
    await h.setup.connect();
    return h;
  };

  for (const [name, change] of [
    [
      "the service changed",
      { "gateway status --json": { stdout: statusJson({ port: PORT, service: "running" }) } },
    ],
    [
      "the status probed elsewhere",
      {
        "gateway status --json": {
          stdout: statusJson({ port: PORT, probeUrl: "ws://127.0.0.1:19960" }),
        },
      },
    ],
    [
      "its RPC answered elsewhere",
      {
        "gateway status --json": {
          stdout: statusJson({ port: PORT, rpcUrl: "wss://127.0.0.1:19940" }),
        },
      },
    ],
    [
      "the auth command failed",
      { "config get gateway.auth.mode --json": { exitCode: 1, stdout: authJson() } },
    ],
    [
      "the auth command timed out",
      {
        "config get gateway.auth.mode --json": {
          timedOut: true,
          exitCode: null,
          stdout: authJson(),
        },
      },
    ],
  ] as const) {
    it(`F-492 F-516: ${name} between the dialog and its answer, and nothing is minted`, async () => {
      const h = await changedAfterDialog(change as Record<string, Reply>);
      expect(h.setup.current.failure?.kind).toBe("changed");
      expect(minted(h.requests)).toEqual([]);
      expect(h.gateway.connects).toEqual([]);
      h.client.stop();
    });
  }

  it("F-492: a device already paired with more than read is told so, in the dialog and on its card", async () => {
    const h = harness();
    await h.storage.set(
      tokenKey(URL),
      JSON.stringify({
        token: "device-token",
        grantedScopes: ["operator.read", "operator.write"],
        heldScopes: ["operator.read", "operator.write"],
      }),
    );
    h.gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read", "operator.write"], "device-token"),
    });
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current.look?.access).toBe("more");
    await h.setup.connect();
    expect(h.dialogs[0]).toEqual({
      message: "Connect this device to the clawtrate-dev-su1-test gateway on this computer?",
      detail: "This device is already paired with this gateway and can also send.",
      confirm: "Connect",
    });
    expect(JSON.stringify(h.dialogs)).not.toMatch(/read-only/);
    expect(minted(h.requests)).toEqual([]);
    h.client.stop();
  });

  it("F-492: a device already paired to read is told it can only read", async () => {
    const h = harness();
    await h.storage.set(
      tokenKey(URL),
      JSON.stringify({
        token: "device-token",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      }),
    );
    h.gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current.look?.access).toBe("read");
    await h.setup.connect();
    expect(h.dialogs[0]?.detail).toBe(
      "This device is already paired with this gateway and can only read.",
    );
    h.client.stop();
  });

  it("a setup cancelled while the earlier connection is let go starts nothing more", async () => {
    const h = harness();
    await h.client.start();
    await h.setup.look();
    // An earlier connection, still trying, that takes its time to be let go.
    h.gateway.refuseConnections = true;
    await h.client.connect({ url: "ws://127.0.0.1:19990", token: null });
    const disconnect = h.client.disconnect.bind(h.client);
    const holds: Array<() => void> = [];
    h.client.disconnect = async () => {
      await new Promise<void>((resolve) => holds.push(resolve));
      return disconnect();
    };
    let asked = 0;
    const hasDeviceToken = h.client.hasDeviceToken.bind(h.client);
    h.client.hasDeviceToken = (url: string) => {
      asked += 1;
      return hasDeviceToken(url);
    };
    const connecting = h.setup.connect();
    await until(() => holds.length > 0);
    h.setup.cancel();
    for (const release of holds) release();
    await connecting;
    // Nothing more is started, not even a read of this device's tokens.
    expect(asked).toBe(0);
    expect(minted(h.requests)).toEqual([]);
    h.client.stop();
  });

  it("a setup cancelled while it checks for an earlier pairing starts nothing more", async () => {
    const h = harness();
    await h.client.start();
    await h.setup.look();
    let release: ((paired: boolean) => void) | undefined;
    h.client.hasDeviceToken = () => new Promise<boolean>((resolve) => (release = resolve));
    const connecting = h.setup.connect();
    await until(() => release !== undefined);
    h.setup.cancel();
    release!(false);
    await connecting;
    expect(minted(h.requests)).toEqual([]);
    expect(h.gateway.connects).toEqual([]);
    h.client.stop();
  });

  it("the operation's two minutes hold until the code is made, not only until the answer", async () => {
    let now = 1_000_000;
    let answered = false;
    const h = harness({
      now: () => now,
      confirm: async () => {
        answered = true;
        return true;
      },
      replies: {
        "gateway status --json": () => {
          // The recheck after the answer takes longer than what is left of the two minutes.
          if (answered) now += OPERATION_LIFETIME_MS + 1;
          return { stdout: statusJson({ port: PORT }) };
        },
      },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("changed");
    expect(minted(h.requests)).toEqual([]);
    h.client.stop();
  });

  it("connected, with bots that couldn't be read, says so and doesn't open the app", async () => {
    const h = harness();
    h.gateway.handlers["agents.list"] = () => {
      throw new Error("agents unavailable");
    };
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.setup.current.phase === "failed");
    expect(h.setup.current.failure?.kind).toBe("bots");
    expect(h.client.state.connection.status).toBe("connected");
    h.client.stop();
  });
});
