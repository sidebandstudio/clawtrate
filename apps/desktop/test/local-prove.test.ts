// The send gate's proof (docs/design/setup-effortless.md §3, checks (e) and
// (f)) without a gateway: the native helper on macOS against listeners and
// profile files of the test's own in temporary homes;
// and stand-in helpers for what the host checks in the helper's answer. A
// development gateway proves the passing case (setup-connect-boundaries.test.ts).

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localGatewayBuild } from "../packaging/config.ts";
import { proveLocalGateway, type ProveOptions } from "../src/setup/local-prove.ts";
import {
  FS_SAFE_1110_SHA256,
  FS_SAFE_NATIVE_SHA256,
  PINNED_OPENCLAW_VERSION,
} from "../src/setup/openclaw-pins.ts";

const platform = process.platform;
const FOLDER = ".openclaw-clawtrate";

let scratch: string;
let helper: string | null = null;
let server: Server;
let port: number;
const accepted: Socket[] = [];
beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-prove-")));
  if (platform === "darwin") {
    helper = join(scratch, "helper");
    execFileSync("/usr/bin/xcrun", localGatewayBuild(helper));
  }
  // A listener of this process's own: this account's, running Node, and no OpenClaw.
  server = createServer((socket) => accepted.push(socket.on("error", () => {})));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  for (const socket of accepted) socket.destroy();
  server?.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A private home with a profile whose gateway lock and state database exist. */
function home(options: { lock?: boolean; database?: boolean } = {}): string {
  const path = realpathSync(mkdtempSync(join(scratch, "home-")));
  chmodSync(path, 0o700);
  const profile = join(path, FOLDER);
  mkdirSync(join(profile, "state"), { recursive: true, mode: 0o700 });
  mkdirSync(join(profile, "tmp", `openclaw-${process.geteuid!()}`), {
    recursive: true,
    mode: 0o700,
  });
  if (options.lock !== false) lockFile(path, { pid: process.pid, role: "gateway", port });
  if (options.database !== false)
    writeFileSync(join(profile, "state", "openclaw.sqlite"), "", { mode: 0o600 });
  return path;
}

/** The profile's lock and database in a home, as the gateway holds them open. */
const held = (path: string) => [
  join(path, FOLDER, "tmp", `openclaw-${process.geteuid!()}`, "gateway.state.lock"),
  join(path, FOLDER, "state", "openclaw.sqlite"),
];

function lockFile(path: string, content: object): string {
  const file = join(path, FOLDER, "tmp", `openclaw-${process.geteuid!()}`, "gateway.state.lock");
  writeFileSync(file, JSON.stringify(content), { mode: 0o600 });
  return file;
}

/** A connection to `to`, held open for the proof; its local port. */
async function connection(to: number): Promise<{ localPort: number; end: () => void }> {
  const socket = connect({ host: "127.0.0.1", port: to });
  await new Promise<void>((done) => socket.once("connect", () => done()));
  return { localPort: socket.localPort!, end: () => socket.destroy() };
}

const options = (path: string, localPort: number, more: Partial<ProveOptions> = {}) => ({
  home: path,
  folder: FOLDER,
  port,
  localPort,
  platform,
  helper,
  sandboxed: true,
  ...more,
});
const refused = (why: string) => ({ proved: false, why });

