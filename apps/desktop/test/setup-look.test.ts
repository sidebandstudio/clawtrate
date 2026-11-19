// The look on this computer (docs/design/setup.md §4, §6), from recorded
// command outputs: every result, what each runs, and the guard that keeps
// an automated run away from the real computer. No program runs here: a
// fake runner answers from the recordings.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lookHere } from "../src/setup/look.ts";
import type { ProgramRequest, ProgramResult } from "../src/setup/programs.ts";
import {
  automatedRun,
  guardPort,
  guardWorld,
  productionWorld,
  readSandbox,
  sandboxWorld,
  SetupRefusedError,
  type LookWorld,
} from "../src/setup/world.ts";
import { authJson, statusJson, VERSION_LINE } from "./fixtures/openclaw-outputs.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-look-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function executable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 1\n");
  chmodSync(path, 0o755);
  return path;
}

/** A production-shaped world in a temporary home, with its program list kept to that home. */
function homeWorld(options: { program?: boolean; platform?: NodeJS.Platform } = {}): LookWorld {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const world = productionWorld({
    home,
    appData: join(dir, "app"),
    platform: options.platform ?? "darwin",
  });
  const program = join(home, ".local/bin/openclaw");
  if (options.program !== false) executable(program);
  return { ...world, candidates: [join(dir, "app/openclaw/bin/openclaw"), program] };
}

type Reply = Partial<ProgramResult> | ((request: ProgramRequest) => Partial<ProgramResult>);

/** Answers each command from a table keyed by its arguments, and records every request. */
function fakeRunner(table: Record<string, Reply>) {
  const requests: ProgramRequest[] = [];
  const run = async (request: ProgramRequest): Promise<ProgramResult> => {
    requests.push(request);
    const key = request.args.join(" ");
    const reply = table[key];
    const result = typeof reply === "function" ? reply(request) : reply;
    return {
      exitCode: 0,
      stdout: "",
      timedOut: false,
      tooLarge: false,
      failed: false,
      ...(result ?? { exitCode: 1 }),
    };
  };
  return { run, requests };
}

const defaultTable = (status = statusJson({ port: 18789 }), auth = authJson()) => ({
  "--version": { stdout: VERSION_LINE },
  "gateway status --json": { stdout: status },
  "gateway status --json --deep": { stdout: status },
  "config get gateway.auth.mode --json": { stdout: auth },
});

