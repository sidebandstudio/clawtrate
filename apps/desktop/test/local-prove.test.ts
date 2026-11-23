// The send gate's proof (docs/design/setup-effortless.md §3, checks (e) and
// (f)) without a gateway: the native helper on macOS, or /proc on Linux,
// against listeners and profile files of the test's own in temporary homes;
// and stand-in helpers for what the host checks in the helper's answer. A
// development gateway proves the passing case (setup-connect-boundaries.test.ts).

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
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
import { FS_SAFE_NATIVE_SHA256, PINNED_OPENCLAW_VERSION } from "../src/setup/openclaw-pins.ts";

const platform = process.platform;
const posix = platform === "darwin" || platform === "linux";
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

describe.skipIf(!posix)("the proof, against listeners of the test's own", () => {
  it("F-492: a same-account holder that maps no OpenClaw module is refused", async () => {
    const { localPort, end } = await connection(port);
    try {
      // (e) passes: this process holds the server end. (f) refuses it.
      expect(await proveLocalGateway(options(home(), localPort))).toEqual(refused("module"));
    } finally {
      end();
    }
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
    expect(await proveLocalGateway(options(path, 1, { platform: "win32" }))).toEqual(
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
    const prove = (path: string, output: Buffer | string, more: Partial<ProveOptions> = {}) =>
      proveLocalGateway(options(path, port + 1, { helper: fake(output), ...more }));

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

    it("refuses a module that isn't the pinned one", async () => {
      const at = path();
      const lock = named(at);
      expect(await prove(at, answer({ lock, sha256: "0".repeat(64) }))).toEqual(refused("pin"));
      // The other architecture's module, with this one's hash.
      expect(await prove(at, answer({ lock, arch: "x64" }))).toEqual(refused("pin"));
      for (const pkg of [
        { name: "openclaw", version: "2026.10.5" },
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
      expect(await proveLocalGateway(options(at, port + 1, { helper: failing }))).toEqual(
        refused("helper"),
      );
      const slow = join(scratch, "slow");
      writeFileSync(slow, "#!/bin/sh\nexec sleep 5\n", { mode: 0o700 });
      const started = Date.now();
      expect(
        await proveLocalGateway(options(at, port + 1, { helper: slow, deadlineMs: 300 })),
      ).toEqual(refused("helper"));
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await proveLocalGateway(options(at, port + 1, { helper: null }))).toEqual(
        refused("helper"),
      );
      expect(
        await proveLocalGateway(options(at, port + 1, { helper: join(scratch, "missing") })),
      ).toEqual(refused("helper"));
    });
  },
);
