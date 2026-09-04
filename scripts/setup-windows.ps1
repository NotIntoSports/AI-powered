[CmdletBinding()]
param(
    [switch]$SkipObs
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

Write-Host '==> Checking Node.js LTS prerequisite' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'ensure-node.ps1')
if ($LASTEXITCODE -ne 0) { throw "Node.js prerequisite setup failed with exit code $LASTEXITCODE." }

$npmPath = @(
    (Get-Command 'npm.cmd' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    (Join-Path $env:ProgramFiles 'nodejs\npm.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\npm.cmd')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $npmPath) {
    throw 'Node.js was installed but npm.cmd could not be located. Restart Windows and rerun setup.'
}

Write-Host '==> Installing project dependencies' -ForegroundColor Cyan
& $npmPath install
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }

if (-not $SkipObs) {
    $obsCandidates = @(
        (Join-Path $env:ProgramFiles 'obs-studio\bin\64bit\obs64.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\obs-studio\bin\64bit\obs64.exe')
    )
    $obsInstalled = $obsCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $obsInstalled) {
        $winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
        if (-not $winget) {
            throw 'OBS Studio is missing and winget is unavailable. Install OBS Studio manually or rerun with -SkipObs.'
        }
        Write-Host '==> Installing OBS Studio from the winget community repository' -ForegroundColor Cyan
        & $winget.Source install --id OBSProject.OBSStudio --exact --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw "OBS Studio installation failed with exit code $LASTEXITCODE." }
    } else {
        Write-Host "OBS Studio is already installed: $obsInstalled" -ForegroundColor Green
    }
}

Write-Host '==> Building the production application' -ForegroundColor Cyan
& $npmPath run build
if ($LASTEXITCODE -ne 0) { throw "Production build failed with exit code $LASTEXITCODE." }

Write-Host ''
Write-Host 'Windows setup completed.' -ForegroundColor Green
Write-Host 'A virtual microphone driver is still required for AI voice in meeting apps.'
Write-Host 'Open-source option: https://github.com/VirtualDrivers/Virtual-Audio-Driver/releases'
Write-Host 'Next: npm run check:environment, then npm run start:windows'
