// F-501 F-502 F-503 F-504 F-505: setting OpenClaw up on this computer
// (docs/design/setup.md §10, §19), against stand-ins only: the downloads are
// served from loopback out of a temporary folder, the installer and
// `openclaw` are scripts of the test's, a stand-in service manager answers
// for launchd or systemd, and every folder is under a temporary home. The
// real install runs only on hosted runners (.github/workflows/setup-install.yml).
//
// Each case below fails without the code it names: the comment beside it
// says what it would catch.

import type { SetupInstall } from "@clawtrate/core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commands,
  computerPlace,
  download,
  InstallRefusedError,
  Installer,
  layout,
  NODE_STEP,
  onboardingFacts,
  onHostedRunner,
  patchInstaller,
  readAnswering,
  readInstallerLine,
  readOnboarding,
  readServiceInstall,
  runsCheckedInstall,
  serviceArgv,
  type InstallOptions,
} from "../src/setup/install.ts";
import { installTarget, PINS } from "../src/setup/install-pins.ts";
import { InstallRunner, type InstallRequest } from "../src/setup/install-runner.ts";
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

/** An installer for a stand-in; `asked` collects every program it was allowed to start. */
function installer(
  stand: StandIn,
  extra: Partial<InstallOptions> = {},
  asked: InstallRequest[] = [],
): Installer {
  return new Installer({
    place: stand.place,
    pins: stand.pins,
    run: (request, check) => {
      check(request);
      asked.push(request);
      return runner.run(request, check);
    },
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
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Every file under a folder with its bytes: what a refusal must leave exactly as it was. */
function inventory(dir: string): string {
  if (!existsSync(dir)) return "(absent)";
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(`${path} ${readFileSync(path, "base64")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

describe("F-502 F-503 F-504 F-505: the whole way through", () => {
  it("F-502 F-503 F-504 F-505: downloads and checks both files, installs from the checked tarball with the checked Node.js, writes the profile's config, installs its service on its own, and waits for its status", async () => {
    const stand = await make();
    const { outcome, seen } = await runAll(installer(stand));
    expect(outcome).toMatchObject({ ok: true, port: expect.any(Number) });
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
        `--gateway-port ${port} --no-install-daemon --skip-health --skip-skills --json`,
      ].join(" ")}`,
      `openclaw --profile clawtrate gateway install --port ${port} --json`,
      "openclaw --profile clawtrate gateway status --json",
    ]);
    // OpenClaw's onboarding service install, the path to its lingering helper, is never asked for.
    expect(stand.marked("linger-reached")).toBe(false);
    // F-504: no provider flag and no model key, in the arguments or the environment.
    expect(stand.calls().join(" ")).not.toMatch(/api-key|--token|anthropic|openai/i);
    // The downloads left staging only once checked; the checked Node.js is where the installer looks.
    expect(existsSync(at.staging)).toBe(false);
    expect(existsSync(at.tarball) && existsSync(at.nodeTarball)).toBe(true);
    expect(existsSync(join(at.nodeDir, "bin", "node"))).toBe(true);

    // F-505: the clawtrate profile's own service, registered once, for this port, running this install.
    expect(stand.registered()).toEqual([`register clawtrate ${port}`]);
    expect(stand.place.serviceFile).toMatch(/ai\.openclaw\.clawtrate\.plist$/);
    const argv = serviceArgv("darwin", readFileSync(stand.place.serviceFile, "utf8"));
    expect(argv && runsCheckedInstall(argv, stand.place, stand.pins, port)).toBe(true);
    expect(await installer(stand).owned(port)).toBe(true);

    // One id, version, profile and stage in all three records (§10).
    const own = json(stand.place.recordFile);
    expect(own).toMatchObject({
      version: "2026.10.6",
      profile: "clawtrate",
      programDir: stand.place.programDir,
      stateDir: stand.place.stateDir,
      service: "ai.openclaw.clawtrate",
      port,
      stage: "installed",
    });
    expect(json(at.record)).toEqual({
      id: own.id,
      version: "2026.10.6",
      profile: "clawtrate",
      stage: "installed",
    });
    expect(json(at.owner)).toEqual({ id: own.id });
  });

  it("F-503: npm's configuration is two separate empty files, its own cache in the program folder and the public registry, and nothing else of the person's environment reaches the installer", async () => {
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
    expect(env.NPM_CONFIG_CACHE).toBe(at.npmCache);
    expect(at.npmCache.startsWith(`${stand.place.programDir}/`)).toBe(true);
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
      "NPM_CONFIG_CACHE",
      "npm_config_registry",
    ]);
    const bash = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
    expect(Object.keys(env).filter((key) => !named.has(key) && !bash.has(key))).toEqual([]);
  });

  it("F-505: on Linux the user manager is asked first, and the service is the profile's own systemd user unit, running this install from a folder whose name has a space", async () => {
    const stand = await make({ platform: "linux" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome.ok).toBe(true);
    const port = (outcome as { port: number }).port;
    expect(stand.manager()[0]).toBe("manager --user show --property=Version --value");
    expect(stand.place.service).toBe("openclaw-gateway-clawtrate.service");
    expect(stand.place.serviceFile).toMatch(
      /\.config\/systemd\/user\/openclaw-gateway-clawtrate\.service$/,
    );
    expect(stand.place.programDir).toContain("App Data");
    const argv = serviceArgv("linux", readFileSync(stand.place.serviceFile, "utf8"));
    expect(argv?.slice(-3)).toEqual(["gateway", "--port", String(port)]);
    expect(argv && runsCheckedInstall(argv, stand.place, stand.pins, port)).toBe(true);
    expect(stand.marked("linger-reached")).toBe(false);
  });
});

