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
 * installer has the running app's publisher does `UpdateVersions` ask Windows for its versions.
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
// The versions Windows itself reads from a held file. Windows' version lookup opens the file
// again by path, and takes the strings, or the whole version, from a .mui file in a language
// folder beside it when there is one. So it reads a copy of the held bytes, alone in a new
// folder this run makes and protects as private-update-directory.ts protects an update folder.
// The copy must have the held file's size and SHA-512 before Windows reads it and afterwards.
public static class UpdateVersions {
  // FILE_VER_GET_LOCALISED, which reads what .NET's FileVersionInfo reads, a .mui file's
  // version included when there is one.
  const uint Localised = 1;
  // LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE: mapped for its resources alone.
  const uint AsResources = 0x2 | 0x20;
  // RESOURCE_ENUM_LN: the file's own resources, never a .mui file's.
  const uint OwnResources = 1;
  // RT_VERSION
  static readonly IntPtr VersionType = new IntPtr(16);
  // More version resources than this refuse the file.
  const int Most = 16;
  [DllImport("version", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFileVersionInfoSizeExW(uint flags, string path, out uint handle);
  [DllImport("version", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetFileVersionInfoExW(uint flags, string path, uint handle, uint size, IntPtr data);
  [DllImport("version", CharSet=CharSet.Unicode)]
  static extern bool VerQueryValueW(IntPtr block, string path, out IntPtr value, out uint size);
  delegate bool NameFound(IntPtr module, IntPtr type, IntPtr name, IntPtr context);
  delegate bool LanguageFound(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr context);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
  [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32", SetLastError=true)]
  static extern bool EnumResourceNamesExW(IntPtr module, IntPtr type, NameFound found, IntPtr context,
    uint flags, ushort language);
  [DllImport("kernel32", SetLastError=true)]
  static extern bool EnumResourceLanguagesExW(IntPtr module, IntPtr type, IntPtr name, LanguageFound found,
    IntPtr context, uint flags, ushort language);
  [DllImport("kernel32", SetLastError=true)]
  static extern IntPtr FindResourceExW(IntPtr module, IntPtr type, IntPtr name, ushort language);
  [DllImport("kernel32", SetLastError=true)] static extern IntPtr LoadResource(IntPtr module, IntPtr found);
  [DllImport("kernel32")] static extern IntPtr LockResource(IntPtr loaded);
  [DllImport("kernel32", SetLastError=true)] static extern uint SizeofResource(IntPtr module, IntPtr found);
  [StructLayout(LayoutKind.Sequential)]
  struct Security { public int size; public IntPtr descriptor; public bool inherit; }
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateDirectoryW(string path, ref Security security);
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
  // A version resource's line: its fixed product version, then the ProductVersion of each
  // translation it lists, "-" for one without.
  static string Facts(IntPtr data, uint size) {
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
    return line.ToString();
  }
  // The same, from a resource's bytes in a block laid out as Windows lays out its own copy: sized
  // from the resource's own length, with room after it.
  static string Facts(byte[] resource) {
    var block = new byte[2 * resource.Length + 4];
    Buffer.BlockCopy(resource, 0, block, 0, resource.Length);
    var pin = GCHandle.Alloc(block, GCHandleType.Pinned);
    try {
      return Facts(pin.AddrOfPinnedObject(), (uint)block.Length);
    } finally {
      pin.Free();
    }
  }
  static bool IsNumber(IntPtr name) { return ((ulong)name.ToInt64() >> 16) == 0; }
  static bool Same(byte[] one, byte[] other) {
    if (one.Length != other.Length) return false;
    for (int i = 0; i < one.Length; i++) if (one[i] != other[i]) return false;
    return true;
  }
  // Why an enumeration stopped: too many, or, when none may be, nothing of the kind.
  static void Ended(int found, bool none) {
    int error = Marshal.GetLastWin32Error();
    if (found > Most) throw new InvalidDataException("More than " + Most + " version resources");
    // ERROR_RESOURCE_DATA_NOT_FOUND to ERROR_RESOURCE_LANG_NOT_FOUND.
    if (!none || error < 1812 || error > 1815) throw new IOException("Resource enumeration failed", error);
  }
  // One resource's bytes, as long as the resource says it is, which its data must hold.
  static byte[] Bytes(IntPtr module, IntPtr name, ushort language) {
    IntPtr found = FindResourceExW(module, VersionType, name, language);
    IntPtr loaded = found == IntPtr.Zero ? IntPtr.Zero : LoadResource(module, found);
    IntPtr at = loaded == IntPtr.Zero ? IntPtr.Zero : LockResource(loaded);
    uint size = at == IntPtr.Zero ? 0 : SizeofResource(module, found);
    if (size < 2) throw new IOException("Version resource unreadable");
    int length = (ushort)Marshal.ReadInt16(at);
    if (length > size) throw new InvalidDataException("Version resource longer than its data");
    var bytes = new byte[length];
    Marshal.Copy(at, bytes, 0, length);
    return bytes;
  }
  // Every version resource the file holds itself, under each name and language, as Windows'
  // resource loader lists them.
  static List<byte[]> Embedded(string path) {
    IntPtr module = LoadLibraryExW(path, IntPtr.Zero, AsResources);
    if (module == IntPtr.Zero) throw new IOException("LoadLibraryExW failed", Marshal.GetLastWin32Error());
    var names = new List<IntPtr>();
    try {
      // A name that is not a number is a string Windows owns only during the call, so it is copied.
      NameFound name = (m, t, found, c) => {
        names.Add(IsNumber(found) ? found : Marshal.StringToHGlobalUni(Marshal.PtrToStringUni(found)));
        return names.Count <= Most;
      };
      if (!EnumResourceNamesExW(module, VersionType, name, IntPtr.Zero, OwnResources, 0)) Ended(names.Count, true);
      var languages = new List<KeyValuePair<IntPtr, ushort>>();
      foreach (var each in names) {
        LanguageFound language = (m, t, n, found, c) => {
          languages.Add(new KeyValuePair<IntPtr, ushort>(each, found));
          return languages.Count <= Most;
        };
        // A name it listed has a language, or the table is malformed.
        if (!EnumResourceLanguagesExW(module, VersionType, each, language, IntPtr.Zero, OwnResources, 0))
          Ended(languages.Count, false);
      }
      var resources = new List<byte[]>();
      foreach (var each in languages) resources.Add(Bytes(module, each.Key, each.Value));
      return resources;
    } finally {
      foreach (var each in names) if (!IsNumber(each)) Marshal.FreeHGlobal(each);
      FreeLibrary(module);
    }
  }
  // "versions <count>", then each version resource the file holds. A file can hold one for each
  // language, and Windows reads the one its resource loader picks for the person's language.
  // That one must be among them, byte for byte, so each is read as Windows reads it.
  static string[] Versions(string path) {
    var embedded = Embedded(path);
    uint unused, size = GetFileVersionInfoSizeExW(Localised, path, out unused);
    if (size == 0) {
      int error = Marshal.GetLastWin32Error();
      if (error < 1812 || error > 1815) throw new IOException("GetFileVersionInfoSizeExW failed", error);
      if (embedded.Count != 0) throw new InvalidDataException("Version resources Windows does not read");
      return new[] { "versions 0" };
    }
    // Windows sizes its copy from the resource's own 16-bit length, so it stays small.
    IntPtr data = Marshal.AllocHGlobal((int)size);
    try {
      if (!GetFileVersionInfoExW(Localised, path, 0, size, data))
        throw new IOException("GetFileVersionInfoExW failed", Marshal.GetLastWin32Error());
      var picked = new byte[Math.Min((ushort)Marshal.ReadInt16(data), (int)size)];
      Marshal.Copy(data, picked, 0, picked.Length);
      if (!embedded.Exists(bytes => Same(bytes, picked)))
        throw new InvalidDataException("Windows reads a version resource the file does not hold");
    } finally {
      Marshal.FreeHGlobal(data);
    }
    var lines = new List<string> { "versions " + embedded.Count };
    foreach (var bytes in embedded) lines.Add(Facts(bytes));
    return lines.ToArray();
  }
  // Makes the folder, failing if anything is there already, with its DACL: owned by this user,
  // inheriting nothing, and one rule giving this user full control.
  static void MakePrivate(string folder) {
    var user = WindowsIdentity.GetCurrent().User;
    var acl = new DirectorySecurity();
    acl.SetOwner(user);
    acl.SetAccessRuleProtection(true, false);
    acl.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
      InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    var descriptor = GCHandle.Alloc(acl.GetSecurityDescriptorBinaryForm(), GCHandleType.Pinned);
    try {
      var security = new Security { size = Marshal.SizeOf(typeof(Security)), descriptor = descriptor.AddrOfPinnedObject() };
      if (!CreateDirectoryW(folder, ref security)) throw new IOException("CreateDirectoryW failed", Marshal.GetLastWin32Error());
    } finally {
      descriptor.Free();
    }
  }
  // The DACL as read back, and nothing in the folder.
  static void CheckPrivate(string folder) {
    var user = WindowsIdentity.GetCurrent().User;
    var made = new DirectoryInfo(folder);
    var actual = made.GetAccessControl();
    var rules = actual.GetAccessRules(true, true, typeof(SecurityIdentifier));
    if (!actual.AreAccessRulesProtected || rules.Count != 1 || made.GetFileSystemInfos().Length != 0
        || (made.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Directory permissions refused");
    var rule = (FileSystemAccessRule)rules[0];
    if (!rule.IdentityReference.Equals(user) || rule.AccessControlType != AccessControlType.Allow
        || rule.FileSystemRights != FileSystemRights.FullControl) throw new IOException("Directory permissions refused");
  }
  // The copy must have the held file's size and SHA-512.
  static void Check(FileStream copy, long length, string sha512) {
    copy.Seek(0, SeekOrigin.Begin);
    string hash;
    using (var sha = SHA512.Create()) hash = Convert.ToBase64String(sha.ComputeHash(copy));
    if (copy.Length != length || hash != sha512) throw new InvalidDataException();
  }
  public static string[] Read(string path, FileStream held, string sha512, string folder) {
    bool made = false;
    try {
      MakePrivate(folder);
      made = true;
      CheckPrivate(folder);
      string copy = Path.Combine(folder, Path.GetFileName(path));
      using (var output = new FileStream(copy, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
        held.Seek(0, SeekOrigin.Begin);
        held.CopyTo(output);
      }
      // Held while Windows reads it, so nothing else can write it or move it.
      using (var hold = new FileStream(copy, FileMode.Open, FileAccess.Read, FileShare.Read, 1)) {
        Check(hold, held.Length, sha512);
        var lines = Versions(copy);
        Check(hold, held.Length, sha512);
        return lines;
      }
    } finally {
      // Only a folder this run made. Removing the copy can't change the answer, and a copy left
      // behind goes with the update folder, which is cleared at the next start and the next check.
      if (made) try { Directory.Delete(folder, true); } catch (IOException) {} catch (UnauthorizedAccessException) {}
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
    public uint index, verified;
    public int result;
    public string digest, subject, root;
    public override string ToString() {
      return "signature " + index + " " + verified + " " + result.ToString("x8") + " " + Encode(digest) + " " + Encode(subject) + " " + (root ?? "-");
    }
  }
  // One embedded signature, picked by its index: the index Windows says it verified, the trust
  // result, the signer's digest algorithm, the leaf's subject and the SHA-256 of the chain's
  // root certificate, all from that signature's own WinVerifyTrust state. The first also counts
  // the ones after it.
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
    // No index, until Windows says which one it verified.
    settings.verified = uint.MaxValue;
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
        var after = (Settings)Marshal.PtrToStructure(data.settings, typeof(Settings));
        secondary = after.secondary;
        var found = new Signature { index = index, verified = after.verified, result = result };
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
  // Whether Windows verified the signature asked for. It names the index it verified for each
  // signature after the first, and none for the first.
  static bool Asked(Signature signature) {
    return signature.verified == signature.index || (signature.index == 0 && signature.verified == uint.MaxValue);
  }
  // The root and subject that every SHA-256 signature names, when every signature is the one
  // asked for and has all its facts, there is a SHA-256 one, Windows trusts each and they agree.
  // windowsRefusal applies the same rule; here it keeps any file that rule refuses away from the
  // version reader.
  static string Publisher(List<Signature> signatures) {
    string found = null;
    foreach (var signature in signatures) {
      if (!Asked(signature) || signature.digest == null
          || string.IsNullOrEmpty(signature.subject) || signature.root == null) return null;
      if (signature.digest != "2.16.840.1.101.3.4.2.1") continue;
      if (signature.result != 0) return null;
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
        if (hash == sha512 && publisher != null && Publisher(installer) == publisher) {
          string folder = Path.Combine(Path.GetDirectoryName(path), ".inspect-" + Path.GetRandomFileName());
          lines.AddRange(UpdateVersions.Read(path, file, sha512, folder));
        } else {
          lines.Add("versions unread");
        }
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
// The verified index the helper starts each call with, which Windows leaves for the first.
const NO_INDEX = "4294967295";
const SIGNATURE =
  /^signature (\d+) (\d+) ([0-9a-f]{8}) (-|[A-Za-z0-9+/]+={0,2}) (-|[A-Za-z0-9+/]+={0,2}) (-|[A-Za-z0-9+/]{43}=)$/;
const RESOURCE = /^resource (-|\d+\.\d+\.\d+\.\d+)((?: (?:-|[A-Za-z0-9+/]+={0,2}))*)$/;

/** One embedded signature, with the index Windows says it verified for the index asked. */
type Signature = {
  index: string;
  verified: string;
  result: string;
  digest: string | null;
  subject: string;
  root: string;
};
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
      index: String(index),
      verified: line[2]!,
      result: line[3]!,
      digest: decode(line[4]!),
      subject: line[5]!,
      root: line[6]!,
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
 * Whether Windows verified the signature asked for. It names the index it verified for each
 * signature after the first, and leaves the field as the helper set it, at no index, for the
 * first.
 */
function asked(signature: Signature) {
  return (
    signature.verified === signature.index ||
    (signature.index === "0" && signature.verified === NO_INDEX)
  );
}

/**
 * The file's SHA-256 signatures, when it has one and Windows trusts each. Every signature the
 * file reports must be the one asked for and name its digest algorithm, signer and root, so
 * none goes unread. A signature with another digest, such as the SHA-1 one
 * electron-builder puts first by default, does not count otherwise. A build signed again later,
 * with a renewed certificate, has two SHA-256 signatures.
 */
function sha256Signatures(signatures: Signature[]) {
  const complete = signatures.every(
    (one) => asked(one) && one.digest && one.subject !== "-" && one.root !== "-",
  );
  const found = signatures.filter((signature) => signature.digest === SHA256);
  return complete && found.length > 0 && found.every((one) => one.result === TRUSTED)
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
 * intermediate under that root, passes; a different root or subject does not. Every version
 * resource the installer holds, one for each language it has, must give the offer's version as
 * the ProductVersion of every translation it lists, and the release's numbers as its fixed
 * product version. Anything unexpected is `inspection-failed`, never a pass.
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
