# Reads the embedded Authenticode signatures of the file SIGNED_FILE names with
# WinVerifyTrust, one signature at a time, for windowsSignature in signing.ts.
# It prints `checked <count>`, then a line for each signature in order:
# `<index> <result> <digest algorithm> <signer's thumbprint>`, with `-` for what a
# signature lacks. It reads no catalog signature, shows no prompt and uses no
# network, so it checks no revocation and fetches no missing certificate.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;

public static class ClawtrateAuthenticode {
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
        public uint cbStruct;
        public IntPtr pcwszFilePath;
        public IntPtr hFile;
        public IntPtr pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SignatureSettings {
        public uint cbStruct;
        public uint dwIndex;
        public uint dwFlags;
        public uint cSecondarySigs;
        public uint dwVerifiedSigIndex;
        public IntPtr pCryptoPolicy;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TrustData {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData;
        public IntPtr pSIPClientData;
        public uint dwUIChoice;
        public uint fdwRevocationChecks;
        public uint dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData;
        public IntPtr pwszURLReference;
        public uint dwProvFlags;
        public uint dwUIContext;
        public IntPtr pSignatureSettings;
    }

    // CRYPT_PROVIDER_SGNR up to psSigner. FILETIME is two DWORDs.
    [StructLayout(LayoutKind.Sequential)]
    struct ProviderSigner {
        public uint cbStruct;
        public uint verifyAsOfLow;
        public uint verifyAsOfHigh;
        public uint csCertChain;
        public IntPtr pasCertChain;
        public uint dwSignerType;
        public IntPtr psSigner;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Blob {
        public uint cbData;
        public IntPtr pbData;
    }

    // CMSG_SIGNER_INFO up to HashAlgorithm.pszObjId.
    [StructLayout(LayoutKind.Sequential)]
    struct SignerInfo {
        public uint dwVersion;
        public Blob issuer;
        public Blob serialNumber;
        public IntPtr hashAlgorithm;
    }

    [DllImport("wintrust.dll", ExactSpelling = true)]
    static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr data, uint signer, bool counterSigner, uint counterSignerIndex);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer, uint cert);

    // WINTRUST_ACTION_GENERIC_VERIFY_V2
    static Guid action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    public static string[] Read(string path) {
        uint secondary;
        var lines = new List<string> { Check(path, 0, out secondary) };
        for (uint index = 1; index <= secondary; index++) {
            uint unused;
            lines.Add(Check(path, index, out unused));
        }
        lines.Insert(0, "checked " + lines.Count);
        return lines.ToArray();
    }

    static string Check(string path, uint index, out uint secondary) {
        IntPtr pathData = Marshal.StringToHGlobalUni(path);
        IntPtr fileData = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
        IntPtr settingsData = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SignatureSettings)));
        var data = new TrustData();
        try {
            var file = new FileInfo();
            file.cbStruct = (uint)Marshal.SizeOf(typeof(FileInfo));
            file.pcwszFilePath = pathData;
            Marshal.StructureToPtr(file, fileData, false);
            var settings = new SignatureSettings();
            settings.cbStruct = (uint)Marshal.SizeOf(typeof(SignatureSettings));
            settings.dwIndex = index;
            // WSS_VERIFY_SPECIFIC, and with the first signature WSS_GET_SECONDARY_SIG_COUNT.
            settings.dwFlags = index == 0 ? 3u : 1u;
            Marshal.StructureToPtr(settings, settingsData, false);
            data.cbStruct = (uint)Marshal.SizeOf(typeof(TrustData));
            data.dwUIChoice = 2;          // WTD_UI_NONE
            data.fdwRevocationChecks = 0; // WTD_REVOKE_NONE
            data.dwUnionChoice = 1;       // WTD_CHOICE_FILE: the file's own signatures, never a catalog's
            data.pFile = fileData;
            data.dwStateAction = 1;       // WTD_STATEACTION_VERIFY
            // WTD_REVOCATION_CHECK_NONE, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_DISABLE_MD2_MD4
            data.dwProvFlags = 0x10 | 0x1000 | 0x2000;
            data.pSignatureSettings = settingsData;
            int result = WinVerifyTrust(new IntPtr(-1), ref action, ref data);
            secondary = ((SignatureSettings)Marshal.PtrToStructure(settingsData, typeof(SignatureSettings))).cSecondarySigs;
            string digest = "-";
            string signer = "-";
            IntPtr provider = data.hWVTStateData == IntPtr.Zero ? IntPtr.Zero : WTHelperProvDataFromStateData(data.hWVTStateData);
            IntPtr found = provider == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(provider, 0, false, 0);
            if (found != IntPtr.Zero) {
                var sgnr = (ProviderSigner)Marshal.PtrToStructure(found, typeof(ProviderSigner));
                if (sgnr.psSigner != IntPtr.Zero) {
                    var info = (SignerInfo)Marshal.PtrToStructure(sgnr.psSigner, typeof(SignerInfo));
                    if (info.hashAlgorithm != IntPtr.Zero) digest = Marshal.PtrToStringAnsi(info.hashAlgorithm);
                }
                // CRYPT_PROVIDER_CERT is a DWORD, then the certificate's context. Index 0 is the leaf.
                IntPtr leaf = WTHelperGetProvCertFromChain(found, 0);
                IntPtr context = leaf == IntPtr.Zero ? IntPtr.Zero : Marshal.ReadIntPtr(leaf, IntPtr.Size);
                if (context != IntPtr.Zero) signer = new X509Certificate2(context).Thumbprint;
            }
            return index + " " + result.ToString("x8") + " " + digest + " " + signer;
        } finally {
            if (data.hWVTStateData != IntPtr.Zero) {
                data.dwStateAction = 2;   // WTD_STATEACTION_CLOSE
                WinVerifyTrust(new IntPtr(-1), ref action, ref data);
            }
            Marshal.FreeHGlobal(settingsData);
            Marshal.FreeHGlobal(fileData);
            Marshal.FreeHGlobal(pathData);
        }
    }
}
'@
[ClawtrateAuthenticode]::Read($env:SIGNED_FILE)
