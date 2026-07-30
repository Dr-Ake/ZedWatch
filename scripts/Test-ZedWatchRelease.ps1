param(
    [string] $InstallRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$required = @(
    'Install ZedWatch.bat'
    'Launch ZedWatch.bat'
    'Uninstall ZedWatch.bat'
    'manager\server-manager.js'
    'manager\public\index.html'
    'manager\public\app.js'
    'manager\public\styles.css'
    'manager\lib\config.js'
    'manager\lib\rcon.js'
    'manager\lib\backups.js'
    'manager\lib\mods.js'
    'manager\lib\watchdog.js'
    'scripts\Install-ZedWatch.ps1'
    'scripts\New-ZedWatchLauncher.ps1'
    'scripts\Configure-ZedWatchFirewall.ps1'
    'scripts\Register-ZedWatchStartup.ps1'
    'scripts\Uninstall-ZedWatch.ps1'
)

foreach ($relative in $required) {
    $path = Join-Path $InstallRoot $relative
    if (-not (Test-Path -LiteralPath $path)) { throw "Required release file is missing: $relative" }
}

$forbidden = @(
    'PalSphere'
    'PalServer.exe'
    '2394010'
    '8219'
)
$sourceFiles = Get-ChildItem -LiteralPath $InstallRoot -Recurse -File |
    Where-Object {
        $_.FullName -ne $PSCommandPath -and
        $_.FullName -notmatch '\\(?:server|data|_steamcmd|\.runtime|_release|node_modules)\\' -and
        $_.Extension -in @('.js', '.ps1', '.bat', '.json', '.html', '.css', '.md')
    }
foreach ($term in $forbidden) {
    $match = $sourceFiles | Select-String -SimpleMatch $term | Select-Object -First 1
    if ($match) { throw "Release still contains a forbidden legacy term '$term' in $($match.Path):$($match.LineNumber)" }
}

$node = if (Test-Path -LiteralPath (Join-Path $InstallRoot '.runtime\node\node.exe')) {
    Join-Path $InstallRoot '.runtime\node\node.exe'
}
else {
    (Get-Command node.exe -ErrorAction Stop).Source
}

& $node --check (Join-Path $InstallRoot 'manager\server-manager.js')
if ($LASTEXITCODE -ne 0) { throw 'server-manager.js syntax check failed.' }
& $node --check (Join-Path $InstallRoot 'manager\public\app.js')
if ($LASTEXITCODE -ne 0) { throw 'public app.js syntax check failed.' }

& (Join-Path $InstallRoot 'scripts\Install-ZedWatch.ps1') -InstallRoot $InstallRoot -DryRun -NonInteractive
if ($LASTEXITCODE -ne 0) { throw 'Installer dry run failed.' }

Write-Host 'ZedWatch release verification passed.' -ForegroundColor Green
