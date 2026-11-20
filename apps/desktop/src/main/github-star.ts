import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  readlinkSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { dirname, join, parse, resolve, sep, win32 } from "node:path";

export function installLocations(platform = process.platform, env = process.env): string[] {
  if (platform === "darwin")
    return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/opt/local/bin/gh"];
  if (platform !== "win32") return [];
  const systemDrive = win32.parse(env.SystemRoot ?? "").root.toLowerCase();
  const roots: [string | undefined, ...string[]][] = [
    [env.ProgramFiles, "GitHub CLI"],
    [env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"],
  ];
  return roots.flatMap(([root, ...parts]) =>
    root &&
    /^[a-z]:\\/i.test(root) &&
    win32.parse(root).root.toLowerCase() === systemDrive &&
    !root.split(/[\\/]/).includes("..")
      ? [win32.join(root, ...parts, "gh.exe")]
      : [],
  );
}

function localPath(path: string): boolean {
  if (process.platform === "win32")
    return (
      /^[a-z]:\\/i.test(path) &&
      parse(path).root.toLowerCase() === parse(process.env.SystemRoot ?? "").root.toLowerCase()
    );
  return path.startsWith("/") && !/^\/(?:\/|(?:Volumes|Network|net|automount)(?:\/|$))/.test(path);
}

// Inspect links before following them, including links in the parent directories.
function canonicalFile(path: string, links = 0): string | null {
  if (!localPath(path) || links > 40) return null;
  const { root } = parse(path);
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      const target = readlinkSync(current);
      if (target.startsWith("//") || target.startsWith("\\\\")) return null;
      return canonicalFile(resolve(dirname(current), target, ...parts.slice(i + 1)), links + 1);
    }
  }
  return current;
}

type Installation = { listed: string; path: string; file: BigIntStats };

export function findGitHubCli(locations = installLocations()): Installation | null {
  for (const listed of locations) {
    try {
      const path = canonicalFile(listed);
      if (!path || (process.platform === "win32" && !path.toLowerCase().endsWith(".exe"))) continue;
      const file = statSync(path, { bigint: true });
      if (!file.isFile()) continue;
      accessSync(path, constants.X_OK);
      return { listed, path, file };
    } catch {
      // Try the next standard installation.
    }
  }
  return null;
}

const args = [
  "api",
  "--method",
  "PUT",
  "/user/starred/sidebandstudio/clawtrate",
  "--hostname",
  "github.com",
  "--silent",
  "--include",
];
let running = false;

export async function starRepository(cli: Installation | null, timeout = 8000): Promise<boolean> {
  if (!cli || running) return false;
  const current = findGitHubCli([cli.listed]);
  if (
    !current ||
    current.path !== cli.path ||
    current.file.dev !== cli.file.dev ||
    current.file.ino !== cli.file.ino ||
    current.file.ctimeNs !== cli.file.ctimeNs ||
    current.file.mtimeNs !== cli.file.mtimeNs ||
    current.file.size !== cli.file.size
  )
    return false;
  const env: NodeJS.ProcessEnv = {
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_TELEMETRY: "0",
  };
  for (const name of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "SystemRoot",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
  ]) {
    const value = process.env[name];
    if (!value) continue;
    if (!localPath(value)) return false;
    env[name] = value;
  }
  running = true;
  try {
    const child = spawn(cli.path, args, {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
    return await new Promise<boolean>((answer) => {
      let status = "";
      let noContent = false;
      let failed = false;
      const readStatus = () => {
        const available = Math.min(child.stdout.readableLength, 4096 - status.length);
        if (!available) return;
        const prefix = child.stdout.read(available) as Buffer;
        const lf = prefix.indexOf(10);
        status += prefix.subarray(0, lf < 0 ? prefix.length : lf).toString("latin1");
        if (lf >= 0 || status.length === 4096) {
          noContent = lf >= 0 && /^HTTP\/\d+\.\d+ 204(?: [^\r\n]*)?\r?$/.test(status);
          status = "";
          child.stdout.off("readable", readStatus);
          // Drain the pipe without delivering any more output to the app.
          child.stdout.resume();
        }
      };
      child.stdout.on("readable", readStatus);
      const timer = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
      }, timeout);
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        answer(!failed && code === 0 && noContent);
      });
    });
  } catch {
    return false;
  } finally {
    running = false;
  }
}
