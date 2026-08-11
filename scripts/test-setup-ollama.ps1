$ErrorActionPreference = 'Stop'
$setupScript = Join-Path $PSScriptRoot 'setup-ollama.ps1'
$output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File $setupScript -Model 'qwen3.5:4b' -DryRun -Json
if ($LASTEXITCODE -ne 0) { throw 'Ollama setup dry run failed.' }
$plan = $output | ConvertFrom-Json
if ($plan.package -ne 'Ollama.Ollama') { throw 'Unexpected winget package.' }
if ($plan.model -ne 'qwen3.5:4b') { throw 'Unexpected default model.' }
if ($plan.endpoint -ne 'http://127.0.0.1:11434/v1') { throw 'Unexpected Ollama endpoint.' }
if ($plan.estimatedModelDownload -ne '3.4GB') { throw 'Unexpected model size estimate.' }
$source = Get-Content -Raw -LiteralPath $setupScript
if ($source -notmatch 'encryptedApiKey\s*=\s*\$null') {
    throw 'Local Ollama setup must clear any previously stored remote API key.'
}
Write-Host 'Ollama setup dry-run test passed'
