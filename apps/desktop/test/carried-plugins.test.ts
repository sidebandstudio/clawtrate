// The plugins the app carries: packing, the list it is built with, the check
// that a changed plugin has a new version, and where the app finds them in a
// development build and in a packaged app. npm runs for real, offline, to read
// a tarball the way OpenClaw's npm-pack install does.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createPackage, listPackage } from "@electron/asar";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  declaredSurface,
  digestNow,
  digestOf,
  bumpPlugin,
  packagedCarried,
  packCarried,
  PLUGINS_DIR,
  readRecord,
  recordPlugin,
  recordSourceDigest,
  requireRecorded,
  tarOf,
} from "../packaging/carried-plugins.ts";
import { builderConfig } from "../packaging/config.ts";
import { OPENCLAW_VERSIONS, PINNED_OPENCLAW } from "../../../tools/dev-gateway/src/versions.ts";
import { integrityOf, readTarball, runNpm } from "../packaging/plugin-npm.ts";
import {
  CARRIED_BUILD_DIR,
  CARRIED_LIST_NAME,
  carriedPlaces,
  type CarriedList,
} from "../src/main/carried-plugins.ts";

const VOICE = join(PLUGINS_DIR, "clawtrate-voice");
const VOICE_VERSION = (
  JSON.parse(readFileSync(join(VOICE, "package.json"), "utf8")) as { version: string }
).version;

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "carried-plugins-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of plugins/ holding only the voice plugin, to change. */
const pluginsCopy = () => {
  const dir = temp();
  cpSync(VOICE, join(dir, "clawtrate-voice"), { recursive: true });
  return dir;
};
const setVersion = (pluginsDir: string, version: string) => {
  const path = join(pluginsDir, "clawtrate-voice/package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
};
const readList = (dir: string) =>
  JSON.parse(readFileSync(join(dir, CARRIED_LIST_NAME), "utf8")) as CarriedList;

describe("the plugins the app carries", () => {
  it("are the voice plugin alone", () => {
    expect(Object.keys(readRecord().plugins)).toEqual(["clawtrate-voice"]);
  });

  it("pack as the release's build packs them, on this checkout", () => {
    // packaging/build.ts runs exactly this, with the same record and plugins, into
    // apps/desktop/out/plugins: anything that would stop the build stops this test in `check`.
    expect(() => packCarried(temp())).not.toThrow();
  });

  it("keep their committed bytes on every checkout", () => {
    // No line-ending conversion (.gitattributes), so a Linux, macOS or Windows checkout, with
    // any core.autocrlf, packs the one recorded digest.
    const out = temp();
    const [voice] = packCarried(out).plugins;
    const packed = [...readTarball(join(out, voice!.file)).keys()]
      .map((path) => path.slice("package/".length))
      .filter((path) => path !== "package.json");
    const sources = packed.map((path) => `plugins/clawtrate-voice/${path}`);
    const attrs = spawnSync("git", ["check-attr", "eol", "--", ...sources], {
      cwd: resolve(PLUGINS_DIR, ".."),
      encoding: "utf8",
    });
    expect(attrs.status, attrs.stderr).toBe(0);
    expect(attrs.stdout.trim().split("\n")).toEqual(sources.map((file) => `${file}: eol: lf`));
  });

  it("are as carried-plugins.json records them in this checkout", () => {
    // A pull request that changes a carried plugin without raising its version fails here.
    const now = digestNow("clawtrate-voice");
    expect(() =>
      requireRecorded(
        "clawtrate-voice",
        now.version,
        now.digest,
        readRecord().plugins["clawtrate-voice"],
        readRecord().openclaw,
      ),
    ).not.toThrow();
  });

  it("lists each tarball with the SHA-512 npm reads from it, and its package, version and id", () => {
    const out = temp();
    const list = packCarried(out);
    expect(readList(out)).toEqual(list);
    expect(list.plugins).toHaveLength(1);
    const [voice] = list.plugins;
    expect(voice).toMatchObject({
      packageName: "@clawtrate/clawtrate-voice",
      version: VOICE_VERSION,
      pluginId: "clawtrate-voice",
      file: `clawtrate-clawtrate-voice-${VOICE_VERSION}.tgz`,
    });
    const tarball = join(out, voice!.file);
    expect(voice!.integrity).toBe(integrityOf(readFileSync(tarball)));
    expect(readdirSync(out).sort()).toEqual([voice!.file, CARRIED_LIST_NAME].sort());

    // What OpenClaw's npm-pack install reads first: `npm pack <archive> --dry-run --json`.
    const read = runNpm(
      ["pack", tarball, "--ignore-scripts", "--dry-run", "--json", "--offline"],
      out,
    );
    expect(read.status, read.stderr).toBe(0);
    const [report] = JSON.parse(read.stdout) as {
      name: string;
      version: string;
      integrity: string;
      files: { path: string }[];
    }[];
    expect(report).toMatchObject({
      name: voice!.packageName,
      version: voice!.version,
      integrity: voice!.integrity,
    });
    expect(report!.files.map((file) => file.path).sort()).toEqual([
      "index.js",
      "openclaw.plugin.json",
      "package.json",
      "voice.md",
    ]);
  });

  it("packs files npm installs unchanged, and a package.json without private", () => {
    const out = temp();
    const [voice] = packCarried(out).plugins;
    const files = readTarball(join(out, voice!.file));
    expect(files.has("package/README.md")).toBe(false);
    expect(files.has("package/LICENSE")).toBe(false);
    for (const path of ["index.js", "openclaw.plugin.json", "voice.md"])
      expect(files.get(`package/${path}`)).toEqual(readFileSync(join(VOICE, path)));
    const pkg = JSON.parse(files.get("package/package.json")!.toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(pkg.private).toBeUndefined();
    expect(pkg.name).toBe("@clawtrate/clawtrate-voice");

    const project = temp();
    writeFileSync(join(project, "package.json"), '{ "name": "stand-in", "private": true }\n');
    const installed = runNpm(
      [
        "install",
        join(out, voice!.file),
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
      ],
      project,
    );
    expect(installed.status, installed.stderr).toBe(0);
    const dir = join(project, "node_modules/@clawtrate/clawtrate-voice");
    expect(readdirSync(dir).sort()).toEqual([...files.keys()].map((p) => p.slice(8)).sort());
    expect(readFileSync(join(dir, "index.js"))).toEqual(readFileSync(join(VOICE, "index.js")));
  });

  it("gives the voice plugin the grant its development contract names, kept apart from its surface", () => {
    const [voice] = packCarried(temp()).plugins;
    const contract = JSON.parse(
      readFileSync(join(VOICE, "clawtrate-dev-contract.json"), "utf8"),
    ) as { hooks: unknown };
    expect(voice!.grants).toEqual({ hooks: contract.hooks });
    expect(voice!.grants).toEqual({ hooks: { allowConversationAccess: true } });
  });

  it("pins the grant of every hook the plugin's code registers", async () => {
    // A plugin that isn't a bundle can't declare its hooks: OpenClaw reads no `hooks` from its
    // manifest and reports `declared.hooks: []` for it (docs/design/plugins-install.md,
    // section 1). So what its code registers is held here instead, by registering it with a
    // stand-in host: each hook must be in this table, and its grant in the pin's `grants`.
    // OpenClaw registers a prompt hook of a plugin it didn't bundle only with
    // `allowConversationAccess: true` (plugins/clawtrate-voice/README.md).
    const HOOK_GRANTS: Record<string, Record<string, unknown>> = {
      before_prompt_build: { hooks: { allowConversationAccess: true } },
    };
    const registered: string[] = [];
    const plugin = (await import(join(VOICE, "index.js"))) as {
      default: { register(api: unknown): void };
    };
    plugin.default.register({
      config: {},
      on: (name: string) => registered.push(name),
      registerGatewayMethod: () => {},
      registerService: () => {},
      runtime: { state: { openKeyedStore: () => ({ lookup: async () => undefined }) } },
    });
    expect(registered).toEqual(["before_prompt_build"]);
    const [voice] = packCarried(temp()).plugins;
    for (const hook of registered) {
      expect(HOOK_GRANTS[hook], `${hook} has a grant in this table`).toBeDefined();
      expect(voice!.grants).toMatchObject(HOOK_GRANTS[hook]!);
    }
  });

  it("carries a source digest for each OpenClaw version the development gateway runs", () => {
    // Versions the development gateway runs, the pin among them; a version added to versions.ts
    // later gets no install until its digest is recorded (the engine's step 0), and fails nothing.
    expect(
      readRecord().openclaw.every((v) => (OPENCLAW_VERSIONS as readonly string[]).includes(v)),
    ).toBe(true);
    expect(readRecord().openclaw).toContain(PINNED_OPENCLAW);
    const [voice] = packCarried(temp()).plugins;
    expect(Object.keys(voice!.sourceDigests)).toEqual(readRecord().openclaw);
    for (const digest of Object.values(voice!.sourceDigests))
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records every capability group the voice plugin's manifest declares", () => {
    const out = temp();
    const [voice] = packCarried(out).plugins;
    const manifest = JSON.parse(readFileSync(join(VOICE, "openclaw.plugin.json"), "utf8"));
    expect(voice!.declared).toEqual(declaredSurface(manifest));
    expect(Object.keys(voice!.declared)).toEqual([
      "channels",
      "providers",
      "tools",
      "contracts",
      "hooks",
      "mcpServers",
      "cliCommands",
      "cliBackends",
      "skills",
      "dangerousConfigFlags",
    ]);
  });
});

describe("a carried plugin's version", () => {
  it("must change when its files do: packing fails and writes nothing", () => {
    const plugins = pluginsCopy();
    writeFileSync(join(plugins, "clawtrate-voice/voice.md"), "Another guide.\n");
    const out = temp();
    writeFileSync(join(out, "kept"), "");
    expect(() => packCarried(out, { pluginsDir: plugins })).toThrow(
      `plugins/clawtrate-voice changed since its version ${VOICE_VERSION} was recorded, but its version is still ${VOICE_VERSION}. Run \`node apps/desktop/packaging/carried-plugins.ts bump clawtrate-voice\`.`,
    );
    expect(readdirSync(out)).toEqual(["kept"]);
    // The same for a record whose digest was changed by hand.
    const recorded = readRecord().plugins["clawtrate-voice"]!;
    const record = {
      ...readRecord(),
      plugins: { "clawtrate-voice": { ...recorded, digest: "sha256-other" } },
    };
    expect(() => packCarried(out, { record })).toThrow(
      `plugins/clawtrate-voice changed since its version ${VOICE_VERSION} was recorded`,
    );
    expect(readdirSync(out)).toEqual(["kept"]);
  });

  it("doesn't change for its README or the repository's LICENSE, which aren't packed", () => {
    const plugins = pluginsCopy();
    writeFileSync(join(plugins, "clawtrate-voice/README.md"), "Another README.\n");
    const license = join(temp(), "LICENSE");
    writeFileSync(license, "Another licence.\n");
    expect(() => packCarried(temp(), { pluginsDir: plugins, license })).not.toThrow();
  });

  it("is raised and recorded in one command", () => {
    const plugins = pluginsCopy();
    writeFileSync(join(plugins, "clawtrate-voice/voice.md"), "Another guide.\n");
    const raised = bumpPlugin("clawtrate-voice", plugins);
    const [a, b, c] = VOICE_VERSION.split(".").map(Number);
    const next = `${a}.${b}.${c! + 1}`;
    expect(raised.version).toBe(next);
    expect(readFileSync(join(plugins, "clawtrate-voice/index.js"), "utf8")).toContain(
      `PLUGIN_VERSION = "${next}"`,
    );
    expect(
      (
        JSON.parse(readFileSync(join(plugins, "clawtrate-voice/package.json"), "utf8")) as {
          version: string;
        }
      ).version,
    ).toBe(next);
    expect(raised).toEqual(digestNow("clawtrate-voice", plugins));
  });

  it("must be recorded when it is raised", () => {
    const plugins = pluginsCopy();
    setVersion(plugins, "9.0.0");
    expect(() => packCarried(temp(), { pluginsDir: plugins })).toThrow(
      `plugins/clawtrate-voice is version 9.0.0, but carried-plugins.json records ${VOICE_VERSION}. Run \`node apps/desktop/packaging/carried-plugins.ts record clawtrate-voice\`.`,
    );
    const now = digestNow("clawtrate-voice", plugins);
    const raised = recordPlugin(readRecord(), "clawtrate-voice", now.version, now.digest);
    expect(raised.plugins["clawtrate-voice"]).toEqual({
      version: "9.0.0",
      digest: now.digest,
      grants: readRecord().plugins["clawtrate-voice"]!.grants,
      sourceDigests: {},
    });
    // The source digests belonged to the old packing: a new one needs each again.
    expect(() => packCarried(temp(), { pluginsDir: plugins, record: raised })).toThrow(
      `plugins/clawtrate-voice 9.0.0 has no source digest for OpenClaw ${readRecord().openclaw[0]}.`,
    );
    const record = readRecord().openclaw.reduce(
      (into, openclaw) => recordSourceDigest(into, "clawtrate-voice", openclaw, "a".repeat(64)),
      raised,
    );
    const [voice] = packCarried(temp(), { pluginsDir: plugins, record }).plugins;
    expect(voice!.version).toBe("9.0.0");
    expect(Object.values(voice!.sourceDigests)).toEqual(
      readRecord().openclaw.map(() => "a".repeat(64)),
    );
  });

  it("is recorded only when it is newer, or unchanged with the same files", () => {
    const grants = { hooks: { allowConversationAccess: true } };
    const sourceDigests = { "2026.10.6": "b".repeat(64) };
    const record = {
      openclaw: ["2026.10.6"],
      plugins: {
        "clawtrate-voice": { version: "0.2.0", digest: "sha256-a", grants, sourceDigests },
      },
    };
    expect(recordPlugin(record, "clawtrate-voice", "0.2.0", "sha256-a")).toEqual(record);
    for (const version of ["0.2.0", "0.1.9"])
      expect(() => recordPlugin(record, "clawtrate-voice", version, "sha256-b")).toThrow(
        `plugins/clawtrate-voice is version ${version}, which isn't newer than the recorded 0.2.0. Raise its version.`,
      );
    expect(recordPlugin(record, "clawtrate-voice", "0.10.0", "sha256-b").plugins).toEqual({
      "clawtrate-voice": { version: "0.10.0", digest: "sha256-b", grants, sourceDigests: {} },
    });
    expect(() => recordPlugin(record, "clawtrate-tool-rules", "0.1.0", "sha256-c")).toThrow(
      "plugins/clawtrate-tool-rules isn't in carried-plugins.json. A plugin joins it, with its grants, in the pull request after its review.",
    );
  });

  it("must be canonical x.y.z", () => {
    const plugins = pluginsCopy();
    setVersion(plugins, "0.01.0");
    expect(() => digestNow("clawtrate-voice", plugins)).toThrow();
    setVersion(plugins, "1.0.0-beta.20261127.1");
    expect(() => digestNow("clawtrate-voice", plugins)).toThrow();
  });
});

describe("a source digest", () => {
  it("is required for every OpenClaw version before packing", () => {
    const recorded = readRecord().plugins["clawtrate-voice"]!;
    for (const openclaw of readRecord().openclaw) {
      const { [openclaw]: _left, ...rest } = recorded.sourceDigests;
      const record = {
        ...readRecord(),
        plugins: { "clawtrate-voice": { ...recorded, sourceDigests: rest } },
      };
      expect(() => packCarried(temp(), { record })).toThrow(
        `plugins/clawtrate-voice ${VOICE_VERSION} has no source digest for OpenClaw ${openclaw}. Install it on a development gateway of that version and run \`node apps/desktop/packaging/carried-plugins.ts source-digest clawtrate-voice ${openclaw} <digest>\` with the digest its runtime reported.`,
      );
    }
  });

  it("can be left out by the recording step's own command alone, never by the build", () => {
    // The recording step: a raised version has no source digests until a gateway reports them.
    const plugins = pluginsCopy();
    setVersion(plugins, "9.0.0");
    const now = digestNow("clawtrate-voice", plugins);
    const record = recordPlugin(readRecord(), "clawtrate-voice", now.version, now.digest);
    const out = temp();
    const [voice] = packCarried(out, {
      pluginsDir: plugins,
      record,
      unrecordedDigests: true,
    }).plugins;
    expect(voice!.version).toBe("9.0.0");
    expect(existsSync(join(out, voice!.file))).toBe(true);
    expect(Object.values(voice!.sourceDigests)).toEqual(record.openclaw.map(() => ""));
    // What the build calls refuses that same state.
    expect(() => packCarried(temp(), { pluginsDir: plugins, record })).toThrow(
      "has no source digest for OpenClaw",
    );
    // The build packs with packCarried(BUILD_OUT) and nothing else, and no release path names
    // the recording step's flag.
    const packaging = join(import.meta.dirname, "../packaging");
    const build = readFileSync(join(packaging, "build.ts"), "utf8");
    expect(build.match(/packCarried\([^)]*\)/g)).toEqual(["packCarried(BUILD_OUT)"]);
    for (const file of ["build.ts", "candidate-build.ts", "release-beta.ts", "config.ts"])
      expect(readFileSync(join(packaging, file), "utf8"), file).not.toMatch(/unrecorded/i);
  });

  it("is left out only into a folder of the recording step's own", () => {
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [join(import.meta.dirname, "../packaging/carried-plugins.ts"), ...args],
        {
          encoding: "utf8",
        },
      );
    const refused = run("pack", "--unrecorded-digests");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      "pack --unrecorded-digests needs a folder of its own, not the build's.",
    );
    const out = temp();
    const packed = run("pack", out, "--unrecorded-digests");
    expect(packed.status, packed.stderr).toBe(0);
    expect(readdirSync(out)).toContain(CARRIED_LIST_NAME);
  });

  it("is recorded only for a version the development gateway runs, in OpenClaw's form", () => {
    const record = readRecord();
    expect(() => recordSourceDigest(record, "clawtrate-voice", "2026.9.1", "a".repeat(64))).toThrow(
      "OpenClaw 2026.9.1 isn't a version carried-plugins.json names.",
    );
    expect(() =>
      recordSourceDigest(record, "clawtrate-voice", "2026.10.6", "A".repeat(64)),
    ).toThrow(`${"A".repeat(64)} isn't a source digest.`);
  });

  it("is checked for a plugin the record doesn't name", () => {
    expect(() => requireRecorded("clawtrate-other", "0.1.0", "sha256-a", undefined, [])).toThrow(
      "plugins/clawtrate-other isn't in carried-plugins.json.",
    );
  });
});

