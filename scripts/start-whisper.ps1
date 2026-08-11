[CmdletBinding()]
param(
    [int]$Port = 8080,
    [switch]$Background
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$whisperRoot = Join-Path $workspace '.tools\whisper.cpp'
$modelsRoot = Join-Path $workspace '.tools\models'
$pidPath = Join-Path $workspace '.tools\whisper-server.pid'
$envPath = Join-Path $workspace '.env.local'

$server = Get-ChildItem -LiteralPath $whisperRoot -Recurse -Filter 'whisper-server.exe' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $server) {
    throw 'whisper.cpp is not installed. Run npm run setup:whisper first.'
}

$configuredModel = $null
if (Test-Path -LiteralPath $envPath) {
    $modelLine = Get-Content -LiteralPath $envPath |
        Where-Object { $_ -match '^WHISPER_MODEL=' } |
        Select-Object -Last 1
    if ($modelLine) {
        $configuredModel = $modelLine.Substring('WHISPER_MODEL='.Length).Trim()
    }
}
$modelName = if ($env:WHISPER_MODEL) {
    $env:WHISPER_MODEL
} elseif ($configuredModel) {
    $configuredModel
} else {
    'base'
}
$modelPath = Join-Path $modelsRoot "ggml-$modelName.bin"
if (-not (Test-Path -LiteralPath $modelPath)) {
    throw "Model not found at $modelPath. Rerun setup-whisper.ps1 -Model $modelName."
}

$arguments = @(
    '-m', $modelPath,
    '--host', '127.0.0.1',
    '--port', [string]$Port,
    '--convert',
    '--language', 'zh',
    '--inference-path', '/inference'
)

if (-not $Background) {
    & $server.FullName @arguments
    exit $LASTEXITCODE
}

if (Test-Path -LiteralPath $pidPath) {
    $existingPid = [int](Get-Content -LiteralPath $pidPath -Raw)
    if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
        Write-Host "whisper-server is already running with PID $existingPid." -ForegroundColor Yellow
        exit 0
    }
}

$process = Start-Process -FilePath $server.FullName -ArgumentList $arguments -WorkingDirectory $server.Directory.FullName -PassThru -WindowStyle Hidden
Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) {
        throw "whisper-server exited during startup with code $($process.ExitCode)."
    }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch {
        # Model may still be loading.
    }
}
if (-not $ready) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw 'whisper-server did not become ready within 30 seconds.'
}

Write-Host "whisper-server is ready at http://127.0.0.1:$Port/inference (PID $($process.Id))" -ForegroundColor Green
