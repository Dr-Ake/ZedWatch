'use strict';

const fs = require('fs');
const path = require('path');

const LOCKED_KEYS = new Set(['Password', 'RCONPassword', 'Open', 'Public', 'AutoCreateUserInWhiteList']);
const SANDBOX_PRESETS = Object.freeze([
  { id: 'outbreak', file: 'Outbreak.lua', translation: 'Outbreak', label: 'Outbreak', description: 'Faster progression and more loot without reducing zombie lethality.' },
  { id: 'apocalypse', file: 'Apocalypse.lua', translation: 'Apocalypse', label: 'Apocalypse', description: 'The careful, canon Project Zomboid survival experience.' },
  { id: 'rising', file: 'Rising.lua', translation: 'Rising', label: 'Rising', description: 'A cozier homestead-focused world with less stress and tamer zombies.' },
  { id: 'extinction', file: 'Extinction.lua', translation: 'Extinction', label: 'Extinction', description: 'A brutal world with scarce supplies and more dangerous zombies.' },
  { id: 'six-months-later', file: 'SixMonthsLater.lua', translation: 'SixMonths', label: 'Six Months Later', description: 'A late start with large hordes, ransacked homes, overgrowth, and no utilities.' },
]);

const CURATED_DESCRIPTIONS = Object.freeze({
  PublicName: 'The display name players see in favorites and, when enabled, the public server browser.',
  PublicDescription: 'A short description shown with the server listing.',
  MaxPlayers: 'Maximum simultaneous players. ZedWatch starts at eight for a private home server.',
  PauseEmpty: 'Freezes the simulation when nobody is connected, reducing CPU use and unattended world changes.',
  DefaultPort: 'Primary Project Zomboid game and Steam-facing UDP port.',
  UDPPort: 'Secondary RakNet UDP port. Forward it together with the primary game port.',
  RCONPort: 'Local remote-console port used by ZedWatch. Windows Firewall does not expose it.',
  PVP: 'Allows players to damage each other when the game rules also permit it.',
  SafetySystem: 'Enables the opt-in safety system used to reduce accidental player-versus-player damage.',
  ShowSafety: 'Shows the current safety state in the game interface.',
  SpawnPoint: 'Forces a shared spawn coordinate. The default 0,0,0 lets players choose an allowed spawn region.',
  Map: 'Semicolon-separated map folders loaded by the server.',
  WorkshopItems: 'Steam Workshop item IDs downloaded by the dedicated server.',
  Mods: 'Internal mod IDs enabled when the server starts.',
  ServerWelcomeMessage: 'Message displayed after a player joins. ZedWatch keeps its hosting signature attached.',
  BackupsCount: 'Number of built-in Zomboid backup archives to retain.',
  BackupsOnStart: 'Creates a built-in backup when the server starts.',
  BackupsOnVersionChange: 'Creates a built-in backup before loading the world with a new game build.',
  BackupsPeriod: 'Minutes between built-in backups while running. Zero disables timed built-in backups.',
  SaveWorldEveryMinutes: 'Minutes between world saves.',
  PingLimit: 'Players above this latency in milliseconds may be removed.',
  SteamScoreboard: 'Controls how much identity information is shown through the Steam scoreboard.',
  VoiceEnable: 'Allows in-game voice communication.',
  VoiceMinDistance: 'Distance where proximity voice begins to fade.',
  VoiceMaxDistance: 'Maximum distance for proximity voice.',
  DisplayUserName: 'Shows account usernames above players.',
  ShowFirstAndLastName: 'Shows character names instead of account usernames.',
  ChatStreams: 'Comma-separated chat channels enabled on the server, including local, radio, admin, whisper, yell, safehouse, faction, and global chat.',
  UsernameDisguises: 'Enables the multiplayer disguise system that allows a character to conceal their normal account identity.',
  HideDisguisedUserName: 'Hides the account username above a player while that player is using the disguise system.',
  SwitchZombiesOwnershipEachUpdate: 'Reassigns which connected client synchronizes zombies on every network update. This is an advanced networking option best left off unless troubleshooting zombie synchronization.',
  DenyLoginOnOverloadedServer: 'Rejects new login attempts while the server is overloaded, protecting connected players from additional load.',
  SafehouseDisableDisguises: 'Prevents the disguise system from concealing player identity during safehouse interactions.',
  War: 'Enables the multiplayer safehouse-war system. The related delay, duration, and safehouse hit-point settings control each war.',
  SneakModeHideFromOtherPlayers: 'Allows sneaking characters to become hidden from other players according to the multiplayer visibility rules.',
  UltraSpeedDoesnotAffectToAnimals: 'Keeps animals at normal simulation speed while the world is using ultra-fast time.',
  LoginQueueEnabled: 'Places incoming connections in a login queue when necessary instead of allowing every login to enter at once.',
  BanKickGlobalSound: 'Plays the server-wide notification sound when a player is banned or kicked.',
  UsePhysicsHitReaction: 'Enables physics-based reactions when characters are hit. Project Zomboid may disable unsupported physics behavior in multiplayer.',
  SafetyDisconnectDelay: 'Seconds the PvP safety system waits after a player disconnects before completing its disconnect handling.',
  MaxSafezoneSize: 'Maximum size permitted for a protected safe zone. Higher values allow larger protected areas.',
  SpeedLimit: 'Maximum vehicle speed, in kilometres per hour, enforced by the multiplayer server.',
  LoginQueueConnectTimeout: 'Seconds a queued connection may take to complete login before the server times it out.',
  ChatMessageCharacterLimit: 'Maximum number of characters allowed in a single chat message.',
  ChatMessageSlowModeTime: 'Minimum number of seconds a player must wait between chat messages when slow mode applies.',
  InsaneLootFactor: 'Spawn multiplier used when a loot category is set to Insanely Rare.',
  ExtremeLootFactor: 'Spawn multiplier used when a loot category is set to Extremely Rare.',
  RareLootFactor: 'Spawn multiplier used when a loot category is set to Rare.',
  NormalLootFactor: 'Spawn multiplier used when a loot category is set to Normal.',
  CommonLootFactor: 'Spawn multiplier used when a loot category is set to Common.',
  AbundantLootFactor: 'Spawn multiplier used when a loot category is set to Abundant.',
  GeneratorTileRange: 'Maximum tile range over which a generator can provide electrical power.',
  DoorOpeningPercentage: 'Percentage of zombies using randomized cognition that are able to open doors.',
  VERSION: 'Sandbox file-format version used by Project Zomboid. Keep the installed build value unless a documented migration requires a change.',
  StartYear: 'Selects the calendar year in which the world begins.',
  AllowDestructionBySledgehammer: 'Allows players to destroy world objects using sledgehammers.',
  SleepAllowed: 'Allows players to sleep in multiplayer.',
  SleepNeeded: 'Makes tiredness and sleep mandatory.',
  DoLuaChecksum: 'Rejects clients whose protected Lua files do not match the server.',
});

