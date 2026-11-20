// Stand-ins for setting OpenClaw up (docs/design/setup.md §19): the two
// downloads served from this computer's loopback out of a temporary folder,
// an npm tarball whose `install-cli.sh` and `openclaw` are scripts of ours,
// a Node.js tarball whose `node` and `npm` only print versions, and a
// stand-in service manager that records what would be registered. Nothing
// here runs OpenClaw or its installer, and everything is written under a
// temporary home outside the account's.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallPins, InstallTarget } from "../../src/setup/install-pins.ts";
import { standInPlace, type InstallPlace } from "../../src/setup/install.ts";

/** How the stand-ins behave: each a failure the install must name, or the whole way through. */
export type StandInScenario =
  | "ok"
  /** The installer's own Node.js check refuses the checked runtime. */
  | "node-unusable"
  /** The installer starts downloading Node.js itself instead of using the checked one. */
  | "node-start"
  | "installer-fails"
  | "onboard-fails"
  | "onboard-no-daemon"
  | "not-answering";

const NODE_VERSION = "24.22.1";

/** The stand-in `install-cli.sh`: sourced, it runs nothing; run, it plays its scenario. */
const INSTALLER = `#!/usr/bin/env bash
set -euo pipefail
SCENARIO="@SCENARIO@"
here="\${BASH_SOURCE[0]%/*}"
source "$here/install-policy.sh"
PREFIX="\${HOME}/.openclaw"
NODE_VERSION="${NODE_VERSION}"
linked_node_is_usable() {
  [[ "$SCENARIO" != "node-unusable" ]] || return 1
  [[ -x "$PREFIX/tools/node-v$NODE_VERSION/bin/node" ]]
}
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
    printf '%s\\n' '{"event":"step","name":"node","status":"start","version":"${NODE_VERSION}"}'
    sleep 20
    exit 0
  fi
  if linked_node_is_usable; then
    ln -sfn "$PREFIX/tools/node-v$NODE_VERSION" "$PREFIX/tools/node"
    printf '{"event":"step","name":"node","status":"skip","path":"%s"}\\n' "$PREFIX/tools/node-v$NODE_VERSION"
  fi
  printf '{"event":"step","name":"openclaw","status":"start","version":"%s"}\\n' "$tgz"
  printf 'added 345 packages\\n'
  if [[ "$SCENARIO" == "installer-fails" ]]; then
    printf '%s\\n' '{"event":"error","message":"npm install did not produce a usable OpenClaw package"}'
    exit 1
  fi
  mkdir -p "$PREFIX/bin"
  cat > "$PREFIX/bin/openclaw" <<'STAND_IN_OPENCLAW'
@OPENCLAW@STAND_IN_OPENCLAW
  chmod 755 "$PREFIX/bin/openclaw"
  printf '%s\\n' '{"event":"step","name":"openclaw","status":"ok"}'
  printf '%s\\n' '{"event":"step","name":"gateway-service","status":"skip","reason":"runtime-only"}'
  printf '%s\\n' '{"event":"done","ok":true,"version":"OpenClaw 2026.10.6 (fe06181)"}'
}
if [[ "\${OPENCLAW_INSTALL_CLI_SH_NO_RUN:-0}" != "1" ]]; then
  main "$@"
fi
`;

/**
 * The stand-in `openclaw`, for the `clawtrate` profile only. Onboarding makes
 * the profile's state folder and asks the stand-in service manager to
 * register the service, which records it and writes the service file.
 */
