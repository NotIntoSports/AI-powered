param(
  [ValidateSet("obs", "virtual-audio")][string]$Component,
  [string]$ResourcesDirectory,
  [ValidateSet("install", "uninstall")][string]$Operation = "install",
  [switch]$Worker,
  [string]$EncodedRequest,
  [string]$EncodedResultPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $OutputEncoding = [Console]::OutputEncoding
} catch {}
$ObsVirtualCameraClsid = "{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
$ObsVirtualCamera32Sha256 = "77C6EDF05247C6EAEB8532D99080C4E3F224DD079FDB6180F3480AEF21854271"
$ObsVirtualCamera64Sha256 = "8978F6383AE7105498D9CBB6FFA9F4EC6C0D18657E3999431E2C851CE4C62ED1"
$VbCablePublisher = "BUREL VINCENT Entrepreneur individuel"
$MaxElevatedCommandLength = 24000

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

function Get-WorkerPnpUtilPath {
  if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
    return Join-Path $env:SystemRoot "Sysnative\pnputil.exe"
  }
  return Join-Path $env:SystemRoot "System32\pnputil.exe"
}

function Invoke-WorkerPnpUtil([string[]]$Arguments) {
  $pnputilPath = Get-WorkerPnpUtilPath
  $output = & $pnputilPath @Arguments 2>&1 | Out-String
  return @{ ExitCode = $LASTEXITCODE; Output = [string]$output }
}

function Get-VirtualAudioDeviceOutput {
  $direct = Invoke-WorkerPnpUtil @("/enum-devices", "/deviceid", "ROOT\VirtualAudioDriver")
  $disconnected = Invoke-WorkerPnpUtil @("/enum-devices", "/disconnected", "/deviceid", "ROOT\VirtualAudioDriver")
  $media = Invoke-WorkerPnpUtil @("/enum-devices", "/class", "Media")
  $audio = Invoke-WorkerPnpUtil @("/enum-devices", "/class", "AudioEndpoint")
  return "$($direct.Output)`n$($disconnected.Output)`n$($media.Output)`n$($audio.Output)"
}

function Test-VbCablePairPresent([string]$Output) {
  $recording = ($Output -match '(?i)\bCABLE Output\b') -or ($Output -match '\u9EA6\u514B\u98CE\s*\([^)]*VB-Audio[^)]*\)')
  $playback = ($Output -match '(?i)\bCABLE\s+In(?:put)?\b') -or ($Output -match '\u626C\u58F0\u5668\s*\([^)]*VB-Audio[^)]*\)')
  return [bool]($recording -and $playback)
}

function Test-VbCableAnyPresent([string]$Output) {
  return [bool](($Output -match '(?i)\bCABLE Input\b') -or ($Output -match '(?i)\bCABLE Output\b'))
}

function Test-VoicemeeterPairPresent([string]$Output) {
  return [bool](($Output -match '(?i)Voicemeeter(?:\s+(?:AUX|VAIO3))?\s+Output') -and ($Output -match '(?i)Voicemeeter(?:\s+(?:AUX|VAIO3))?\s+Input'))
}

function Test-LegacyVirtualAudioStarted([string]$Output) {
  $blockPattern = '(?is)(?:Instance ID|.. ID):\s*(ROOT\\VIRTUALAUDIODRIVER\\[^\r\n]+)(.*?)(?=(?:Instance ID|.. ID):|\z)'
  foreach ($block in [regex]::Matches($Output, $blockPattern)) {
    $body = $block.Groups[2].Value
    if ($body -match '(?im)(?:Status|..):\s*Problem') { continue }
    if ($body -match '(?im)(?:Status|..):\s*Started(?!\w)' -or $body -match '(?im)(?:Status|..):\s*\u5DF2\u542F\u52A8') {
      return $true
    }
  }
  return $false
}

function Test-VbCableInDriverStore {
  $drivers = Invoke-WorkerPnpUtil @("/enum-drivers")
  return [bool]($drivers.Output -match '(?i)vbaudio_cable|vbMmeCable')
}

function Test-VirtualAudioAlreadyUsable([string]$Output) {
  return (Test-VbCablePairPresent $Output) -or (Test-VoicemeeterPairPresent $Output) -or (Test-LegacyVirtualAudioStarted $Output)
}

function Invoke-VbCableSetup([string]$SetupPath, [bool]$Silent) {
  $workingDirectory = [System.IO.Path]::GetDirectoryName($SetupPath)
  $argumentString = if ($Silent) { "-i -h" } else { "-i" }
  $windowStyle = if ($Silent) { "Hidden" } else { "Normal" }
  return Start-Process -FilePath $SetupPath -ArgumentList $argumentString -WorkingDirectory $workingDirectory -WindowStyle $windowStyle -Wait -PassThru
}

