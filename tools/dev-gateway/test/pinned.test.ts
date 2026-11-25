// The development gateway runs a pinned OpenClaw, never the one on PATH (#597): which program it
// picks, which Node runs it, and what it refuses.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NODE_VERSION,
  OPENCLAW_VERSION,
  nodeArchive,
  openclawProgram,
  openclawReady,
  programVersion,
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

  it("runs OPENCLAW_BIN only when it is the pinned version, and says why it refuses another", () => {
    const pinned = installed(OPENCLAW_VERSION);
    expect(programVersion(pinned)).toBe(OPENCLAW_VERSION);
    expect(openclawProgram({ OPENCLAW_BIN: pinned }, temp())).toEqual({
      command: pinned,
      args: [],
    });
    expect(() => openclawProgram({ OPENCLAW_BIN: installed("2026.11.10") }, temp())).toThrow(
      `OPENCLAW_BIN is OpenClaw 2026.11.10; the development gateway runs only ${OPENCLAW_VERSION}.`,
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
    });
    // On one it doesn't, the Node the setup installed beside it.
    expect(openclawProgram({}, dir, "26.0.0", process.execPath)).toEqual({
      command: join(dir, `node-${NODE_VERSION}`, "bin/node"),
      args: [entry],
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

  it("downloads Node only for a computer whose archive it knows", () => {
    expect(nodeArchive("darwin", "arm64").name).toBe(`node-v${NODE_VERSION}-darwin-arm64`);
    expect(nodeArchive("linux", "x64").sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => nodeArchive("win32", "x64")).toThrow(/set OPENCLAW_NODE/);
  });
});
