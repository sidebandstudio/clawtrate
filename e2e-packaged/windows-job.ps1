$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class PackagedJob {
    [DllImport("kernel32", SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint PageFaults, Total, Active, Terminated;
    }
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out Accounting info, int size, IntPtr used);
    public static SafeFileHandle Enter() {
        var job = CreateJobObject(IntPtr.Zero, null);
        using (var self = Process.GetCurrentProcess()) {
            if (job.IsInvalid || !AssignProcessToJobObject(job, self.Handle)) throw new Win32Exception();
        }
        return job;
    }
    public static uint Active(SafeFileHandle job) {
        Accounting info;
        if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
        return info.Active;
    }
}
"@
$job = [PackagedJob]::Enter()
try {
    & $env:CLAWTRATE_PACKAGED_NODE @args
    $status = $LASTEXITCODE
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([PackagedJob]::Active($job) -gt 1 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if ([PackagedJob]::Active($job) -ne 1) { throw 'A Windows packaged check process remains in its job' }
    Write-Output 'Verified the Windows packaged job has no remaining children'
    exit $status
} finally { $job.Dispose() }
