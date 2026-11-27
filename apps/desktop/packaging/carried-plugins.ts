// The OpenClaw plugins the desktop app carries, packed for a gateway on the
// same computer to install from (issue #796).
//
//   node apps/desktop/packaging/carried-plugins.ts pack [out folder] [--unrecorded-digests]
//   node apps/desktop/packaging/carried-plugins.ts record <plugin folder name>
//   node apps/desktop/packaging/carried-plugins.ts bump <plugin folder name>
//   node apps/desktop/packaging/carried-plugins.ts source-digest <plugin folder name> <OpenClaw version> <digest>
//
// `pack` packs each plugin `carried-plugins.json` names from the checkout into
// apps/desktop/out/plugins (or the folder given): its tarball, and
// plugins.json, the list the app is built with. packaging/build.ts runs it
// before electron-builder, which puts the tarballs under the app's resources,
// outside its archive, and the list inside it (config.ts).
//
// `carried-plugins.json` records, for each carried plugin, the version last
// recorded and a digest of what that version packs to; the grants the plugin
// is given when it is enabled; and, for each OpenClaw version it names in
// `openclaw` (the versions the development gateway runs; a test holds them to
// tools/dev-gateway/src/versions.ts), the source digest that version's gateway reported when it loaded that packing
// (`plugins.setEnabled`'s `runtime.sourceDigests`). Packing fails when a
// plugin's files changed but its version didn't, when its version isn't the
// one recorded, and when any OpenClaw version it names has no source digest.
// `record` writes the plugin's current version and digest, only for a version
// newer than the one recorded, and drops the source digests, which belonged to
// the old packing. `bump` raises the version's patch number and records it.
// `source-digest` records one source digest for the recorded packing.
//
// The tarball is written here rather than by `npm pack`, so a build needs no
// npm and packs the same way on macOS and Windows. It holds the files the
// plugin's package.json `files` list names and that package.json without
// `private`, as plugin-npm.ts packs them for npm (`packageFiles`) but without
// npm's README and LICENSE, each at `package/<path>` with npm's fixed time and
// modes, in a fixed order. The
// digest is of the tar before compression, so it doesn't depend on the
// computer's zlib; the list's integrity is the compressed file's SHA-512.

import { extractFile, uncache } from "@electron/asar";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { parseVersion, isNewer } from "../src/main/update/version.ts";
import {
  CARRIED_BUILD_DIR,
  CARRIED_LIST_NAME,
  carriedPlaces,
  type CarriedList,
  type CarriedPlugin,
  type DeclaredSurface,
  type Grants,
} from "../src/main/carried-plugins.ts";
import { integrityOf, packageFiles, readTarball } from "./plugin-npm.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
export const PLUGINS_DIR = join(ROOT, "plugins");
export const LICENSE = join(ROOT, "LICENSE");
export const RECORD = join(import.meta.dirname, "carried-plugins.json");
export const BUILD_OUT = join(ROOT, "apps/desktop", CARRIED_BUILD_DIR);

/** One plugin's line in carried-plugins.json. */
export type Recorded = {
  version: string;
  digest: string;
  grants: Grants;
  /** By OpenClaw version, for the recorded packing. */
  sourceDigests: { [openclawVersion: string]: string };
};
export type CarriedRecord = {
  /** The OpenClaw versions every carried plugin needs a source digest for. */
  openclaw: string[];
  plugins: { [folder: string]: Recorded };
};

export const readRecord = (path = RECORD): CarriedRecord =>
  JSON.parse(readFileSync(path, "utf8")) as CarriedRecord;

/** npm's time for every file it packs, 1985-10-26T08:15:00Z, in seconds. */
const PACK_TIME = 499162500;

const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;

/**
 * A tar of `files` at `package/<path>`, in path order, each a plain file of
 * mode 644 with npm's time and no owner. The same files give the same bytes.
 */
