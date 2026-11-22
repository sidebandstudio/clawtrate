// The bounded settings reader on real files (docs/design/setup-effortless.md
// §3, "The settings reader"): each opening rejection with its own fixture, the
// native helper's failures, the parse worker's deadline, two profiles, and
// the guard that keeps a test away from the account's real home. Every home
// here is a temporary folder of the test's own; on macOS the helper is built
// with packaging's own flags.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, relative, sep } from "node:path";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_GATEWAY_HELPER, localGatewayBuild } from "../packaging/config.ts";
import { FS_SAFE_NATIVE_SHA256 } from "../src/setup/openclaw-pins.ts";
import {
  HeldToken,
  openSettingsFile,
  parseInWorker,
  readBounded,
  readLocalSettings,
  SETTINGS_LIMIT,
} from "../src/setup/settings-reader.ts";
import { accountHome, SetupRefusedError } from "../src/setup/world.ts";

const ROOT = join(import.meta.dirname, "../../..");
const WORKER = new URL("../src/setup/settings-parse.ts", import.meta.url);
const TOKEN = "dev-token.0123456789abcdef";
const SETTINGS = `{ gateway: { mode: "local", port: 19555, auth: { token: "${TOKEN}" } } }`;
const platform = process.platform;
const posix = platform === "darwin" || platform === "linux";

let scratch: string;
let helper: string | null = null;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-settings-")));
  if (platform === "darwin") {
    helper = join(scratch, LOCAL_GATEWAY_HELPER);
    execFileSync("/usr/bin/xcrun", localGatewayBuild(helper));
  }
}, 60_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let homes = 0;
/** A new home with a profile folder and settings file, both private unless a test says otherwise. */
function home(options: { text?: string; folder?: string } = {}) {
  const path = join(scratch, `home-${++homes}`);
  const folder = join(path, options.folder ?? ".openclaw");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const file = join(folder, "openclaw.json");
  writeFileSync(file, options.text ?? SETTINGS, { mode: 0o600 });
  return { path, folder, file };
}

const openIn = (path: string, folder = ".openclaw", file = "openclaw.json") =>
  openSettingsFile({ home: path, folder, file, platform, helper });
const read = (path: string) => readLocalSettings({ home: path, platform, helper, worker: WORKER });

