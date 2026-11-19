// The look on this computer (docs/design/setup.md §4, §6), from recorded
// command outputs: every result, what each runs, and the guard that keeps
// an automated run away from the real computer. No program runs here: a
// fake runner answers from the recordings.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lookHere } from "../src/setup/look.ts";
import { MARKER_FILE } from "../../../tools/dev-gateway/src/state-guard.ts";
import { checkRequest, type ProgramRequest, type ProgramResult } from "../src/setup/programs.ts";
import {
  emptyWorld,
  guardPort,
  guardWorld,
  isStandIn,
  mustSandbox,
  productionWorld,
  readSandbox,
  SANDBOX_MARKERS,
  SANDBOX_SWITCHES,
  sandboxWorld,
  SetupRefusedError,
  STAND_IN_MARK,
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
    // Every request the look makes is one the host's runner would start.
    checkRequest(request);
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
      access: "new",
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

  it("F-516: a found gateway is identified by its profile, config path, service, port and answer", async () => {
    const report = await lookHere(homeWorld(), fakeRunner(defaultTable()).run);
    expect(report?.found).toMatchObject({
      configPath: "<state>/openclaw.json",
      port: 18789,
      version: "2026.10.6",
    });
    expect(report?.found?.profile.name).toBe("default");
    expect(report?.look.service).toBe("none");
  });

  it("runs every program in the world's own working folder, never the app's", async () => {
    const world = homeWorld();
    const { run, requests } = fakeRunner(defaultTable());
    await lookHere(world, run);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.cwd).toBe(world.home);
  });

  it("F-516: a sandboxed look never runs the deep status", async () => {
    const program = join(dir, "bin/openclaw");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(program, `#!/bin/sh\n# ${STAND_IN_MARK}\n`);
    chmodSync(program, 0o755);
    mkdirSync(join(dir, "home"), { recursive: true });
    const world = sandboxWorld(
      {
        home: join(dir, "home"),
        openclaw: program,
        instance: "su1-test",
        stateDir: join(dir, "state"),
      },
      "darwin",
    );
    const prefix = "--profile clawtrate-dev-su1-test ";
    const { run, requests } = fakeRunner(
      Object.fromEntries(
        Object.entries(defaultTable(statusJson({ port: 19940 }))).map(([k, v]) => [prefix + k, v]),
      ),
    );
    const report = await lookHere(world, run);
    expect(report?.look.outcome).toBe("running");
    expect(requests.some((request) => request.args.includes("--deep"))).toBe(false);
  });

  it("F-492 F-516: a gateway that answered somewhere other than its own loopback port isn't offered", async () => {
    for (const status of [
      statusJson({ port: 18789, rpcUrl: "ws://127.0.0.1:18790" }),
      statusJson({ port: 18789, probeUrl: "ws://127.0.0.1:18790" }),
      statusJson({ port: 18789, rpcUrl: "wss://127.0.0.1:18789" }),
      statusJson({ port: 18789, probeUrl: "ws://192.0.2.10:18789" }),
    ]) {
      const report = await lookHere(homeWorld(), fakeRunner(defaultTable(status)).run);
      expect(report?.look).toMatchObject({ outcome: "cant-tell", reason: "endpoint" });
      expect(report?.found).toBe(null);
    }
  });

  it("F-516: a bind or a service the status doesn't describe is not reported, never a fact", async () => {
    const odd = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, bind: "mystery" }))).run,
    );
    expect(odd?.look.listens).toBe(null);
    const unknown = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, label: "Something else" }))).run,
    );
    expect(unknown?.look.service).toBe(null);
    const diagnostic = await lookHere(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, service: "unknown" }))).run,
    );
    expect(diagnostic?.look.service).toBe(null);
  });

  it("F-516: a file named like a profile's folder is not a profile", async () => {
    const world = homeWorld();
    writeFileSync(join(world.home, ".openclaw-work"), "not a folder");
    symlinkSync(join(dir, "app"), join(world.home, ".openclaw-linked"));
    const report = await lookHere(world, fakeRunner(defaultTable()).run);
    expect(report?.look.others).toEqual([]);
  });

  it("a program that can't be started is its own result, not an answer of the wrong shape", async () => {
    for (const reply of [{ failed: true, exitCode: null }, { exitCode: 127 }, { exitCode: 126 }]) {
      const report = await lookHere(
        homeWorld(),
        fakeRunner({ ...defaultTable(), "--version": reply }).run,
      );
      expect(report?.look.outcome).toBe("cant-run");
    }
  });

  it("F-516: Clawtrate's own profile is not asked when its folder isn't there", async () => {
    const { run, requests } = fakeRunner(defaultTable());
    await lookHere(homeWorld(), run);
    expect(requests.some((request) => request.args.includes("clawtrate"))).toBe(false);
  });
});