export function tarOf(files: Map<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path)!;
    const name = `package/${path}`;
    if (Buffer.byteLength(name) > 100) throw new Error(`${path} is too long a path to pack.`);
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write(octal(0o644, 8), 100, "ascii");
    header.write(octal(0, 8), 108, "ascii");
    header.write(octal(0, 8), 116, "ascii");
    header.write(octal(bytes.length, 12), 124, "ascii");
    header.write(octal(PACK_TIME, 12), 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0" + "00", 257, "ascii");
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** The digest carried-plugins.json records: the SHA-256 of the uncompressed tar. */
export const digestOf = (tar: Buffer) =>
  `sha256-${createHash("sha256").update(tar).digest("base64")}`;

/**
 * The contract families both OpenClaw versions count in a plugin's declared
 * surface (`PLUGIN_MANIFEST_CONTRACT_KEYS`: `<2026.10.6>/dist/manifest-contract-keys-WtA6uWDt.mjs`,
 * `<2026.11.10>/dist/manifest-contract-keys-BTtgVkx2.mjs`). A family only one
 * of them counts would make the two report different surfaces, so a carried
 * plugin may declare no other.
 */
const CONTRACT_FAMILIES = new Set([
  "codeModeExecutors",
  "agentToolResultMiddleware",
  "trustedToolPolicies",
  "externalAuthProviders",
  "decisionProviders",
  "embeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "documentExtractors",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webContentExtractors",
  "webFetchProviders",
  "webSearchProviders",
  "workerProviders",
  "storageProviders",
  "usageProviders",
  "migrationProviders",
  "gatewayMethodDispatch",
  "tools",
]);

type Json = { [key: string]: unknown };
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const names = (value: unknown, where: string): string[] => {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  throw new Error(`The manifest's ${where} isn't a list of names.`);
};
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/**
 * Every capability group a manifest declares, as both OpenClaw versions'
 * `buildPluginCapabilitySummary` counts it for `plugins.inspect`'s `declared`
 * (`<2026.10.6>/dist/capability-summary-CFDZfvsK.mjs`; the same groups in
 * `<2026.11.10>/dist/capability-summary-D1Y-zikG.mjs`).
 */
export function declaredSurface(manifest: Json): DeclaredSurface {
  const contracts = isObject(manifest.contracts) ? manifest.contracts : {};
  for (const family of Object.keys(contracts))
    if (!CONTRACT_FAMILIES.has(family))
      throw new Error(
        `The manifest declares contracts.${family}, which not every OpenClaw counts.`,
      );
  if (manifest.hooks !== undefined)
    throw new Error(
      "The manifest declares hooks, which OpenClaw doesn't report for a plugin that isn't a bundle.",
    );
  const channel = isObject(manifest.channel) ? manifest.channel.id : undefined;
  const providers = Array.isArray(manifest.providers) ? manifest.providers : [];
  const objectKeys = (value: unknown) => (isObject(value) ? Object.keys(value) : []);
  const commands = Array.isArray(manifest.cliCommands) ? manifest.cliCommands : [];
  const flags = isObject(manifest.configContracts)
    ? manifest.configContracts.dangerousFlags
    : undefined;
  return {
    channels: sorted(
      manifest.channels !== undefined
        ? names(manifest.channels, "channels")
        : typeof channel === "string"
          ? [channel]
          : [],
    ),
    providers: sorted(
      providers.flatMap((provider: unknown) =>
        typeof provider === "string"
          ? [provider]
          : isObject(provider) && typeof provider.id === "string"
            ? [provider.id]
            : [],
      ),
    ),
    tools: sorted([
      ...names(contracts.tools, "contracts.tools"),
      ...objectKeys(manifest.toolMetadata),
    ]),
    contracts: sorted(
      Object.entries(contracts).flatMap(([family, ids]) =>
        names(ids, `contracts.${family}`).map((id) => `${family}: ${id}`),
      ),
    ),
    // A plugin that isn't a bundle reports no hooks, whatever its manifest says: both
    // versions build its record with `hooks: []` (`buildPluginManifestRecord`,
    // `<2026.10.6>/dist/manifest-registry-build-BGqXwGUm.mjs:388`), and so `declared.hooks` is
    // empty (ran on both). A manifest that names hooks would make the list promise what the
    // gateway can't report, so it is refused above.
    hooks: [],
    mcpServers: sorted(objectKeys(manifest.mcpServers)),
    cliCommands: sorted(
      commands.flatMap((command: unknown) =>
        isObject(command) && typeof command.name === "string" ? [command.name] : [],
      ),
    ),
    cliBackends: sorted(names(manifest.cliBackends, "cliBackends")),
    skills: sorted(names(manifest.skills, "skills")),
    dangerousConfigFlags: sorted(
      (Array.isArray(flags) ? flags : []).flatMap((flag: unknown) =>
        isObject(flag) && typeof flag.path === "string" ? [flag.path] : [],
      ),
    ),
  };
}

/**
 * Fails unless `version` and `digest` are what `recorded` says of `folder`:
 * a plugin whose files changed needs a new version, and a new version needs
 * recording.
 */
export function requireRecorded(
  folder: string,
  version: string,
  digest: string,
  recorded: Recorded | undefined,
  openclawVersions: readonly string[],
): void {
  const record = `node apps/desktop/packaging/carried-plugins.ts record ${folder}`;
  if (!recorded) throw new Error(`plugins/${folder} isn't in carried-plugins.json.`);
  if (version === recorded.version && digest !== recorded.digest)
    throw new Error(
      `plugins/${folder} changed since its version ${version} was recorded, but its version is still ${version}. Run \`node apps/desktop/packaging/carried-plugins.ts bump ${folder}\`.`,
    );
  if (version !== recorded.version)
    throw new Error(
      `plugins/${folder} is version ${version}, but carried-plugins.json records ${recorded.version}. Run \`${record}\`.`,
    );
  for (const openclaw of openclawVersions)
    if (!SOURCE_DIGEST.test(recorded.sourceDigests?.[openclaw] ?? ""))
      throw new Error(
        `plugins/${folder} ${version} has no source digest for OpenClaw ${openclaw}. Install it on a development gateway of that version and run \`node apps/desktop/packaging/carried-plugins.ts source-digest ${folder} ${openclaw} <digest>\` with the digest its runtime reported.`,
      );
}

/** `runtime.sourceDigests`' form: a SHA-256 in lowercase hex. */
const SOURCE_DIGEST = /^[0-9a-f]{64}$/;

/** Records the source digest OpenClaw `openclaw` reported for the recorded packing of `folder`. */
export function recordSourceDigest(
  record: CarriedRecord,
  folder: string,
  openclaw: string,
  digest: string,
): CarriedRecord {
  const recorded = record.plugins[folder];
  if (!recorded) throw new Error(`plugins/${folder} isn't in carried-plugins.json.`);
  if (!record.openclaw.includes(openclaw))
    throw new Error(`OpenClaw ${openclaw} isn't a version carried-plugins.json names.`);
  if (!SOURCE_DIGEST.test(digest)) throw new Error(`${digest} isn't a source digest.`);
  const sourceDigests = { ...recorded.sourceDigests, [openclaw]: digest };
  return { ...record, plugins: { ...record.plugins, [folder]: { ...recorded, sourceDigests } } };
}

/**
 * Records the plugin's current version and digest in `record`, keeping its
 * grants and dropping its source digests. Refuses a plugin the record doesn't
 * name, and a version that isn't newer than the one recorded, unless it is the
 * same version with the same files.
 */
export function recordPlugin(
  record: CarriedRecord,
  folder: string,
  version: string,
  digest: string,
): CarriedRecord {
  const recorded = record.plugins[folder];
  if (!recorded)
    throw new Error(
      `plugins/${folder} isn't in carried-plugins.json. A plugin joins it, with its grants, in the pull request after its review.`,
    );
  if (recorded.version === version && recorded.digest === digest) return record;
  const was = parseVersion(recorded.version);
  const now = parseVersion(version);
  if (!was || !now || !isNewer(now, was))
    throw new Error(
      `plugins/${folder} is version ${version}, which isn't newer than the recorded ${recorded.version}. Raise its version.`,
    );
  const next = { version, digest, grants: recorded.grants, sourceDigests: {} };
  return { ...record, plugins: { ...record.plugins, [folder]: next } };
}

type Packed = { entry: CarriedPlugin; files: Map<string, Buffer>; digest: string; tgz: Buffer };

/** Packs `plugins/<folder>` into a tarball's bytes and its list entry, checking nothing against the record. */
function packOne(
  folder: string,
  pluginsDir: string,
  license: string,
  recorded?: Recorded,
  openclawVersions: readonly string[] = [],
): Packed {
  const { manifest, pluginId, files } = packageFiles(join(pluginsDir, folder), license);
  // Only what the gateway loads and runs: npm's package adds the README and the LICENSE, which
  // OpenClaw doesn't need, so a change to either never makes a new version of the plugin.
  files.delete("README.md");
  files.delete("LICENSE");
  const tar = tarOf(files);
  const tgz = gzipSync(tar, { level: 9 });
  const name = manifest.name as string;
  const version = manifest.version as string;
  if (parseVersion(version)?.length !== 3)
    throw new Error(`plugins/${folder}'s version ${version} isn't a canonical x.y.z.`);
  const openclaw = JSON.parse(files.get("openclaw.plugin.json")!.toString("utf8")) as Json;
  const entry: CarriedPlugin = {
    packageName: name,
    version,
    pluginId,
    integrity: integrityOf(tgz),
    file: `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`,
    declared: declaredSurface(openclaw),
    grants: recorded?.grants ?? {},
    sourceDigests: Object.fromEntries(
      openclawVersions.map((openclaw) => [openclaw, recorded?.sourceDigests?.[openclaw] ?? ""]),
    ),
  };
  return { entry, files, digest: digestOf(tar), tgz };
}

/**
 * Raises the patch number of `plugins/<folder>`'s version, in its package.json and in each of its
 * JavaScript files' `PLUGIN_VERSION = "<old>"`, and returns the new version and its digest.
 */
export function bumpPlugin(folder: string, pluginsDir = PLUGINS_DIR, license = LICENSE) {
  const dir = join(pluginsDir, folder);
  const path = join(dir, "package.json");
  const text = readFileSync(path, "utf8");
  const old = (JSON.parse(text) as { version: string }).version;
  const parsed = parseVersion(old);
  if (parsed?.length !== 3) throw new Error(`plugins/${folder}'s version ${old} isn't x.y.z.`);
  const next = `${parsed[0]}.${parsed[1]}.${parsed[2] + 1}`;
  writeFileSync(path, text.replace(`"version": "${old}"`, `"version": "${next}"`));
  const { files } = packageFiles(dir, license);
  for (const file of files.keys())
    if (file.endsWith(".js")) {
      const code = readFileSync(join(dir, file), "utf8");
      const raised = code.replace(`PLUGIN_VERSION = "${old}"`, `PLUGIN_VERSION = "${next}"`);
      if (raised !== code) writeFileSync(join(dir, file), raised);
    }
  return digestNow(folder, pluginsDir, license);
}

/** The plugin's current version and digest, for `record`. */
export function digestNow(folder: string, pluginsDir = PLUGINS_DIR, license = LICENSE) {
  const { entry, digest } = packOne(folder, pluginsDir, license);
  return { version: entry.version, digest };
}

/**
 * Packs every plugin `record` names into `out`, which is emptied first: each
 * tarball, and the list (`plugins.json`). Fails, writing nothing, when any
 * plugin isn't as recorded. Each tarball is read back and must hold exactly
 * its plugin's files.
 */
export function packCarried(
  out: string,
  {
    record = readRecord(),
    pluginsDir = PLUGINS_DIR,
    license = LICENSE,
    /** For the development gateway's `--install-plugin`, which measures them: never a build. */
    unrecordedDigests = false,
  } = {},
): CarriedList {
  const packed = Object.keys(record.plugins)
    .sort()
    .map((folder) => {
      const recorded = record.plugins[folder];
      const one = packOne(folder, pluginsDir, license, recorded, record.openclaw);
      requireRecorded(
        folder,
        one.entry.version,
        one.digest,
        recorded,
        unrecordedDigests ? [] : record.openclaw,
      );
      return one;
    });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const { entry, files, tgz } of packed) {
    const path = join(out, entry.file);
    writeFileSync(path, tgz);
    const back = readTarball(path);
    if (
      integrityOf(readFileSync(path)) !== entry.integrity ||
      back.size !== files.size ||
      [...files].some(([file, bytes]) => !back.get(`package/${file}`)?.equals(bytes))
    )
      throw new Error(`${path} doesn't read back as the files packed.`);
  }
  const list: CarriedList = { plugins: packed.map(({ entry }) => entry) };
  writeFileSync(join(out, CARRIED_LIST_NAME), `${JSON.stringify(list, null, 2)}\n`);
  return list;
}

