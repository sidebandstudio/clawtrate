import type { UpdateInstallRefusal } from "@clawtrate/core";
import { runUpdatePowerShell } from "./private-update-directory.ts";
import type { VerifiedArtifact } from "./update/install.ts";

// One native call holds the directory entries and the read-only image open
// through the per-user setup process. Elevated handoff stays unavailable.
const native = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

public static class VerifiedInstaller {
  [StructLayout(LayoutKind.Sequential)]
  struct Info {
    public uint attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  [DllImport("kernel32")] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  [DllImport("kernel32")] static extern uint GetFileType(SafeFileHandle h);

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  class TrustFile {
    public uint size = (uint)Marshal.SizeOf(typeof(TrustFile));
    [MarshalAs(UnmanagedType.LPWStr)] public string path;
    public IntPtr handle, subject;
  }
  [StructLayout(LayoutKind.Sequential)]
  class TrustData {
    public uint size = (uint)Marshal.SizeOf(typeof(TrustData));
    public IntPtr callback, client;
    public uint ui = 2, revocation = 1, choice = 1;
    public IntPtr file;
    public uint action = 1;
    public IntPtr state, url;
    // WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT
    public uint flags = 0x1080, context;
    public IntPtr settings;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct CertPrefix { public uint size; public IntPtr certificate; }
  [DllImport("wintrust", ExactSpelling=true)]
  static extern int WinVerifyTrust(IntPtr window, ref Guid policy, [In,Out] TrustData data);
  [DllImport("wintrust", ExactSpelling=true)] static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
  [DllImport("wintrust", ExactSpelling=true)] static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr data, uint index, bool counter, uint counterIndex);
  [DllImport("wintrust", ExactSpelling=true)] static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer, uint index);

  static string TrustedPublisher(string path, SafeFileHandle handle) {
    var file = new TrustFile { path = path, handle = handle.DangerousGetHandle() };
    IntPtr memory = Marshal.AllocHGlobal(Marshal.SizeOf(file));
    Marshal.StructureToPtr(file, memory, false);
    var data = new TrustData { file = memory };
    var policy = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
    try {
      if (WinVerifyTrust(new IntPtr(-1), ref policy, data) != 0) return null;
      var provider = WTHelperProvDataFromStateData(data.state);
      var signer = provider == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(provider, 0, false, 0);
      var entry = signer == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvCertFromChain(signer, 0);
      if (entry == IntPtr.Zero) return null;
      var cert = (CertPrefix)Marshal.PtrToStructure(entry, typeof(CertPrefix));
      using (var leaf = new X509Certificate2(cert.certificate))
      using (var sha = SHA256.Create()) {
        return BitConverter.ToString(sha.ComputeHash(leaf.RawData)).Replace("-", "");
      }
    } finally {
      data.action = 2;
      WinVerifyTrust(new IntPtr(-1), ref policy, data);
      Marshal.DestroyStructure(memory, typeof(TrustFile));
      Marshal.FreeHGlobal(memory);
      GC.KeepAlive(handle);
    }
  }

