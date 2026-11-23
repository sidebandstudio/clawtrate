<#
Installs OpenClaw into private folders on Windows, runs its gateway as a Scheduled Task for a
throwaway profile, removes it all again, and records what happened and what was left behind.
The results go in docs/research/setup-flow.md, section 6.6.

It installs software and registers a service, so it runs only on a discarded GitHub-hosted
runner, through .github/workflows/windows-private-install.yml, and refuses to start anywhere
else. Never run it on a person's computer.

Windows PowerShell 5.1. Keep this file ASCII: 5.1 reads a script without a byte order mark in
the system code page.
#>
param([Parameter(Mandatory = $true)][string]$OutDir)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ProfileName = 'clawtrate-proof'
$TaskName = "OpenClaw Gateway ($ProfileName)"
$OpenClawSpec = 'openclaw@2026.10.6'
$OpenClawVersion = '2026.10.6'
# dist/entry.js in the registry's openclaw-2026.10.6.tgz (integrity sha512-jSpQPa2J...qrxwA==).
$EntrySha256 = '84d9ae4527bb46be0eece8f95cafefa40559cba8bd921e1358998b331cea0d08'
$NodeVersion = '24.22.1'
$NodeZip = "node-v$NodeVersion-win-x64.zip"
$NodeZipSha256 = 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'
# The Node.js releaser who signed v24.22.1's SHASUMS256.txt, and that key as nodejs/release-keys
# publishes it.
$NodeSigner = '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356'
$NodeSignerKeyUrl = "https://raw.githubusercontent.com/nodejs/release-keys/481637f813e912c4aa3622d7964ab426c97b8e8d/keys/$NodeSigner.asc"
$NodeSignerKeySha256 = '5115095e2f8010c75da052ecb1cfb3af630e084f0f8daa93a863557b01b0f90a'

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:OS -ne 'Windows_NT') {
  [Console]::Error.WriteLine('This proof installs software. It runs only on a GitHub-hosted Windows runner.')
  exit 2
}

# Everything the install makes lives under $Root, as the app's own data folder would.
$Root = Join-Path $env:LOCALAPPDATA 'Clawtrate-proof'
$Downloads = Join-Path $Root 'downloads'
$RuntimeDir = Join-Path $Root 'node'
$NodeDir = Join-Path $RuntimeDir "node-v$NodeVersion-win-x64"
$NodeExe = Join-Path $NodeDir 'node.exe'
$NpmCli = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
$Prefix = Join-Path $Root 'openclaw'
$OpenClawEntry = Join-Path $Prefix 'node_modules\openclaw\dist\entry.js'
$NpmDir = Join-Path $Root 'npm'
$NpmCache = Join-Path $NpmDir 'cache'
$NpmUserConfig = Join-Path $NpmDir 'user.npmrc'
$NpmGlobalConfig = Join-Path $NpmDir 'global.npmrc'
# The signature check is the proof's own; the app would carry the hash instead.
$GnupgHome = Join-Path $env:RUNNER_TEMP 'clawtrate-proof-gnupg'
$StateDir = Join-Path $env:USERPROFILE ".openclaw-$ProfileName"
$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$GitUsrBin = Join-Path $env:ProgramFiles 'Git\usr\bin'
$System32 = Join-Path $env:SystemRoot 'System32'

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$LogFile = Join-Path $OutDir 'proof.log'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Steps = New-Object System.Collections.ArrayList
$Checks = [ordered]@{}
$Findings = [ordered]@{}
$ToolchainCheck = "the computer's node, npm, their versions, npm configuration, npmrc files and PATH are unchanged"

function Write-Log([string]$Text) {
  $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('HH:mm:ss'), $Text
  [System.IO.File]::AppendAllText($LogFile, $line + "`r`n", $Utf8)
  Write-Host $line
}

# Hides credentials before they reach the log or the artifact: the values of token, password,
# secret and key settings, and any bare 48-digit hex string, the shape of a gateway token
# (randomToken, <openclaw>/dist/random-token-Sl4a6KEQ.mjs). SHA-256 hashes have 64 and stay.
function Hide-Secrets([string]$Text) {
  if (-not $Text) { return $Text }
  $t = [regex]::Replace($Text, '(?i)([a-z_]*(token|password|secret|api[_-]?key)"?\s*[:=]\s*"?)[^"\s,}]+', '$1[redacted]')
  return [regex]::Replace($t, '\b[0-9a-fA-F]{48}\b', '[redacted]')
}

function Save-Text([string]$Name, [string]$Text) {
  [System.IO.File]::WriteAllText((Join-Path $OutDir $Name), (Hide-Secrets $Text), $Utf8)
}

