$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

$voices = @()
try {
    $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $voices = @(
            $synthesizer.GetInstalledVoices() |
                Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'zh-CN' } |
                ForEach-Object {
                    [pscustomobject]@{
                        name = $_.VoiceInfo.Name
                        culture = $_.VoiceInfo.Culture.Name
                    }
                }
        )
    } finally {
        $synthesizer.Dispose()
    }
} catch {
    # Some Windows installations intermittently throw a null reference from
    # System.Speech even though the same registered SAPI voices remain usable.
    $voices = @()
}

if ($voices.Count -eq 0) {
    $comVoice = New-Object -ComObject SAPI.SpVoice
    try {
        $voices = @(
            $comVoice.GetVoices() |
                Where-Object { $_.GetAttribute('Language') -match '(^|;)804($|;)' } |
                ForEach-Object {
                    [pscustomobject]@{
                        name = $_.GetDescription()
                        culture = 'zh-CN'
                    }
                }
        )
    } finally {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($comVoice)
    }
}

[Console]::Out.Write((ConvertTo-Json -InputObject $voices -Compress))
