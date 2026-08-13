$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$destination = Join-Path $root "resources\prerequisites"
New-Item -ItemType Directory -Force -Path $destination | Out-Null

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($stream)
    return ([System.BitConverter]::ToString($hash)).Replace("-", "")
  } finally { $stream.Dispose() }
}

$items = @(
  @{
    Name = "OBS-Studio-32.2.1-Windows-x64.zip"
    Url = "https://github.com/obsproject/obs-studio/releases/download/32.2.1/OBS-Studio-32.2.1-Windows-x64.zip"
    Sha256 = "DB64A2934F8261F85B1410B84BE011207A0AFDA5400D008289F1F1E211BCC7DE"
  },
  @{
    Name = "Virtual.Audio.Driver.Signed.-.25.7.14.zip"
    Url = "https://github.com/VirtualDrivers/Virtual-Audio-Driver/releases/download/25.7.14/Virtual.Audio.Driver.Signed.-.25.7.14.zip"
    Sha256 = "DD10560994DE65A7E587FB8B93C0D7E9838292D9C3566A0976C2786D727292BD"
  }
)

foreach ($item in $items) {
  $path = Join-Path $destination $item.Name
  if (-not (Test-Path -LiteralPath $path) -or (Get-Sha256 $path) -ne $item.Sha256) {
    Invoke-WebRequest -UseBasicParsing -Uri $item.Url -OutFile $path
  }
  if ((Get-Sha256 $path) -ne $item.Sha256) {
    throw "SHA-256 mismatch: $($item.Name)"
  }
  if ($item.Publisher) {
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notlike "*$($item.Publisher)*") {
      throw "Authenticode verification failed: $($item.Name)"
    }
  }
}

$obsRoot = Join-Path $destination "obs-portable"
if (Test-Path -LiteralPath $obsRoot) { Remove-Item -LiteralPath $obsRoot -Recurse -Force }
Expand-Archive -LiteralPath (Join-Path $destination $items[0].Name) -DestinationPath $obsRoot
$obsExecutable = Join-Path $obsRoot "bin\64bit\obs64.exe"
if (-not (Test-Path -LiteralPath $obsExecutable)) { throw "OBS portable executable is missing" }
$obsSignature = Get-AuthenticodeSignature -LiteralPath $obsExecutable
if ($obsSignature.Status -ne "Valid" -or $obsSignature.SignerCertificate.Subject -notlike "*OBS Project*") {
  throw "OBS portable signature verification failed"
}
[System.IO.File]::WriteAllText((Join-Path $obsRoot "portable_mode.txt"), "", [System.Text.UTF8Encoding]::new($false))

$driverRoot = Join-Path $destination "virtual-audio-driver"
if (Test-Path -LiteralPath $driverRoot) { Remove-Item -LiteralPath $driverRoot -Recurse -Force }
Expand-Archive -LiteralPath (Join-Path $destination $items[1].Name) -DestinationPath $driverRoot
$driverFiles = Get-ChildItem -LiteralPath $driverRoot -Recurse -Include *.cat,*.sys
if ($driverFiles.Count -lt 2) { throw "Virtual audio driver files are missing" }
foreach ($file in $driverFiles) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notlike "*SignPath Foundation*") {
    throw "Driver signature verification failed: $($file.Name)"
  }
}

Write-Host "Pinned OBS and virtual audio prerequisites are verified."
