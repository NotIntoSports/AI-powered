$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'ensure-node.ps1'
$output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File $scriptPath -DryRun -Json
if ($LASTEXITCODE -ne 0) { throw 'Node.js prerequisite dry run failed.' }
$plan = $output | ConvertFrom-Json
if ($plan.package -ne 'OpenJS.NodeJS.LTS') { throw 'Unexpected Node.js winget package.' }
if ($plan.minimumMajor -ne 22) { throw 'Unexpected minimum Node.js major.' }
if ($plan.action -notin @('none', 'install', 'upgrade')) { throw 'Unexpected Node.js setup action.' }
$source = Get-Content -Raw -LiteralPath $scriptPath
if ($source -notmatch 'winget\.Source install --id \$packageId --exact') {
    throw 'Node.js install must use the exact winget package.'
}
if ($source -notmatch 'winget\.Source upgrade --id \$packageId --exact') {
    throw 'Old Node.js versions must use the exact winget upgrade package.'
}
Write-Host 'Node.js prerequisite dry-run test passed'
