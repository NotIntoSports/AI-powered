param([switch]$RunTests)

$ErrorActionPreference = "Stop"
$project = Join-Path $PSScriptRoot "..\native\AudioBridge\AudioBridge.csproj"
$output = Join-Path $PSScriptRoot "..\native\AudioBridge\publish"

dotnet publish $project -c Release -r win-x64 --self-contained true -o $output
if ($LASTEXITCODE -ne 0) { throw "AudioBridge publish failed" }

if ($RunTests) {
  & (Join-Path $output "AudioBridge.exe") --self-test
  if ($LASTEXITCODE -ne 0) { throw "AudioBridge self-test failed" }
}