describe.skipIf(!posix)("opening the settings file", () => {
  it("reads a private file in a private folder, and takes its token and port", async () => {
    const { path } = home();
    const [result, ...rest] = await read(path);
    expect(rest).toEqual([]);
    expect(result!.profile).toBe("default");
    const outcome = result!.outcome;
    if (outcome.kind !== "found") throw new Error(`refused: ${JSON.stringify(outcome)}`);
    expect(outcome.port).toBe(19555);
    expect(outcome.token.reveal()).toBe(TOKEN);
  });

  it("says absent for a missing folder or file", async () => {
    const { path, file } = home();
    expect(await openIn(path, ".openclaw-clawtrate")).toEqual({
      kind: "refused",
      reason: "absent",
    });
    rmSync(file);
    expect(await openIn(path)).toEqual({ kind: "refused", reason: "absent" });
  });

  const unsafe = (why: string) => ({ kind: "refused", reason: "unsafe", why });

  it("refuses a profile folder that is a link, even to a private folder", async () => {
    const { path, folder } = home();
    symlinkSync(folder, join(path, ".openclaw-clawtrate"));
    expect(await openIn(path, ".openclaw-clawtrate")).toEqual(unsafe("link"));
  });

  it("refuses a settings file that is a link, even to a private file", async () => {
    const { path, folder, file } = home();
    const target = join(folder, "real.json");
    writeFileSync(target, SETTINGS, { mode: 0o600 });
    rmSync(file);
    symlinkSync(target, file);
    expect(await openIn(path)).toEqual(unsafe("link"));
  });

  it("refuses a settings file with a second link", async () => {
    const { path, folder, file } = home();
    linkSync(file, join(folder, "copy.json"));
    expect(await openIn(path)).toEqual(unsafe("links"));
  });

  it("refuses a FIFO without blocking", async () => {
    const { path, file } = home();
    rmSync(file);
    execFileSync("mkfifo", ["-m", "600", file]);
    const started = Date.now();
    expect(await openIn(path)).toEqual(unsafe("type"));
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("refuses a folder where the file should be, and a file where the folder should be", async () => {
    const { path, file } = home();
    rmSync(file);
    mkdirSync(file, { mode: 0o700 });
    expect(await openIn(path)).toEqual(unsafe("type"));
    writeFileSync(join(path, ".openclaw-clawtrate"), "", { mode: 0o600 });
    expect(await openIn(path, ".openclaw-clawtrate")).toEqual(unsafe("type"));
  });

  it.each([0o644, 0o640, 0o604, 0o400, 0o700, 0o4600])(
    "refuses a settings file of mode %o",
    async (mode) => {
      const { path, file } = home();
      chmodSync(file, mode);
      expect(await openIn(path)).toEqual(unsafe("mode"));
    },
  );

  it.each([0o750, 0o705, 0o755])("refuses a profile folder of mode %o", async (mode) => {
    const { path, folder } = home();
    chmodSync(folder, mode);
    expect(await openIn(path)).toEqual(unsafe("mode"));
  });

  it("refuses a folder that belongs to another account", async () => {
    // A system folder of root's, which no test can create: the owner is checked before the mode.
    expect(await openIn("/", "usr", "openclaw.json")).toEqual(unsafe("owner"));
  });

  it("refuses an unreadable file as denied", async () => {
    const { path, file } = home();
    chmodSync(file, 0o200);
    expect(await openIn(path)).toEqual(unsafe("denied"));
  });

  it("refuses a file over 1 MiB, and reads one of exactly 1 MiB", async () => {
    const { path, file } = home();
    writeFileSync(file, "x".repeat(SETTINGS_LIMIT + 1));
    expect(await openIn(path)).toEqual({ kind: "refused", reason: "unreadable", why: "large" });
    writeFileSync(file, "x".repeat(SETTINGS_LIMIT));
    expect(await openIn(path)).toMatchObject({ kind: "read" });
  });

  it("refuses a file that grew past 1 MiB after its size was checked", async () => {
    const { file } = home();
    const handle = await open(file, "r");
    try {
      appendFileSync(file, "x".repeat(SETTINGS_LIMIT));
      expect(await readBounded(handle)).toEqual({
        kind: "refused",
        reason: "unreadable",
        why: "large",
      });
    } finally {
      await handle.close();
    }
  });
});

describe.skipIf(platform !== "darwin")("the macOS helper's ACL checks", () => {
  const acl = (path: string, entry: string) => execFileSync("/bin/chmod", ["+a", entry, path]);

  it("refuses a file whose ACL grants another account anything", async () => {
    const { path, file } = home();
    acl(file, "everyone allow read");
    expect(await openIn(path)).toEqual({ kind: "refused", reason: "unsafe", why: "acl" });
  });

  it("refuses a folder whose ACL grants another account anything", async () => {
    const { path, folder } = home();
    acl(folder, "staff allow list");
    expect(await openIn(path)).toEqual({ kind: "refused", reason: "unsafe", why: "acl" });
  });

  it("refuses a file whose ACL grants another user anything", async () => {
    const { path, file } = home();
    acl(file, "root allow read");
    expect(await openIn(path)).toEqual({ kind: "refused", reason: "unsafe", why: "acl" });
  });

  it("allows an ACL that grants only this account, or only denies", async () => {
    const { path, file } = home();
    acl(file, `${userInfo().username} allow read`);
    acl(file, "everyone deny write");
    expect(await openIn(path)).toMatchObject({ kind: "read" });
  });

  it("refuses a file over 1 MiB by its size, and one that grew past it by the bytes read", () => {
    const harness = join(scratch, "grow.c");
    writeFileSync(
      harness,
      `#define main helper_main
#include "local-gateway.c"
#undef main
int main(int argc, char **argv) {
  (void)argc;
  int fd = open(argv[1], O_RDONLY);
  const char *why = checkOpened(fd, 0);
  if (why) { printf("checked: %s\\n", why); return 0; }
  FILE *grow = fopen(argv[1], "a");
  for (int i = 0; i <= SETTINGS_LIMIT; ++i) fputc('x', grow);
  fclose(grow);
  size_t length;
  char *buffer = malloc(SETTINGS_LIMIT + 1);
  why = readBounded(fd, buffer, &length);
  printf("read: %s\\n", why ? why : "ok");
  return 0;
}`,
    );
    const binary = join(scratch, "grow");
    execFileSync("/usr/bin/xcrun", [
      "clang",
      "-Wno-unused-function",
      "-I",
      join(ROOT, "apps/desktop/packaging/mac"),
      harness,
      "-o",
      binary,
    ]);
    const run = (file: string) => execFileSync(binary, [file], { encoding: "utf8" }).trim();
    const large = home().file;
    writeFileSync(large, "x".repeat(SETTINGS_LIMIT + 1));
    expect(run(large)).toBe("checked: large");
    expect(run(home().file)).toBe("read: large");
  });

  // Only on a discarded hosted runner, where sudo needs no password: a file root owns that
  // this account may read through an ACL, so that only the owner check refuses it.
  it.skipIf(process.env.CLAWTRATE_HOSTED_MAC_RUNNER !== "1")(
    "refuses a file that belongs to another account",
    async () => {
      const { path, file } = home();
      execFileSync("/usr/bin/sudo", ["-n", "/usr/sbin/chown", "root", file]);
      execFileSync("/usr/bin/sudo", [
        "-n",
        "/bin/chmod",
        "+a",
        `${userInfo().username} allow read`,
        file,
      ]);
      expect(await openIn(path)).toEqual({ kind: "refused", reason: "unsafe", why: "owner" });
    },
  );
});

describe.skipIf(platform !== "linux")("Linux ACLs", () => {
  const setfacl = ["/usr/bin/setfacl", "/bin/setfacl"].find((path) => existsSync(path));
  it.skipIf(!setfacl)("refuses a file whose ACL names another account, by its mode", async () => {
    const { path, file } = home();
    execFileSync(setfacl!, ["-m", "u:nobody:r", file]);
    expect(await openIn(path)).toEqual({ kind: "refused", reason: "unsafe", why: "mode" });
  });
});

describe.skipIf(!posix)("the helper's failures mean unverified", () => {
  /** A stand-in helper: a shell script of the test's own. */
  const fake = (name: string, body: string) => {
    const path = join(scratch, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return path;
  };
  const viaFake = (path: string | null, deadlineMs?: number) =>
    openSettingsFile({
      home: home().path,
      folder: ".openclaw",
      file: "openclaw.json",
      platform: "darwin",
      helper: path,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
  const unverified = { kind: "refused", reason: "unsafe", why: "helper" };

  it.each([
    ["no helper", () => null],
    ["a missing helper", () => join(scratch, "no-such-helper")],
    ["a helper that fails", () => fake("fails", "exit 3")],
    ["an answer, then a failed exit", () => fake("answer-fails", "printf 'ok\\n{}'; exit 1")],
    ["an answer, then a signal", () => fake("answer-killed", "printf 'ok\\n{}'; kill -9 $$")],
    ["malformed output", () => fake("malformed", "echo surprise")],
    ["an unknown refusal", () => fake("unknown", "echo 'refused maybe'")],
    ["no line end", () => fake("no-newline", "printf ok")],
    ["output over its limit", () => fake("large", `printf 'ok\\n'; head -c 1050000 /dev/zero`)],
  ])("refuses with %s", async (_, path) => {
    expect(await viaFake(path())).toEqual(unverified);
  });

  it("refuses a helper that passes its deadline, and stops it", async () => {
    const started = Date.now();
    expect(await viaFake(fake("slow", "exec sleep 5"), 200)).toEqual(unverified);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("passes no token, file name or environment of the host's to the helper", async () => {
    const out = join(scratch, "seen");
    const seen = fake("seen", `echo "$@" > ${out}; env >> ${out}; echo 'refused absent'`);
    process.env.CLAWTRATE_TEST_SECRET = "must-not-pass";
    try {
      expect(await viaFake(seen)).toEqual({ kind: "refused", reason: "absent" });
    } finally {
      delete process.env.CLAWTRATE_TEST_SECRET;
    }
    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines[0]).toMatch(/^read \S+ \.openclaw openclaw\.json$/);
    expect(lines.slice(1).filter((line) => !/^(PATH|PWD|SHLVL|_)=/.test(line))).toEqual([]);
  });
});

describe("the parse worker", () => {
  it("answers with what the rules found", async () => {
    expect(await parseInWorker(SETTINGS, WORKER)).toEqual({
      kind: "found",
      token: TOKEN,
      port: 19555,
    });
  });

  it("refuses when the worker passes its deadline, and ends it", async () => {
    const spin = join(scratch, "spin.mjs");
    writeFileSync(spin, "for (;;) {}\n");
    const started = Date.now();
    expect(await parseInWorker(SETTINGS, new URL(`file://${spin}`), 300)).toEqual({
      kind: "refused",
      reason: "unreadable",
      why: "worker",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  const write = (name: string, body: string) => {
    const path = join(scratch, name);
    writeFileSync(path, body);
    return new URL(`file://${path}`);
  };

  it("runs with resource limits and an empty environment", async () => {
    const report = `import { parentPort, resourceLimits } from "node:worker_threads";
const token = JSON.stringify({ resourceLimits, env: Object.keys(process.env) });
parentPort.postMessage({ kind: "found", token, port: 1 });\n`;
    const answer = await parseInWorker("", write("report.mjs", report));
    if (answer.kind !== "found") throw new Error("the worker didn't answer");
    expect(JSON.parse(answer.token)).toEqual({
      resourceLimits: expect.objectContaining({
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 4,
      }) as unknown,
      env: [],
    });
  });

  it("refuses a worker that fails, runs out of memory or answers with another shape", async () => {
    const failed = { kind: "refused", reason: "unreadable", why: "worker" };
    expect(await parseInWorker("", write("throws.mjs", "throw new Error('x');\n"))).toEqual(failed);
    const grow = "const a = []; for (;;) a.push(new Array(1e6).fill(1));\n";
    expect(await parseInWorker("", write("grows.mjs", grow), 10_000)).toEqual(failed);
    const odd = `import { parentPort } from "node:worker_threads";
parentPort.postMessage({ kind: "found", token: 1, port: "x" });\n`;
    expect(await parseInWorker("", write("odd.mjs", odd))).toEqual(failed);
  }, 15_000);
});

describe.skipIf(!posix)("two profiles", () => {
  it("shows both by name when both qualify", async () => {
    const { path } = home();
    const other = join(path, ".openclaw-clawtrate");
    mkdirSync(other, { mode: 0o700 });
    writeFileSync(
      join(other, "openclaw.json"),
      `{ gateway: { port: 19556, auth: { token: "other" } } }`,
      {
        mode: 0o600,
      },
    );
    const results = await read(path);
    expect(results.map((result) => result.profile)).toEqual(["default", "clawtrate"]);
    expect(results.map((result) => result.outcome)).toMatchObject([
      { kind: "found", port: 19555 },
      { kind: "found", port: 19556 },
    ]);
  });

  it("keeps the default profile's absence beside a clawtrate profile", async () => {
    const { path, folder } = home({ folder: ".openclaw-clawtrate" });
    expect(folder.endsWith(".openclaw-clawtrate")).toBe(true);
    expect(await read(path)).toMatchObject([
      { profile: "default", outcome: { kind: "refused", reason: "absent" } },
      { profile: "clawtrate", outcome: { kind: "found", port: 19555 } },
    ]);
  });

  it("reports each profile's own refusal", async () => {
    const { path } = home({ text: `{ gateway: { mode: "remote" } }` });
    const other = join(path, ".openclaw-clawtrate");
    mkdirSync(other, { mode: 0o755 });
    writeFileSync(join(other, "openclaw.json"), SETTINGS, { mode: 0o600 });
    expect(await read(path)).toMatchObject([
      { profile: "default", outcome: { reason: "address", why: "remote" } },
      { profile: "clawtrate", outcome: { reason: "unsafe", why: "mode" } },
    ]);
  });
});

describe("the token is held, not shown", () => {
  it("never prints, inspects or serializes its value, and is gone once dropped", () => {
    const token = new HeldToken(TOKEN);
    for (const text of [JSON.stringify({ token }), String(token), `${token}`, inspect({ token })])
      expect(text).not.toContain(TOKEN);
    expect(token.reveal()).toBe(TOKEN);
    token.drop();
    expect(() => token.reveal()).toThrow();
  });
});

describe("the account's real home", () => {
  it("is never read under test: the reader refuses it before any file or helper is touched", async () => {
    const real = accountHome();
    expect(real).not.toBe(null);
    const marker = join(scratch, "helper-ran");
    const spy = join(scratch, "spy");
    writeFileSync(spy, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o700 });
    for (const path of [real!, `${real!}/`, `${real!}/./`]) {
      await expect(
        openSettingsFile({
          home: path,
          folder: ".openclaw",
          file: "openclaw.json",
          platform: "darwin",
          helper: spy,
        }),
      ).rejects.toBeInstanceOf(SetupRefusedError);
      await expect(
        readLocalSettings({ home: path, platform: "darwin", helper: spy, worker: WORKER }),
      ).rejects.toBeInstanceOf(SetupRefusedError);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("is never a default: every reader entry point takes the home from its caller", () => {
    const source = readFileSync(join(ROOT, "apps/desktop/src/setup/settings-reader.ts"), "utf8");
    // `accountHome` is read only to refuse it; nothing resolves a home of its own.
    expect(source.match(/accountHome\(\)/g)).toHaveLength(1);
    expect(source).not.toMatch(/homedir|userInfo|process\.env\.HOME|"~/);
  });
});

it("nothing in a shipped host reaches the reader yet", () => {
  const own = new Set([
    "settings-reader.ts",
    "settings-parse.ts",
    "settings-extract.ts",
    "settings-lexer.ts",
    "openclaw-pins.ts",
  ]);
  const shipped = ["apps/desktop/src", "packages/core/src", "packages/ui/src"].flatMap((dir) =>
    (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
      .filter((path) => /\.tsx?$/.test(path))
      .map((path) => join(ROOT, dir, path)),
  );
  const importers = shipped.filter((file) => {
    const name = relative(join(ROOT, "apps/desktop/src/setup"), file);
    if (own.has(name)) return false;
    return [...own].some((module) =>
      readFileSync(file, "utf8").includes(module.replace(/\.ts$/, "")),
    );
  });
  expect(importers.map((file) => relative(ROOT, file).split(sep).join("/"))).toEqual([]);
});

// CI installs the pinned OpenClaw from npm and names its folder; the module it carries for
// this platform must match the hash taken from the published package.
it.skipIf(!process.env.CLAWTRATE_PINNED_OPENCLAW)(
  "the pinned hashes match the installed OpenClaw's own modules",
  () => {
    const scope = join(process.env.CLAWTRATE_PINNED_OPENCLAW!, "node_modules/@openclaw");
    const found = readdirSync(scope).filter((name) => name.startsWith("fs-safe-"));
    expect(found.length).toBeGreaterThan(0);
    for (const name of found) {
      const file = readFileSync(join(scope, name, "fs-safe-native.node"));
      const hash = createHash("sha256").update(file).digest("hex");
      expect(hash, name).toBe(FS_SAFE_NATIVE_SHA256[name.slice("fs-safe-".length)]);
    }
  },
);
