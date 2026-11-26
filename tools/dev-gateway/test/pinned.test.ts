// The development gateway runs a pinned OpenClaw, never the one on PATH (#597): which program it
// picks, which Node runs it, and what it refuses.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NODE_VERSION,
  OPENCLAW_VERSION,
  nodeArchive,
  openclawProgram,
  openclawReady,
  programVersion,
  removeLeftovers,
  setupEnv,
  setupOpenclaw,
  stagingFor,
  supportsNode,
} from "../src/pinned.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-pinned-"));
  dirs.push(dir);
  return dir;
};

/** An installed OpenClaw package of `version`, with its program linked from a bin folder. */
function installed(version: string, name = "openclaw"): string {
  const root = temp();
  const pkg = join(root, "lib/node_modules/openclaw");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(pkg, "openclaw.mjs"), "");
  mkdirSync(join(root, "bin"));
  symlinkSync(join(pkg, "openclaw.mjs"), join(root, "bin/openclaw"));
  return join(root, "bin/openclaw");
}

/** A tool folder set up as `pnpm dev-gateway setup` leaves it. */
function setUp(withNode: boolean): string {
  const dir = temp();
  const pkg = join(dir, `openclaw-${OPENCLAW_VERSION}`, "node_modules/openclaw");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "openclaw.mjs"), "");
  if (withNode) {
    mkdirSync(join(dir, `node-${NODE_VERSION}`, "bin"), { recursive: true });
    writeFileSync(join(dir, `node-${NODE_VERSION}`, "bin/node"), "");
  }
  return dir;
}

