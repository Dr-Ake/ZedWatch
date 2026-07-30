'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  accessModeValues, categoryFor, enrichInstalledSettings, ensureWelcomeSignature, humanizeSettingKey, parseIni, parseLuaSettings, readSandboxPresets, updateIni, updateLuaSettings,
  validateSharedPassword,
} = require('../lib/config');

const iniFixture = [
  '# Public server name',
  'PublicName=ZedWatch',
  '# Minimum=1 Maximum=100 Default=32',
  'MaxPlayers=8',
  'Open=false',
  'Public=false',
  'AutoCreateUserInWhiteList=false',
  'Password=private',
  'UnknownBuild42Setting=preserve-me',
  '',
].join('\r\n');

const luaFixture = [
  'SandboxVars = {',
  '    Zombies = 4,',
  '    ZombieLore = {',
  '        Speed = 2,',
  '        Cognition = 3,',
  '    },',
  '    AllowExteriorGenerator = true,',
  '    Welcome = "Knox",',
  '    FutureBuild42Option = 71,',
  '}',
  '',
].join('\r\n');

test('INI parsing exposes metadata and preserves unknown settings during round trip', () => {
  const parsed = parseIni(iniFixture);
  const maxPlayers = parsed.entries.find((entry) => entry.key === 'MaxPlayers');
  assert.equal(maxPlayers.type, 'number');
  assert.equal(maxPlayers.minimum, 1);
  assert.equal(maxPlayers.maximum, 100);
  const updated = updateIni(iniFixture, { PublicName: 'ZedWatch Night Shift', MaxPlayers: 12 });
  assert.match(updated, /PublicName=ZedWatch Night Shift/);
  assert.match(updated, /MaxPlayers=12/);
  assert.match(updated, /UnknownBuild42Setting=preserve-me/);
  assert.throws(() => updateIni(iniFixture, { MaxPlayers: 101 }), /at most 100/);
  assert.throws(() => updateIni(iniFixture, { Open: true }), /controlled by ZedWatch/);
  const colonRange = parseIni('# Movement limit. Min: 10.00 Max: 150.00 Default: 70.00\nSpeedLimit=70.0').entries[0];
  assert.equal(colonRange.description, 'Movement limit.');
  assert.equal(colonRange.minimum, 10);
  assert.equal(colonRange.maximum, 150);
});

test('Lua parser updates nested settings without losing future Build 42 options', () => {
  const parsed = parseLuaSettings(luaFixture);
  assert.ok(parsed.entries.some((entry) => entry.key === 'ZombieLore.Speed'));
  const updated = updateLuaSettings(luaFixture, {
    'ZombieLore.Speed': 1,
    AllowExteriorGenerator: false,
    Welcome: 'Safe "house"',
  });
  assert.match(updated, /Speed = 1,/);
  assert.match(updated, /AllowExteriorGenerator = false,/);
  assert.match(updated, /Welcome = "Safe \\"house\\"",/);
  assert.match(updated, /FutureBuild42Option = 71,/);
});

test('access conversions keep visibility independent from authentication', () => {
  assert.deepEqual(accessModeValues({ mode: 'whitelist', publicListing: true, sharedPassword: 'stored-code' }), {
    Public: 'true', Open: 'false', AutoCreateUserInWhiteList: 'false', Password: '',
  });
  assert.deepEqual(accessModeValues({ mode: 'password', publicListing: false, sharedPassword: 'stored-code' }), {
    Public: 'false', Open: 'true', AutoCreateUserInWhiteList: 'true', Password: 'stored-code',
  });
  assert.throws(() => accessModeValues({ mode: 'password' }), /requires a shared join password/);
});

test('welcome message always carries one fixed hosting signature', () => {
  assert.equal(ensureWelcomeSignature('Welcome, survivors!'), 'Welcome, survivors!<LINE>Hosted by ZedWatch');
  assert.equal(ensureWelcomeSignature('Welcome<LINE>Hosted by ZedWatch'), 'Welcome<LINE>Hosted by ZedWatch');
  assert.equal(ensureWelcomeSignature(''), 'Welcome to the Knox Event Exclusion Zone.<LINE>Hosted by ZedWatch');
});

