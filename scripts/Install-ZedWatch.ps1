param(
    [string] $InstallRoot = (Split-Path -Parent $PSScriptRoot),
    [switch] $DryRun,
    [switch] $NonInteractive
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$ServerRoot = Join-Path $InstallRoot 'server'
$DataRoot = Join-Path $InstallRoot 'data'
$SteamCmdRoot = Join-Path $InstallRoot '_steamcmd'
$RuntimeRoot = Join-Path $InstallRoot '.runtime'
$ManagerRoot = Join-Path $InstallRoot 'manager'
$LogsRoot = Join-Path $ManagerRoot 'logs'
$ConfigRoot = Join-Path $DataRoot 'Server'
$ConfigPath = Join-Path $ConfigRoot 'zedwatch.ini'
$SandboxPath = Join-Path $ConfigRoot 'zedwatch_SandboxVars.lua'
$SecretsPath = Join-Path $ManagerRoot 'secrets.json'
$SettingsPath = Join-Path $ManagerRoot 'manager-settings.json'
$WhitelistPath = Join-Path $ManagerRoot 'whitelist-ledger.json'
$PrivateInfoPath = Join-Path $InstallRoot 'ZedWatch Server Info - Private.txt'
$SteamCmdUrl = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
$NodeIndexUrl = 'https://nodejs.org/dist/index.json'

function Write-Step([string] $Text) {
    Write-Host "`n==> $Text" -ForegroundColor Cyan
}

function Write-Utf8NoBom([string] $Path, [object] $Content) {
    $text = if ($Content -is [array]) { ($Content -join "`r`n") + "`r`n" } else { [string] $Content }
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
}

function Protect-PrivatePath([string] $Path, [bool] $Container = $false) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $security = if ($Container) {
        [Security.AccessControl.DirectorySecurity]::new()
    }
    else {
        [Security.AccessControl.FileSecurity]::new()
    }
    $security.SetOwner($currentSid)
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = if ($Container) {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    }
    else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $security.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $security
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-SecurePassword([int] $Length = 24) {
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_'
    $bytes = New-Object byte[] $Length
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

function Invoke-Download([string] $Uri, [string] $Destination) {
    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing -TimeoutSec 120
    if (-not (Test-Path -LiteralPath $Destination) -or (Get-Item -LiteralPath $Destination).Length -eq 0) {
        throw "Download did not produce a usable file: $Uri"
    }
}

function Install-PortableNode {
    $nodeExe = Join-Path $RuntimeRoot 'node\node.exe'
    if (Test-Path -LiteralPath $nodeExe) {
        $version = & $nodeExe --version
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Portable Node.js $version is ready."
            return $nodeExe
        }
    }

    Write-Step 'Downloading a verified portable Node.js LTS runtime'
    $releases = Invoke-RestMethod -Uri $NodeIndexUrl -TimeoutSec 30
    $release = $releases | Where-Object { $_.lts -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
    if (-not $release) { throw 'Node.js did not publish a usable Windows x64 LTS archive.' }
    $archiveName = "node-$($release.version)-win-x64.zip"
    $versionRoot = "https://nodejs.org/dist/$($release.version)"
    $archivePath = Join-Path $RuntimeRoot $archiveName
    $sumsPath = Join-Path $RuntimeRoot 'SHASUMS256.txt'
    Invoke-Download "$versionRoot/$archiveName" $archivePath
    Invoke-Download "$versionRoot/SHASUMS256.txt" $sumsPath
    $sumLine = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match ("\s{0}$" -f [regex]::Escape($archiveName)) } | Select-Object -First 1
    $sumMatch = if ($sumLine) { [regex]::Match($sumLine, '^([a-fA-F0-9]{64})') } else { $null }
    if (-not $sumMatch -or -not $sumMatch.Success) { throw 'Could not find the Node.js archive checksum.' }
    $expectedHash = $sumMatch.Groups[1].Value
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if (-not [string]::Equals($actualHash, $expectedHash, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Node.js archive checksum verification failed.'
    }

    $extractRoot = Join-Path $RuntimeRoot 'node-extract'
    if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
    $extractedNode = Get-ChildItem -LiteralPath $extractRoot -Filter node.exe -Recurse -File | Select-Object -First 1
    if (-not $extractedNode) { throw 'Node.js archive layout was not recognized.' }
    $sourceDirectory = Split-Path -Parent $extractedNode.FullName
    $nodeDirectory = Join-Path $RuntimeRoot 'node'
    if (Test-Path -LiteralPath $nodeDirectory) { Remove-Item -LiteralPath $nodeDirectory -Recurse -Force }
    Move-Item -LiteralPath $sourceDirectory -Destination $nodeDirectory
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
    Remove-Item -LiteralPath $archivePath, $sumsPath -Force
    if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'Portable Node.js installation did not produce node.exe.' }
    Write-Host "Portable Node.js $(& $nodeExe --version) installed." -ForegroundColor Green
    return $nodeExe
}

function Install-SteamCmd {
    $steamExe = Join-Path $SteamCmdRoot 'steamcmd.exe'
    if (-not (Test-Path -LiteralPath $steamExe)) {
        Write-Step 'Downloading SteamCMD from Valve'
        New-Item -ItemType Directory -Path $SteamCmdRoot -Force | Out-Null
        $archive = Join-Path $SteamCmdRoot 'steamcmd.zip'
        Invoke-Download $SteamCmdUrl $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $SteamCmdRoot -Force
        Remove-Item -LiteralPath $archive -Force
    }
    if (-not (Test-Path -LiteralPath $steamExe)) { throw 'SteamCMD installation did not produce steamcmd.exe.' }
    $initialized = $false
    for ($attempt = 1; $attempt -le 3 -and -not $initialized; $attempt++) {
        & $steamExe '+quit' | Out-Host
        if ($LASTEXITCODE -eq 0) {
            $initialized = $true
        }
        elseif ($attempt -lt 3) {
            Write-Warning "SteamCMD initialization attempt $attempt returned exit code $LASTEXITCODE; retrying after its self-update."
            Start-Sleep -Seconds 2
        }
    }
    if (-not $initialized) { throw "SteamCMD initialization failed after three attempts with exit code $LASTEXITCODE." }
    return $steamExe
}

function Install-ZomboidServer([string] $SteamExe) {
    Write-Step 'Installing Project Zomboid Dedicated Server Build 42 from Steam'
    New-Item -ItemType Directory -Path $ServerRoot -Force | Out-Null
    & $SteamExe '+force_install_dir' $ServerRoot '+login' 'anonymous' '+app_info_update' '1' '+app_update' '380870' 'validate' '+quit'
    if ($LASTEXITCODE -ne 0) { throw "SteamCMD failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path -LiteralPath (Join-Path $ServerRoot 'StartServer64.bat'))) {
        throw 'SteamCMD finished, but StartServer64.bat is missing.'
    }
}

function Set-IniValue([string] $Path, [string] $Key, [string] $Value) {
    $content = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw } else { '' }
    $pattern = '(?m)^' + [regex]::Escape($Key) + '=.*$'
    $replacement = "$Key=$Value"
    if ($content -match $pattern) {
        $content = [regex]::Replace($content, $pattern, { param($match) $replacement }, 1)
    }
    else {
        $content = $content.TrimEnd() + "`r`n$replacement`r`n"
    }
    Write-Utf8NoBom -Path $Path -Content $content
}