describe("the tarball", () => {
  it("is the same bytes for the same files, whatever their times and order", () => {
    const files = new Map([
      ["b.js", Buffer.from("b\n")],
      ["a.js", Buffer.from("a\n")],
    ]);
    const reversed = new Map([...files].reverse());
    expect(tarOf(reversed)).toEqual(tarOf(files));
    const plugins = pluginsCopy();
    utimesSync(join(plugins, "clawtrate-voice/index.js"), new Date(0), new Date(0));
    expect(digestNow("clawtrate-voice", plugins)).toEqual(digestNow("clawtrate-voice"));
    expect(digestOf(tarOf(files))).not.toBe(
      digestOf(tarOf(new Map([...files, ["c.js", Buffer.from("")]]))),
    );
  });
});

describe("a manifest's declared surface", () => {
  it("counts each group as OpenClaw's capability summary does", () => {
    expect(
      declaredSurface({
        channel: { id: "chat" },
        providers: ["p2", { id: "p1" }, {}],
        contracts: { tools: ["t2"], webSearchProviders: ["w"] },
        toolMetadata: { t1: {}, t2: {} },
        mcpServers: { m: {} },
        cliCommands: [{ name: "c" }],
        cliBackends: ["b"],
        skills: ["s"],
        configContracts: { dangerousFlags: [{ path: "x.y" }] },
      }),
    ).toEqual({
      channels: ["chat"],
      providers: ["p1", "p2"],
      tools: ["t1", "t2"],
      contracts: ["tools: t2", "webSearchProviders: w"],
      hooks: [],
      mcpServers: ["m"],
      cliCommands: ["c"],
      cliBackends: ["b"],
      skills: ["s"],
      dangerousConfigFlags: ["x.y"],
    });
    expect(declaredSurface({ channels: ["a"], channel: { id: "b" } }).channels).toEqual(["a"]);
  });

  it("refuses hooks, which OpenClaw doesn't report for a plugin that isn't a bundle", () => {
    // Staged on both versions with `hooks: ["before_prompt_build"]`, inspect said `hooks: []`.
    expect(() => declaredSurface({ hooks: ["before_prompt_build"] })).toThrow(
      "The manifest declares hooks, which OpenClaw doesn't report for a plugin that isn't a bundle.",
    );
  });

  it("refuses a contract family only one OpenClaw version counts", () => {
    // 2026.10.6 counts embeddedExtensionFactories, 2026.11.10 subagentProfiles; neither both.
    for (const family of ["embeddedExtensionFactories", "subagentProfiles"])
      expect(() => declaredSurface({ contracts: { [family]: ["x"] } })).toThrow(
        `The manifest declares contracts.${family}, which not every OpenClaw counts.`,
      );
  });
});

