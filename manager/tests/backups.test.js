'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { assertInside, createSnapshot, listBuiltInBackups, listSnapshots, restoreSnapshot, safeName } = require('../lib/backups');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zedwatch-backups-'));
  const dataRoot = path.join(root, 'data');
  const backupsRoot = path.join(root, 'manager', 'backups');
  const managerSettingsPath = path.join(root, 'manager', 'manager-settings.json');
  const whitelistLedgerPath = path.join(root, 'manager', 'whitelist-ledger.json');
  fs.mkdirSync(path.join(dataRoot, 'Saves', 'Multiplayer', 'zedwatch'), { recursive: true });
  fs.mkdirSync(path.dirname(managerSettingsPath), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'Saves', 'Multiplayer', 'zedwatch', 'map.bin'), 'first world');
  fs.writeFileSync(managerSettingsPath, '{"accessMode":"whitelist"}');
  fs.writeFileSync(whitelistLedgerPath, '[{"username":"Drake","enabled":true}]');
  return { root, dataRoot, backupsRoot, managerSettingsPath, whitelistLedgerPath };
}

test('portable snapshots capture and restore the world plus manager state', (t) => {
  const context = fixture();
  t.after(() => fs.rmSync(context.root, { recursive: true, force: true }));
  const snapshot = createSnapshot({ installRoot: context.root, ...context, reason: 'Unit test' });
  assert.ok(snapshot.name.startsWith('ZedWatch-'));
  fs.writeFileSync(path.join(context.dataRoot, 'Saves', 'Multiplayer', 'zedwatch', 'map.bin'), 'changed world');
  fs.writeFileSync(context.managerSettingsPath, '{"accessMode":"password"}');
  restoreSnapshot({ ...context, name: snapshot.name });
  assert.equal(fs.readFileSync(path.join(context.dataRoot, 'Saves', 'Multiplayer', 'zedwatch', 'map.bin'), 'utf8'), 'first world');
  assert.match(fs.readFileSync(context.managerSettingsPath, 'utf8'), /whitelist/);
  assert.equal(listSnapshots(context.backupsRoot).length, 1);
});

test('snapshot retention is bounded and path escape attempts are rejected', (t) => {
  const context = fixture();
  t.after(() => fs.rmSync(context.root, { recursive: true, force: true }));
  for (let index = 0; index < 4; index += 1) {
    createSnapshot({ installRoot: context.root, ...context, reason: `Snapshot ${index}`, retain: 2 });
    const waitUntil = Date.now() + 3;
    while (Date.now() < waitUntil) {}
  }
  assert.equal(listSnapshots(context.backupsRoot).length, 2);
  assert.throws(() => assertInside(context.root, path.join(context.root, '..', 'outside')), /outside ZedWatch/);
  assert.throws(() => safeName('..\\outside'), /invalid/);
});

test('built-in backup inventory finds nested categories once on case-insensitive paths', (t) => {
  const context = fixture();
  t.after(() => fs.rmSync(context.root, { recursive: true, force: true }));
  for (const category of ['startup', 'version']) {
    const directory = path.join(context.dataRoot, 'backups', category);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'backup_1.zip'), category);
  }
  const backups = listBuiltInBackups(context.dataRoot);
  assert.equal(backups.length, 2);
  assert.deepEqual(new Set(backups.map((item) => item.name)), new Set(['startup--backup_1.zip', 'version--backup_1.zip']));
});
