'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { URL } = require('url');

const { createSnapshot, listBuiltInBackups, listSnapshots, restoreBuiltInBackup, restoreSnapshot, safeName } = require('./lib/backups');
const { requireMutationToken: verifyMutationToken } = require('./lib/api-security');
const { discoverAuthenticatedAccounts, reconcileAccountLedger } = require('./lib/accounts');
const { accessModeValues, enrichInstalledSettings, ensureWelcomeSignature, parseIni, parseLuaSettings, readIniFile, readSandboxPresets, setIniValues, updateIni, updateLuaSettings, validateSharedPassword } = require('./lib/config');
const { discoverMods, importZip, joinList, lookupWorkshopItem, parseWorkshopId, removeLocalMod, splitList } = require('./lib/mods');
const { resolveLanIp } = require('./lib/network');
const { RconClient } = require('./lib/rcon');
const { detectGameVersion } = require('./lib/version');
const { CrashWatchdog, normalizeWatchdogSettings } = require('./lib/watchdog');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = 16300;
const MANAGER_VERSION = '1.0.0';
const SERVER_ID = 'zedwatch';
const SERVER_DIR = path.join(ROOT, 'server');
const DATA_DIR = path.join(ROOT, 'data');
const GAME_LOGS_DIR = path.join(DATA_DIR, 'Logs');
const SERVER_CONFIG_DIR = path.join(DATA_DIR, 'Server');
const CONFIG_PATH = path.join(SERVER_CONFIG_DIR, `${SERVER_ID}.ini`);
const SANDBOX_PATH = path.join(SERVER_CONFIG_DIR, `${SERVER_ID}_SandboxVars.lua`);
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOGS_DIR = path.join(__dirname, 'logs');
const ACTIVITY_PATH = path.join(LOGS_DIR, 'activity.ndjson');
const SERVER_LOG_PATH = path.join(LOGS_DIR, 'server-console.log');
const UPDATE_LOG_PATH = path.join(LOGS_DIR, 'update.log');
const MANAGER_SETTINGS_PATH = path.join(__dirname, 'manager-settings.json');
const SECRETS_PATH = path.join(__dirname, 'secrets.json');
const WHITELIST_LEDGER_PATH = path.join(__dirname, 'whitelist-ledger.json');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const MOD_STAGING_DIR = path.join(__dirname, 'mod-staging');
const LOCAL_MODS_DIR = path.join(DATA_DIR, 'mods');
const GENERATED_LAUNCHER = path.join(__dirname, 'generated-start-server.bat');
const STEAMCMD_PATH = path.join(ROOT, '_steamcmd', 'steamcmd.exe');
const PRIVATE_INFO_PATH = path.join(ROOT, 'ZedWatch Server Info - Private.txt');
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
const ADVANCED_FILES = new Set([
  `${SERVER_ID}_SandboxVars.lua`,
  `${SERVER_ID}_spawnregions.lua`,
  `${SERVER_ID}_spawnpoints.lua`,
]);

fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });
fs.mkdirSync(MOD_STAGING_DIR, { recursive: true });

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return structuredClone(fallback); }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function securePassword(length = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_';
  const bytes = crypto.randomBytes(length);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

const defaultManagerSettings = {
  accessMode: 'whitelist',
  publicListing: false,
  startupEnabled: false,
  desiredRunning: false,
  watchdog: {
    enabled: true,
    pollIntervalSeconds: 15,
    restartDelaySeconds: 30,
    maxRestarts: 3,
    restartWindowMinutes: 10,
  },
};

let managerSettings = {
  ...defaultManagerSettings,
  ...readJson(MANAGER_SETTINGS_PATH, defaultManagerSettings),
};
managerSettings.watchdog = normalizeWatchdogSettings(managerSettings.watchdog);
let secrets = readJson(SECRETS_PATH, {
  adminPassword: '',
  rconPassword: '',
  sharedJoinPassword: '',
  playerPasswords: {},
});
let whitelistLedger = readJson(WHITELIST_LEDGER_PATH, []);
let managedChild = null;
let managedPid = null;
let managedStartedAt = null;
let updateProcess = null;
let transition = null;
let publicIpCache = { value: null, expiresAt: 0 };
let lastKnownPlayers = [];
let watchdog = null;

function persistSettings() {
  writeJson(MANAGER_SETTINGS_PATH, managerSettings);
}

function persistSecrets() {
  writeJson(SECRETS_PATH, secrets);
}

function persistWhitelist() {
  writeJson(WHITELIST_LEDGER_PATH, whitelistLedger);
}

function whitelistEntry(username, { includeRemoved = false } = {}) {
  const key = String(username || '').toLowerCase();
  return whitelistLedger.find((entry) =>
    String(entry.username || '').toLowerCase() === key && (includeRemoved || !entry.removed));
}

function playerPasswordKey(username) {
  const key = String(username || '').toLowerCase();
  return Object.keys(secrets.playerPasswords || {}).find((item) => item.toLowerCase() === key);
}

function storedPlayerPassword(username) {
  const key = playerPasswordKey(username);
  return key ? secrets.playerPasswords[key] : '';
}

function storePlayerPassword(username, password) {
  secrets.playerPasswords ||= {};
  const existingKey = playerPasswordKey(username);
  if (existingKey && existingKey !== username) delete secrets.playerPasswords[existingKey];
  secrets.playerPasswords[username] = password;
}

function forgetPlayerPassword(username) {
  const key = playerPasswordKey(username);
  if (key) delete secrets.playerPasswords[key];
}

function visibleWhitelistEntries() {
  return whitelistLedger
    .filter((entry) => !entry.removed)
    .map((entry) => ({
      ...entry,
      passwordStored: Boolean(storedPlayerPassword(entry.username)),
    }));
}

function syncWhitelistAccounts() {
  const discovered = discoverAuthenticatedAccounts(GAME_LOGS_DIR);
  const result = reconcileAccountLedger(whitelistLedger, discovered);
  if (!result.changed) return result;
  whitelistLedger = result.ledger;
  persistWhitelist();
  updatePrivateInfo();
  for (const username of result.added) {
    logEvent('access', `Discovered player-created account ${username}.`);
  }
  for (const username of result.restored) {
    logEvent('access', `Rediscovered player-created account ${username} after a new successful login.`);
  }
  return result;
}

function migrateLegacyPlayerAccountState() {
  const legacyPassword = secrets.initialPlayerPassword;
  const legacyEntry = whitelistLedger.find((entry) => entry.initial === true && entry.username);
  const hadLegacySecret = Object.prototype.hasOwnProperty.call(secrets, 'initialPlayerPassword');
  const hadLegacyFlags = whitelistLedger.some((entry) => Object.prototype.hasOwnProperty.call(entry, 'initial'));
  secrets.playerPasswords ||= {};
  if (legacyPassword && legacyEntry && !secrets.playerPasswords[legacyEntry.username]) {
    secrets.playerPasswords[legacyEntry.username] = legacyPassword;
  }
  delete secrets.initialPlayerPassword;
  whitelistLedger = whitelistLedger.map(({ initial: ignored, ...entry }) => entry);
  if (hadLegacySecret) persistSecrets();
  if (hadLegacyFlags) persistWhitelist();
  if (hadLegacySecret || hadLegacyFlags) updatePrivateInfo();
}

migrateLegacyPlayerAccountState();

function redactText(value) {
  let text = String(value ?? '');
  const candidates = [
    secrets.adminPassword,
    secrets.rconPassword,
    secrets.sharedJoinPassword,
    ...Object.values(secrets.playerPasswords || {}),
  ].filter(Boolean);
  for (const secret of candidates) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/((?:adduser|setpassword)\s+(?:"[^"]*"|\S+)\s+)(?:"[^"]*"|\S+)/gi, '$1[REDACTED]');
  return text;
}

function logEvent(type, message, metadata = {}) {
  const entry = {
    at: new Date().toISOString(),
    type,
    message: redactText(message),
    metadata: JSON.parse(redactText(JSON.stringify(metadata || {}))),
  };
  fs.appendFileSync(ACTIVITY_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

function recentActivity(limit = 120) {
  if (!fs.existsSync(ACTIVITY_PATH)) return [];
  return fs.readFileSync(ACTIVITY_PATH, 'utf8').trim().split(/\r?\n/)
    .filter(Boolean).slice(-Math.max(1, Math.min(500, limit))).reverse()
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

function configValues() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  return Object.fromEntries(parseIni(fs.readFileSync(CONFIG_PATH, 'utf8')).entries.map((entry) => [entry.key, entry.value]));
}

function saveSecuritySettings() {
  setIniValues(CONFIG_PATH, {
    ...accessModeValues({
      mode: managerSettings.accessMode,
      publicListing: managerSettings.publicListing,
      sharedPassword: secrets.sharedJoinPassword,
    }),
    RCONPort: '27025',
    RCONPassword: secrets.rconPassword,
  });
}

function updatePrivateInfo() {
  const values = configValues();
  const visibleAccounts = whitelistLedger.filter((entry) => !entry.removed);
  const accountLines = visibleAccounts.length
    ? visibleAccounts.flatMap((entry) => [
      `Username: ${entry.username}`,
      `Status: ${entry.enabled ? 'enabled' : 'disabled'}`,
      `Password: ${storedPlayerPassword(entry.username) || '(player-chosen; reset it in ZedWatch if forgotten)'}`,
      '',
    ])
    : [
      'No player accounts are configured.',
      'Add accounts in the dashboard under Players & access.',
      '',
    ];
  const lines = [
    'ZedWatch Server Information - PRIVATE',
    '=====================================',
    '',
    `Updated: ${new Date().toLocaleString()}`,
    `Server name: ${values.PublicName || 'ZedWatch'}`,
    `Server ID: ${SERVER_ID}`,
    `Game port: ${values.DefaultPort || 16261} UDP`,
    `Secondary port: ${values.UDPPort || 16262} UDP`,
    `Access mode: ${managerSettings.accessMode}`,
    `Public listing: ${managerSettings.publicListing ? 'enabled' : 'disabled'}`,
    '',
    'PLAYER ACCOUNTS',
    '---------------',
    ...accountLines,
    'PASSWORD MODE',
    '-------------',
    `Shared join password: ${secrets.sharedJoinPassword || '(not generated)'}`,
    '',
    'ADMINISTRATION',
    '--------------',
    'Admin username: admin',
    `Admin password: ${secrets.adminPassword || '(created during installation)'}`,
    `RCON password: ${secrets.rconPassword || '(created during installation)'}`,
    'RCON is intentionally not opened in Windows Firewall.',
    '',
    'FRIENDS OUTSIDE YOUR HOME',
    '-------------------------',
    'Reserve this PC address in the router, then forward:',
    'UDP 16261 -> this PC',
    'UDP 16262 -> this PC',
    '',
    'Keep this file private. Do not post it in Discord, screenshots, or support logs.',
  ];
  fs.writeFileSync(PRIVATE_INFO_PATH, `${lines.join('\r\n')}\r\n`, 'utf8');
}

function rcon() {
  const values = configValues();
  return new RconClient({
    port: Number(values.RCONPort || 27025),
    password: secrets.rconPassword || values.RCONPassword,
  });
}

async function discoverServerProcess() {
  const managedShell = managedChild && managedChild.exitCode === null && managedChild.pid
    ? { pid: managedChild.pid, memoryBytes: 0 }
    : null;
  const escapedRoot = ROOT.replace(/'/g, "''");
  const script = [
    `$root='${escapedRoot}'`,
    "$process = Get-CimInstance Win32_Process -Filter \"Name='java.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*zombie.network.GameServer*' -and $_.CommandLine -like '*zedwatch*' -and $_.CommandLine -like \"*$root*\" } | Select-Object -First 1",
    'if ($process) {',
    '  $live = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue',
    '  [pscustomobject]@{ pid = [int]$process.ProcessId; memoryBytes = if($live){[long]$live.WorkingSet64}else{0} } | ConvertTo-Json -Compress',
    '}',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], {
      windowsHide: true,
      timeout: 5000,
    });
    const line = String(stdout || '').trim().split(/\r?\n/).find((item) => item.startsWith('{'));
    if (!line) {
      managedPid = managedShell?.pid || null;
      return managedShell;
    }
    const result = JSON.parse(line);
    managedPid = Number(result.pid);
    return result;
  } catch {
    return managedShell;
  }
}

async function isServerRunning() {
  return Boolean(await discoverServerProcess());
}

async function isUpdateRunning() {
  return Boolean(updateProcess && updateProcess.exitCode === null);
}

async function detectPortCollisions() {
  const script = [
    "$udp = Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(16261,16262) } | Select-Object LocalPort,OwningProcess",
    "$tcp = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 27025 } | Select-Object LocalPort,OwningProcess",
    '@($udp) + @($tcp) | ConvertTo-Json -Compress',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], {
      windowsHide: true,
      timeout: 5000,
    });
    const text = String(stdout || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((entry) => Number(entry.OwningProcess) !== Number(managedPid));
  } catch {
    return [];
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRcon(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!(await isServerRunning())) throw new Error('The Project Zomboid process exited during startup.');
    try {
      await rcon().execute('players');
      return;
    } catch (error) {
      lastError = error;
      await wait(2000);
    }
  }
  throw new Error(`The server process started, but RCON did not become ready: ${lastError?.message || 'timeout'}`);
}

function quoteRcon(value) {
  const text = String(value || '');
  if (/[\r\n]/.test(text)) throw new Error('Command values cannot contain line breaks.');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!/^[A-Za-z0-9_. -]{1,32}$/.test(value)) throw new Error('Usernames may contain letters, numbers, spaces, dots, underscores, and hyphens.');
  return value;
}

