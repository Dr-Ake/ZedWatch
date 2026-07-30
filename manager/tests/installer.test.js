'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('installer pins ZedWatch identity, ports, access defaults, and independent runtimes', () => {
  const installer = read('scripts/Install-ZedWatch.ps1');
  assert.match(installer, /'\+app_update'\s+'380870'\s+'validate'/);
  assert.match(installer, /zedwatch\.ini/);
  assert.match(installer, /DefaultPort = '16261'/);
  assert.match(installer, /UDPPort = '16262'/);
  assert.match(installer, /RCONPort = '27025'/);
  assert.match(installer, /MaxPlayers = '8'/);
  assert.match(installer, /AutoCreateUserInWhiteList = 'false'/);
  assert.match(installer, /Drake/);
  assert.match(installer, /Outbreak\.lua/);
  assert.match(installer, /_steamcmd/);
  assert.match(installer, /\.runtime/);
});

test('repository metadata and personal defaults stay assigned to Dr-Ake and Drake', () => {
  const packageMetadata = JSON.parse(read('package.json'));
  assert.equal(packageMetadata.author, 'Dr-Ake');
  assert.equal(packageMetadata.repository.url, 'https://github.com/Dr-Ake/ZedWatch.git');

  for (const relative of [
    'README.md',
    'scripts/Install-ZedWatch.ps1',
    'manager/server-manager.js',
    'manager/public/index.html',
  ]) {
    const content = read(relative);
    assert.match(content, /Drake/, `${relative} must retain Drake as the initial player`);
    assert.doesNotMatch(content, /Ghaleon/i, `${relative} must not use the computer name as a player`);
  }

  const ignore = read('.gitignore');
  for (const protectedPath of [
    '/data/',
    '/server/',
    '/manager/secrets*.json',
    '/manager/whitelist-ledger*.json',
    '/_uninstall-backups/',
    '/ZedWatch Server Info - Private.txt',
  ]) {
    assert.match(ignore, new RegExp(protectedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('launcher uses the bundled 64-bit JVM with the managed heap and server ID', () => {
  const launcher = read('scripts/New-ZedWatchLauncher.ps1');
  assert.match(launcher, /StartServer64\.bat/);
  assert.match(launcher, /-Xms2g/);
  assert.match(launcher, /-Xmx8g/);
  assert.match(launcher, /-servername/);
  assert.match(launcher, /zedwatch/);
  assert.match(launcher, /-cachedir/);
});

test('firewall and startup scripts keep non-game services private and manual by default', () => {
  const firewall = read('scripts/Configure-ZedWatchFirewall.ps1');
  const startup = read('scripts/Register-ZedWatchStartup.ps1');
  assert.match(firewall, /Protocol UDP/);
  assert.match(firewall, /LocalPort '16261-16262'/);
  assert.match(firewall, /jre64\\bin\\java\.exe/);
  assert.doesNotMatch(firewall, /27025|16300/);
  assert.match(startup, /if \(-not \$enableRequested\)/);
  assert.match(startup, /launch-manager\.ps1/);
});

test('release dry run completes without network, elevation, or installation', { skip: process.platform !== 'win32' }, () => {
  const output = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'Install-ZedWatch.ps1'),
    '-InstallRoot', root, '-DryRun', '-NonInteractive',
  ], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.match(output, /installer dry run/i);
  assert.match(output, /app 380870/);
});
