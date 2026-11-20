import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";

type DirectoryIdentity = {
  dev: bigint;
  ino: bigint;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/** An NTFS short name identifies the same directory entry. A junction does not. */
export async function checkWindowsDirectorySpelling(
  path: string,
  canonical: string,
  inspect: (path: string) => Promise<DirectoryIdentity> = (path) => lstat(path, { bigint: true }),
): Promise<void> {
  path = win32.resolve(path);
  canonical = win32.resolve(canonical);
  while (path !== canonical) {
    const [entry, actual] = await Promise.all([inspect(path), inspect(canonical)]);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      !entry.ino ||
      entry.dev !== actual.dev ||
      entry.ino !== actual.ino
    )
      throw Error("Linked update directory");
    const parent = win32.dirname(path);
    const canonicalParent = win32.dirname(canonical);
    if (parent === path || canonicalParent === canonical) {
      if (
        parent === path &&
        canonicalParent === canonical &&
        path.toLowerCase() === canonical.toLowerCase()
      )
        return;
      throw Error("Different update directory roots");
    }
    path = parent;
    canonical = canonicalParent;
  }
}

/** Validate every parent before removing anything or creating an offer's directory. */
async function checkParents(root: string): Promise<void> {
  const parent = resolve(dirname(root));
  // Darwin installs /tmp and /var as root-owned links to these system directories.
  const expected =
    process.platform === "darwin" ? parent.replace(/^\/(tmp|var)(\/|$)/, "/private/$1$2") : parent;
  const canonical = await realpath(parent);
  if (process.platform === "win32") await checkWindowsDirectorySpelling(parent, canonical);
  else if (canonical !== expected) throw Error("Linked update directory");
  for (let current = canonical; ; current = dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Invalid update directory");
    if (process.getuid) {
      const uid = process.getuid();
      const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
      if (
        (current === canonical && info.uid !== uid) ||
        (info.uid !== uid && info.uid !== 0) ||
        ((info.mode & 0o022) !== 0 && !stickyRoot)
      )
        throw Error("Unsafe update directory");
    }
    if (dirname(current) === current) return;
  }
}

export async function clearUpdateDirectory(root: string): Promise<void> {
  await checkParents(root);
  // rm removes a link at root itself without following it.
  await rm(root, { recursive: true, force: true });
}

async function makePrivateDirectory(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await mkdir(path, { mode: 0o700 });
    return;
  }
  // Windows ignores POSIX mode bits. Create the directory with a protected
  // DACL so the artifact inherits just the current user's full-control rule.
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=$env:CLAWTRATE_PRIVATE_DIRECTORY",
    "if ([IO.Directory]::Exists($p) -or [IO.File]::Exists($p)) {throw 'Directory exists'}",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl=New-Object Security.AccessControl.DirectorySecurity",
    "$acl.SetOwner($sid)",
    "$acl.SetAccessRuleProtection($true,$false)",
    "$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
    "$acl.AddAccessRule($rule)",
    "$dir=[IO.Directory]::CreateDirectory($p,$acl)",
    "$actual=$dir.GetAccessControl()",
    "$rules=$actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])",
    "if (!$actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl' -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Directory permissions refused'}",
  ].join("\n");
  await runUpdatePowerShell(script, { CLAWTRATE_PRIVATE_DIRECTORY: path }, 15000);
}

/** Keep the compiler, module loader and command interpreter inside the OS installation. */
export function updatePowerShellEnvironment(systemRoot: string, profile: NodeJS.ProcessEnv) {
  const system = win32.join(systemRoot, "System32");
  const env: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: win32.parse(systemRoot).root.slice(0, 2),
    PATH: system,
    ComSpec: win32.join(system, "cmd.exe"),
    PSModulePath: win32.join(system, "WindowsPowerShell", "v1.0", "Modules"),
  };
  for (const key of [
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "TEMP",
    "TMP",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
  ]) {
    if (profile[key] !== undefined) env[key] = profile[key];
  }
  return env;
}

export function runUpdatePowerShell(
  script: string,
  values: Record<string, string>,
  timeout: number,
  signal?: AbortSignal,
) {
  // The kernel's SystemRoot link cannot be redirected by the app's environment.
  const root = realpathSync.native(String.raw`\\?\GLOBALROOT\SystemRoot`);
  const system = win32.join(root, "System32");
  const shell = win32.join(system, "WindowsPowerShell", "v1.0", "powershell.exe");
  return promisify(execFile)(
    shell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      cwd: system,
      env: { ...updatePowerShellEnvironment(root, process.env), ...values },
      ...(signal && { signal }),
      windowsHide: true,
      timeout,
    },
  );
}

/** Both directories must be fresh. Never reopen a destination left by another offer. */
export async function prepareUpdateDirectory(root: string, offerId: string): Promise<void> {
  await checkParents(root);
  await makePrivateDirectory(root);
  await makePrivateDirectory(join(root, offerId));
}