async function launchServer(source = 'manual') {
  if (await isUpdateRunning()) throw new Error('Wait for the server update to finish.');
  if (await isServerRunning()) return { alreadyRunning: true, pid: managedPid };
  if (!fs.existsSync(GENERATED_LAUNCHER)) throw new Error('Managed launcher is missing. Run Install ZedWatch.bat to repair the installation.');
  saveSecuritySettings();
  const collisions = await detectPortCollisions();
  if (collisions.length) {
    throw new Error(`A different process is already using ZedWatch port(s): ${collisions.map((entry) => `${entry.LocalPort} (PID ${entry.OwningProcess})`).join(', ')}.`);
  }
  transition = { type: 'starting', since: new Date().toISOString() };
  if (source !== 'watchdog') watchdog.manualStartRequested();
  fs.appendFileSync(SERVER_LOG_PATH, `\r\n--- ZedWatch start ${new Date().toISOString()} ---\r\n`, 'utf8');
  managedChild = spawn('cmd.exe', ['/d', '/s', '/c', GENERATED_LAUNCHER], {
    cwd: SERVER_DIR,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  managedPid = managedChild.pid;
  managedStartedAt = new Date().toISOString();
  const append = (chunk) => fs.appendFileSync(SERVER_LOG_PATH, redactText(chunk.toString()), 'utf8');
  managedChild.stdout.on('data', append);
  managedChild.stderr.on('data', append);
  managedChild.once('exit', (code, signal) => {
    fs.appendFileSync(SERVER_LOG_PATH, `\r\n--- Process exited code=${code} signal=${signal || ''} ---\r\n`, 'utf8');
    logEvent(code === 0 ? 'server' : 'crash', `Project Zomboid process exited with code ${code}.`, { signal });
    managedChild = null;
    managedPid = null;
    transition = null;
  });
  logEvent('server', source === 'watchdog' ? 'Crash recovery started Project Zomboid.' : 'Server start requested.', { pid: managedPid });
  try {
    await waitForRcon();
    transition = null;
    watchdog.noteStartSucceeded();
    return { pid: managedPid };
  } catch (error) {
    transition = null;
    if (source !== 'watchdog') watchdog.noteStartFailed(error);
    throw error;
  }
}

async function saveServer() {
  if (!(await isServerRunning())) throw new Error('The server is offline.');
  const response = await rcon().execute('save');
  logEvent('save', 'Manual world save completed.');
  return response;
}

async function stopServer({ force = false } = {}) {
  if (!(await isServerRunning())) {
    watchdog.intentionalStopRequested('server already offline');
    return { alreadyStopped: true };
  }
  transition = { type: force ? 'force-stopping' : 'stopping', since: new Date().toISOString() };
  watchdog.intentionalStopRequested(force ? 'force stop' : 'Save & Stop');
  if (force) {
    const pid = Number(managedPid || (await discoverServerProcess())?.pid);
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Could not identify the ZedWatch server process safely.');
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    logEvent('server', 'Server was force-stopped.', { pid });
  } else {
    await rcon().execute('save');
    await wait(1500);
    await rcon().execute('quit');
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && await isServerRunning()) await wait(1000);
    if (await isServerRunning()) {
      transition = null;
      throw new Error('The server did not exit after a safe save and quit. Use Force Stop only if it remains stuck.');
    }
    logEvent('server', 'World saved and server stopped safely.');
  }
  transition = null;
  watchdog.noteServerStopped();
  return { stopped: true };
}

function backupContext() {
  return {
    installRoot: ROOT,
    dataRoot: DATA_DIR,
    backupsRoot: BACKUPS_DIR,
    managerSettingsPath: MANAGER_SETTINGS_PATH,
    whitelistLedgerPath: WHITELIST_LEDGER_PATH,
  };
}

function createBackup(reason) {
  const result = createSnapshot({ ...backupContext(), reason });
  logEvent('backup', `Created portable snapshot: ${reason}.`, { name: result.name });
  return result;
}

async function currentPlayers() {
  if (!(await isServerRunning())) {
    lastKnownPlayers = [];
    return [];
  }
  try {
    const response = await rcon().execute('players');
    const candidates = response.split(/\r?\n/)
      .map((line) => line.replace(/^[\s*-]+/, '').trim())
      .filter((line) => line && !/^Players connected/i.test(line) && !/^\d+$/.test(line));
    lastKnownPlayers = candidates.slice(0, 100);
  } catch {}
  return lastKnownPlayers;
}

async function publicIp() {
  if (publicIpCache.expiresAt > Date.now()) return publicIpCache.value;
  try {
    const response = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) });
    const value = (await response.json()).ip;
    publicIpCache = { value, expiresAt: Date.now() + 15 * 60 * 1000 };
    return value;
  } catch {
    return null;
  }
}

