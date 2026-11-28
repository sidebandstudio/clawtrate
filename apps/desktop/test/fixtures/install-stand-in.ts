// Stand-ins for setting OpenClaw up (docs/design/setup.md §19): the two
// downloads served from this computer's loopback out of a temporary folder;
// an npm tarball whose `install-cli.sh` is a script of ours with the checked
// installer's `install_node` and `prepare_tmpdir` word for word (from
// OpenClaw 2026.11.10's `scripts/install-cli.sh`, MIT licensed, in
// `install-cli-6ea542f/`), and whose `dist/entry.js` is a
// stand-in `openclaw`; a Node.js tarball whose `node` runs that stand-in and
// whose `npm` only prints a version; and a stand-in service manager that
// answers `launchctl print` or `systemctl --user show` from what was
// registered. Nothing here runs OpenClaw or its installer, and everything is
// written under a temporary home outside the account's, in an app-data
// folder whose name has a space, as a Mac's has.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallPins, InstallTarget } from "../../src/setup/install-pins.ts";
import { standInPlace, type InstallPlace } from "../../src/setup/install.ts";

/** One of the pinned installer's functions, word for word. */
const pinned = (name: "install_node" | "prepare_tmpdir") =>
  readFileSync(fileURLToPath(new URL(`./install-cli-6ea542f/${name}.sh`, import.meta.url)), "utf8");

/** How the stand-ins behave: each a failure the install must name, or the whole way through. */
export type StandInScenario =
  | "ok"
  /** The installer's own Node.js check refuses the checked runtime, first time. */
  | "node-unusable"
  /** The first check passes and the installer's own second check fails: its fallback would fetch Node.js. */
  | "node-second-check-fails"
  /** The installer reports starting Node.js itself before its Node.js step. */
  | "node-start"
  /** The tarball's installer has another Node.js step than the one this build replaces. */
  | "installer-unpatchable"
  /** A musl-classified Linux with `apk` on the path: the pinned Node.js step's package-manager branch. */
  | "alpine"
  /** The installer's temporary folder can't be made: the pinned step's fallback is the shared `/tmp`. */
  | "tmp-unusable"
  | "installer-fails"
  /** The installer leaves a program running that writes into the program folder later. */
  | "descendant"
  /** The installed `entry.js` isn't the checked tarball's. */
  | "wrong-program"
  /** Someone else's `clawtrate` state folder appears while the installer runs. */
  | "state-before-onboard"
  /** Someone else's `clawtrate` service file appears while the installer runs. */
  | "service-before-onboard"
  | "onboard-fails"
  /** Someone else's `clawtrate` service file appears after onboarding, before the service install. */
  | "service-after-onboard"
  /** Someone else's `clawtrate` service definition appears during the service install, which says it installed. */
  | "service-during-install"
  | "service-fails"
  /** Linux: the session has no systemd user manager. */
  | "no-user-manager"
  /** The service manager has a `clawtrate` job or unit already, defined somewhere else. */
  | "loaded-elsewhere"
  | "not-answering";

const NODE_VERSION = "24.22.1";