function Add-Step([string]$Name, [bool]$Ok, [double]$Seconds, $Detail) {
  [void]$Steps.Add([ordered]@{ name = $Name; ok = $Ok; seconds = [math]::Round($Seconds, 1); detail = $Detail })
  Write-Log ('STEP {0}: {1} in {2:N1} s' -f $Name, $(if ($Ok) { 'ok' } else { 'FAILED' }), $Seconds)
}

function Set-Check([string]$Name, [bool]$Ok, $Detail) {
  $Checks[$Name] = [ordered]@{ ok = $Ok; detail = $Detail }
  Write-Log ('CHECK {0}: {1}' -f $Name, $(if ($Ok) { 'yes' } else { 'NO' }))
}

function ConvertTo-Argument([string]$Value) {
  if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

# The environment a child gets. -Clean drops inherited OpenClaw, npm and Node settings, so only
# the values given here reach the private install.
function New-ChildEnvironment([hashtable]$Values, [switch]$Clean) {
  $result = @{}
  foreach ($item in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
    $key = [string]$item.Key
    if ($Clean -and $key -match '^(OPENCLAW_|NPM_CONFIG_|NODE_OPTIONS$|NODE_PATH$)') { continue }
    $result[$key] = [string]$item.Value
  }
  foreach ($key in $Values.Keys) { $result[$key] = [string]$Values[$key] }
  return $result
}

# Runs a program without a shell and returns its exit code and output. A child still running at the
# timeout is ended with its whole tree; this script started it.
function Invoke-Native([string]$File, [string[]]$Arguments, [hashtable]$Environment, [int]$TimeoutSeconds = 300, [string]$RawArguments, [switch]$Quiet) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $File
  if ($RawArguments) { $psi.Arguments = $RawArguments } else { $psi.Arguments = (@($Arguments) | ForEach-Object { ConvertTo-Argument $_ }) -join ' ' }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $psi.WorkingDirectory = $env:RUNNER_TEMP
  if ($Environment) {
    $psi.EnvironmentVariables.Clear()
    foreach ($key in $Environment.Keys) { $psi.EnvironmentVariables[$key] = $Environment[$key] }
  }
  if (-not $Quiet) { Write-Log ('RUN {0} {1}' -f [System.IO.Path]::GetFileName($File), (Hide-Secrets $psi.Arguments)) }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  [void]$process.Start()
  $outTask = $process.StandardOutput.ReadToEndAsync()
  $errTask = $process.StandardError.ReadToEndAsync()
  $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
  if ($timedOut) {
    Write-Log "TIMEOUT after $TimeoutSeconds s; ending process tree $($process.Id)"
    & (Join-Path $System32 'taskkill.exe') /T /F /PID $process.Id | Out-Null
    [void]$process.WaitForExit(15000)
  }
  [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($outTask, $errTask), 15000)
  $stdout = if ($outTask.IsCompleted) { $outTask.Result } else { '[output still open: a child kept it]' }
  $stderr = if ($errTask.IsCompleted) { $errTask.Result } else { '[output still open: a child kept it]' }
  $code = if ($timedOut) { -1 } else { $process.ExitCode }
  $watch.Stop()
  if (-not $Quiet) {
    Write-Log ("EXIT $code after {0:N1} s" -f $watch.Elapsed.TotalSeconds)
    if ($stdout.Trim()) { Write-Log ("STDOUT`r`n" + (Hide-Secrets $stdout.TrimEnd())) }
    if ($stderr.Trim()) { Write-Log ("STDERR`r`n" + (Hide-Secrets $stderr.TrimEnd())) }
  }
  return [pscustomobject]@{ ExitCode = $code; StdOut = $stdout; StdErr = $stderr; Seconds = $watch.Elapsed.TotalSeconds; TimedOut = $timedOut }
}

# A command's JSON: all of its output, or from the first line that opens an object to the end, or
# the last one-line object.
function ConvertFrom-JsonOutput([string]$Text) {
  if (-not $Text) { return $null }
  try { return $Text | ConvertFrom-Json } catch { }
  $start = [regex]::Match($Text, '(?m)^\{')
  if ($start.Success) { try { return $Text.Substring($start.Index) | ConvertFrom-Json } catch { } }
  $found = $null
  foreach ($line in ($Text -split "`r?`n")) { if ($line.Trim().StartsWith('{')) { try { $found = $line | ConvertFrom-Json } catch { } } }
  return $found
}

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'absent' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# The list functions return their array whole (the leading comma), so an empty or one-item list
# stays a list.
function Get-Names([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return , @() }
  return , @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object)
}