function Write-WorkerResult([string]$ResultPath, [bool]$Success, [string]$ErrorCode, [string]$Detail, [bool]$RebootRequired = $false) {
  $payload = @{ success = $Success; errorCode = $ErrorCode; detail = $Detail; rebootRequired = $RebootRequired } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($ResultPath, $payload, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-PrerequisiteWorker($Request, [string]$ResultPath) {
  try {
    Import-SecurityModule
    if ($Request.component -eq "obs") {
      Assert-ObsModule $Request.module32 $ObsVirtualCamera32Sha256
      Assert-ObsModule $Request.module64 $ObsVirtualCamera64Sha256
      $entries = @(
        @{ view = [Microsoft.Win32.RegistryView]::Registry32; path = [string]$Request.module32 },
        @{ view = [Microsoft.Win32.RegistryView]::Registry64; path = [string]$Request.module64 }
      )
      if ($Request.operation -eq "uninstall") {
        foreach ($entry in $entries) {
          if (Test-RegistryModule $entry.view $entry.path) {
            Invoke-Regsvr32 $entry.view $entry.path $true
          }
        }
      } else {
        foreach ($entry in $entries) {
          if (-not (Test-RegistryModule $entry.view $entry.path)) {
            Invoke-Regsvr32 $entry.view $entry.path $false
          }
        }
        foreach ($entry in $entries) {
          if (-not (Test-RegistryModule $entry.view $entry.path)) {
            throw "PREREQUISITE_REGISTRATION_FAILED: $($entry.view) registration did not match the bundled module"
          }
        }
      }
      Write-WorkerResult $ResultPath $true "" "OBS Virtual Camera operation completed" $false
      return
    }

    if ($Request.operation -ne "install") {
      throw "PREREQUISITE_INSTALL_FAILED: virtual audio uninstall is not supported"
    }
    $output = Get-VirtualAudioDeviceOutput
    if (Test-VirtualAudioAlreadyUsable $output) {
      Write-WorkerResult $ResultPath $true "" "virtual audio already present" $false
      return
    }
    if ((Test-VbCableAnyPresent $output) -or (Test-VbCableInDriverStore)) {
      Write-WorkerResult $ResultPath $true "" "VB-CABLE is present in Windows; reboot to complete device registration" $true
      return
    }
    $setupPath = [string]$Request.setupPath
    if (-not $setupPath -or -not (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
      throw "PREREQUISITE_RESOURCE_MISSING: VBCABLE_Setup_x64.exe"
    }
    Assert-AuthenticodePublisher $setupPath $VbCablePublisher
    $setup = Invoke-VbCableSetup $setupPath $true
    if ($setup.ExitCode -ne 0 -and $setup.ExitCode -ne 3010) {
      $setup = Invoke-VbCableSetup $setupPath $false
    }
    if ($setup.ExitCode -ne 0 -and $setup.ExitCode -ne 3010) {
      throw "PREREQUISITE_INSTALL_FAILED: VB-CABLE setup returned $($setup.ExitCode)"
    }
    $after = Get-VirtualAudioDeviceOutput
    if (Test-VbCablePairPresent $after) {
      Write-WorkerResult $ResultPath $true "" "VB-CABLE devices are present" $false
      return
    }
    Write-WorkerResult $ResultPath $true "" "VB-CABLE setup completed; reboot Windows if CABLE devices are not visible yet" $true
  } catch {
    $detail = $_.Exception.Message
    $errorCode = if ($detail -match "^(PREREQUISITE_[A-Z_]+)") { $Matches[1] } else { "PREREQUISITE_INSTALL_FAILED" }
    try { Write-WorkerResult $ResultPath $false $errorCode $detail $false } catch {}
    exit 1
  }
}

function Invoke-ElevatedWorker([hashtable]$Request) {
  $resultPath = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-digital-human-prerequisite-result-{0}.json" -f [guid]::NewGuid())
  # Keep the request on the command line (not a temp file) so an unelevated process
  # cannot swap the component or file paths while the UAC prompt is open.
  $encodedRequestJson = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Request | ConvertTo-Json -Compress)))
  $encodedResultPath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($resultPath))
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) { throw "PREREQUISITE_INSTALL_FAILED: installer script path is missing" }
  $argumentList = @(
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", $scriptPath,
    "-Worker",
    "-EncodedRequest", $encodedRequestJson,
    "-EncodedResultPath", $encodedResultPath
  )
  $argumentString = (
    $argumentList | ForEach-Object {
      if ($_ -match '[\s"]') { '"{0}"' -f ($_ -replace '"', '\"') } else { $_ }
    }
  ) -join " "
  $commandLength = $argumentString.Length
  if ($commandLength -gt $MaxElevatedCommandLength) {
    throw "PREREQUISITE_INSTALL_FAILED: elevated installer command is too long ($commandLength)"
  }

  try {
    $hostExecutable = (Get-Process -Id $PID).Path
    if (-not $hostExecutable) { $hostExecutable = "powershell.exe" }
    if (Test-Administrator) {
      & $hostExecutable @argumentList
      $workerExitCode = $LASTEXITCODE
    } else {
      try {
        $process = Start-Process -FilePath $hostExecutable -ArgumentList $argumentString -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        $workerExitCode = $process.ExitCode
      } catch {
        if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.Message -match "cancel|\u53D6\u6D88") {
          throw "PREREQUISITE_UAC_CANCELLED: administrator approval was cancelled"
        }
        throw "PREREQUISITE_INSTALL_FAILED: $($_.Exception.Message)"
      }
    }

    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
      $marker = if ($Request.component -eq "obs") { "PREREQUISITE_REGISTRATION_FAILED" } else { "PREREQUISITE_INSTALL_FAILED" }
      throw "${marker}: elevated installer returned $workerExitCode without a result"
    }
    $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
    if ($workerExitCode -ne 0 -or -not $result.success) {
      $marker = if ($result.errorCode -match "^PREREQUISITE_[A-Z_]+$") { $result.errorCode } else { "PREREQUISITE_INSTALL_FAILED" }
      $detail = [string]$result.detail
      if ($detail -match "^PREREQUISITE_[A-Z_]+") { throw $detail }
      throw "${marker}: $detail"
    }
    return $result
  } finally {
    Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
  }
}

