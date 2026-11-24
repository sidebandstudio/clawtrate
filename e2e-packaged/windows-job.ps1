$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class PackagedJob {
    [StructLayout(LayoutKind.Sequential)]
    private struct Limits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinSet, MaxSet;
        public uint ProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public Limits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32", SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits info, int size);
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, IntPtr buffer, int size, IntPtr used);
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint code);

    private static long[] Members(SafeFileHandle job) {
        for (int count = 16; ; count = checked(count * 2)) {
            int size = checked(8 + count * IntPtr.Size);
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                if (!QueryInformationJobObject(job, 3, buffer, size, IntPtr.Zero)) {
                    var error = new Win32Exception();
                    if (error.NativeErrorCode == 234) continue;
                    throw error;
                }
                var members = new long[Marshal.ReadInt32(buffer, 4)];
                for (int index = 0; index < members.Length; index++)
                    members[index] = Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64();
                return members;
            } finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    private static long[] WaitEmpty(SafeFileHandle job, int milliseconds) {
        var clock = Stopwatch.StartNew();
        long[] members;
        while ((members = Members(job)).Length != 0 && clock.ElapsedMilliseconds < milliseconds)
            Thread.Sleep(50);
        return members;
    }

    public static int Run(string node, string worker) {
        var cancelled = Task.Factory.StartNew(() => Console.OpenStandardInput().ReadByte());
        using (var job = CreateJobObject(IntPtr.Zero, null)) {
            if (job.IsInvalid) throw new Win32Exception();
            var limits = new ExtendedLimits();
            const uint KillOnJobClose = 0x2000;
            limits.Basic.Flags = KillOnJobClose;
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Win32Exception();
            var start = new ProcessStartInfo(node, "\"" + worker + "\"");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            using (var child = Process.Start(start)) {
                if (!AssignProcessToJobObject(job, child.Handle)) {
                    var error = new Win32Exception();
                    child.StandardInput.Close();
                    child.WaitForExit();
                    throw error;
                }
                child.StandardInput.BaseStream.WriteByte(1);
                child.StandardInput.Close();
                while (!child.WaitForExit(50) && !cancelled.IsCompleted) { }
                int status = cancelled.IsCompleted ? 130 : child.ExitCode;
                var left = WaitEmpty(job, cancelled.IsCompleted ? 0 : 1500);
                if (left.Length != 0) {
                    if (!TerminateJobObject(job, 1)) throw new Win32Exception();
                    var survivors = WaitEmpty(job, 5000);
                    if (survivors.Length != 0) throw new Exception("Windows job still contains PIDs: " + string.Join(", ", survivors));
                    if (status == 0) status = 1;
                    Console.Error.WriteLine("Drained Windows job PIDs: " + string.Join(", ", left));
                }
                return status;
            }
        }
    }
}
"@
try {
    $status = [PackagedJob]::Run($env:CLAWTRATE_PACKAGED_NODE, (Join-Path $PSScriptRoot 'windows-worker.ts'))
    Write-Output 'Verified the Windows packaged job has no remaining children'
    & $env:CLAWTRATE_PACKAGED_NODE (Join-Path $PSScriptRoot 'windows-gateway.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Windows pairing cleanup did not finish' }
    exit $status
} catch {
    [Console]::Error.WriteLine("Keeping Windows pairing root: $(Split-Path -Parent $env:CLAWTRATE_PACKAGED_HOME). $_")
    exit 1
}
