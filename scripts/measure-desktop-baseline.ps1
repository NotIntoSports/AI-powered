[CmdletBinding()]
param(
    [string]$ExecutablePath,
    [string]$InstallerPath,
    [string]$RuntimePath,
    [ValidateRange(0, 3600)]
    [int]$WarmupSeconds = 8,
    [ValidateRange(1, 3600)]
    [int]$SampleSeconds = 10,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

function Resolve-SuppliedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Kind
    )

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $resolved) {
        throw "$Kind path does not exist: $Path"
    }
    $resolved.Path
}

function Get-DirectoryBytes {
    param([Parameter(Mandatory = $true)][string]$Path)

    $sum = (Get-ChildItem -LiteralPath $Path -File -Recurse -Force |
        Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { return [int64]0 }
    [int64]$sum
}

function Get-ProcessTreeIds {
    param([Parameter(Mandatory = $true)][int]$RootId)

    $ids = [System.Collections.Generic.List[int]]::new()
    $pending = [System.Collections.Generic.Queue[int]]::new()
    $ids.Add($RootId)
    $pending.Enqueue($RootId)

    while ($pending.Count -gt 0) {
        $parentId = $pending.Dequeue()
        foreach ($child in Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId") {
            $childId = [int]$child.ProcessId
            if (-not $ids.Contains($childId)) {
                $ids.Add($childId)
                $pending.Enqueue($childId)
            }
        }
    }
    $ids.ToArray()
}

function Get-ProcessSnapshot {
    param([Parameter(Mandatory = $true)][int[]]$Ids)

    $cpuSeconds = 0.0
    $workingSetBytes = [int64]0
    foreach ($processId in $Ids) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) {
            if ($null -ne $process.CPU) { $cpuSeconds += [double]$process.CPU }
            $workingSetBytes += [int64]$process.WorkingSet64
        }
    }
    [pscustomobject]@{ CpuSeconds = $cpuSeconds; WorkingSetBytes = $workingSetBytes }
}

$commit = (& git rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
    throw 'Unable to determine the current Git commit.'
}

$installerBytes = $null
$runtimeBytes = $null
$startupMs = $null
$idleWorkingSetBytes = $null
$idleCpuPercent = $null
$startedProcess = $null

if ($InstallerPath) {
    $resolvedInstaller = Resolve-SuppliedPath -Path $InstallerPath -Kind 'Installer'
    $installerBytes = [int64](Get-Item -LiteralPath $resolvedInstaller).Length
}
if ($RuntimePath) {
    $resolvedRuntime = Resolve-SuppliedPath -Path $RuntimePath -Kind 'Runtime'
    $runtimeBytes = Get-DirectoryBytes -Path $resolvedRuntime
}

try {
    if ($ExecutablePath) {
        $resolvedExecutable = Resolve-SuppliedPath -Path $ExecutablePath -Kind 'Executable'
        $startupTimer = [System.Diagnostics.Stopwatch]::StartNew()
        $startedProcess = Start-Process -FilePath $resolvedExecutable -WindowStyle Hidden -PassThru
        $startupTimer.Stop()
        $startupMs = [int64]$startupTimer.ElapsedMilliseconds

        if ($WarmupSeconds -gt 0) { Start-Sleep -Seconds $WarmupSeconds }
        if ($startedProcess.HasExited) { throw 'The measured process exited during warmup.' }

        $processIds = Get-ProcessTreeIds -RootId $startedProcess.Id
        $before = Get-ProcessSnapshot -Ids $processIds
        Start-Sleep -Seconds $SampleSeconds
        $after = Get-ProcessSnapshot -Ids $processIds
        $idleWorkingSetBytes = [int64]$after.WorkingSetBytes
        $cpuDelta = [Math]::Max(0.0, $after.CpuSeconds - $before.CpuSeconds)
        $idleCpuPercent = [Math]::Round(($cpuDelta / $SampleSeconds) * 100.0, 2)
    }
}
finally {
    if ($startedProcess -and -not $startedProcess.HasExited) {
        Stop-Process -Id $startedProcess.Id -ErrorAction SilentlyContinue
    }
}

$measurement = [ordered]@{
    commit = $commit
    measuredAt = [DateTimeOffset]::UtcNow.ToString('o')
    installerBytes = $installerBytes
    runtimeBytes = $runtimeBytes
    startupMs = $startupMs
    idleWorkingSetBytes = $idleWorkingSetBytes
    idleCpuPercent = $idleCpuPercent
}
$json = $measurement | ConvertTo-Json -Depth 3
if ($OutputPath) {
    $outputDirectory = Split-Path -Parent $OutputPath
    if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
        throw "Output directory does not exist: $outputDirectory"
    }
    Set-Content -LiteralPath $OutputPath -Value $json -Encoding utf8
}
$json
