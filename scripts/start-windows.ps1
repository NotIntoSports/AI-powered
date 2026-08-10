[CmdletBinding()]
param(
    [int]$Port = 3000,
    [switch]$SkipObs,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsRoot = Join-Path $workspace '.tools'
$logsRoot = Join-Path $toolsRoot 'logs'
$nextPidPath = Join-Path $toolsRoot 'next.pid'
$obsPasswordPath = Join-Path $toolsRoot 'obs-websocket-password.protected'
$envPath = Join-Path $workspace '.env.local'

function Get-EnvFileValue([string]$Key) {
    if (-not (Test-Path -LiteralPath $envPath)) { return $null }
    $prefix = "$Key="
    $line = Get-Content -LiteralPath $envPath |
        Where-Object { $_.StartsWith($prefix, [StringComparison]::Ordinal) } |
        Select-Object -Last 1
    if ($line) { return $line.Substring($prefix.Length).Trim() }
    return $null
}

function Test-AppReady([int]$TargetPort) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$TargetPort/api/health" -TimeoutSec 2
        if ($response.StatusCode -ne 200) { return $false }
        $health = $response.Content | ConvertFrom-Json
        return $health.service -eq 'authorized-interview-screen-helper' -and $health.status -eq 'ok'
    } catch {
        return $false
    }
}

function Get-PortOwner([int]$TargetPort) {
    $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
    foreach ($line in (& $netstat -ano -p tcp)) {
        if ($line -match "^\s*TCP\s+\S+:$TargetPort\s+\S+\s+LISTENING\s+(\d+)\s*$") {
            return [int]$Matches[1]
        }
    }
    return $null
}

$npm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
$node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
$nodeVersion = if ($node) { (& $node.Source --version).Trim() } else { '' }
$nodeMajor = if ($nodeVersion -match '^v(\d+)') { [int]$Matches[1] } else { 0 }
if (-not $npm -or $nodeMajor -lt 22) {
    throw 'Node.js 22 LTS or newer and npm are required. Run First-Time-Setup.cmd.'
}
if (-not (Test-Path -LiteralPath (Join-Path $workspace 'node_modules\next\package.json'))) {
    throw 'Project dependencies are missing. Run npm run setup:windows first.'
}

New-Item -ItemType Directory -Force -Path $toolsRoot, $logsRoot | Out-Null
$env:AI_INTERVIEW_OBS_MANAGED = '0'
$env:AI_INTERVIEW_OBS_PASSWORD = ''

$provider = Get-EnvFileValue 'TRANSCRIPTION_PROVIDER'
if ($provider -eq 'whisper-cpp') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-whisper.ps1') -Background
    if ($LASTEXITCODE -ne 0) { throw 'Could not start whisper-server.' }
}

if (-not $SkipObs) {
    $obsPath = @(
        (Join-Path $env:ProgramFiles 'obs-studio\bin\64bit\obs64.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\obs-studio\bin\64bit\obs64.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($obsPath -and -not (Get-Process 'obs64' -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath $obsPasswordPath) {
            $protectedPassword = (Get-Content -Raw -LiteralPath $obsPasswordPath).Trim()
            $obsPassword = $protectedPassword |
                powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
                    -File (Join-Path $PSScriptRoot 'dpapi-secret.ps1') -Mode Unprotect
            if ($LASTEXITCODE -ne 0 -or -not $obsPassword) {
                throw 'Could not decrypt the local OBS WebSocket password.'
            }
        } else {
            $randomBytes = New-Object byte[] 32
            $random = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $random.GetBytes($randomBytes) } finally { $random.Dispose() }
            $obsPassword = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
            $protectedPassword = $obsPassword |
                powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
                    -File (Join-Path $PSScriptRoot 'dpapi-secret.ps1') -Mode Protect
            if ($LASTEXITCODE -ne 0 -or -not $protectedPassword) {
                throw 'Could not protect the local OBS WebSocket password.'
            }
            Set-Content -LiteralPath $obsPasswordPath -Value $protectedPassword -Encoding ascii
        }
        $env:AI_INTERVIEW_OBS_MANAGED = '1'
        $env:AI_INTERVIEW_OBS_PASSWORD = $obsPassword
        Start-Process -FilePath $obsPath -WorkingDirectory (Split-Path -Parent $obsPath) -ArgumentList @(
            '--websocket_ipv4_only',
            '--websocket_port', '4455',
            '--websocket_password', $obsPassword
        )
    }
}

if (-not (Test-AppReady $Port)) {
    $listeningPorts = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().
        GetActiveTcpListeners().Port
    if ($listeningPorts -contains $Port) {
        throw "Port $Port is already used by another application."
    }
    $stdoutPath = Join-Path $logsRoot 'next.out.log'
    $stderrPath = Join-Path $logsRoot 'next.err.log'
    if (-not (Test-Path -LiteralPath (Join-Path $workspace '.next\BUILD_ID'))) {
        Write-Host 'Production build is missing; building now.' -ForegroundColor Yellow
        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) { throw 'Could not build the production application.' }
    }
    $node = Get-Command 'node.exe' -ErrorAction Stop
    $launchedPid = & $node.Source (Join-Path $PSScriptRoot 'launch-next.mjs') 'start' $Port $stdoutPath $stderrPath
    if ($LASTEXITCODE -ne 0 -or -not $launchedPid) { throw 'Could not launch Next.js.' }
    $ready = $false
    for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
        Start-Sleep -Milliseconds 500
        if (Test-AppReady $Port) {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        Stop-Process -Id ([int]$launchedPid) -Force -ErrorAction SilentlyContinue
        throw "Next.js did not become ready. Check $stderrPath."
    }
    $listenerPid = Get-PortOwner $Port
    if ($listenerPid) {
        Set-Content -LiteralPath $nextPidPath -Value $listenerPid -Encoding ascii
    }
}

$url = "http://127.0.0.1:$Port"
if (-not $NoBrowser) { Start-Process $url }
Write-Host "AI Interviewer is ready: $url" -ForegroundColor Green
Write-Host "Logs: $logsRoot"
