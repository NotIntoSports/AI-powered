[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9._:/-]{1,200}$')]
    [string]$Model = 'qwen3.5:4b',
    [switch]$SkipInstall,
    [switch]$SkipPull,
    [switch]$DryRun,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$settingsRoot = if ($env:INTERVIEW_DATA_DIR) {
    [IO.Path]::GetFullPath($env:INTERVIEW_DATA_DIR)
} else {
    Join-Path $workspace 'data\settings'
}
$settingsPath = Join-Path $settingsRoot 'model.json'

function Find-Ollama {
    $command = Get-Command 'ollama.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
        (Join-Path $env:LOCALAPPDATA 'Ollama\ollama.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Test-OllamaReady {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

$ollama = Find-Ollama
$plan = [ordered]@{
    package = 'Ollama.Ollama'
    installed = [bool]$ollama
    model = $Model
    estimatedModelDownload = if ($Model -eq 'qwen3.5:4b') { '3.4GB' } else { 'model-dependent' }
    endpoint = 'http://127.0.0.1:11434/v1'
    settingsPath = $settingsPath
    willInstall = -not [bool]$ollama -and -not $SkipInstall
    willPull = -not $SkipPull
}
if ($DryRun) {
    if ($Json) { $plan | ConvertTo-Json -Compress } else { $plan | Format-List }
    exit 0
}

if (-not $ollama) {
    if ($SkipInstall) {
        throw 'Ollama is not installed and -SkipInstall was specified.'
    }
    $winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw 'winget is unavailable. Install Ollama from https://ollama.com/download/windows and rerun with -SkipInstall.'
    }
    Write-Host '==> Installing Ollama from the exact winget package Ollama.Ollama' -ForegroundColor Cyan
    & $winget.Source install --id Ollama.Ollama --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Ollama installation failed with exit code $LASTEXITCODE." }
    $ollama = Find-Ollama
    if (-not $ollama) { throw 'Ollama was installed but ollama.exe could not be located.' }
}

if (-not (Test-OllamaReady)) {
    $logRoot = Join-Path $workspace '.tools\logs'
    New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
    Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logRoot 'ollama.out.log') `
        -RedirectStandardError (Join-Path $logRoot 'ollama.err.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        Start-Sleep -Milliseconds 500
        if (Test-OllamaReady) {
            $ready = $true
            break
        }
    }
    if (-not $ready) { throw 'Ollama did not become ready on 127.0.0.1:11434.' }
}

if (-not $SkipPull) {
    Write-Host "==> Pulling local model $Model" -ForegroundColor Cyan
    & $ollama pull $Model
    if ($LASTEXITCODE -ne 0) { throw "Ollama model pull failed with exit code $LASTEXITCODE." }
}

if (Test-Path -LiteralPath $settingsPath) {
    try {
        Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json | Out-Null
    } catch {
        throw 'Existing model settings are invalid; refusing to overwrite them.'
    }
}
$settings = [ordered]@{
    baseUrl = 'http://127.0.0.1:11434/v1'
    model = $Model
    encryptedApiKey = $null
}
New-Item -ItemType Directory -Force -Path $settingsRoot | Out-Null
$temporaryPath = "$settingsPath.$PID.tmp"
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($temporaryPath, (($settings | ConvertTo-Json) + [Environment]::NewLine), $utf8)
Move-Item -LiteralPath $temporaryPath -Destination $settingsPath -Force

Write-Host ''
Write-Host "Ollama model is ready: $Model" -ForegroundColor Green
Write-Host 'The AI Virtual Assistant is configured for http://127.0.0.1:11434/v1'
Write-Host 'Run npm run start:windows, then click “测试模型连接”.'
