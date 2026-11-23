# Prints the thumbprint of each certificate in a .pfx that comes with its private
# key, for windowsSigner in signing.ts. Standard input holds the file in base64 on
# its first line and the password's UTF-8 bytes in base64 on its second.
# PFXImportCertStore opens the file as a store in this process's memory, with
# PKCS12_NO_PERSIST_KEY and PKCS12_ALWAYS_CNG_KSP, the flags .NET's
# EphemeralKeySet stands for, so no certificate store or key container gets
# anything and each key ends with the process. It calls Windows itself because
# .NET Framework drops EphemeralKeySet when its DoNotValidateX509KeyStorageFlags
# compatibility switch is on.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;

public static class ClawtrateCertificate {
    [StructLayout(LayoutKind.Sequential)]
    struct Blob {
        public uint cbData;
        public IntPtr pbData;
    }

    [DllImport("crypt32.dll", ExactSpelling = true, SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr PFXImportCertStore(ref Blob pfx, string password, uint flags);

    [DllImport("crypt32.dll", ExactSpelling = true)]
    static extern IntPtr CertEnumCertificatesInStore(IntPtr store, IntPtr previous);

    [DllImport("crypt32.dll", ExactSpelling = true)]
    static extern bool CertGetCertificateContextProperty(IntPtr context, uint property, IntPtr data, ref uint size);

    [DllImport("crypt32.dll", ExactSpelling = true)]
    static extern bool CertCloseStore(IntPtr store, uint flags);

    // PKCS12_NO_PERSIST_KEY | PKCS12_ALWAYS_CNG_KSP
    const uint InMemory = 0x8000 | 0x200;

    public static string[] Keyed(byte[] pfx, string password) {
        IntPtr data = Marshal.AllocHGlobal(pfx.Length);
        try {
            Marshal.Copy(pfx, 0, data, pfx.Length);
            var blob = new Blob();
            blob.cbData = (uint)pfx.Length;
            blob.pbData = data;
            IntPtr store = PFXImportCertStore(ref blob, password, InMemory);
            // A file made without a password takes NULL, not an empty one.
            if (store == IntPtr.Zero && password.Length == 0) store = PFXImportCertStore(ref blob, null, InMemory);
            if (store == IntPtr.Zero) throw new Win32Exception();
            try {
                var keyed = new List<string>();
                IntPtr context = IntPtr.Zero;
                while ((context = CertEnumCertificatesInStore(store, context)) != IntPtr.Zero) {
                    uint size = 0;
                    // CERT_KEY_PROV_INFO_PROP_ID, CERT_KEY_CONTEXT_PROP_ID or CERT_NCRYPT_KEY_HANDLE_PROP_ID.
                    if (CertGetCertificateContextProperty(context, 2, IntPtr.Zero, ref size) ||
                        CertGetCertificateContextProperty(context, 5, IntPtr.Zero, ref size) ||
                        CertGetCertificateContextProperty(context, 78, IntPtr.Zero, ref size)) {
                        keyed.Add(new X509Certificate2(context).Thumbprint);
                    }
                }
                return keyed.ToArray();
            } finally {
                CertCloseStore(store, 0);
            }
        } finally {
            Marshal.FreeHGlobal(data);
        }
    }
}
'@
$lines = [Console]::In.ReadToEnd() -split "`r?`n"
[ClawtrateCertificate]::Keyed([Convert]::FromBase64String($lines[0]), [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($lines[1])))
