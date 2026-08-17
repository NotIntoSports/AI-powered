[CmdletBinding()]
param(
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsRoot = Join-Path $workspace '.tools'
$envPath = Join-Path $workspace '.env.local'

function Find-CommandPath([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Find-ObsPath {
    $command = Find-CommandPath 'obs64.exe'
    if ($command) { return $command }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'obs-studio\bin\64bit\obs64.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\obs-studio\bin\64bit\obs64.exe')
    )
    return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Get-EnvFileValue([string]$Key) {
    if (-not (Test-Path -LiteralPath $envPath)) { return $null }
    $prefix = "$Key="
    $line = Get-Content -LiteralPath $envPath |
        Where-Object { $_.StartsWith($prefix, [StringComparison]::Ordinal) } |
        Select-Object -Last 1
    if (-not $line) { return $null }
    return $line.Substring($prefix.Length).Trim()
}

$listeningPorts = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().
    GetActiveTcpListeners().Port
function Test-Port([int]$Port) {
    return $listeningPorts -contains $Port
}

$nodePath = Find-CommandPath 'node.exe'
$npmPath = Find-CommandPath 'npm.cmd'
$wingetPath = Find-CommandPath 'winget.exe'
$ffmpegPath = Find-CommandPath 'ffmpeg.exe'
[string]$obsPath = Find-ObsPath
$whisperServer = Get-ChildItem -LiteralPath (Join-Path $toolsRoot 'whisper.cpp') -Recurse -Filter 'whisper-server.exe' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
$modelName = Get-EnvFileValue 'WHISPER_MODEL'
if (-not $modelName) { $modelName = 'base' }
$modelPath = Join-Path $toolsRoot "models\ggml-$modelName.bin"
$provider = Get-EnvFileValue 'TRANSCRIPTION_PROVIDER'
if (-not $provider) { $provider = 'openai' }
$apiKey = Get-EnvFileValue 'OPENAI_API_KEY'
$transcriptionApiKey = Get-EnvFileValue 'TRANSCRIPTION_API_KEY'
$nodeVersion = if ($nodePath) { (& $nodePath --version).Trim() } else { $null }
$nodeReady = if ($nodeVersion -match '^v(\d+)\.(\d+)') {
    ([int]$Matches[1] -gt 22) -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -ge 13)
} else { $false }
$storedModel = $null
if ($nodeReady) {
    try {
        $settingsStatus = & $nodePath --no-warnings (Join-Path $PSScriptRoot 'settings-status.mjs') $workspace | ConvertFrom-Json
        $storedModel = $settingsStatus.model
    } catch {}
}
$modelBaseUrl = if ($storedModel) { [string]$storedModel.baseUrl } else { Get-EnvFileValue 'OPENAI_BASE_URL' }
$configuredModelName = if ($storedModel) { [string]$storedModel.name } else { Get-EnvFileValue 'OPENAI_MODEL' }
$modelApiKeyConfigured = if ($storedModel) {
    [bool]$storedModel.apiKeyConfigured
} else {
    -not [string]::IsNullOrWhiteSpace($apiKey) -and $apiKey -ne 'your_api_key'
}
$modelIsLoopback = $modelBaseUrl -match '^https?://(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:/|$)'
$modelConfigured = -not [string]::IsNullOrWhiteSpace($configuredModelName) -and (
    $modelApiKeyConfigured -or
    $modelIsLoopback
)
$virtualAudioDevices = @()
try {
    $virtualAudioDevices = Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction Stop |
        Where-Object { $_.FriendlyName -match 'CABLE Input|CABLE Output|Virtual Mic|Virtual Microphone|Virtual Audio Driver|Voicemeeter.+Input|Voicemeeter.+Output' } |
        ForEach-Object { $_.FriendlyName }
} catch {
    # Audio endpoint enumeration is optional on restricted machines.
}
$virtualAudioNames = $virtualAudioDevices -join "`n"
$vbCableReady = $false
foreach ($suffix in @('', '-A', '-B', '-C', '-D')) {
    if (
        $virtualAudioNames -match "CABLE$([regex]::Escape($suffix))\s+Input" -and
        $virtualAudioNames -match "CABLE$([regex]::Escape($suffix))\s+Output"
    ) {
        $vbCableReady = $true
        break
    }
}
$virtualAudioReady = (
    $vbCableReady -or
    ($virtualAudioNames -match 'Virtual\s+(Mic|Microphone)' -and $virtualAudioNames -match 'Virtual\s+Audio\s+Driver') -or
    ($virtualAudioNames -match 'Voicemeeter.+Input' -and $virtualAudioNames -match 'Voicemeeter.+Output')
)
$sapiVoices = @()
try {
    $voiceJson = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File (Join-Path $PSScriptRoot 'sapi-voices.ps1')
    if ($LASTEXITCODE -eq 0 -and $voiceJson) {
        $sapiVoices = @($voiceJson | ConvertFrom-Json | ForEach-Object { $_.name })
    }
} catch {
    # SAPI may be unavailable on Windows Server Core or stripped-down images.
}

$result = [ordered]@{
    workspace = $workspace
    node = [ordered]@{ ready = $nodeReady; version = $nodeVersion; path = $nodePath }
    npm = [ordered]@{ ready = [bool]$npmPath; path = $npmPath }
    dependencies = [ordered]@{ ready = Test-Path -LiteralPath (Join-Path $workspace 'node_modules\next\package.json') }
    model = [ordered]@{ ready = $modelConfigured; name = $configuredModelName; baseUrl = $modelBaseUrl }
    winget = [ordered]@{ ready = [bool]$wingetPath; path = $wingetPath }
    obs = [ordered]@{ ready = [bool]$obsPath; path = $obsPath; websocketPortOpen = Test-Port 4455 }
    ffmpeg = [ordered]@{ ready = [bool]$ffmpegPath; path = $ffmpegPath }
    transcription = [ordered]@{
        provider = $provider
        ready = if ($provider -eq 'whisper-cpp') {
            [bool]$whisperServer -and (Test-Path -LiteralPath $modelPath)
        } else {
            (-not [string]::IsNullOrWhiteSpace($transcriptionApiKey) -and $transcriptionApiKey -ne 'your_api_key') -or
            $modelApiKeyConfigured
        }
        whisperServer = if ($whisperServer) { $whisperServer.FullName } else { $null }
        model = $modelPath
        portOpen = Test-Port 8080
    }
    virtualAudio = [ordered]@{ ready = $virtualAudioReady; devices = @($virtualAudioDevices) }
    tts = [ordered]@{ ready = $sapiVoices.Count -gt 0; voices = @($sapiVoices) }
    app = [ordered]@{ portOpen = Test-Port 3000 }
}

if ($Json) {
    $result | ConvertTo-Json -Depth 5
    exit 0
}

$checks = @(
    @('Node 22.13+', $result.node.ready, "$($result.node.version) $($result.node.path)"),
    @('npm', $result.npm.ready, $result.npm.path),
    @('npm dependencies', $result.dependencies.ready, $(if ($result.dependencies.ready) { 'installed' } else { 'run npm install' })),
    @('AI model config', $result.model.ready, $(if ($result.model.ready) { $result.model.name } else { 'configure in the control console' })),
    @('OBS Studio', $result.obs.ready, $(if ($result.obs.path) { $result.obs.path } else { 'run npm run setup:windows' })),
    @('Transcription', $result.transcription.ready, "$provider"),
    @('Chinese TTS', $result.tts.ready, $(if ($sapiVoices.Count) { $sapiVoices -join ', ' } else { 'no zh-CN SAPI voice found' })),
    @('Virtual microphone', $result.virtualAudio.ready, $(if ($virtualAudioDevices.Count) { $virtualAudioDevices -join ', ' } else { 'manual driver install required' }))
)

Write-Host ''
Write-Host 'AI Virtual Assistant environment' -ForegroundColor Cyan
foreach ($check in $checks) {
    $mark = if ($check[1]) { '[OK]' } else { '[--]' }
    $color = if ($check[1]) { 'Green' } else { 'Yellow' }
    Write-Host ("{0,-5} {1,-20} {2}" -f $mark, $check[0], $check[2]) -ForegroundColor $color
}
Write-Host ''
Write-Host 'Virtual microphone installation remains manual because it changes a system driver.' -ForegroundColor DarkGray

if (-not $result.node.ready -or -not $result.npm.ready) { exit 2 }
exit 0