function findManifest() {
  const candidates = [
    path.join(ROOT, '_steamcmd', 'steamapps', 'appmanifest_380870.acf'),
    path.join(SERVER_DIR, 'steamapps', 'appmanifest_380870.acf'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function buildId() {
  const manifest = findManifest();
  if (!manifest) return null;
  const match = fs.readFileSync(manifest, 'utf8').match(/"buildid"\s+"(\d+)"/i);
  return match ? match[1] : null;
}

function gameVersion() {
  return detectGameVersion([
    SERVER_LOG_PATH,
    path.join(LOGS_DIR, 'bootstrap.log'),
  ]);
}

async function statusPayload() {
  const processInfo = await discoverServerProcess();
  const values = configValues();
  const players = processInfo ? await currentPlayers() : [];
  const lanIp = await resolveLanIp();
  const externalIp = await publicIp();
  const portable = listSnapshots(BACKUPS_DIR);
  const builtIn = listBuiltInBackups(DATA_DIR);
  return {
    managerVersion: MANAGER_VERSION,
    running: Boolean(processInfo),
    pid: processInfo?.pid || null,
    memoryBytes: Number(processInfo?.memoryBytes || 0),
    startedAt: managedStartedAt,
    transition,
    updating: await isUpdateRunning(),
    serverName: values.PublicName || 'ZedWatch',
    description: values.PublicDescription || 'Private Project Zomboid survival server',
    gameVersion: gameVersion(),
    buildId: buildId(),
    ports: { primary: Number(values.DefaultPort || 16261), secondary: Number(values.UDPPort || 16262) },
    maxPlayers: Number(values.MaxPlayers || 8),
    players,
    accessMode: managerSettings.accessMode,
    publicListing: managerSettings.publicListing,
    startupEnabled: managerSettings.startupEnabled,
    watchdog: watchdog.getStatus(),
    lanAddress: `${lanIp}:${values.DefaultPort || 16261}`,
    publicAddress: externalIp ? `${externalIp}:${values.DefaultPort || 16261}` : null,
    backups: { portable: portable.length, builtIn: builtIn.length, latest: portable[0] || builtIn[0] || null },
    worldPreset: 'Outbreak',
    modsEnabled: splitList(values.Mods).length,
    welcomeMessage: values.ServerWelcomeMessage || '',
  };
}

async function runSteamUpdate() {
  if (await isServerRunning()) throw new Error('Stop the server before updating.');
  if (await isUpdateRunning()) throw new Error('An update is already running.');
  createBackup('Automatic pre-update safety snapshot');
  transition = { type: 'updating', since: new Date().toISOString() };
  watchdog.intentionalStopRequested('server update');
  fs.appendFileSync(UPDATE_LOG_PATH, `\r\n--- Update ${new Date().toISOString()} ---\r\n`, 'utf8');
  updateProcess = spawn(STEAMCMD_PATH, [
    '+force_install_dir', SERVER_DIR,
    '+login', 'anonymous',
    '+app_info_update', '1',
    '+app_update', '380870', 'validate',
    '+quit',
  ], { cwd: path.dirname(STEAMCMD_PATH), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  updateProcess.stdout.on('data', (chunk) => fs.appendFileSync(UPDATE_LOG_PATH, chunk));
  updateProcess.stderr.on('data', (chunk) => fs.appendFileSync(UPDATE_LOG_PATH, chunk));
  const code = await new Promise((resolve) => updateProcess.once('exit', resolve));
  updateProcess = null;
  transition = null;
  if (code !== 0) throw new Error(`SteamCMD exited with code ${code}.`);
  await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'scripts', 'New-ZedWatchLauncher.ps1'),
    '-InstallRoot', ROOT,
  ], { windowsHide: true, timeout: 60000 });
  logEvent('update', 'Project Zomboid Dedicated Server updated successfully.', { buildId: buildId() });
  return { buildId: buildId() };
}

function managerSettingsResponse() {
  return {
    accessMode: managerSettings.accessMode,
    publicListing: managerSettings.publicListing,
    startupEnabled: managerSettings.startupEnabled,
    watchdog: managerSettings.watchdog,
  };
}

function settingsPayload() {
  const ini = readIniFile(CONFIG_PATH);
  const sandboxText = fs.existsSync(SANDBOX_PATH) ? fs.readFileSync(SANDBOX_PATH, 'utf8') : '';
  const sandbox = parseLuaSettings(sandboxText);
  const enriched = enrichInstalledSettings(SERVER_DIR, ini.entries, sandbox.entries);
  return {
    ini: enriched.ini.map((entry) => ({ ...entry, value: entry.secret ? '' : entry.value })),
    sandbox: enriched.sandbox,
    presets: readSandboxPresets(SERVER_DIR),
    categories: [...new Set([...ini.entries, ...sandbox.entries].map((entry) => entry.category))],
    advancedFiles: [...ADVANCED_FILES].filter((name) => fs.existsSync(path.join(SERVER_CONFIG_DIR, name))),
  };
}

async function saveSettings(body) {
  if (await isServerRunning()) throw new Error('Stop the server before changing settings.');
  createBackup('Automatic pre-configuration snapshot');
  if (body.ini && typeof body.ini === 'object') {
    if (Object.hasOwn(body.ini, 'ServerWelcomeMessage')) body.ini.ServerWelcomeMessage = ensureWelcomeSignature(body.ini.ServerWelcomeMessage);
    const text = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, updateIni(text, body.ini), 'utf8');
  }
  if (body.sandbox && typeof body.sandbox === 'object') {
    const text = fs.readFileSync(SANDBOX_PATH, 'utf8');
    fs.writeFileSync(SANDBOX_PATH, updateLuaSettings(text, body.sandbox), 'utf8');
  }
  saveSecuritySettings();
  updatePrivateInfo();
  logEvent('settings', 'Server and sandbox settings saved.');
  return settingsPayload();
}

function workshopRoots() {
  return [
    path.join(ROOT, '_steamcmd', 'steamapps', 'workshop', 'content', '108600'),
    path.join(SERVER_DIR, 'steamapps', 'workshop', 'content', '108600'),
  ];
}

function modsPayload() {
  const values = configValues();
  const activeWorkshopItems = splitList(values.WorkshopItems);
  const activeModIds = splitList(values.Mods);
  return {
    activeWorkshopItems,
    activeModIds,
    packages: discoverMods({ workshopRoots: workshopRoots(), localModsRoot: LOCAL_MODS_DIR, activeWorkshopItems, activeModIds }),
  };
}

function updateModLists({ workshopItems, modIds }) {
  setIniValues(CONFIG_PATH, {
    WorkshopItems: joinList(workshopItems),
    Mods: joinList(modIds),
  });
}

async function setStartup(enabled) {
  const value = Boolean(enabled);
  await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'scripts', 'Register-ZedWatchStartup.ps1'),
    '-InstallRoot', ROOT,
    '-Enable', value ? '1' : '0',
  ], { windowsHide: true, timeout: 20000 });
  managerSettings.startupEnabled = value;
  persistSettings();
  logEvent('startup', `Windows startup ${value ? 'enabled' : 'disabled'}.`);
  return managerSettingsResponse();
}

