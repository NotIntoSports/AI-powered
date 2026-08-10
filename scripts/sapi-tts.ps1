[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [switch]$ForceCom
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$text = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($text)) {
    throw 'Speech text is empty.'
}

$systemSpeechSucceeded = $false
if (-not $ForceCom) {
    try {
        $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            $culture = [Globalization.CultureInfo]::GetCultureInfo('zh-CN')
            $synthesizer.SelectVoiceByHints(
                [System.Speech.Synthesis.VoiceGender]::NotSet,
                [System.Speech.Synthesis.VoiceAge]::NotSet,
                0,
                $culture
            )
            $synthesizer.Rate = -1
            $synthesizer.SetOutputToWaveFile($OutputPath)
            $synthesizer.Speak($text)
            $systemSpeechSucceeded = $true
        } finally {
            $synthesizer.Dispose()
        }
    } catch {
        Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
    }
}

if (-not $systemSpeechSucceeded) {
    $comVoice = New-Object -ComObject SAPI.SpVoice
    $fileStream = New-Object -ComObject SAPI.SpFileStream
    try {
        $chineseVoice = @(
            $comVoice.GetVoices() |
                Where-Object { $_.GetAttribute('Language') -match '(^|;)804($|;)' }
        ) | Select-Object -First 1
        if (-not $chineseVoice) {
            throw 'No zh-CN SAPI voice is installed.'
        }
        $comVoice.Voice = $chineseVoice
        $comVoice.Rate = -1
        # SSFMCreateForWrite = 3.
        $fileStream.Open($OutputPath, 3, $false)
        $comVoice.AudioOutputStream = $fileStream
        [void]$comVoice.Speak($text, 0)
    } finally {
        try { $fileStream.Close() } catch {}
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($fileStream)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($comVoice)
    }
}
