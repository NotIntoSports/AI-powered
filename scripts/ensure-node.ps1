[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$minimumMajor = 22
$minimumMinor = 13
$packageId = 'OpenJS.NodeJS.LTS'

function Find-NodePath {
    $command = Get-Command 'node.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Get-NodeVersionInfo([string]$NodePath) {
    if (-not $NodePath) { return [ordered]@{ major = 0; minor = 0; ready = $false } }
    $version = (& $NodePath --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.(\d+)') {
        return [ordered]@{ major = 0; minor = 0; ready = $false }
    }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    return [ordered]@{
        major = $major
        minor = $minor
        ready = ($major -gt $minimumMajor) -or ($major -eq $minimumMajor -and $minor -ge $minimumMinor)
    }
}

$nodePath = Find-NodePath
$nodeInfo = Get-NodeVersionInfo $nodePath
$plan = [ordered]@{
    package = $packageId
    minimumMajor = $minimumMajor
    currentPath = $nodePath
    minimumMinor = $minimumMinor
    currentMajor = $nodeInfo.major
    currentMinor = $nodeInfo.minor
    ready = $nodeInfo.ready
    action = if (-not $nodePath) { 'install' } elseif (-not $nodeInfo.ready) { 'upgrade' } else { 'none' }
}

if ($DryRun) {
    if ($Json) { $plan | ConvertTo-Json -Compress } else { $plan | Format-List }
    exit 0
}

if ($plan.ready) {
    Write-Host "Node.js is ready: $(& $nodePath --version) ($nodePath)" -ForegroundColor Green
    exit 0
}

$winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
if (-not $winget) {
    throw 'Node.js 22.13.0 or newer is required and winget is unavailable. Install the current Node.js LTS from https://nodejs.org/ and rerun.'
}

if ($plan.action -eq 'install') {
    Write-Host "==> Installing Node.js LTS from the exact winget package $packageId" -ForegroundColor Cyan
    & $winget.Source install --id $packageId --exact --accept-package-agreements --accept-source-agreements
} else {
    Write-Host "==> Upgrading Node.js to the current LTS with winget package $packageId" -ForegroundColor Cyan
    & $winget.Source upgrade --id $packageId --exact --accept-package-agreements --accept-source-agreements
}
if ($LASTEXITCODE -ne 0) {
    throw "Node.js LTS $($plan.action) failed with exit code $LASTEXITCODE."
}

$nodePath = Find-NodePath
$nodeInfo = Get-NodeVersionInfo $nodePath
if (-not $nodeInfo.ready) {
    throw 'Node.js installation completed but a compatible node.exe could not be located. Restart Windows and rerun setup.'
}
Write-Host "Node.js is ready: $(& $nodePath --version) ($nodePath)" -ForegroundColor Green