describe("the development gateway's OpenClaw (#597)", () => {
  it("knows the Node versions the pinned OpenClaw runs on", () => {
    for (const ok of ["24.22.1", "v24.30.0", "26.12.1", "26.13.0", "27.0.0"])
      expect(supportsNode(ok), ok).toBe(true);
    for (const no of ["24.22.0", "22.20.0", "25.1.0", "26.0.0", "26.12.0"])
      expect(supportsNode(no), no).toBe(false);
  });

  it("runs OPENCLAW_BIN only when it is a listed version, and says why it refuses another", () => {
    const pinned = installed(OPENCLAW_VERSION);
    expect(programVersion(pinned)).toBe(OPENCLAW_VERSION);
    expect(openclawProgram({ OPENCLAW_BIN: pinned }, temp())).toEqual({
      command: pinned,
      args: [],
      version: OPENCLAW_VERSION,
    });
    // npm's newest, which the OpenClaw latest workflow runs (#609).
    const latest = installed("2026.11.10");
    expect(openclawProgram({ OPENCLAW_BIN: latest }, temp())).toEqual({
      command: latest,
      args: [],
      version: "2026.11.10",
    });
    expect(() => openclawProgram({ OPENCLAW_BIN: installed("2026.10.33") }, temp())).toThrow(
      "OPENCLAW_BIN is OpenClaw 2026.10.33; the development gateway runs only 2026.10.6 or 2026.11.10.",
    );
    expect(() => openclawProgram({ OPENCLAW_BIN: installed("1.0.0", "other") }, temp())).toThrow(
      /OPENCLAW_BIN is OpenClaw of a version this tool cannot read/,
    );
    expect(() => openclawProgram({ OPENCLAW_BIN: join(temp(), "missing") }, temp())).toThrow(
      /cannot read/,
    );
  });

  it("without OPENCLAW_BIN, runs its own copy and never another, and asks for setup when it has none", () => {
    const empty = temp();
    expect(() => openclawProgram({}, empty, "26.12.1", "/node")).toThrow(
      `OpenClaw ${OPENCLAW_VERSION} is not set up for the development gateway. Run \`pnpm dev-gateway setup\`.`,
    );
    expect(openclawReady({}, empty)).toBe(false);
    const dir = setUp(true);
    const entry = join(dir, `openclaw-${OPENCLAW_VERSION}`, "node_modules/openclaw/openclaw.mjs");
    // On a Node it supports, that Node runs it.
    expect(openclawProgram({}, dir, "26.12.1", process.execPath)).toEqual({
      command: process.execPath,
      args: [entry],
      version: OPENCLAW_VERSION,
    });
    // On one it doesn't, the Node the setup installed beside it.
    expect(openclawProgram({}, dir, "26.0.0", process.execPath)).toEqual({
      command: join(dir, `node-${NODE_VERSION}`, "bin/node"),
      args: [entry],
      version: OPENCLAW_VERSION,
    });
    // OPENCLAW_NODE names another, which must exist.
    expect(
      openclawProgram({ OPENCLAW_NODE: process.execPath }, setUp(false), "26.0.0", "/x").command,
    ).toBe(process.execPath);
    expect(() =>
      openclawProgram({ OPENCLAW_NODE: "/no/node" }, setUp(false), "26.0.0", "/x"),
    ).toThrow(/not set up/);
    expect(() => openclawProgram({}, setUp(false), "26.0.0", process.execPath)).toThrow(
      /not set up/,
    );
  });

  it("runs a relative OPENCLAW_BIN or OPENCLAW_NODE as the absolute path it was checked as", () => {
    // OpenClaw runs from the instance's state folder, so a relative path is resolved first.
    const pinned = installed(OPENCLAW_VERSION);
    const bin = relative(process.cwd(), pinned);
    expect(bin.startsWith("/")).toBe(false);
    expect(openclawProgram({ OPENCLAW_BIN: bin }, temp())).toEqual({
      command: pinned,
      args: [],
      version: OPENCLAW_VERSION,
    });
    const node = relative(process.cwd(), process.execPath);
    const dir = setUp(false);
    expect(openclawProgram({ OPENCLAW_NODE: node }, dir, "26.0.0", "/x")).toEqual({
      command: process.execPath,
      args: [join(dir, `openclaw-${OPENCLAW_VERSION}`, "node_modules/openclaw/openclaw.mjs")],
      version: OPENCLAW_VERSION,
    });
  });

  it("does not set up a Node of its own when OPENCLAW_NODE names one that is missing", async () => {
    await expect(
      setupOpenclaw(
        join(realpathSync(temp()), "tool"),
        { OPENCLAW_NODE: "/no/such/node" },
        () => {},
      ),
    ).rejects.toThrow("OPENCLAW_NODE names /no/such/node, which does not exist.");
  });

  it("gives npm and the install scripts no token or key from the caller's shell", () => {
    // A home folder of the test's own; the repository names no real one.
    const home = temp();
    const env = setupEnv(
      {
        PATH: "/usr/bin:/bin",
        HOME: home,
        LANG: "en_US.UTF-8",
        HTTPS_PROXY: "http://proxy.test:3128",
        npm_config_registry: "https://registry.test/",
        npm_config_cache: join(home, ".npm"),
        GH_TOKEN: "ghp_secret",
        GITHUB_TOKEN: "ghs_secret",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        OPENAI_API_KEY: "sk-secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        NPM_TOKEN: "npm_secret",
        npm_config__authToken: "npm_secret",
        OPENCLAW_GATEWAY_TOKEN: "secret",
      },
      "/tool/node/bin",
    );
    expect(env).toEqual({
      PATH: "/tool/node/bin:/usr/bin:/bin",
      HOME: home,
      LANG: "en_US.UTF-8",
      HTTPS_PROXY: "http://proxy.test:3128",
      npm_config_registry: "https://registry.test/",
      npm_config_cache: join(home, ".npm"),
    });
    expect(JSON.stringify(env)).not.toMatch(/secret/);
  });

  it("stages each run in a folder of its own, and the next setup removes what a killed one left", async () => {
    const dir = join(realpathSync(temp()), "tool");
    mkdirSync(dir);
    const first = stagingFor(dir, `openclaw-${OPENCLAW_VERSION}`);
    const second = stagingFor(dir, `openclaw-${OPENCLAW_VERSION}`);
    expect(first).not.toBe(second);
    // What killed runs left: a staging folder of today's form and one of the old, fixed form.
    mkdirSync(first);
    writeFileSync(join(first, "half-written"), "");
    mkdirSync(join(dir, `node-${NODE_VERSION}.partial`));
    removeLeftovers(dir);
    expect(readdirSync(dir)).toEqual([]);
    // A setup with both already in place installs nothing, and clears the leftovers first.
    const ready = realpathSync(setUp(true));
    mkdirSync(stagingFor(ready, `openclaw-${OPENCLAW_VERSION}`));
    await setupOpenclaw(ready, { OPENCLAW_NODE: process.execPath }, () => {});
    expect(readdirSync(ready).filter((name) => name.includes(".partial"))).toEqual([]);
    expect(existsSync(join(ready, `openclaw-${OPENCLAW_VERSION}`))).toBe(true);
  });

  it("downloads Node only for a computer whose archive it knows", () => {
    expect(nodeArchive("darwin", "arm64").name).toBe(`node-v${NODE_VERSION}-darwin-arm64`);
    expect(nodeArchive("linux", "x64").sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => nodeArchive("win32", "x64")).toThrow(/set OPENCLAW_NODE/);
  });
});
