// The stand-in for `openclaw` in a sandbox (docs/development/setup.md): the
// host's own answers to the look's exact commands, for the proven instance
// alone. Every spawn, socket and request of this process is counted here:
// a sandboxed look and Connect start no program and, outside the pairing
// scenario, open nothing.

import type * as ChildProcess from "node:child_process";
import type * as Http from "node:http";
import type * as Net from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProgramRequest } from "../src/setup/programs.ts";
import type { Scenario } from "../src/setup/sandbox.ts";
import type { SyntheticGateway } from "../src/setup/synthetic-gateway.ts";

const opened = vi.hoisted(() => ({ spawns: [] as string[], sockets: [] as string[] }));

vi.mock("node:child_process", async (original) => {
  const real = await original<typeof ChildProcess>();
  const count =
    <T extends (...args: never[]) => unknown>(name: string, fn: T) =>
    (...args: Parameters<T>) => {
      opened.spawns.push(`${name} ${String(args[0])}`);
      return fn(...args);
    };
  return {
    ...real,
    spawn: count("spawn", real.spawn),
    spawnSync: count("spawnSync", real.spawnSync),
    execFile: count("execFile", real.execFile),
    execFileSync: count("execFileSync", real.execFileSync),
    exec: count("exec", real.exec),
  };
});
vi.mock("node:net", async (original) => {
  const real = await original<typeof Net>();
  return {
    ...real,
    connect: (...args: Parameters<typeof real.connect>) => {
      opened.sockets.push("net.connect");
      return real.connect(...args);
    },
    createConnection: (...args: Parameters<typeof real.createConnection>) => {
      opened.sockets.push("net.createConnection");
      return real.createConnection(...args);
    },
    createServer: (...args: Parameters<typeof real.createServer>) => {
      opened.sockets.push("net.createServer");
      return real.createServer(...args);
    },
  };
});
vi.mock("node:http", async (original) => {
  const real = await original<typeof Http>();
  return {
    ...real,
    request: (...args: Parameters<typeof real.request>) => {
      opened.sockets.push("http.request");
      return real.request(...args);
    },
    get: (...args: Parameters<typeof real.get>) => {
      opened.sockets.push("http.get");
      return real.get(...args);
    },
  };
});

const { ClawtrateClient } = await import("@clawtrate/core");
const { FakeGateway, testHost, memoryStorage, until } =
  await import("../../../packages/core/test/fake-gateway.ts");
const { SetupController } = await import("../src/setup/controller.ts");
const { lookHere } = await import("../src/setup/look.ts");
const { isLookCommand } = await import("../src/setup/programs.ts");
const { sandboxOpener, STAND_IN_PROGRAM, UNTESTED_VERSION } =
  await import("../src/setup/sandbox.ts");
const { SetupRefusedError } = await import("../src/setup/world.ts");
const fake = await import("./fixtures/sandbox.ts");

const PROFILE = "clawtrate-dev-su1-test";

/** A proven run of this checkout's, its sandbox, and a pairing gateway that is never a real one. */
function sandbox(scenario?: Scenario) {
  const at = fake.world();
  const run = fake.instance({
    home: at.home,
    checkout: at.checkout,
    name: "su1-test",
    run: fake.runId("a"),
  });
  const { file, root } = fake.runFolder(join(at.base, "runs"), {
    instance: run.name,
    run: run.run,
    ...(scenario ? { scenario } : {}),
  });
  const processes = fake.identities();
  const minted: string[] = [];
  let started = 0;
  const gateway: SyntheticGateway = {
    url: "ws://127.0.0.1:19980",
    port: 19980,
    mint: (now) => {
      minted.push("code");
      return {
        url: "ws://127.0.0.1:19980",
        bootstrapToken: "c".repeat(43),
        expiresAtMs: now + 60_000,
      };
    },
    close: async () => {},
  };
  const opener = sandboxOpener({
    file,
    platform: "darwin",
    context: {
      platform: "darwin",
      home: at.home,
      uid: at.uid,
      checkout: at.checkout,
      identify: processes.identify,
    },
    startGateway: async () => {
      started += 1;
      return gateway;
    },
  });
  return { at, run, file, root, processes, opener, minted, started: () => started };
}

async function openOrThrow(opener: ReturnType<typeof sandbox>["opener"]) {
  const result = await opener.open();
  if (result instanceof SetupRefusedError) throw result;
  return result;
}