watchdog = new CrashWatchdog({
  settings: managerSettings.watchdog,
  desiredRunning: managerSettings.desiredRunning,
  isRunning: isServerRunning,
  isUpdating: isUpdateRunning,
  restart: () => launchServer('watchdog'),
  log: logEvent,
  persistDesired: (desiredRunning) => {
    managerSettings.desiredRunning = desiredRunning;
    persistSettings();
  },
});

function sendJson(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

async function readBody(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const buffer = await readBody(request);
  if (!buffer.length) return {};
  try { return JSON.parse(buffer.toString('utf8')); } catch { throw new Error('Request body must be valid JSON.'); }
}

function requireMutationToken(request) {
  verifyMutationToken(request, SESSION_TOKEN, { port: PORT });
}

function serveStatic(request, response, pathname) {
  const mapping = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  };
  const item = mapping[pathname];
  if (!item) return false;
  const filePath = path.join(PUBLIC_DIR, item[0]);
  if (!fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end();
    return true;
  }
  const data = fs.readFileSync(filePath);
  response.writeHead(200, {
    'content-type': item[1],
    'content-length': data.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  response.end(data);
  return true;
}

async function handleApi(request, response, pathname, url) {
  const method = request.method || 'GET';
  if (method !== 'GET') requireMutationToken(request);

  if (method === 'GET' && pathname === '/api/session') return sendJson(response, 200, { token: SESSION_TOKEN });
  if (method === 'GET' && pathname === '/api/health') return sendJson(response, 200, { ok: true, version: MANAGER_VERSION, installRoot: ROOT });
  if (method === 'GET' && pathname === '/api/status') return sendJson(response, 200, await statusPayload());
  if (method === 'GET' && pathname === '/api/activity') return sendJson(response, 200, recentActivity(Number(url.searchParams.get('limit') || 120)));
  if (method === 'GET' && pathname === '/api/settings') return sendJson(response, 200, settingsPayload());
  if (method === 'GET' && pathname === '/api/manager-settings') return sendJson(response, 200, managerSettingsResponse());
  if (method === 'GET' && pathname === '/api/whitelist') {
    syncWhitelistAccounts();
    return sendJson(response, 200, { users: visibleWhitelistEntries() });
  }
  if (method === 'GET' && pathname === '/api/backups') return sendJson(response, 200, { portable: listSnapshots(BACKUPS_DIR), builtIn: listBuiltInBackups(DATA_DIR).map(({ path: ignored, ...item }) => item) });
  if (method === 'GET' && pathname === '/api/mods') return sendJson(response, 200, modsPayload());
  if (method === 'GET' && pathname === '/api/advanced') {
    const name = url.searchParams.get('name');
    if (!ADVANCED_FILES.has(name)) throw new Error('Advanced file is not allowed.');
    const filePath = path.join(SERVER_CONFIG_DIR, name);
    return sendJson(response, 200, { name, content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '' });
  }

  if (method === 'POST' && pathname === '/api/server/start') return sendJson(response, 200, await launchServer());
  if (method === 'POST' && pathname === '/api/server/stop') return sendJson(response, 200, await stopServer());
  if (method === 'POST' && pathname === '/api/server/force-stop') return sendJson(response, 200, await stopServer({ force: true }));
  if (method === 'POST' && pathname === '/api/server/restart') {
    await stopServer();
    return sendJson(response, 200, await launchServer());
  }
  if (method === 'POST' && pathname === '/api/server/save') return sendJson(response, 200, { response: await saveServer() });
  if (method === 'POST' && pathname === '/api/server/broadcast') {
    const body = await readJsonBody(request);
    const message = String(body.message || '').trim();
    if (!message || message.length > 300) throw new Error('Broadcast message must contain 1 to 300 characters.');
    const result = await rcon().execute(`servermsg ${quoteRcon(message)}`);
    logEvent('broadcast', 'Broadcast a message to connected players.');
    return sendJson(response, 200, { result });
  }
  if (method === 'POST' && pathname === '/api/update') return sendJson(response, 200, await runSteamUpdate());
  if (method === 'POST' && pathname === '/api/settings') return sendJson(response, 200, await saveSettings(await readJsonBody(request)));

  if (method === 'POST' && pathname === '/api/access') {
    if (await isServerRunning()) throw new Error('Stop the server before changing access mode.');
    const body = await readJsonBody(request);
    if (!['whitelist', 'password'].includes(body.mode)) throw new Error('Access mode must be whitelist or password.');
    createBackup(`Automatic snapshot before switching to ${body.mode} access`);
    managerSettings.accessMode = body.mode;
    persistSettings();
    saveSecuritySettings();
    updatePrivateInfo();
    logEvent('access', `Access mode changed to ${body.mode}.`);
    return sendJson(response, 200, managerSettingsResponse());
  }
  if (method === 'POST' && pathname === '/api/public-listing') {
    if (await isServerRunning()) throw new Error('Stop the server before changing public listing.');
    const body = await readJsonBody(request);
    managerSettings.publicListing = Boolean(body.enabled);
    persistSettings();
    saveSecuritySettings();
    updatePrivateInfo();
    logEvent('access', `Server-browser listing ${managerSettings.publicListing ? 'enabled' : 'disabled'}.`);
    return sendJson(response, 200, managerSettingsResponse());
  }
  if (method === 'POST' && pathname === '/api/access/rotate-shared') {
    if (await isServerRunning()) throw new Error('Stop the server before rotating the shared password.');
    secrets.sharedJoinPassword = securePassword();
    persistSecrets();
    saveSecuritySettings();
    updatePrivateInfo();
    logEvent('access', 'Shared join password rotated.');
    return sendJson(response, 200, { password: secrets.sharedJoinPassword });
  }
  if (method === 'POST' && pathname === '/api/access/shared-password') {
    if (await isServerRunning()) throw new Error('Stop the server before changing the shared password.');
    const body = await readJsonBody(request);
    secrets.sharedJoinPassword = validateSharedPassword(body.password);
    persistSecrets();
    saveSecuritySettings();
    updatePrivateInfo();
    logEvent('access', 'Shared join password updated manually.');
    return sendJson(response, 200, { password: secrets.sharedJoinPassword });
  }
  if (method === 'POST' && pathname === '/api/access/shared-password/reveal') {
    if (!secrets.sharedJoinPassword) throw new Error('No shared join password is stored.');
    return sendJson(response, 200, { password: secrets.sharedJoinPassword });
  }

  if (method === 'POST' && pathname === '/api/whitelist/add') {
    if (!(await isServerRunning())) throw new Error('Start the server before adding a whitelist account.');
    const body = await readJsonBody(request);
    const username = validateUsername(body.username);
    const password = String(body.password || securePassword());
    if (password.length < 10 || password.length > 128 || /[\r\n]/.test(password)) throw new Error('Player password must contain 10 to 128 characters.');
    const result = await rcon().execute(`adduser ${quoteRcon(username)} ${quoteRcon(password)}`);
    const existing = whitelistEntry(username, { includeRemoved: true });
    if (existing) {
      Object.assign(existing, {
        username,
        enabled: true,
        source: 'zedwatch',
        updatedAt: new Date().toISOString(),
      });
      delete existing.removed;
      delete existing.removedAt;
      delete existing.disabledBy;
    } else {
      whitelistLedger.push({
        username,
        enabled: true,
        source: 'zedwatch',
        createdAt: new Date().toISOString(),
      });
    }
    storePlayerPassword(username, password);
    persistWhitelist();
    persistSecrets();
    updatePrivateInfo();
    logEvent('access', `Added whitelist account ${username}.`);
    return sendJson(response, 200, { username, password, result });
  }
  if (method === 'POST' && pathname === '/api/whitelist/disable') {
    if (!(await isServerRunning())) throw new Error('Start the server before disabling a whitelist account.');
    const body = await readJsonBody(request);
    const username = validateUsername(body.username);
    const entry = whitelistEntry(username);
    if (!entry) throw new Error('Player account was not found.');
    const result = await rcon().execute(`banuser ${quoteRcon(username)} -r ${quoteRcon('Disabled by ZedWatch')}`);
    Object.assign(entry, { enabled: false, disabledBy: 'ban', updatedAt: new Date().toISOString() });
    persistWhitelist();
    updatePrivateInfo();
    logEvent('access', `Disabled player account ${username}.`);
    return sendJson(response, 200, { result });
  }
  if (method === 'POST' && pathname === '/api/whitelist/enable') {
    if (!(await isServerRunning())) throw new Error('Start the server before enabling a player account.');
    const body = await readJsonBody(request);
    const username = validateUsername(body.username);
    const entry = whitelistEntry(username);
    if (!entry) throw new Error('Player account was not found.');
    const result = await rcon().execute(`unbanuser ${quoteRcon(username)}`);
    if (entry.disabledBy !== 'ban') {
      const password = storedPlayerPassword(username);
      if (password) await rcon().execute(`adduser ${quoteRcon(username)} ${quoteRcon(password)}`);
    }
    Object.assign(entry, { enabled: true, updatedAt: new Date().toISOString() });
    delete entry.disabledBy;
    persistWhitelist();
    updatePrivateInfo();
    logEvent('access', `Enabled player account ${username}.`);
    return sendJson(response, 200, { result });
  }
  if (method === 'POST' && pathname === '/api/whitelist/remove') {
    if (!(await isServerRunning())) throw new Error('Start the server before removing a whitelist account.');
    const body = await readJsonBody(request);
    const username = validateUsername(body.username);
    const entry = whitelistEntry(username);
    if (entry?.disabledBy === 'ban') await rcon().execute(`unbanuser ${quoteRcon(username)}`);
    const result = await rcon().execute(`removeuserfromwhitelist ${quoteRcon(username)}`);
    const removedAt = new Date().toISOString();
    if (entry) {
      Object.assign(entry, { enabled: false, removed: true, removedAt, updatedAt: removedAt });
      delete entry.disabledBy;
    } else {
      whitelistLedger.push({ username, enabled: false, removed: true, removedAt, updatedAt: removedAt });
    }
    forgetPlayerPassword(username);
    persistWhitelist();
    persistSecrets();
    updatePrivateInfo();
    logEvent('access', `Removed whitelist account ${username}.`);
    return sendJson(response, 200, { result });
  }
  if (method === 'POST' && (pathname === '/api/whitelist/reset' || pathname === '/api/whitelist/rotate')) {
    if (!(await isServerRunning())) throw new Error('Start the server before resetting an account password.');
    const body = await readJsonBody(request);
    const username = validateUsername(body.username);
    const entry = whitelistEntry(username);
    if (!entry) throw new Error('Player account was not found.');
    const password = securePassword();
    const result = await rcon().execute(`setpassword ${quoteRcon(username)} ${quoteRcon(password)}`);
    storePlayerPassword(username, password);
    Object.assign(entry, { updatedAt: new Date().toISOString() });
    persistSecrets();
    persistWhitelist();
    updatePrivateInfo();
    logEvent('access', `Reset the password for ${username}.`);
    return sendJson(response, 200, { username, password, result });
  }

  if (method === 'POST' && pathname === '/api/backup') {
    if (await isServerRunning()) throw new Error('Stop the server before creating a portable snapshot.');
    const body = await readJsonBody(request);
    return sendJson(response, 200, createBackup(String(body.reason || 'Manual snapshot').slice(0, 160)));
  }
  if (method === 'POST' && pathname === '/api/restore') {
    if (await isServerRunning()) throw new Error('Stop the server before restoring a snapshot.');
    const body = await readJsonBody(request);
    createBackup('Automatic safety snapshot before restore');
    const result = restoreSnapshot({ ...backupContext(), name: body.name });
    logEvent('restore', `Restored portable snapshot ${body.name}.`);
    return sendJson(response, 200, result);
  }
  if (method === 'POST' && pathname === '/api/restore-built-in') {
    if (await isServerRunning()) throw new Error('Stop the server before restoring a built-in backup.');
    const body = await readJsonBody(request);
    const item = listBuiltInBackups(DATA_DIR).find((entry) => entry.name === safeName(body.name));
    if (!item) throw new Error('Built-in backup was not found.');
    createBackup('Automatic safety snapshot before built-in restore');
    const result = await restoreBuiltInBackup({ installRoot: ROOT, dataRoot: DATA_DIR, backupPath: item.path });
    logEvent('restore', `Restored built-in backup ${body.name}.`);
    return sendJson(response, 200, result);
  }

  if (method === 'POST' && pathname === '/api/mods/workshop') {
    if (await isServerRunning()) throw new Error('Stop the server before adding a Workshop item.');
    const body = await readJsonBody(request);
    const id = parseWorkshopId(body.value);
    const detail = await lookupWorkshopItem(id);
    createBackup('Automatic pre-mod snapshot');
    const values = configValues();
    updateModLists({ workshopItems: [...splitList(values.WorkshopItems), id], modIds: splitList(values.Mods) });
    logEvent('mod', `Added Workshop item ${id}: ${detail.title}.`);
    return sendJson(response, 200, { detail, mods: modsPayload() });
  }
  if (method === 'POST' && pathname === '/api/mods/upload') {
    if (await isServerRunning()) throw new Error('Stop the server before importing a mod.');
    const filename = String(request.headers['x-filename'] || 'mod.zip').replace(/[^A-Za-z0-9._-]/g, '_');
    if (path.extname(filename).toLowerCase() !== '.zip') throw new Error('Only ZIP mod packages are accepted.');
    const upload = path.join(MOD_STAGING_DIR, `${Date.now()}-${filename}`);
    fs.writeFileSync(upload, await readBody(request, 512 * 1024 * 1024));
    createBackup('Automatic pre-mod snapshot');
    const installed = await importZip({ installRoot: ROOT, zipPath: upload, localModsRoot: LOCAL_MODS_DIR, stagingRoot: MOD_STAGING_DIR });
    logEvent('mod', `Imported ${installed.length} local mod package(s).`);
    return sendJson(response, 200, { installed, mods: modsPayload() });
  }
  if (method === 'POST' && pathname === '/api/mods/toggle') {
    if (await isServerRunning()) throw new Error('Stop the server before changing mods.');
    const body = await readJsonBody(request);
    const modId = String(body.modId || '');
    if (!modsPayload().packages.some((entry) => entry.id === modId)) throw new Error('Mod package was not found.');
    const values = configValues();
    const modIds = splitList(values.Mods);
    const next = body.enabled ? [...modIds, modId] : modIds.filter((id) => id !== modId);
    createBackup('Automatic pre-mod snapshot');
    updateModLists({ workshopItems: splitList(values.WorkshopItems), modIds: next });
    logEvent('mod', `${body.enabled ? 'Enabled' : 'Disabled'} mod ${modId}.`);
    return sendJson(response, 200, modsPayload());
  }
  if (method === 'POST' && pathname === '/api/mods/remove') {
    if (await isServerRunning()) throw new Error('Stop the server before removing a mod.');
    const body = await readJsonBody(request);
    const values = configValues();
    const packages = modsPayload().packages;
    const item = packages.find((entry) => entry.id === body.modId && String(entry.workshopId || '') === String(body.workshopId || ''));
    if (!item) throw new Error('Mod package was not found.');
    createBackup('Automatic pre-mod-removal snapshot');
    let workshopItems = splitList(values.WorkshopItems);
    let modIds = splitList(values.Mods).filter((id) => id !== item.id);
    if (item.workshopId) workshopItems = workshopItems.filter((id) => id !== item.workshopId);
    if (item.source === 'local') removeLocalMod({ localModsRoot: LOCAL_MODS_DIR, modId: item.id });
    updateModLists({ workshopItems, modIds });
    logEvent('mod', `Removed mod ${item.name}.`);
    return sendJson(response, 200, modsPayload());
  }

  if (method === 'POST' && pathname === '/api/advanced') {
    if (await isServerRunning()) throw new Error('Stop the server before replacing advanced configuration.');
    const body = await readJsonBody(request);
    if (!ADVANCED_FILES.has(body.name)) throw new Error('Advanced file is not allowed.');
    if (typeof body.content !== 'string' || body.content.length > 2 * 1024 * 1024) throw new Error('Advanced file content is invalid or too large.');
    createBackup('Automatic pre-advanced-configuration snapshot');
    fs.writeFileSync(path.join(SERVER_CONFIG_DIR, body.name), body.content, 'utf8');
    logEvent('settings', `Saved advanced configuration file ${body.name}.`);
    return sendJson(response, 200, { saved: true });
  }
  if (method === 'POST' && pathname === '/api/startup') {
    const body = await readJsonBody(request);
    return sendJson(response, 200, await setStartup(body.enabled));
  }
  if (method === 'POST' && pathname === '/api/watchdog') {
    const body = await readJsonBody(request);
    managerSettings.watchdog = normalizeWatchdogSettings({ ...managerSettings.watchdog, ...body });
    persistSettings();
    watchdog.updateSettings(managerSettings.watchdog);
    logEvent('settings', 'Crash recovery settings saved.', managerSettings.watchdog);
    return sendJson(response, 200, managerSettingsResponse());
  }
  if (method === 'POST' && pathname === '/api/open-folder') {
    const body = await readJsonBody(request);
    const choices = {
      root: ROOT, server: SERVER_DIR, data: DATA_DIR, saves: path.join(DATA_DIR, 'Saves'),
      config: SERVER_CONFIG_DIR, backups: BACKUPS_DIR, mods: LOCAL_MODS_DIR, logs: LOGS_DIR,
    };
    const target = choices[body.target];
    if (!target) throw new Error('Folder target is invalid.');
    fs.mkdirSync(target, { recursive: true });
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return sendJson(response, 200, { opened: true });
  }
  if (method === 'POST' && pathname === '/api/launch-game') {
    spawn('cmd.exe', ['/c', 'start', '', 'steam://run/108600'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return sendJson(response, 200, { launched: true });
  }
  if (method === 'POST' && pathname === '/api/close') {
    if (await isServerRunning()) throw new Error('Stop the Project Zomboid server before closing ZedWatch.');
    sendJson(response, 200, { closing: true });
    setTimeout(() => {
      watchdog.stop();
      server.close(() => process.exit(0));
    }, 100).unref();
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url.pathname, url);
    if (request.method === 'GET' && serveStatic(request, response, url.pathname)) return;
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  } catch (error) {
    logEvent('error', error.message, { stack: error.stack });
    sendJson(response, /token|origin/i.test(error.message) ? 403 : 400, { error: redactText(error.message) });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(`ZedWatch is already running at http://${HOST}:${PORT}/\n`);
    process.exit(2);
  }
  throw error;
});

server.listen(PORT, HOST, async () => {
  logEvent('manager', `ZedWatch Server Studio ${MANAGER_VERSION} started.`, { host: HOST, port: PORT });
  await watchdog.start({ adoptRunning: true });
  process.stdout.write(`ZedWatch ready at http://${HOST}:${PORT}/\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    watchdog.stop();
    server.close(() => process.exit(0));
  });
}

module.exports = {
  configValues,
  createBackup,
  launchServer,
  saveSecuritySettings,
  securePassword,
  statusPayload,
  stopServer,
};
