[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$minimumMajor = 22
$packageId = 'OpenJS.NodeJS.LTS'

function Find-NodePath {
    $command = Get-Command 'node.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Get-NodeMajor([string]$NodePath) {
    if (-not $NodePath) { return 0 }
    $version = (& $NodePath --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)') { return 0 }
    return [int]$Matches[1]
}

$nodePath = Find-NodePath
$nodeMajor = Get-NodeMajor $nodePath
$plan = [ordered]@{
    package = $packageId
    minimumMajor = $minimumMajor
    currentPath = $nodePath
    currentMajor = $nodeMajor
    ready = $nodeMajor -ge $minimumMajor
    action = if (-not $nodePath) { 'install' } elseif ($nodeMajor -lt $minimumMajor) { 'upgrade' } else { 'none' }
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
    throw 'Node.js 22 LTS or newer is required and winget is unavailable. Install the current Node.js LTS from https://nodejs.org/ and rerun.'
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
$nodeMajor = Get-NodeMajor $nodePath
if ($nodeMajor -lt $minimumMajor) {
    throw 'Node.js installation completed but a compatible node.exe could not be located. Restart Windows and rerun setup.'
}
Write-Host "Node.js is ready: $(& $nodePath --version) ($nodePath)" -ForegroundColor Green
