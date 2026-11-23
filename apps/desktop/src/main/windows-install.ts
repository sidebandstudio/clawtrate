import type { UpdateInstallRefusal } from "@clawtrate/core";
import { runUpdatePowerShell } from "./private-update-directory.ts";
import type { UpdateInstaller, VerifiedArtifact } from "./update/install.ts";

/** The gate the signed upgrade trial lifts (#309). Until then nothing is handed to setup. */
const PENDING_TRIAL = "windows-install-pending-trial";

/** The C# behind the check. `UpdateSignature.Inspect` reads, in one run, the running app's
 * signatures and then the installer's under one handle that denies writes and deletion. NTFS
 * also refuses to rename the file or any folder above it while that handle is open, so the
 * hash, the signatures and the copy the version comes from all have the same bytes.
 * WinVerifyTrust checks one embedded signature at a time, picked by its index, shows no prompt,
 * skips revocation and downloads nothing: the chain is built from certificates already on this
 * machine and in the signature. Only when the bytes are the ones the engine verified and the
 * installer has the running app's publisher does `UpdateVersions` ask Windows for the version.
 * Each line is a fact; `windowsRefusal` decides.
 * e2e-updates/windows-authenticode.spec.ts compiles it too, to run the version reader alone. */
export const inspectSource = `
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
// The version Windows itself reads from a held file. Windows' version lookup opens the file
// again by path, and takes the strings, or the whole version, from a .mui file in a language
// folder beside it when there is one. So it reads a copy of the held bytes, alone in a new
// folder this run makes and protects as private-update-directory.ts protects an update folder,
// and the copy must still have the held file's size and SHA-512 afterwards.
public static class UpdateVersions {
  // FILE_VER_GET_LOCALISED, which reads what .NET's FileVersionInfo reads, a .mui file's
  // version included when there is one.
  const uint Localised = 1;
  [DllImport("version", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFileVersionInfoSizeExW(uint flags, string path, out uint handle);
  [DllImport("version", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetFileVersionInfoExW(uint flags, string path, uint handle, uint size, IntPtr data);
  [DllImport("version", CharSet=CharSet.Unicode)]
  static extern bool VerQueryValueW(IntPtr block, string path, out IntPtr value, out uint size);
  static uint U32(byte[] bytes, int at) { return BitConverter.ToUInt32(bytes, at); }
  static int U16(byte[] bytes, int at) { return BitConverter.ToUInt16(bytes, at); }
  // The value at a path in Windows' copy, or null. It must lie inside that copy.
  static byte[] Value(IntPtr data, uint size, string path, bool text) {
    IntPtr at;
    uint length;
    if (!VerQueryValueW(data, path, out at, out length)) return null;
    long offset = at.ToInt64() - data.ToInt64(), count = text ? 2L * length : length;
    if (offset < 0 || offset > size || count > size - offset) throw new InvalidDataException();
    var bytes = new byte[count];
    Marshal.Copy(at, bytes, 0, (int)count);
    return bytes;
  }
  // "versions 0" for a file without a version resource. Otherwise "versions 1" and the resource
  // Windows picks: its fixed product version, then the ProductVersion of each translation it
  // lists, "-" for one without.
  static string[] Versions(string path) {
    uint unused, size = GetFileVersionInfoSizeExW(Localised, path, out unused);
    if (size == 0) {
      int error = Marshal.GetLastWin32Error();
      // ERROR_RESOURCE_DATA_NOT_FOUND to ERROR_RESOURCE_LANG_NOT_FOUND.
      if (error >= 1812 && error <= 1815) return new[] { "versions 0" };
      throw new IOException("GetFileVersionInfoSizeExW failed", error);
    }
    // Windows sizes its copy from the resource's own 16-bit length, so it stays small.
    IntPtr data = Marshal.AllocHGlobal((int)size);
    try {
      if (!GetFileVersionInfoExW(Localised, path, 0, size, data))
        throw new IOException("GetFileVersionInfoExW failed", Marshal.GetLastWin32Error());
      string product = "-";
      var info = Value(data, size, "\\\\", false);
      if (info != null && info.Length >= 52 && U32(info, 0) == 0xfeef04bd) {
        uint high = U32(info, 16), low = U32(info, 20);
        product = (high >> 16) + "." + (high & 0xffff) + "." + (low >> 16) + "." + (low & 0xffff);
      }
      var line = new StringBuilder("resource " + product);
      var translations = Value(data, size, "\\\\VarFileInfo\\\\Translation", false);
      for (int at = 0; translations != null && at + 4 <= translations.Length; at += 4) {
        string key = U16(translations, at).ToString("x4") + U16(translations, at + 2).ToString("x4");
        var text = Value(data, size, "\\\\StringFileInfo\\\\" + key + "\\\\ProductVersion", true);
        string version = text == null ? null : Encoding.Unicode.GetString(text).Split('\\0')[0];
        line.Append(" ").Append(UpdateSignature.Encode(version == "" ? null : version));
      }
      return new[] { "versions 1", line.ToString() };
    } finally {
      Marshal.FreeHGlobal(data);
    }
  }
  // The folder and its DACL: owned by this user, inheriting nothing, and one rule giving this
  // user full control. CreateDirectory returns a folder that already exists without applying
  // the DACL, so the name is random and the DACL is read back.
  static void MakePrivate(string folder) {
    var user = WindowsIdentity.GetCurrent().User;
    var acl = new DirectorySecurity();
    acl.SetOwner(user);
    acl.SetAccessRuleProtection(true, false);
    acl.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
      InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    var made = Directory.CreateDirectory(folder, acl);
    var actual = made.GetAccessControl();
    var rules = actual.GetAccessRules(true, true, typeof(SecurityIdentifier));
    if (!actual.AreAccessRulesProtected || rules.Count != 1 || made.GetFileSystemInfos().Length != 0
        || (made.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Directory permissions refused");
    var rule = (FileSystemAccessRule)rules[0];
    if (!rule.IdentityReference.Equals(user) || rule.AccessControlType != AccessControlType.Allow
        || rule.FileSystemRights != FileSystemRights.FullControl) throw new IOException("Directory permissions refused");
  }
  public static string[] Read(string path, FileStream held, string sha512) {
    string folder = Path.Combine(Path.GetDirectoryName(path), ".inspect-" + Path.GetRandomFileName());
    if (Directory.Exists(folder) || File.Exists(folder)) throw new IOException("Directory exists");
    try {
      MakePrivate(folder);
      string copy = Path.Combine(folder, Path.GetFileName(path));
      using (var output = new FileStream(copy, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
        held.Seek(0, SeekOrigin.Begin);
        held.CopyTo(output);
      }
      // Held while Windows reads it, so nothing else can write it or move it.
      using (var hold = new FileStream(copy, FileMode.Open, FileAccess.Read, FileShare.Read, 1)) {
        var lines = Versions(copy);
        string hash;
        using (var sha = SHA512.Create()) hash = Convert.ToBase64String(sha.ComputeHash(hold));
        if (hold.Length != held.Length || hash != sha512) throw new InvalidDataException();
        return lines;
      }
    } finally {
      // Removing the copy can't change the answer, and a copy left behind goes with the update
      // folder, which is cleared at the next start and the next check.
      try { Directory.Delete(folder, true); } catch (IOException) {} catch (UnauthorizedAccessException) {}
    }
  }
}
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
  struct Settings { public uint size, index, flags, secondary, verified; public IntPtr policy; }
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
  // CRYPT_PROVIDER_SGNR up to psSigner, and CMSG_SIGNER_INFO up to HashAlgorithm.pszObjId.
  [StructLayout(LayoutKind.Sequential)]
  struct Signer { public uint size, asOfLow, asOfHigh, certs; public IntPtr chain; public uint type; public IntPtr info; }
  [StructLayout(LayoutKind.Sequential)]
  struct Blob { public uint size; public IntPtr data; }
  [StructLayout(LayoutKind.Sequential)]
  struct SignerInfo { public uint version; public Blob issuer, serial; public IntPtr digest; }
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
  internal static string Encode(string text) {
    return text == null ? "-" : Convert.ToBase64String(Encoding.UTF8.GetBytes(text));
  }
  sealed class Signature {
    public uint index;
    public int result;
    public string digest, subject, root;
    public override string ToString() {
      return "signature " + index + " " + result.ToString("x8") + " " + Encode(digest) + " " + Encode(subject) + " " + (root ?? "-");
    }
  }
  // One embedded signature, picked by its index: the trust result, the signer's digest
  // algorithm, the leaf's subject and the SHA-256 of the chain's root certificate, all from
  // that signature's own WinVerifyTrust state. The first also counts the ones after it.
  static Signature Trust(string path, FileStream held, uint index, out uint secondary) {
    var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
    var file = new TrustFile();
    file.size = (uint)Marshal.SizeOf(typeof(TrustFile));
    file.path = Marshal.StringToHGlobalUni(path);
    file.file = held == null ? IntPtr.Zero : held.SafeFileHandle.DangerousGetHandle();
    var settings = new Settings();
    settings.size = (uint)Marshal.SizeOf(typeof(Settings));
    settings.index = index;
    // WSS_VERIFY_SPECIFIC, and with the first WSS_GET_SECONDARY_SIG_COUNT.
    settings.flags = index == 0 ? 3u : 1u;
    var data = new TrustData();
    data.size = (uint)Marshal.SizeOf(typeof(TrustData));
    data.ui = 2;
    data.choice = 1;
    data.action = 1;
    data.flags = 0x10 | 0x1000 | 0x2000;
    data.file = Marshal.AllocHGlobal((int)file.size);
    data.settings = Marshal.AllocHGlobal((int)settings.size);
    try {
      Marshal.StructureToPtr(file, data.file, false);
      Marshal.StructureToPtr(settings, data.settings, false);
      if (held != null) held.Seek(0, SeekOrigin.Begin);
      int result = WinVerifyTrust(new IntPtr(-1), ref action, ref data);
      try {
        secondary = ((Settings)Marshal.PtrToStructure(data.settings, typeof(Settings))).secondary;
        var found = new Signature { index = index, result = result };
        IntPtr provider = data.state == IntPtr.Zero ? IntPtr.Zero : WTHelperProvDataFromStateData(data.state);
        IntPtr signer = provider == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(provider, 0, false, 0);
        if (signer != IntPtr.Zero) {
          var state = (Signer)Marshal.PtrToStructure(signer, typeof(Signer));
          if (state.info != IntPtr.Zero) {
            var info = (SignerInfo)Marshal.PtrToStructure(state.info, typeof(SignerInfo));
            if (info.digest != IntPtr.Zero) found.digest = Marshal.PtrToStringAnsi(info.digest);
          }
          X509Certificate2 leaf = null, last = null;
          for (uint i = 0; ; i++) {
            IntPtr cert = WTHelperGetProvCertFromChain(signer, i);
            if (cert == IntPtr.Zero) break;
            // CRYPT_PROVIDER_CERT: a DWORD, then the certificate's context.
            last = new X509Certificate2(Marshal.ReadIntPtr(cert, IntPtr.Size));
            if (leaf == null) leaf = last;
          }
          if (leaf != null) {
            found.subject = leaf.Subject;
            using (var sha = SHA256.Create()) found.root = Convert.ToBase64String(sha.ComputeHash(last.RawData));
          }
        }
        return found;
      } finally {
        data.action = 2;
        WinVerifyTrust(new IntPtr(-1), ref action, ref data);
      }
    } finally {
      Marshal.FreeHGlobal(data.settings);
      Marshal.FreeHGlobal(data.file);
      Marshal.FreeHGlobal(file.path);
    }
  }
  // "<name> <count>", then every embedded signature in index order.
  static List<Signature> Signatures(List<string> lines, string name, string path, FileStream held) {
    uint more, unused;
    var found = new List<Signature> { Trust(path, held, 0, out more) };
    for (uint index = 1; index <= more; index++) found.Add(Trust(path, held, index, out unused));
    lines.Add(name + " " + found.Count);
    foreach (var signature in found) lines.Add(signature.ToString());
    return found;
  }
  // The root and subject that every SHA-256 signature names, when there is one, Windows trusts
  // each and they agree. windowsRefusal applies the same rule; here it keeps any file that rule
  // refuses away from the version reader.
  static string Publisher(List<Signature> signatures) {
    string found = null;
    foreach (var signature in signatures) {
      if (signature.digest != "2.16.840.1.101.3.4.2.1") continue;
      if (signature.result != 0 || string.IsNullOrEmpty(signature.subject) || signature.root == null) return null;
      string publisher = signature.root + " " + signature.subject;
      if (found != null && found != publisher) return null;
      found = publisher;
    }
    return found;
  }
  public static string[] Inspect(string path, long expected, string sha512, string running) {
    var lines = new List<string>();
    string publisher = Publisher(Signatures(lines, "running", running, null));
    using (var handle = CreateFileW(path, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      Info info;
      if (handle.IsInvalid || GetFileType(handle) != 1 || !GetFileInformationByHandle(handle, out info)
          || (info.attributes & 0x410) != 0 || info.links != 1) throw new IOException();
      var final = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
      if (length == 0 || length >= final.Capacity) throw new IOException();
      // Unbuffered, so a seek moves the handle's own position before each WinVerifyTrust.
      using (var file = new FileStream(handle, FileAccess.Read, 1)) {
        string hash = "-";
        if (file.Length == expected) {
          using (var sha = SHA512.Create()) hash = Convert.ToBase64String(sha.ComputeHash(file));
        }
        lines.Add("file " + info.volume + "." + info.indexHigh + "." + info.indexLow + " " + file.Length + " " + hash);
        var installer = Signatures(lines, "installer", final.ToString(), file);
        // Only the bytes the engine verified, signed by the running app's publisher, are copied.
        if (hash == sha512 && publisher != null && Publisher(installer) == publisher)
          lines.AddRange(UpdateVersions.Read(path, file, sha512));
        else
          lines.Add("versions unread");
      }
    }
    return lines.ToArray();
  }
}
`;