describe("F-502 F-503: each failure, named, with what the attempt left", () => {
  it.each(["openclaw", "node"] as const)(
    "F-503: a %s download that doesn't match its fingerprint stops before anything is extracted or run, and the attempt is removed",
    async (wrong) => {
      const stand = await make({ wrong });
      const asked: InstallRequest[] = [];
      const { outcome } = await runAll(installer(stand, {}, asked));
      expect(outcome).toEqual({
        ok: false,
        failure: {
          kind: "fingerprint",
          step: 0,
          exitCode: null,
          classification: null,
          retry: true,
          cleanup: "removed",
        },
      });
      // Nothing was unpacked: extracting before the comparison would show here.
      expect(asked.filter((request) => request.program === stand.place.tar)).toEqual([]);
      expect(stand.calls()).toEqual([]);
      expect(existsSync(stand.place.programDir)).toBe(false);
      expect(existsSync(stand.place.recordFile)).toBe(false);
      expect(existsSync(stand.place.stateDir)).toBe(false);
    },
  );

  it.each([
    ["missing", "download"],
    ["redirect", "download"],
    ["partial", "download"],
    ["short", "download-short"],
  ] as const)(
    "F-502: a download answered %s is named %s, nothing is run, and the attempt is removed",
    async (as, kind) => {
      const stand = await make({ serve: { name: "node", as } });
      const asked: InstallRequest[] = [];
      const { outcome } = await runAll(installer(stand, {}, asked));
      expect(outcome).toMatchObject({
        ok: false,
        failure: { kind, step: 0, retry: true, cleanup: "removed" },
      });
      // A redirect is never followed: the server was asked once for it.
      expect(stand.requests.filter((path) => path === "/node.tgz")).toHaveLength(1);
      expect(asked.filter((request) => request.program === stand.place.tar)).toEqual([]);
      expect(existsSync(stand.place.programDir)).toBe(false);
    },
  );

  it("F-502: a disk that fills while a download is saved is named as space, not the network", async () => {
    const stand = await make();
    const { outcome } = await runAll(
      installer(stand, { download: async () => ({ ok: false, why: "space" }) }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "download-space", step: 0, retry: true, cleanup: "removed" },
    });
    expect(existsSync(stand.place.programDir)).toBe(false);
  });

  it("F-503: when the installer's own Node.js check refuses the checked Node.js, the installer never runs and the attempt is removed", async () => {
    const stand = await make({ scenario: "node-unusable" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "node-not-checked", step: 1, retry: true, cleanup: "removed" },
    });
    expect(stand.calls()).toEqual([]);
    expect(existsSync(stand.place.programDir)).toBe(false);
  });

  it("F-503: when the first Node.js check passes and the installer's own second check fails, the installer ends before its Node.js download", async () => {
    const stand = await make({ scenario: "node-second-check-fails" });
    const { outcome, seen } = await runAll(installer(stand));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "node-not-checked", step: 1, retry: true },
    });
    expect(stand.calls()[0]).toMatch(/^install-cli /);
    // Without the change to the installer's copy, its fallback starts here.
    expect(stand.marked("fallback-fetched")).toBe(false);
    expect(seen.some((step) => step.nodeChecked)).toBe(false);
  });

  it("F-503: an installer whose Node.js step isn't the one this build changes never runs", async () => {
    const stand = await make({ scenario: "installer-unpatchable" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "installer-changed", step: 1, retry: true },
    });
    expect(stand.calls()).toEqual([]);
  });

  it("F-503: an installer that reports starting Node.js itself is stopped at once, and the attempt is removed", async () => {
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
      failure: {
        kind: "installer",
        step: 1,
        exitCode: 1,
        classification: null,
        retry: true,
        cleanup: "removed",
      },
    });
    expect(existsSync(stand.place.programDir)).toBe(false);
  });

  it("F-502: a program the installer left running is ended with it, so nothing appears after the attempt is removed", async () => {
    const stand = await make({ scenario: "descendant" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "installer", cleanup: "removed" },
    });
    expect(existsSync(stand.place.programDir)).toBe(false);
    // The stand-in's descendant would write 3 s after it started.
    await pause(3_500);
    expect(existsSync(stand.place.programDir)).toBe(false);
    expect(stand.marked("late")).toBe(false);
  }, 30_000);

  it("F-503: an installed program that isn't the checked tarball's is refused before onboarding", async () => {
    const stand = await make({ scenario: "wrong-program" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "no-program", step: 1, retry: true, cleanup: "removed" },
    });
    expect(stand.calls().filter((line) => line.startsWith("openclaw"))).toEqual([]);
  });

  it.each(["state-before-onboard", "service-before-onboard"] as const)(
    "F-501: a clawtrate profile or service that appears while the installer runs (%s) stops it before onboarding, and is left exactly as it came",
    async (scenario) => {
      const stand = await make({ scenario });
      const { outcome } = await runAll(installer(stand));
      expect(outcome).toMatchObject({
        ok: false,
        failure: { kind: "changed", step: 2, retry: false, cleanup: "removed" },
      });
      expect(stand.calls().filter((line) => line.startsWith("openclaw"))).toEqual([]);
      if (scenario === "state-before-onboard")
        expect(inventory(stand.place.stateDir)).toBe(
          `${join(stand.place.stateDir, "keep-me")} ${Buffer.from("someone's\n").toString("base64")}`,
        );
      else expect(readFileSync(stand.place.serviceFile, "utf8")).toBe("someone's\n");
      expect(stand.registered()).toEqual([]);
      expect(existsSync(stand.place.programDir)).toBe(false);
    },
  );

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
        cleanup: "kept",
      },
    });
    expect(existsSync(stand.place.programDir)).toBe(true);
    expect(json(stand.place.recordFile)).toMatchObject({ stage: "onboarding" });
    // A later install refuses while it is there.
    const again = await runAll(installer(stand));
    expect(again.outcome).toMatchObject({ ok: false, failure: { kind: "exists", step: -1 } });
  });

  it("F-505: a service OpenClaw couldn't install is named, and the attempt is kept", async () => {
    const stand = await make({ scenario: "service-fails" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "service", step: 2, exitCode: 1, retry: false, cleanup: "kept" },
    });
  });

  it("F-502: on Linux, a session without a reachable user manager stops before anything is downloaded or made", async () => {
    const stand = await make({ scenario: "no-user-manager", platform: "linux" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: "user-service",
        step: -1,
        exitCode: null,
        classification: null,
        retry: false,
        cleanup: "none",
      },
    });
    expect(stand.requests).toEqual([]);
    expect(existsSync(stand.place.programDir)).toBe(false);
    expect(existsSync(stand.place.recordFile)).toBe(false);
  });

  it("F-502: a gateway that doesn't answer within the wait is named at the last step", async () => {
    const stand = await make({ scenario: "not-answering" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "not-answering", step: 3, retry: false, cleanup: "kept" },
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
      (stand: StandIn) => {
        mkdirSync(stand.place.programDir);
        writeFileSync(join(stand.place.programDir, "someone's"), "x");
      },
    ],
    [
      "Clawtrate's record without its program folder",
      (stand: StandIn) => writeFileSync(stand.place.recordFile, '{"id":"x","stage":"installed"}'),
    ],
  ])(
    "F-501: with %s already there it refuses before downloading anything, and leaves everything byte for byte",
    async (_name, plant) => {
      const stand = await make();
      plant(stand);
      const before = [inventory(stand.home), inventory(stand.appData)];
      const { outcome } = await runAll(installer(stand));
      expect(outcome).toEqual({
        ok: false,
        failure: {
          kind: "exists",
          step: -1,
          exitCode: null,
          classification: null,
          retry: false,
          cleanup: "none",
        },
      });
      expect(stand.requests).toEqual([]);
      expect(stand.calls()).toEqual([]);
      const home = inventory(stand.home)
        .split("\n")
        .filter((line) => !line.includes("stand-in-"))
        .join("\n");
      expect([home, inventory(stand.appData)]).toEqual([
        before[0]!
          .split("\n")
          .filter((line) => !line.includes("stand-in-"))
          .join("\n"),
        before[1],
      ]);
    },
  );

  it("F-501: a clawtrate job or unit the service manager has, defined anywhere, is something there", async () => {
    const stand = await make({ scenario: "loaded-elsewhere" });
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "exists", step: -1 } });
    expect(stand.requests).toEqual([]);
  });

  it("F-501: a place that can't be read is not taken for an empty one", async () => {
    const stand = await make();
    // `Library` as a file: the service file's folder can't be looked into.
    writeFileSync(join(stand.home, "Library"), "not a folder");
    const { outcome } = await runAll(installer(stand));
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "write", step: -1 } });
    expect(stand.requests).toEqual([]);
  });

  it("F-502: a write of the program folder's record that fails removes only the empty folder this attempt made, and offers Try again", async () => {
    const stand = await make();
    const at = layout(stand.place, stand.pins);
    const full: typeof writeFile = async (file, ...rest) => {
      if (file === at.record) throw Object.assign(new Error("full"), { code: "ENOSPC" });
      return writeFile(file, ...rest);
    };
    const { outcome } = await runAll(installer(stand, { writeFile: full }));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "write", step: -1, retry: true, cleanup: "removed" },
    });
    expect(existsSync(stand.place.programDir)).toBe(false);
    expect(existsSync(stand.place.recordFile)).toBe(false);
  });

  it("F-502: a write that fails later, before onboarding, is the same early failure, with the attempt removed", async () => {
    const stand = await make();
    const at = layout(stand.place, stand.pins);
    const full: typeof writeFile = async (file, ...rest) => {
      if (file === at.npmUser) throw Object.assign(new Error("full"), { code: "ENOSPC" });
      return writeFile(file, ...rest);
    };
    const { outcome } = await runAll(installer(stand, { writeFile: full }));
    expect(outcome).toMatchObject({
      ok: false,
      failure: { kind: "write", step: 1, retry: true, cleanup: "removed" },
    });
    expect(existsSync(stand.place.programDir)).toBe(false);
    expect(existsSync(stand.place.recordFile)).toBe(false);
  });

  it("F-502: an attempt of Clawtrate's that never reached onboarding, left by an earlier run, is proven, offered to the look as not an OpenClaw, removed, and the install goes on", async () => {
    const stand = await make();
    const at = layout(stand.place, stand.pins);
    mkdirSync(join(stand.place.programDir, "bin"), { recursive: true });
    writeFileSync(at.openclaw, "#!/bin/sh\n");
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
      at.record,
      JSON.stringify({
        id: record.id,
        version: "2026.10.6",
        profile: "clawtrate",
        stage: "installing",
      }),
    );
    const install = installer(stand);
    expect(await install.site()).toBe("leftover");
    expect(await install.leftoverProgram()).toBe(at.openclaw);
    const { outcome } = await runAll(install);
    expect(outcome.ok).toBe(true);
    expect(json(stand.place.recordFile).id).not.toBe(record.id);
  });

  it("F-502: an attempt whose records disagree on id, version or stage, or that reached onboarding, is never removed", async () => {
    const stand = await make();
    const at = layout(stand.place, stand.pins);
    mkdirSync(stand.place.programDir, { recursive: true });
    const base = {
      id: "a",
      version: "2026.10.6",
      profile: "clawtrate",
      programDir: stand.place.programDir,
      stateDir: stand.place.stateDir,
      stage: "installing",
    };
    const folder = { id: "a", version: "2026.10.6", profile: "clawtrate", stage: "installing" };
    const cases: Array<[object, object]> = [
      [{ ...base, stage: "onboarding" }, folder],
      [{ ...base, id: "b" }, folder],
      [base, { ...folder, version: "2026.9.37" }],
      // A folder record without a stage, as an earlier build wrote it.
      [base, { id: "a", version: "2026.10.6", profile: "clawtrate" }],
    ];
    for (const [own, there] of cases) {
      writeFileSync(stand.place.recordFile, JSON.stringify(own));
      writeFileSync(at.record, JSON.stringify(there));
      const install = installer(stand);
      expect(await install.site()).toBe("exists");
      expect(await install.leftoverProgram()).toBeNull();
      expect(await install.discard()).toBe(false);
    }
    expect(existsSync(stand.place.programDir)).toBe(true);
  });

  it("F-505: a profile named clawtrate whose records or service don't prove Clawtrate set it up isn't said to be Clawtrate's", async () => {
    const stand = await make();
    const { outcome } = await runAll(installer(stand));
    const port = (outcome as { port: number }).port;
    expect(await installer(stand).owned(port)).toBe(true);
    expect(await installer(stand).owned(port + 1)).toBe(false);
    const at = layout(stand.place, stand.pins);
    const owner = readFileSync(at.owner, "utf8");
    writeFileSync(at.owner, JSON.stringify({ id: "someone-else" }));
    expect(await installer(stand).owned(port)).toBe(false);
    writeFileSync(at.owner, owner);
    const service = readFileSync(stand.place.serviceFile, "utf8");
    writeFileSync(
      stand.place.serviceFile,
      service.replace(at.installedEntry, "/elsewhere/entry.js"),
    );
    expect(await installer(stand).owned(port)).toBe(false);
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
        return { ok: false, why: "network" };
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
        expect(() => check({ ...request, args: [...request.args, "--force"] })).toThrow(
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
    const at = layout(stand.place, stand.pins);
    expect(
      asked
        .map((command) => command[0])
        .filter((program) => program !== stand.place.serviceManager),
    ).toEqual([
      "/usr/bin/tar",
      "/usr/bin/tar",
      "/bin/bash",
      "/bin/bash",
      at.openclaw,
      at.openclaw,
      at.openclaw,
    ]);
    // The service manager is asked about the profile's job before anything, before onboarding and before its install.
    expect(asked.filter((command) => command[0] === stand.place.serviceManager)).toHaveLength(3);
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

  it("F-503: the installer's copy ends where its Node.js download would start, only when its Node.js step appears exactly once", () => {
    const script = `install_node() {\n${NODE_STEP}\n  emit_json step name node status start version "$NODE_VERSION"\n}\n`;
    const patched = patchInstaller(script)!;
    expect(patched.indexOf("exit 70")).toBeGreaterThan(patched.indexOf("status skip"));
    expect(patched.indexOf("exit 70")).toBeLessThan(patched.indexOf("status start"));
    expect(patchInstaller(script + script)).toBeNull();
    expect(patchInstaller(script.replace("    return\n", "    return 0\n"))).toBeNull();
  });
});

describe("F-502 F-503: downloads", () => {
  it("F-503: a download is exactly the pinned URL with status 200 and the declared length, or it has no digest", async () => {
    const dir = (await make()).root;
    const server = createServer((request, response) => {
      if (request.url === "/ok") response.writeHead(200).end("bytes");
      else if (request.url === "/moved") response.writeHead(302, { location: "/ok" }).end();
      else if (request.url === "/range") response.writeHead(206).end("bytes");
      else {
        response.writeHead(200, { "content-length": "100" });
        response.write("bytes", () => response.socket?.destroy());
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const get = (path: string, name: string) =>
        download(`${base}${path}`, join(dir, name), "sha256", "hex");
      expect(await get("/ok", "a")).toEqual({
        ok: true,
        digest: createHash("sha256").update("bytes").digest("hex"),
      });
      expect(await get("/moved", "b")).toEqual({ ok: false, why: "network" });
      expect(await get("/range", "c")).toEqual({ ok: false, why: "network" });
      expect(await get("/short", "d")).toEqual({ ok: false, why: "short" });
      // A file it can't create is a write of its own, not the network.
      expect(await get("/ok", "missing-folder/e")).toEqual({ ok: false, why: "write" });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("F-502: the runner ends what it started", () => {
  it("F-502: stopping a program ends its whole process group and waits for it", async () => {
    const stand = await make();
    const marker = join(stand.root, "late");
    const request: InstallRequest = {
      program: "/bin/bash",
      args: ["-c", 'set -- "$1"; ( sleep 1; : > "$1" ) & sleep 30', "x", marker],
      env: { PATH: "/usr/bin:/bin" },
      cwd: stand.root,
      timeoutMs: 60_000,
      maxBytes: 1024,
    };
    const own = new InstallRunner();
    const running = own.run(request, () => {});
    await pause(200);
    expect(own.running()).toHaveLength(1);
    own.stopAll();
    await running;
    expect(own.running()).toEqual([]);
    await pause(1_500);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("F-502: once the app quits nothing more starts, and close waits for what runs", async () => {
    const stand = await make();
    const own = new InstallRunner();
    const request: InstallRequest = {
      program: "/bin/sleep",
      args: ["30"],
      env: { PATH: "/usr/bin:/bin" },
      cwd: stand.root,
      timeoutMs: 60_000,
      maxBytes: 1024,
    };
    const running = own.run(request, () => {});
    await pause(100);
    await own.close(5_000);
    expect(own.running()).toEqual([]);
    expect((await running).exitCode).not.toBe(0);
    expect(await own.run(request, () => {})).toMatchObject({ failed: true });
  }, 30_000);
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

  it("F-505: onboarding counts only the profile's config for a loopback gateway on the chosen port with token sign-in, and no service of its own", () => {
    const ok = (gateway: object, installDaemon = false) =>
      JSON.stringify({ ok: true, gateway, installDaemon, skipHealth: true });
    const good = { port: 40001, bind: "loopback", authMode: "token" };
    expect(readOnboarding(ok(good), 40001)).toEqual({ ok: true });
    expect(readOnboarding(ok(good), 40002).ok).toBe(false);
    expect(readOnboarding(ok({ ...good, bind: "lan" }), 40001).ok).toBe(false);
    expect(readOnboarding(ok({ ...good, authMode: "none" }), 40001).ok).toBe(false);
    expect(readOnboarding(ok(good, true), 40001).ok).toBe(false);
    expect(readOnboarding("banner\n" + ok(good), 40001)).toEqual({ ok: true });
    // Printed over several lines, after lines of text.
    const pretty = JSON.stringify(JSON.parse(ok(good)), null, 2);
    expect(readOnboarding(`Config written\n{ not this\n${pretty}\n`, 40001)).toEqual({
      ok: true,
    });
    expect(readOnboarding('{"ok":false,"classification":"not-listening"}', 40001)).toEqual({
      ok: false,
      classification: "not-listening",
    });
    expect(readOnboarding('{"ok":false,"classification":"made-up"}', 40001)).toEqual({
      ok: false,
      classification: null,
    });
  });

  it("F-505: the service install counts only a service it installed and loaded, never one already there", () => {
    expect(
      readServiceInstall(
        '{"ok":true,"action":"install","result":"installed","service":{"loaded":true}}',
      ),
    ).toBe(true);
    expect(readServiceInstall('{"ok":true,"action":"install","result":"already-installed"}')).toBe(
      false,
    );
    expect(
      readServiceInstall(
        '{"ok":true,"action":"install","result":"installed","service":{"loaded":false}}',
      ),
    ).toBe(false);
    expect(readServiceInstall('{"ok":false,"action":"install"}')).toBe(false);
  });

  it("F-505: a service file's command, as launchd and systemd read it", () => {
    const plist = `<plist><dict><key>ProgramArguments</key>\n<array>\n<string>/a b/node</string>\n<string>x&amp;y&lt;z</string>\n</array></dict></plist>`;
    expect(serviceArgv("darwin", plist)).toEqual(["/a b/node", "x&y<z"]);
    const unit = `[Service]\nExecStart="/a b/node" --flag "/c\\"d/entry.js" gateway --port 40001 100%%\n`;
    expect(serviceArgv("linux", unit)).toEqual([
      "/a b/node",
      "--flag",
      '/c"d/entry.js',
      "gateway",
      "--port",
      "40001",
      "100%",
    ]);
    expect(serviceArgv("linux", "ExecStart=a\nExecStart=b\n")).toBeNull();
    expect(serviceArgv("darwin", "<plist/>")).toBeNull();
  });

  it("F-502: the host's log of onboarding names only words it knows, booleans and whether the port was the chosen one", () => {
    const facts = onboardingFacts(
      JSON.stringify({
        ok: false,
        gateway: { port: 40002, bind: "/srv/a-path", authMode: "token" },
        installDaemon: false,
        classification: "a message with a token sk-123",
        secretKey: "x",
      }),
      40001,
    );
    expect(facts).toBe("ok=false port=other bind=other auth=token daemon=false class=other");
    expect(onboardingFacts("not json", 40001)).toBe("json=absent");
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