/** The stand-in `install-cli.sh`: sourced, it runs nothing; run, it plays its scenario. */
const INSTALLER = `#!/usr/bin/env bash
set -euo pipefail
SCENARIO="@SCENARIO@"
PLATFORM="@PLATFORM@"
here="\${BASH_SOURCE[0]%/*}"
source "$here/install-policy.sh"
PREFIX="\${HOME}/stand-in-prefix"
NODE_VERSION="${NODE_VERSION}"
NODE_ONLY=0
SUPPORTED_NODE_VERSION_LABEL="Node 24"
TMPFILES=()
emit_json() {
  local out="{\\"event\\":\\"$1\\""
  shift
  while [[ $# -ge 2 ]]; do out+=",\\"$1\\":\\"$2\\""; shift 2; done
  printf '%s}\\n' "$out"
}
fail() { emit_json error message "$1"; exit 1; }
log() { :; }
resolve_installer_path() { printf '%s' "$1"; }
os_detect() { [[ "$SCENARIO" == "alpine" ]] && echo linux || echo "$PLATFORM"; }
arch_detect() { echo arm64; }
is_musl_linux() { [[ "$SCENARIO" == "alpine" ]]; }
select_node_version_for_platform() { :; }
node_version_is_supported() { :; }
node_dir() { echo "\${PREFIX}/tools/node-v\${NODE_VERSION}"; }
node_bin() { echo "$(node_dir)/bin/node"; }
command_path_without_node_prefix() { return 1; }
link_node_runtime_paths() { :; }
detect_downloader() { :; }
require_bin() { :; }
sha256_file() { echo 0; }
required_node_version() { echo 24; }
node_binary_sqlite_version() { echo unknown; }
# The pinned step's own downloads and package manager: markers, never the network or a package.
download_file() {
  : > "$HOME/stand-in-fallback-fetched"
  sleep 20
  return 1
}
install_alpine_node() {
  : > "$HOME/stand-in-package-manager-reached"
  emit_json step name node status ok method apk
}
# The shared /tmp: a marker, and a folder in the stand-in's own home instead.
mktemp() {
  local last="\${!#}"
  if [[ "$last" == /tmp/openclaw-* ]]; then
    : > "$HOME/stand-in-tmp-fallback"
    mkdir -p "$HOME/stand-in-shared-tmp"
    command mktemp -d "$HOME/stand-in-shared-tmp/openclaw-install.XXXXXX"
    return
  fi
  command mktemp "$@"
}
linked_node_is_usable() {
  [[ "$SCENARIO" != "node-unusable" ]] || return 1
  if [[ "$SCENARIO" == "node-second-check-fails" && "\${OPENCLAW_INSTALL_CLI_SH_NO_RUN:-0}" != "1" ]]; then
    return 1
  fi
  [[ -x "$PREFIX/tools/node-v$NODE_VERSION/bin/node" ]]
}
@INSTALL_NODE@
@PREPARE_TMPDIR@
main() {
  local tgz=""
  printf 'install-cli %s\\n' "$*" >> "$HOME/stand-in-calls.log"
  env | LC_ALL=C sort > "$HOME/stand-in-installer-env"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prefix) PREFIX="$2"; shift 2 ;;
      --version) tgz="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$SCENARIO" == "node-start" ]]; then
    emit_json step name node status start version "$NODE_VERSION"
    sleep 20
    exit 0
  fi
  [[ "$SCENARIO" != "tmp-unusable" ]] || TMPDIR="$TMPDIR/not-there"
  prepare_tmpdir
  [[ "$TMPDIR" == "$PREFIX"/tmp/openclaw-install.* ]] || : > "$HOME/stand-in-tmp-elsewhere"
  if [[ "$SCENARIO" == "alpine" ]]; then
    mkdir -p "$PREFIX/bin"
    printf '#!/bin/sh\\nexit 0\\n' > "$PREFIX/bin/apk"
    chmod 755 "$PREFIX/bin/apk"
  fi
  install_node "$(os_detect)" "$(arch_detect)"
  emit_json step name openclaw status start version "$tgz"
  printf 'added 345 packages\\n'
  if [[ "$SCENARIO" == "descendant" ]]; then
    ( sleep 3; mkdir -p "$PREFIX/late"; : > "$HOME/stand-in-late" ) &
  fi
  if [[ "$SCENARIO" == "installer-fails" || "$SCENARIO" == "descendant" ]]; then
    emit_json error message "npm install did not produce a usable OpenClaw package"
    exit 1
  fi
  local package="$PREFIX/tools/node-v$NODE_VERSION/lib/node_modules/openclaw"
  local unpacked
  unpacked="$(mktemp -d)"
  tar -xzf "$tgz" -C "$unpacked" package/dist/entry.js package/dist/index.js
  mkdir -p "$package/dist"
  cp "$unpacked/package/dist/entry.js" "$unpacked/package/dist/index.js" "$package/dist/"
  rm -rf "$unpacked"
  [[ "$SCENARIO" != "wrong-program" ]] || printf '# changed\\n' >> "$package/dist/entry.js"
  mkdir -p "$PREFIX/bin"
  printf '#!/usr/bin/env bash\\nset -euo pipefail\\nexec %q %q "$@"\\n' "$PREFIX/tools/node/bin/node" "$package/dist/entry.js" > "$PREFIX/bin/openclaw"
  chmod 755 "$PREFIX/bin/openclaw"
  emit_json step name openclaw status ok
  emit_json step name gateway-service status skip reason runtime-only
  if [[ "$SCENARIO" == "state-before-onboard" ]]; then
    mkdir -p "$HOME/.openclaw-clawtrate"
    printf "someone's\\n" > "$HOME/.openclaw-clawtrate/keep-me"
  fi
  if [[ "$SCENARIO" == "service-before-onboard" ]]; then
    mkdir -p "\${SERVICE_FILE%/*}"
    printf "someone's\\n" > "$SERVICE_FILE"
  fi
  printf '%s\\n' '{"event":"done","ok":true,"version":"OpenClaw 2026.10.6 (fe06181)"}'
}
SERVICE_FILE="@SERVICE_FILE@"
if [[ "\${OPENCLAW_INSTALL_CLI_SH_NO_RUN:-0}" != "1" ]]; then
  main "$@"
fi
`;