const ask = (args: string[], program = STAND_IN_PROGRAM): ProgramRequest => ({
  program,
  args,
  env: {},
  cwd: "/",
  timeoutMs: 1000,
  maxBytes: 4096,
});

describe("the stand-in for openclaw", () => {
  it("answers the look's three commands for the proven instance, from fixtures and the run's records, and starts and opens nothing", async () => {
    opened.spawns.length = 0;
    opened.sockets.length = 0;
    const s = sandbox();
    const { run } = await openOrThrow(s.opener);
    const version = await run(ask(["--profile", PROFILE, "--version"]));
    expect(version).toMatchObject({ exitCode: 0, stdout: "OpenClaw 2026.10.6\n" });
    expect(
      (await run(ask(["--profile", PROFILE, "config", "get", "gateway.auth.mode", "--json"])))
        .stdout,
    ).toBe('"token"\n');
    const status = JSON.parse(
      (await run(ask(["--profile", PROFILE, "gateway", "status", "--json"]))).stdout,
    );
    expect(status).toEqual({
      service: {
        label: "LaunchAgent",
        loaded: false,
        runtime: { status: "unknown", missingUnit: true },
      },
      config: { cli: { path: join(s.run.stateDir, "openclaw.json"), exists: true } },
      gateway: { bindMode: "loopback", port: s.run.port, probeUrl: `ws://127.0.0.1:${s.run.port}` },
      port: { port: s.run.port, status: "busy" },
      rpc: { ok: true, version: "2026.10.6", url: `ws://127.0.0.1:${s.run.port}` },
    });
    // The run is proven again for each status: the gateway's process asked each time.
    expect(s.processes.asked).toEqual([fake.GATEWAY_PID, fake.GATEWAY_PID]);
    expect(opened.spawns).toEqual([]);
    expect(opened.sockets).toEqual([]);
    expect(s.started()).toBe(0);
  });

  it("refuses the deep status, every other command, another profile, the default profile and any other program", async () => {
    const s = sandbox();
    const { run } = await openOrThrow(s.opener);
    const refused = [
      ask(["--profile", PROFILE, "gateway", "status", "--json", "--deep"]),
      ask([
        "--profile",
        PROFILE,
        "qr",
        "--json",
        "--voice-node",
        "--url",
        `ws://127.0.0.1:${s.run.port}`,
      ]),
      ask(["--profile", PROFILE, "devices", "list", "--json"]),
      ask(["--profile", "clawtrate-dev-other", "--version"]),
      ask(["--profile", "clawtrate", "--version"]),
      ask(["--version"]),
      ask(["gateway", "status", "--json"]),
      ask(["--profile", PROFILE, "--version"], "/usr/local/bin/openclaw"),
      ask(["--profile", PROFILE, "--version"], join(s.root, "home/openclaw")),
    ];
    for (const request of refused)
      expect((await run(request)).exitCode, request.args.join(" ")).toBe(2);
    expect(s.minted).toEqual([]);
    expect(s.started()).toBe(0);
  });

  it("answers status only while the run is proven: a replaced marker or a gone gateway changes the answer", async () => {
    const s = sandbox();
    const { run } = await openOrThrow(s.opener);
    s.processes.alive.clear();
    const stopped = JSON.parse(
      (await run(ask(["--profile", PROFILE, "gateway", "status", "--json"]))).stdout,
    );
    expect(stopped.rpc).toEqual({ ok: false, url: `ws://127.0.0.1:${s.run.port}` });
    expect(stopped.port.status).toBe("free");
    // Another run's marker in the instance's folder: no answer at all.
    fake.instance({
      home: s.at.home,
      checkout: s.at.checkout,
      name: "su1-test",
      run: fake.runId("e"),
      record: null,
    });
    expect((await run(ask(["--profile", PROFILE, "gateway", "status", "--json"]))).exitCode).toBe(
      2,
    );
  });

  it("reports the untested version in its scenario, and no program in the not-found and program-missing scenarios", async () => {
    const untested = sandbox("untested-version");
    const opened = await openOrThrow(untested.opener);
    expect((await lookHere(opened.world, opened.run))?.look).toMatchObject({
      outcome: "untested",
      version: UNTESTED_VERSION,
    });
    for (const [scenario, outcome] of [
      ["not-found", "not-found"],
      ["program-missing", "program-missing"],
    ] as const) {
      const s = sandbox(scenario);
      const world = await openOrThrow(s.opener);
      const asked: ProgramRequest[] = [];
      const report = await lookHere(world.world, (request) => {
        asked.push(request);
        return world.run(request);
      });
      expect(report?.look.outcome, scenario).toBe(outcome);
      expect(asked, scenario).toEqual([]);
    }
  });

  it("only in the pairing scenario: its gateway's port, and a code for that gateway's address alone", async () => {
    const s = sandbox("pairing");
    const { world, run } = await openOrThrow(s.opener);
    expect(world.pairs).toBe(true);
    expect(world.portAllowed(19980)).toBe(true);
    expect(world.portAllowed(s.run.port)).toBe(false);
    const status = JSON.parse(
      (await run(ask(["--profile", PROFILE, "gateway", "status", "--json"]))).stdout,
    );
    expect(status.gateway.port).toBe(19980);
    const other = await run(
      ask(["--profile", PROFILE, "qr", "--json", "--voice-node", "--url", "ws://127.0.0.1:19960"]),
    );
    expect(other.exitCode).toBe(2);
    expect(s.minted).toEqual([]);
    const code = await run(
      ask(["--profile", PROFILE, "qr", "--json", "--voice-node", "--url", "ws://127.0.0.1:19980"]),
    );
    expect(code.exitCode).toBe(0);
    expect(s.minted).toEqual(["code"]);
    expect(s.started()).toBe(1);
  });

  it("every command it answers is one of the look's exact commands", () => {
    for (const args of [
      ["--profile", PROFILE, "--version"],
      ["--profile", PROFILE, "gateway", "status", "--json"],
      ["--profile", PROFILE, "config", "get", "gateway.auth.mode", "--json"],
      ["--profile", PROFILE, "qr", "--json", "--voice-node", "--url", "ws://127.0.0.1:19980"],
    ])
      expect(isLookCommand(args)).toBe(true);
  });
});

