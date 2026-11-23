import type { UpdateInstallRefusal } from "@clawtrate/core";
import { runUpdatePowerShell } from "./private-update-directory.ts";
import type { UpdateInstaller, VerifiedArtifact } from "./update/install.ts";

/** The gate the signed upgrade trial lifts (#309). Until then nothing is handed to setup. */
const PENDING_TRIAL = "windows-install-pending-trial";

/** The C# behind the check. `UpdateSignature.Inspect` reads, in one run, the running app's
 * signatures and then the installer's under one handle that denies writes and deletion. NTFS
 * also refuses to rename the file or any folder above it while that handle is open, so the
 * hash, the signatures and the version all come from the same bytes. WinVerifyTrust checks one
 * embedded signature at a time, picked by its index, shows no prompt, skips revocation and
 * downloads nothing: the chain is built from certificates already on this machine and in the
 * signature. Only when the bytes are the ones the engine verified and the installer has the
 * running app's publisher does `UpdateVersions` read the file's own version resources, through
 * the handle: the version API opens the file again by path and can take its strings from a
 * .mui file beside it. Each line is a fact; `windowsRefusal` decides.
 * e2e-updates/windows-authenticode.spec.ts compiles it too, to run the version reader on
 * crafted files. */
export const inspectSource = `
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Microsoft.Win32.SafeHandles;
// The version resources of one file, read through a stream its caller holds. A crafted file
// cannot make it allocate much, loop or run long: it reads at most 1 MiB in all, looks at no
// more than 4096 directory entries and 16 version resources of up to 64 KiB each, reaches each
// directory and data entry once, and keeps every read inside the structure that declares it.
// Past a limit, or anything malformed, is InvalidDataException.
public sealed class UpdateVersions {
  const int MostSections = 96, MostEntries = 4096, MostResources = 16, MostResource = 65536;
  readonly FileStream file;
  readonly Dictionary<uint, bool> seen = new Dictionary<uint, bool>();
  long left = 1 << 20;
  int entries = MostEntries;
  byte[] sections;
  uint tree, treeSize;
  public UpdateVersions(FileStream file) { this.file = file; }
  static uint U32(byte[] bytes, int at) { return BitConverter.ToUInt32(bytes, at); }
  static int U16(byte[] bytes, int at) { return BitConverter.ToUInt16(bytes, at); }
  byte[] Bytes(long at, long count) {
    if (at < 0 || count < 0 || count > left || at > file.Length - count) throw new InvalidDataException();
    left -= count;
    var bytes = new byte[count];
    file.Seek(at, SeekOrigin.Begin);
    for (int done = 0; done < count; ) {
      int read = file.Read(bytes, done, (int)count - done);
      if (read <= 0) throw new IOException();
      done += read;
    }
    return bytes;
  }
  // Bytes at an RVA, all inside one section's raw data.
  byte[] Mapped(uint rva, uint size) {
    for (int at = 0; at < sections.Length; at += 40) {
      uint start = U32(sections, at + 12), raw = U32(sections, at + 16);
      if (rva >= start && rva - start < raw && size <= raw - (rva - start))
        return Bytes(U32(sections, at + 20) + (long)(rva - start), size);
    }
    throw new InvalidDataException();
  }
  // Bytes of the resource tree, inside the size its data directory gives.
  byte[] Tree(uint at, uint size) {
    if (at > treeSize || size > treeSize - at) throw new InvalidDataException();
    return Mapped(tree + at, size);
  }
  void Visit(uint at) {
    if (seen.ContainsKey(at)) throw new InvalidDataException();
    seen.Add(at, true);
  }
  // The targets of an IMAGE_RESOURCE_DIRECTORY's entries: all of them, or the one numbered id.
  // The high bit marks another directory, which every level but the last holds.
  List<uint> Entries(uint at, long id, bool directories) {
    Visit(at);
    var head = Tree(at, 16);
    int named = U16(head, 12), count = named + U16(head, 14);
    if (count > entries) throw new InvalidDataException();
    entries -= count;
    var list = Tree(at + 16, (uint)(8 * count));
    var found = new List<uint>();
    for (int i = 0; i < count; i++) {
      if (id >= 0 && (i < named || U32(list, 8 * i) != id)) continue;
      uint target = U32(list, 8 * i + 4);
      if (((target & 0x80000000) != 0) != directories) throw new InvalidDataException();
      found.Add(target & 0x7fffffff);
    }
    return found;
  }
  struct Node { public string key; public int value, valueEnd, children, end; }
  // A version resource is a tree of nodes: a length, a value's length, a type (1 for text), a
  // key, the value and then the children, each part on a four-byte boundary and inside its
  // parent.
  static List<Node> Nodes(byte[] block, int at, int end) {
    var nodes = new List<Node>();
    // Padding can follow the last node.
    while (end - at >= 6 && U16(block, at) != 0) {
      var node = new Node();
      int length = U16(block, at), key = at + 6, keyEnd = key;
      if (length < 6 || length > end - at) throw new InvalidDataException();
      node.end = at + length;
      for (; ; keyEnd += 2) {
        if (keyEnd + 2 > node.end) throw new InvalidDataException();
        if (U16(block, keyEnd) == 0) break;
      }
      node.key = Encoding.Unicode.GetString(block, key, keyEnd - key);
      node.value = Math.Min((keyEnd + 5) & ~3, node.end);
      node.valueEnd = node.value + U16(block, at + 2) * (U16(block, at + 4) == 1 ? 2 : 1);
      if (node.valueEnd > node.end) throw new InvalidDataException();
      node.children = (node.valueEnd + 3) & ~3;
      nodes.Add(node);
      at = (node.end + 3) & ~3;
    }
    return nodes;
  }
  // One version resource: its fixed product version, then the ProductVersion string of each
  // string table, "-" for a table without one, and "-" for each translation it lists without a
  // table.
  static string Resource(byte[] block) {
    var roots = Nodes(block, 0, block.Length);
    if (roots.Count != 1 || roots[0].key != "VS_VERSION_INFO") throw new InvalidDataException();
    var root = roots[0];
    string product = "-";
    if (root.valueEnd - root.value == 52 && U32(block, root.value) == 0xfeef04bd) {
      uint high = U32(block, root.value + 16), low = U32(block, root.value + 20);
      product = (high >> 16) + "." + (high & 0xffff) + "." + (low >> 16) + "." + (low & 0xffff);
    }
    var tables = new List<string>();
    var versions = new Dictionary<string, string>();
    var translations = new List<string>();
    foreach (var part in Nodes(block, root.children, root.end)) {
      if (part.key == "StringFileInfo") {
        foreach (var table in Nodes(block, part.children, part.end)) {
          string version = null;
          foreach (var text in Nodes(block, table.children, table.end)) {
            if (text.key != "ProductVersion") continue;
            if (version != null) throw new InvalidDataException();
            version = Encoding.Unicode.GetString(block, text.value, text.valueEnd - text.value).TrimEnd('\\0');
          }
          string key = table.key.ToLowerInvariant();
          if (versions.ContainsKey(key)) throw new InvalidDataException();
          versions.Add(key, version == "" ? null : version);
          tables.Add(key);
        }
      } else if (part.key == "VarFileInfo") {
        foreach (var value in Nodes(block, part.children, part.end))
          if (value.key == "Translation")
            for (int at = value.value; at + 4 <= value.valueEnd; at += 4)
              translations.Add(U16(block, at).ToString("x4") + U16(block, at + 2).ToString("x4"));
      }
    }
    var line = new StringBuilder("resource " + product);
    foreach (string key in tables) line.Append(" ").Append(UpdateSignature.Encode(versions[key]));
    foreach (string key in translations) if (!versions.ContainsKey(key)) line.Append(" -");
    return line.ToString();
  }
  // "versions <count>", then a line for each version resource.
  public string[] Read() {
    long pe = U32(Bytes(0x3c, 4), 0);
    var head = Bytes(pe, 24);
    if (U32(head, 0) != 0x4550) throw new InvalidDataException();
    int count = U16(head, 6), optionalSize = U16(head, 20);
    if (count > MostSections) throw new InvalidDataException();
    var optional = Bytes(pe + 24, optionalSize);
    sections = Bytes(pe + 24 + optionalSize, 40 * count);
    // The data directories follow their count; the third is the resource table.
    int directories = optionalSize >= 2 && U16(optional, 0) == 0x20b ? 112 : 96;
    if (optionalSize < directories) throw new InvalidDataException();
    var lines = new List<string>();
    if (U32(optional, directories - 4) >= 3) {
      if (optionalSize < directories + 24) throw new InvalidDataException();
      tree = U32(optional, directories + 16);
      treeSize = U32(optional, directories + 20);
      if (treeSize > uint.MaxValue - tree) throw new InvalidDataException();
      // RT_VERSION is type 16. Each of its names and languages leads to a data entry: an RVA and a size.
      if (treeSize > 0)
        foreach (uint type in Entries(0, 16, true))
          foreach (uint name in Entries(type, -1, true))
            foreach (uint language in Entries(name, -1, false)) {
              Visit(language);
              var entry = Tree(language, 16);
              uint rva = U32(entry, 0), size = U32(entry, 4);
              if (lines.Count == MostResources || size > MostResource || rva < tree) throw new InvalidDataException();
              lines.Add(Resource(Tree(rva - tree, size)));
            }
    }
    lines.Insert(0, "versions " + lines.Count);
    return lines.ToArray();
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
        // Only the bytes the engine verified, signed by the running app's publisher, are parsed.
        if (hash == sha512 && publisher != null && Publisher(installer) == publisher)
          lines.AddRange(new UpdateVersions(file).Read());
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
 * intermediate under that root, passes; a different root or subject does not. Each of its
 * version resources must give the offer's version as the ProductVersion of every translation,
 * and the release's numbers as its fixed product version. Anything unexpected is
 * `inspection-failed`, never a pass.
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