test('setting categories do not confuse gameplay words with network or identity controls', () => {
  assert.equal(categoryFor('ZombieConfig.PopulationMultiplier'), 'Sandbox gameplay');
  assert.equal(categoryFor('ZombieLore.DoorOpeningPercentage'), 'Sandbox gameplay');
  assert.equal(categoryFor('SleepAllowed'), 'Players & co-op');
  assert.equal(categoryFor('SafehousePreventsLootRespawn'), 'Players & co-op');
  assert.equal(categoryFor('DefaultPort'), 'Network & visibility');
  assert.equal(categoryFor('PublicName'), 'Network & visibility');
  assert.equal(categoryFor('PublicDescription'), 'Network & visibility');
  assert.equal(categoryFor('Open'), 'Identity & access');
});

test('custom shared passwords accept visible values without unsafe whitespace or controls', () => {
  assert.equal(validateSharedPassword('Example Base 42!'), 'Example Base 42!');
  assert.throws(() => validateSharedPassword('abc'), /4 to 64/);
  assert.throws(() => validateSharedPassword(' leading-space'), /begin or end/);
  assert.throws(() => validateSharedPassword('line\nbreak'), /control characters/);
});

test('numeric-looking installed passwords can be replaced with text passwords', () => {
  const numericPassword = iniFixture.replace('Password=private', 'Password=4242');
  const parsed = parseIni(numericPassword).entries.find((entry) => entry.key === 'Password');
  assert.equal(parsed.type, 'text');
  assert.match(updateIni(numericPassword, { Password: 'Invite-Code!' }, { allowLocked: true }), /Password=Invite-Code!/);
});

test('installed Project Zomboid presets are discovered with translated descriptions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zedwatch-presets-'));
  const presetDirectory = path.join(root, 'media', 'lua', 'shared', 'Sandbox');
  const translationDirectory = path.join(root, 'media', 'lua', 'shared', 'Translate', 'EN');
  fs.mkdirSync(presetDirectory, { recursive: true });
  fs.mkdirSync(translationDirectory, { recursive: true });
  fs.writeFileSync(path.join(presetDirectory, 'Outbreak.lua'), [
    'return {',
    '    Version = 6,',
    '    Zombies = 4,',
    '    ZombieLore = {',
    '        Speed = 2,',
    '    },',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(translationDirectory, 'UI.json'), JSON.stringify({
    UI_NewGame_Outbreak: 'Outbreak',
    UI_NewGame_Outbreak_desc: 'Less grind.<LINE>More loot.',
  }));
  try {
    const presets = readSandboxPresets(root);
    assert.equal(presets.length, 1);
    assert.equal(presets[0].id, 'outbreak');
    assert.equal(presets[0].description, 'Less grind. More loot.');
    assert.equal(presets[0].values.Zombies, '4');
    assert.equal(presets[0].values['ZombieLore.Speed'], '2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installed option metadata supplies readable names and descriptions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zedwatch-descriptions-'));
  const translationDirectory = path.join(root, 'media', 'lua', 'shared', 'Translate', 'EN');
  fs.mkdirSync(translationDirectory, { recursive: true });
  fs.writeFileSync(path.join(translationDirectory, 'UI.json'), JSON.stringify({
    UI_ServerOption_MysterySetting_tooltip: 'Controls the server mystery setting.<br>Leave off for normal play.',
  }));
  fs.writeFileSync(path.join(translationDirectory, 'Sandbox.json'), JSON.stringify({
    Sandbox_ZSpeed: 'Zombie Speed',
    Sandbox_ZSpeed_tooltip: 'Controls how quickly zombies move.',
  }));
  try {
    const enriched = enrichInstalledSettings(root, [{
      key: 'MysterySetting',
      description: 'Installed Project Zomboid setting: MysterySetting.',
    }], [{
      key: 'ZombieLore.Speed',
      shortKey: 'Speed',
      description: 'Installed sandbox setting: ZombieLore.Speed.',
    }]);
    assert.equal(enriched.ini[0].label, 'Mystery Setting');
    assert.equal(enriched.ini[0].description, 'Controls the server mystery setting. Leave off for normal play.');
    assert.equal(enriched.sandbox[0].label, 'Zombie Speed');
    assert.equal(enriched.sandbox[0].description, 'Controls how quickly zombies move.');
    assert.equal(humanizeSettingKey('SafeHouseRemovalTime'), 'Safe House Removal Time');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
