[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Protect', 'Unprotect')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::LoadWithPartialName('System.Security')
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$value = [Console]::In.ReadToEnd()
if ($Mode -eq 'Protect') {
    $plainBytes = [Text.Encoding]::UTF8.GetBytes($value)
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
    exit 0
}

$cipherBytes = [Convert]::FromBase64String($value)
$unprotectedBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $cipherBytes,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($unprotectedBytes))
