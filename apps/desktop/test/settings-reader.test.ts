// The bounded settings reader on real files (docs/design/setup-effortless.md
// §3, "The settings reader"): each opening rejection with its own fixture, the
// home folder's checks, the native helper's failures and output, the parse
// worker's bounds, two profiles, and the guard that keeps a test away from the
// account's real home. Every home here is a temporary folder of the test's
// own; on macOS the helper is built with packaging's own flags.

import { execFileSync, spawn, spawnSync } from "node:child_process";
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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_GATEWAY_HELPER, localGatewayBuild } from "../packaging/config.ts";
import { PROVED_FS_SAFE, PROVED_OPENCLAW } from "../src/setup/openclaw-pins.ts";
import {
  checkOpened,
  guardHome,
  HeldToken,
  holdHome,
  openSettingsFile,
  parseInWorker,
  preflight,
  readBounded,
  readLocalSettings,
  sameFolder,
  SETTINGS_LIMIT,
} from "../src/setup/settings-reader.ts";
import { accountHome, packagedApp, SetupRefusedError } from "../src/setup/world.ts";

const ROOT = join(import.meta.dirname, "../../..");
const WORKER = new URL("../src/setup/settings-parse.ts", import.meta.url);
const TOKEN = "dev-token.0123456789abcdef";
const SETTINGS = `{ gateway: { mode: "local", port: 19555, auth: { token: "${TOKEN}" } } }`;
const platform = process.platform;
const posix = platform === "darwin" || platform === "linux";
const unsafe = (why: string) => ({ kind: "refused", reason: "unsafe", why });
const unverified = unsafe("helper");
const workerFailed = { kind: "refused", reason: "unreadable", why: "worker" };

/** Stand-in helpers, written before any test starts one. */
const FAKES: Record<string, string> = {
  fails: "exit 3",
  "answer-fails": "printf 'ok\\n{}'; exit 1",
  "answer-killed": "printf 'ok\\n{}'; kill -9 $$",
  malformed: "echo surprise",
  unknown: "echo 'refused maybe'",
  "no-newline": "printf ok",
  "refusal-no-newline": "printf 'refused absent'",
  "refusal-body": "printf 'refused absent\\nmore'",
  "two-refusals": "printf 'refused absent\\nrefused link\\n'",
  "over-cap": `printf 'ok\\n'; head -c ${SETTINGS_LIMIT + 1} /dev/zero`,
  "at-cap": `printf 'ok\\n'; head -c ${SETTINGS_LIMIT} /dev/zero`,
  slow: "exec sleep 5",
};

