# ZedWatch Server Studio

ZedWatch is a local Windows control panel and one-click installer for a private
Project Zomboid Dedicated Server. It installs the official server through
SteamCMD, keeps server data inside its own folder, and provides safe controls
for settings, access, saves, backups, updates, mods, and crash recovery.

## Defaults

- Project Zomboid public stable branch, Steam app `380870`
- Server identifier `zedwatch`
- Outbreak sandbox preset
- Eight players
- Private, direct-connect, whitelist-only access
- Initial normal player account `Drake`
- Game ports UDP `16261` and `16262`
- Local dashboard `127.0.0.1:16300`
- Local RCON TCP `27025` (not opened in Windows Firewall)
- 2 GB initial / 8 GB maximum Java heap
- No mods enabled initially
- Windows startup disabled initially

## Install and use

1. Keep this folder in a permanent writable location.
2. Double-click **Install ZedWatch.bat** and approve the administrator prompt.
3. When installation finishes, use **Launch ZedWatch.bat**.
4. Start and stop the game server through the dashboard.

Generated credentials are stored in
`ZedWatch Server Info - Private.txt`. Keep that file private.

For friends outside the home network, reserve this computer's LAN address and
forward UDP ports `16261` and `16262` to it in the router. ZedWatch configures
Windows Firewall but cannot safely configure the router.

## Development checks

```powershell
npm run verify
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-ZedWatchRelease.ps1
```

ZedWatch is an independent community project and is not affiliated with or
endorsed by The Indie Stone, Valve, or Microsoft.