function Get-KeyNames([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return , @() }
  return , @(Get-ChildItem -LiteralPath $Path -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName } | Sort-Object)
}

function Get-ValueList([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return , @() }
  $item = Get-Item -LiteralPath $Path
  return , @($item.GetValueNames() | Sort-Object | ForEach-Object { '{0}={1}' -f $_, (Hide-Secrets ([string]$item.GetValue($_, '', 'DoNotExpandEnvironmentNames'))) })
}

# What a new shell on this computer would see: PATH from the registry, the node and npm it finds,
# their versions, npm's configuration and global packages, the npmrc files; and the folders, tasks
# and registry keys around them.
function Get-MachineState {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $shell = New-ChildEnvironment @{ PATH = ((@($machinePath, $userPath) | Where-Object { $_ }) -join ';'); NPM_CONFIG_UPDATE_NOTIFIER = 'false' }
  $cmd = Join-Path $System32 'cmd.exe'
  $run = {
    param($line)
    $r = Invoke-Native $cmd -RawArguments "/d /s /c `"$line`"" -Environment $shell -TimeoutSeconds 120 -Quiet
    'exit {0}: {1}{2}' -f $r.ExitCode, $r.StdOut.Trim(), $(if ($r.StdErr.Trim()) { ' | ' + $r.StdErr.Trim() } else { '' })
  }
  $npmConfig = & $run 'npm config get prefix cache userconfig globalconfig'
  $configFiles = [ordered]@{ 'user .npmrc' = (Join-Path $env:USERPROFILE '.npmrc') }
  foreach ($key in 'userconfig', 'globalconfig') {
    $match = [regex]::Match($npmConfig, "(?m)^$key=(.+?)\s*$")
    if ($match.Success) { $configFiles[$key] = $match.Groups[1].Value }
  }
  $hashes = [ordered]@{}
  foreach ($key in $configFiles.Keys) { $hashes[$key] = '{0} {1}' -f $configFiles[$key], (Get-Sha256 $configFiles[$key]) }
  return [ordered]@{
    toolchain = [ordered]@{
      machinePath = $machinePath
      userPath = $userPath
      whereNode = & $run 'where node'
      whereNpm = & $run 'where npm'
      nodeVersion = & $run 'node --version'
      npmVersion = & $run 'npm --version'
      npmConfig = $npmConfig
      npmGlobalPackages = & $run 'npm ls --global --depth=0'
      npmrcFiles = $hashes
      userEnvironment = Get-ValueList 'HKCU:\Environment'
      machineEnvironmentPath = @((Get-ValueList 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment') -match '^(Path|PATHEXT)=')
    }
    defaultOpenClawFolder = Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.openclaw')
    scheduledTasks = @(Get-ScheduledTask | ForEach-Object { $_.TaskPath + $_.TaskName } | Sort-Object)
    folders = [ordered]@{
      USERPROFILE = Get-Names $env:USERPROFILE
      APPDATA = Get-Names $env:APPDATA
      LOCALAPPDATA = Get-Names $env:LOCALAPPDATA
      TEMP = Get-Names $env:TEMP
      ProgramData = Get-Names $env:ProgramData
      ProgramFiles = Get-Names $env:ProgramFiles
      Startup = Get-Names $StartupDir
      'APPDATA\npm' = Get-Names (Join-Path $env:APPDATA 'npm')
    }
    registry = [ordered]@{
      'HKCU\Software' = Get-KeyNames 'HKCU:\Software'
      'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' = Get-ValueList 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
      'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall' = Get-KeyNames 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
      'HKLM\SOFTWARE' = Get-KeyNames 'HKLM:\SOFTWARE'
    }
  }
}

function Compare-Lists($Before, $After) {
  $b = @($Before | Where-Object { $null -ne $_ })
  $a = @($After | Where-Object { $null -ne $_ })
  return [ordered]@{ added = @($a | Where-Object { $b -notcontains $_ }); removed = @($b | Where-Object { $a -notcontains $_ }) }
}

function Get-FreePort {
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $listener.Stop()
  return $port
}

function Test-Health([int]$Port) {
  try {
    return (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3).StatusCode -eq 200
  } catch {
    return $false
  }
}

# Polls the gateway's unauthenticated /healthz until it answers (or stops answering), and returns
# the seconds that took, or -1 if it never did.
function Wait-Health([int]$Port, [bool]$Up, [int]$Seconds) {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($watch.Elapsed.TotalSeconds -lt $Seconds) {
    if ((Test-Health $Port) -eq $Up) { return [math]::Round($watch.Elapsed.TotalSeconds, 1) }
    Start-Sleep -Seconds 2
  }
  return -1
}

function Get-ListenerProcess([int]$Port) {
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $connection) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
}

function Test-UnderRoot([string]$Path) {
  return [bool]$Path -and $Path.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)
}

# Every process running from the private folders or naming OpenClaw on its command line.
function Get-OpenClawProcesses {
  return , @(Get-CimInstance Win32_Process | Where-Object { (Test-UnderRoot $_.ExecutablePath) -or ($_.CommandLine -match '(?i)openclaw') } |
      ForEach-Object { [ordered]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; path = $_.ExecutablePath; commandLine = (Hide-Secrets $_.CommandLine) } })
}

function Get-TaskReport {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { return $null }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  return [ordered]@{
    state = [string]$task.State
    lastRunTime = [string]$info.LastRunTime
    lastTaskResult = $info.LastTaskResult
    user = $task.Principal.UserId
    logonType = [string]$task.Principal.LogonType
    runLevel = [string]$task.Principal.RunLevel
    triggers = @($task.Triggers | ForEach-Object { '{0} enabled={1}' -f $_.CimClass.CimClassName, $_.Enabled })
    actions = @($task.Actions | ForEach-Object { [ordered]@{ execute = $_.Execute; arguments = $_.Arguments; workingDirectory = $_.WorkingDirectory } })
    restartCount = $task.Settings.RestartCount
    restartInterval = $task.Settings.RestartInterval
    executionTimeLimit = $task.Settings.ExecutionTimeLimit
    multipleInstances = [string]$task.Settings.MultipleInstances
  }
}

function Get-StartupEntries {
  return , @(Get-ChildItem -LiteralPath $StartupDir -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'OpenClaw*' } | ForEach-Object { $_.FullName })
}

$PrivateEnv = New-ChildEnvironment -Clean @{
  PATH = "$NodeDir;$env:PATH"
  NPM_CONFIG_USERCONFIG = $NpmUserConfig
  NPM_CONFIG_GLOBALCONFIG = $NpmGlobalConfig
  NPM_CONFIG_CACHE = $NpmCache
  NPM_CONFIG_PREFIX = $Prefix
  NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
  NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  NPM_CONFIG_FUND = 'false'
  NPM_CONFIG_AUDIT = 'false'
}

function Invoke-OpenClaw([string[]]$Arguments, [int]$TimeoutSeconds = 300) {
  return Invoke-Native $NodeExe (@($OpenClawEntry, '--profile', $ProfileName) + $Arguments) -Environment $PrivateEnv -TimeoutSeconds $TimeoutSeconds
}

function Get-GatewayStatus {
  $r = Invoke-OpenClaw @('gateway', 'status', '--json') 180
  $status = ConvertFrom-JsonOutput $r.StdOut
  if (-not $status) { return [ordered]@{ exitCode = $r.ExitCode; parsed = $false } }
  return [ordered]@{ exitCode = $r.ExitCode; service = $status.service; gateway = $status.gateway; rpc = $status.rpc; port = $status.port }
}

# The gateway after an event: the task's state, what listens on the port, which program that is,
# and every OpenClaw process.
function Get-GatewayView([int]$Port) {
  $listener = Get-ListenerProcess $Port
  return [ordered]@{
    task = Get-TaskReport
    listening = [bool]$listener
    listenerPid = $(if ($listener) { $listener.ProcessId } else { $null })
    listenerPath = $(if ($listener) { $listener.ExecutablePath } else { $null })
    processes = Get-OpenClawProcesses
  }
}

# --- Before anything ---------------------------------------------------------------------------

$os = Get-CimInstance Win32_OperatingSystem
$Findings.environment = [ordered]@{
  windows = '{0} {1}' -f $os.Caption, $os.Version
  powershell = $PSVersionTable.PSVersion.ToString()
  elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  enableLUA = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).EnableLUA
  profile = $ProfileName
  taskName = $TaskName
  root = $Root
  stateDir = $StateDir
}
Write-Log ('Environment: ' + ($Findings.environment | ConvertTo-Json -Compress))

foreach ($path in @($Root, $StateDir)) {
  if (Test-Path -LiteralPath $path) { throw "$path already exists; this proof only works on a fresh runner." }
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw "$TaskName already exists." }

Write-Log 'Recording the machine before the install'
$Before = Get-MachineState
Save-Text 'before.json' ($Before | ConvertTo-Json -Depth 8)

$Port = Get-FreePort
$Findings.port = $Port
$total = [System.Diagnostics.Stopwatch]::StartNew()
$stopped = $null

try {
  # --- 1. Node.js, checked against Node's signed SHASUMS256.txt ---------------------------------
  New-Item -ItemType Directory -Force -Path $Downloads, $GnupgHome, $RuntimeDir, $Prefix, $NpmCache | Out-Null
  [System.IO.File]::WriteAllText($NpmUserConfig, '', $Utf8)
  [System.IO.File]::WriteAllText($NpmGlobalConfig, '', $Utf8)

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $curl = Join-Path $System32 'curl.exe'
  foreach ($pair in @(
      @("https://nodejs.org/dist/v$NodeVersion/$NodeZip", $NodeZip),
      @("https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt", 'SHASUMS256.txt'),
      @("https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt.sig", 'SHASUMS256.txt.sig'),
      @($NodeSignerKeyUrl, 'signer.asc'))) {
    $r = Invoke-Native $curl @('--fail', '--silent', '--show-error', '--location', '--retry', '3', '--output', (Join-Path $Downloads $pair[1]), $pair[0])
    if ($r.ExitCode -ne 0) { throw "Download failed: $($pair[0])" }
  }
  Add-Step 'download Node.js' $true $watch.Elapsed.TotalSeconds $null

  # Git for Windows' gpg takes POSIX paths, and its keyring is a folder of the proof's own.
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $zipHash = Get-Sha256 (Join-Path $Downloads $NodeZip)
  $keyHash = Get-Sha256 (Join-Path $Downloads 'signer.asc')
  $listed = [regex]::Match([System.IO.File]::ReadAllText((Join-Path $Downloads 'SHASUMS256.txt')), "(?m)^([0-9a-f]{64})  $([regex]::Escape($NodeZip))$").Groups[1].Value
  $cygpath = Join-Path $GitUsrBin 'cygpath.exe'
  $toPosix = { param($p) (Invoke-Native $cygpath @('-u', $p) -Quiet).StdOut.Trim() }
  $gpgEnv = New-ChildEnvironment @{ GNUPGHOME = (& $toPosix $GnupgHome) }
  $gpg = Join-Path $GitUsrBin 'gpg.exe'
  [void](Invoke-Native $gpg @('--batch', '--import', (& $toPosix (Join-Path $Downloads 'signer.asc'))) -Environment $gpgEnv)
  $verify = Invoke-Native $gpg @('--batch', '--status-fd', '1', '--verify', (& $toPosix (Join-Path $Downloads 'SHASUMS256.txt.sig')), (& $toPosix (Join-Path $Downloads 'SHASUMS256.txt'))) -Environment $gpgEnv
  [void](Invoke-Native (Join-Path $GitUsrBin 'gpgconf.exe') @('--kill', 'all') -Environment $gpgEnv)
  $signed = $verify.ExitCode -eq 0 -and $verify.StdOut -match "\[GNUPG:\] VALIDSIG $NodeSigner "
  $nodeChecked = $keyHash -eq $NodeSignerKeySha256 -and $signed -and $listed -eq $NodeZipSha256 -and $zipHash -eq $NodeZipSha256
  Add-Step 'check Node.js' $nodeChecked $watch.Elapsed.TotalSeconds ([ordered]@{ zip = $zipHash; listed = $listed; pinned = $NodeZipSha256; signerKey = $keyHash; signatureValid = $signed })
  Set-Check 'the Node.js download matches the pinned hash and the signed SHASUMS256.txt' $nodeChecked $null
  if (-not $nodeChecked) { throw 'Node.js did not match; nothing was extracted.' }

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-Native (Join-Path $System32 'tar.exe') @('-xf', (Join-Path $Downloads $NodeZip), '-C', $RuntimeDir)
  $version = (Invoke-Native $NodeExe @('--version') -Environment $PrivateEnv).StdOut.Trim()
  $npmVersion = (Invoke-Native $NodeExe @($NpmCli, '--version') -Environment $PrivateEnv).StdOut.Trim()
  Add-Step 'unpack Node.js' ($r.ExitCode -eq 0 -and $version -eq "v$NodeVersion") $watch.Elapsed.TotalSeconds ([ordered]@{ node = $version; npm = $npmVersion })
  if ($version -ne "v$NodeVersion") { throw 'The private Node.js does not run.' }

  # --- 2. OpenClaw, with that runtime's npm, a private prefix, cache and configuration -----------
  # As OpenClaw's own install-cli.sh does: a global install into a prefix of its own, allowing
  # lifecycle scripts for openclaw alone, as its installers do for npm 11.16 and later.
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-Native $NodeExe @($NpmCli, 'install', '--global', '--prefix', $Prefix, '--cache', $NpmCache, '--userconfig', $NpmUserConfig, '--globalconfig', $NpmGlobalConfig, '--no-fund', '--no-audit', '--allow-scripts=openclaw', $OpenClawSpec) -Environment $PrivateEnv -TimeoutSeconds 1200
  $pending = Test-Path -LiteralPath (Join-Path $Prefix 'node_modules\openclaw\.openclaw-lifecycle-pending')
  $guard = Test-Path -LiteralPath (Join-Path $Prefix 'node_modules\openclaw\dist\openclaw-install-guard')
  $entryHash = Get-Sha256 $OpenClawEntry
  $installed = $r.ExitCode -eq 0 -and $entryHash -eq $EntrySha256 -and -not $pending -and -not $guard
  Add-Step 'install OpenClaw' $installed $watch.Elapsed.TotalSeconds ([ordered]@{ exitCode = $r.ExitCode; entrySha256 = $entryHash; lifecyclePending = $pending; installGuard = $guard; npmSays = ([regex]::Match($r.StdOut, 'added \d+ packages[^\r\n]*')).Value })
  Set-Check 'npm installed exactly the pinned OpenClaw, with its lifecycle scripts complete' $installed $null
  if (-not $installed) { throw 'OpenClaw did not install.' }
  $size = Invoke-Native $NodeExe @('-e', 'const fs = require("fs"), path = require("path"); let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else n += fs.lstatSync(f).size; } }; walk(process.argv[1]); console.log(n)', $Root) -Environment $PrivateEnv -Quiet
  $Findings.installSizeMB = [math]::Round([double]$size.StdOut.Trim() / 1MB, 0)

  # --- 3. The version, then onboarding, which registers and starts the Scheduled Task ------------
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-OpenClaw @('--version') 300
  Add-Step 'openclaw --version' ($r.ExitCode -eq 0 -and $r.StdOut -match [regex]::Escape($OpenClawVersion)) $watch.Elapsed.TotalSeconds ($r.StdOut.Trim())

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-OpenClaw @('onboard', '--non-interactive', '--accept-risk', '--auth-choice', 'skip', '--gateway-bind', 'loopback', '--gateway-auth', 'token', '--gateway-port', [string]$Port, '--install-daemon', '--skip-skills', '--json') 900
  $onboard = ConvertFrom-JsonOutput $r.StdOut
  Add-Step 'onboard with --install-daemon' ($r.ExitCode -eq 0 -and $onboard -and $onboard.ok -eq $true) $watch.Elapsed.TotalSeconds ([ordered]@{ exitCode = $r.ExitCode; json = $onboard })
  $Findings.startupMode = ([regex]::Match($r.StdOut + $r.StdErr, 'Startup mode:[^\r\n]*')).Value

  # --- 4. The task, the program it runs, and the gateway answering on its port --------------------
  $Findings.afterOnboard = Get-GatewayView $Port
  $Findings.afterOnboard.health = Test-Health $Port
  $Findings.afterOnboard.status = Get-GatewayStatus
  $Findings.startupEntries = Get-StartupEntries
  $task = $Findings.afterOnboard.task
  Set-Check 'a Scheduled Task named for the profile exists' ([bool]$task) $TaskName
  Set-Check 'the gateway answers /healthz on its port' ([bool]$Findings.afterOnboard.health) $Port
  $listenerPath = [string]$Findings.afterOnboard.listenerPath
  Set-Check 'the listening gateway runs the private node.exe' ($listenerPath -ieq $NodeExe) $listenerPath
  $xml = Export-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($xml) { Save-Text 'task.xml' $xml }
  $launcher = Join-Path $StateDir 'gateway.cmd'
  if (Test-Path -LiteralPath $launcher) {
    $content = [System.IO.File]::ReadAllText($launcher)
    Save-Text 'gateway.cmd.txt' $content
    $runsPrivate = $content.IndexOf($NodeExe, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $content.IndexOf($Prefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    Set-Check 'gateway.cmd runs the private node.exe and the private OpenClaw' $runsPrivate $null
  }

  # --- 5. Restarts ---------------------------------------------------------------------------
  if (-not $task) {
    Write-Log 'No Scheduled Task was registered; the restart checks are skipped.'
  } else {
    # a. The gateway process is killed. Does anything start it again by itself? Task Scheduler's
    #    RestartOnFailure is set to every minute, three times, so wait past two intervals.
    if ($Findings.afterOnboard.listening) {
      Stop-Process -Id $Findings.afterOnboard.listenerPid -Force
      $back = Wait-Health $Port $true 150
      $Findings.afterKill = Get-GatewayView $Port
      $Findings.afterKill.backAfterSeconds = $back
      Add-Step 'kill the gateway process, then wait 150 s for it to come back by itself' ($back -ge 0) 150 $back
    }

    # b. The task is started, as a logon or boot trigger starts it: the same action and principal.
    #    The trigger itself isn't fired; a runner can't log its user on again or reboot.
    if (-not (Test-Health $Port)) {
      $state = [string](Get-ScheduledTask -TaskName $TaskName).State
      if ($state -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 3 }
      $watch = [System.Diagnostics.Stopwatch]::StartNew()
      Start-ScheduledTask -TaskName $TaskName
      $up = Wait-Health $Port $true 300
      Add-Step 'start the task after the kill' ($up -ge 0) $watch.Elapsed.TotalSeconds ([ordered]@{ taskStateBefore = $state; upAfterSeconds = $up })
      Set-Check 'starting the task brings the gateway back' ($up -ge 0) $up
    }

    # c. The task is ended through Task Scheduler, then started again.
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    Stop-ScheduledTask -TaskName $TaskName
    $down = Wait-Health $Port $false 60
    Start-Sleep -Seconds 5
    $Findings.afterEnd = Get-GatewayView $Port
    $Findings.afterEnd.downAfterSeconds = $down
    $survivors = @($Findings.afterEnd.processes | Where-Object { Test-UnderRoot $_.path })
    Add-Step 'end the task' ($down -ge 0 -and $survivors.Count -eq 0) $watch.Elapsed.TotalSeconds $down
    Set-Check 'ending the task stops the gateway and every process it started' ($down -ge 0 -and $survivors.Count -eq 0) $survivors
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    Start-ScheduledTask -TaskName $TaskName
    $up = Wait-Health $Port $true 300
    $Findings.afterRestart = Get-GatewayView $Port
    $Findings.afterRestart.status = Get-GatewayStatus
    Add-Step 'start the task after ending it' ($up -ge 0) $watch.Elapsed.TotalSeconds $up
  }
} catch {
  $stopped = $_.Exception.Message
  Write-Log "STOPPED: $stopped"
} finally {
  # --- 6. Removal ---------------------------------------------------------------------------
  if (Test-Path -LiteralPath $OpenClawEntry) {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-OpenClaw @('uninstall', '--service', '--state', '--workspace', '--yes', '--non-interactive') 600
    Add-Step 'openclaw uninstall --service --state --workspace' ($r.ExitCode -eq 0) $watch.Elapsed.TotalSeconds $r.ExitCode
    $Findings.afterUninstall = [ordered]@{
      exitCode = $r.ExitCode
      task = Get-TaskReport
      startupEntries = Get-StartupEntries
      stateDirExists = Test-Path -LiteralPath $StateDir
      stateDirContents = @(Get-ChildItem -LiteralPath $StateDir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($StateDir.Length) })
      listening = [bool](Get-ListenerProcess $Port)
      processes = Get-OpenClawProcesses
    }
  }

  # Whatever uninstall left of this profile's service, the proof removes and records.
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Log 'The task is still registered; removing it with Unregister-ScheduledTask'
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    $Findings.taskRemovedByProof = $true
  }
  foreach ($startupEntry in Get-StartupEntries) {
    if ([System.IO.Path]::GetFileName($startupEntry) -like "OpenClaw Gateway ($ProfileName).*") {
      Remove-Item -LiteralPath $startupEntry -Force
      Write-Log "Removed a Startup entry: $startupEntry"
    }
  }
  $survivors = @(Get-OpenClawProcesses | Where-Object { Test-UnderRoot $_.path })
  $Findings.processesStoppedByProof = $survivors
  foreach ($p in $survivors) { Stop-Process -Id $p.pid -Force -ErrorAction SilentlyContinue }

  # A state folder that uninstall couldn't remove: try again now that uninstall has exited.
  if (Test-Path -LiteralPath $StateDir) {
    $attempts = New-Object System.Collections.ArrayList
    for ($i = 1; $i -le 6 -and (Test-Path -LiteralPath $StateDir); $i++) {
      try {
        if (@(Get-ChildItem -LiteralPath $StateDir -Force).Count -eq 0) { [System.IO.Directory]::Delete($StateDir, $false) } else { Remove-Item -LiteralPath $StateDir -Recurse -Force }
        [void]$attempts.Add("attempt $i removed it")
      } catch {
        [void]$attempts.Add("attempt $i failed: $($_.Exception.Message)")
        Start-Sleep -Seconds 5
      }
    }
    $Findings.stateDirRemovalByProof = $attempts
  }

  # The private folders. Node removes the deep npm trees; the rest has short paths.
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  if (Test-Path -LiteralPath $NodeExe) {
    foreach ($dir in @($Prefix, $NpmDir)) {
      [void](Invoke-Native $NodeExe @('-e', 'require("fs").rmSync(process.argv[1], { recursive: true, force: true })', $dir) -Environment $PrivateEnv)
    }
  }
  try { Remove-Item -LiteralPath $Root -Recurse -Force } catch { Write-Log "Removing $Root failed: $($_.Exception.Message)" }
  Add-Step 'remove the private folders' (-not (Test-Path -LiteralPath $Root)) $watch.Elapsed.TotalSeconds $null
  Set-Check 'the private folders are gone' (-not (Test-Path -LiteralPath $Root)) $Root

  # --- 7. What is left, and whether the computer's Node.js, npm and PATH changed ------------------
  Write-Log 'Recording the machine after removal'
  $After = Get-MachineState
  Save-Text 'after.json' ($After | ConvertTo-Json -Depth 8)

  $toolchainChanges = [ordered]@{}
  foreach ($key in $Before.toolchain.Keys) {
    if (($Before.toolchain[$key] | ConvertTo-Json -Depth 4 -Compress) -ne ($After.toolchain[$key] | ConvertTo-Json -Depth 4 -Compress)) {
      $toolchainChanges[$key] = [ordered]@{ before = $Before.toolchain[$key]; after = $After.toolchain[$key] }
    }
  }
  Set-Check $ToolchainCheck ($toolchainChanges.Count -eq 0) $toolchainChanges

  $diff = [ordered]@{ scheduledTasks = Compare-Lists $Before.scheduledTasks $After.scheduledTasks }
  foreach ($key in $Before.folders.Keys) { $diff["folder $key"] = Compare-Lists $Before.folders[$key] $After.folders[$key] }
  foreach ($key in $Before.registry.Keys) { $diff["registry $key"] = Compare-Lists $Before.registry[$key] $After.registry[$key] }
  $Findings.addedOrRemoved = $diff

  # The gateway's log is written under the temporary folder on Windows. Its last lines go into the
  # artifact; the files stay, as a person's computer would keep them.
  $tempFiles = @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'openclaw*' -Force -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.PSIsContainer) { Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue } else { $_ }
    })
  foreach ($log in @($tempFiles | Where-Object { $_.Name -like "*$ProfileName*" } | Select-Object -First 3)) {
    Save-Text ('gateway-log-tail-{0}.txt' -f $log.Name) ((Get-Content -LiteralPath $log.FullName -Tail 300 -ErrorAction SilentlyContinue) -join "`r`n")
  }
  $left = [ordered]@{
    task = [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
    startupEntries = Get-StartupEntries
    stateDir = Test-Path -LiteralPath $StateDir
    privateFolders = Test-Path -LiteralPath $Root
    defaultOpenClawFolderCreated = (-not $Before.defaultOpenClawFolder) -and (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.openclaw'))
    tempFiles = @($tempFiles | ForEach-Object { $_.FullName })
    listening = [bool](Get-ListenerProcess $Port)
    processes = Get-OpenClawProcesses
    namedAdditions = @($diff.Keys | ForEach-Object { $k = $_; @($diff[$k].added) | Where-Object { $_ -match '(?i)openclaw|clawtrate|npm|node' } | ForEach-Object { "$k\$_" } })
  }
  $Findings.leftAfterRemoval = $left
  $nothingLeft = -not $left.task -and $left.startupEntries.Count -eq 0 -and -not $left.stateDir -and -not $left.privateFolders -and -not $left.defaultOpenClawFolderCreated -and $left.tempFiles.Count -eq 0 -and -not $left.listening -and $left.processes.Count -eq 0 -and $left.namedAdditions.Count -eq 0
  Set-Check 'nothing of OpenClaw, npm or the proof is left' $nothingLeft $left

  Save-Text 'summary.json' ([ordered]@{
      completed = -not $stopped
      stoppedAt = $stopped
      totalSeconds = [math]::Round($total.Elapsed.TotalSeconds, 0)
      checks = $Checks
      steps = $Steps
      findings = $Findings
    } | ConvertTo-Json -Depth 10)
  Write-Log '--- Summary ---'
  foreach ($step in $Steps) { Write-Log ('{0,-72} {1,-6} {2,7:N1} s' -f $step.name, $(if ($step.ok) { 'ok' } else { 'FAILED' }), $step.seconds) }
  foreach ($name in $Checks.Keys) { Write-Log ('{0,-104} {1}' -f $name, $(if ($Checks[$name].ok) { 'yes' } else { 'NO' })) }
}

# The run fails when the proof couldn't finish or the computer's own toolchain changed. Every other
# result is a finding, recorded in summary.json.
if ($stopped -or -not $Checks[$ToolchainCheck].ok) { exit 1 }
exit 0
