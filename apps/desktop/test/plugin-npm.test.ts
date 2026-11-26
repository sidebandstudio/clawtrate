// The packing and publishing script behind .github/workflows/plugins-publish.yml.
// Packing runs the real npm, offline; the registry is a stand-in.

import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  integrityOf,
  needsPublish,
  packPlaceholder,
  packPlugin,
  publishedManifest,
  publishTarball,
  registryIntegrity,
  report,
  writeLock,
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

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-npm-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The files in a .tgz, by path, with their contents. */
function untar(file: string): Map<string, Buffer> {
  const tar = gunzipSync(readFileSync(file));
  const files = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (name === "") break;
    const size = Number.parseInt(
      header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim(),
      8,
    );
    files.set(name, tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

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
    ["a dependency", { dependencies: { leftpad: "1.0.0" } }, "no dependencies"],
    ["a peer dependency", { peerDependencies: { openclaw: "*" } }, "no peerDependencies"],
    ["a dev dependency", { devDependencies: { vitest: "5.1.0" } }, "no devDependencies"],
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
    const files = untar(packed.file);
    expect([...files.keys()].sort()).toEqual(
      [
        "LICENSE",
        "README.md",
        "index.js",
        "lib/apply.js",
        "lib/bots.js",
        "lib/canonical.js",
        "lib/ledger.js",
        "lib/records.js",
        "openclaw.plugin.json",
        "package.json",
      ].map((path) => `package/${path}`),
    );
    const manifest = JSON.parse(files.get("package/package.json")!.toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest).not.toHaveProperty("private");
    expect(files.get("package/index.js")).toEqual(readFileSync(join(PLUGIN, "index.js")));
  });

  it("gives the same tarball for the same files, whatever their times", () => {
    const copy = join(temp(), "clawtrate-bots");
    cpSync(PLUGIN, copy, { recursive: true });
    const first = packPlugin(copy, temp(), LICENSE);
    utimesSync(join(copy, "index.js"), new Date(2001, 0, 1), new Date(2001, 0, 1));
    const second = packPlugin(copy, temp(), LICENSE);
    expect(second.integrity).toBe(first.integrity);
    writeFileSync(join(copy, "index.js"), `${readFileSync(join(copy, "index.js"), "utf8")}\n`);
    expect(packPlugin(copy, temp(), LICENSE).integrity).not.toBe(first.integrity);
  });

  it("fails when the files list leaves out the code the package runs", () => {
    const copy = join(temp(), "clawtrate-bots");
    cpSync(PLUGIN, copy, { recursive: true });
    writeFileSync(
      join(copy, "package.json"),
      JSON.stringify({ ...IN_REPO, files: ["lib/", "openclaw.plugin.json"] }),
    );
    expect(() => packPlugin(copy, temp(), LICENSE)).toThrow("The tarball lacks index.js");
  });
});

describe("packing the placeholder", { timeout: 60_000 }, () => {
  it("holds a package.json at 0.0.0 with no openclaw entry, and a README, the same each time", () => {
    const first = packPlaceholder(PLUGIN, temp());
    const second = packPlaceholder(PLUGIN, temp());
    expect(first).toMatchObject({ name: "@clawtrate/clawtrate-bots", version: "0.0.0" });
    expect(second.integrity).toBe(first.integrity);
    const files = untar(first.file);
    expect([...files.keys()].sort()).toEqual(["package/README.md", "package/package.json"]);
    const manifest = JSON.parse(files.get("package/package.json")!.toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest).toEqual({
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

describe("publishing", () => {
  const tarball = () => {
    const file = join(temp(), "clawtrate-clawtrate-bots-0.1.0.tgz");
    writeFileSync(file, "tarball bytes");
    const packed: Packed = {
      name: "@clawtrate/clawtrate-bots",
      version: "0.1.0",
      integrity: integrityOf(Buffer.from("tarball bytes")),
      file,
      pluginId: "clawtrate-bots",
    };
    return packed;
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
  const noWait = async () => {};

  it("publishes a new version with provenance and reads it back", async () => {
    const packed = tarball();
    const { npm, calls } = registry({ on: null, delay: 2, listed: packed.integrity });
    await expect(publishTarball(packed, npm, noWait)).resolves.toEqual({
      ...packed,
      published: true,
    });
    expect(calls.filter((args) => args[0] === "publish")).toEqual([
      ["publish", packed.file, "--provenance", "--access", "public"],
    ]);
  });

  it("leaves a version already published with the same integrity", async () => {
    const packed = tarball();
    const { npm, calls } = registry({ on: packed.integrity, delay: 0 });
    await expect(publishTarball(packed, npm, noWait)).resolves.toEqual({
      ...packed,
      published: false,
    });
    expect(calls.map((args) => args[0])).toEqual(["view"]);
  });

  it("never republishes a version the registry has with another integrity", async () => {
    const packed = tarball();
    const { npm, calls } = registry({ on: integrityOf(Buffer.from("other")), delay: 0 });
    await expect(publishTarball(packed, npm, noWait)).rejects.toThrow("never replaced");
    expect(calls.map((args) => args[0])).toEqual(["view"]);
  });

  it("fails when the registry lists other bytes after publishing", async () => {
    const packed = tarball();
    const { npm } = registry({ on: null, delay: 0, listed: integrityOf(Buffer.from("other")) });
    await expect(publishTarball(packed, npm, noWait)).rejects.toThrow("not the published");
  });

  it("fails when the registry never lists the version", async () => {
    const packed = tarball();
    const { npm } = registry({ on: null, delay: 100, listed: packed.integrity });
    await expect(publishTarball(packed, npm, noWait)).rejects.toThrow("still doesn't list");
  });

  it("publishes nothing when the tarball isn't the one packed", async () => {
    const packed = tarball();
    writeFileSync(packed.file, "changed bytes");
    const { npm, calls } = registry({ on: null, delay: 0 });
    await expect(publishTarball(packed, npm, noWait)).rejects.toThrow("not the packed");
    expect(calls).toEqual([]);
  });

  it("fails when npm publish fails", async () => {
    const packed = tarball();
    const npm: Npm = (args) =>
      args[0] === "publish" ? { status: 1, stdout: "", stderr: "E403" } : notFound;
    await expect(publishTarball(packed, npm, noWait)).rejects.toThrow("npm publish failed");
  });
});

describe("what a caller reads", () => {
  const result = {
    name: "@clawtrate/clawtrate-bots",
    version: "0.1.0",
    integrity: "sha512-abc==",
    file: "/out/clawtrate-clawtrate-bots-0.1.0.tgz",
    pluginId: "clawtrate-bots",
    published: true,
  };

  it("writes the job's outputs and summary", () => {
    const dir = temp();
    const env = { GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary") };
    report(result, "Published", env);
    expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toBe(
      [
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
    expect(summary).toContain("| Integrity | `sha512-abc==` |");
    expect(summary).toContain("| File | `clawtrate-clawtrate-bots-0.1.0.tgz` |");
  });

  it("writes nothing outside GitHub Actions", () => {
    expect(() => report(result, "Published", {})).not.toThrow();
  });

  it("writes the lock a release reads", () => {
    const path = writeLock([result], temp());
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      plugins: [
        {
          package: "@clawtrate/clawtrate-bots",
          version: "0.1.0",
          integrity: "sha512-abc==",
          pluginId: "clawtrate-bots",
        },
      ],
    });
  });
});
