// F-501 F-502 F-503 F-504 F-505: setting OpenClaw up on this computer
// (docs/design/setup.md §10, §19), against stand-ins only: the downloads are
// served from loopback out of a temporary folder, the installer and
// `openclaw` are scripts of the test's, a stand-in service manager records
// what would be registered, and every folder is under a temporary home. The
// real install runs only on hosted runners (.github/workflows/setup-install.yml).

import type { SetupInstall } from "@clawtrate/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commands,
  computerPlace,
  InstallRefusedError,
  Installer,
  layout,
  onHostedRunner,
  readAnswering,
  readInstallerLine,
  readOnboarding,
  type InstallOptions,
} from "../src/setup/install.ts";
import { installTarget, PINS } from "../src/setup/install-pins.ts";
import { InstallRunner } from "../src/setup/install-runner.ts";
import { standIn, type StandIn } from "./fixtures/install-stand-in.ts";

let open: StandIn[] = [];
afterEach(async () => {
  await Promise.all(open.map((stand) => stand.close()));
  open = [];
});

async function make(options: Parameters<typeof standIn>[0] = {}): Promise<StandIn> {
  const stand = await standIn(options);
  open.push(stand);
  return stand;
}

const runner = new InstallRunner();

function installer(stand: StandIn, extra: Partial<InstallOptions> = {}): Installer {
  return new Installer({
    place: stand.place,
    pins: stand.pins,
    run: (request, check) => runner.run(request, check),
    personsApp: false,
    accountHome: homedir(),
    env: {},
    statusWaitMs: 300,
    sleep: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 50))),
    ...extra,
  });
}

