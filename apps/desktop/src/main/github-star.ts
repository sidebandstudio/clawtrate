import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Discovery never starts the CLI. Ignore relative PATH entries and shell wrappers. */
export function findGitHubCli(env = process.env, platform = process.platform): string | null {
  const dirs = (env.PATH ?? "").split(delimiter);
  if (platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin");
  if (platform === "win32") {
    if (env.ProgramFiles) dirs.push(join(env.ProgramFiles, "GitHub CLI"));
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
  }
  for (const dir of dirs.filter(isAbsolute)) {
    const path = join(dir, platform === "win32" ? "gh.exe" : "gh");
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      // Try the next installation directory.
    }
  }
  return null;
}

export function starRepository(path: string | null, timeout = 8000): Promise<boolean> {
  if (!path) return Promise.resolve(false);
  const env: NodeJS.ProcessEnv = {
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  };
  for (const name of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "SystemRoot",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return new Promise((resolve) => {
    const child = spawn(
      path,
      [
        "api",
        "--method",
        "PUT",
        "/user/starred/sidebandstudio/clawtrate",
        "--hostname",
        "github.com",
        "--silent",
      ],
      {
        env,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, timeout);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