/**
 * The stand-in `openclaw` (the tarball's `dist/entry.js`, run by the stand-in
 * `node`), for the `clawtrate` profile only. Onboarding writes the profile's
 * config and refuses to install a service; `gateway install` registers the
 * service with the stand-in manager and writes its file in the real format,
 * never replacing one.
 */
const OPENCLAW = `#!/bin/bash
SCENARIO="@SCENARIO@"
PLATFORM="@PLATFORM@"
SERVICE_FILE="@SERVICE_FILE@"
ENTRY="$0"
NODE="\${ENTRY%/lib/node_modules/openclaw/dist/entry.js}/bin/node"
# OpenClaw's service starts the package's gateway entrypoint, beside entry.js.
INDEX="\${ENTRY%entry.js}index.js"
printf 'openclaw %s\\n' "$*" >> "$HOME/stand-in-calls.log"
[[ "$1" == "--profile" && "$2" == "clawtrate" ]] || exit 64
shift 2
case "$1" in
  onboard)
    port=""
    for arg in "$@"; do
      # OpenClaw's onboarding service install is the path that reaches its lingering helper.
      [[ "$arg" == "--install-daemon" ]] && { : > "$HOME/stand-in-linger-reached"; exit 99; }
    done
    while [[ $# -gt 0 ]]; do
      [[ "$1" == "--gateway-port" ]] && port="$2"
      shift
    done
    printf '%s' "$port" > "$HOME/stand-in-port"
    if [[ "$SCENARIO" == "onboard-fails" ]]; then
      printf '%s\\n' '{"ok":false,"phase":"gateway","message":"redacted","classification":"startup-blocked","hints":[]}'
      exit 1
    fi
    mkdir -p "$HOME/.openclaw-clawtrate"
    printf '{"gateway":{"port":%s}}\\n' "$port" > "$HOME/.openclaw-clawtrate/openclaw.json"
    if [[ "$SCENARIO" == "service-after-onboard" ]]; then
      mkdir -p "\${SERVICE_FILE%/*}"
      printf "someone's\\n" > "$SERVICE_FILE"
    fi
    printf '{"ok":true,"mode":"local","authChoice":"skip","gateway":{"port":%s,"bind":"loopback","authMode":"token","tailscaleMode":"off"},"installDaemon":false,"skipHealth":true}\\n' "$port"
    ;;
  gateway)
    port="$(cat "$HOME/stand-in-port")"
    if [[ "$2" == "install" ]]; then
      if [[ -e "$SERVICE_FILE" || -e "$HOME/stand-in-loaded" ]]; then
        printf '%s\\n' '{"ok":true,"action":"install","result":"already-installed"}'
        exit 0
      fi
      if [[ "$SCENARIO" == "service-fails" && ! -e "$HOME/stand-in-service-failed" ]]; then
        : > "$HOME/stand-in-service-failed"
        printf '%s\\n' '{"ok":false,"action":"install","error":"redacted"}'
        exit 1
      fi
      mkdir -p "\${SERVICE_FILE%/*}"
      if [[ "$SCENARIO" == "service-during-install" ]]; then
        # Another program's definition, written in the moment between the host's check and this call.
        if [[ "$PLATFORM" == "darwin" ]]; then
          printf '<plist version="1.0"><dict><key>Label</key><string>ai.openclaw.clawtrate</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array></dict></plist>\\n' > "$SERVICE_FILE"
        else
          printf '[Service]\\nExecStart=/usr/bin/true\\n' > "$SERVICE_FILE"
        fi
        : > "$HOME/stand-in-loaded"
        printf '%s\\n' '{"ok":true,"action":"install","result":"installed","service":{"label":"stand-in","loaded":true}}'
        exit 0
      fi
      if [[ "$PLATFORM" == "darwin" ]]; then
        printf '<?xml version="1.0" encoding="UTF-8"?>\\n<plist version="1.0">\\n  <dict>\\n    <key>Label</key>\\n    <string>ai.openclaw.clawtrate</string>\\n    <key>RunAtLoad</key>\\n    <true/>\\n    <key>ProgramArguments</key>\\n    <array>\\n      <string>/bin/sh</string>\\n      <string>%s</string>\\n      <string>%s</string>\\n      <string>%s</string>\\n      <string>--max-old-space-size=4096</string>\\n      <string>%s</string>\\n      <string>gateway</string>\\n      <string>--port</string>\\n      <string>%s</string>\\n    </array>\\n  </dict>\\n</plist>\\n' "$HOME/.openclaw-clawtrate/service-env/ai.openclaw.clawtrate-env-wrapper.sh" "$HOME/.openclaw-clawtrate/service-env/ai.openclaw.clawtrate.env" "$NODE" "$INDEX" "$port" > "$SERVICE_FILE"
      else
        printf '[Unit]\\nDescription=OpenClaw Gateway\\n\\n[Service]\\nExecStart="%s" --max-old-space-size=4096 "%s" gateway --port %s\\nRestart=always\\n\\n[Install]\\nWantedBy=default.target\\n' "$NODE" "$INDEX" "$port" > "$SERVICE_FILE"
      fi
      : > "$HOME/stand-in-loaded"
      printf 'register clawtrate %s\\n' "$port" >> "$HOME/stand-in-service-manager.log"
      printf '%s\\n' '{"ok":true,"action":"install","result":"installed","service":{"label":"stand-in","loaded":true}}'
      exit 0
    fi
    ok=true
    [[ "$SCENARIO" == "not-answering" ]] && ok=false
    printf '{"service":{"label":"LaunchAgent","loaded":true},"gateway":{"version":"2026.10.6","bindMode":"loopback","port":%s},"rpc":{"ok":%s}}\\n' "$port" "$ok"
    ;;
  *) exit 64 ;;
esac
`;

