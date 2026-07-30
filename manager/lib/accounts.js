'use strict';

const fs = require('fs');
const path = require('path');

function connectionLogFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && /_connections\.txt$/i.test(entry.name)) files.push(entryPath);
    }
  }
  return files;
}

function parseLogTimestamp(line) {
  const match = String(line || '').match(/^\[(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})]/);
  if (!match) return null;
  const [, day, month, year, hour, minute, second, millisecond] = match;
  const value = new Date(
    2000 + Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond),
  );
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

function logAttribute(line, name) {
  const match = String(line || '').match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? match[1] : '';
}

function discoverAuthenticatedAccounts(logRoot) {
  const accounts = new Map();
  for (const filePath of connectionLogFiles(logRoot)) {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!/\bevent="fully-connected"/i.test(line)) continue;
      const username = logAttribute(line, 'username').trim();
      if (!username || /^admin$/i.test(username)) continue;
      const lastSeenAt = parseLogTimestamp(line) || fs.statSync(filePath).mtime.toISOString();
      const key = username.toLowerCase();
      const previous = accounts.get(key);
      if (previous && Date.parse(previous.lastSeenAt) >= Date.parse(lastSeenAt)) continue;
      accounts.set(key, {
        username,
        lastSeenAt,
        steamId: logAttribute(line, 'steam-id') || undefined,
      });
    }
  }
  return [...accounts.values()].sort((left, right) => left.username.localeCompare(right.username));
}

function reconcileAccountLedger(ledger, discoveredAccounts) {
  const result = Array.isArray(ledger) ? ledger.map((entry) => ({ ...entry })) : [];
  const added = [];
  const restored = [];
  let changed = false;

  for (const account of discoveredAccounts || []) {
    if (!account?.username || /^admin$/i.test(account.username)) continue;
    const key = account.username.toLowerCase();
    let entry = result.find((item) => String(item.username || '').toLowerCase() === key);
    if (!entry) {
      entry = {
        username: account.username,
        enabled: true,
        source: 'game',
        createdAt: account.lastSeenAt || new Date().toISOString(),
        lastSeenAt: account.lastSeenAt,
      };
      if (account.steamId) entry.steamId = account.steamId;
      result.push(entry);
      added.push(account.username);
      changed = true;
      continue;
    }

    const discoveredAt = Date.parse(account.lastSeenAt || '') || 0;
    const removedAt = Date.parse(entry.removedAt || '') || 0;
    if (entry.removed) {
      if (discoveredAt <= removedAt) continue;
      delete entry.removed;
      delete entry.removedAt;
      entry.enabled = true;
      entry.source = 'game';
      restored.push(account.username);
      changed = true;
    }

    if (account.lastSeenAt && account.lastSeenAt !== entry.lastSeenAt &&
        discoveredAt > (Date.parse(entry.lastSeenAt || '') || 0)) {
      entry.lastSeenAt = account.lastSeenAt;
      changed = true;
    }
    if (account.steamId && account.steamId !== entry.steamId) {
      entry.steamId = account.steamId;
      changed = true;
    }
  }

  return { ledger: result, added, restored, changed };
}

module.exports = {
  connectionLogFiles,
  discoverAuthenticatedAccounts,
  logAttribute,
  parseLogTimestamp,
  reconcileAccountLedger,
};
