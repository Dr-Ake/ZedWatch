param(
    [string] $InstallRoot = (Split-Path -Parent $PSScriptRoot),
    [switch] $RemoveDownloadedFiles,
    [switch] $NonInteractive
)

$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$desktop = [IO.Path]::GetFullPath([Environment]::GetFolderPath('Desktop')).TrimEnd('\')
if ($InstallRoot.Length -le ($desktop.Length + 2) -or -not $InstallRoot.StartsWith($desktop, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to uninstall from an unexpected broad location: $InstallRoot"
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
    throw 'Run Uninstall ZedWatch.bat and approve the administrator prompt.'
}

$managerUrl = 'http://127.0.0.1:16300'
try {
    $session = Invoke-RestMethod -Uri "$managerUrl/api/session" -TimeoutSec 2
    $status = Invoke-RestMethod -Uri "$managerUrl/api/status" -TimeoutSec 3
    if ($status.running) {
        Write-Host 'Saving and stopping the Project Zomboid server...'
        Invoke-RestMethod `
            -Method Post `
            -Uri "$managerUrl/api/server/stop" `
            -Headers @{ 'X-ZedWatch-Token' = [string] $session.token } `
            -ContentType 'application/json' `
            -Body '{}' `
            -TimeoutSec 120 | Out-Null
    }
}
catch {
    $escapedRoot = $InstallRoot.Replace("'", "''")
    $process = Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*zombie.network.GameServer*' -and $_.CommandLine -like '*zedwatch*' -and $_.CommandLine -like "*$escapedRoot*" } |
        Select-Object -First 1
    if ($process) {
        throw "The ZedWatch game server is running as PID $($process.ProcessId), but safe shutdown was unavailable. Launch ZedWatch and use Save & Stop before uninstalling."
    }
}

$archiveRoot = Join-Path $InstallRoot '_uninstall-backups'
New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
$archivePath = Join-Path $archiveRoot ("ZedWatch-Uninstall-{0}.zip" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$archiveItems = @(
    (Join-Path $InstallRoot 'data')
    (Join-Path $InstallRoot 'manager\manager-settings.json')
    (Join-Path $InstallRoot 'manager\secrets.json')
    (Join-Path $InstallRoot 'manager\whitelist-ledger.json')
    (Join-Path $InstallRoot 'manager\backups')
    (Join-Path $InstallRoot 'ZedWatch Server Info - Private.txt')
) | Where-Object { Test-Path -LiteralPath $_ }

if ($archiveItems.Count) {
    Write-Host "Creating final recovery archive: $archivePath"
    Compress-Archive -LiteralPath $archiveItems -DestinationPath $archivePath -CompressionLevel Optimal -Force
}

& (Join-Path $InstallRoot 'scripts\Configure-ZedWatchFirewall.ps1') -InstallRoot $InstallRoot -Remove
& (Join-Path $InstallRoot 'scripts\Register-ZedWatchStartup.ps1') -InstallRoot $InstallRoot -Enable $false

$remove = $RemoveDownloadedFiles
if (-not $NonInteractive -and -not $RemoveDownloadedFiles) {
    $answer = (Read-Host 'Remove downloaded server files, saves, runtimes, logs, and private settings? [y/N]').Trim()
    $remove = $answer -match '^(?i)y(?:es)?$'
}

if ($remove) {
    $targets = @(
        'server'
        'data'
        '.runtime'
        '_steamcmd'
        '_prerequisites'
        'manager\backups'
        'manager\logs'
        'manager\config-history'
        'manager\mod-staging'
        'manager\restore-staging'
        'manager\manager-settings.json'
        'manager\secrets.json'
        'manager\whitelist-ledger.json'
        'manager\generated-start-server.bat'
        'ZedWatch Server Info - Private.txt'
    )
    foreach ($relative in $targets) {
        $target = [IO.Path]::GetFullPath((Join-Path $InstallRoot $relative))
        if (-not $target.StartsWith($InstallRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing unsafe uninstall target: $target"
        }
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Recurse -Force
        }
    }
    Write-Host 'Downloaded server files and live ZedWatch data were removed.'
}
else {
    Write-Host 'Downloaded server files and live data were preserved.'
}

Write-Host "Final recovery archive: $archivePath" -ForegroundColor Green
Write-Host 'ZedWatch source files remain so the recovery archive and installer are still available.'
