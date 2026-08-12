param(
  [Parameter(Mandatory=$true)][ValidateSet("obs", "virtual-audio")][string]$Component,
  [Parameter(Mandatory=$true)][string]$ResourcesDirectory
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($stream)
    return ([System.BitConverter]::ToString($hash)).Replace("-", "")
  } finally { $stream.Dispose() }
}
if ($Component -eq "obs") {
  $installer = Join-Path $ResourcesDirectory "OBS-Studio-32.2.1-Windows-x64-Installer.exe"
  if ((Get-Sha256 $installer) -ne "BBB95E52B96AD9B7CCD5ABD13121379D29774D6CC5FDBEF82FFA249E8A24A289") { throw "OBS hash invalid" }
  $process = Start-Process -FilePath $installer -ArgumentList "/S" -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "OBS installer failed: $($process.ExitCode)" }
  exit 0
}

$driverDirectory = Join-Path $ResourcesDirectory "virtual-audio-driver"
$inf = Get-ChildItem -LiteralPath $driverDirectory -Recurse -Filter "VirtualAudioDriver.inf" | Select-Object -First 1
if (-not $inf) { throw "PREREQUISITE_RESOURCE_MISSING: VirtualAudioDriver.inf" }

$catalog = Get-ChildItem -LiteralPath $inf.DirectoryName -Filter "VirtualAudioDriver.cat" | Select-Object -First 1
$driver = Get-ChildItem -LiteralPath $inf.DirectoryName -Filter "VirtualAudioDriver.sys" | Select-Object -First 1
if (-not $catalog -or -not $driver) { throw "PREREQUISITE_RESOURCE_MISSING: virtual audio catalog or driver" }
foreach ($file in @($catalog, $driver)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notlike "*SignPath Foundation*") {
    throw "PREREQUISITE_SIGNATURE_REJECTED: $($file.Name) ($($signature.Status))"
  }
}

# Pass the INF through JSON instead of interpolating it into a command line. This
# preserves spaces, non-ASCII characters and PowerShell metacharacters exactly.
$requestPath = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-interviewer-driver-request-{0}.json" -f [guid]::NewGuid())
$resultPath = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-interviewer-driver-result-{0}.json" -f [guid]::NewGuid())
$request = @{ infPath = $inf.FullName; resultPath = $resultPath } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($requestPath, $request, [System.Text.UTF8Encoding]::new($false))

$encodedRequestPath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($requestPath))
$elevatedScript = @'
$ErrorActionPreference = "Stop"
$requestPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("__REQUEST_PATH__"))
$request = Get-Content -Raw -LiteralPath $requestPath | ConvertFrom-Json
try {
  $output = & "$env:SystemRoot\System32\pnputil.exe" /add-driver $request.infPath /install 2>&1 | Out-String
  @{ exitCode = $LASTEXITCODE; output = $output } | ConvertTo-Json -Compress | Set-Content -LiteralPath $request.resultPath -Encoding UTF8
  exit $LASTEXITCODE
} catch {
  @{ exitCode = 1; output = $_.Exception.Message } | ConvertTo-Json -Compress | Set-Content -LiteralPath $request.resultPath -Encoding UTF8
  exit 1
}
'@
$elevatedScript = $elevatedScript.Replace("__REQUEST_PATH__", $encodedRequestPath)
$encodedScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($elevatedScript))
try {
  try {
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-NonInteractive", "-EncodedCommand", $encodedScript) -Verb RunAs -Wait -PassThru
  } catch {
    if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.Message -match "cancel|取消") {
      throw "PREREQUISITE_UAC_CANCELLED: administrator approval was cancelled"
    }
    throw
  }
  if (-not (Test-Path -LiteralPath $resultPath)) {
    throw "PREREQUISITE_INSTALL_FAILED: elevated installer returned $($process.ExitCode) without a result"
  }
  $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
  if ($result.exitCode -ne 0) {
    $detail = ([string]$result.output).Trim()
    if ($detail -match "signature|digital.*signed|签名|0xE0000247|0x800B0109") {
      throw "PREREQUISITE_SIGNATURE_REJECTED: $detail"
    }
    throw "PREREQUISITE_INSTALL_FAILED: $detail"
  }
  Write-Output (@{ installed = $true; output = ([string]$result.output).Trim() } | ConvertTo-Json -Compress)
} finally {
  Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
}
