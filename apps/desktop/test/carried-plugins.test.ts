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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  declaredSurface,
  digestNow,
  digestOf,
  LICENSE,
  packCarried,
  PLUGINS_DIR,
  readRecord,
  recordPlugin,
  requireRecorded,
  tarOf,
} from "../packaging/carried-plugins.ts";
import { builderConfig } from "../packaging/config.ts";
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

  it("are as carried-plugins.json records them in this checkout", () => {
    // A pull request that changes a carried plugin without raising its version fails here.
    const now = digestNow("clawtrate-voice");
    expect(() =>
      requireRecorded(
        "clawtrate-voice",
        now.version,
        now.digest,
        readRecord().plugins["clawtrate-voice"],
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
      name: "@clawtrate/clawtrate-voice",
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
      name: voice!.name,
      version: voice!.version,
      integrity: voice!.integrity,
    });
    expect(report!.files.map((file) => file.path).sort()).toEqual([
      "LICENSE",
      "README.md",
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
    for (const path of ["index.js", "openclaw.plugin.json", "voice.md", "README.md"])
      expect(files.get(`package/${path}`)).toEqual(readFileSync(join(VOICE, path)));
    expect(files.get("package/LICENSE")).toEqual(readFileSync(LICENSE));
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
      `plugins/clawtrate-voice changed since its version ${VOICE_VERSION} was recorded, but its version is still ${VOICE_VERSION}. Raise its version, then run \`node apps/desktop/packaging/carried-plugins.ts record clawtrate-voice\`.`,
    );
    expect(readdirSync(out)).toEqual(["kept"]);
  });

  it("must be recorded when it is raised", () => {
    const plugins = pluginsCopy();
    setVersion(plugins, "9.0.0");
    expect(() => packCarried(temp(), { pluginsDir: plugins })).toThrow(
      `plugins/clawtrate-voice is version 9.0.0, but carried-plugins.json records ${VOICE_VERSION}. Run \`node apps/desktop/packaging/carried-plugins.ts record clawtrate-voice\`.`,
    );
    const now = digestNow("clawtrate-voice", plugins);
    const record = recordPlugin(readRecord(), "clawtrate-voice", now.version, now.digest);
    expect(record.plugins["clawtrate-voice"]).toEqual({ version: "9.0.0", digest: now.digest });
    expect(packCarried(temp(), { pluginsDir: plugins, record }).plugins[0]!.version).toBe("9.0.0");
  });

  it("is recorded only when it is newer, or unchanged with the same files", () => {
    const record = { plugins: { "clawtrate-voice": { version: "0.2.0", digest: "sha256-a" } } };
    expect(recordPlugin(record, "clawtrate-voice", "0.2.0", "sha256-a")).toEqual(record);
    for (const version of ["0.2.0", "0.1.9"])
      expect(() => recordPlugin(record, "clawtrate-voice", version, "sha256-b")).toThrow(
        `plugins/clawtrate-voice is version ${version}, which isn't newer than the recorded 0.2.0. Raise its version.`,
      );
    expect(recordPlugin(record, "clawtrate-voice", "0.10.0", "sha256-b").plugins).toEqual({
      "clawtrate-voice": { version: "0.10.0", digest: "sha256-b" },
    });
  });

  it("is checked for a plugin the record doesn't name", () => {
    expect(() => requireRecorded("clawtrate-other", "0.1.0", "sha256-a", undefined)).toThrow(
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
        hooks: ["before_prompt_build"],
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
      hooks: ["before_prompt_build"],
      mcpServers: ["m"],
      cliCommands: ["c"],
      cliBackends: ["b"],
      skills: ["s"],
      dangerousConfigFlags: ["x.y"],
    });
    expect(declaredSurface({ channels: ["a"], channel: { id: "b" } }).channels).toEqual(["a"]);
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

  it("reads the list from the archive and the tarballs from the resources when packaged", () => {
    const config = builderConfig({}, "45.3.2");
    expect(config.files).toContain("out/plugins/plugins.json");
    expect(config.extraResources).toEqual([
      { from: "out/plugins", to: "plugins", filter: ["*.tgz"] },
    ]);

    // The packaged layout, made from the configuration as electron-builder applies it:
    // `files` go into app.asar (a folder here, which plain Node can read), and
    // `extraResources` beside it.
    const app = temp();
    const built = join(app, CARRIED_BUILD_DIR);
    packCarried(built);
    for (const [platform, resources] of [
      ["darwin", join(temp(), "Clawtrate.app/Contents/Resources")],
      ["win32", join(temp(), "Clawtrate/resources")],
    ] as const) {
      const archive = join(resources, "app.asar");
      for (const pattern of config.files as string[]) {
        if (pattern.includes("*") || !existsSync(join(app, pattern))) continue;
        mkdirSync(resolve(archive, pattern, ".."), { recursive: true });
        cpSync(join(app, pattern), join(archive, pattern));
      }
      const [extra] = config.extraResources as { from: string; to: string }[];
      mkdirSync(join(resources, extra!.to), { recursive: true });
      for (const name of readdirSync(join(app, extra!.from)).filter((n) => n.endsWith(".tgz")))
        cpSync(join(app, extra!.from, name), join(resources, extra!.to, name));

      const places = carriedPlaces({ packaged: true, appPath: archive, resourcesPath: resources });
      expect(places, platform).toEqual({
        list: join(archive, "out/plugins/plugins.json"),
        tarballs: join(resources, "plugins"),
      });
      const [voice] = (JSON.parse(readFileSync(places.list, "utf8")) as CarriedList).plugins;
      expect(integrityOf(readFileSync(join(places.tarballs, voice!.file))), platform).toBe(
        voice!.integrity,
      );
      // The tarball is outside the archive, where the gateway's plain Node can read it.
      expect(existsSync(join(archive, "out/plugins", voice!.file)), platform).toBe(false);
    }
  });
});