const inspectWindows = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${inspectSource}
'@
[UpdateSignature]::Inspect($env:CLAWTRATE_UPDATE_FILE, [long]$env:CLAWTRATE_UPDATE_SIZE, $env:CLAWTRATE_UPDATE_SHA512, $env:CLAWTRATE_RUNNING_APP)
`;

export type InspectWindowsFile = (
  file: VerifiedArtifact,
  runningApp: string,
  signal: AbortSignal,
) => Promise<string>;

export const inspectWithPowerShell: InspectWindowsFile = async (file, runningApp, signal) =>
  (
    await runUpdatePowerShell(
      inspectWindows,
      {
        CLAWTRATE_UPDATE_FILE: file.path,
        CLAWTRATE_UPDATE_SIZE: String(file.size),
        CLAWTRATE_UPDATE_SHA512: file.sha512,
        CLAWTRATE_RUNNING_APP: runningApp,
      },
      120000,
      signal,
    )
  ).stdout;

const TRUSTED = "00000000";
// TRUST_E_NOSIGNATURE: the file carries no embedded signature.
const NOT_SIGNED = "800b0100";
// The signer's digest algorithm, as CMSG_SIGNER_INFO names it.
const SHA256 = "2.16.840.1.101.3.4.2.1";
const SIGNATURE =
  /^signature (\d+) ([0-9a-f]{8}) (-|[A-Za-z0-9+/]+={0,2}) (-|[A-Za-z0-9+/]+={0,2}) (-|[A-Za-z0-9+/]{43}=)$/;
const RESOURCE = /^resource (-|\d+\.\d+\.\d+\.\d+)((?: (?:-|[A-Za-z0-9+/]+={0,2}))*)$/;

type Signature = { result: string; digest: string | null; subject: string; root: string };
/** A version resource: its fixed product version, and the ProductVersion of each translation. */
type Resource = { product: string; versions: (string | null)[] };

function decode(value: string) {
  return value === "-" ? null : Buffer.from(value, "base64").toString("utf8");
}

/** Takes `<name> <count>` and that many signatures, in index order, off the front of `lines`. */
function takeSignatures(lines: string[], name: string): Signature[] | null {
  const head = /^(\w+) ([1-9]\d*)$/.exec(lines.shift() ?? "");
  if (head?.[1] !== name) return null;
  const signatures: Signature[] = [];
  for (let index = 0; index < Number(head[2]); index++) {
    const line = SIGNATURE.exec(lines.shift() ?? "");
    if (line?.[1] !== String(index)) return null;
    signatures.push({
      result: line[2]!,
      digest: decode(line[3]!),
      subject: line[4]!,
      root: line[5]!,
    });
  }
  return signatures;
}

/**
 * Takes `versions <count>` and that many resources off the front of `lines`, or
 * `versions unread`, which the helper prints when it left them unread.
 */
function takeVersions(lines: string[]): Resource[] | "unread" | null {
  const head = /^versions (unread|0|[1-9]\d*)$/.exec(lines.shift() ?? "");
  if (head?.[1] === "unread") return "unread";
  if (!head) return null;
  const resources: Resource[] = [];
  for (let index = 0; index < Number(head[1]); index++) {
    const line = RESOURCE.exec(lines.shift() ?? "");
    if (!line) return null;
    resources.push({ product: line[1]!, versions: line[2]!.split(" ").slice(1).map(decode) });
  }
  return resources;
}

/**
 * The file's SHA-256 signatures, when it has one and Windows trusts each and each names a
 * signer. A signature with another digest, such as the SHA-1 one electron-builder puts first by
 * default, does not count. A build signed again later, with a renewed certificate, has two.
 */
function sha256Signatures(signatures: Signature[]) {
  const found = signatures.filter((signature) => signature.digest === SHA256);
  return found.length > 0 &&
    found.every((one) => one.result === TRUSTED && one.subject !== "-" && one.root !== "-")
    ? found
    : null;
}

function samePublisher(one: Signature, other: Signature) {
  return one.subject === other.subject && one.root === other.root;
}

/** A fixed product version carries the release's major, minor and patch, then any build number. */
function sameRelease(product: string, version: string) {
  const release = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const parts = product.split(".");
  return !!release && parts.length === 4 && [1, 2, 3].every((i) => +parts[i - 1]! === +release[i]!);
}

/**
 * What the helper's facts mean for this download. The installer must have the running app's
 * publisher: every SHA-256 signature on each file trusted by Windows, with a leaf certificate of
 * the same subject whose chain ends at the same root. A renewed certificate, or one from a new
 * intermediate under that root, passes; a different root or subject does not. The version
 * resource Windows reads must give the offer's version as the ProductVersion of every
 * translation it lists, and the release's numbers as its fixed product version. Anything
 * unexpected is `inspection-failed`, never a pass.
 */
export function windowsRefusal(
  output: string,
  file: VerifiedArtifact,
): UpdateInstallRefusal | null {
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const running = takeSignatures(lines, "running");
  const held = /^file (\d+\.\d+\.\d+) (\d+) (-|[A-Za-z0-9+/]{86}==)$/.exec(lines.shift() ?? "");
  const installer = takeSignatures(lines, "installer");
  const versions = takeVersions(lines);
  if (lines.length || !running || !held || !installer || !versions) return "inspection-failed";
  if (running[0]!.result === NOT_SIGNED) return "build-not-signed";
  const app = sha256Signatures(running);
  if (!app?.every((one) => samePublisher(one, app[0]!))) return "running-signature-untrusted";
  if (held[1] !== file.identity || held[2] !== String(file.size) || held[3] !== file.sha512)
    return "artifact-changed";
  const setup = sha256Signatures(installer);
  if (!setup) return "windows-signature";
  if (!setup.every((one) => samePublisher(one, app[0]!))) return "windows-publisher";
  // The helper reads the version resources only after the same checks pass.
  if (versions === "unread") return "inspection-failed";
  if (
    !versions.length ||
    versions.some(
      (resource) =>
        !resource.versions.length ||
        resource.versions.some((version) => version !== file.version) ||
        !sameRelease(resource.product, file.version),
    )
  )
    return "installer-version";
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
