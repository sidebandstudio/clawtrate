// The packing and publishing script behind .github/workflows/plugins-publish.yml.
// Packing runs the real npm, offline; the registry and git are stand-ins.

import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  integrityOf,
  lockEntry,
  needsPublish,
  packPlaceholder,
  packPlugin,
  publishedManifest,
  publishTarball,
  readTarball,
  registryIntegrity,
  report,
  requireOnMain,
  runNpm,
  writeLock,
  type Git,
  type Npm,
  type Packed,
} from "../packaging/plugin-npm.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const PLUGIN = join(ROOT, "plugins/clawtrate-bots");
const LICENSE = join(ROOT, "LICENSE");
const IN_REPO = JSON.parse(readFileSync(join(PLUGIN, "package.json"), "utf8")) as Record<
  string,
  unknown
>;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PACKED_FILES = [
  "LICENSE",
  "README.md",
  "index.js",
  "lib/apply.js",
  "lib/bots.js",
  "lib/canonical.js",
  "lib/here.js",
  "lib/hooks.js",
  "lib/ledger.js",
  "lib/origins.js",
  "lib/records.js",
  "lib/runs.js",
  "openclaw.plugin.json",
  "package.json",
].map((path) => `package/${path}`);

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-npm-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the plugin's folder, under its own name, to change. */
const pluginCopy = () => {
  const copy = join(temp(), "clawtrate-bots");
  cpSync(PLUGIN, copy, { recursive: true });
  return copy;
};
const json = (bytes: Buffer | undefined) =>
  JSON.parse(bytes!.toString("utf8")) as Record<string, unknown>;

describe("the published package.json", () => {
  it("is the in-repo one without private", () => {
    const published = publishedManifest(IN_REPO, "clawtrate-bots");
    expect(published).not.toHaveProperty("private");
    expect(published).toEqual(
      Object.fromEntries(Object.entries(IN_REPO).filter(([key]) => key !== "private")),
    );
    expect(published.name).toBe("@clawtrate/clawtrate-bots");
  });

  it.each([
    ["another name", { name: "clawtrate-bots" }, "its name must be @clawtrate/clawtrate-bots"],
    ["a range", { version: "^0.1.0" }, "exact x.y.z"],
    ["the placeholder's version", { version: "0.0.0" }, "the placeholder's version"],
    ["no files list", { files: undefined }, "files list"],
    ["a dotfile in the files list", { files: ["index.js", ".npmrc"] }, "plain relative paths"],
    ["a path out of the folder", { files: ["../index.js"] }, "plain relative paths"],
    ["a pattern", { files: ["lib/*.js"] }, "plain relative paths"],
    ["no openclaw entry", { openclaw: undefined }, "openclaw.extensions"],
    ["no extensions", { openclaw: { extensions: [] } }, "openclaw.extensions"],
    ["a dependency", { dependencies: { leftpad: "1.0.0" } }, "no dependencies"],
    ["a peer dependency", { peerDependencies: { openclaw: "*" } }, "no peerDependencies"],
    ["a dev dependency", { devDependencies: { vitest: "5.1.0" } }, "no devDependencies"],
    ["a main file", { main: "other.js" }, "no main"],
    ["a bin", { bin: { tool: "tool.js" } }, "no bin"],
    ["a browser file", { browser: "browser.js" }, "no browser"],
  ])("refuses %s", (_, change, why) => {
    expect(() => publishedManifest({ ...IN_REPO, ...change }, "clawtrate-bots")).toThrow(why);
  });
});