function Invoke-ServerBootstrap([string] $AdminPassword) {
    Write-Step 'Generating Build 42 server configuration'
    & (Join-Path $InstallRoot 'scripts\New-ZedWatchLauncher.ps1') -InstallRoot $InstallRoot -AdminPassword $AdminPassword | Out-Null
    $launcher = Join-Path $ManagerRoot 'generated-start-server.bat'
    $bootstrapLog = Join-Path $LogsRoot 'bootstrap.log'
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'cmd.exe'
    $startInfo.Arguments = ('/d /s /c ""{0}""' -f $launcher)
    $startInfo.WorkingDirectory = $ServerRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'Could not start Project Zomboid for initial configuration.' }
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()

    $deadline = (Get-Date).AddMinutes(10)
    while ((Get-Date) -lt $deadline -and -not $process.HasExited -and -not (Test-Path -LiteralPath $ConfigPath)) {
        Start-Sleep -Seconds 2
    }
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        try { $process.Kill($true) } catch {}
        throw 'Project Zomboid did not generate its server configuration within ten minutes.'
    }

    Start-Sleep -Seconds 35
    if (-not $process.HasExited) {
        $process.StandardInput.WriteLine('quit')
        $process.StandardInput.Flush()
        if (-not $process.WaitForExit(120000)) {
            $process.Kill($true)
            $process.WaitForExit()
        }
    }
    $output = $outputTask.GetAwaiter().GetResult() + "`r`n" + $errorTask.GetAwaiter().GetResult()
    Write-Utf8NoBom -Path $bootstrapLog -Content $output
}