const OPENCLAW = `#!/bin/bash
SCENARIO="@SCENARIO@"
SERVICE_FILE="@SERVICE_FILE@"
printf 'openclaw %s\\n' "$*" >> "$HOME/stand-in-calls.log"
[[ "$1" == "--profile" && "$2" == "clawtrate" ]] || exit 64
shift 2
case "$1" in
  onboard)
    port=""
    while [[ $# -gt 0 ]]; do
      [[ "$1" == "--gateway-port" ]] && port="$2"
      shift
    done
    printf '%s' "$port" > "$HOME/stand-in-port"
    if [[ "$SCENARIO" == "onboard-fails" ]]; then
      printf '%s\\n' '{"ok":false,"phase":"gateway","message":"redacted","classification":"startup-blocked","hints":[]}'
      exit 1
    fi
    if [[ "$SCENARIO" == "onboard-no-daemon" ]]; then
      mkdir -p "$HOME/.openclaw-clawtrate"
      printf '{"ok":false,"gateway":{"port":%s,"bind":"loopback","authMode":"token"},"daemonInstall":{"requested":true,"installed":false,"skippedReason":"systemd-user-unavailable"}}\\n' "$port"
      exit 1
    fi
    mkdir -p "$HOME/.openclaw-clawtrate" "\${SERVICE_FILE%/*}"
    printf 'register clawtrate %s\\n' "$port" >> "$HOME/stand-in-service-manager.log"
    printf 'stand-in service for port %s\\n' "$port" > "$SERVICE_FILE"
    printf '{"ok":true,"mode":"local","authChoice":"skip","gateway":{"port":%s,"bind":"loopback","authMode":"token","tailscaleMode":"off"},"installDaemon":true,"daemonInstall":{"requested":true,"installed":true}}\\n' "$port"
    ;;
  gateway)
    port="$(cat "$HOME/stand-in-port")"
    ok=true
    [[ "$SCENARIO" == "not-answering" ]] && ok=false
    printf '{"service":{"label":"LaunchAgent","loaded":true},"gateway":{"version":"2026.10.6","bindMode":"loopback","port":%s},"rpc":{"ok":%s}}\\n' "$port" "$ok"
    ;;
  *) exit 64 ;;
esac
`;

const NODE = `#!/bin/sh
echo v${NODE_VERSION}
`;
const NPM = `#!/bin/sh
echo 11.0.0
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
  /** The installer's environment, one `KEY=value` per line. */
  installerEnv(): string[];
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

/**
 * A temporary root with a home, an app-data folder and the two stand-in
 * downloads, served from loopback. `pins` names their real hashes unless
 * `wrong` asks for one that doesn't match; `missing` serves a 404 for one.
 */
export async function standIn(
  options: {
    scenario?: StandInScenario;
    platform?: "darwin" | "linux";
    wrong?: "openclaw" | "node";
    missing?: "openclaw" | "node";
  } = {},
): Promise<StandIn> {
  const scenario = options.scenario ?? "ok";
  const platform = options.platform ?? "darwin";
  const target: InstallTarget = platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const root = mkdtempSync(join(tmpdir(), "clawtrate-install-"));
  const home = join(root, "home");
  const appData = join(root, "app-data");
  const served = join(root, "served");
  for (const dir of [home, appData, served]) mkdirSync(dir, { recursive: true });
  const place = standInPlace({ home, appData, platform, target });

  // The npm tarball: package/scripts/install-cli.sh and install-policy.sh, and the stand-in program.
  const pkg = join(root, "pkg", "package");
  mkdirSync(join(pkg, "scripts"), { recursive: true });
  mkdirSync(join(pkg, "dist"), { recursive: true });
  const program = OPENCLAW.replace("@SCENARIO@", scenario).replace(
    "@SERVICE_FILE@",
    place.serviceFile,
  );
  sh(
    join(pkg, "scripts", "install-cli.sh"),
    INSTALLER.replace("@SCENARIO@", scenario).replace("@OPENCLAW@", program),
  );
  sh(join(pkg, "scripts", "install-policy.sh"), "# stand-in policy\n");
  writeFileSync(join(pkg, "dist", "entry.js"), "// stand-in\n");
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
    const name = path === "/openclaw.tgz" ? "openclaw" : path === "/node.tgz" ? "node" : null;
    if (!name || options.missing === name) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(readFileSync(join(served, `${name}.tgz`)));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
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
    installerEnv: () => read(join(home, "stand-in-installer-env")),
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