// npm pack takes a second or more on a busy machine.
describe("packing the plugin", { timeout: 60_000 }, () => {
  it("packs the plugin's code, manifest, README and LICENSE, and not its tests", () => {
    const packed = packPlugin(PLUGIN, temp(), LICENSE);
    expect(packed).toMatchObject({
      name: "@clawtrate/clawtrate-bots",
      version: IN_REPO.version,
      pluginId: "clawtrate-bots",
    });
    expect(packed.integrity).toBe(integrityOf(readFileSync(packed.file)));
    const files = readTarball(packed.file);
    expect([...files.keys()].sort()).toEqual(PACKED_FILES);
    expect(json(files.get("package/package.json"))).not.toHaveProperty("private");
    expect(files.get("package/index.js")).toEqual(readFileSync(join(PLUGIN, "index.js")));
  });

  it("gives the same tarball for the same files, whatever their times", () => {
    const copy = pluginCopy();
    const first = packPlugin(copy, temp(), LICENSE);
    utimesSync(join(copy, "index.js"), new Date(2001, 0, 1), new Date(2001, 0, 1));
    expect(packPlugin(copy, temp(), LICENSE).integrity).toBe(first.integrity);
    writeFileSync(join(copy, "index.js"), `${readFileSync(join(copy, "index.js"), "utf8")}\n`);
    expect(packPlugin(copy, temp(), LICENSE).integrity).not.toBe(first.integrity);
  });

  it("packs nothing the files list doesn't name, such as a plugin's own .npmrc", () => {
    const copy = pluginCopy();
    const clean = packPlugin(copy, temp(), LICENSE);
    writeFileSync(join(copy, ".npmrc"), "registry=https://registry.example/\n");
    writeFileSync(join(copy, "stray.js"), "export {};\n");
    const packed = packPlugin(copy, temp(), LICENSE);
    expect([...readTarball(packed.file).keys()].sort()).toEqual(PACKED_FILES);
    expect(packed.integrity).toBe(clean.integrity);
  });

  it("fails unless the manifest's id is the plugin's own", () => {
    const copy = pluginCopy();
    const manifest = json(readFileSync(join(copy, "openclaw.plugin.json")));
    writeFileSync(
      join(copy, "openclaw.plugin.json"),
      JSON.stringify({ ...manifest, id: "clawtrate-other" }),
    );
    expect(() => packPlugin(copy, temp(), LICENSE)).toThrow("must have the id clawtrate-bots");
  });

  it("fails when the files list leaves out the code OpenClaw runs", () => {
    const copy = pluginCopy();
    writeFileSync(
      join(copy, "package.json"),
      JSON.stringify({ ...IN_REPO, files: ["lib/", "openclaw.plugin.json"] }),
    );
    expect(() => packPlugin(copy, temp(), LICENSE)).toThrow("leaves out index.js");
  });

  it("fails on a dotfile or a link inside a listed folder", () => {
    const dotted = pluginCopy();
    writeFileSync(join(dotted, "lib/.hidden"), "");
    expect(() => packPlugin(dotted, temp(), LICENSE)).toThrow("lib/.hidden starts with a dot");
    const linked = pluginCopy();
    symlinkSync(join(linked, "index.js"), join(linked, "lib/link.js"));
    expect(() => packPlugin(linked, temp(), LICENSE)).toThrow("lib/link.js is a link");
  });

  it("fails on a link in a folder above a listed file", () => {
    const copy = pluginCopy();
    renameSync(join(copy, "lib"), join(copy, "real-lib"));
    symlinkSync(join(copy, "real-lib"), join(copy, "lib"));
    writeFileSync(
      join(copy, "package.json"),
      JSON.stringify({
        ...IN_REPO,
        files: ["index.js", "lib/bots.js", "openclaw.plugin.json"],
      }),
    );
    expect(() => packPlugin(copy, temp(), LICENSE)).toThrow("lib is a link");
  });

  it("fails when npm packs a file that isn't expected", () => {
    const npm: Npm = (args, cwd) => {
      const result = runNpm(args, cwd);
      const [report] = JSON.parse(result.stdout) as { files: { path: string }[] }[];
      report!.files.push({ path: "extra.js" });
      return { ...result, stdout: JSON.stringify([report]) };
    };
    expect(() => packPlugin(PLUGIN, temp(), LICENSE, npm)).toThrow("extra.js is extra");
  });
});