describe("a sandboxed setup, from the look to Connect", () => {
  function controller(scenario?: Scenario) {
    const s = sandbox(scenario);
    const gateway = new FakeGateway();
    const logs: string[] = [];
    const client = new ClawtrateClient(
      {
        ...testHost(gateway, memoryStorage()),
        log: (_level: string, line: string) => void logs.push(line),
      },
      { reconnect: { initialMs: 20, maxMs: 40 } },
    );
    const dialogs: string[] = [];
    const setup = new SetupController({
      client,
      open: s.opener.open,
      stopPrograms: () => {},
      confirm: async (confirmation) => {
        dialogs.push(confirmation.message);
        return true;
      },
      log: (line) => logs.push(line),
    });
    return { ...s, gateway, client, setup, logs, dialogs };
  }

  it("a development instance is looked at and never paired with: after the dialog, a fixed refusal, no code, no socket, no program", async () => {
    opened.spawns.length = 0;
    opened.sockets.length = 0;
    const c = controller();
    await c.setup.look();
    expect(c.setup.current.look?.outcome).toBe("running");
    await c.setup.connect();
    expect(c.dialogs).toHaveLength(1);
    expect(c.setup.current.failure).toMatchObject({ kind: "refused", reason: "pairing" });
    expect(c.logs).toContain(
      "[setup] The look on this computer refused to start: this sandbox's scenario does not pair.",
    );
    expect(c.minted).toEqual([]);
    expect(c.gateway.sockets).toHaveLength(0);
    expect(opened.spawns).toEqual([]);
    expect(opened.sockets).toEqual([]);
  });

  it("a description that stops proving between the look and Connect refuses Connect, in fixed words", async () => {
    const c = controller("pairing");
    await c.setup.look();
    expect(c.setup.current.look?.outcome).toBe("running");
    fake.instance({
      home: c.at.home,
      checkout: c.at.checkout,
      name: "su1-test",
      run: fake.runId("f"),
      record: null,
    });
    await c.setup.connect();
    expect(c.setup.current.failure).toMatchObject({ kind: "refused", reason: "state" });
    expect(c.minted).toEqual([]);
    expect(c.gateway.sockets).toHaveLength(0);
    for (const line of c.logs) expect(line).not.toContain(c.at.base);
  });

  it("the pairing scenario mints after the dialog, through the fixture, for its own gateway", async () => {
    const c = controller("pairing");
    c.gateway.connectReply = () => ({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "x" },
    });
    await c.setup.look();
    await c.setup.connect();
    expect(c.dialogs).toHaveLength(1);
    expect(c.minted).toEqual(["code"]);
    await until(() => c.gateway.connects.length > 0);
    c.client.stop();
  });
});
