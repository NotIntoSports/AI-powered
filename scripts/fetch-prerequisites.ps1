param(
  [ValidateSet("all", "obs", "virtual-audio")][string]$Component = "all",
  [string]$Destination = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
if ($Destination) {
  $destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination)
} else {
  $destination = Join-Path $root "resources\prerequisites"
}
New-Item -ItemType Directory -Force -Path $destination | Out-Null

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($stream)
    return ([System.BitConverter]::ToString($hash)).Replace("-", "")
  } finally { $stream.Dispose() }
}

function Get-PinnedArchive($item) {
  $path = Join-Path $destination $item.Name
  if (-not (Test-Path -LiteralPath $path) -or (Get-Sha256 $path) -ne $item.Sha256) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $item.Url -OutFile $path
    } catch {
      throw "PREREQUISITE_DOWNLOAD_FAILED: $($item.Name)"
    }
  }
  if ((Get-Sha256 $path) -ne $item.Sha256) {
    throw "PREREQUISITE_HASH_MISMATCH: $($item.Name)"
  }
  return $path
}

$obs = @{
  Name = "OBS-Studio-32.2.1-Windows-x64.zip"
  Url = "https://github.com/obsproject/obs-studio/releases/download/32.2.1/OBS-Studio-32.2.1-Windows-x64.zip"
  Sha256 = "DB64A2934F8261F85B1410B84BE011207A0AFDA5400D008289F1F1E211BCC7DE"
}
$virtualAudio = @{
  Name = "VBCABLE_Driver_Pack45.zip"
  Url = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip"
  Sha256 = "B950E39F01AF1D04EA623C8F6D8EB9B6EA5C477C637295FABF20631C85116BFB"
  Publisher = "BUREL VINCENT Entrepreneur individuel"
}

if ($Component -eq "all" -or $Component -eq "obs") {
  $obsArchive = Get-PinnedArchive $obs
  $obsRoot = Join-Path $destination "obs-portable"
  if (Test-Path -LiteralPath $obsRoot) { Remove-Item -LiteralPath $obsRoot -Recurse -Force }
  Expand-Archive -LiteralPath $obsArchive -DestinationPath $obsRoot
  $obsExecutable = Join-Path $obsRoot "bin\64bit\obs64.exe"
  if (-not (Test-Path -LiteralPath $obsExecutable)) { throw "OBS portable executable is missing" }
  $obsSignature = Get-AuthenticodeSignature -LiteralPath $obsExecutable
  if ($obsSignature.Status -ne "Valid" -or $obsSignature.SignerCertificate.Subject -notlike "*OBS Project*") {
    throw "OBS portable signature verification failed"
  }
  [System.IO.File]::WriteAllText((Join-Path $obsRoot "portable_mode.txt"), "", [System.Text.UTF8Encoding]::new($false))
}

if ($Component -eq "all" -or $Component -eq "virtual-audio") {
  $driverArchive = Get-PinnedArchive $virtualAudio
  $driverRoot = Join-Path $destination "vb-cable"
  if (Test-Path -LiteralPath $driverRoot) { Remove-Item -LiteralPath $driverRoot -Recurse -Force }
  Expand-Archive -LiteralPath $driverArchive -DestinationPath $driverRoot
  $setup = Get-ChildItem -LiteralPath $driverRoot -Recurse -Filter "VBCABLE_Setup_x64.exe" | Select-Object -First 1
  if (-not $setup) { throw "PREREQUISITE_RESOURCE_MISSING: VBCABLE_Setup_x64.exe" }
  $signature = Get-AuthenticodeSignature -LiteralPath $setup.FullName
  $commonName = if ($signature.SignerCertificate) {
    $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  } else { "" }
  if ($signature.Status -ne "Valid" -or $commonName -ne $virtualAudio.Publisher) {
    throw "PREREQUISITE_SIGNATURE_REJECTED: $($setup.Name)"
  }
}

if ($Component -eq "virtual-audio") {
  Write-Host "Pinned virtual audio prerequisite is verified."
} elseif ($Component -eq "obs") {
  Write-Host "Pinned OBS prerequisite is verified."
} else {
  Write-Host "Pinned OBS and virtual audio prerequisites are verified."
}