describe("the look's sandbox and its guard", () => {
  /** A fake account: its home, with a default state folder in it. */
  const account = () => {
    const home = join(dir, "account");
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    return home;
  };
  const standIn = (path: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `#!/bin/sh\n# ${STAND_IN_MARK}\nexit 0\n`);
    chmodSync(path, 0o755);
    return path;
  };
  /** A sandbox outside the account, with an instance state folder and its marker. */
  const sandbox = (port: number | null = 19940) => {
    const stateDir = join(dir, ".openclaw-clawtrate-dev-su1-test");
    mkdirSync(stateDir, { recursive: true });
    if (port !== null)
      writeFileSync(
        join(stateDir, MARKER_FILE),
        JSON.stringify({
          createdBy: "clawtrate tools/dev-gateway",
          instance: "su1-test",
          gatewayPort: port,
        }),
      );
    mkdirSync(join(dir, "home"), { recursive: true });
    return {
      home: join(dir, "home"),
      openclaw: standIn(join(dir, "bin/openclaw")),
      instance: "su1-test",
      stateDir,
    };
  };
  const guard =
    (world: LookWorld, home = account()) =>
    () =>
      guardWorld(world, { realHome: home });

  it("passes a sandbox entirely outside the account, with the stand-in and this run's instance", () => {
    expect(guard(sandboxWorld(sandbox(), "darwin"))).not.toThrow();
  });

  it("refuses a sandbox home that is the account's home, above it, or inside it", () => {
    const home = account();
    for (const at of [home, dir, join(home, "sandbox-home")]) {
      mkdirSync(at, { recursive: true });
      expect(guard(sandboxWorld({ ...sandbox(), home: at }, "darwin"), home)).toThrow(
        /its home is not outside the real home folder/,
      );
    }
  });

  it("refuses programs whose HOME, or whose working folder, is in the account's home, even with a home outside", () => {
    const home = account();
    const world = sandboxWorld(sandbox(), "darwin");
    expect(guard({ ...world, env: { ...world.env, HOME: join(home, "x") } }, home)).toThrow(
      /programs' HOME/,
    );
    expect(guard({ ...world, cwd: join(home, "x") }, home)).toThrow(/working folder/);
  });

  it("refuses a sandbox that would run the deep status", () => {
    expect(guard({ ...sandboxWorld(sandbox(), "darwin"), deep: true })).toThrow(/deep status/);
  });

  it("refuses the default profile, another profile, and an instance that isn't this run's", () => {
    const world = sandboxWorld(sandbox(), "darwin");
    const profile = world.profiles[0]!;
    expect(guard({ ...world, profiles: [{ ...profile, args: [] }] })).toThrow(/default profile/);
    expect(
      guard({ ...world, profiles: [{ ...profile, name: "work", args: ["--profile", "work"] }] }),
    ).toThrow(/not this run's development instance/);
    const shared = "clawtrate-dev-preview-accounts";
    expect(
      guard({ ...world, profiles: [{ ...profile, name: shared, args: ["--profile", shared] }] }),
    ).toThrow(/not this run's development instance/);
  });

  it("refuses the account's default state, as written, through a link, and when it is itself a link", () => {
    const home = account();
    expect(
      guard(sandboxWorld({ ...sandbox(), stateDir: join(home, ".openclaw") }, "darwin"), home),
    ).toThrow(/default profile's state/);
    symlinkSync(join(home, ".openclaw"), join(dir, "linked-state"));
    expect(
      guard(sandboxWorld({ ...sandbox(), stateDir: join(dir, "linked-state") }, "darwin"), home),
    ).toThrow(/default profile's state/);
    // An account whose default state is a link to a folder elsewhere: that folder is the default state.
    const moved = join(dir, "moved-account");
    mkdirSync(join(moved, "elsewhere"), { recursive: true });
    symlinkSync(join(moved, "elsewhere"), join(moved, ".openclaw"));
    expect(
      guard(sandboxWorld({ ...sandbox(), stateDir: join(moved, "elsewhere") }, "darwin"), moved),
    ).toThrow(/default profile's state/);
  });

  it("refuses a state folder whose config file is a link", () => {
    const box = sandbox();
    writeFileSync(join(dir, "other.json"), "{}");
    symlinkSync(join(dir, "other.json"), join(box.stateDir, "openclaw.json"));
    expect(guard(sandboxWorld(box, "darwin"))).toThrow(/config file is a link/);
  });

  it("refuses a program inside the account's default state, or reached through a link into it", () => {
    const home = account();
    const inside = standIn(join(home, ".openclaw/bin/openclaw"));
    expect(guard(sandboxWorld({ ...sandbox(), openclaw: inside }, "darwin"), home)).toThrow(
      /inside the real default profile's state/,
    );
    symlinkSync(inside, join(dir, "linked-openclaw"));
    expect(
      guard(sandboxWorld({ ...sandbox(), openclaw: join(dir, "linked-openclaw") }, "darwin"), home),
    ).toThrow(/inside the real default profile's state/);
  });

  it("refuses a program that is not the repository's stand-in, and takes one that doesn't exist", () => {
    const real = executable(join(dir, "bin/real-openclaw"));
    expect(guard(sandboxWorld({ ...sandbox(), openclaw: real }, "darwin"))).toThrow(/stand-in/);
    expect(isStandIn(real)).toBe(false);
    expect(
      guard(sandboxWorld({ ...sandbox(), openclaw: join(dir, "bin/none") }, "darwin")),
    ).not.toThrow();
  });

  it("lets a sandbox use its instance's own recorded port only, and never OpenClaw's default", () => {
    const world = sandboxWorld(sandbox(19940), "darwin");
    expect(() => guardPort(19940, world, true)).not.toThrow();
    expect(() => guardPort(19960, world, true)).toThrow(SetupRefusedError);
    expect(() => guardPort(19600, world, true)).toThrow(SetupRefusedError);
    rmSync(join(sandbox().stateDir, MARKER_FILE), { force: true });
    expect(() => guardPort(19940, sandboxWorld(sandbox(null), "darwin"), true)).toThrow(
      SetupRefusedError,
    );
    // The sandboxed run's own rule holds whatever the world allows.
    const open = { ...world, portAllowed: () => true };
    expect(() => guardPort(18789, open, true)).toThrow(/not a development instance's/);
    expect(() => guardPort(19001, open, true)).toThrow(/not a development instance's/);
    expect(() => guardPort(18789, open, false)).not.toThrow();
  });

  it("reads a sandbox file only from the temporary folder, a regular file, every value with its shape", () => {
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const file = (name: string, values: Record<string, unknown>) => {
      const path = join(allowed, name);
      writeFileSync(path, JSON.stringify(values));
      return path;
    };
    const values = sandbox();
    expect(readSandbox(file("ok.json", values), [allowed])).toEqual(values);
    const outside = join(dir, "outside.json");
    writeFileSync(outside, JSON.stringify(values));
    expect(() => readSandbox(outside, [allowed])).toThrow(/temporary folder/);
    symlinkSync(outside, join(allowed, "link.json"));
    expect(() => readSandbox(join(allowed, "link.json"), [allowed])).toThrow(SetupRefusedError);
    for (const instance of ["default", "dev", "preview-accounts"]) {
      expect(() =>
        readSandbox(file(`${instance}.json`, { ...values, instance }), [allowed]),
      ).toThrow(SetupRefusedError);
    }
    expect(() => readSandbox(file("rel.json", { ...values, home: "relative" }), [allowed])).toThrow(
      SetupRefusedError,
    );
    expect(() => readSandbox("relative.json", [allowed])).toThrow(SetupRefusedError);
  });

  it("a sandbox's programs get its home, its working folder and its instance's profile, and no deep status", () => {
    const world = sandboxWorld(sandbox(), "darwin");
    expect(world.env).toEqual({ HOME: join(dir, "home"), LANG: "en_US.UTF-8", NO_COLOR: "1" });
    expect(world.cwd).toBe(join(dir, "home"));
    expect(world.deep).toBe(false);
    expect(world.profiles).toHaveLength(1);
    expect(world.profiles[0]).toMatchObject({
      name: "clawtrate-dev-su1-test",
      args: ["--profile", "clawtrate-dev-su1-test"],
    });
    expect(emptyWorld("darwin")).toMatchObject({ candidates: [], profiles: [], deep: false });
  });

  it("must sandbox a development build, any marker present at all, any switch, and a sandbox named by the environment", () => {
    const none = () => false;
    expect(mustSandbox({ packaged: true, env: {}, switches: none })).toBe(false);
    expect(mustSandbox({ packaged: false, env: {}, switches: none })).toBe(true);
    for (const key of SANDBOX_MARKERS) {
      expect(mustSandbox({ packaged: true, env: { [key]: "" }, switches: none }), key).toBe(true);
    }
    for (const name of SANDBOX_SWITCHES) {
      expect(mustSandbox({ packaged: true, env: {}, switches: (n) => n === name }), name).toBe(
        true,
      );
    }
    expect(SANDBOX_MARKERS).toContain("CLAWTRATE_SETUP_SANDBOX");
  });
});