async function runAll(install: Installer) {
  const seen: SetupInstall[] = [];
  const outcome = await install.run((progress) => seen.push(progress));
  return { outcome, seen };
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

describe("F-502 F-503 F-504 F-505: the whole way through", () => {
  it("F-502 F-503 F-504 F-505: downloads and checks both files, installs from the checked tarball with the checked Node.js, onboards the clawtrate profile on a free loopback port with no provider, and waits for its status", async () => {
    const stand = await make();
    const { outcome, seen } = await runAll(installer(stand));
    expect(outcome).toEqual({ ok: true, port: expect.any(Number) });
    const port = (outcome as { port: number }).port;
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).not.toBe(18789);

    // The steps in order, and the Node.js line once the installer reported it used the checked one.
    expect(seen.map((step) => step.step)).toEqual([0, 1, 1, 2, 3, 4]);
    expect(seen.at(-1)).toEqual({ step: 4, nodeChecked: true, failure: null });
    expect(stand.requests).toEqual(expect.arrayContaining(["/openclaw.tgz", "/node.tgz"]));

    // Exactly the installer from the checked tarball, with its path as the version (F-503).
    const at = layout(stand.place, stand.pins);
    expect(stand.calls()).toEqual([
      `install-cli --json --runtime-only --npm --version ${at.tarball} --prefix ${stand.place.programDir}`,
      `openclaw ${[
        "--profile clawtrate onboard --non-interactive --accept-risk --auth-choice skip",
        "--gateway-bind loopback --gateway-auth token",
        `--gateway-port ${port} --install-daemon --skip-skills --json`,
      ].join(" ")}`,
      "openclaw --profile clawtrate gateway status --json",
    ]);
    // F-504: no provider flag and no model key, in the arguments or the environment.
    expect(stand.calls().join(" ")).not.toMatch(/api-key|--token|anthropic|openai/i);
    // The checked Node.js was extracted where the installer looks first.
    expect(existsSync(join(at.nodeDir, "bin", "node"))).toBe(true);

    // F-505: the clawtrate profile's own service, registered once, for this port.
    expect(stand.registered()).toEqual([`register clawtrate ${port}`]);
    expect(existsSync(stand.place.serviceFile)).toBe(true);
    expect(stand.place.serviceFile).toMatch(/ai\.openclaw\.clawtrate\.plist$/);

    // One id in all three records (§10).
    const own = json(stand.place.recordFile);
    const there = json(at.record);
    const owner = json(at.owner);
    expect(own).toMatchObject({
      version: "2026.10.6",
      profile: "clawtrate",
      programDir: stand.place.programDir,
      stateDir: stand.place.stateDir,
      service: "ai.openclaw.clawtrate",
      port,
      stage: "installed",
    });
    expect(there).toEqual({ id: own.id, version: "2026.10.6", profile: "clawtrate" });
    expect(owner).toEqual({ id: own.id });
  });

  it("F-503: npm's configuration is two separate empty files and the public registry, and nothing else of the person's environment reaches the installer", async () => {
    const stand = await make();
    const before = process.env.CLAWTRATE_TEST_SECRET;
    process.env.CLAWTRATE_TEST_SECRET = "must-not-pass";
    try {
      await runAll(installer(stand));
    } finally {
      if (before === undefined) delete process.env.CLAWTRATE_TEST_SECRET;
      else process.env.CLAWTRATE_TEST_SECRET = before;
    }
    const at = layout(stand.place, stand.pins);
    const env = Object.fromEntries(
      stand
        .installerEnv()
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(env.NPM_CONFIG_USERCONFIG).toBe(at.npmUser);
    expect(env.NPM_CONFIG_GLOBALCONFIG).toBe(at.npmGlobal);
    expect(at.npmUser).not.toBe(at.npmGlobal);
    expect(readFileSync(at.npmUser, "utf8")).toBe("");
    expect(readFileSync(at.npmGlobal, "utf8")).toBe("");
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org/");
    expect(env.HOME).toBe(stand.home);
    expect(env.PATH).toBe(`${stand.place.programDir}/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(env.CLAWTRATE_TEST_SECRET).toBeUndefined();
    // Only what the install names, and what bash itself sets.
    const named = new Set([
      "HOME",
      "LANG",
      "NO_COLOR",
      "PATH",
      "NPM_CONFIG_USERCONFIG",
      "NPM_CONFIG_GLOBALCONFIG",
      "npm_config_registry",
    ]);
    const bash = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
    expect(Object.keys(env).filter((key) => !named.has(key) && !bash.has(key))).toEqual([]);
  });

  it("F-505: on Linux the service is the profile's own systemd user unit", async () => {
    const stand = await make({ platform: "linux" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome.ok).toBe(true);
    expect(stand.place.service).toBe("openclaw-gateway-clawtrate.service");
    expect(stand.place.serviceFile).toMatch(
      /\.config\/systemd\/user\/openclaw-gateway-clawtrate\.service$/,
    );
    expect(existsSync(stand.place.serviceFile)).toBe(true);
  });
});

describe("F-502 F-503: each failure, named, with what the attempt left", () => {
  it.each(["openclaw", "node"] as const)(
    "F-503: a %s download that doesn't match its fingerprint stops before anything is extracted or run, and the attempt is removed",
    async (wrong) => {
      const stand = await make({ wrong });
      const { outcome } = await runAll(installer(stand));
      expect(outcome).toEqual({
        ok: false,
        failure: {
          kind: "fingerprint",
          step: 0,
          exitCode: null,
          classification: null,
          retry: true,
        },
      });
      expect(stand.calls()).toEqual([]);
      expect(existsSync(stand.place.programDir)).toBe(false);
      expect(existsSync(stand.place.recordFile)).toBe(false);
      expect(existsSync(stand.place.stateDir)).toBe(false);
    },
  );

  it("F-502: a download that doesn't finish is named, and nothing is run", async () => {
    const stand = await make({ missing: "node" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "download", step: 0, retry: true },
    });
    expect(stand.calls()).toEqual([]);
    expect(existsSync(stand.place.programDir)).toBe(false);
  });

  it("F-503: when the installer's own Node.js check refuses the checked Node.js, the installer never runs and the attempt is removed", async () => {
    const stand = await make({ scenario: "node-unusable" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "node-not-checked", step: 1, retry: true },
    });
    expect(stand.calls()).toEqual([]);
    expect(existsSync(stand.place.programDir)).toBe(false);
  });

  it("F-503: an installer whose Node.js step doesn't report skip is stopped at once, and the attempt is removed", async () => {
    const stand = await make({ scenario: "node-start" });
    const started = Date.now();
    const { outcome, seen } = await runAll(installer(stand));
    // The stand-in would sleep 20 s after "start"; it was ended when it said it.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "node-not-checked", step: 1, retry: true },
    });
    expect(seen.some((step) => step.nodeChecked)).toBe(false);
    expect(stand.calls().filter((line) => line.startsWith("openclaw"))).toEqual([]);
    expect(existsSync(stand.place.programDir)).toBe(false);
  });

  it("F-502: an installer that stops names its exit code, and the attempt is removed", async () => {
    const stand = await make({ scenario: "installer-fails" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: "installer", step: 1, exitCode: 1, classification: null, retry: true },
    });
    expect(existsSync(stand.place.programDir)).toBe(false);
  });

  it("F-502: onboarding's failure class is kept, and once onboarding has begun nothing is removed and trying again isn't offered", async () => {
    const stand = await make({ scenario: "onboard-fails" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: "onboard",
        step: 2,
        exitCode: 1,
        classification: "startup-blocked",
        retry: false,
      },
    });
    expect(existsSync(stand.place.programDir)).toBe(true);
    expect(json(stand.place.recordFile)).toMatchObject({ stage: "onboarding" });
    // A later install refuses while it is there.
    const again = await runAll(installer(stand));
    expect(again.outcome).toMatchObject({ ok: false, failure: { kind: "exists", step: -1 } });
  });

  it("F-502: a session that can't run a systemd user service is named", async () => {
    const stand = await make({ scenario: "onboard-no-daemon", platform: "linux" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "onboard", step: 2, classification: "systemd-user-unavailable" },
    });
  });

  it("F-502: a gateway that doesn't answer within the wait is named at the last step", async () => {
    const stand = await make({ scenario: "not-answering" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "not-answering", step: 3, retry: false },
    });
    expect(
      stand.calls().filter((line) => line.endsWith("gateway status --json")).length,
    ).toBeGreaterThan(1);
  });
});

describe("F-501 F-502: nothing there before, and the narrowed retry", () => {
  it.each([
    ["the profile's state folder", (stand: StandIn) => mkdirSync(stand.place.stateDir)],
    [
      "the profile's service",
      (stand: StandIn) => {
        mkdirSync(join(stand.place.serviceFile, ".."), { recursive: true });
        writeFileSync(stand.place.serviceFile, "someone's");
      },
    ],
    [
      "a program folder without Clawtrate's records",
      (stand: StandIn) => mkdirSync(stand.place.programDir),
    ],
  ])(
    "F-501: with %s already there it refuses before downloading anything",
    async (_name, plant) => {
      const stand = await make();
      plant(stand);
      const { outcome } = await runAll(installer(stand));
      expect(outcome).toEqual({
        ok: false,
        failure: { kind: "exists", step: -1, exitCode: null, classification: null, retry: false },
      });
      expect(stand.requests).toEqual([]);
      expect(stand.calls()).toEqual([]);
    },
  );

  it("F-502: an attempt of Clawtrate's that never reached onboarding, left by an earlier run, is proven and removed, and the install goes on", async () => {
    const stand = await make();
    mkdirSync(stand.place.programDir, { recursive: true });
    writeFileSync(join(stand.place.programDir, "partial"), "x");
    const record = {
      id: "0c6b1a52-1111-4222-8333-944455556666",
      version: "2026.10.6",
      profile: "clawtrate",
      programDir: stand.place.programDir,
      stateDir: stand.place.stateDir,
      service: stand.place.service,
      port: null,
      stage: "installing",
    };
    writeFileSync(stand.place.recordFile, JSON.stringify(record));
    writeFileSync(
      join(stand.place.programDir, ".clawtrate-install.json"),
      JSON.stringify({ id: record.id, version: "2026.10.6", profile: "clawtrate" }),
    );
    const install = installer(stand);
    expect(await install.site()).toBe("leftover");
    const { outcome } = await runAll(install);
    expect(outcome.ok).toBe(true);
    expect(existsSync(join(stand.place.programDir, "partial"))).toBe(false);
    expect(json(stand.place.recordFile).id).not.toBe(record.id);
  });

  it("F-502: an attempt whose records disagree, or that reached onboarding, is never removed", async () => {
    const stand = await make();
    mkdirSync(stand.place.programDir, { recursive: true });
    const record = { id: "a", profile: "clawtrate", programDir: stand.place.programDir };
    writeFileSync(stand.place.recordFile, JSON.stringify({ ...record, stage: "onboarding" }));
    writeFileSync(join(stand.place.programDir, ".clawtrate-install.json"), JSON.stringify(record));
    const install = installer(stand);
    expect(await install.site()).toBe("exists");
    expect(await install.discard()).toBe(false);
    writeFileSync(
      stand.place.recordFile,
      JSON.stringify({ ...record, id: "b", stage: "installing" }),
    );
    expect(await install.site()).toBe("exists");
    expect(await install.discard()).toBe(false);
    expect(existsSync(stand.place.programDir)).toBe(true);
  });
});

describe("F-501 F-503: what may run, and where", () => {
  it("F-501: a real install refuses to start outside a person's app or a hosted runner, before anything is downloaded", async () => {
    let downloads = 0;
    let runs = 0;
    const place = computerPlace({
      home: "/nonexistent-home",
      appData: "/nonexistent-app-data",
      platform: "darwin",
      target: "darwin-arm64",
      env: {},
    });
    const install = new Installer({
      place,
      pins: PINS,
      run: async () => {
        runs += 1;
        throw new Error("must not run");
      },
      personsApp: false,
      accountHome: homedir(),
      env: {
        CI: "true",
        GITHUB_ACTIONS: "true",
        VITEST: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
      },
      download: async () => {
        downloads += 1;
        return null;
      },
    });
    await expect(install.run(() => {})).rejects.toBeInstanceOf(InstallRefusedError);
    expect(downloads + runs).toBe(0);
    expect(
      onHostedRunner({ CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" }),
    ).toBe(true);
    expect(
      onHostedRunner({ CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }),
    ).toBe(false);
    expect(onHostedRunner({ CI: "true" })).toBe(false);
  });

  it("F-501: a stand-in refuses a home outside the system's temporary root, or downloads from anywhere but loopback", async () => {
    const stand = await make();
    const outside = installer(stand, {
      place: { ...stand.place, home: homedir() },
    });
    await expect(outside.run(() => {})).rejects.toBeInstanceOf(InstallRefusedError);
    const remote = installer(stand, {
      pins: {
        ...stand.pins,
        openclaw: { ...stand.pins.openclaw, url: "https://registry.npmjs.org/x.tgz" },
      },
    });
    await expect(remote.run(() => {})).rejects.toBeInstanceOf(InstallRefusedError);
    expect(stand.requests).toEqual([]);
  });

  it("F-503: the runner starts only the install's own commands, for this place", async () => {
    const stand = await make();
    const asked: string[][] = [];
    const install = installer(stand, {
      run: async (request, check) => {
        asked.push([request.program, ...request.args]);
        // The same command with one argument changed is refused before it starts.
        expect(() => check({ ...request, args: [...request.args, "--onboard"] })).toThrow(
          /doesn't run/,
        );
        expect(() => check({ ...request, program: "/bin/sh" })).toThrow(/doesn't run/);
        check(request);
        return runner.run(request, check);
      },
    });
    const { outcome } = await runAll(install);
    expect(outcome.ok).toBe(true);
    const port = (outcome as { port: number }).port;
    const allowed = commands(stand.place, stand.pins, port).map((command) => [
      command.program,
      ...command.args,
    ]);
    for (const command of asked) expect(allowed).toContainEqual(command);
    expect(asked.map((command) => command[0])).toEqual([
      "/usr/bin/tar",
      "/usr/bin/tar",
      "/bin/bash",
      "/bin/bash",
      layout(stand.place, stand.pins).openclaw,
      layout(stand.place, stand.pins).openclaw,
    ]);
  });

  it("F-501: the systems offered are macOS and glibc Linux on arm64 and x64, and nothing else", () => {
    expect(installTarget("darwin", "arm64", false)).toBe("darwin-arm64");
    expect(installTarget("darwin", "x64", false)).toBe("darwin-x64");
    expect(installTarget("linux", "x64", true)).toBe("linux-x64");
    expect(installTarget("linux", "arm64", true)).toBe("linux-arm64");
    expect(installTarget("linux", "x64", false)).toBeNull();
    expect(installTarget("win32", "x64", false)).toBeNull();
    expect(installTarget("freebsd", "x64", false)).toBeNull();
    expect(installTarget("linux", "arm", true)).toBeNull();
  });

  it("F-503: the pins are OpenClaw 2026.10.6's published integrity and Node.js 24.22.1's published SHA-256", () => {
    expect(PINS.version).toBe("2026.10.6");
    expect(PINS.openclaw.url).toBe("https://registry.npmjs.org/openclaw/-/openclaw-2026.10.6.tgz");
    expect(PINS.openclaw.integrity).toMatch(/^sha512-jSpQPa2J[A-Za-z0-9+/]+qrxwA==$/);
    expect(PINS.nodeVersion).toBe("24.22.1");
    for (const [target, node] of Object.entries(PINS.node)) {
      expect(node.url).toBe(`https://nodejs.org/dist/v24.22.1/node-v24.22.1-${target}.tar.gz`);
      expect(node.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("F-502 F-503 F-505: reading what the programs print", () => {
  it("F-503: the installer's NDJSON: the Node.js step and done; anything else is ignored", () => {
    let seen = { node: null, done: false, version: null } as Parameters<
      typeof readInstallerLine
    >[0];
    for (const line of [
      "added 345 packages",
      '{"event":"step","name":"node","status":"skip","path":"/p/tools/node-v24.22.1"}',
      "{not json",
      '{"event":"error","message":"x"}',
      '{"event":"done","ok":true,"version":"OpenClaw 2026.10.6 (fe06181)"}',
    ])
      seen = readInstallerLine(seen, line);
    expect(seen).toEqual({ node: "skip", done: true, version: "OpenClaw 2026.10.6 (fe06181)" });
    expect(readInstallerLine(seen, '{"event":"step","name":"node","status":"start"}').node).toBe(
      "start",
    );
  });

  it("F-505: onboarding counts only a loopback gateway on the chosen port with token sign-in and its service installed", () => {
    const ok = (gateway: object, daemon = true) =>
      JSON.stringify({ ok: true, gateway, daemonInstall: { requested: true, installed: daemon } });
    const good = { port: 40001, bind: "loopback", authMode: "token" };
    expect(readOnboarding(ok(good), 40001)).toEqual({ ok: true });
    expect(readOnboarding(ok(good), 40002).ok).toBe(false);
    expect(readOnboarding(ok({ ...good, bind: "lan" }), 40001).ok).toBe(false);
    expect(readOnboarding(ok({ ...good, authMode: "none" }), 40001).ok).toBe(false);
    expect(readOnboarding(ok(good, false), 40001).ok).toBe(false);
    expect(readOnboarding("banner\n" + ok(good), 40001)).toEqual({ ok: true });
    expect(readOnboarding('{"ok":false,"classification":"not-listening"}', 40001)).toEqual({
      ok: false,
      classification: "not-listening",
    });
    expect(readOnboarding('{"ok":false,"classification":"made-up"}', 40001)).toEqual({
      ok: false,
      classification: null,
    });
  });

  it("F-505: the status counts only an answering gateway of the tested version on the chosen port", () => {
    const status = (rpc: boolean, version: string, port: number) =>
      JSON.stringify({ rpc: { ok: rpc }, gateway: { version, port } });
    expect(readAnswering(status(true, "2026.10.6", 40001), 40001, "2026.10.6")).toBe(true);
    expect(readAnswering(status(false, "2026.10.6", 40001), 40001, "2026.10.6")).toBe(false);
    expect(readAnswering(status(true, "2026.9.37", 40001), 40001, "2026.10.6")).toBe(false);
    expect(readAnswering(status(true, "2026.10.6", 18789), 40001, "2026.10.6")).toBe(false);
  });
});
