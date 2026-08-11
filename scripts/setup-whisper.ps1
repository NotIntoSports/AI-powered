[CmdletBinding()]
param(
    [ValidateSet('tiny', 'base', 'small')]
    [string]$Model = 'base',
    [switch]$SkipFfmpeg
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsRoot = Join-Path $workspace '.tools'
$whisperRoot = Join-Path $toolsRoot 'whisper.cpp'
$modelsRoot = Join-Path $toolsRoot 'models'
$modelPath = Join-Path $modelsRoot "ggml-$Model.bin"
$envPath = Join-Path $workspace '.env.local'

$models = @{
    tiny = @{
        Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
        Sha1 = 'bd577a113a864445d4c299885e0cb97d4ba92b5f'
    }
    base = @{
        Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
        Sha1 = '465707469ff3a37a2b9b8d8f89f2f99de7299dac'
    }
    small = @{
        Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin'
        Sha1 = '55356645c2b361a969dfd0ef2c5a50d530afd8d5'
    }
}

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Set-EnvValue([string]$Key, [string]$Value) {
    $lines = if (Test-Path -LiteralPath $envPath) {
        [Collections.Generic.List[string]](Get-Content -LiteralPath $envPath)
    } else {
        [Collections.Generic.List[string]]::new()
    }
    $prefix = "$Key="
    $found = $false
    for ($index = 0; $index -lt $lines.Count; $index += 1) {
        if ($lines[$index].StartsWith($prefix, [StringComparison]::Ordinal)) {
            $lines[$index] = "$prefix$Value"
            $found = $true
            break
        }
    }
    if (-not $found) {
        $lines.Add("$prefix$Value")
    }
    Set-Content -LiteralPath $envPath -Value $lines -Encoding utf8
}

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'The prebuilt whisper.cpp installer requires 64-bit Windows.'
}

New-Item -ItemType Directory -Force -Path $toolsRoot, $whisperRoot, $modelsRoot | Out-Null

$server = Get-ChildItem -LiteralPath $whisperRoot -Recurse -Filter 'whisper-server.exe' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $server) {
    Write-Step 'Finding the latest official whisper.cpp Windows release'
    $headers = @{
        'User-Agent' = 'AI-Interviewer-Setup'
        'Accept' = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest' -Headers $headers
    $asset = $release.assets |
        Where-Object { $_.name -eq 'whisper-bin-x64.zip' } |
        Select-Object -First 1
    if (-not $asset) {
        $asset = $release.assets |
            Where-Object { $_.name -match '^whisper-(?!cublas|vulkan).*bin-x64\.zip$' } |
            Select-Object -First 1
    }
    if (-not $asset) {
        throw "No CPU x64 archive was found in official release $($release.tag_name)."
    }

    $archive = Join-Path $toolsRoot $asset.name
    $extractRoot = Join-Path $toolsRoot "whisper-$($release.tag_name)"
    Write-Step "Downloading $($asset.name) ($($release.tag_name))"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -Headers $headers
    if (-not (Test-Path -LiteralPath $extractRoot)) {
        Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot
    }
    $downloadedServer = Get-ChildItem -LiteralPath $extractRoot -Recurse -Filter 'whisper-server.exe' -File |
        Select-Object -First 1
    if (-not $downloadedServer) {
        throw 'whisper-server.exe was not found in the official archive.'
    }
    Copy-Item -Path (Join-Path $downloadedServer.Directory.FullName '*') -Destination $whisperRoot -Recurse -Force
    $server = Get-Item -LiteralPath (Join-Path $whisperRoot 'whisper-server.exe')
}

$modelInfo = $models[$Model]
$downloadModel = $true
if (Test-Path -LiteralPath $modelPath) {
    $currentHash = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA1).Hash.ToLowerInvariant()
    $downloadModel = $currentHash -ne $modelInfo.Sha1
}
if ($downloadModel) {
    Write-Step "Downloading the multilingual Whisper $Model model"
    $temporaryModel = "$modelPath.download"
    Invoke-WebRequest -Uri $modelInfo.Url -OutFile $temporaryModel
    $modelHash = (Get-FileHash -LiteralPath $temporaryModel -Algorithm SHA1).Hash.ToLowerInvariant()
    if ($modelHash -ne $modelInfo.Sha1) {
        Remove-Item -LiteralPath $temporaryModel -Force
        throw "Model checksum mismatch. Expected $($modelInfo.Sha1), received $modelHash."
    }
    Move-Item -LiteralPath $temporaryModel -Destination $modelPath -Force
}

if (-not $SkipFfmpeg -and -not (Get-Command 'ffmpeg.exe' -ErrorAction SilentlyContinue)) {
    $winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw 'FFmpeg and winget were not found. Install FFmpeg, then rerun with -SkipFfmpeg.'
    }
    Write-Step 'Installing FFmpeg through winget'
    & $winget.Source install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "FFmpeg installation failed with winget exit code $LASTEXITCODE."
    }
}

Set-EnvValue -Key 'TRANSCRIPTION_PROVIDER' -Value 'whisper-cpp'
Set-EnvValue -Key 'WHISPER_CPP_URL' -Value 'http://127.0.0.1:8080/inference'
Set-EnvValue -Key 'WHISPER_MODEL' -Value $Model

Write-Host ''
Write-Host 'Local transcription dependencies are ready.' -ForegroundColor Green
Write-Host "whisper-server: $($server.FullName)"
Write-Host "model: $modelPath"
Write-Host 'Next: npm run start:whisper'