/** The stand-in `node`: its version, or the stand-in `openclaw` it is asked to run. */
const NODE = `#!/bin/bash
if [[ "$1" == "-v" || "$1" == "--version" ]]; then echo v${NODE_VERSION}; exit 0; fi
exec /bin/bash "$@"
`;
const NPM = `#!/bin/sh
echo 11.0.0
`;

/** The stand-in service manager: what a real one says about the `clawtrate` job or unit and the user manager. */
const MANAGER = `#!/bin/bash
SCENARIO="@SCENARIO@"
printf 'manager %s\\n' "$*" >> "$HOME/stand-in-manager.log"
loaded=false
[[ -e "$HOME/stand-in-loaded" || "$SCENARIO" == "loaded-elsewhere" ]] && loaded=true
if [[ "$1" == "print" ]]; then
  $loaded && { echo "state = running"; exit 0; }
  echo "Could not find service"
  exit 113
fi
if [[ "$1 $2" == "--user show" ]]; then
  if [[ "$SCENARIO" == "no-user-manager" ]]; then echo "Failed to connect to bus" >&2; exit 1; fi
  if [[ "$3" == "--property=Version" ]]; then echo "255"; exit 0; fi
  $loaded && echo loaded || echo not-found
  exit 0
fi
exit 64
`;