describe("packing the placeholder", { timeout: 60_000 }, () => {
  it("holds a package.json at 0.0.0 with no openclaw entry, and a README, the same each time", () => {
    const first = packPlaceholder(PLUGIN, temp());
    const second = packPlaceholder(PLUGIN, temp());
    expect(first).toMatchObject({ name: "@clawtrate/clawtrate-bots", version: "0.0.0" });
    expect(second.integrity).toBe(first.integrity);
    const files = readTarball(first.file);
    expect([...files.keys()].sort()).toEqual(["package/README.md", "package/package.json"]);
    expect(json(files.get("package/package.json"))).toEqual({
      name: "@clawtrate/clawtrate-bots",
      version: "0.0.0",
      description: "A placeholder with no code. Install a released version.",
      license: "MIT",
      repository: IN_REPO.repository,
    });
    expect(files.get("package/README.md")!.toString("utf8")).toContain(
      "placeholder and holds no code",
    );
  });
});

describe("checking the commit is on main", () => {
  const git = (statuses: { fetch?: number; ancestor?: number }) => {
    const calls: string[][] = [];
    const run: Git = (args) => {
      calls.push(args);
      const status = args[0] === "fetch" ? (statuses.fetch ?? 0) : (statuses.ancestor ?? 0);
      return { status, stdout: "", stderr: "git said no" };
    };
    return { run, calls };
  };

  it("reads main fresh from origin and asks git whether the commit is on it", () => {
    const { run, calls } = git({});
    requireOnMain(COMMIT, ".", run);
    expect(calls).toEqual([
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--filter=blob:none",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ],
      ["merge-base", "--is-ancestor", COMMIT, "refs/remotes/origin/main"],
    ]);
  });

  it.each([
    ["a commit not on main", { ancestor: 1 }, "is not on main"],
    ["a failed fetch", { fetch: 128 }, "couldn't read origin's main"],
    ["a commit git can't find", { ancestor: 128 }, "couldn't tell"],
  ])("fails on %s", (_, statuses, why) => {
    expect(() => requireOnMain(COMMIT, ".", git(statuses).run)).toThrow(why);
  });

  it("fails on anything but a full commit", () => {
    const { run, calls } = git({});
    expect(() => requireOnMain("main", ".", run)).toThrow("not a full commit");
    expect(() => requireOnMain("", ".", run)).toThrow("not a full commit");
    expect(calls).toEqual([]);
  });
});

const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
const notFound = { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }), stderr: "404" };

describe("reading the registry", () => {
  it.each([
    ["a version's integrity", ok('"sha512-abc=="'), "sha512-abc=="],
    ["no such version or package", notFound, null],
  ])("reads %s", (_, answer, expected) => {
    expect(registryIntegrity("@clawtrate/clawtrate-bots", "0.1.0", ".", () => answer)).toBe(
      expected,
    );
  });

  it.each([
    [
      "another error",
      { status: 1, stdout: JSON.stringify({ error: { code: "E500" } }), stderr: "500" },
    ],
    ["no answer", ok("")],
    ["an answer that isn't text", ok("{}")],
  ])("fails on %s", (_, answer) => {
    expect(() =>
      registryIntegrity("@clawtrate/clawtrate-bots", "0.1.0", ".", () => answer),
    ).toThrow("gave no integrity");
  });

  it("asks the registry, not npm's cache", () => {
    const calls: string[][] = [];
    registryIntegrity("@clawtrate/clawtrate-bots", "0.1.0", ".", (args) => {
      calls.push(args);
      return ok('"sha512-abc=="');
    });
    expect(calls).toEqual([
      ["view", "@clawtrate/clawtrate-bots@0.1.0", "dist.integrity", "--json", "--prefer-online"],
    ]);
  });

  it("publishes a missing version, skips one with the same integrity and fails on another", () => {
    expect(needsPublish("p", "1.0.0", "sha512-a", null)).toBe(true);
    expect(needsPublish("p", "1.0.0", "sha512-a", "sha512-a")).toBe(false);
    expect(() => needsPublish("p", "1.0.0", "sha512-a", "sha512-b")).toThrow("never replaced");
  });
});

