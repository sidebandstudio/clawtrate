// The OpenClaw plugins the desktop app carries, packed for a gateway on the
// same computer to install from (issue #796).
//
//   node apps/desktop/packaging/carried-plugins.ts pack [out folder]
//   node apps/desktop/packaging/carried-plugins.ts record <plugin folder name>
//
// `pack` packs each plugin `carried-plugins.json` names from the checkout into
// apps/desktop/out/plugins (or the folder given): its tarball, and
// plugins.json, the list the app is built with. packaging/build.ts runs it
// before electron-builder, which puts the tarballs under the app's resources,
// outside its archive, and the list inside it (config.ts).
//
// `carried-plugins.json` records, for each carried plugin, the version last
// recorded and a digest of what that version packs to. Packing fails when a
// plugin's files changed but its version didn't, and when its version isn't
// the one recorded. `record` writes the plugin's current version and digest,
// and only for a version newer than the one recorded.
//
// The tarball is written here rather than by `npm pack`, so a build needs no
// npm and packs the same way on macOS and Windows. Its files and package.json
// are exactly the ones plugin-npm.ts packs for npm (`packageFiles`), each at
// `package/<path>` with npm's fixed time and modes, in a fixed order. The
// digest is of the tar before compression, so it doesn't depend on the
// computer's zlib; the list's integrity is the compressed file's SHA-512.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { parseVersion, isNewer } from "../src/main/update/version.ts";
import {
  CARRIED_BUILD_DIR,
  CARRIED_LIST_NAME,
  type CarriedList,
  type CarriedPlugin,
  type DeclaredSurface,
} from "../src/main/carried-plugins.ts";
import { integrityOf, packageFiles, readTarball } from "./plugin-npm.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
export const PLUGINS_DIR = join(ROOT, "plugins");
export const LICENSE = join(ROOT, "LICENSE");
export const RECORD = join(import.meta.dirname, "carried-plugins.json");
export const BUILD_OUT = join(ROOT, "apps/desktop", CARRIED_BUILD_DIR);

/** One plugin's line in carried-plugins.json. */
export type Recorded = { version: string; digest: string };
export type Record = { plugins: { [folder: string]: Recorded } };

export const readRecord = (path = RECORD): Record =>
  JSON.parse(readFileSync(path, "utf8")) as Record;

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
    hooks: sorted(names(manifest.hooks, "hooks")),
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
): void {
  const record = `node apps/desktop/packaging/carried-plugins.ts record ${folder}`;
  if (!recorded) throw new Error(`plugins/${folder} isn't in carried-plugins.json.`);
  if (version === recorded.version && digest !== recorded.digest)
    throw new Error(
      `plugins/${folder} changed since its version ${version} was recorded, but its version is still ${version}. Raise its version, then run \`${record}\`.`,
    );
  if (version !== recorded.version)
    throw new Error(
      `plugins/${folder} is version ${version}, but carried-plugins.json records ${recorded.version}. Run \`${record}\`.`,
    );
}

/**
 * Records the plugin's current version and digest in `record`. Refuses a
 * version that isn't newer than the one recorded, unless it is the same
 * version with the same files.
 */
export function recordPlugin(
  record: Record,
  folder: string,
  version: string,
  digest: string,
): Record {
  const recorded = record.plugins[folder];
  if (recorded && !(recorded.version === version && recorded.digest === digest)) {
    const was = parseVersion(recorded.version);
    const now = parseVersion(version);
    if (!was || !now || !isNewer(now, was))
      throw new Error(
        `plugins/${folder} is version ${version}, which isn't newer than the recorded ${recorded.version}. Raise its version.`,
      );
  }
  return { plugins: { ...record.plugins, [folder]: { version, digest } } };
}

type Packed = { entry: CarriedPlugin; files: Map<string, Buffer>; digest: string; tgz: Buffer };

/** Packs `plugins/<folder>` into a tarball's bytes and its list entry, checking nothing against the record. */
function packOne(folder: string, pluginsDir: string, license: string): Packed {
  const { manifest, pluginId, files } = packageFiles(join(pluginsDir, folder), license);
  const tar = tarOf(files);
  const tgz = gzipSync(tar, { level: 9 });
  const name = manifest.name as string;
  const version = manifest.version as string;
  const openclaw = JSON.parse(files.get("openclaw.plugin.json")!.toString("utf8")) as Json;
  const entry: CarriedPlugin = {
    name,
    version,
    pluginId,
    integrity: integrityOf(tgz),
    file: `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`,
    declared: declaredSurface(openclaw),
  };
  return { entry, files, digest: digestOf(tar), tgz };
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
  { record = readRecord(), pluginsDir = PLUGINS_DIR, license = LICENSE } = {},
): CarriedList {
  const packed = Object.keys(record.plugins)
    .sort()
    .map((folder) => {
      const one = packOne(folder, pluginsDir, license);
      requireRecorded(folder, one.entry.version, one.digest, record.plugins[folder]);
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

function main(args: string[]): void {
  const [command, ...rest] = args;
  if (command === "pack" && rest.length <= 1) {
    const out = rest[0] ? resolve(rest[0]) : BUILD_OUT;
    for (const plugin of packCarried(out).plugins)
      console.log(`Carried ${plugin.name} ${plugin.version} ${plugin.integrity}`);
  } else if (command === "record" && rest.length === 1) {
    const { version, digest } = digestNow(rest[0]!);
    writeFileSync(
      RECORD,
      `${JSON.stringify(recordPlugin(readRecord(), rest[0]!, version, digest), null, 2)}\n`,
    );
    console.log(`Recorded plugins/${rest[0]} ${version} ${digest}`);
  } else {
    throw new Error("Usage: carried-plugins.ts pack [out folder] | record <plugin folder name>");
  }
}

if (import.meta.main) main(process.argv.slice(2));