let scratch: string;
let helper: string | null = null;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-settings-")));
  for (const [name, body] of Object.entries(FAKES))
    writeFileSync(join(scratch, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  if (platform === "darwin") {
    helper = join(scratch, LOCAL_GATEWAY_HELPER);
    execFileSync("/usr/bin/xcrun", localGatewayBuild(helper));
  }
}, 60_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let homes = 0;
/** A new home with a profile folder and settings file, all private unless a test says otherwise. */
function home(options: { text?: string; folder?: string } = {}) {
  const path = join(scratch, `home-${++homes}`);
  const folder = join(path, options.folder ?? ".openclaw");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  chmodSync(folder, 0o700);
  const file = join(folder, "openclaw.json");
  writeFileSync(file, options.text ?? SETTINGS, { mode: 0o600 });
  return { path, folder, file };
}

const openIn = (path: string, folder = ".openclaw", file = "openclaw.json") =>
  openSettingsFile({ home: path, folder, file, platform, helper, sandboxed: true });
const read = (path: string) =>
  readLocalSettings({ home: path, platform, helper, sandboxed: true, worker: WORKER });

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

  it("refuses a FIFO with a waiting writer, and never opens it", async () => {
    const { path, file } = home();
    rmSync(file);
    execFileSync("mkfifo", ["-m", "600", file]);
    // The writer's open waits for a reader; it touches the marker only once something opened the
    // FIFO to read. Opening without writing means no broken pipe can stop it first.
    const marker = join(scratch, `fifo-opened-${homes}`);
    const writer = spawn("/bin/sh", ["-c", ': > "$0"; touch "$1"', file, marker], {
      stdio: "ignore",
    });
    try {
      const started = Date.now();
      expect(await openIn(path)).toEqual(unsafe("type"));
      expect(Date.now() - started).toBeLessThan(1_500);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(marker)).toBe(false);
    } finally {
      writer.kill();
    }
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

it("reads nothing on Windows, and looks up, resolves and opens no home first", async () => {
  // A home that doesn't exist: the guard would refuse it, and holding it would fail.
  const missing = join(scratch, "no-such-windows-home");
  for (const home of [missing, "relative\\home"])
    await expect(
      openSettingsFile({
        home,
        folder: ".openclaw",
        file: "openclaw.json",
        platform: "win32",
        helper: null,
        sandboxed: true,
      }),
    ).resolves.toEqual(unsafe("helper"));
  expect(
    await readLocalSettings({
      home: missing,
      platform: "win32",
      helper: null,
      sandboxed: false,
      worker: WORKER,
    }),
  ).toEqual([
    { profile: "default", outcome: unsafe("helper") },
    { profile: "clawtrate", outcome: unsafe("helper") },
  ]);
});

describe.skipIf(!posix)("the home folder", () => {
  it("refuses a home or a name that isn't one plain step, before opening anything", async () => {
    const { path } = home();
    for (const [where, folder, file] of [
      [`${path}/../${relative(scratch, path)}`, ".openclaw", "openclaw.json"],
      [`${path}/./`, ".openclaw", "openclaw.json"],
      ["relative/home", ".openclaw", "openclaw.json"],
      [path, "..", "openclaw.json"],
      [path, ".openclaw/../.openclaw", "openclaw.json"],
      [path, "", "openclaw.json"],
      [path, ".openclaw", "../openclaw.json"],
      [path, ".openclaw", "."],
      [path, ".openclaw", "a\0b"],
    ])
      expect(await openIn(where!, folder, file), `${where} ${folder} ${file}`).toEqual(
        unsafe("path"),
      );
  });

  // Every run of this file is sandboxed (VITEST is set): its homes must be the guard's kind.
  it.each([
    ["a missing home", () => join(scratch, "no-such-home")],
    [
      "a linked home",
      () => {
        const link = join(scratch, `link-${++homes}`);
        symlinkSync(home().path, link);
        return link;
      },
    ],
    [
      "a home others may enter",
      () => {
        const { path } = home();
        chmodSync(path, 0o755);
        return path;
      },
    ],
    ["a home outside the temporary roots", () => "/usr"],
    ["a temporary root itself", () => realpathSync("/tmp")],
    [
      "a home below a linked folder",
      () => {
        const real = join(scratch, `real-${++homes}`);
        mkdirSync(join(real, "home", ".openclaw"), { recursive: true, mode: 0o700 });
        const link = join(scratch, `linked-${homes}`);
        symlinkSync(real, link);
        return join(link, "home");
      },
    ],
  ])("refuses %s in a sandboxed run", async (_, path) => {
    await expect(openIn(path())).rejects.toBeInstanceOf(SetupRefusedError);
  });

  it("takes the temporary roots from this machine, whichever platform's reader is asked for", async () => {
    const other = platform === "darwin" ? "linux" : "darwin";
    const answer = openSettingsFile({
      home: home().path,
      folder: ".openclaw",
      file: "openclaw.json",
      platform: other,
      helper: join(scratch, "unknown"),
      sandboxed: true,
    });
    await expect(answer).resolves.toHaveProperty("kind", "refused");
  });

  it("holds the home without following a link, and checks what it opened", async () => {
    const { path } = home();
    const link = join(scratch, `held-link-${++homes}`);
    symlinkSync(path, link);
    expect(await holdHome(link, null)).toEqual(unsafe("link"));
    // A trailing separator would have the open follow a link before it.
    expect(await holdHome(`${link}/`, null)).toEqual(unsafe("path"));
    const shared = join(scratch, `shared-${++homes}`);
    mkdirSync(shared, { mode: 0o700 });
    chmodSync(shared, 0o770);
    expect(await holdHome(shared, null)).toEqual(unsafe("mode"));
    expect(await holdHome(join(path, ".openclaw", "openclaw.json"), null)).toEqual(unsafe("type"));
    // A system folder of root's, which no test can make.
    expect(await holdHome("/usr", null)).toEqual(unsafe("owner"));
    const held = await holdHome(path, null);
    expect(held).toHaveProperty("handle");
    if ("handle" in held) await held.handle.close();
  });

  /** A folder's exact device and inode. */
  const exact = (path: string) => {
    const stat = statSync(path, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  };

  it("hands back the checked folder, exactly, in a sandboxed run, and nothing in a production one", () => {
    const { path } = home();
    // Another temporary home stands in for the account's.
    const account = home().path;
    expect(guardHome(path, true, {}, () => account)).toEqual(exact(path));
    // A marker makes the run sandboxed whatever the caller says; only both together are production.
    expect(guardHome(path, false, { CLAWTRATE_AUTOMATED: "" }, () => account)).toEqual(exact(path));
    expect(
      guardHome(
        path,
        false,
        {},
        () => path,
        () => true,
      ),
    ).toBe(null);
  });

  it("holds a sandboxed home to the folder the guard checked, still private", async () => {
    const { path } = home();
    const checked = guardHome(path, true);
    expect(checked).toEqual(exact(path));
    const held = await holdHome(path, checked);
    expect(held).toHaveProperty("handle");
    if ("handle" in held) await held.handle.close();
    // Another folder in its place since the check, private or not, is refused.
    const other = home().path;
    expect(await holdHome(other, checked)).toEqual(unsafe("changed"));
    // The same folder, opened up to others after the check, is refused too.
    chmodSync(path, 0o755);
    expect(await holdHome(path, checked)).toEqual(unsafe("mode"));
    // A production read keeps the ordinary home rule: no write for group or others.
    const production = await holdHome(path, null);
    expect(production).toHaveProperty("handle");
    if ("handle" in production) await production.handle.close();
  });

  it("checks an opened folder's owner before its mode", async () => {
    const usr = await open("/usr", "r");
    try {
      expect(await checkOpened(usr, true)).toEqual(unsafe("owner"));
    } finally {
      await usr.close();
    }
  });

  it("refuses a device, a FIFO or a link by its no-follow stat, before opening it", async () => {
    const { folder, file } = home();
    expect(await preflight("/dev/null")).toEqual(unsafe("type"));
    const fifo = join(folder, "fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    expect(await preflight(fifo)).toEqual(unsafe("type"));
    const link = join(folder, "link");
    symlinkSync(file, link);
    expect(await preflight(link)).toEqual(unsafe("link"));
    expect(await preflight(join(folder, "missing"))).toEqual({ kind: "refused", reason: "absent" });
    expect(await preflight(file)).toBe(null);
  });
});

describe.skipIf(platform !== "darwin")("the macOS helper", () => {
  const acl = (path: string, entry: string) => execFileSync("/bin/chmod", ["+a", entry, path]);

  it("refuses a file whose ACL grants another account anything", async () => {
    const { path, file } = home();
    acl(file, "everyone allow read");
    expect(await openIn(path)).toEqual(unsafe("acl"));
  });

  it("refuses a folder whose ACL grants another account anything", async () => {
    const { path, folder } = home();
    acl(folder, "staff allow list");
    expect(await openIn(path)).toEqual(unsafe("acl"));
  });

  it("refuses a file whose ACL grants another user anything", async () => {
    const { path, file } = home();
    acl(file, "root allow read");
    expect(await openIn(path)).toEqual(unsafe("acl"));
  });

  /** The helper's answer for a home it is handed, by command: production's or a sandbox's. */
  const handed = (command: "read" | "read-private", home: string) =>
    spawnSync(
      "/bin/sh",
      ["-c", 'exec "$0" "$1" .openclaw openclaw.json 3<"$2"', helper!, command, home],
      { encoding: "utf8" },
    ).stdout;

  it.each(["add_file", "add_subdirectory", "delete_child", "writesecurity", "chown"])(
    "refuses a home whose ACL lets another account %s, in either mode",
    async (perm) => {
      const { path } = home();
      acl(path, `staff allow ${perm}`);
      expect(handed("read", path)).toBe("refused acl\n");
      expect(handed("read-private", path)).toBe("refused acl\n");
      expect(await openIn(path)).toEqual(unsafe("acl"));
    },
  );

  it("keeps a production home's ordinary ACLs, and refuses them in a sandboxed run", async () => {
    const { path } = home();
    try {
      acl(path, "group:everyone deny delete");
      acl(path, "everyone allow list,search,readattr,readextattr,readsecurity");
      acl(path, `${userInfo().username} allow add_file,delete_child`);
      expect(handed("read", path)).toBe(`ok\n${SETTINGS}`);
      expect(handed("read-private", path)).toBe("refused acl\n");
      // This run is sandboxed, so the reader asks for the private rule.
      expect(await openIn(path)).toEqual(unsafe("acl"));
    } finally {
      // The delete denial would otherwise keep the scratch folder from being removed.
      execFileSync("/bin/chmod", ["-N", path]);
    }
  });

  it("keeps a sandboxed home whose ACL only denies, or grants only this account", async () => {
    const { path } = home();
    try {
      acl(path, "group:everyone deny delete");
      acl(path, `${userInfo().username} allow add_file,delete_child`);
      expect(handed("read-private", path)).toBe(`ok\n${SETTINGS}`);
      expect(await openIn(path)).toMatchObject({ kind: "read" });
    } finally {
      execFileSync("/bin/chmod", ["-N", path]);
    }
  });

  it("checks the home it was handed itself, as the host does", () => {
    const shared = join(scratch, `helper-shared-${++homes}`);
    mkdirSync(shared, { mode: 0o700 });
    chmodSync(shared, 0o770);
    expect(handed("read", "/usr")).toBe("refused owner\n");
    expect(handed("read", shared)).toBe("refused mode\n");
    expect(handed("read", home().path)).toBe(`ok\n${SETTINGS}`);
    // A home others may enter but not write to: production's rule takes it, a sandbox's doesn't.
    const open = home().path;
    chmodSync(open, 0o755);
    expect(handed("read", open)).toBe(`ok\n${SETTINGS}`);
    expect(handed("read-private", open)).toBe("refused mode\n");
  });

  it("allows an ACL that grants only this account, or only denies", async () => {
    const { path, file } = home();
    acl(file, `${userInfo().username} allow read`);
    acl(file, "everyone deny write");
    expect(await openIn(path)).toMatchObject({ kind: "read" });
  });

  /** The helper's own functions, driven one at a time. */
  const harness = () => {
    const binary = join(scratch, "harness");
    if (existsSync(binary)) return binary;
    const source = join(scratch, "harness.c");
    writeFileSync(
      source,
      `#define main helper_main
#include "local-gateway.c"
#undef main
int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "folder") == 0) {
    const char *why = checkOpened(open(argv[2], O_RDONLY | O_DIRECTORY), 1, 0);
    puts(why ? why : "ok");
    return 0;
  }
  if (argc == 4 && strcmp(argv[1], "preflight") == 0) {
    const char *why = preflight(open(argv[2], O_RDONLY | O_DIRECTORY), argv[3]);
    puts(why ? why : "ok");
    return 0;
  }
  int fd = open(argv[2], O_RDONLY);
  const char *why = checkOpened(fd, 0, SETTINGS_LIMIT);
  if (why) { printf("checked: %s\\n", why); return 0; }
  FILE *grow = fopen(argv[2], "a");
  for (int i = 0; i <= SETTINGS_LIMIT; ++i) fputc('x', grow);
  fclose(grow);
  size_t length;
  char *buffer = malloc(SETTINGS_LIMIT + 1);
  why = readBounded(fd, buffer, SETTINGS_LIMIT, &length);
  printf("read: %s\\n", why ? why : "ok");
  return 0;
}`,
    );
    execFileSync("/usr/bin/xcrun", [
      "clang",
      "-Wno-unused-function",
      "-I",
      join(ROOT, "apps/desktop/packaging/mac"),
      source,
      "-o",
      binary,
    ]);
    return binary;
  };
  const run = (...args: string[]) => execFileSync(harness(), args, { encoding: "utf8" }).trim();

  it("refuses a file over 1 MiB by its size, and one that grew past it by the bytes read", () => {
    const large = home().file;
    writeFileSync(large, "x".repeat(SETTINGS_LIMIT + 1));
    expect(run("grow", large)).toBe("checked: large");
    expect(run("grow", home().file)).toBe("read: large");
  });

  it("checks an opened folder's owner before its mode, and refuses a device before opening it", () => {
    expect(run("folder", "/usr")).toBe("owner");
    expect(run("preflight", "/dev", "null")).toBe("type");
    expect(run("preflight", home().folder, "openclaw.json")).toBe("ok");
  });

  it("fails when it can't write its answer", () => {
    const { path } = home();
    // stdout closed: the answer can't be written, so the exit isn't a success.
    const result = spawnSync(
      "/bin/sh",
      ["-c", 'exec "$0" read .openclaw openclaw.json 3<"$1" >&-', helper!, path],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    const refusal = spawnSync(
      "/bin/sh",
      ["-c", 'exec "$0" read .openclaw missing.json 3<"$1" >&-', helper!, path],
      { encoding: "utf8" },
    );
    expect(refusal.status).toBe(1);
  });

  it("reads only from the home it was handed, and takes no path of its own", () => {
    const { path } = home();
    const answer = (args: string[]) =>
      spawnSync("/bin/sh", ["-c", 'exec "$0" "$@" 3<"$HOME_DIR"', helper!, ...args], {
        env: { HOME_DIR: path, PATH: "/usr/bin:/bin" },
      });
    expect(answer(["read", ".openclaw", "openclaw.json"]).stdout.toString()).toBe(
      `ok\n${SETTINGS}`,
    );
    for (const args of [
      ["read", path, ".openclaw", "openclaw.json"],
      ["read", "..", "openclaw.json"],
      ["read", ".openclaw", "a/b"],
    ])
      expect(answer(args).status, args.join(" ")).toBe(2);
  });

  // Only where CI's fixture step made it, on a discarded GitHub-hosted runner: a file root owns
  // that this account may read through an ACL, so that only the owner check refuses it. This
  // test reads that fixture and changes nothing.
  it.skipIf(!process.env.CLAWTRATE_OWNER_FIXTURE_HOME)(
    "refuses a file that belongs to another account",
    async () => {
      expect(await openIn(process.env.CLAWTRATE_OWNER_FIXTURE_HOME!)).toEqual(unsafe("owner"));
    },
  );
});

describe.skipIf(platform !== "linux")("Linux ACLs", () => {
  const setfacl = ["/usr/bin/setfacl", "/bin/setfacl"].find((path) => existsSync(path));
  it.skipIf(!setfacl)("refuses a file whose ACL names another account, by its mode", async () => {
    const { path, file } = home();
    execFileSync(setfacl!, ["-m", "u:nobody:r", file]);
    expect(await openIn(path)).toEqual(unsafe("mode"));
  });
});

describe.skipIf(!posix)("the helper's failures mean unverified", () => {
  const viaFake = (path: string | null, deadlineMs?: number) =>
    openSettingsFile({
      home: home().path,
      folder: ".openclaw",
      file: "openclaw.json",
      platform: "darwin",
      helper: path,
      sandboxed: true,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
  const fake = (name: string) => join(scratch, name);

  it.each([
    ["no helper", null],
    ["a missing helper", "no-such-helper"],
    ["a helper that fails", "fails"],
    ["an answer, then a failed exit", "answer-fails"],
    ["an answer, then a signal", "answer-killed"],
    ["malformed output", "malformed"],
    ["an unknown refusal", "unknown"],
    ["no line end", "no-newline"],
    ["a refusal with no line end", "refusal-no-newline"],
    ["a refusal with more after it", "refusal-body"],
    ["two refusals", "two-refusals"],
    ["a file of more than 1 MiB", "over-cap"],
  ])("refuses with %s", async (_, name) => {
    expect(await viaFake(name === null ? null : fake(name))).toEqual(unverified);
  });

  it("takes a file of exactly 1 MiB", async () => {
    const answer = await viaFake(fake("at-cap"));
    expect(answer.kind === "read" && answer.bytes.length).toBe(SETTINGS_LIMIT);
  });

  it("refuses a helper that passes its deadline, and stops it", async () => {
    const started = Date.now();
    expect(await viaFake(fake("slow"), 200)).toEqual(unverified);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("hands the helper the held home and two names, with no environment of the host's", async () => {
    const marker = join(scratch, "seen.json");
    const seen = join(scratch, "seen");
    writeFileSync(
      seen,
      `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  argv: process.argv.slice(2),
  // macOS sets this one for every process it starts; nothing else may come through.
  env: Object.keys(process.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING"),
  home: fs.fstatSync(3).ino,
}));
process.stdout.write("refused absent\\n");
`,
      { mode: 0o700 },
    );
    const { path } = home();
    process.env.CLAWTRATE_TEST_SECRET = "must-not-pass";
    let answer;
    try {
      answer = await openSettingsFile({
        home: path,
        folder: ".openclaw",
        file: "openclaw.json",
        platform: "darwin",
        helper: seen,
        sandboxed: true,
      });
    } finally {
      delete process.env.CLAWTRATE_TEST_SECRET;
    }
    // The fixture ran (its marker first), then its one refusal line was taken as it is.
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
      // This run is sandboxed, so its home is read by the private rule.
      argv: ["read-private", ".openclaw", "openclaw.json"],
      env: ["PATH"],
      home: statSync(path).ino,
    });
    expect(answer).toEqual({ kind: "refused", reason: "absent" });
  });
});

describe("the parse worker", () => {
  const write = (name: string, body: string) => {
    const path = join(scratch, name);
    writeFileSync(path, body);
    return pathToFileURL(path);
  };
  /** A worker that answers with exactly this message. */
  const answering = (name: string, message: unknown) =>
    write(
      name,
      `import { parentPort } from "node:worker_threads";
parentPort.postMessage(${JSON.stringify(message)});\n`,
    );

  it("answers with what the rules found", async () => {
    expect(await parseInWorker(SETTINGS, "default", WORKER)).toEqual({
      kind: "found",
      token: TOKEN,
      port: 19555,
    });
  });

  it("refuses a malformed number in linear time", async () => {
    const text = `{ gateway: { port: ${"1".repeat(400_000)}x } }`;
    const started = Date.now();
    expect(await parseInWorker(text, "default", WORKER)).toEqual({
      kind: "refused",
      reason: "unreadable",
      why: "malformed",
    });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("refuses when the worker passes its deadline, and ends it", async () => {
    const started = Date.now();
    expect(
      await parseInWorker(SETTINGS, "default", write("spin.mjs", "for (;;) {}\n"), 300),
    ).toEqual(workerFailed);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses text over 1 MiB without starting a worker", async () => {
    const spin = write("spin-large.mjs", "for (;;) {}\n");
    const started = Date.now();
    expect(await parseInWorker("x".repeat(SETTINGS_LIMIT + 1), "default", spin, 5_000)).toEqual({
      kind: "refused",
      reason: "unreadable",
      why: "large",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("refuses a worker that can't start", async () => {
    expect(
      await parseInWorker("", "default", new URL("http://127.0.0.1:9/settings-parse.mjs")),
    ).toEqual(workerFailed);
  });

  it("runs with resource limits, no Node options and an empty environment", async () => {
    const report = `import { parentPort, resourceLimits } from "node:worker_threads";
const token = JSON.stringify({ resourceLimits, execArgv: process.execArgv, env: Object.keys(process.env) });
parentPort.postMessage({ kind: "found", token, port: 1 });\n`;
    const answer = await parseInWorker("", "default", write("report.mjs", report));
    if (answer.kind !== "found") throw new Error("the worker didn't answer");
    expect(JSON.parse(answer.token)).toEqual({
      resourceLimits: expect.objectContaining({
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 4,
      }) as unknown,
      execArgv: [],
      env: [],
    });
  });

  it("refuses a worker that fails or runs out of memory", async () => {
    expect(
      await parseInWorker("", "default", write("throws.mjs", "throw new Error('x');\n")),
    ).toEqual(workerFailed);
    const grow = "const a = []; for (;;) a.push(new Array(1e6).fill(1));\n";
    expect(await parseInWorker("", "default", write("grows.mjs", grow), 10_000)).toEqual(
      workerFailed,
    );
  }, 15_000);

  it.each([
    ["a token that isn't text", { kind: "found", token: 1, port: 19555 }],
    ["a port out of range", { kind: "found", token: TOKEN, port: 0 }],
    ["a port that isn't whole", { kind: "found", token: TOKEN, port: 19555.5 }],
    ["an empty token", { kind: "found", token: "", port: 19555 }],
    ["a token with a control character", { kind: "found", token: "a\nb", port: 19555 }],
    ["a token over 4 KiB", { kind: "found", token: "x".repeat(4097), port: 19555 }],
    ["a reason the rules never give", { kind: "refused", reason: "other", why: "port" }],
    ["a why from another reason", { kind: "refused", reason: "address", why: "empty" }],
    ["a why the rules never give", { kind: "refused", reason: "credential", why: "nope" }],
  ])("refuses an answer with %s", async (name, message) => {
    expect(await parseInWorker("", "default", answering(`${name}.mjs`, message))).toEqual(
      workerFailed,
    );
  });

  it.each([
    ["$NAME", "$OPENCLAW_TOKEN"],
    ["${…}", "${OPENCLAW_TOKEN}"],
    ["${…} inside text", "abc${OPENCLAW_TOKEN}def"],
    ["a legacy env marker", "secretref-env:OPENCLAW_TOKEN"],
    ["an older env marker", "__env__:OPENCLAW_TOKEN"],
    ["the redaction sentinel", "__OPENCLAW_REDACTED__"],
    ["a display marker", "[REDACTED]"],
    ["a placeholder", "change-me-now"],
    ["the word null", "null"],
    ["untrimmed text", ` ${TOKEN}`],
  ])("refuses a worker's token that is %s, by the extractor's own rule", async (name, token) => {
    const answer = answering(`token-${name.replace(/\W+/g, "-")}.mjs`, {
      kind: "found",
      token,
      port: 19555,
    });
    expect(await parseInWorker("", "default", answer)).toEqual(workerFailed);
  });

  it("takes a worker's literal token that only looks like a reference", async () => {
    const answer = answering("token#literal.mjs", { kind: "found", token: "$cost-2026", port: 1 });
    expect(await parseInWorker("", "default", answer)).toEqual({
      kind: "found",
      token: "$cost-2026",
      port: 1,
    });
  });

  it("keeps only a refusal's fixed fields", async () => {
    const message = { kind: "refused", reason: "credential", why: "empty", secret: TOKEN };
    expect(await parseInWorker("", "default", answering("extra.mjs", message))).toStrictEqual({
      kind: "refused",
      reason: "credential",
      why: "empty",
    });
  });
});

describe.skipIf(!posix)("two profiles", () => {
  /** Adds the clawtrate profile's folder and file to a home. */
  const clawtrate = (path: string, text: string, mode = 0o700) => {
    const other = join(path, ".openclaw-clawtrate");
    mkdirSync(other, { mode });
    chmodSync(other, mode);
    writeFileSync(join(other, "openclaw.json"), text, { mode: 0o600 });
  };

  it("shows both by name when both qualify", async () => {
    const { path } = home();
    clawtrate(path, `{ gateway: { port: 19556, auth: { token: "other" } } }`);
    const results = await read(path);
    expect(results.map((result) => result.profile)).toEqual(["default", "clawtrate"]);
    expect(results.map((result) => result.outcome)).toMatchObject([
      { kind: "found", port: 19555 },
      { kind: "found", port: 19556 },
    ]);
  });

  it("gives each profile its own port when its file names none", async () => {
    const { path } = home({ text: `{ gateway: { auth: { token: "${TOKEN}" } } }` });
    clawtrate(path, `{ gateway: { auth: { token: "other" } } }`);
    expect(await read(path)).toMatchObject([
      { profile: "default", outcome: { kind: "found", port: 18789 } },
      { profile: "clawtrate", outcome: { kind: "found", port: 22768 } },
    ]);
  });

  it("refuses a port the profile's own file could override", async () => {
    const { path } = home();
    clawtrate(
      path,
      `{ env: { OPENCLAW_GATEWAY_PORT: "19999" }, gateway: { auth: { token: "a" } } }`,
    );
    expect(await read(path)).toMatchObject([
      { profile: "default", outcome: { kind: "found", port: 19555 } },
      { profile: "clawtrate", outcome: { kind: "refused", reason: "address", why: "port" } },
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
    clawtrate(path, SETTINGS, 0o755);
    expect(await read(path)).toMatchObject([
      { profile: "default", outcome: { reason: "address", why: "remote" } },
      { profile: "clawtrate", outcome: { reason: "unsafe", why: "mode" } },
    ]);
  });
});

it("compares folders by their exact device and inode, beyond a number's precision", () => {
  const large = 2n ** 60n;
  const folder = { dev: 1n, ino: large };
  expect(sameFolder(folder, { dev: 1n, ino: large })).toBe(true);
  // Each pair differs by one, which a JavaScript number would round away.
  expect(sameFolder(folder, { dev: 1n, ino: large + 1n })).toBe(false);
  expect(sameFolder({ dev: large, ino: 1n }, { dev: large + 1n, ino: 1n })).toBe(false);
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
    for (const path of [real!, `${real!}${sep}`]) {
      await expect(
        openSettingsFile({
          home: path,
          folder: ".openclaw",
          file: "openclaw.json",
          platform: "darwin",
          helper: spy,
          sandboxed: true,
        }),
      ).rejects.toBeInstanceOf(SetupRefusedError);
      await expect(
        readLocalSettings({
          home: path,
          platform: "darwin",
          helper: spy,
          sandboxed: true,
          worker: WORKER,
        }),
      ).rejects.toBeInstanceOf(SetupRefusedError);
    }
    expect(existsSync(marker)).toBe(false);
  });

  // Every guardHome call here passes a stand-in for the account's home: the real one is never
  // looked up, and nothing is opened, since the guard decides before anything is.
  const synthetic = resolve("/", "clawtrate-synthetic-home");
  const elsewhere = resolve("/", "clawtrate-other-home");

  it("is refused unless the caller says the run is a production one, and no marker says otherwise", () => {
    for (const path of [synthetic, "/usr"]) {
      for (const sandboxed of [true, undefined])
        expect(() => guardHome(path, sandboxed, {}, () => path), `${path} ${sandboxed}`).toThrow(
          SetupRefusedError,
        );
      // A marker makes a run sandboxed whatever the caller says.
      expect(() => guardHome(path, false, { CLAWTRATE_AUTOMATED: "" }, () => path)).toThrow(
        SetupRefusedError,
      );
    }
  });

  it("in a production run, is only the home the system reports for this account", () => {
    const production = (home: string, account: string | null) => () =>
      guardHome(
        home,
        false,
        {},
        () => account,
        () => true,
      );
    expect(production(synthetic, synthetic)).not.toThrow();
    expect(production(synthetic, `${synthetic}${sep}`)).not.toThrow();
    // A home the caller names that isn't the account's, or no account home at all, refuses.
    expect(production(elsewhere, synthetic)).toThrow(SetupRefusedError);
    expect(production(`${synthetic}${sep}`, synthetic)).toThrow(SetupRefusedError);
    expect(production(join(synthetic, ".openclaw"), synthetic)).toThrow(SetupRefusedError);
    expect(production(synthetic, null)).toThrow(SetupRefusedError);
  });

  it("outside a person's packaged app has no default home: a production run there is refused", () => {
    // A development build, a test runner, the web host: this process isn't a packaged app's, so
    // even the account's own home, named exactly, is refused before anything is opened.
    expect(() => guardHome(synthetic, false, {}, () => synthetic)).toThrow(SetupRefusedError);
    expect(() =>
      guardHome(
        synthetic,
        false,
        {},
        () => synthetic,
        () => false,
      ),
    ).toThrow(SetupRefusedError);
    expect(packagedApp({ versions: {} })).toBe(false);
    expect(packagedApp({ versions: { electron: "41.0.0" }, defaultApp: true })).toBe(false);
    expect(packagedApp({ versions: { electron: "41.0.0" } })).toBe(true);
    // This test runner itself.
    expect(packagedApp()).toBe(false);
  });

  it("is never a default: every reader entry point takes the home from its caller", () => {
    const source = readFileSync(join(ROOT, "apps/desktop/src/setup/settings-reader.ts"), "utf8");
    // The account's home is looked up only to compare with the one given; nothing else names one.
    expect(source.match(/\baccountHome\b/g)).toHaveLength(2);
    expect(source).toContain("accountHomeOf: () => string | null = accountHome,");
    expect(source).not.toMatch(/homedir|userInfo|process\.env\.HOME|"~/);
  });
});

it("a shipped host reaches the reader only through local connect: its look, its Connect and its proof", () => {
  const own = new Set([
    "settings-reader.ts",
    "settings-parse.ts",
    "settings-extract.ts",
    "settings-lexer.ts",
    "openclaw-pins.ts",
  ]);
  const shipped = ["apps/desktop/src", "packages/core/src", "packages/ui/src"].flatMap((dir) =>
    (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
      .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
      .map((path) => join(ROOT, dir, path)),
  );
  const importers = shipped.filter((file) => {
    const name = relative(join(ROOT, "apps/desktop/src/setup"), file);
    if (own.has(name)) return false;
    return [...own].some((module) =>
      readFileSync(file, "utf8").includes(module.replace(/\.ts$/, "")),
    );
  });
  // The proof holds the home and runs the helper as the reader does; the look reads settings,
  // and Connect holds the token it found: local connect, which no shipped host turns on yet
  // (local-connect.test.ts).
  expect(importers.map((file) => relative(ROOT, file).split(sep).join("/")).sort()).toEqual([
    "apps/desktop/src/setup/controller.ts",
    "apps/desktop/src/setup/local-look.ts",
    "apps/desktop/src/setup/local-prove.ts",
  ]);
  const readers = shipped.filter(
    (file) =>
      !file.endsWith(`${sep}settings-reader.ts`) &&
      /\b(readLocalSettings|openSettingsFile|parseInWorker)\b/.test(readFileSync(file, "utf8")),
  );
  expect(readers.map((file) => relative(ROOT, file).split(sep).join("/"))).toEqual([
    "apps/desktop/src/setup/local-look.ts",
  ]);
});

// CI installs the pinned OpenClaw from npm and names its folder: it must be a version local
// connect proves, carry this platform's own module, and every module it carries must match its
// version's pin.
it.skipIf(!process.env.CLAWTRATE_PINNED_OPENCLAW)(
  "the pinned hashes match the installed OpenClaw's own modules",
  () => {
    const root = process.env.CLAWTRATE_PINNED_OPENCLAW!;
    const version = (path: string) =>
      (JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { version: string }).version;
    const openclaw = version(root);
    expect(Object.keys(PROVED_OPENCLAW)).toContain(openclaw);
    const scope = join(root, "node_modules/@openclaw");
    const found = readdirSync(scope).filter((name) => /^fs-safe-.+/.test(name));
    const libc =
      platform !== "linux"
        ? ""
        : (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header
              ?.glibcVersionRuntime
          ? "-gnu"
          : "-musl";
    expect(found).toContain(`fs-safe-${platform}-${process.arch}${libc}`);
    for (const name of found) {
      expect(version(join(scope, name)), name).toBe(PROVED_FS_SAFE[openclaw]);
      const file = readFileSync(join(scope, name, "fs-safe-native.node"));
      const hash = createHash("sha256").update(file).digest("hex");
      expect(hash, name).toBe(PROVED_OPENCLAW[openclaw]![name.slice("fs-safe-".length)]);
    }
  },
);