function Initialize-OutbreakPreset {
    Write-Step 'Applying the installed Build 42 Outbreak preset'
    $preset = Get-ChildItem -LiteralPath $ServerRoot -Filter 'Outbreak.lua' -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '(?i)[\\/]Sandbox[\\/]' } |
        Select-Object -First 1
    if (-not $preset) {
        Write-Warning 'The installed server did not include a discoverable Outbreak.lua preset. Keeping the generated Build 42 sandbox file.'
        return
    }
    $content = Get-Content -LiteralPath $preset.FullName -Raw
    if ($content -match '(?m)^\s*return\s*{') {
        $content = [regex]::Replace($content, '(?m)^\s*return\s*{', 'SandboxVars = {', 1)
    }
    elseif ($content -notmatch '(?m)^\s*SandboxVars\s*=\s*{') {
        Write-Warning "Outbreak preset format was not recognized: $($preset.FullName). Keeping the generated sandbox file."
        return
    }
    Write-Utf8NoBom -Path $SandboxPath -Content $content
    Write-Host "Outbreak preset copied from $($preset.FullName)." -ForegroundColor Green
}

function Initialize-ZedWatchConfiguration([pscustomobject] $SecretValues, [bool] $FreshInstall) {
    New-Item -ItemType Directory -Path $ConfigRoot -Force | Out-Null
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        Invoke-ServerBootstrap $SecretValues.adminPassword
    }
    if ($FreshInstall) {
        Initialize-OutbreakPreset
        $bootstrapWorld = Join-Path $DataRoot 'Saves\Multiplayer\zedwatch'
        if (Test-Path -LiteralPath $bootstrapWorld) {
            $resolvedWorld = [IO.Path]::GetFullPath($bootstrapWorld)
            if (-not $resolvedWorld.StartsWith($DataRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to clear an unsafe bootstrap path: $resolvedWorld"
            }
            Remove-Item -LiteralPath $resolvedWorld -Recurse -Force
        }
    }

    $welcome = 'Welcome to the Knox Event Exclusion Zone.<LINE>Hosted by ZedWatch'
    $settings = @{
        PublicName = 'ZedWatch'
        PublicDescription = 'Private Project Zomboid survival server hosted with ZedWatch'
        Public = 'false'
        Open = 'false'
        AutoCreateUserInWhiteList = 'false'
        Password = ''
        MaxPlayers = '8'
        PauseEmpty = 'true'
        UPnP = 'false'
        DefaultPort = '16261'
        UDPPort = '16262'
        RCONPort = '27025'
        RCONPassword = $SecretValues.rconPassword
        ServerWelcomeMessage = $welcome
        WorkshopItems = ''
        Mods = ''
        BackupsCount = '5'
        BackupsOnStart = 'true'
        BackupsOnVersionChange = 'true'
        BackupsPeriod = '0'
    }
    foreach ($entry in $settings.GetEnumerator()) {
        Set-IniValue -Path $ConfigPath -Key $entry.Key -Value ([string] $entry.Value)
    }

    & (Join-Path $InstallRoot 'scripts\New-ZedWatchLauncher.ps1') -InstallRoot $InstallRoot | Out-Null
}

function Write-PrivateInfo([pscustomobject] $SecretValues) {
    $lines = @(
        'ZedWatch Server Information - PRIVATE'
        '====================================='
        ''
        ('Created: {0}' -f (Get-Date))
        'Server name: ZedWatch'
        'Server ID: zedwatch'
        'Game ports: UDP 16261 and UDP 16262'
        'Access mode: whitelist'
        'Public listing: disabled'
        ''
        'PLAYER ACCOUNT'
        '--------------'
        'Username: Drake'
        ('Password: {0}' -f $SecretValues.initialPlayerPassword)
        ''
        'PASSWORD MODE'
        '-------------'
        ('Shared join password: {0}' -f $SecretValues.sharedJoinPassword)
        ''
        'ADMINISTRATION'
        '--------------'
        'Admin username: admin'
        ('Admin password: {0}' -f $SecretValues.adminPassword)
        ('RCON password: {0}' -f $SecretValues.rconPassword)
        'RCON is intentionally not opened in Windows Firewall.'
        ''
        'ROUTER'
        '------'
        'Forward UDP 16261 and UDP 16262 to this computer''s reserved LAN address.'
        ''
        'Keep this file private. Do not post it in screenshots, Discord, or support logs.'
    )
    Write-Utf8NoBom -Path $PrivateInfoPath -Content $lines
}

