// Packs Clawtrate's OpenClaw plugins for npm and publishes them, for
// .github/workflows/plugins-publish.yml. docs/development/plugins-publish.md
// says how the workflow uses it.
//
//   node apps/desktop/packaging/plugin-npm.ts pack <plugin folder> <out folder>
//   node apps/desktop/packaging/plugin-npm.ts placeholder <plugin folder> <out folder>
//   node apps/desktop/packaging/plugin-npm.ts publish <tarball> <name> <version> <integrity> <plugin id> <out folder>
//
// `pack` packs the plugin's folder with npm, after a copy of its package.json
// without `private`. `placeholder` packs a package of the plugin's name at
// 0.0.0 with no code in it. `publish` publishes a packed tarball, once: a
// version already on the registry with the same integrity is left as it is,
// and one with any other integrity fails. Each writes what it made to the
// job's outputs and summary when GitHub Actions gives their files.
//
// npm runs in the output folder, so no project .npmrc applies, and with
// --ignore-scripts. npm packs every file with the same fixed time, in a fixed
// order, so the same files and the same npm give the same tarball.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

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

export type Npm = (
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string };

export const runNpm: Npm = (args, cwd) => {
  const result = spawnSync("npm", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
};

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
 * has no exact version or `files` list, or has any dependency.
 */
export function publishedManifest(pkg: Manifest, folder: string): Manifest {
  const problems: string[] = [];
  if (pkg.name !== `${SCOPE}/${folder}`) problems.push(`its name must be ${SCOPE}/${folder}`);
  if (typeof pkg.version !== "string" || !VERSION.test(pkg.version))
    problems.push("its version must be an exact x.y.z");
  if (pkg.version === PLACEHOLDER_VERSION)
    problems.push(`${PLACEHOLDER_VERSION} is the placeholder's version`);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) problems.push("it needs a files list");
  for (const field of DEPENDENCY_FIELDS) {
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

/** Runs `npm pack` in `stage` and checks the tarball it wrote against npm's own report. */
function npmPack(
  stage: string,
  out: string,
  npm: Npm,
): { file: string; integrity: string; files: string[] } {
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
  return { file, integrity, files: report.files.map((entry) => entry.path) };
}

const scratch = () => mkdtempSync(join(tmpdir(), "clawtrate-plugin-npm-"));

/**
 * Packs the plugin in `pluginDir` into `out`, from a copy of its folder with
 * the published package.json and the repository's LICENSE. Fails when the
 * tarball lacks the manifest or a file the package names to run.
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
  if (typeof pluginId !== "string")
    throw new Error(`plugins/${folder}/openclaw.plugin.json has no id.`);
  const stage = scratch();
  try {
    cpSync(pluginDir, stage, { recursive: true });
    cpSync(license, join(stage, "LICENSE"));
    writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(out, { recursive: true });
    const packed = npmPack(stage, resolve(out), npm);
    const openclaw = manifest.openclaw as { extensions?: unknown } | undefined;
    const extensions = Array.isArray(openclaw?.extensions) ? (openclaw.extensions as string[]) : [];
    for (const needed of [
      "openclaw.plugin.json",
      ...extensions.map((path) => path.replace(/^\.\//, "")),
    ]) {
      if (!packed.files.includes(needed))
        throw new Error(`The tarball lacks ${needed}; check the files list.`);
    }
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
    const packed = npmPack(stage, resolve(out), npm);
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

/**
 * Publishes `tarball` as `name@version` unless the registry already has it,
 * then reads the registry's integrity back and fails unless it is `integrity`.
 */
export async function publishTarball(
  packed: Packed,
  npm: Npm = runNpm,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<Published> {
  const { name, version, integrity, file } = packed;
  if (!INTEGRITY.test(integrity)) throw new Error(`${integrity} is not a sha512 integrity.`);
  const actual = integrityOf(readFileSync(file));
  if (actual !== integrity) throw new Error(`${file} is ${actual}, not the packed ${integrity}.`);
  const cwd = resolve(file, "..");
  if (!needsPublish(name, version, integrity, registryIntegrity(name, version, cwd, npm)))
    return { ...packed, published: false };
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

/** Writes what was packed or published to the job's outputs and summary, when GitHub gives their files. */
export function report(result: Packed | Published, heading: string, env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_OUTPUT) {
    const lines = [
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

/** The lock a release reads: each published plugin's package, version, integrity and plugin id. */
export function writeLock(results: Published[], out: string): string {
  const path = join(out, "plugins.lock.json");
  const plugins = results.map(({ name, version, integrity, pluginId }) => ({
    package: name,
    version,
    integrity,
    pluginId,
  }));
  writeFileSync(path, `${JSON.stringify({ plugins }, null, 2)}\n`);
  return path;
}

const LICENSE = resolve(import.meta.dirname, "../../../LICENSE");

async function main(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const [command, ...rest] = args;
  if (command === "pack" && rest.length === 2) {
    report(packPlugin(rest[0]!, rest[1]!, LICENSE), "Packed", env);
  } else if (command === "placeholder" && rest.length === 2) {
    report(packPlaceholder(rest[0]!, rest[1]!), "Placeholder, not published", env);
  } else if (command === "publish" && rest.length === 6) {
    const [file, name, version, integrity, pluginId, out] = rest as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const result = await publishTarball({ file, name, version, integrity, pluginId });
    writeLock([result], out);
    report(result, result.published ? "Published" : "Already published", env);
  } else {
    throw new Error(
      "Usage: plugin-npm.ts pack <plugin folder> <out folder> | placeholder <plugin folder> <out folder> | publish <tarball> <name> <version> <integrity> <plugin id> <out folder>",
    );
  }
}

if (import.meta.main) await main(process.argv.slice(2), process.env);