describe.skipIf(platform !== "darwin")("the proof, against listeners of the test's own", () => {
  it("F-492: a same-account holder is refused by the profile's files first, then by its module", async () => {
    const { localPort, end } = await connection(port);
    const at = home();
    try {
      // (e) passes: this process holds the server end. (f) asks first for the profile's lock
      // and database held open, which opens nothing of the holder's.
      expect(await proveLocalGateway(options(at, localPort))).toEqual(refused("lock"));
      const files = held(at).map((file) => openSync(file, "r"));
      try {
        // Holding them, it runs Node, but maps no OpenClaw module.
        expect(await proveLocalGateway(options(at, localPort))).toEqual(refused("module"));
      } finally {
        for (const fd of files) closeSync(fd);
      }
    } finally {
      end();
    }
  });

  it("proves exactly this connection, by both its ports", async () => {
    const spare = createServer((socket) => socket.on("error", () => {}));
    await new Promise<void>((done) => spare.listen(0, "127.0.0.1", done));
    const sparePort = (spare.address() as { port: number }).port;
    const toServer = await connection(port);
    const toSpare = await connection(sparePort);
    try {
      // The far end of another connection of this process's, to another port, holds neither.
      expect(await proveLocalGateway(options(home(), toSpare.localPort))).toEqual(
        refused("holder"),
      );
      expect(
        await proveLocalGateway(options(home(), toServer.localPort, { port: sparePort })),
      ).toEqual(refused("holder"));
    } finally {
      toServer.end();
      toSpare.end();
      spare.close();
    }
  }, 15_000);

  it("refuses a holder of this account's that isn't Node", async () => {
    const at = home();
    // A Perl listener holding the profile's lock and database open, so the program is reached.
    const perl = spawn(
      "/usr/bin/perl",
      [
        "-MIO::Socket::INET",
        "-e",
        'open(my $l, "<", $ARGV[0]) or die; open(my $d, "<", $ARGV[1]) or die; $|=1; my $s = IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => 0, Listen => 4) or die; print $s->sockport, "\n"; my @held; while (my $c = $s->accept) { push @held, $c }',
        ...held(at),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const listening = await new Promise<number>((done) =>
        perl.stdout.once("data", (text: Buffer) => done(Number(String(text).trim()))),
      );
      const { localPort, end } = await connection(listening);
      try {
        const proof = await proveLocalGateway(options(at, localPort, { port: listening }));
        expect(proof).toEqual(refused("node"));
      } finally {
        end();
      }
    } finally {
      perl.kill("SIGKILL");
    }
  });

  it("refuses a PID whose start time isn't the one the scan saw", async () => {
    // PID reuse can't be forced safely, so the helper's own check is driven directly: this
    // process by its PID and the start the kernel reports, a microsecond off either way, and a
    // PID whose process has exited.
    const source = join(scratch, "same-process.c");
    const binary = join(scratch, "same-process");
    writeFileSync(
      source,
      `#define main helper_main
#include "local-gateway.c"
#undef main
int main(int argc, char **argv) {
  (void)argc;
  pid_t pid = (pid_t)atoi(argv[1]);
  struct proc_bsdinfo info;
  uint64_t start = 1;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) == sizeof info)
    start = info.pbi_start_tvsec * 1000000ull + info.pbi_start_tvusec;
  const char *at[] = {sameProcess(pid, start, &info), sameProcess(pid, start + 1, &info),
                      sameProcess(pid, start - 1, &info)};
  for (int i = 0; i < 3; ++i) printf("%s ", at[i] ? at[i] : "ok");
  return 0;
}`,
    );
    execFileSync("/usr/bin/xcrun", [
      "clang",
      "-Wno-unused-function",
      "-I",
      join(import.meta.dirname, "../packaging/mac"),
      source,
      "-o",
      binary,
    ]);
    expect(execFileSync(binary, [String(process.pid)], { encoding: "utf8" }).trim()).toBe(
      "ok holder holder",
    );
    const gone = spawn("/usr/bin/true");
    await new Promise((done) => gone.once("exit", done));
    expect(execFileSync(binary, [String(gone.pid)], { encoding: "utf8" }).trim()).toBe(
      "holder holder holder",
    );
  });

  it("refuses a holder whose start differs from the one the scan recorded", async () => {
    // A test build records every start a microsecond late: (f) must refuse the PID it then sees.
    const skewed = join(scratch, "helper-skewed");
    execFileSync("/usr/bin/xcrun", [...localGatewayBuild(skewed), "-DPROVE_START_SKEW=1"]);
    const { localPort, end } = await connection(port);
    const at = home();
    const files = held(at).map((file) => openSync(file, "r"));
    try {
      expect(await proveLocalGateway(options(at, localPort))).toEqual(refused("module"));
      expect(await proveLocalGateway(options(at, localPort, { helper: skewed }))).toEqual(
        refused("holder"),
      );
    } finally {
      for (const fd of files) closeSync(fd);
      end();
    }
  });

  it("takes a process with no descriptors as an empty list, whatever errno said before", async () => {
    // A stale errno from an earlier lookup (here EPERM) once made a successful empty list read
    // as a failure, and the scan refused a healthy gateway as `denied`.
    const source = join(scratch, "descriptors.c");
    const binary = join(scratch, "descriptors");
    writeFileSync(
      source,
      `#define main helper_main
#include "local-gateway.c"
#undef main
int main(int argc, char **argv) {
  (void)argc;
  int count = -1;
  errno = EPERM;
  struct proc_fdinfo *fds = descriptors((pid_t)atoi(argv[1]), &count);
  printf("%s %d", fds ? "list" : "none", count);
  free(fds);
  return 0;
}`,
    );
    execFileSync("/usr/bin/xcrun", [
      "clang",
      "-Wno-unused-function",
      "-I",
      join(import.meta.dirname, "../packaging/mac"),
      source,
      "-o",
      binary,
    ]);
    // A process of the test's own that has closed every descriptor.
    const bare = spawn(
      "/usr/bin/perl",
      ["-MPOSIX", "-e", "$| = 1; print qq(ready\n); POSIX::close($_) for 0..1023; sleep 60"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await new Promise((done) => bare.stdout.once("data", done));
      // It prints before it closes them: ask until the closing is done, not for a fixed time.
      await expect
        .poll(() => execFileSync(binary, [String(bare.pid)], { encoding: "utf8" }), {
          timeout: 3_000,
        })
        .toBe("list 0");
    } finally {
      bare.kill("SIGKILL");
    }
    // A process that is gone is still no list.
    const gone = spawn("/usr/bin/true");
    await new Promise((done) => gone.once("exit", done));
    expect(execFileSync(binary, [String(gone.pid)], { encoding: "utf8" })).toBe("none 0");
  });

  it("finds no holder for a connection that isn't there", async () => {
    // A port of this run's that no connection uses, as the far end of nothing.
    const spare = createServer();
    await new Promise<void>((done) => spare.listen(0, "127.0.0.1", done));
    const unused = (spare.address() as { port: number }).port;
    spare.close();
    expect(await proveLocalGateway(options(home(), unused))).toEqual(refused("holder"));
  });

  it("refuses a profile whose gateway isn't running, before it looks for a holder", async () => {
    const { localPort, end } = await connection(port);
    try {
      expect(await proveLocalGateway(options(home({ lock: false }), localPort))).toEqual(
        refused("lock"),
      );
      expect(await proveLocalGateway(options(home({ database: false }), localPort))).toEqual(
        refused("state"),
      );
      expect(await proveLocalGateway(options(home(), localPort, { folder: ".openclaw" }))).toEqual(
        refused("absent"),
      );
    } finally {
      end();
    }
  });

  it("reads the lock by the reader's rules: no link, and owner-only", async () => {
    const { localPort, end } = await connection(port);
    try {
      const open = home();
      chmodSync(lockFile(open, { pid: process.pid }), 0o644);
      expect(await proveLocalGateway(options(open, localPort))).toEqual(refused("mode"));
      const linked = home({ lock: false });
      const target = join(scratch, `lock-${Math.random()}`);
      writeFileSync(target, "{}", { mode: 0o600 });
      symlinkSync(
        target,
        join(linked, FOLDER, "tmp", `openclaw-${process.geteuid!()}`, "gateway.state.lock"),
      );
      expect(await proveLocalGateway(options(linked, localPort))).toEqual(refused("link"));
      const shared = home();
      chmodSync(join(shared, FOLDER), 0o750);
      expect(await proveLocalGateway(options(shared, localPort))).toEqual(refused("mode"));
      // A sandboxed run's home must be private, ACL included, as the reader's is.
      const granted = home();
      execFileSync("/bin/chmod", ["+a", "everyone allow read", granted]);
      try {
        expect(await proveLocalGateway(options(granted, localPort))).toEqual(refused("acl"));
      } finally {
        execFileSync("/bin/chmod", ["-N", granted]);
      }
    } finally {
      end();
    }
  });

  it("refuses what it can't use before it opens anything", async () => {
    const path = home();
    expect(await proveLocalGateway(options(path, port))).toEqual(refused("path"));
    expect(await proveLocalGateway(options(path, 0))).toEqual(refused("path"));
    for (const folder of ["..", ".openclaw/../x", "openclaw", ".openclaw-A", ""])
      expect(await proveLocalGateway(options(path, 1, { folder })), folder).toEqual(
        refused("path"),
      );
    // Linux's walk through /proc is setup PR 2a-3's: until then nothing is proved there.
    for (const other of ["win32", "linux"] as const)
      expect(await proveLocalGateway(options(path, 1, { platform: other })), other).toEqual(
        refused("platform"),
      );
    // The reader's home rule: a test never proves against a home outside the temporary roots.
    expect(await proveLocalGateway(options("/usr", 1))).toEqual(refused("path"));
  });
});

/** What the helper prints for a holder, before the host's checks. */
function answer(facts: {
  pid?: number;
  start?: number;
  arch?: string;
  sha256?: string;
  lock?: object | string;
  pkg?: object;
  extra?: string;
}): Buffer {
  const lock = Buffer.from(
    typeof facts.lock === "string" ? facts.lock : JSON.stringify(facts.lock ?? {}),
  );
  const pkg = Buffer.from(
    JSON.stringify(facts.pkg ?? { name: "openclaw", version: PINNED_OPENCLAW_VERSION }),
  );
  const header = `proved ${facts.pid ?? 4242} ${facts.start ?? 1795410457} ${facts.arch ?? "arm64"} ${
    facts.sha256 ?? FS_SAFE_NATIVE_SHA256["darwin-arm64"]
  } ${lock.length} ${pkg.length}\n`;
  return Buffer.concat([Buffer.from(header), lock, pkg, Buffer.from(facts.extra ?? "")]);
}

let fakes = 0;
/** A stand-in helper that prints exactly these bytes and exits 0. */
function fake(output: Buffer | string, exit = 0): string {
  const path = join(scratch, `fake-${(fakes += 1)}`);
  const bytes = Buffer.from(output).toString("base64");
  writeFileSync(
    path,
    `#!${process.execPath}\nprocess.stdout.write(Buffer.from(${JSON.stringify(bytes)}, "base64"), () => process.exit(${exit}));\n`,
    { mode: 0o700 },
  );
  return path;
}

describe.skipIf(platform !== "darwin")(
  "the host's checks of the helper's answer",
  // Each stand-in helper is a Node process of its own.
  { timeout: 60_000 },
  () => {
    const path = () => home({ lock: false, database: false });
    const named = (path: string, more: object = {}) => ({
      pid: 4242,
      role: "gateway",
      port,
      stateDir: join(path, FOLDER),
      startTime: 1795410457,
      ...more,
    });
    // A stand-in is a Node process, which can take longer than the proof's 2 s to start on a busy
    // machine: its answer is what these check, so it gets all the time the test has.
    const STAND_IN_DEADLINE_MS = 50_000;
    const prove = (path: string, output: Buffer | string, more: Partial<ProveOptions> = {}) =>
      proveLocalGateway(
        options(path, port + 1, {
          helper: fake(output),
          deadlineMs: STAND_IN_DEADLINE_MS,
          ...more,
        }),
      );

    it("passes a holder whose facts match the pins and the lock that names it", async () => {
      const at = path();
      expect(await prove(at, answer({ lock: named(at) }))).toEqual({ proved: true });
      // Within a second of the kernel's start time, as OpenClaw records it.
      expect(await prove(at, answer({ lock: named(at, { startTime: 1795410458 }) }))).toEqual({
        proved: true,
      });
      // OpenClaw pads its lock with whitespace.
      const padded = `${JSON.stringify(named(at))}\n\t  \t`;
      expect(await prove(at, answer({ lock: padded }))).toEqual({ proved: true });
    });

    it("passes either proved version with its own module, and neither with the other's", async () => {
      const at = path();
      const lock = named(at);
      const v1110 = { name: "openclaw", version: "2026.11.10" };
      for (const arch of ["arm64", "x64"]) {
        const sha256 = FS_SAFE_1110_SHA256[`darwin-${arch}`]!;
        expect(await prove(at, answer({ lock, pkg: v1110, arch, sha256 })), arch).toEqual({
          proved: true,
        });
        // 2026.10.6's module in a package that says 2026.11.10, and the other way round.
        const older = FS_SAFE_NATIVE_SHA256[`darwin-${arch}`]!;
        expect(await prove(at, answer({ lock, pkg: v1110, arch, sha256: older }))).toEqual(
          refused("pin"),
        );
        expect(await prove(at, answer({ lock, arch, sha256 }))).toEqual(refused("pin"));
      }
    });

    it("refuses a module that isn't the pinned one", async () => {
      const at = path();
      const lock = named(at);
      expect(await prove(at, answer({ lock, sha256: "0".repeat(64) }))).toEqual(refused("pin"));
      // The other architecture's module, with this one's hash.
      expect(await prove(at, answer({ lock, arch: "x64" }))).toEqual(refused("pin"));
      for (const pkg of [
        { name: "openclaw", version: "2026.10.5" },
        { name: "openclaw", version: "2026.11.11" },
        { name: "not-openclaw", version: PINNED_OPENCLAW_VERSION },
        {},
      ])
        expect(await prove(at, answer({ lock, pkg })), JSON.stringify(pkg)).toEqual(
          refused("package"),
        );
    });

    it("refuses a holder the lock doesn't name, in every field", async () => {
      const at = path();
      for (const more of [
        { pid: 4243 },
        { role: "agent-embedded" },
        { port: port + 7 },
        { stateDir: join(at, ".openclaw") },
        { startTime: 1795410459 },
        { startTime: "1795410457" },
      ])
        expect(await prove(at, answer({ lock: named(at, more) })), JSON.stringify(more)).toEqual(
          refused("named"),
        );
      expect(await prove(at, answer({ lock: "not json" }))).toEqual(refused("named"));
      expect(await prove(at, answer({ lock: "[]" }))).toEqual(refused("named"));
    });

    it("takes the helper's own refusals, and nothing else it says", async () => {
      const at = path();
      for (const why of ["holder", "account", "node", "module", "lock", "state", "denied", "acl"])
        expect(await prove(at, `refused ${why}\n`), why).toEqual(refused(why));
      for (const output of [
        "refused helper\n",
        "refused named\n",
        "refused pin\n",
        "refused changed\n",
        "refused maybe\n",
        "refused holder",
        "refused holder\nrefused node\n",
        "proved\n",
        "",
        answer({ lock: named(at), extra: "x" }),
        answer({ lock: named(at) }).subarray(0, -1),
      ])
        expect(await prove(at, output), String(output).slice(0, 40)).toEqual(refused("helper"));
      // A failed exit, however good its answer, a helper that never answers, and none.
      const failing = fake(answer({ lock: named(at) }), 1);
      expect(
        await proveLocalGateway(
          options(at, port + 1, { helper: failing, deadlineMs: STAND_IN_DEADLINE_MS }),
        ),
      ).toEqual(refused("helper"));
      // Past its deadline a helper's answer, a good one, is never waited for.
      const slow = join(scratch, "slow");
      writeFileSync(slow, '#!/usr/bin/perl\nsleep 30; print "refused module\\n";\n', {
        mode: 0o700,
      });
      expect(
        await proveLocalGateway(options(at, port + 1, { helper: slow, deadlineMs: 300 })),
      ).toEqual(refused("helper"));
      expect(await proveLocalGateway(options(at, port + 1, { helper: null }))).toEqual(
        refused("helper"),
      );
      expect(
        await proveLocalGateway(options(at, port + 1, { helper: join(scratch, "missing") })),
      ).toEqual(refused("helper"));
    });
  },
);
