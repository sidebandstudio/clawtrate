// `--install-plugin`: which plugins it takes, how it packs them, and what it says. The install
// itself is the engine's (packages/core/test/plugin-install.test.ts) and the e2e spec's
// (e2e/plugin-install.spec.ts).
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  devConfig,
  installCarried,
  installRecordsFile,
  openInstance,
  recordedStartOptions,
  sandboxProblems,
  start,
} from "../src/cli.ts";
import {
  describeOutcome,
  INSTALLABLE,
  INSTALLED_GRANTS,
  installPlugin,
  operatorContext,
  type Packed,
  packCarried,
  recordMap,
  verifyPacked,
} from "../src/install-plugin.ts";
import type { OperatorSession } from "../src/operator.ts";
import type { PluginRecord } from "../../../packages/core/src/plugin-install.ts";
import {
  ARCHIVE,
  FakeGateway,
  ID,
  Refusal,
  TARBALLS,
} from "../../../packages/core/test/plugin-gateway.ts";
import { tempDir } from "../../../test/temp-dir.ts";
import type { InstancePorts } from "../src/registry.ts";

const CHECKOUT = resolve(import.meta.dirname, "../../..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("--install-plugin", () => {
  it("takes only the plugins the desktop app carries", () => {
    expect(INSTALLABLE).toEqual(["clawtrate-voice"]);
    for (const name of ["clawtrate-tool-rules", "clawtrate-bots", "../x"])
      expect(() => packCarried(CHECKOUT, "/nowhere", name)).toThrow(
        `--install-plugin takes clawtrate-voice, not ${JSON.stringify(name)}`,
      );
  });

  it("packs with the app's own packer, as its build does", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-plugin-test-"));
    dirs.push(dir);
    const packed = packCarried(CHECKOUT, dir, "clawtrate-voice");
    expect(existsSync(packed.archive)).toBe(true);
    expect(packed.pin).toMatchObject({
      packageName: "@clawtrate/clawtrate-voice",
      pluginId: "clawtrate-voice",
      grants: { hooks: { allowConversationAccess: true } },
    });
    expect(packed.unrecorded).toBe(false);
  });

  it("says the digest a gateway reported and the one command that records it", () => {
    expect(
      describeOutcome("clawtrate-voice", "2026.11.10", {
        kind: "stopped",
        stop: "turned-off",
        mayBeRunning: false,
        reported: "a".repeat(64),
      }),
    ).toBe(
      `Didn't install clawtrate-voice: turned-off.\nThe gateway reported the source digest ${"a".repeat(64)}. If this packing is the one to ship, record it: node apps/desktop/packaging/carried-plugins.ts source-digest clawtrate-voice 2026.11.10 ${"a".repeat(64)}`,
    );
    expect(describeOutcome("clawtrate-voice", "2026.10.6", { kind: "enabled" })).toBe(
      "Installed clawtrate-voice on OpenClaw 2026.10.6: enabled and confirmed.",
    );
  });

  it("says nothing was installed, never that it took off a plugin it never had", () => {
    expect(describeOutcome("clawtrate-voice", "2026.10.6", { kind: "nothing-installed" })).toBe(
      "Nothing of clawtrate-voice was installed, so there was nothing to take off.",
    );
    expect(
      describeOutcome("clawtrate-voice", "2026.10.6", {
        kind: "stopped",
        stop: "taking-off-later",
        mayBeRunning: true,
      }),
    ).toBe(
      "clawtrate-voice will be taken off when this device is next connected with full control: nothing was sent.\nUntil then it may still be running.",
    );
  });

  it("says when the plugin may still be running", () => {
    expect(
      describeOutcome("clawtrate-voice", "2026.10.6", {
        kind: "stopped",
        stop: "lost",
        mayBeRunning: true,
      }),
    ).toBe(
      "Didn't install clawtrate-voice: lost.\nIt may still be running: no read has shown it off since.",
    );
  });

  it("refuses the option before any command runs or any instance changes", () => {
    const cli = join(CHECKOUT, "tools/dev-gateway/src/cli.ts");
    // An OpenClaw that isn't there: a refusal that comes after the version probe would say so.
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_BIN: "/nowhere/openclaw" },
      });
    const prune = run("prune", "--install-plugin", "clawtrate-voice");
    expect(prune.status).toBe(1);
    expect(prune.stderr).toContain("--install-plugin is a start option; prune does not take it");
    const typo = run("start", "--instance", "never-made", "--install-plugin", "clawtrate-vioce");
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain('--install-plugin takes clawtrate-voice, not "clawtrate-vioce"');
    // Loaded and installed at once: refused before the version probe or anything else, and the
    // command on a running instance needs its plugin's name.
    const both = run(
      "start",
      "--instance",
      "never-made",
      "--with-plugin",
      "clawtrate-voice",
      "--install-plugin",
      "clawtrate-voice",
    );
    expect(both.status).toBe(1);
    expect(both.stderr).toContain(
      "clawtrate-voice is loaded with --with-plugin and installed with --install-plugin",
    );
    const unnamed = run("install-plugin", "--instance", "never-made");
    expect(unnamed.status).toBe(1);
    expect(unnamed.stderr).toContain("install-plugin takes the plugin to install: clawtrate-voice");
    // Two Node processes start the tool's CLI, which takes more than Vitest's 5 s under load.
  }, 40_000);

  it("refuses a name it doesn't install, or a plugin also loaded from the checkout, before start changes anything", async () => {
    const home = tempDir("install-plugin-home-");
    const inst = () => openInstance("install-check", { home, runRoot: join(home, "run") });
    await expect(start(inst(), { installPlugins: ["clawtrate-vioce"] })).rejects.toThrow(
      '--install-plugin takes clawtrate-voice, not "clawtrate-vioce"',
    );
    await expect(
      start(inst(), { plugins: ["clawtrate-voice"], installPlugins: ["clawtrate-voice"] }),
    ).rejects.toThrow(
      "clawtrate-voice is loaded with --with-plugin and installed with --install-plugin",
    );
    expect(existsSync(inst().stateDir)).toBe(false);
  });

  it("lets the instance's config hold the entry the engine writes, and nothing else", () => {
    const ports: InstancePorts = { gatewayPort: 19240, providerPort: 19250 };
    const state = "/state/.openclaw-clawtrate-dev-install";
    const options = { installPlugins: ["clawtrate-voice" as const] };
    const grants = INSTALLED_GRANTS["clawtrate-voice"];
    const withEntry = (entry: unknown) => {
      const config = devConfig("token", ports, state, [], options) as {
        plugins: { entries: Record<string, unknown> };
      };
      config.plugins.entries[ID] = entry;
      return config;
    };
    // `seed` after an unseeded start that installed it, and every later check of the config.
    for (const entry of [
      { enabled: false },
      { enabled: false, ...grants },
      { enabled: true, ...grants },
      { enabled: true, ...grants, config: {} },
    ])
      expect(
        sandboxProblems(withEntry(entry), ports, state, [], options),
        JSON.stringify(entry),
      ).toEqual([]);
    expect(
      sandboxProblems(devConfig("token", ports, state, [], options), ports, state, [], options),
    ).toEqual([]);
    for (const [entry, problem] of [
      [
        { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true } },
        "plugins.entries.clawtrate-voice.hooks.allowPromptInjection is not allowed",
      ],
      [
        { enabled: true, ...grants, config: { x: 1 } },
        "plugins.entries.clawtrate-voice.config.x is not allowed",
      ],
      [{ enabled: "yes" }, "plugins.entries.clawtrate-voice.enabled must be true or false"],
      [
        { enabled: true, ...grants, apiKey: "k" },
        "plugins.entries.clawtrate-voice.apiKey is not allowed",
      ],
    ] as const)
      expect(sandboxProblems(withEntry(entry), ports, state, [], options).join("\n")).toContain(
        problem,
      );
    // Without the start's record of it, the entry is refused as before.
    expect(sandboxProblems(withEntry({ enabled: false }), ports, state)).toEqual([
      "plugins.entries.clawtrate-voice is not allowed",
    ]);
  });

  it("reads back only a list of plugins it installs, as the start recorded it", () => {
    const runDir = tempDir("install-plugin-run-");
    for (const [text, ok] of [
      ['{"installPlugins":["clawtrate-voice"]}', true],
      ['{"installPlugins":["clawtrate-voice","clawtrate-voice"]}', false],
      ['{"installPlugins":["clawtrate-tool-rules"]}', false],
      ['{"installPlugins":[]}', false],
      ['{"installPlugins":"clawtrate-voice"}', false],
    ] as const) {
      writeFileSync(join(runDir, "start-options.json"), text);
      if (ok) expect(recordedStartOptions({ runDir })).toEqual(JSON.parse(text));
      else expect(() => recordedStartOptions({ runDir })).toThrow(/not a record of start options/);
    }
  });

  it("allows the grants the plugin's record pins, and those alone", () => {
    const record = JSON.parse(
      readFileSync(join(CHECKOUT, "apps/desktop/packaging/carried-plugins.json"), "utf8"),
    ) as { plugins: Record<string, { grants: unknown }> };
    for (const name of INSTALLABLE)
      expect(INSTALLED_GRANTS[name], name).toEqual(record.plugins[name]!.grants);
  });

  /** An operator session over the engine tests' stand-in gateway, one connection at a time. */
  function session(
    gateway: FakeGateway,
    grantedScopes = ["operator.admin", "operator.read", "operator.write"],
  ): OperatorSession {
    const fake = {
      generation: 1,
      isUp: true,
      grantedScopes,
      serverVersion: gateway.version,
      deviceId: "install-test-device",
      events: [],
      waitFor: () => Promise.reject(new Error("no event")),
      requestOnce: (method: string, params: unknown) => gateway.request(method, params),
      close: async () => {},
    };
    return fake as unknown as OperatorSession;
  }

  /** The app's packing, in a folder this file keeps to its end. */
  let packing: Packed;
  beforeAll(() => {
    packing = packCarried(CHECKOUT, realpathSync(tempDir("install-plugin-pack-")), ID);
  }, 40_000);
  const packedOnce = (): Packed => packing;

  it("checks the packed tarball as the app's host checks its own: resolved, inside, its bytes", () => {
    const packed = packedOnce();
    expect(verifyPacked(packed)).toEqual({
      path: packed.archive,
      root: packed.dir,
      integrity: packed.pin.integrity,
    });
    const link = join(realpathSync(tempDir("install-plugin-link-")), "pack");
    symlinkSync(packed.dir, link);
    expect(() =>
      verifyPacked({ archive: join(link, packed.archive.slice(packed.dir.length + 1)), dir: link }),
    ).toThrow("symbolic link");
  });

  it("resumes an attempt it left, and never turns its stop into a fresh enable", async () => {
    const packed = packedOnce();
    const gateway = FakeGateway.at("2026.10.6", "off");
    gateway.staged = { ...TARBALLS[ARCHIVE]!, integrity: packed.pin.integrity };
    const records = new Map<string, PluginRecord | null>([
      [
        ID,
        {
          mode: "install",
          integrity: packed.pin.integrity,
          step: 6,
          pending: 7,
          turningOff: false,
          sourceDigest: null,
          configHash: null,
        },
      ],
    ]);
    const outcome = await installPlugin(session(gateway), packed, recordMap(records));
    // A lost enable with the entry still off is a stop (#832): no Turn on after it.
    expect(outcome).toMatchObject({ kind: "stopped", stop: "listed-off" });
    // Only the disable that proves the lost enable can no longer publish; never an enable.
    expect(
      gateway.calls.some((c) => c.method === "plugins.setEnabled" && c.params.enabled === true),
    ).toBe(false);
  });

  it("the command run again on the same instance resumes the attempt the first run left", async () => {
    const home = realpathSync(tempDir("install-plugin-instance-"));
    const inst = openInstance("install-check", { home, runRoot: join(home, "run") });
    const dir = join(inst.runDir, "carried-plugins");
    const archive = join(dir, basename(packedOnce().archive));
    const gateway = FakeGateway.at("2026.10.6", "fresh");
    // The enable applies and its reply is lost.
    gateway.hooks.push({ method: "plugins.setEnabled", nth: 1, lose: "after" });
    const io = {
      // The CLI packed the archive before connecting. Gzip can produce different bytes on
      // different Node builds, so the stand-in reports the integrity of the file just packed.
      open: async () => {
        TARBALLS[archive] = {
          ...TARBALLS[ARCHIVE]!,
          integrity: verifyPacked({ archive, dir }).integrity,
        };
        return session(gateway);
      },
      unpair: async () => {},
    };
    const exit = process.exitCode;
    try {
      const first = await installCarried(inst, ID, io);
      expect(first).toMatchObject({ stop: "lost", mayBeRunning: true });
      expect(JSON.parse(readFileSync(installRecordsFile(inst), "utf8"))[ID]).toMatchObject({
        pending: 7,
      });
      const staged = gateway.calls.filter((c) => c.method === "plugins.install").length;
      const second = await installCarried(inst, ID, io);
      expect(second).toEqual({ kind: "enabled" });
      // Resumed: turned off, then steps 6 and 7 again; nothing staged again.
      expect(gateway.calls.filter((c) => c.method === "plugins.install")).toHaveLength(staged);
      expect(JSON.parse(readFileSync(installRecordsFile(inst), "utf8"))).toEqual({});
    } finally {
      process.exitCode = exit;
      delete TARBALLS[archive];
    }
  }, 40_000);

  it("writes only when the gateway's hello granted operator.admin", async () => {
    const gateway = FakeGateway.at("2026.10.6", "fresh");
    const outcome = await installPlugin(
      session(gateway, ["operator.read", "operator.write"]),
      packedOnce(),
    );
    expect(outcome).toMatchObject({ stop: "no-admin" });
    expect(gateway.writes()).toEqual([]);
  });

  it("tells the gateway's refusals from a request that wasn't answered", () => {
    const ctx = operatorContext(
      session(FakeGateway.at("2026.10.6", "fresh")),
      recordMap(new Map()),
      packedOnce(),
    );
    expect(ctx.answered(new Refusal({ message: "no", code: "INVALID_REQUEST" }))).toBe(true);
    expect(ctx.answered(new Error("not connected"))).toBe(false);
  });
});