function inferType(value) {
  const text = String(value ?? '').trim();
  if (/^(true|false)$/i.test(text)) return 'boolean';
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return 'number';
  return text.length > 110 ? 'textarea' : 'text';
}

function categoryFor(key) {
  const name = String(key || '');
  if (/Workshop|Mods|Lua|Checksum/i.test(name)) return 'Mods & compatibility';
  if (/Zombie/i.test(name)) return 'Sandbox gameplay';
  if (/Player|PVP|Safety|Sleep|Faction|Safehouse|Safezone/i.test(name)) return 'Players & co-op';
  if (/Loot|Hours|Day|Night|Nature|Farming|Animal/i.test(name)) return 'Sandbox gameplay';
  if (/Backup|Save|Reset|World|Map|Spawn/i.test(name)) return 'World & protection';
  if (/AntiCheat|Kick|Ban|Physics|Protection|^SpeedLimit$/i.test(name)) return 'Security';
  if (/Password|^Open$|Whitelist|User|Access|Login|Account/i.test(name)) return 'Identity & access';
  if (/^Public(?:Name|Description)?$/i.test(name)) return 'Network & visibility';
  if (/Voice|Chat|Welcome|Discord|Display|Name/i.test(name)) return 'Communication';
  if (/Port|UPnP|Ping|Steam|Public|IPAddress|ServerIP|BindIP|Relay/i.test(name)) return 'Network & visibility';
  return 'Advanced server';
}

function validateSharedPassword(value) {
  const password = String(value ?? '');
  if (password.length < 4 || password.length > 64) throw new Error('Shared password must contain 4 to 64 characters.');
  if (password !== password.trim()) throw new Error('Shared password cannot begin or end with a space.');
  if (/[\u0000-\u001f\u007f]/.test(password)) throw new Error('Shared password cannot contain control characters.');
  return password;
}