if ($DryRun) {
    Write-Host 'ZedWatch installer dry run'
    Write-Host "Install root: $InstallRoot"
    Write-Host 'Would install verified portable Node.js LTS.'
    Write-Host 'Would install SteamCMD and public stable app 380870.'
    Write-Host 'Would bootstrap Build 42 configuration, Outbreak, whitelist access, and the Drake account.'
    Write-Host 'Would allow only UDP 16261-16262 for the bundled server Java executable.'
    exit 0
}

if (-not (Test-IsAdministrator)) {
    throw 'Run Install ZedWatch.bat and approve the Windows administrator prompt.'
}

New-Item -ItemType Directory -Path $LogsRoot -Force | Out-Null
$transcriptPath = Join-Path $LogsRoot 'install.log'
Start-Transcript -LiteralPath $transcriptPath -Append | Out-Null
try {
    Write-Step 'Checking ZedWatch installation'
    $freshInstall = -not (Test-Path -LiteralPath $ConfigPath)
    $secrets = if (Test-Path -LiteralPath $SecretsPath) {
        Get-Content -LiteralPath $SecretsPath -Raw | ConvertFrom-Json
    }
    else {
        [pscustomobject] @{
            adminPassword = New-SecurePassword
            rconPassword = New-SecurePassword
            sharedJoinPassword = New-SecurePassword
            initialPlayerPassword = New-SecurePassword
            playerPasswords = [pscustomobject] @{}
        }
    }
    foreach ($name in @('adminPassword', 'rconPassword', 'sharedJoinPassword', 'initialPlayerPassword')) {
        if ([string]::IsNullOrWhiteSpace([string] $secrets.$name)) { $secrets.$name = New-SecurePassword }
    }
    Write-Utf8NoBom -Path $SecretsPath -Content ($secrets | ConvertTo-Json -Depth 5)

    if (-not (Test-Path -LiteralPath $SettingsPath)) {
        Copy-Item -LiteralPath (Join-Path $ManagerRoot 'manager-settings.example.json') -Destination $SettingsPath
    }
    if (-not (Test-Path -LiteralPath $WhitelistPath)) {
        Write-Utf8NoBom -Path $WhitelistPath -Content '[]'
    }

    $nodeExe = Install-PortableNode
    $steamExe = Install-SteamCmd
    Install-ZomboidServer $steamExe
    Initialize-ZedWatchConfiguration -SecretValues $secrets -FreshInstall $freshInstall

    Write-Step 'Configuring Windows Firewall'
    & (Join-Path $InstallRoot 'scripts\Configure-ZedWatchFirewall.ps1') -InstallRoot $InstallRoot
    & (Join-Path $InstallRoot 'scripts\Register-ZedWatchStartup.ps1') -InstallRoot $InstallRoot -Enable $false
    Write-PrivateInfo $secrets
    Protect-PrivatePath -Path $ManagerRoot -Container $true
    foreach ($privatePath in @($SecretsPath, $SettingsPath, $WhitelistPath)) {
        Protect-PrivatePath -Path $privatePath
    }
    Protect-PrivatePath -Path $PrivateInfoPath

    Write-Step 'Starting ZedWatch and the Project Zomboid server'
    & (Join-Path $ManagerRoot 'launch-manager.ps1') -NoBrowser
    $session = Invoke-RestMethod -Uri 'http://127.0.0.1:16300/api/session' -TimeoutSec 10
    $headers = @{ 'X-ZedWatch-Token' = [string] $session.token }
    Invoke-RestMethod `
        -Method Post `
        -Uri 'http://127.0.0.1:16300/api/server/start' `
        -Headers $headers `
        -ContentType 'application/json' `
        -Body '{}' `
        -TimeoutSec 300 | Out-Null
    Start-Process 'http://127.0.0.1:16300/'

    Write-Host "`nZedWatch installation is complete." -ForegroundColor Green
    Write-Host "Private connection details: $PrivateInfoPath" -ForegroundColor Yellow
}
finally {
    Stop-Transcript | Out-Null
}
