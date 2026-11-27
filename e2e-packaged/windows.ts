// What the launch check needs to ask Windows about processes, through
// PowerShell, which every Windows has. Used only when the check runs there.
import { execFileSync } from "node:child_process";

export type WindowsProcess = { pid: number; ppid: number; command: string };

function powershell(script: string, env: NodeJS.ProcessEnv = {}, timeout?: number): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
    timeout,
    killSignal: "SIGKILL",
  });
}

/**
 * Every process with its parent and full command line, as Windows reports them.
 * Throws if the query reports an error, rather than return the part it listed,
 * or if it takes longer than 5 seconds.
 */
export function windowsProcesses(): WindowsProcess[] {
  const out = powershell(
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress",
    {},
    5_000,
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
 * What the taskbar says about the app's button, through UI Automation: the
 * button's help text is the description of the overlay icon the app set on it
 * ("3 unread"), and is empty while there is no overlay. The button is found by
 * its application id, which the packaged app sets to its bundle id, compared
 * without regard to case.
 * Returns null only if the search finished and no taskbar has a button with
 * that id, and undefined if the read failed, took longer than 5 seconds or
 * printed neither answer: a synchronous read blocks the event loop, so one
 * that hangs would outlast any poll around it. Each read is appended to
 * `reads`, for the failure's report.
 */
export function taskbarOverlayDescription(
  appId: string,
  reads: OverlayRead[],
): string | null | undefined {
  const at = new Date().toISOString();
  const started = Date.now();
  try {
    const out = readOverlay(appId);
    const value =
      out === ABSENT ? null : out.startsWith(FOUND) ? out.slice(FOUND.length) : undefined;
    reads.push(
      value === undefined
        ? { at, ms: Date.now() - started, error: out ? "unexpected output" : "no output" }
        : { at, ms: Date.now() - started, value },
    );
    return value;
  } catch (error) {
    reads.push({ at, ms: Date.now() - started, error: readFailure(error) });
    return undefined;
  }
}

/**
 * A failed read by its exit status, signal or system error code alone, never
 * its message: that holds the whole script, and PowerShell's complaint.
 */
function readFailure(error: unknown): string {
  const { status, signal, code } = error as { status?: unknown; signal?: unknown; code?: unknown };
  if (code === "ETIMEDOUT") return "timed out";
  if (typeof status === "number") return `failed with exit ${status}`;
  const name = [signal, code].find(
    (each): each is string => typeof each === "string" && /^[A-Z][A-Z0-9_]*$/.test(each),
  );
  return name ? `failed with ${name}` : "failed";
}

export type OverlayRead = { at: string; ms: number } & (
  { value: string | null } | { error: string }
);

const FOUND = "found:";
const ABSENT = "absent";

/**
 * The read's output: "found:" and the help text, or "absent" once every
 * taskbar has been searched. Any error ends the script with a nonzero exit:
 * without the preference, `-Command` prints it, runs the next statement and
 * exits 0, so a failed search would read as one that found nothing.
 */
function readOverlay(appId: string): string {
  return powershell(
    `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$ae = [Windows.Automation.AutomationElement]
$want = 'Appid: ' + $env:CLAWTRATE_CHECK_APP_ID
$found = $null
foreach ($bar in $ae::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
  if ($bar.Current.ClassName -notin 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd') { continue }
  $button = $bar.FindFirst([Windows.Automation.TreeScope]::Descendants, (New-Object Windows.Automation.PropertyCondition($ae::AutomationIdProperty, $want, [Windows.Automation.PropertyConditionFlags]::IgnoreCase)))
  if ($button) { $found = '${FOUND}' + $button.Current.HelpText; break }
}
if ($null -ne $found) { $found } else { '${ABSENT}' }`,
    { CLAWTRATE_CHECK_APP_ID: appId },
    5_000,
  ).trim();
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
    execFileSync("taskkill.exe", ["/PID", String(Number(pid))], {
      stdio: "pipe",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    return null;
  } catch (error) {
    return (error as { stderr?: Buffer }).stderr?.toString().trim() || String(error);
  }
}

/** Ends a process and its children by PID, for cleanup after a failure only. */
export function forceEnd(pid: number): void {
  try {
    execFileSync("taskkill.exe", ["/F", "/T", "/PID", String(Number(pid))], {
      stdio: "ignore",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
  } catch {
    // already gone
  }
}
