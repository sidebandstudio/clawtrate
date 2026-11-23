import type { UpdateInstallRefusal } from "@clawtrate/core";
import { runUpdatePowerShell } from "./private-update-directory.ts";
import type { UpdateInstaller, VerifiedArtifact } from "./update/install.ts";

/** The gate the signed upgrade trial lifts (#309). Until then nothing is handed to setup. */
const PENDING_TRIAL = "windows-install-pending-trial";

/** Reads, in one run, the running app's signatures and then the installer's under one handle
 * that denies writes and deletion. NTFS also refuses to rename the file or any folder above
 * it while that handle is open, so the hash, the signatures and the version all come from the
 * same bytes. WinVerifyTrust checks one embedded signature at a time, picked by its index,
 * shows no prompt, skips revocation and downloads nothing: the chain is built from
 * certificates already on this machine and in the signature. The version comes from the
 * file's own version resource, read through the handle: the version API opens the file again
 * by path and can take its strings from a .mui file beside it. Each line is a fact;
 * `windowsRefusal` decides. */
const inspectWindows = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
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
  static string Encode(string text) {
    return text == null ? "-" : Convert.ToBase64String(Encoding.UTF8.GetBytes(text));
  }
  // One embedded signature, picked by its index: the trust result, the signer's digest
  // algorithm, the leaf's subject and the SHA-256 of the chain's root certificate, all from
  // that signature's own WinVerifyTrust state. The first also counts the ones after it.
  static string Trust(string path, FileStream held, uint index, out uint secondary) {
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
        string digest = "-", subject = "-", root = "-";
        IntPtr provider = data.state == IntPtr.Zero ? IntPtr.Zero : WTHelperProvDataFromStateData(data.state);
        IntPtr signer = provider == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(provider, 0, false, 0);
        if (signer != IntPtr.Zero) {
          var state = (Signer)Marshal.PtrToStructure(signer, typeof(Signer));
          if (state.info != IntPtr.Zero) {
            var info = (SignerInfo)Marshal.PtrToStructure(state.info, typeof(SignerInfo));
            if (info.digest != IntPtr.Zero) digest = Encode(Marshal.PtrToStringAnsi(info.digest));
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
            subject = Encode(leaf.Subject);
            using (var sha = SHA256.Create()) root = Convert.ToBase64String(sha.ComputeHash(last.RawData));
          }
        }
        return "signature " + index + " " + result.ToString("x8") + " " + digest + " " + subject + " " + root;
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
  static void Signatures(List<string> lines, string name, string path, FileStream held) {
    uint more, unused;
    var found = new List<string> { Trust(path, held, 0, out more) };
    for (uint index = 1; index <= more; index++) found.Add(Trust(path, held, index, out unused));
    lines.Add(name + " " + found.Count);
    lines.AddRange(found);
  }
  static byte[] Read(FileStream file, long at, long count) {
    if (at < 0 || count < 0 || at + count > file.Length) throw new InvalidDataException();
    var bytes = new byte[count];
    file.Seek(at, SeekOrigin.Begin);
    for (int done = 0; done < count; ) {
      int read = file.Read(bytes, done, (int)count - done);
      if (read <= 0) throw new IOException();
      done += read;
    }
    return bytes;
  }
  static uint U32(byte[] bytes, long at) { return BitConverter.ToUInt32(bytes, (int)at); }
  static int U16(byte[] bytes, long at) { return BitConverter.ToUInt16(bytes, (int)at); }
  // The offsets an IMAGE_RESOURCE_DIRECTORY's entries point to: all of them, or the one whose
  // number is id. The high bit marks another directory, which every level but the last holds.
  static List<long> Entries(byte[] tree, long at, long id, bool directories) {
    var found = new List<long>();
    int named = U16(tree, at + 12), count = named + U16(tree, at + 14);
    for (int i = 0; i < count; i++) {
      long entry = at + 16 + 8 * i;
      if (id >= 0 && (i < named || U32(tree, entry) != id)) continue;
      uint target = U32(tree, entry + 4);
      if (((target & 0x80000000) != 0) != directories) throw new InvalidDataException();
      found.Add(target & 0x7fffffff);
    }
    return found;
  }
  // A version resource is a tree of nodes: a length, a value's length, a type (1 for text), a
  // key, the value and then the children, each part on a four-byte boundary. ProductVersion is
  // a string in a table under VS_VERSION_INFO's StringFileInfo.
  static void ProductVersions(byte[] block, int at, int end, int depth, List<string> found) {
    while (at < end) {
      int length = U16(block, at), next = at + length, key = at + 6, keyEnd = key;
      // Padding after the last node.
      if (length == 0) break;
      if (length < 6 || next > end) throw new InvalidDataException();
      while (U16(block, keyEnd) != 0) keyEnd += 2;
      string name = Encoding.Unicode.GetString(block, key, keyEnd - key);
      int value = (keyEnd + 5) & ~3, valueEnd = value + U16(block, at + 2) * (U16(block, at + 4) == 1 ? 2 : 1);
      if (valueEnd > next) throw new InvalidDataException();
      if (depth == 3) {
        if (name == "ProductVersion") found.Add(Encoding.Unicode.GetString(block, value, valueEnd - value).TrimEnd('\\0'));
      } else if (depth == 2 || name == (depth == 0 ? "VS_VERSION_INFO" : "StringFileInfo")) {
        ProductVersions(block, (valueEnd + 3) & ~3, next, depth + 1, found);
      }
      at = (next + 3) & ~3;
    }
  }
  // The ProductVersion that every version resource in the file gives, read through the held
  // stream. Null when there is none, when two differ, or when the file is not one Windows could
  // read them from.
  static string Version(FileStream file) {
    try {
      long pe = U32(Read(file, 0x3c, 4), 0);
      var head = Read(file, pe, 24);
      if (U32(head, 0) != 0x4550) return null;
      int sections = U16(head, 6), optionalSize = U16(head, 20);
      var optional = Read(file, pe + 24, optionalSize);
      var table = Read(file, pe + 24 + optionalSize, 40 * sections);
      // The data directories follow their count; the third is the resource table.
      int directories = U16(optional, 0) == 0x20b ? 112 : 96;
      if (U32(optional, directories - 4) < 3) return null;
      Func<uint, uint, byte[]> mapped = (rva, size) => {
        for (int i = 0; i < sections; i++) {
          uint start = U32(table, 40 * i + 12), raw = U32(table, 40 * i + 16);
          if (rva >= start && rva - start < raw && size <= raw - (rva - start))
            return Read(file, U32(table, 40 * i + 20) + (long)(rva - start), size);
        }
        throw new InvalidDataException();
      };
      var tree = mapped(U32(optional, directories + 16), U32(optional, directories + 20));
      var found = new List<string>();
      // RT_VERSION is type 16. Each of its names and languages leads to a data entry: an RVA and a size.
      foreach (long type in Entries(tree, 0, 16, true))
        foreach (long name in Entries(tree, type, -1, true))
          foreach (long language in Entries(tree, name, -1, false)) {
            var block = mapped(U32(tree, language), U32(tree, language + 4));
            ProductVersions(block, 0, block.Length, 0, found);
          }
      return found.Count > 0 && found.TrueForAll(version => version == found[0]) ? found[0] : null;
    } catch (InvalidDataException) {
      return null;
    } catch (ArgumentException) {
      return null;
    }
  }
  public static string[] Inspect(string path, long expected, string running) {
    var lines = new List<string>();
    Signatures(lines, "running", running, null);
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
        string version = Encode(Version(file));
        Signatures(lines, "installer", final.ToString(), file);
        lines.Add("version " + version);
      }
    }
    return lines.ToArray();
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

