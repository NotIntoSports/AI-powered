param(
  [Parameter(Mandatory=$true)][ValidateSet("obs", "virtual-audio")][string]$Component,
  [Parameter(Mandatory=$true)][string]$ResourcesDirectory,
  [ValidateSet("install", "uninstall")][string]$Operation = "install"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ObsVirtualCameraClsid = "{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
$ObsVirtualCamera32Sha256 = "77C6EDF05247C6EAEB8532D99080C4E3F224DD079FDB6180F3480AEF21854271"
$ObsVirtualCamera64Sha256 = "8978F6383AE7105498D9CBB6FFA9F4EC6C0D18657E3999431E2C851CE4C62ED1"

function Import-SecurityModule {
  $modulePath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
  try {
    Import-Module -Name $modulePath -ErrorAction Stop
  } catch {
    throw "PREREQUISITE_MODULE_LOAD_FAILED: Microsoft.PowerShell.Security could not be loaded"
  }
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($stream)
    return ([System.BitConverter]::ToString($hash)).Replace("-", "")
  } finally { $stream.Dispose() }
}

function Assert-AuthenticodePublisher([string]$Path, [string]$Publisher) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $commonName = if ($signature.SignerCertificate) {
    $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  } else { "" }
  if ($signature.Status -ne "Valid" -or $commonName -ne $Publisher) {
    throw "PREREQUISITE_SIGNATURE_REJECTED: $([System.IO.Path]::GetFileName($Path)) ($($signature.Status))"
  }
}

function Assert-ObsModule([string]$Path, [string]$ExpectedSha256) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "PREREQUISITE_RESOURCE_MISSING: $([System.IO.Path]::GetFileName($Path))"
  }
  Assert-AuthenticodePublisher $Path "OBS Project, LLC"
  if ((Get-Sha256 $Path) -ne $ExpectedSha256) {
    throw "PREREQUISITE_HASH_MISMATCH: $([System.IO.Path]::GetFileName($Path))"
  }
}

function Get-RegistryDefaultValue([Microsoft.Win32.RegistryView]$View) {
  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $View)
  try {
    $key = $baseKey.OpenSubKey("SOFTWARE\Classes\CLSID\$ObsVirtualCameraClsid\InprocServer32")
    if (-not $key) { return "" }
    try { return [string]$key.GetValue($null, "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $key.Dispose() }
  } finally { $baseKey.Dispose() }
}

function Test-RegistryModule([Microsoft.Win32.RegistryView]$View, [string]$ExpectedPath) {
  $registeredPath = Get-RegistryDefaultValue $View
  if (-not $registeredPath) { return $false }
  try {
    $registeredFullPath = [System.IO.Path]::GetFullPath($registeredPath.Trim().Trim('"'))
    $expectedFullPath = [System.IO.Path]::GetFullPath($ExpectedPath)
    return [string]::Equals($registeredFullPath, $expectedFullPath, [System.StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } finally { $identity.Dispose() }
}

function Invoke-ElevatedWorker([hashtable]$Request) {
  $resultPath = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-digital-human-prerequisite-result-{0}.json" -f [guid]::NewGuid())
  # Embed the JSON request in the elevated command so an unelevated process cannot
  # swap the component or file paths while the UAC prompt is open.
  $encodedRequestJson = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Request | ConvertTo-Json -Compress)))
  $encodedResultPath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($resultPath))
  $elevatedScript = @'
$ErrorActionPreference = "Stop"
$resultPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("__RESULT_PATH__"))
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("__REQUEST_JSON__")) | ConvertFrom-Json
$obsVirtualCameraClsid = "{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
$obsVirtualCamera32Sha256 = "77C6EDF05247C6EAEB8532D99080C4E3F224DD079FDB6180F3480AEF21854271"
$obsVirtualCamera64Sha256 = "8978F6383AE7105498D9CBB6FFA9F4EC6C0D18657E3999431E2C851CE4C62ED1"

function Import-WorkerSecurityModule {
  $modulePath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
  try {
    Import-Module -Name $modulePath -ErrorAction Stop
  } catch {
    throw "PREREQUISITE_MODULE_LOAD_FAILED: Microsoft.PowerShell.Security could not be loaded"
  }
}

function Write-WorkerResult([bool]$Success, [string]$ErrorCode, [string]$Detail) {
  $payload = @{ success = $Success; errorCode = $ErrorCode; detail = $Detail } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($resultPath, $payload, [System.Text.UTF8Encoding]::new($false))
}

function Get-WorkerSha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($stream)
    return ([System.BitConverter]::ToString($hash)).Replace("-", "")
  } finally { $stream.Dispose() }
}

function Assert-WorkerPublisher([string]$Path, [string]$Publisher) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $commonName = if ($signature.SignerCertificate) {
    $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  } else { "" }
  if ($signature.Status -ne "Valid" -or $commonName -ne $Publisher) {
    throw "PREREQUISITE_SIGNATURE_REJECTED: $([System.IO.Path]::GetFileName($Path)) ($($signature.Status))"
  }
}