export type StandIn = {
  root: string;
  home: string;
  appData: string;
  place: InstallPlace;
  pins: InstallPins;
  /** The paths the loopback server was asked for, in order. */
  requests: string[];
  /** Lines of `stand-in-calls.log`: every installer and `openclaw` run. */
  calls(): string[];
  /** What the stand-in service manager was asked to register. */
  registered(): string[];
  /** What the stand-in service manager was asked. */
  manager(): string[];
  /** The installer's environment, one `KEY=value` per line. */
  installerEnv(): string[];
  /** Whether a stand-in wrote this marker into the home: `linger-reached`, `fallback-fetched`, `late`. */
  marked(name: string): boolean;
  close(): Promise<void>;
};

function sh(file: string, content: string): void {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/** How the loopback server answers one download. */
export type Serve = "ok" | "missing" | "redirect" | "partial" | "short";

/**
 * A temporary root with a home, an app-data folder and the two stand-in
 * downloads, served from loopback. `pins` names their real hashes unless
 * `wrong` asks for one that doesn't match; `serve` changes how one of them is
 * answered.
 */
export type StandInOptions = {
  scenario?: StandInScenario;
  platform?: "darwin" | "linux";
  wrong?: "openclaw" | "node";
  serve?: { name: "openclaw" | "node"; as: Serve };
};

export async function standIn(options: StandInOptions = {}): Promise<StandIn> {
  const root = mkdtempSync(join(tmpdir(), "clawtrate-install-"));
  try {
    return await makeStandIn(root, options);
  } catch (error) {
    // A stand-in that couldn't be made leaves nothing behind.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function makeStandIn(root: string, options: StandInOptions): Promise<StandIn> {
  const scenario = options.scenario ?? "ok";
  const platform = options.platform ?? "darwin";
  const target: InstallTarget = platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const home = join(root, "home");
  const appData = join(root, "App Data");
  const served = join(root, "served");
  const tools = join(root, "tools");
  for (const dir of [home, appData, served, tools]) mkdirSync(dir, { recursive: true });
  const manager = join(tools, "service-manager");
  sh(manager, MANAGER.replace("@SCENARIO@", scenario));
  const place = standInPlace({ home, appData, platform, target, serviceManager: manager });

  // The npm tarball: package/scripts/install-cli.sh and install-policy.sh, and the stand-in program.
  const pkg = join(root, "pkg", "package");
  mkdirSync(join(pkg, "scripts"), { recursive: true });
  mkdirSync(join(pkg, "dist"), { recursive: true });
  const installNode =
    scenario === "installer-unpatchable"
      ? pinned("install_node").replace("    return\n", "    return 0\n")
      : pinned("install_node");
  sh(
    join(pkg, "scripts", "install-cli.sh"),
    INSTALLER.replace("@SCENARIO@", scenario)
      .replace("@PLATFORM@", platform)
      .replace("@SERVICE_FILE@", place.serviceFile)
      .replace("@INSTALL_NODE@\n", installNode)
      .replace("@PREPARE_TMPDIR@\n", pinned("prepare_tmpdir")),
  );
  sh(join(pkg, "scripts", "install-policy.sh"), "# stand-in policy\n");
  sh(
    join(pkg, "dist", "entry.js"),
    OPENCLAW.replace("@SCENARIO@", scenario)
      .replace("@PLATFORM@", platform)
      .replace("@SERVICE_FILE@", place.serviceFile),
  );
  writeFileSync(join(pkg, "dist", "index.js"), "// the stand-in's gateway entrypoint\n");
  writeFileSync(join(pkg, "package.json"), '{"name":"openclaw","version":"2026.10.6"}\n');
  execFileSync("/usr/bin/tar", [
    "-czf",
    join(served, "openclaw.tgz"),
    "-C",
    join(root, "pkg"),
    "package",
  ]);

  // Node.js: node-v24.22.1-<target>/bin/node and npm.
  const nodeTop = `node-v${NODE_VERSION}-${target}`;
  const nodeDir = join(root, "node", nodeTop, "bin");
  mkdirSync(nodeDir, { recursive: true });
  sh(join(nodeDir, "node"), NODE);
  sh(join(nodeDir, "npm"), NPM);
  execFileSync("/usr/bin/tar", [
    "-czf",
    join(served, "node.tgz"),
    "-C",
    join(root, "node"),
    nodeTop,
  ]);

  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "";
    requests.push(path);
    const name =
      path === "/openclaw.tgz" || path === "/redirected-openclaw.tgz"
        ? "openclaw"
        : path === "/node.tgz" || path === "/redirected-node.tgz"
          ? "node"
          : null;
    const how =
      options.serve?.name === name && !path.startsWith("/redirected-") ? options.serve.as : "ok";
    if (!name || how === "missing") {
      response.writeHead(404).end();
      return;
    }
    const body = readFileSync(join(served, `${name}.tgz`));
    if (how === "redirect") {
      // Another path on the same loopback, which answers: never asked for.
      const port = (server.address() as { port: number }).port;
      response
        .writeHead(302, { location: `http://127.0.0.1:${port}/redirected-${name}.tgz` })
        .end();
      return;
    }
    if (how === "partial") {
      response.writeHead(206, { "content-type": "application/octet-stream" });
      response.end(body);
      return;
    }
    if (how === "short") {
      // Declares the whole length and ends early.
      response.writeHead(200, { "content-length": String(body.length) });
      response.write(body.subarray(0, Math.floor(body.length / 2)), () =>
        response.socket?.destroy(),
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(body);
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const tarball = readFileSync(join(served, "openclaw.tgz"));
  const node = readFileSync(join(served, "node.tgz"));
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const sha256 = createHash("sha256").update(node).digest("hex");
  const flip = (hex: string) => (hex.startsWith("0") ? `1${hex.slice(1)}` : `0${hex.slice(1)}`);
  const nodePin = {
    url: `${base}/node.tgz`,
    sha256: options.wrong === "node" ? flip(sha256) : sha256,
  };
  const pins: InstallPins = {
    version: "2026.10.6",
    openclaw: {
      url: `${base}/openclaw.tgz`,
      integrity: options.wrong === "openclaw" ? `sha512-${"A".repeat(86)}==` : integrity,
    },
    nodeVersion: NODE_VERSION,
    node: {
      "darwin-arm64": nodePin,
      "darwin-x64": nodePin,
      "linux-arm64": nodePin,
      "linux-x64": nodePin,
    },
  };

  return {
    root,
    home,
    appData,
    place,
    pins,
    requests,
    calls: () => read(join(home, "stand-in-calls.log")),
    registered: () => read(join(home, "stand-in-service-manager.log")),
    manager: () => read(join(home, "stand-in-manager.log")),
    installerEnv: () => read(join(home, "stand-in-installer-env")),
    marked: (name) => {
      try {
        readFileSync(join(home, `stand-in-${name}`));
        return true;
      } catch {
        return false;
      }
    },
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