function Write-InstallerJson([bool]$Installed, [string]$ErrorCode, [string]$Detail, [bool]$RebootRequired = $false) {
  Write-Output ((@{
    installed = $Installed
    errorCode = $ErrorCode
    detail = $Detail
    rebootRequired = $RebootRequired
  }) | ConvertTo-Json -Compress)
}

if ($Worker) {
  try {
    if (-not $EncodedRequest -or -not $EncodedResultPath) {
      throw "PREREQUISITE_INSTALL_FAILED: worker request is missing"
    }
    $resultPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedResultPath))
    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedRequest)) | ConvertFrom-Json
    Invoke-PrerequisiteWorker $request $resultPath
    exit 0
  } catch {
    $detail = $_.Exception.Message
    $errorCode = if ($detail -match "^(PREREQUISITE_[A-Z_]+)") { $Matches[1] } else { "PREREQUISITE_INSTALL_FAILED" }
    try {
      if ($EncodedResultPath) {
        $fallbackPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedResultPath))
        Write-WorkerResult $fallbackPath $false $errorCode $detail $false
      }
    } catch {}
    Write-InstallerJson $false $errorCode $detail $false
    exit 1
  }
}

try {
if (-not $Component -or -not $ResourcesDirectory) {
  throw "PREREQUISITE_INSTALL_FAILED: component and resources directory are required"
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
  Write-InstallerJson ($Operation -eq "install") "" "" $false
  exit 0
}

if ($Operation -ne "install") { throw "PREREQUISITE_INSTALL_FAILED: virtual audio uninstall is not supported" }
Import-SecurityModule
$output = Get-VirtualAudioDeviceOutput
if (Test-VirtualAudioAlreadyUsable $output) {
  Write-InstallerJson $true "" "virtual audio already present" $false
  exit 0
}
if ((Test-VbCableAnyPresent $output) -or (Test-VbCableInDriverStore)) {
  Write-InstallerJson $true "" "VB-CABLE is present in Windows; reboot to complete device registration" $true
  exit 0
}
$setupDirectory = Join-Path $ResourcesDirectory "vb-cable"
$setup = $null
if (Test-Path -LiteralPath $setupDirectory) {
  $setup = Get-ChildItem -LiteralPath $setupDirectory -Recurse -Filter "VBCABLE_Setup_x64.exe" | Select-Object -First 1
}
if (-not $setup) { throw "PREREQUISITE_RESOURCE_MISSING: VBCABLE_Setup_x64.exe" }
Assert-AuthenticodePublisher $setup.FullName $VbCablePublisher
$result = Invoke-ElevatedWorker @{
  component = "virtual-audio"
  operation = "install"
  setupPath = $setup.FullName
}
$rebootRequired = $true
if ($null -ne $result.rebootRequired) { $rebootRequired = [bool]$result.rebootRequired }
Write-InstallerJson $true "" ([string]$result.detail).Trim() $rebootRequired
exit 0
} catch {
  $detail = $_.Exception.Message
  $errorCode = if ($detail -match "^(PREREQUISITE_[A-Z_]+)") { $Matches[1] } else { "PREREQUISITE_INSTALL_FAILED" }
  Write-InstallerJson $false $errorCode $detail $false
  exit 1
}