function Assert-WorkerObsModule([string]$Path, [string]$ExpectedSha256) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "PREREQUISITE_RESOURCE_MISSING: $([System.IO.Path]::GetFileName($Path))"
  }
  Assert-WorkerPublisher $Path "OBS Project, LLC"
  if ((Get-WorkerSha256 $Path) -ne $ExpectedSha256) {
    throw "PREREQUISITE_HASH_MISMATCH: $([System.IO.Path]::GetFileName($Path))"
  }
}

function Get-WorkerRegistryDefaultValue([Microsoft.Win32.RegistryView]$View) {
  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $View)
  try {
    $key = $baseKey.OpenSubKey("SOFTWARE\Classes\CLSID\$obsVirtualCameraClsid\InprocServer32")
    if (-not $key) { return "" }
    try { return [string]$key.GetValue($null, "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $key.Dispose() }
  } finally { $baseKey.Dispose() }
}

function Test-WorkerRegistryModule([Microsoft.Win32.RegistryView]$View, [string]$ExpectedPath) {
  $registeredPath = Get-WorkerRegistryDefaultValue $View
  if (-not $registeredPath) { return $false }
  try {
    return [string]::Equals(
      [System.IO.Path]::GetFullPath($registeredPath.Trim().Trim('"')),
      [System.IO.Path]::GetFullPath($ExpectedPath),
      [System.StringComparison]::OrdinalIgnoreCase
    )
  } catch { return $false }
}

function Get-Regsvr32Path([Microsoft.Win32.RegistryView]$View) {
  if ($View -eq [Microsoft.Win32.RegistryView]::Registry32) {
    return Join-Path $env:SystemRoot "SysWOW64\regsvr32.exe"
  }
  if ([Environment]::Is64BitProcess) {
    return Join-Path $env:SystemRoot "System32\regsvr32.exe"
  }
  return Join-Path $env:SystemRoot "Sysnative\regsvr32.exe"
}

function Invoke-Regsvr32([Microsoft.Win32.RegistryView]$View, [string]$ModulePath, [bool]$Unregister) {
  $executable = Get-Regsvr32Path $View
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "PREREQUISITE_REGISTRATION_FAILED: regsvr32 is missing for $View"
  }
  $arguments = if ($Unregister) { @("/u", "/s", $ModulePath) } else { @("/i", "/s", $ModulePath) }
  $registration = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($registration.ExitCode -ne 0) {
    throw "PREREQUISITE_REGISTRATION_FAILED: regsvr32 returned $($registration.ExitCode) for $View"
  }
}

try {
  Import-WorkerSecurityModule
  if ($request.component -eq "obs") {
    Assert-WorkerObsModule $request.module32 $obsVirtualCamera32Sha256
    Assert-WorkerObsModule $request.module64 $obsVirtualCamera64Sha256
    $entries = @(
      @{ view = [Microsoft.Win32.RegistryView]::Registry32; path = [string]$request.module32 },
      @{ view = [Microsoft.Win32.RegistryView]::Registry64; path = [string]$request.module64 }
    )
    if ($request.operation -eq "uninstall") {
      foreach ($entry in $entries) {
        if (Test-WorkerRegistryModule $entry.view $entry.path) {
          Invoke-Regsvr32 $entry.view $entry.path $true
        }
      }
    } else {
      foreach ($entry in $entries) {
        if (-not (Test-WorkerRegistryModule $entry.view $entry.path)) {
          Invoke-Regsvr32 $entry.view $entry.path $false
        }
      }
      foreach ($entry in $entries) {
        if (-not (Test-WorkerRegistryModule $entry.view $entry.path)) {
          throw "PREREQUISITE_REGISTRATION_FAILED: $($entry.view) registration did not match the bundled module"
        }
      }
    }
    Write-WorkerResult $true "" "OBS Virtual Camera operation completed"
    exit 0
  }

  if ($request.operation -ne "install") {
    throw "PREREQUISITE_INSTALL_FAILED: virtual audio uninstall is not supported"
  }
  $inf = Get-Item -LiteralPath $request.infPath
  $catalog = Get-ChildItem -LiteralPath $inf.DirectoryName -Filter "VirtualAudioDriver.cat" | Select-Object -First 1
  $driver = Get-ChildItem -LiteralPath $inf.DirectoryName -Filter "VirtualAudioDriver.sys" | Select-Object -First 1
  if (-not $catalog -or -not $driver) {
    throw "PREREQUISITE_RESOURCE_MISSING: virtual audio catalog or driver"
  }
  foreach ($file in @($catalog, $driver)) { Assert-WorkerPublisher $file.FullName "SignPath Foundation" }
  $pnputilPath = if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
    Join-Path $env:SystemRoot "Sysnative\pnputil.exe"
  } else {
    Join-Path $env:SystemRoot "System32\pnputil.exe"
  }
  $output = & $pnputilPath /add-driver $request.infPath /install 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    if ($output -match "signature|digital.*signed|签名|0xE0000247|0x800B0109") {
      throw "PREREQUISITE_SIGNATURE_REJECTED: $($output.Trim())"
    }
    throw "PREREQUISITE_INSTALL_FAILED: $($output.Trim())"
  }
  Write-WorkerResult $true "" $output.Trim()
  exit 0
} catch {
  $detail = $_.Exception.Message
  $errorCode = if ($detail -match "^(PREREQUISITE_[A-Z_]+)") { $matches[1] } else { "PREREQUISITE_INSTALL_FAILED" }
  try { Write-WorkerResult $false $errorCode $detail } catch {}
  exit 1
}
'@
  $elevatedScript = $elevatedScript.Replace("__REQUEST_JSON__", $encodedRequestJson).Replace("__RESULT_PATH__", $encodedResultPath)
  $encodedScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($elevatedScript))

  try {
    $hostExecutable = (Get-Process -Id $PID).Path
    if (-not $hostExecutable) { $hostExecutable = "powershell.exe" }
    if (Test-Administrator) {
      & $hostExecutable -NoProfile -NonInteractive -EncodedCommand $encodedScript
      $workerExitCode = $LASTEXITCODE
    } else {
      try {
        $process = Start-Process -FilePath $hostExecutable -ArgumentList @("-NoProfile", "-NonInteractive", "-EncodedCommand", $encodedScript) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        $workerExitCode = $process.ExitCode
      } catch {
        if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.Message -match "cancel|取消") {
          throw "PREREQUISITE_UAC_CANCELLED: administrator approval was cancelled"
        }
        throw
      }
    }

    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
      $marker = if ($Component -eq "obs") { "PREREQUISITE_REGISTRATION_FAILED" } else { "PREREQUISITE_INSTALL_FAILED" }
      throw "${marker}: elevated installer returned $workerExitCode without a result"
    }
    $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
    if ($workerExitCode -ne 0 -or -not $result.success) {
      $marker = if ($result.errorCode -match "^PREREQUISITE_[A-Z_]+$") { $result.errorCode } else { "PREREQUISITE_INSTALL_FAILED" }
      throw "${marker}: $([string]$result.detail)"
    }
    return $result
  } finally {
    Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
  }
}