export const inspectWithPowerShell: InspectWindowsFile = async (file, runningApp, signal) =>
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
// The signer's digest algorithm, as CMSG_SIGNER_INFO names it.
const SHA256 = "2.16.840.1.101.3.4.2.1";
const SIGNATURE =
  /^signature (\d+) ([0-9a-f]{8}) (-|[A-Za-z0-9+/]+={0,2}) (-|[A-Za-z0-9+/]+={0,2}) (-|[A-Za-z0-9+/]{43}=)$/;

type Signature = { result: string; digest: string | null; subject: string; root: string };

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
 * The file's one SHA-256 signature, when Windows trusts it and it names a signer. A signature
 * with another digest, such as the SHA-1 one electron-builder puts first by default, does not
 * count. No build has two SHA-256 signatures, and with two there is no one signer to compare.
 */
function sha256Signer(signatures: Signature[]) {
  const found = signatures.filter((signature) => signature.digest === SHA256);
  const only = found.length === 1 ? found[0]! : null;
  return only?.result === TRUSTED && only.subject !== "-" && only.root !== "-" ? only : null;
}

/**
 * What the helper's facts mean for this download. The installer must have the running app's
 * publisher: a leaf certificate with the same subject whose chain ends at the same root, both
 * trusted by Windows, read from each file's SHA-256 signature. A renewed certificate, or one
 * from a new intermediate under that root, passes; a different root or subject does not.
 * Anything unexpected is `inspection-failed`, never a pass.
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
  const version = /^version (-|[A-Za-z0-9+/]+={0,2})$/.exec(lines.shift() ?? "");
  if (lines.length || !running || !held || !installer || !version) return "inspection-failed";
  if (running[0]!.result === NOT_SIGNED) return "build-not-signed";
  const app = sha256Signer(running);
  if (!app) return "running-signature-untrusted";
  if (held[1] !== file.identity || held[2] !== String(file.size) || held[3] !== file.sha512)
    return "artifact-changed";
  const setup = sha256Signer(installer);
  if (!setup) return "windows-signature";
  if (setup.subject !== app.subject || setup.root !== app.root) return "windows-publisher";
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
