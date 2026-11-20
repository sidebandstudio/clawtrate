import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

/** Validate every parent before removing anything or creating an offer's directory. */
async function checkParents(root: string): Promise<void> {
  const parent = resolve(dirname(root));
  // Darwin installs /tmp and /var as root-owned links to these system directories.
  const expected =
    process.platform === "darwin" ? parent.replace(/^\/(tmp|var)(\/|$)/, "/private/$1$2") : parent;
  const canonical = await realpath(parent);
  if (
    process.platform === "win32"
      ? canonical.toLowerCase() !== expected.toLowerCase()
      : canonical !== expected
  ) {
    throw Error("Linked update directory");
  }
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
  const shell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
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
  await promisify(execFile)(
    shell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, CLAWTRATE_PRIVATE_DIRECTORY: path },
      windowsHide: true,
      timeout: 15000,
    },
  );
}

/** Both directories must be fresh. Never reopen a destination left by another offer. */
export async function prepareUpdateDirectory(root: string, offerId: string): Promise<void> {
  await checkParents(root);
  await makePrivateDirectory(root);
  await makePrivateDirectory(join(root, offerId));
}
