// Packs Clawtrate's OpenClaw plugins for npm and publishes them, for
// .github/workflows/plugins-publish.yml. docs/development/plugins-publish.md
// says how the workflow uses it.
//
//   node apps/desktop/packaging/plugin-npm.ts on-main
//   node apps/desktop/packaging/plugin-npm.ts pack <plugin folder> <out folder>
//   node apps/desktop/packaging/plugin-npm.ts placeholder <plugin folder> <out folder>
//   node apps/desktop/packaging/plugin-npm.ts publish <tarball> <name> <version> <integrity> <plugin id> <out folder>
//
// `on-main` fails unless the run's commit (GITHUB_SHA) is on origin's main.
// `pack` packs the files the plugin's package.json lists, from a clean folder,
// with a copy of that package.json without `private`. `placeholder` packs a
// package of the plugin's name at 0.0.0 with no code in it. `publish`
// publishes a packed tarball, once: a version already on the registry with
// the same integrity is left as it is, and one with any other integrity
// fails. Just before it publishes, it checks again that the run's commit is
// on main. Each writes what it made, and the commit it came from, to the
// job's outputs and summary when GitHub Actions gives their files.
//
// npm runs in a folder holding only the files to pack, and with
// --ignore-scripts. npm packs every file with the same fixed time, in a fixed
// order, so the same files and the same npm give the same tarball.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const SCOPE = "@clawtrate";
export const PLACEHOLDER_VERSION = "0.0.0";
const VERSION = /^\d+\.\d+\.\d+$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
];
/** Fields that make npm pack files the `files` list doesn't name. */
const EXTRA_FILE_FIELDS = ["main", "bin", "browser"];
/** A `files` entry: a relative path of plain names, none starting with a dot; a folder ends in `/`. */
const FILES_ENTRY = /^[\w-][\w.-]*(?:\/[\w-][\w.-]*)*\/?$/;

export type Npm = (
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string };

export const runNpm: Npm = (args, cwd) => {
  const result = spawnSync("npm", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
};

export type Git = Npm;

const runGit: Git = (args, cwd) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
};

/**
 * Fails unless `commit` is on origin's main, read fresh from origin. A main
 * rewritten since the run started fails it.
 */
export function requireOnMain(commit: string, cwd: string, git: Git = runGit): void {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${commit} is not a full commit.`);
  const fetched = git(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--filter=blob:none",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ],
    cwd,
  );
  if (fetched.status !== 0) throw new Error(`git couldn't read origin's main:\n${fetched.stderr}`);
  const ancestor = git(["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"], cwd);
  if (ancestor.status === 1) throw new Error(`${commit} is not on main.`);
  if (ancestor.status !== 0)
    throw new Error(`git couldn't tell whether ${commit} is on main:\n${ancestor.stderr}`);
}

export type Packed = {
  name: string;
  version: string;
  integrity: string;
  file: string;
  pluginId: string;
};

/** npm's integrity for these bytes: `sha512-` and the base64 SHA-512. */
export function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

type Manifest = Record<string, unknown>;

const readJson = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8")) as Manifest;

/**
 * The package.json npm publishes for the plugin in `folder`: the in-repo one
 * without `private`. It refuses one that isn't named `@clawtrate/<folder>`,
 * has no exact version, no `files` list of plain paths or no `openclaw`
 * extensions, has any dependency, or names files outside the list through
 * `main`, `bin` or `browser`.
 */
