param(
  [Parameter(Mandatory=$true)][ValidateSet("obs", "virtual-audio")][string]$Component,
  [Parameter(Mandatory=$true)][string]$ResourcesDirectory
)

$ErrorActionPreference = "Stop"
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

$inf = Get-ChildItem -LiteralPath (Join-Path $ResourcesDirectory "virtual-audio-driver") -Recurse -Filter "VirtualAudioDriver.inf" | Select-Object -First 1
if (-not $inf) { throw "Virtual audio driver INF missing" }
$process = Start-Process -FilePath "pnputil.exe" -ArgumentList @("/add-driver", $inf.FullName, "/install") -Verb RunAs -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Virtual audio driver install failed: $($process.ExitCode)" }
