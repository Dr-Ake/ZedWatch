# Security

ZedWatch binds its dashboard to `127.0.0.1` and opens only the two Project
Zomboid UDP game ports in Windows Firewall. Its RCON port is not exposed.

Do not publish `ZedWatch Server Info - Private.txt`, `manager/secrets.json`,
server INI files containing RCON credentials, player databases, logs, or
backup archives. ZedWatch redacts credential-bearing commands from activity
logs, but logs should still be reviewed before sharing.