export function publishedManifest(pkg: Manifest, folder: string): Manifest {
  const problems: string[] = [];
  if (pkg.name !== `${SCOPE}/${folder}`) problems.push(`its name must be ${SCOPE}/${folder}`);
  if (typeof pkg.version !== "string" || !VERSION.test(pkg.version))
    problems.push("its version must be an exact x.y.z");
  if (pkg.version === PLACEHOLDER_VERSION)
    problems.push(`${PLACEHOLDER_VERSION} is the placeholder's version`);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) problems.push("it needs a files list");
  else if (!pkg.files.every((entry) => typeof entry === "string" && FILES_ENTRY.test(entry)))
    problems.push("its files list may hold only plain relative paths, none starting with a dot");
  const extensions = (pkg.openclaw as { extensions?: unknown } | undefined)?.extensions;
  if (
    !Array.isArray(extensions) ||
    extensions.length === 0 ||
    !extensions.every((entry) => typeof entry === "string" && entry !== "")
  )
    problems.push("it needs openclaw.extensions, a list of the files OpenClaw runs");
  for (const field of [...DEPENDENCY_FIELDS, ...EXTRA_FILE_FIELDS]) {
    if (field in pkg) problems.push(`it may have no ${field}`);
  }
  if (problems.length > 0)
    throw new Error(`plugins/${folder}/package.json can't be published: ${problems.join("; ")}.`);
  const { private: _private, ...published } = pkg;
  return published;
}

/** The placeholder's package.json: the plugin's name at 0.0.0, with no `openclaw` entry. */
export function placeholderManifest(pkg: Manifest): Manifest {
  return {
    name: pkg.name,
    version: PLACEHOLDER_VERSION,
    description: "A placeholder with no code. Install a released version.",
    license: pkg.license,
    repository: pkg.repository,
  };
}

/**
 * Runs `npm pack` in `stage` and checks the tarball it wrote against npm's own
 * report, and its files against `expected`, exactly.
 */
function npmPack(
  stage: string,
  out: string,
  expected: string[],
  npm: Npm,
): { file: string; integrity: string } {
  const result = npm(["pack", "--json", "--ignore-scripts", "--pack-destination", out], stage);
  if (result.status !== 0) throw new Error(`npm pack failed:\n${result.stderr}`);
  const [report] = JSON.parse(result.stdout) as {
    filename: string;
    integrity: string;
    files: { path: string }[];
  }[];
  if (!report) throw new Error("npm pack reported no tarball.");
  const file = join(out, basename(report.filename));
  const integrity = integrityOf(readFileSync(file));
  if (integrity !== report.integrity)
    throw new Error(`${file} is ${integrity}, but npm pack reported ${report.integrity}.`);
  const files = report.files.map((entry) => entry.path).sort();
  const want = [...expected].sort();
  const extra = files.filter((path) => !want.includes(path));
  const missing = want.filter((path) => !files.includes(path));
  if (extra.length > 0 || missing.length > 0)
    throw new Error(
      `The tarball's files aren't the expected ones: ${[
        ...extra.map((path) => `${path} is extra`),
        ...missing.map((path) => `${path} is missing`),
      ].join(", ")}.`,
    );
  return { file, integrity };
}

/**
 * The files a `files` list names in `dir`, as paths relative to it: each file,
 * and every file under each folder. Fails on a missing entry, a link
 * anywhere on an entry's path, or a name starting with a dot.
 */
export function listedFiles(dir: string, entries: string[]): string[] {
  const found: string[] = [];
  const visit = (path: string) => {
    const stat = lstatSync(join(dir, path), { throwIfNoEntry: false });
    if (!stat) throw new Error(`The files list names ${path}, which isn't there.`);
    if (stat.isSymbolicLink()) throw new Error(`${path} is a link, which isn't packed.`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(dir, path)).sort()) {
        if (name.startsWith(".")) throw new Error(`${path}/${name} starts with a dot.`);
        visit(`${path}/${name}`);
      }
    } else if (stat.isFile()) {
      if (!found.includes(path)) found.push(path);
    } else throw new Error(`${path} is neither a file nor a folder.`);
  };
  for (const entry of entries) {
    const path = entry.replace(/\/$/, "");
    // A link in a parent folder would pull in files from elsewhere, too.
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (lstatSync(join(dir, parent), { throwIfNoEntry: false })?.isSymbolicLink())
        throw new Error(`${parent} is a link, which isn't packed.`);
    }
    visit(path);
  }
  return found;
}