describe("publishing", { timeout: 60_000 }, () => {
  // Packed once, in a folder of its own that outlives each test's.
  let fixture: Packed;
  let fixtureDir: string;
  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "plugin-npm-fixture-"));
    fixture = packPlugin(PLUGIN, fixtureDir, LICENSE);
  });
  afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));
  /** A copy of the packed plugin in a folder of its own. */
  const tarball = (): Packed => {
    const file = join(temp(), "clawtrate-clawtrate-bots.tgz");
    copyFileSync(fixture.file, file);
    return { ...fixture, file };
  };
  /** A registry that lists the version after `delay` views once published, as `listed`. */
  const registry = (state: { on: string | null; delay: number; listed?: string }) => {
    const calls: string[][] = [];
    const npm: Npm = (args) => {
      calls.push(args);
      if (args[0] === "publish") {
        state.on = "pending";
        return ok("");
      }
      if (state.on === "pending") {
        if (state.delay-- > 0) return notFound;
        state.on = state.listed ?? null;
      }
      return state.on === null ? notFound : ok(JSON.stringify(state.on));
    };
    return { npm, calls };
  };
  const wait = async () => {};
  const other = integrityOf(Buffer.from("other"));

  it("publishes a new version with provenance, after checking main, and reads it back", async () => {
    const packed = tarball();
    const { npm, calls } = registry({ on: null, delay: 2, listed: packed.integrity });
    const beforePublish = () => calls.push(["checked main"]);
    await expect(publishTarball(packed, { beforePublish, npm, wait })).resolves.toEqual({
      ...packed,
      published: true,
    });
    expect(calls.map((args) => args[0])).toEqual([
      "view",
      "checked main",
      "publish",
      "view",
      "view",
      "view",
    ]);
    expect(calls[2]).toEqual(["publish", packed.file, "--provenance", "--access", "public"]);
  });

  it("publishes nothing when the commit is no longer on main", async () => {
    const packed = tarball();
    const { npm, calls } = registry({ on: null, delay: 0, listed: packed.integrity });
    const beforePublish = () => {
      throw new Error("not on main");
    };
    await expect(publishTarball(packed, { beforePublish, npm, wait })).rejects.toThrow(
      "not on main",
    );
    expect(calls.map((args) => args[0])).toEqual(["view"]);
  });

  it("leaves a version already published with the same integrity", async () => {
    const packed = tarball();
    const { npm, calls } = registry({ on: packed.integrity, delay: 0 });
    let checked = false;
    const beforePublish = () => (checked = true);
    await expect(publishTarball(packed, { beforePublish, npm, wait })).resolves.toEqual({
      ...packed,
      published: false,
    });
    expect(calls.map((args) => args[0])).toEqual(["view"]);
    expect(checked).toBe(false);
  });

  it("never republishes a version the registry has with another integrity", async () => {
    const packed = tarball();
    const { npm, calls } = registry({ on: other, delay: 0 });
    await expect(publishTarball(packed, { beforePublish() {}, npm, wait })).rejects.toThrow(
      "never replaced",
    );
    expect(calls.map((args) => args[0])).toEqual(["view"]);
  });

  it("fails when the registry lists other bytes after publishing", async () => {
    const { npm } = registry({ on: null, delay: 0, listed: other });
    await expect(publishTarball(tarball(), { beforePublish() {}, npm, wait })).rejects.toThrow(
      "not the published",
    );
  });

  it("fails when the registry never lists the version", async () => {
    const packed = tarball();
    const { npm } = registry({ on: null, delay: 100, listed: packed.integrity });
    await expect(publishTarball(packed, { beforePublish() {}, npm, wait })).rejects.toThrow(
      "still doesn't list",
    );
  });

  it("publishes nothing when the tarball isn't the one packed", async () => {
    const packed = tarball();
    writeFileSync(packed.file, "changed bytes");
    const { npm, calls } = registry({ on: null, delay: 0 });
    await expect(publishTarball(packed, { beforePublish() {}, npm, wait })).rejects.toThrow(
      "not the packed",
    );
    expect(calls).toEqual([]);
  });

  it("publishes nothing when the tarball holds another package or version", async () => {
    const { npm, calls } = registry({ on: null, delay: 0 });
    for (const change of [{ version: "0.2.0" }, { name: "@clawtrate/other" }, { pluginId: "x" }]) {
      await expect(
        publishTarball({ ...tarball(), ...change }, { beforePublish() {}, npm, wait }),
      ).rejects.toThrow("holds @clawtrate/clawtrate-bots@");
    }
    expect(calls).toEqual([]);
  });

  it("fails when npm publish fails", async () => {
    const npm: Npm = (args) =>
      args[0] === "publish" ? { status: 1, stdout: "", stderr: "E403" } : notFound;
    await expect(publishTarball(tarball(), { beforePublish() {}, npm, wait })).rejects.toThrow(
      "npm publish failed",
    );
  });
});

