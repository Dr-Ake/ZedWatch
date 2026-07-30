param(
    [Parameter(Mandatory = $true)]
    [string] $InstallRoot,
    [switch] $Remove
)

$ErrorActionPreference = 'Stop'
$displayName = 'ZedWatch - Project Zomboid Game Server (UDP 16261-16262)'
$resolvedRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$javaPath = Join-Path $resolvedRoot 'server\jre64\bin\java.exe'

# Windows may create broad Java rules after its first network-consent prompt.
# Remove only rules targeting this bundled executable, then recreate the narrow game rule.
Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
    Where-Object { [string]::Equals([string] $_.Program, $javaPath, [StringComparison]::OrdinalIgnoreCase) } |
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue

Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue

if ($Remove) {
    Write-Host 'ZedWatch Windows Firewall rule removed.'
    exit 0
}

if (-not (Test-Path -LiteralPath $javaPath)) {
    throw "Project Zomboid's bundled Java runtime was not found: $javaPath"
}

New-NetFirewallRule `
    -DisplayName $displayName `
    -Direction Inbound `
    -Action Allow `
    -Enabled True `
    -Profile Any `
    -Protocol UDP `
    -LocalPort '16261-16262' `
    -Program $javaPath `
    -Description 'Allows only the two Project Zomboid game UDP ports for the bundled server Java executable.' | Out-Null

Write-Host 'Windows Firewall allows Project Zomboid UDP ports 16261 and 16262.'
