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
import { productionWorld, sandboxWorld, type LookWorld } from "../src/setup/world.ts";
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
  writeFileSync(program, "#!/bin/sh\nexit 1\n");
  chmodSync(program, 0o755);
  mkdirSync(join(dir, "home"));
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
      let entries: string[] = [];
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

  it("an automated run with no sandbox refuses the look loudly and starts no program", async () => {
    const h = harness({ world: productionWorld({ home: dir, appData: dir, platform: "darwin" }) });
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current).toMatchObject({ phase: "failed", failure: { kind: "refused" } });
    expect(h.logs.some((line) => line.includes("refused to start"))).toBe(true);
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
  it("F-494: refuses an argument or a variable that isn't safe before anything starts", () => {
    const base = { program: "/usr/bin/true", env: {}, timeoutMs: 1000, maxBytes: 1024 };
    for (const arg of [
      "two words",
      "quo'te",
      "semi;colon",
      "$(x)",
      "-x value",
      "a|b",
      "back\\slash",
    ]) {
      expect(() => checkRequest({ ...base, args: [arg] })).toThrow();
    }
    expect(() =>
      checkRequest({ ...base, args: ["--url", URL, "--profile", "clawtrate"] }),
    ).not.toThrow();
    expect(() => checkRequest({ ...base, args: [], env: { TOKEN: "a'b" } })).toThrow();
    expect(() => checkRequest({ ...base, program: "relative/openclaw", args: [] })).toThrow();
  });

  it("F-494: a program gets exactly the environment it is given, and its errors are not kept", async () => {
    const runner = new ProgramRunner();
    const result = await runner.run({
      program: "/usr/bin/env",
      args: [],
      env: { ONLY: "this" },
      timeoutMs: 5000,
      maxBytes: 4096,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ONLY=this");
    const failing = await runner.run({
      program: "/bin/ls",
      args: ["nonexistent-clawtrate-path"],
      env: {},
      timeoutMs: 5000,
      maxBytes: 4096,
    });
    expect(failing.exitCode).not.toBe(0);
    expect(JSON.stringify(failing)).not.toContain("nonexistent");
  });

  it("ends a program at its time limit, and at its output limit", async () => {
    const runner = new ProgramRunner();
    const slow = await runner.run({
      program: "/bin/sleep",
      args: ["5"],
      env: {},
      timeoutMs: 100,
      maxBytes: 4096,
    });
    expect(slow.timedOut).toBe(true);
    const large = await runner.run({
      program: "/usr/bin/yes",
      args: [],
      env: {},
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    expect(large).toMatchObject({ tooLarge: true, stdout: "" });
    expect(runner.running()).toEqual([]);
  });
});