const scratch = () => mkdtempSync(join(tmpdir(), "clawtrate-plugin-npm-"));

/**
 * Packs the plugin in `pluginDir` into `out`, from a clean folder holding only
 * the files its `files` list names, its README, the published package.json
 * and the repository's LICENSE. Fails unless its manifest's id is the
 * folder's name, the list holds the manifest and every file OpenClaw runs,
 * and the tarball holds exactly those files.
 */
export function packPlugin(
  pluginDir: string,
  out: string,
  license: string,
  npm: Npm = runNpm,
): Packed {
  const folder = basename(resolve(pluginDir));
  const manifest = publishedManifest(readJson(join(pluginDir, "package.json")), folder);
  const pluginId = readJson(join(pluginDir, "openclaw.plugin.json")).id;
  if (pluginId !== folder)
    throw new Error(`plugins/${folder}/openclaw.plugin.json must have the id ${folder}.`);
  const listed = listedFiles(pluginDir, manifest.files as string[]);
  const extensions = (manifest.openclaw as { extensions: string[] }).extensions;
  for (const needed of [
    "openclaw.plugin.json",
    ...extensions.map((path) => path.replace(/^\.\//, "")),
  ]) {
    if (!listed.includes(needed)) throw new Error(`The files list leaves out ${needed}.`);
  }
  const extras = ["README.md"].filter((path) =>
    lstatSync(join(pluginDir, path), { throwIfNoEntry: false })?.isFile(),
  );
  const stage = scratch();
  try {
    for (const path of [...listed, ...extras]) {
      mkdirSync(dirname(join(stage, path)), { recursive: true });
      cpSync(join(pluginDir, path), join(stage, path));
    }
    cpSync(license, join(stage, "LICENSE"));
    writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(out, { recursive: true });
    const expected = [...listed, ...extras, "LICENSE", "package.json"];
    const packed = npmPack(stage, resolve(out), expected, npm);
    return {
      name: manifest.name as string,
      version: manifest.version as string,
      integrity: packed.integrity,
      file: packed.file,
      pluginId,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Packs the placeholder for the plugin in `pluginDir` into `out`: a package.json and a README. */
export function packPlaceholder(pluginDir: string, out: string, npm: Npm = runNpm): Packed {
  const pkg = readJson(join(pluginDir, "package.json"));
  const manifest = placeholderManifest(pkg);
  const stage = scratch();
  try {
    writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(stage, "README.md"),
      `# ${String(manifest.name)}\n\nThis version is a placeholder and holds no code. Install a released version.\n`,
    );
    mkdirSync(out, { recursive: true });
    const packed = npmPack(stage, resolve(out), ["package.json", "README.md"], npm);
    return {
      name: String(manifest.name),
      version: PLACEHOLDER_VERSION,
      integrity: packed.integrity,
      file: packed.file,
      pluginId: "",
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * The integrity the registry has for `name@version`, or null when it has no
 * such version or package. Any other answer fails.
 */
export function registryIntegrity(
  name: string,
  version: string,
  cwd: string,
  npm: Npm = runNpm,
): string | null {
  const result = npm(
    ["view", `${name}@${version}`, "dist.integrity", "--json", "--prefer-online"],
    cwd,
  );
  const answer = (() => {
    try {
      return result.stdout.trim() === "" ? undefined : (JSON.parse(result.stdout) as unknown);
    } catch {
      return undefined;
    }
  })();
  if (result.status === 0 && typeof answer === "string") return answer;
  const code = (answer as { error?: { code?: unknown } } | undefined)?.error?.code;
  if (result.status !== 0 && code === "E404") return null;
  throw new Error(
    `npm view ${name}@${version} gave no integrity:\n${result.stderr || result.stdout}`,
  );
}

/** Whether to publish: yes when the registry lacks the version; no when it has these bytes; otherwise it fails. */
export function needsPublish(
  name: string,
  version: string,
  integrity: string,
  onRegistry: string | null,
): boolean {
  if (onRegistry === null) return true;
  if (onRegistry === integrity) return false;
  throw new Error(
    `${name}@${version} is already on the registry as ${onRegistry}, not ${integrity}. A published version is never replaced: raise the plugin's version.`,
  );
}

export type Published = Packed & { published: boolean };

/** The regular files in a .tgz npm packed, by their path in it (`package/…`). */
export function readTarball(file: string): Map<string, Buffer> {
  const tar = gunzipSync(readFileSync(file));
  const files = new Map<string, Buffer>();
  let paxPath: string | undefined;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const body = tar.subarray(at + 512, at + 512 + size);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = undefined;
    if (type === "x") paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
    else if (type === "0" || type === "") files.set(name, Buffer.from(body));
    else if (type !== "5") throw new Error(`${file} holds a tar entry of type ${type}.`);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** A JSON file of a packed tarball, by its path in the package. */
function packedJson(files: Map<string, Buffer>, path: string): Manifest {
  const bytes = files.get(`package/${path}`);
  if (!bytes) throw new Error(`The tarball has no ${path}.`);
  return JSON.parse(bytes.toString("utf8")) as Manifest;
}

const stringList = (value: unknown, where: string): string[] => {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  throw new Error(`The packed ${where} isn't a list of names.`);
};

export type LockEntry = {
  name: string;
  version: string;
  integrity: string;
  pluginId: string;
  tools: string[];
  hooks: string[];
  commit: string;
};

/**
 * What the lock says of one published tarball, read from the tarball's own
 * package.json and openclaw.plugin.json. Its tools and hooks are the ones the
 * manifest declares, counted as OpenClaw counts them for its capability
 * review (`buildPluginCapabilitySummary` in 2026.10.6): `contracts.tools`
 * with the keys of `toolMetadata`, and `hooks`.
 */
export function lockEntry(file: string, integrity: string, commit: string): LockEntry {
  const files = readTarball(file);
  const pkg = packedJson(files, "package.json");
  const manifest = packedJson(files, "openclaw.plugin.json");
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string")
    throw new Error("The packed package.json has no name or version.");
  if (typeof manifest.id !== "string")
    throw new Error("The packed openclaw.plugin.json has no id.");
  const contracts = (manifest.contracts ?? {}) as Manifest;
  const toolMetadata = (manifest.toolMetadata ?? {}) as Manifest;
  return {
    name: pkg.name,
    version: pkg.version,
    integrity,
    pluginId: manifest.id,
    tools: [
      ...new Set([...stringList(contracts.tools, "contracts.tools"), ...Object.keys(toolMetadata)]),
    ].sort(),
    hooks: [...new Set(stringList(manifest.hooks, "hooks"))].sort(),
    commit,
  };
}

export type PublishOptions = {
  /** Runs just before `npm publish`; a throw publishes nothing. */
  beforePublish: () => void;
  npm?: Npm;
  wait?: (ms: number) => Promise<void>;
};

/**
 * Publishes `tarball` as `name@version` unless the registry already has it,
 * then reads the registry's integrity back and fails unless it is `integrity`.
 */
export async function publishTarball(
  packed: Packed,
  {
    beforePublish,
    npm = runNpm,
    wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  }: PublishOptions,
): Promise<Published> {
  const { name, version, integrity, file } = packed;
  if (!INTEGRITY.test(integrity)) throw new Error(`${integrity} is not a sha512 integrity.`);
  const actual = integrityOf(readFileSync(file));
  if (actual !== integrity) throw new Error(`${file} is ${actual}, not the packed ${integrity}.`);
  const own = lockEntry(file, integrity, "");
  if (own.name !== name || own.version !== version || own.pluginId !== packed.pluginId)
    throw new Error(
      `${file} holds ${own.name}@${own.version} with plugin id ${own.pluginId}, not ${name}@${version} with ${packed.pluginId}.`,
    );
  const cwd = resolve(file, "..");
  if (!needsPublish(name, version, integrity, registryIntegrity(name, version, cwd, npm)))
    return { ...packed, published: false };
  beforePublish();
  const result = npm(["publish", resolve(file), "--provenance", "--access", "public"], cwd);
  if (result.status !== 0) throw new Error(`npm publish failed:\n${result.stderr}`);
  // The registry can take a moment to list a new version.
  for (let attempt = 1; ; attempt++) {
    const read = registryIntegrity(name, version, cwd, npm);
    if (read === integrity) return { ...packed, published: true };
    if (read !== null)
      throw new Error(
        `The registry lists ${name}@${version} as ${read}, not the published ${integrity}.`,
      );
    if (attempt === 10)
      throw new Error(`The registry still doesn't list ${name}@${version} after publishing.`);
    await wait(6000);
  }
}

/**
 * Writes what was packed or published from `commit` to the job's outputs and
 * summary, when GitHub gives their files.
 */
export function report(
  result: Packed | Published,
  commit: string,
  heading: string,
  env: NodeJS.ProcessEnv,
): void {
  if (env.GITHUB_OUTPUT) {
    const lines = [
      `commit=${commit}`,
      `name=${result.name}`,
      `version=${result.version}`,
      `integrity=${result.integrity}`,
      `file=${basename(result.file)}`,
      `plugin-id=${result.pluginId}`,
      ...("published" in result ? [`published=${result.published}`] : []),
    ];
    appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const rows = [
      ["Commit", commit],
      ["Package", result.name],
      ["Version", result.version],
      ["File", basename(result.file)],
      ["Integrity", result.integrity],
      ...("published" in result
        ? [["Published now", result.published ? "yes" : "no, it was already there"]]
        : []),
    ];
    const table = rows.map(([key, value]) => `| ${key} | \`${value}\` |`).join("\n");
    appendFileSync(env.GITHUB_STEP_SUMMARY, `## ${heading}\n\n| | |\n| --- | --- |\n${table}\n\n`);
  }
}

/** Writes the lock a release reads, `plugins.lock.json`, into `out`. */
export function writeLock(plugins: LockEntry[], out: string): string {
  mkdirSync(out, { recursive: true });
  const path = join(out, "plugins.lock.json");
  writeFileSync(path, `${JSON.stringify({ plugins }, null, 2)}\n`);
  return path;
}

const ROOT = resolve(import.meta.dirname, "../../..");
const LICENSE = join(ROOT, "LICENSE");

async function main(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const [command, ...rest] = args;
  const commit = env.GITHUB_SHA ?? "";
  if (command === "on-main" && rest.length === 0) {
    requireOnMain(commit, ROOT);
  } else if (command === "pack" && rest.length === 2) {
    report(packPlugin(rest[0]!, rest[1]!, LICENSE), commit, "Packed", env);
  } else if (command === "placeholder" && rest.length === 2) {
    report(packPlaceholder(rest[0]!, rest[1]!), commit, "Placeholder, not published", env);
  } else if (command === "publish" && rest.length === 6) {
    const [file, name, version, integrity, pluginId, out] = rest as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    // Made before any registry work, so a publish never ends without its lock.
    mkdirSync(out, { recursive: true });
    const result = await publishTarball(
      { file, name, version, integrity, pluginId },
      { beforePublish: () => requireOnMain(commit, ROOT) },
    );
    writeLock([lockEntry(file, result.integrity, commit)], out);
    report(result, commit, result.published ? "Published" : "Already published", env);
  } else {
    throw new Error(
      "Usage: plugin-npm.ts on-main | pack <plugin folder> <out folder> | placeholder <plugin folder> <out folder> | publish <tarball> <name> <version> <integrity> <plugin id> <out folder>",
    );
  }
}

if (import.meta.main) await main(process.argv.slice(2), process.env);