describe("the lock a release reads", { timeout: 60_000 }, () => {
  it("describes the packed bytes from the tarball's own manifests, into a folder not yet made", () => {
    const copy = pluginCopy();
    const manifest = json(readFileSync(join(copy, "openclaw.plugin.json")));
    writeFileSync(
      join(copy, "openclaw.plugin.json"),
      JSON.stringify({
        ...manifest,
        contracts: {
          ...(manifest.contracts as object),
          tools: ["clawtrate_here", "clawtrate_bots"],
        },
        toolMetadata: { clawtrate_tasks: {}, clawtrate_here: {} },
        hooks: ["before_tool_call", "agent_end"],
      }),
    );
    const packed = packPlugin(copy, temp(), LICENSE);
    // The checkout changes after packing; the lock follows the tarball.
    writeFileSync(join(copy, "openclaw.plugin.json"), JSON.stringify({ ...manifest, id: "other" }));
    writeFileSync(join(copy, "package.json"), JSON.stringify({ ...IN_REPO, version: "9.9.9" }));
    const out = join(temp(), "not", "yet");
    const path = writeLock([lockEntry(packed.file, packed.integrity, COMMIT)], out);
    expect(path).toBe(join(out, "plugins.lock.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      plugins: [
        {
          name: "@clawtrate/clawtrate-bots",
          version: IN_REPO.version,
          integrity: packed.integrity,
          pluginId: "clawtrate-bots",
          tools: ["clawtrate_bots", "clawtrate_here", "clawtrate_tasks"],
          hooks: ["agent_end", "before_tool_call"],
          commit: COMMIT,
        },
      ],
    });
  });

  it("lists the tools the manifest declares, and no hooks when it declares none", () => {
    const packed = packPlugin(PLUGIN, temp(), LICENSE);
    expect(lockEntry(packed.file, packed.integrity, COMMIT)).toMatchObject({
      tools: ["clawtrate_bots", "clawtrate_here", "clawtrate_tasks"],
      hooks: [],
    });
  });
});

describe("the job's outputs and summary", () => {
  const result = {
    name: "@clawtrate/clawtrate-bots",
    version: "0.1.0",
    integrity: "sha512-abc==",
    file: "/out/clawtrate-clawtrate-bots-0.1.0.tgz",
    pluginId: "clawtrate-bots",
    published: true,
  };

  it("names the commit packed", () => {
    const dir = temp();
    const env = { GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary") };
    report(result, COMMIT, "Published", env);
    expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toBe(
      [
        `commit=${COMMIT}`,
        "name=@clawtrate/clawtrate-bots",
        "version=0.1.0",
        "integrity=sha512-abc==",
        "file=clawtrate-clawtrate-bots-0.1.0.tgz",
        "plugin-id=clawtrate-bots",
        "published=true",
        "",
      ].join("\n"),
    );
    const summary = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
    expect(summary).toContain("## Published");
    expect(summary).toContain(`| Commit | \`${COMMIT}\` |`);
    expect(summary).toContain("| Integrity | `sha512-abc==` |");
    expect(summary).toContain("| File | `clawtrate-clawtrate-bots-0.1.0.tgz` |");
  });

  it("writes nothing outside GitHub Actions", () => {
    expect(() => report(result, COMMIT, "Published", {})).not.toThrow();
  });
});