describe("where the app finds them", () => {
  it("reads both from out/plugins in a development build", () => {
    const app = temp();
    packCarried(join(app, CARRIED_BUILD_DIR));
    const places = carriedPlaces({ packaged: false, appPath: app, resourcesPath: "/nowhere" });
    expect(places).toEqual({
      list: join(app, "out/plugins/plugins.json"),
      tarballs: join(app, "out/plugins"),
    });
    const [voice] = (JSON.parse(readFileSync(places.list, "utf8")) as CarriedList).plugins;
    expect(integrityOf(readFileSync(join(places.tarballs, voice!.file)))).toBe(voice!.integrity);
  });

  it("reads the list from the archive and the tarballs from the resources when packaged", async () => {
    const config = builderConfig({}, "45.3.2");
    expect(config.files).toContain("out/plugins/plugins.json");
    expect(config.extraResources).toEqual([
      { from: "out/plugins", to: "plugins", filter: ["*.tgz"] },
    ]);

    // The packaged layout, made from the configuration as electron-builder applies it:
    // `files` packed into a real app.asar, and `extraResources` beside it.
    const app = temp();
    packCarried(join(app, CARRIED_BUILD_DIR));
    const staged = temp();
    for (const pattern of config.files as string[]) {
      if (pattern.includes("*") || !existsSync(join(app, pattern))) continue;
      mkdirSync(resolve(staged, pattern, ".."), { recursive: true });
      cpSync(join(app, pattern), join(staged, pattern));
    }
    for (const [platform, resources] of [
      ["darwin", join(temp(), "Clawtrate.app/Contents/Resources")],
      ["win32", join(temp(), "Clawtrate/resources")],
    ] as const) {
      const archive = join(resources, "app.asar");
      await createPackage(staged, archive);
      const [extra] = config.extraResources as { from: string; to: string }[];
      mkdirSync(join(resources, extra!.to), { recursive: true });
      for (const name of readdirSync(join(app, extra!.from)).filter((n) => n.endsWith(".tgz")))
        cpSync(join(app, extra!.from, name), join(resources, extra!.to, name));

      expect(carriedPlaces({ packaged: true, appPath: archive, resourcesPath: resources })).toEqual(
        { list: join(archive, "out/plugins/plugins.json"), tarballs: join(resources, "plugins") },
      );
      const { list, tarballs } = packagedCarried(resources);
      expect(list, platform).toEqual(readList(join(app, CARRIED_BUILD_DIR)));
      const [voice] = list.plugins;
      expect(integrityOf(readFileSync(join(tarballs, voice!.file))), platform).toBe(
        voice!.integrity,
      );
      // The tarball is outside the archive, where the gateway's plain Node can read it.
      expect(listPackage(archive, { isPack: false }), platform).toEqual([
        "/out",
        "/out/plugins",
        "/out/plugins/plugins.json",
      ]);
    }
  });
});
