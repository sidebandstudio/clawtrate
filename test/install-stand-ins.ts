// A whole first install by site/install.sh on this Mac, against stand-ins: a
// loopback feed and release, an unsigned stand-in app, and stand-ins for the
// three tools that would need a real signed build (file, codesign and spctl).
// The app lands in a temporary Applications folder. macOS only.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCRIPT = new URL("../site/install.sh", import.meta.url).pathname;
export const VERSION = "0.1.1-beta.20261122.1";
const BUNDLE_ID = "dev.clawtrate.desktop";
const TEAM = /^CLAWTRATE_TEAM_ID="([A-Z0-9]{10})"$/m.exec(readFileSync(SCRIPT, "utf8"))![1]!;

const ARCH_OF_THIS_MAC = `if [ "$(sysctl -in hw.optional.arm64 2>/dev/null)" = 1 ] ||
  [ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" = 1 ]; then arch=arm64; else arch="$(uname -m)"; fi`;

const STAND_INS: Record<string, string> = {
  file: `#!/bin/sh\n${ARCH_OF_THIS_MAC}\necho "Mach-O 64-bit executable $arch"\n`,
  codesign: `#!/bin/sh
case "$1" in
  --verify) exit 0 ;;
  --display)
    echo "Identifier=${BUNDLE_ID}" >&2
    echo "Authority=Developer ID Application: Stand-in (${TEAM})" >&2
    echo "TeamIdentifier=${TEAM}" >&2
    echo "CDHash=0123456789abcdef0123456789abcdef01234567" >&2 ;;
  *) exit 1 ;;
esac
`,
  spctl: `#!/bin/sh\necho "accepted" >&2\necho "source=Notarized Developer ID" >&2\n`,
};

export type StandIns = {
  root: string;
  applications: string;
  env: Record<string, string>;
  close(): Promise<void>;
};

export async function standIns(): Promise<StandIns> {
  const root = mkdtempSync(join(tmpdir(), "clawtrate-install-"));
  const bin = join(root, "bin");
  const applications = join(root, "Applications");
  const app = join(root, "build", "Clawtrate.app", "Contents");
  for (const dir of [bin, applications, join(root, "tmp"), join(app, "MacOS")])
    mkdirSync(dir, { recursive: true });
  for (const [tool, body] of Object.entries(STAND_INS))
    writeFileSync(join(bin, tool), body, { mode: 0o700 });
  writeFileSync(
    join(app, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleShortVersionString</key><string>${VERSION}</string>
</dict></plist>
`,
  );
  writeFileSync(join(app, "MacOS", "Clawtrate"), "a stand-in, never run\n", { mode: 0o700 });
  const zipPath = join(root, "Clawtrate.zip");
  execFileSync("ditto", [
    "-c",
    "-k",
    "--keepParent",
    join(root, "build", "Clawtrate.app"),
    zipPath,
  ]);
  const zip = readFileSync(zipPath);
  const sha256 = createHash("sha256").update(zip).digest("hex");

  let prefix = "";
  const server = createServer((request, response) => {
    if (request.url === "/feed/latest-mac.json") {
      const entry = (file: string) => ({
        version: VERSION,
        url: `${prefix}v${VERSION}/Clawtrate-${VERSION}-${file}.zip`,
        sha256,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          arm64: entry("mac-arm64"),
          x86_64: entry("mac-x64"),
          teamIdentifier: TEAM,
        }),
      );
    } else if (request.url?.startsWith(`/releases/v${VERSION}/Clawtrate-${VERSION}-mac-`)) {
      response.writeHead(200, { "content-type": "application/zip" });
      response.end(zip);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  prefix = `${origin}/releases/`;
  return {
    root,
    applications,
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: root,
      TMPDIR: join(root, "tmp"),
      CLAWTRATE_FEED: `${origin}/feed/latest-mac.json`,
      CLAWTRATE_RELEASES: prefix,
      CLAWTRATE_APPLICATIONS: applications,
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type Run = { status: number | null; stdout: string; stderr: string };

/** The installer piped into `shell`, as `curl … | sh` runs it, with stdout not a terminal. */
export function runPiped(
  shell: string,
  env: Record<string, string>,
  script = SCRIPT,
): Promise<Run> {
  const child = spawn(shell, [], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(readFileSync(script));
  return collect(child);
}

/**
 * The installer piped into `shell` inside a pseudo-terminal (script(1)), so
 * its stdout and stderr are a terminal. `before` runs first in the terminal's
 * shell, such as `stty cols 40`. When `interrupt` is given, the terminal's
 * foreground process group gets SIGINT, as from Ctrl-C, once the output
 * contains it.
 */
export function runInTerminal(
  shell: string,
  env: Record<string, string>,
  options: { before?: string; interrupt?: string; script?: string } = {},
): Promise<Run> {
  const pidFile = join(env.TMPDIR ?? tmpdir(), "terminal-shell.pid");
  // The shell in the terminal leads its own process group, and exec keeps its pid.
  const command = `echo $$ >"$2"; ${options.before ?? ":"}; exec "$0" <"$1"`;
  // script(1) needs a stdin it can query, which a Node pipe is not.
  const child = spawn(
    "script",
    ["-q", "/dev/null", "/bin/sh", "-c", command, shell, options.script ?? SCRIPT, pidFile],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (options.interrupt) {
    let seen = "";
    let sent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (!sent && seen.includes(options.interrupt!)) {
        sent = true;
        process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGINT");
      }
    });
  }
  // With no stdin, script(1) sends the terminal an end of file, which it echoes.
  const echo = "^D\b\b";
  return collect(child).then((run) => ({
    ...run,
    stdout: run.stdout.startsWith(echo) ? run.stdout.slice(echo.length) : run.stdout,
  }));
}

function collect(child: ReturnType<typeof spawn>): Promise<Run> {
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