/**
 * What a packaged app carries: the list read from its archive, and the folder
 * of its tarballs, where the app looks for them (`resources` is
 * `Contents/Resources` on macOS, `resources` on Windows).
 */
export function packagedCarried(resources: string): { list: CarriedList; tarballs: string } {
  const archive = join(resources, "app.asar");
  const { tarballs } = carriedPlaces({
    packaged: true,
    appPath: archive,
    resourcesPath: resources,
  });
  uncache(archive);
  const list = JSON.parse(
    extractFile(archive, join(CARRIED_BUILD_DIR, CARRIED_LIST_NAME)).toString("utf8"),
  ) as CarriedList;
  return { list, tarballs };
}

function main(args: string[]): void {
  const [command, ...rest] = args;
  const unrecordedDigests = rest.includes("--unrecorded-digests");
  const operands = rest.filter((arg) => arg !== "--unrecorded-digests");
  if (command === "pack" && operands.length <= 1) {
    const out = operands[0] ? resolve(operands[0]) : BUILD_OUT;
    for (const plugin of packCarried(out, { unrecordedDigests }).plugins)
      console.log(`Carried ${plugin.packageName} ${plugin.version} ${plugin.integrity}`);
  } else if (command === "record" && rest.length === 1) {
    const { version, digest } = digestNow(rest[0]!);
    writeFileSync(
      RECORD,
      `${JSON.stringify(recordPlugin(readRecord(), rest[0]!, version, digest), null, 2)}\n`,
    );
    console.log(`Recorded plugins/${rest[0]} ${version} ${digest}`);
  } else if (command === "bump" && rest.length === 1) {
    const { version, digest } = bumpPlugin(rest[0]!);
    const record = recordPlugin(readRecord(), rest[0]!, version, digest);
    writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Raised plugins/${rest[0]} to ${version} and recorded it.`);
  } else if (command === "source-digest" && rest.length === 3) {
    const [folder, openclaw, digest] = rest as [string, string, string];
    const record = recordSourceDigest(readRecord(), folder, openclaw, digest);
    writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Recorded plugins/${folder}'s source digest on OpenClaw ${openclaw}`);
  } else {
    throw new Error(
      "Usage: carried-plugins.ts pack [out folder] | record <plugin folder name> | bump <plugin folder name> | source-digest <plugin folder name> <OpenClaw version> <digest>",
    );
  }
}

if (import.meta.main) main(process.argv.slice(2));
