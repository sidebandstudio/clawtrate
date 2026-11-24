$ErrorActionPreference = 'Stop'
$shell = (Get-Process -Id $PID).Path
function Start-Hidden($arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($shell, $arguments)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = $true
    $info.WorkingDirectory = (Get-Location).Path
    [Diagnostics.Process]::Start($info)
}
Add-Type -Namespace Proof -Name Ctrl -MemberDefinition '[DllImport("kernel32")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add);'
if (-not [Proof.Ctrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)) { throw 'cannot enable Ctrl-C' }
$name = 'pairing-proof-' + [guid]::NewGuid().ToString('N')
$env:CLAWTRATE_CANCEL_MARKER = Join-Path $env:RUNNER_TEMP "$name.json"
$step = Join-Path $env:RUNNER_TEMP "$name.ps1"
Set-Content -LiteralPath $step -Value @'
$ErrorActionPreference = 'Stop'
pnpm check:packaged
if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }
'@
$run = Start-Hidden "-command `". '$step'`""
$run.StandardInput.Close()
$out = $run.StandardOutput.ReadToEndAsync()
$err = $run.StandardError.ReadToEndAsync()
function Send-Signal($signal) {
    $script = "Add-Type -Namespace W -Name C -MemberDefinition '[DllImport(""kernel32"")] public static extern bool FreeConsole(); [DllImport(""kernel32"")] public static extern bool AttachConsole(uint pid); [DllImport(""kernel32"")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add); [DllImport(""kernel32"")] public static extern bool GenerateConsoleCtrlEvent(uint signal, uint group);'; [void][W.C]::FreeConsole(); if (-not [W.C]::AttachConsole($($run.Id))) {exit 2}; [void][W.C]::SetConsoleCtrlHandler([IntPtr]::Zero,`$true); if (-not [W.C]::GenerateConsoleCtrlEvent($signal,0)) {exit 3}; exit 0"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $sender = Start-Hidden "-NoProfile -NonInteractive -EncodedCommand $encoded"
    if (-not $sender.WaitForExit(8000) -or ($signal -eq 0 -and $sender.ExitCode -ne 0)) { throw "signal $signal failed" }
}
function Listeners {
    [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port
}
try {
    $until = [DateTime]::UtcNow.AddMinutes(13)
    while (-not (Test-Path -LiteralPath $env:CLAWTRATE_CANCEL_MARKER)) {
        if ($run.HasExited) { throw "step ended before seeding: $($out.Result) $($err.Result)" }
        if ([DateTime]::UtcNow -gt $until) { throw 'timed out before seeding' }
        Start-Sleep -Milliseconds 50
    }
    $owned = Get-Content -Raw -LiteralPath $env:CLAWTRATE_CANCEL_MARKER | ConvertFrom-Json
    $before = @(Listeners)
    foreach ($port in @($owned.gatewayPort, $owned.providerPort)) { if ($port -notin $before) { throw "port $port not listening before cancel" } }
    $processes = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)
    $tree = [Collections.Generic.HashSet[int]]::new()
    [void]$tree.Add($run.Id)
    do {
        $count = $tree.Count
        foreach ($proc in $processes) { if ($tree.Contains($proc.ParentProcessId)) { [void]$tree.Add($proc.ProcessId) } }
    } while ($tree.Count -ne $count)
    if (!$tree.Contains($owned.gateway) -or !$tree.Contains($owned.provider)) { throw 'both marker PIDs must be in the step tree' }
    $handles = @(foreach ($processId in $tree) { $child = Get-Process -Id $processId -ErrorAction SilentlyContinue; if ($child) { $null = $child.Handle; $child } })
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Send-Signal 0
    $ended = 'Ctrl-C'
    if (-not $run.WaitForExit([Math]::Max(0, 7500 - [int]$clock.ElapsedMilliseconds))) {
        Send-Signal 1
        $ended = 'Ctrl-Break'
        if (-not $run.WaitForExit([Math]::Max(0, 10000 - [int]$clock.ElapsedMilliseconds))) {
            & taskkill.exe /T /F /PID $run.Id | Out-Null
            $ended = 'tree termination'
        }
    }
    $until = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $left = @($handles | Where-Object { !$_.HasExited })
        $paths = @($owned.root,$owned.records,$owned.state | Where-Object { Test-Path -LiteralPath $_ })
        $ports = @(Listeners | Where-Object { $_ -in @($owned.gatewayPort,$owned.providerPort) })
        if (!$left.Count -and !$ports.Count -and !$paths.Count) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $until)
    if ($out.IsCompleted) { $out.Result }; if ($err.IsCompleted) { $err.Result }
    if ($left.Count -or $paths.Count -or $ports.Count) { throw "cancel left PIDs $($left.Id), ports $ports, paths $paths" }
    "Verified runner cancellation during seeding via $ended. All $($handles.Count) observed processes exited, both listeners closed and all private paths disappeared."
} finally {
    if (!$run.HasExited) { & taskkill.exe /T /F /PID $run.Id | Out-Null }
    Remove-Item -LiteralPath $step -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $env:CLAWTRATE_CANCEL_MARKER -ErrorAction SilentlyContinue
}
