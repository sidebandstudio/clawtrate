// What the launch check needs to ask Windows about processes, through
// PowerShell, which every Windows has. Used only when the check runs there.
import { execFileSync } from "node:child_process";

export type WindowsProcess = { pid: number; ppid: number; command: string };

function powershell(script: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Every process with its parent and full command line, as Windows reports them. */
export function windowsProcesses(): WindowsProcess[] {
  const out = powershell(
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress",
  );
  const rows = JSON.parse(out) as {
    ProcessId: number;
    ParentProcessId: number;
    CommandLine: string | null;
  }[];
  return rows.map((row) => ({
    pid: row.ProcessId,
    ppid: row.ParentProcessId,
    command: row.CommandLine ?? "",
  }));
}

/** The title of the process's main window, as the window manager has it, or "" if it has none. */
export function mainWindowTitle(pid: number): string {
  return powershell(`(Get-Process -Id ${Number(pid)}).MainWindowTitle`).trim();
}

/**
 * The mandatory integrity level of each process's token, as Windows reports
 * it: 0 is untrusted, 4096 low, 8192 medium. Chromium starts a sandboxed
 * renderer with a restricted token at untrusted integrity, and its main
 * process at the user's own level. One call for all, because PowerShell
 * compiles the small C# helper each time, and the first compile on a machine
 * can take tens of seconds while the antivirus looks at it.
 */
export function integrityLevels(pids: number[]): Map<number, number> {
  const script = `
Add-Type -Namespace ClawtrateCheck -Name Token -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
[DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
[DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
[DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
[DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
public static int Level(int pid) {
  IntPtr process = OpenProcess(0x1000, false, pid);
  if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
  IntPtr token;
  if (!OpenProcessToken(process, 0x8, out token)) throw new System.ComponentModel.Win32Exception();
  int length;
  GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
  IntPtr info = System.Runtime.InteropServices.Marshal.AllocHGlobal(length);
  try {
    if (!GetTokenInformation(token, 25, info, length, out length)) throw new System.ComponentModel.Win32Exception();
    IntPtr sid = System.Runtime.InteropServices.Marshal.ReadIntPtr(info);
    int count = System.Runtime.InteropServices.Marshal.ReadByte(GetSidSubAuthorityCount(sid));
    return System.Runtime.InteropServices.Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
  } finally {
    System.Runtime.InteropServices.Marshal.FreeHGlobal(info);
    CloseHandle(token);
    CloseHandle(process);
  }
}
'@
foreach ($id in @(${pids.map(Number).join(", ")})) { "$id $([ClawtrateCheck.Token]::Level($id))" }`;
  return new Map(
    powershell(script)
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().split(" ").map(Number) as [number, number]),
  );
}

/**
 * Asks a process to close its windows, as the system does at sign-out; never
 * forces it. Returns taskkill's complaint if the request could not be sent.
 */
export function askToClose(pid: number): string | null {
  try {
    execFileSync("taskkill.exe", ["/PID", String(Number(pid))], { stdio: "pipe" });
    return null;
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr ?? error).trim();
  }
}

/** Ends a process and its children by PID, for cleanup after a failure only. */
export function forceEnd(pid: number): void {
  try {
    execFileSync("taskkill.exe", ["/F", "/T", "/PID", String(Number(pid))], { stdio: "ignore" });
  } catch {
    // already gone
  }
}
