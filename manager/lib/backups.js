'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing to access a path outside ZedWatch: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeName(value) {
  const name = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) throw new Error('Backup name is invalid.');
  return name;
}

function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function listSnapshots(backupsRoot) {
  if (!fs.existsSync(backupsRoot)) return [];
  return fs.readdirSync(backupsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(backupsRoot, entry.name);
      let metadata = {};
      try { metadata = JSON.parse(fs.readFileSync(path.join(full, 'backup.json'), 'utf8')); } catch {}
      return {
        name: entry.name,
        createdAt: metadata.createdAt || fs.statSync(full).birthtime.toISOString(),
        reason: metadata.reason || 'Manual snapshot',
        size: directorySize(full),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function copyIfPresent(source, destination) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true, errorOnExist: false });
  return true;
}

function createSnapshot({
  installRoot, dataRoot, backupsRoot, managerSettingsPath, whitelistLedgerPath,
  reason = 'Manual snapshot', retain = 12,
}) {
  assertInside(installRoot, dataRoot);
  assertInside(installRoot, backupsRoot);
  fs.mkdirSync(backupsRoot, { recursive: true });
  const name = `ZedWatch-${timestamp()}`;
  const destination = assertInside(backupsRoot, path.join(backupsRoot, name));
  fs.mkdirSync(destination, { recursive: false });
  const copied = [];
  for (const item of ['Server', 'Saves', 'db', 'mods']) {
    if (copyIfPresent(path.join(dataRoot, item), path.join(destination, 'data', item))) copied.push(item);
  }
  if (copyIfPresent(managerSettingsPath, path.join(destination, 'manager', 'manager-settings.json'))) copied.push('manager settings');
  if (copyIfPresent(whitelistLedgerPath, path.join(destination, 'manager', 'whitelist-ledger.json'))) copied.push('whitelist ledger');
  const metadata = { name, createdAt: new Date().toISOString(), reason, copied };
  fs.writeFileSync(path.join(destination, 'backup.json'), JSON.stringify(metadata, null, 2), 'utf8');
  for (const stale of listSnapshots(backupsRoot).slice(retain)) {
    fs.rmSync(assertInside(backupsRoot, path.join(backupsRoot, safeName(stale.name))), { recursive: true, force: true });
  }
  return { ...metadata, size: directorySize(destination) };
}

function restoreSnapshot({ dataRoot, backupsRoot, managerSettingsPath, whitelistLedgerPath, name }) {
  const source = assertInside(backupsRoot, path.join(backupsRoot, safeName(name)));
  if (!fs.existsSync(path.join(source, 'backup.json'))) throw new Error('Portable snapshot was not found.');
  for (const item of ['Server', 'Saves', 'db', 'mods']) {
    const from = path.join(source, 'data', item);
    if (!fs.existsSync(from)) continue;
    const to = assertInside(dataRoot, path.join(dataRoot, item));
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, force: true });
  }
  copyIfPresent(path.join(source, 'manager', 'manager-settings.json'), managerSettingsPath);
  copyIfPresent(path.join(source, 'manager', 'whitelist-ledger.json'), whitelistLedgerPath);
  return JSON.parse(fs.readFileSync(path.join(source, 'backup.json'), 'utf8'));
}

function listBuiltInBackups(dataRoot) {
  const roots = [path.join(dataRoot, 'backups'), path.join(dataRoot, 'Backups')];
  const results = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(full);
          continue;
        }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.zip') continue;
        const relative = path.relative(root, full);
        const category = path.dirname(relative) === '.' ? 'general' : path.dirname(relative).split(path.sep)[0];
        const stat = fs.statSync(full);
        results.push({
          name: relative.split(path.sep).join('--'),
          displayName: `${category}: ${entry.name}`,
          category,
          path: full,
          createdAt: stat.mtime.toISOString(),
          size: stat.size,
        });
      }
    };
    visit(root);
  }
  const seen = new Set();
  return results.filter((item) => {
    const identity = path.resolve(item.path).toLowerCase();
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function restoreBuiltInBackup({ installRoot, dataRoot, backupPath }) {
  assertInside(dataRoot, backupPath);
  const tempRoot = assertInside(installRoot, path.join(installRoot, 'manager', 'restore-staging', `restore-${timestamp()}`));
  fs.mkdirSync(tempRoot, { recursive: true });
  try {
    await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath ${quotePowerShell(backupPath)} -DestinationPath ${quotePowerShell(tempRoot)} -Force`,
    ], { windowsHide: true, timeout: 180000 });
    const extracted = [path.join(tempRoot, 'Zomboid'), tempRoot]
      .find((candidate) => fs.existsSync(path.join(candidate, 'Saves')) || fs.existsSync(path.join(candidate, 'Server')));
    if (!extracted) throw new Error('The built-in archive did not contain recognizable Zomboid data.');
    for (const item of ['Server', 'Saves', 'db']) {
      const from = path.join(extracted, item);
      if (!fs.existsSync(from)) continue;
      const to = assertInside(dataRoot, path.join(dataRoot, item));
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true, force: true });
    }
    return { name: path.basename(backupPath) };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

module.exports = {
  assertInside, createSnapshot, directorySize, listBuiltInBackups, listSnapshots,
  restoreBuiltInBackup, restoreSnapshot, safeName,
};
