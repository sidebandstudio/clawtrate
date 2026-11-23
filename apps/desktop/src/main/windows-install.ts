import type { UpdateInstallRefusal } from "@clawtrate/core";
import { runUpdatePowerShell } from "./private-update-directory.ts";
import type { UpdateInstaller, VerifiedArtifact } from "./update/install.ts";

/** The gate the signed upgrade trial lifts (#309). Until then nothing is handed to setup. */
const PENDING_TRIAL = "windows-install-pending-trial";

/** Reads, in one run, the running app's signature and then the installer's under one handle
 * that denies writes and deletion. NTFS also refuses to rename the file or any folder above
 * it while that handle is open, so the hash, the signature and the version all come from the
 * same bytes. WinVerifyTrust checks only an embedded signature, shows no prompt, skips
 * revocation and downloads nothing: the chain is built from certificates already on this
 * machine and in the signature. Each line is a fact; `windowsRefusal` decides. */
const inspectWindows = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class UpdateSignature {
  [StructLayout(LayoutKind.Sequential)]
  struct Info {
    public uint attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct TrustFile { public uint size; public IntPtr path, file, subject; }
  [StructLayout(LayoutKind.Sequential)]
  struct TrustData {
    public uint size;
    public IntPtr policy, sip;
    public uint ui, revocation, choice;
    public IntPtr file;
    public uint action;
    public IntPtr state, url;
    public uint flags, context;
    public IntPtr settings;
  }
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  [DllImport("kernel32")] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32")] static extern uint GetFileType(SafeFileHandle handle);
  [DllImport("kernel32", CharSet=CharSet.Unicode)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
  [DllImport("wintrust")] static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
  [DllImport("wintrust")] static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
  [DllImport("wintrust")] static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr data, uint signer,
    bool counter, uint counterSigner);
  [DllImport("wintrust")] static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer, uint cert);
  static string Encode(string text) {
    return text == null ? "-" : Convert.ToBase64String(Encoding.UTF8.GetBytes(text));
  }
  // The trust result, the leaf's subject and the SHA-256 of the chain's root certificate.
  static string Trust(string path, SafeFileHandle handle) {
    var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
    var file = new TrustFile();
    file.size = (uint)Marshal.SizeOf(typeof(TrustFile));
    file.path = Marshal.StringToHGlobalUni(path);
    file.file = handle == null ? IntPtr.Zero : handle.DangerousGetHandle();
    var data = new TrustData();
    data.size = (uint)Marshal.SizeOf(typeof(TrustData));
    data.ui = 2;
    data.choice = 1;
    data.action = 1;
    data.flags = 0x10 | 0x1000 | 0x2000;
    data.file = Marshal.AllocHGlobal((int)file.size);
    try {
      Marshal.StructureToPtr(file, data.file, false);
      int result = WinVerifyTrust(new IntPtr(-1), ref action, ref data);
      try {
        string subject = "-", root = "-";
        IntPtr provider = data.state == IntPtr.Zero ? IntPtr.Zero : WTHelperProvDataFromStateData(data.state);
        IntPtr signer = provider == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(provider, 0, false, 0);
        if (signer != IntPtr.Zero) {
          X509Certificate2 leaf = null, last = null;
          for (uint i = 0; ; i++) {
            IntPtr cert = WTHelperGetProvCertFromChain(signer, i);
            if (cert == IntPtr.Zero) break;
            // CRYPT_PROVIDER_CERT: a DWORD, then the certificate's context.
            last = new X509Certificate2(Marshal.ReadIntPtr(cert, IntPtr.Size));
            if (leaf == null) leaf = last;
          }
          if (leaf != null) {
            subject = Encode(leaf.Subject);
            using (var sha = SHA256.Create()) root = Convert.ToBase64String(sha.ComputeHash(last.RawData));
          }
        }
        return result.ToString("x8") + " " + subject + " " + root;
      } finally {
        data.action = 2;
        WinVerifyTrust(new IntPtr(-1), ref action, ref data);
      }
    } finally {
      Marshal.FreeHGlobal(data.file);
      Marshal.FreeHGlobal(file.path);
    }
  }
  public static string[] Inspect(string path, long expected, string running) {
    var lines = new string[4];
    lines[0] = "running " + Trust(running, null);
    using (var handle = CreateFileW(path, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      Info info;
      if (handle.IsInvalid || GetFileType(handle) != 1 || !GetFileInformationByHandle(handle, out info)
          || (info.attributes & 0x410) != 0 || info.links != 1) throw new IOException();
      var final = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
      if (length == 0 || length >= final.Capacity) throw new IOException();
      using (var file = new FileStream(handle, FileAccess.Read)) {
        string hash = "-";
        if (file.Length == expected) {
          using (var sha = SHA512.Create()) hash = Convert.ToBase64String(sha.ComputeHash(file));
        }
        lines[1] = "file " + info.volume + "." + info.indexHigh + "." + info.indexLow + " " + file.Length + " " + hash;
        file.Seek(0, SeekOrigin.Begin);
        lines[2] = "installer " + Trust(final.ToString(), handle);
        lines[3] = "version " + Encode(FileVersionInfo.GetVersionInfo(final.ToString()).ProductVersion);
      }
    }
    return lines;
  }
}
'@
[UpdateSignature]::Inspect($env:CLAWTRATE_UPDATE_FILE, [long]$env:CLAWTRATE_UPDATE_SIZE, $env:CLAWTRATE_RUNNING_APP)
`;

export type InspectWindowsFile = (
  file: VerifiedArtifact,
  runningApp: string,
  signal: AbortSignal,
) => Promise<string>;

const inspectWithPowerShell: InspectWindowsFile = async (file, runningApp, signal) =>
  (
    await runUpdatePowerShell(
      inspectWindows,
      {
        CLAWTRATE_UPDATE_FILE: file.path,
        CLAWTRATE_UPDATE_SIZE: String(file.size),
        CLAWTRATE_RUNNING_APP: runningApp,
      },
      120000,
      signal,
    )
  ).stdout;

const TRUSTED = "00000000";
// TRUST_E_NOSIGNATURE: the file carries no embedded signature.
const NOT_SIGNED = "800b0100";
const SIGNER = "([0-9a-f]{8}) (-|[A-Za-z0-9+/]+={0,2}) (-|[A-Za-z0-9+/]{43}=)";

function decode(value: string) {
  return value === "-" ? null : Buffer.from(value, "base64").toString("utf8");
}

/**
 * What the helper's facts mean for this download. The installer must have the running app's
 * publisher: a leaf certificate with the same subject whose chain ends at the same root, both
 * trusted by Windows. A renewed certificate, or one from a new intermediate under that root,
 * passes; a different root or subject does not. Anything unexpected is `inspection-failed`,
 * never a pass.
 */
export function windowsRefusal(
  output: string,
  file: VerifiedArtifact,
): UpdateInstallRefusal | null {
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const running = new RegExp(`^running ${SIGNER}$`).exec(lines[0] ?? "");
  const held = /^file (\d+\.\d+\.\d+) (\d+) (-|[A-Za-z0-9+/]{86}==)$/.exec(lines[1] ?? "");
  const installer = new RegExp(`^installer ${SIGNER}$`).exec(lines[2] ?? "");
  const version = /^version (-|[A-Za-z0-9+/]+={0,2})$/.exec(lines[3] ?? "");
  if (lines.length !== 4 || !running || !held || !installer || !version) return "inspection-failed";
  if (running[1] === NOT_SIGNED) return "build-not-signed";
  if (running[1] !== TRUSTED || running[2] === "-" || running[3] === "-")
    return "running-signature-untrusted";
  if (held[1] !== file.identity || held[2] !== String(file.size) || held[3] !== file.sha512)
    return "artifact-changed";
  if (installer[1] !== TRUSTED || installer[2] === "-" || installer[3] === "-")
    return "windows-signature";
  if (installer[2] !== running[2] || installer[3] !== running[3]) return "windows-publisher";
  if (decode(version[1]!) !== file.version) return "installer-version";
  return null;
}

export function windowsInstaller(
  runningApp = process.execPath,
  inspect: InspectWindowsFile = inspectWithPowerShell,
): UpdateInstaller {
  let kept: VerifiedArtifact | undefined;
  let inspection: AbortController | undefined;
  function retire() {
    inspection?.abort();
    inspection = undefined;
    kept = undefined;
  }
  async function check(file: VerifiedArtifact, signal: AbortSignal) {
    try {
      const output = await inspect(file, runningApp, signal);
      signal.throwIfAborted();
      return windowsRefusal(output, file);
    } catch {
      return signal.aborted ? "artifact-changed" : "inspection-failed";
    }
  }
  return {
    unavailable: PENDING_TRIAL,
    retire,
    async inspect(file) {
      retire();
      inspection = new AbortController();
      const reason = await check(file, inspection.signal);
      if (reason) return reason;
      kept = file;
      return null;
    },
    async launch(file, signal) {
      if (
        !kept ||
        kept.offerId !== file.offerId ||
        kept.identity !== file.identity ||
        kept.sha512 !== file.sha512
      )
        return "artifact-changed";
      const proof = kept;
      kept = undefined;
      // Nothing holds the file between inspect and launch, so read it all again under a new
      // hold. The trial's handoff starts setup inside that hold, so it runs these bytes.
      const reason = await check(proof, signal);
      return reason ?? PENDING_TRIAL;
    },
  };
}