  // The x64 installer's own key and uninstall entry are written in the 64-bit view.
  static string Scope(string dir) {
    const string key = @"Software\ccda9b3a-da36-5fc3-9c37-0011d2510f25";
    string result = null;
    bool otherUserRegistration = false;
    foreach (var hive in new [] { RegistryHive.CurrentUser, RegistryHive.LocalMachine }) {
      using (var root = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64))
      using (var own = root.OpenSubKey(key))
      using (var uninstall = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Path.GetFileName(key))) {
        if (hive == RegistryHive.CurrentUser && (own != null || uninstall != null))
          otherUserRegistration = true;
        if (own == null || uninstall == null) continue;
        var location = own.GetValue("InstallLocation") as string;
        if (!String.Equals(location, dir, StringComparison.Ordinal)) continue;
        if (result != null) return null;
        result = hive == RegistryHive.CurrentUser ? "/currentuser" : "/allusers";
      }
    }
    return result == "/allusers" && otherUserRegistration ? null : result;
  }

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Startup {
    public int size;
    public IntPtr reserved, desktop, title;
    public uint x, y, width, height, xChars, yChars, fill, flags;
    public ushort show, reservedSize;
    public IntPtr reservedBytes, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string image, StringBuilder args, IntPtr ps, IntPtr ts,
    bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);

  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumeNameForVolumeMountPointW(string root, StringBuilder volume, uint length);

  // Pin the namespace used by CreateProcessW as well as the leaf. A drive
  // letter is an alias; the OS volume GUID still names the same local volume.
  static string LockParents(string path, Stack<SafeFileHandle> locks) {
    string root = Path.GetPathRoot(path);
    var volume = new StringBuilder(64);
    if (!GetVolumeNameForVolumeMountPointW(root, volume, (uint)volume.Capacity)) throw new IOException();
    string current = volume.ToString();
    string[] parts = path.Substring(root.Length).Split('\\');
    foreach (var part in parts) {
      if (part.Length == 0 || part == "." || part == ".." || part.Contains(":")) throw new IOException();
      // FILE_LIST_DIRECTORY participates in share-access checks. Attribute-only
      // access cannot hold an entry against deletion or reparse writes.
      var h = CreateFileW(current, 0x81, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
      locks.Push(h);
      Info info;
      if (h.IsInvalid || !GetFileInformationByHandle(h, out info) ||
          (info.attributes & 0x410) != 0x10) throw new IOException();
      current = current.TrimEnd('\\') + "\\" + part;
    }
    return current;
  }

  public static string Run(string path, long size, string app, string expectedVersion, int ownerPid, bool launch) {
    if (!System.Text.RegularExpressions.Regex.IsMatch(path, @"^[A-Za-z]:\\") ||
        !System.Text.RegularExpressions.Regex.IsMatch(app, @"^[A-Za-z]:\\")) return "installation-context";
    if (new DriveInfo(Path.GetPathRoot(path)).DriveType != DriveType.Fixed ||
        new DriveInfo(Path.GetPathRoot(app)).DriveType != DriveType.Fixed) return "installation-context";
    string dir = Path.GetDirectoryName(app);
    if (!String.Equals(Path.GetFileName(app), "Clawtrate.exe", StringComparison.OrdinalIgnoreCase))
      return "installation-context";
    var locks = new Stack<SafeFileHandle>();
    var appLocks = new Stack<SafeFileHandle>();
    try {
      string imagePath = LockParents(path, locks);
      string runningPath, scope;
      try {
        runningPath = LockParents(app, appLocks);
        scope = Scope(dir);
      } catch { return "installation-context"; }
      if (scope == null) return "installation-context";
      if (scope != "/currentuser") return "no-installer-path";
      using (var running = CreateFileW(runningPath, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
      using (var image = CreateFileW(imagePath, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
        Info info;
        if (running.IsInvalid) return "installation-context";
        string runningPublisher = TrustedPublisher(runningPath, running);
        if (runningPublisher == null) return "running-signature-untrusted";
        if (image.IsInvalid || GetFileType(image) != 1 || !GetFileInformationByHandle(image, out info) ||
            (info.attributes & 0x410) != 0 || info.links != 1 || (info.indexHigh == 0 && info.indexLow == 0)) return "artifact-changed";
        using (var file = new FileStream(image, FileAccess.Read))
        using (var hash = SHA512.Create()) {
          if (file.Length != size) return "artifact-changed";
          string digest = Convert.ToBase64String(hash.ComputeHash(file));
          file.Position = 0;
          string publisher = TrustedPublisher(imagePath, image);
          if (publisher == null) return "authenticode-trust";
          // Read under the same namespace and image locks as WinVerifyTrust.
          var metadata = System.Diagnostics.FileVersionInfo.GetVersionInfo(imagePath);
          if (metadata.ProductName != "Clawtrate" || metadata.OriginalFilename != "ClawtrateSetup.exe")
            return "installer-product";
          if (metadata.ProductVersion != expectedVersion) return "installer-version";
          string identity = info.volume + "." + info.indexHigh + "." + info.indexLow;
          using (var owner = System.Diagnostics.Process.GetProcessById(ownerPid)) {
          // Acquire the process handle before asking the app to quit, never reacquire it by PID.
          IntPtr ownerHandle = owner.Handle;
          Console.WriteLine("proof " + identity + " " + file.Length + " " + digest + " " + runningPublisher + " " + publisher);
          if (!launch) return "ok";
          Console.Out.Flush();
          if (Console.ReadLine() != "launch") return "installer-failed";
          Console.WriteLine("waiting");
          Console.Out.Flush();
          if (WaitForSingleObject(ownerHandle, 30000) != 0) return "quit-blocked";
          running.Dispose();
          if (Scope(dir) != scope) return "installation-context";
          Environment.SetEnvironmentVariable("CLAWTRATE_EXITED_INSTALL_DIR", dir);
          var startup = new Startup { size = Marshal.SizeOf(typeof(Startup)) };
          var args = new StringBuilder("\"" + imagePath + "\" /S --updated --force-run " + scope + " /D=" + dir);
          ProcessInfo child;
          if (!CreateProcessW(imagePath, args, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero,
                              Environment.SystemDirectory, ref startup, out child)) return "installer-failed";
          CloseHandle(child.thread);
          // The installed app's directory must be replaceable. The original candidate
          // and its full volume-qualified namespace stay held through all setup reads.
          while (appLocks.Count > 0) appLocks.Pop().Dispose();
          try { WaitForSingleObject(child.process, UInt32.MaxValue); }
          finally { CloseHandle(child.process); }
          return "ok";
          }
        }
      }
    } catch (IOException) { return "artifact-changed"; }
    finally { while (appLocks.Count > 0) appLocks.Pop().Dispose(); while (locks.Count > 0) locks.Pop().Dispose(); }
  }
}
'@
[VerifiedInstaller]::Run($env:CLAWTRATE_UPDATE_FILE,[long]$env:CLAWTRATE_UPDATE_SIZE,$env:CLAWTRATE_RUNNING_IMAGE,
    $env:CLAWTRATE_UPDATE_VERSION, [int]$env:CLAWTRATE_OWNER_PID, ($env:CLAWTRATE_INSTALL_MODE -eq 'launch'))
`;

export async function windowsInstall(
  file: VerifiedArtifact,
  publisher: string,
  launch: boolean,
  signal?: AbortSignal,
  requestQuit?: () => void,
) {
  const failure = launch ? "installer-failed" : "inspection-failed";
  let authorized = false;
  try {
    const task = runUpdatePowerShell(
      native,
      {
        CLAWTRATE_UPDATE_FILE: file.path,
        CLAWTRATE_UPDATE_SIZE: String(file.size),
        CLAWTRATE_OWNER_PID: String(process.pid),
        CLAWTRATE_UPDATE_VERSION: file.version,
        CLAWTRATE_RUNNING_IMAGE: process.execPath,
        CLAWTRATE_INSTALL_MODE: launch ? "launch" : "inspect",
      },
      120000,
      launch ? undefined : signal,
    );
    let pending = "";
    let checked = false;
    let refusal: UpdateInstallRefusal | null = null;
    task.child.stdin?.on("error", () => {
      /* exit or abort closes the pipe */
    });
    task.child.stdout?.on("data", (chunk: Buffer | string) => {
      pending += chunk.toString();
      while (pending.includes("\n")) {
        const newline = pending.indexOf("\n");
        const line = pending.slice(0, newline).trimEnd();
        pending = pending.slice(newline + 1);
        if (line === "waiting" && authorized && !signal?.aborted) {
          requestQuit?.();
          requestQuit = undefined;
        }
        const fields = line.split(" ");
        if (checked || fields[0] !== "proof") continue;
        checked = true;
        const [, identity, size, digest, runningPin, candidatePin] = fields;
        if (
          fields.length !== 6 ||
          identity !== file.identity ||
          size !== String(file.size) ||
          digest !== file.sha512
        )
          refusal = "artifact-changed";
        else if (runningPin !== publisher) refusal = "running-publisher-mismatch";
        else if (candidatePin !== publisher) refusal = "publisher-mismatch";
        if (launch) {
          authorized = !refusal && !signal?.aborted;
          task.child.stdin?.end(authorized ? "launch\n" : "");
        }
      }
    });
    const { stdout } = await task;
    if (refusal) return refusal;
    const result = stdout.trim().split(/\r?\n/).at(-1);
    switch (result) {
      case "ok":
        return checked && !signal?.aborted ? null : failure;
      case "authenticode-trust":
      case "quit-blocked":
      case "no-installer-path":
      case "installer-product":
      case "installer-version":
      case "publisher-mismatch":
      case "running-signature-untrusted":
      case "artifact-changed":
      case "installation-context":
        return result as UpdateInstallRefusal;
      default:
        return failure;
    }
  } catch {
    return authorized ? ("handoff-unconfirmed" as const) : failure;
  }
}