describe("the look on this computer", () => {
  it("F-492: a running gateway of the tested version is found and named by profile, version, how it listens and its service", async () => {
    const world = homeWorld();
    const { run, requests } = fakeRunner(defaultTable());
    const report = await lookHere(world, run);
    expect(report?.look).toEqual({
      outcome: "running",
      reason: null,
      version: "2026.10.6",
      profile: "default",
      listens: "loopback",
      service: "none",
      port: 18789,
      authMode: null,
      others: [],
    });
    expect(report?.found).toMatchObject({ port: 18789, version: "2026.10.6" });
    expect(report?.found?.profile.args).toEqual([]);
    // Read-only commands only, each an argument array for the program found.
    expect(requests.map((request) => request.args.join(" ")).sort()).toEqual([
      "--version",
      "config get gateway.auth.mode --json",
      "gateway status --json",
      "gateway status --json --deep",
    ]);
    for (const request of requests) {
      expect(request.program).toBe(join(dir, "home/.local/bin/openclaw"));
      expect(Object.keys(request.env).sort()).toEqual(["HOME", "LANG", "NO_COLOR", "PATH"]);
    }
  });

  it("F-492: the service is named as observed: a LaunchAgent, a systemd user service, or none", async () => {
    const running = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, service: "running" }))).run,
    );
    expect(running?.look.service).toBe("launchagent");
    const systemd = await lookHere(
      homeWorld({ platform: "linux" }),
      fakeRunner(defaultTable(statusJson({ port: 18789, service: "running", label: "systemd" })))
        .run,
    );
    expect(systemd?.look.service).toBe("systemd");
    const network = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, bind: "lan" }))).run,
    );
    expect(network?.look.listens).toBe("network");
  });

  it("F-515: another version is named and not offered for Connect", async () => {
    const report = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, answered: "2026.9.37" }))).run,
    );
    expect(report?.look).toMatchObject({ outcome: "untested", version: "2026.9.37" });
    expect(report?.found).toBe(null);
    const newer = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, answered: "2026.11.2" }))).run,
    );
    expect(newer?.look.outcome).toBe("untested");
  });

  it("F-515: a version below the protocol this client speaks is too old", async () => {
    const report = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, answered: "2026.6.2" }))).run,
    );
    expect(report?.look).toMatchObject({ outcome: "too-old", version: "2026.6.2" });
    expect(report?.found).toBe(null);
  });

  it("F-515: a version of the wrong shape is a gateway the look can't tell", async () => {
    const program = await lookHere(
      homeWorld(),
      fakeRunner({ ...defaultTable(), "--version": { stdout: "openclaw version 9\n" } }).run,
    );
    expect(program?.look).toMatchObject({ outcome: "cant-tell", reason: "shape" });
    const gateway = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, answered: "v10; rm -rf" }))).run,
    );
    expect(gateway?.look).toMatchObject({ outcome: "cant-tell", reason: "shape" });
    expect(gateway?.found).toBe(null);
  });

  it("a gateway that signs in another way than a token is named and not connected to", async () => {
    const report = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789 }), authJson("password"))).run,
    );
    expect(report?.look).toMatchObject({ outcome: "not-token", authMode: "password" });
    expect(report?.found).toBe(null);
  });

  it("a gateway started by hand and stopped is installed but not running", async () => {
    const report = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, answered: null }))).run,
    );
    expect(report?.look).toMatchObject({
      outcome: "stopped",
      version: "2026.10.6",
      service: "none",
      port: 18789,
    });
    expect(report?.found).toBe(null);
  });

  it("a registered service that is stopped, with nothing listening, is proven stopped", async () => {
    const report = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, answered: null, service: "stopped" }))).run,
    );
    expect(report?.look).toMatchObject({ outcome: "stopped", service: "launchagent-stopped" });
  });

  it("a service that runs, or a port that is taken, without an answer can't be told", async () => {
    for (const status of [
      statusJson({ port: 18789, answered: null, service: "running" }),
      statusJson({ port: 18789, answered: null, listening: true }),
    ]) {
      const report = await lookHere(homeWorld(), fakeRunner(defaultTable(status)).run);
      expect(report?.look).toMatchObject({ outcome: "cant-tell", reason: "no-answer" });
    }
  });

  it("a step that times out can't be told", async () => {
    const report = await lookHere(
      homeWorld(),
      fakeRunner({ ...defaultTable(), "gateway status --json": { timedOut: true, exitCode: null } })
        .run,
    );
    expect(report?.look).toMatchObject({ outcome: "cant-tell", reason: "timeout" });
  });

  it("a program with no gateway set up can't be told, and offers nothing to connect to", async () => {
    const report = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ configExists: false, answered: null }))).run,
    );
    expect(report?.look).toMatchObject({ outcome: "cant-tell", reason: "not-set-up" });
  });

  it("no program, no ~/.openclaw and no service is not found, and nothing runs", async () => {
    const { run, requests } = fakeRunner({});
    const report = await lookHere(homeWorld({ program: false }), run);
    expect(report?.look.outcome).toBe("not-found");
    expect(requests).toEqual([]);
  });

  it("no program, with ~/.openclaw or a service, is set up with its program missing", async () => {
    const world = homeWorld({ program: false });
    mkdirSync(join(world.home, ".openclaw"));
    expect((await lookHere(world, fakeRunner({}).run))?.look.outcome).toBe("program-missing");
    rmSync(join(world.home, ".openclaw"), { recursive: true });
    mkdirSync(join(world.home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(join(world.home, "Library/LaunchAgents/ai.openclaw.gateway.plist"), "");
    expect((await lookHere(world, fakeRunner({}).run))?.look.outcome).toBe("program-missing");
  });

  it("a file that is not executable is not the program", async () => {
    const world = homeWorld({ program: false });
    mkdirSync(join(world.home, ".local/bin"), { recursive: true });
    writeFileSync(world.candidates[1]!, "not a program");
    expect((await lookHere(world, fakeRunner({}).run))?.look.outcome).toBe("not-found");
  });

  it("on Windows the look doesn't run", async () => {
    const { run, requests } = fakeRunner(defaultTable());
    const report = await lookHere(homeWorld({ platform: "win32" }), run);
    expect(report?.look.outcome).toBe("windows");
    expect(requests).toEqual([]);
  });

  it("F-516: other services and profiles are named and never asked; only the default profile and Clawtrate's own are", async () => {
    const world = homeWorld();
    mkdirSync(join(world.home, ".openclaw-work"));
    mkdirSync(join(world.home, ".openclaw-clawtrate"));
    const status = statusJson({
      port: 18789,
      extraServices: [{ label: "com.example.openclaw-gateway" }, { label: "bad; label" }],
    });
    const { run, requests } = fakeRunner({
      ...defaultTable(status),
      "--profile clawtrate gateway status --json": {
        stdout: statusJson({ port: 19300, answered: null }),
      },
      "--profile clawtrate config get gateway.auth.mode --json": { stdout: authJson() },
    });
    const report = await lookHere(world, run);
    expect(report?.look.outcome).toBe("running");
    expect(report?.look.profile).toBe("default");
    expect(report?.look.others).toEqual(["service com.example.openclaw-gateway", "profile work"]);
    const asked = requests.map((request) => request.args.join(" "));
    expect(asked.filter((args) => args.includes("work"))).toEqual([]);
    expect(asked).toContain("--profile clawtrate gateway status --json");
    // The deep status is read for its other services only, once.
    expect(asked.filter((args) => args.endsWith("--deep"))).toEqual([
      "gateway status --json --deep",
    ]);
  });

  it("F-516: Clawtrate's own profile is chosen when the default profile has no gateway", async () => {
    const world = homeWorld();
    mkdirSync(join(world.home, ".openclaw-clawtrate"));
    const report = await lookHere(
      world,
      fakeRunner({
        ...defaultTable(statusJson({ port: 18789, configExists: false, answered: null })),
        "--profile clawtrate gateway status --json": { stdout: statusJson({ port: 19300 }) },
        "--profile clawtrate config get gateway.auth.mode --json": { stdout: authJson() },
      }).run,
    );
    expect(report?.look).toMatchObject({ outcome: "running", profile: "clawtrate", port: 19300 });
    expect(report?.found?.profile.args).toEqual(["--profile", "clawtrate"]);
  });

  it("F-516: Clawtrate's own profile is not asked when its folder isn't there", async () => {
    const { run, requests } = fakeRunner(defaultTable());
    await lookHere(homeWorld(), run);
    expect(requests.some((request) => request.args.includes("clawtrate"))).toBe(false);
  });
});