if ($Component -eq "obs") {
  Import-SecurityModule
  $portable = Join-Path $ResourcesDirectory "obs-portable"
  $moduleDirectory = Join-Path $portable "data\obs-plugins\win-dshow"
  $module32 = Join-Path $moduleDirectory "obs-virtualcam-module32.dll"
  $module64 = Join-Path $moduleDirectory "obs-virtualcam-module64.dll"
  Assert-ObsModule $module32 $ObsVirtualCamera32Sha256
  Assert-ObsModule $module64 $ObsVirtualCamera64Sha256

  $registered32 = Test-RegistryModule ([Microsoft.Win32.RegistryView]::Registry32) $module32
  $registered64 = Test-RegistryModule ([Microsoft.Win32.RegistryView]::Registry64) $module64
  $operationComplete = if ($Operation -eq "uninstall") {
    -not $registered32 -and -not $registered64
  } else {
    $registered32 -and $registered64
  }
  if (-not $operationComplete) {
    Invoke-ElevatedWorker @{
      component = "obs"
      operation = $Operation
      module32 = $module32
      module64 = $module64
    } | Out-Null
  }
  if ($Operation -eq "install" -and (
    -not (Test-RegistryModule ([Microsoft.Win32.RegistryView]::Registry32) $module32) -or
    -not (Test-RegistryModule ([Microsoft.Win32.RegistryView]::Registry64) $module64)
  )) {
    throw "PREREQUISITE_REGISTRATION_FAILED: Windows did not retain both OBS Virtual Camera registrations"
  }
  Write-Output (@{ installed = ($Operation -eq "install"); uninstalled = ($Operation -eq "uninstall") } | ConvertTo-Json -Compress)
  exit 0
}

if ($Operation -ne "install") { throw "PREREQUISITE_INSTALL_FAILED: virtual audio uninstall is not supported" }
Import-SecurityModule
$driverDirectory = Join-Path $ResourcesDirectory "virtual-audio-driver"
$inf = Get-ChildItem -LiteralPath $driverDirectory -Recurse -Filter "VirtualAudioDriver.inf" | Select-Object -First 1
if (-not $inf) { throw "PREREQUISITE_RESOURCE_MISSING: VirtualAudioDriver.inf" }

$catalog = Get-ChildItem -LiteralPath $inf.DirectoryName -Filter "VirtualAudioDriver.cat" | Select-Object -First 1
$driver = Get-ChildItem -LiteralPath $inf.DirectoryName -Filter "VirtualAudioDriver.sys" | Select-Object -First 1
if (-not $catalog -or -not $driver) { throw "PREREQUISITE_RESOURCE_MISSING: virtual audio catalog or driver" }
foreach ($file in @($catalog, $driver)) { Assert-AuthenticodePublisher $file.FullName "SignPath Foundation" }

$result = Invoke-ElevatedWorker @{
  component = "virtual-audio"
  operation = "install"
  infPath = $inf.FullName
}
Write-Output (@{ installed = $true; output = ([string]$result.detail).Trim() } | ConvertTo-Json -Compress)