function cleanPresetDescription(value, fallback) {
  const text = cleanOptionText(value);
  return text || fallback;
}

function cleanOptionText(value) {
  return String(value || '')
    .replace(/\\n|\r?\n|<LINE>|<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function humanizeSettingKey(key) {
  const name = String(key || '').split('.').pop();
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\bPvp\b/gi, 'PvP')
    .replace(/\bRcon\b/gi, 'RCON')
    .replace(/\bUpnP\b/gi, 'UPnP')
    .replace(/\bVoip\b/gi, 'VOIP')
    .replace(/\bVac\b/gi, 'VAC')
    .replace(/\bLua\b/gi, 'Lua')
    .trim();
}

function readTranslationFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

function sandboxTranslationBases(entry) {
  const shortKey = entry.shortKey || String(entry.key).split('.').pop();
  const prefix = String(entry.key).includes('.') ? String(entry.key).split('.')[0] : '';
  const candidates = [];
  if (prefix === 'ZombieLore') candidates.push(`Sandbox_Z${shortKey}`);
  if (entry.key === 'Zombies') candidates.push('Sandbox_ZombieCount');
  if (entry.key === 'Distribution') candidates.push('Sandbox_ZombieDistribution');
  candidates.push(`Sandbox_${shortKey}`);
  if (prefix) candidates.push(`Sandbox_${prefix}${shortKey}`);
  return [...new Set(candidates)];
}

function enrichInstalledSettings(serverDirectory, iniEntries, sandboxEntries) {
  const translationDirectory = path.join(path.resolve(serverDirectory), 'media', 'lua', 'shared', 'Translate', 'EN');
  const ui = readTranslationFile(path.join(translationDirectory, 'UI.json'));
  const sandbox = readTranslationFile(path.join(translationDirectory, 'Sandbox.json'));
  const isGeneric = (value) => /^Installed (?:Project Zomboid|sandbox) setting:/i.test(String(value || ''));
  const safeFallback = (label) => `Advanced Project Zomboid option: ${label}. The installed build does not provide additional help, so keep its installed value unless documented otherwise.`;

  return {
    ini: iniEntries.map((entry) => {
      const base = `UI_ServerOption_${entry.key}`;
      const translatedDescription = cleanOptionText(ui[`${base}_tooltip`]);
      const label = cleanOptionText(ui[base]) || humanizeSettingKey(entry.key);
      return {
        ...entry,
        label,
        description: isGeneric(entry.description) ? (translatedDescription || safeFallback(label)) : entry.description,
      };
    }),
    sandbox: sandboxEntries.map((entry) => {
      const bases = sandboxTranslationBases(entry);
      const base = bases.find((candidate) => sandbox[candidate] || sandbox[`${candidate}_tooltip`] || sandbox[`${candidate}_help`]);
      const label = cleanOptionText(base && sandbox[base]) || humanizeSettingKey(entry.shortKey || entry.key);
      const translatedDescription = cleanOptionText(base && (sandbox[`${base}_help`] || sandbox[`${base}_tooltip`]));
      return {
        ...entry,
        label,
        description: isGeneric(entry.description) ? (translatedDescription || safeFallback(label)) : entry.description,
      };
    }),
  };
}

function presetEntryValue(entry) {
  const value = String(entry.value ?? '').trim();
  if (entry.type === 'string' && /^".*"$/.test(value)) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  return value;
}

function readSandboxPresets(serverDirectory) {
  const serverRoot = path.resolve(serverDirectory);
  const presetDirectory = path.join(serverRoot, 'media', 'lua', 'shared', 'Sandbox');
  const translationPath = path.join(serverRoot, 'media', 'lua', 'shared', 'Translate', 'EN', 'UI.json');
  const translations = readTranslationFile(translationPath);

  return SANDBOX_PRESETS.flatMap((definition) => {
    const filePath = path.join(presetDirectory, definition.file);
    if (!fs.existsSync(filePath)) return [];
    const parsed = parseLuaSettings(fs.readFileSync(filePath, 'utf8'));
    const values = Object.fromEntries(parsed.entries.map((entry) => [entry.key, presetEntryValue(entry)]));
    if (!Object.keys(values).length) return [];
    const translationKey = `UI_NewGame_${definition.translation}`;
    return [{
      id: definition.id,
      label: String(translations[translationKey] || definition.label),
      description: cleanPresetDescription(translations[`${translationKey}_desc`], definition.description),
      values,
    }];
  });
}

function parseCommentMetadata(comments) {
  const joined = comments.join(' ').trim();
  const minimum = joined.match(/\b(?:Minimum\s*=|Min\s*:)\s*(-?\d+(?:\.\d+)?)/i);
  const maximum = joined.match(/\b(?:Maximum\s*=|Max\s*:)\s*(-?\d+(?:\.\d+)?)/i);
  const defaultValue = joined.match(/\b(?:Default\s*=|Default\s*:)\s*([^\s#]+)/i);
  return {
    description: joined.replace(/\s*\b(?:Minimum\s*=|Min\s*:).*$/i, '').trim(),
    minimum: minimum ? Number(minimum[1]) : undefined,
    maximum: maximum ? Number(maximum[1]) : undefined,
    defaultValue: defaultValue ? defaultValue[1] : undefined,
  };
}

function parseIni(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  let pendingComments = [];
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
      pendingComments.push(trimmed.replace(/^[#;]\s?/, ''));
      return;
    }
    const match = line.match(/^([^#;=\s][^=]*)=(.*)$/);
    if (!match) {
      if (trimmed) pendingComments = [];
      return;
    }
    const key = match[1].trim();
    const value = match[2];
    const metadata = parseCommentMetadata(pendingComments);
    entries.push({
      key, value, lineIndex,
      type: inferType(value),
      category: categoryFor(key),
      description: metadata.description || CURATED_DESCRIPTIONS[key] || `Installed Project Zomboid setting: ${key}.`,
      minimum: metadata.minimum,
      maximum: metadata.maximum,
      defaultValue: metadata.defaultValue,
      locked: LOCKED_KEYS.has(key),
      secret: /password|token/i.test(key),
    });
    pendingComments = [];
  });
  return { lines, entries };
}

function validateValue(entry, value) {
  const text = String(value ?? '');
  if (entry.type === 'boolean' && !/^(true|false)$/i.test(text)) throw new Error(`${entry.key} must be true or false.`);
  if (entry.type === 'number') {
    const number = Number(text);
    if (!Number.isFinite(number)) throw new Error(`${entry.key} must be a number.`);
    if (entry.minimum !== undefined && number < entry.minimum) throw new Error(`${entry.key} must be at least ${entry.minimum}.`);
    if (entry.maximum !== undefined && number > entry.maximum) throw new Error(`${entry.key} must be at most ${entry.maximum}.`);
  }
  if (/Port$/.test(entry.key)) {
    const port = Number(text);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${entry.key} must be a valid port.`);
  }
  if (/[\r\n]/.test(text)) throw new Error(`${entry.key} cannot contain a line break.`);
  return text;
}

function updateIni(text, updates, { allowLocked = false } = {}) {
  const parsed = parseIni(text);
  const byKey = new Map(parsed.entries.map((entry) => [entry.key, entry]));
  for (const [key, rawValue] of Object.entries(updates || {})) {
    const entry = byKey.get(key);
    if (!entry) throw new Error(`Unknown installed setting: ${key}`);
    if (entry.locked && !allowLocked) throw new Error(`${key} is controlled by ZedWatch's access and security tools.`);
    parsed.lines[entry.lineIndex] = `${key}=${validateValue(entry, rawValue)}`;
  }
  return `${parsed.lines.join('\r\n').replace(/\s+$/, '')}\r\n`;
}

function readIniFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Server configuration was not found: ${filePath}`);
  const text = fs.readFileSync(filePath, 'utf8');
  return { text, ...parseIni(text) };
}

function setIniValues(filePath, updates, options) {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  let output = text;
  const parsed = parseIni(text);
  const existing = new Set(parsed.entries.map((entry) => entry.key));
  const knownUpdates = {};
  const additions = [];
  for (const [key, value] of Object.entries(updates || {})) {
    if (existing.has(key)) knownUpdates[key] = value;
    else {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error(`Unsafe INI key: ${key}`);
      if (/[\r\n]/.test(String(value))) throw new Error(`${key} cannot contain a line break.`);
      additions.push(`${key}=${value}`);
    }
  }
  if (Object.keys(knownUpdates).length) output = updateIni(output, knownUpdates, { allowLocked: true, ...options });
  if (additions.length) output = `${output.replace(/\s+$/, '')}\r\n${additions.join('\r\n')}\r\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, output, 'utf8');
  return output;
}

function parseLuaSettings(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  const stack = [];
  let pendingComments = [];
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) {
      pendingComments.push(trimmed.replace(/^--\s?/, ''));
      return;
    }
    if (/^}\s*,?\s*$/.test(trimmed)) {
      stack.pop();
      pendingComments = [];
      return;
    }
    const tableMatch = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*{\s*$/);
    if (tableMatch) {
      if (tableMatch[1] !== 'SandboxVars') stack.push(tableMatch[1]);
      pendingComments = [];
      return;
    }
    const valueMatch = line.match(/^(\s*)([A-Za-z_][\w]*)\s*=\s*(.+?)(,?)\s*$/);
    if (!valueMatch) {
      if (trimmed) pendingComments = [];
      return;
    }
    const key = [...stack, valueMatch[2]].join('.');
    const value = valueMatch[3].trim();
    const metadata = parseCommentMetadata(pendingComments);
    entries.push({
      key, shortKey: valueMatch[2], value, lineIndex,
      indentation: valueMatch[1], comma: valueMatch[4] || ',',
      type: inferType(value.replace(/^"(.*)"$/, '$1')),
      category: categoryFor(key),
      description: metadata.description || CURATED_DESCRIPTIONS[valueMatch[2]] || `Installed sandbox setting: ${key}.`,
      minimum: metadata.minimum, maximum: metadata.maximum,
      locked: false, secret: false,
    });
    pendingComments = [];
  });
  return { lines, entries };
}

function formatLuaValue(entry, rawValue) {
  const current = entry.value;
  if (/^(true|false)$/i.test(current)) {
    if (!/^(true|false)$/i.test(String(rawValue))) throw new Error(`${entry.key} must be true or false.`);
    return String(rawValue).toLowerCase();
  }
  if (/^-?\d+(?:\.\d+)?$/.test(current)) {
    const number = Number(rawValue);
    if (!Number.isFinite(number)) throw new Error(`${entry.key} must be a number.`);
    if (entry.minimum !== undefined && number < entry.minimum) throw new Error(`${entry.key} must be at least ${entry.minimum}.`);
    if (entry.maximum !== undefined && number > entry.maximum) throw new Error(`${entry.key} must be at most ${entry.maximum}.`);
    return String(number);
  }
  if (/^".*"$/.test(current)) return `"${String(rawValue).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"`;
  if (/[\r\n]/.test(String(rawValue))) throw new Error(`${entry.key} cannot contain a line break.`);
  return String(rawValue);
}

function updateLuaSettings(text, updates) {
  const parsed = parseLuaSettings(text);
  const byKey = new Map(parsed.entries.map((entry) => [entry.key, entry]));
  for (const [key, rawValue] of Object.entries(updates || {})) {
    const entry = byKey.get(key);
    if (!entry) throw new Error(`Unknown installed sandbox setting: ${key}`);
    parsed.lines[entry.lineIndex] = `${entry.indentation}${entry.shortKey} = ${formatLuaValue(entry, rawValue)}${entry.comma}`;
  }
  return `${parsed.lines.join('\r\n').replace(/\s+$/, '')}\r\n`;
}

function ensureWelcomeSignature(message) {
  const cleaned = String(message || '').replace(/\s*(?:<LINE>\s*)?Hosted by ZedWatch\s*$/i, '').trim();
  return `${cleaned || 'Welcome to the Knox Event Exclusion Zone.'}<LINE>Hosted by ZedWatch`;
}

function accessModeValues({ mode, publicListing = false, sharedPassword = '' }) {
  if (!['whitelist', 'password'].includes(mode)) throw new Error('Access mode must be whitelist or password.');
  const whitelist = mode === 'whitelist';
  if (!whitelist && !String(sharedPassword)) throw new Error('Password mode requires a shared join password.');
  return {
    Public: publicListing ? 'true' : 'false',
    Open: whitelist ? 'false' : 'true',
    AutoCreateUserInWhiteList: whitelist ? 'false' : 'true',
    Password: whitelist ? '' : String(sharedPassword),
  };
}

module.exports = {
  CURATED_DESCRIPTIONS, LOCKED_KEYS, accessModeValues, categoryFor, enrichInstalledSettings, ensureWelcomeSignature, humanizeSettingKey, inferType,
  parseIni, parseLuaSettings, readIniFile, readSandboxPresets, setIniValues, updateIni, updateLuaSettings, validateSharedPassword, validateValue,
};