describe("the look's sandbox and its guard", () => {
  const sandboxFile = (values: Record<string, unknown>) => {
    const path = join(dir, "sandbox.json");
    writeFileSync(path, JSON.stringify(values));
    return path;
  };
  const sandbox = () => ({
    home: join(dir, "home"),
    openclaw: join(dir, "bin/openclaw"),
    instance: "su1-test",
    stateDir: join(dir, ".openclaw-clawtrate-dev-su1-test"),
  });

  it("refuses a production world in a run that must be sandboxed, before any program starts", () => {
    const world = productionWorld({ home: dir, appData: dir, platform: "darwin" });
    expect(() => guardWorld(world, { sandboxed: true, realHome: dir })).toThrow(SetupRefusedError);
    expect(() => guardWorld(world, { sandboxed: true, realHome: dir })).toThrow(/no sandbox/);
    expect(() => guardWorld(world, { sandboxed: false, realHome: dir })).not.toThrow();
  });

  it("refuses a sandbox whose home is the real home folder or holds it", () => {
    const world = sandboxWorld({ ...sandbox(), home: dir }, "darwin");
    expect(() => guardWorld(world, { sandboxed: true, realHome: dir })).toThrow(/real home/);
    const above = sandboxWorld({ ...sandbox(), home: join(dir, "..") }, "darwin");
    expect(() => guardWorld(above, { sandboxed: true, realHome: dir })).toThrow(/real home/);
  });

  it("refuses a sandbox that would look at the default profile or read its state", () => {
    const real = join(dir, "real");
    mkdirSync(real);
    const world = sandboxWorld(sandbox(), "darwin");
    expect(() => guardWorld(world, { sandboxed: true, realHome: real })).not.toThrow();
    const asDefault = { ...world, profiles: [{ ...world.profiles[0]!, args: [] }] };
    expect(() => guardWorld(asDefault, { sandboxed: true, realHome: real })).toThrow(
      /default profile/,
    );
    const realState = sandboxWorld({ ...sandbox(), stateDir: join(real, ".openclaw") }, "darwin");
    expect(() => guardWorld(realState, { sandboxed: true, realHome: real })).toThrow(
      /default profile's state/,
    );
    const other = {
      ...world,
      profiles: [{ ...world.profiles[0]!, name: "work", args: ["--profile", "work"] }],
    };
    expect(() => guardWorld(other, { sandboxed: true, realHome: real })).toThrow(
      /not a development instance/,
    );
  });

  it("refuses OpenClaw's default port and any port outside the development instances' range", () => {
    const world = sandboxWorld(sandbox(), "darwin");
    expect(() => guardPort(18789, world, true)).toThrow(SetupRefusedError);
    expect(() => guardPort(19001, world, true)).toThrow(SetupRefusedError);
    expect(() => guardPort(19940, world, true)).not.toThrow();
    const production = productionWorld({ home: dir, appData: dir, platform: "darwin" });
    expect(() => guardPort(18789, production, false)).not.toThrow();
    expect(() => guardPort(80, production, false)).toThrow(SetupRefusedError);
  });

  it("reads a sandbox file only when every value has its shape", () => {
    expect(readSandbox(sandboxFile(sandbox()))).toEqual(sandbox());
    expect(() => readSandbox(sandboxFile({ ...sandbox(), instance: "default" }))).toThrow(
      SetupRefusedError,
    );
    expect(() => readSandbox(sandboxFile({ ...sandbox(), home: "relative/home" }))).toThrow(
      SetupRefusedError,
    );
    expect(() => readSandbox("relative.json")).toThrow(SetupRefusedError);
  });

  it("a sandbox's programs get its home and its instance's profile, and nothing else of the caller's", () => {
    const world = sandboxWorld(sandbox(), "darwin");
    expect(world.env).toEqual({ HOME: join(dir, "home"), LANG: "en_US.UTF-8", NO_COLOR: "1" });
    expect(world.profiles).toHaveLength(1);
    expect(world.profiles[0]).toMatchObject({
      name: "clawtrate-dev-su1-test",
      args: ["--profile", "clawtrate-dev-su1-test"],
    });
    expect(world.candidates).toEqual([join(dir, "bin/openclaw")]);
  });

  it("knows an automated run by the checks' markers and a driven app's switches", () => {
    const none = () => false;
    expect(automatedRun({}, none)).toBe(false);
    expect(automatedRun({ CLAWTRATE_E2E_RUN: "0a1b2c3d" }, none)).toBe(true);
    expect(automatedRun({ VITEST: "true" }, none)).toBe(true);
    expect(automatedRun({ CI: "1" }, none)).toBe(true);
    expect(automatedRun({}, (name) => name === "remote-debugging-port")).toBe(true);
    expect(automatedRun({}, (name) => name === "clawtrate-setup-sandbox")).toBe(true);
  });
});
