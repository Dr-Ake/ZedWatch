param(
    [Parameter(Mandatory = $true)]
    [string] $InstallRoot,
    [Parameter(Mandatory = $true)]
    [ValidateSet('true', 'false', '1', '0', IgnoreCase = $true)]
    [string] $Enable
)

$ErrorActionPreference = 'Stop'
$enableRequested = $Enable -in @('true', '1')
$taskName = 'ZedWatch Server Studio'
$resolvedRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$launcher = Join-Path $resolvedRoot 'manager\launch-manager.ps1'

if (-not $enableRequested) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host 'ZedWatch will not start with Windows.'
    exit 0
}

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "ZedWatch startup launcher was not found: $launcher"
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -NoBrowser' -f $launcher) `
    -WorkingDirectory (Split-Path -Parent $launcher)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal `
    -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Starts the local ZedWatch manager at Windows sign-in.' `
    -Force | Out-Null

Write-Host 'ZedWatch will start quietly at Windows sign-in.'
