param(
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'
$managerUrl = 'http://127.0.0.1:16300/'
$healthUrl = 'http://127.0.0.1:16300/api/health'
$serverScript = Join-Path $PSScriptRoot 'server-manager.js'
$installRoot = Split-Path -Parent $PSScriptRoot
$portableNode = Join-Path $installRoot '.runtime\node\node.exe'
$packagePath = Join-Path $installRoot 'package.json'
$expectedVersion = if (Test-Path -LiteralPath $packagePath) {
    [string] ((Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version)
}

function Get-ManagerHealth {
    try {
        return Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    }
    catch {
        return $null
    }
}

function Test-ExpectedManager {
    $health = Get-ManagerHealth
    if ($null -eq $health -or $health.ok -ne $true) { return $false }
    if ($expectedVersion -and -not [string]::Equals([string] $health.version, $expectedVersion, [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    $runningRoot = [IO.Path]::GetFullPath([string] $health.installRoot).TrimEnd('\')
    $expectedRoot = [IO.Path]::GetFullPath($installRoot).TrimEnd('\')
    return [string]::Equals($runningRoot, $expectedRoot, [StringComparison]::OrdinalIgnoreCase)
}

if (-not (Test-ExpectedManager)) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 16300 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $owner = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $listener.OwningProcess) -ErrorAction SilentlyContinue
        $command = if ($owner) { [string] $owner.CommandLine } else { 'unknown process' }
        throw "Port 16300 is already used by another program (PID $($listener.OwningProcess)): $command"
    }

    $node = if (Test-Path -LiteralPath $portableNode) {
        $portableNode
    }
    else {
        (Get-Command node.exe -ErrorAction Stop).Source
    }

    Start-Process `
        -FilePath $node `
        -ArgumentList ('"{0}"' -f $serverScript) `
        -WorkingDirectory $PSScriptRoot `
        -WindowStyle Hidden | Out-Null

    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline -and -not (Test-ExpectedManager)) {
        Start-Sleep -Milliseconds 400
    }
}

if (-not (Test-ExpectedManager)) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        "ZedWatch could not start. Check manager\logs\activity.ndjson for details.",
        'ZedWatch Server Studio',
        'OK',
        'Error'
    ) | Out-Null
    exit 1
}

if (-not $NoBrowser) {
    Start-Process $managerUrl
}
