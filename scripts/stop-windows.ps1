[CmdletBinding()]
param(
    [switch]$IncludeObs
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsRoot = Join-Path $workspace '.tools'

function Get-PortOwner([int]$Port) {
    $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
    foreach ($line in (& $netstat -ano -p tcp)) {
        if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
            return [int]$Matches[1]
        }
    }
    return $null
}

function Stop-RecordedProcess(
    [string]$PidPath,
    [string]$Label,
    [string[]]$AllowedProcessNames,
    [int]$FallbackPort = 0,
    [string]$RequiredCommandPattern = ''
) {
    $recordedPid = $null
    if (Test-Path -LiteralPath $PidPath) {
        $recordedPid = [int](Get-Content -LiteralPath $PidPath -Raw)
    }
    if (-not $recordedPid -and $FallbackPort -gt 0) {
        $recordedPid = Get-PortOwner $FallbackPort
    }
    $process = if ($recordedPid) {
        Get-Process -Id $recordedPid -ErrorAction SilentlyContinue
    } else {
        $null
    }
    if (-not $process) {
        if (Test-Path -LiteralPath $PidPath) { Remove-Item -LiteralPath $PidPath -Force }
        return
    }
    if ($AllowedProcessNames -notcontains $process.ProcessName) {
        throw "Refusing to stop unexpected $Label process PID $recordedPid ($($process.ProcessName))."
    }
    if ($RequiredCommandPattern) {
        $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$recordedPid" -ErrorAction SilentlyContinue).CommandLine
        if (-not $commandLine -or $commandLine -notmatch $RequiredCommandPattern) {
            throw "Refusing to stop $Label PID $recordedPid because its command line does not match this workspace."
        }
    }
    Stop-Process -Id $recordedPid -Force
    Write-Host "Stopped $Label (PID $recordedPid)." -ForegroundColor Green
    if (-not (Test-Path -LiteralPath $PidPath)) { return }
    Remove-Item -LiteralPath $PidPath -Force
}

Stop-RecordedProcess -PidPath (Join-Path $toolsRoot 'next.pid') -Label 'Next.js' `
    -AllowedProcessNames @('node') -FallbackPort 3000 `
    -RequiredCommandPattern ([regex]::Escape($workspace))
Stop-RecordedProcess -PidPath (Join-Path $toolsRoot 'whisper-server.pid') -Label 'whisper-server' `
    -AllowedProcessNames @('whisper-server') -FallbackPort 8080 `
    -RequiredCommandPattern ([regex]::Escape((Join-Path $toolsRoot 'whisper.cpp')))

if ($IncludeObs) {
    $obsProcesses = @(Get-Process 'obs64' -ErrorAction SilentlyContinue)
    foreach ($process in $obsProcesses) {
        Stop-Process -Id $process.Id
        Write-Host "Stopped OBS Studio (PID $($process.Id))." -ForegroundColor Green
    }
}
