'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { assertInside } = require('./backups');

const execFileAsync = promisify(execFile);
const WORKSHOP_APP_ID = '108600';

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function splitList(value) {
  return String(value || '').split(';').map((item) => item.trim()).filter(Boolean);
}

function joinList(values) {
  return [...new Set((values || []).map(String).map((value) => value.trim()).filter(Boolean))].join(';');
}

function parseWorkshopId(value) {
  const text = String(value || '').trim();
  if (/^\d{6,20}$/.test(text)) return text;
  let url;
  try { url = new URL(text); } catch { throw new Error('Enter a Steam Workshop URL or numeric item ID.'); }
  if (!/(?:^|\.)steamcommunity\.com$/i.test(url.hostname)) throw new Error('Only Steam Community Workshop URLs are accepted.');
  const id = url.searchParams.get('id');
  if (!/^\d{6,20}$/.test(id || '')) throw new Error('The Workshop URL does not contain a valid item ID.');
  return id;
}

async function lookupWorkshopItem(id, fetchImpl = fetch) {
  const body = new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': String(id) });
  const response = await fetchImpl('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Steam Workshop lookup failed with HTTP ${response.status}.`);
  const detail = (await response.json())?.response?.publishedfiledetails?.[0];
  if (!detail || Number(detail.result) !== 1) throw new Error('Steam could not find that Workshop item.');
  if (String(detail.consumer_app_id) !== WORKSHOP_APP_ID) throw new Error('That Workshop item does not belong to Project Zomboid.');
  return {
    id: String(detail.publishedfileid),
    title: String(detail.title || `Workshop item ${id}`),
    description: String(detail.description || '').replace(/\[[^\]]+\]/g, '').slice(0, 500),
    updatedAt: detail.time_updated ? new Date(Number(detail.time_updated) * 1000).toISOString() : null,
    size: Number(detail.file_size || 0),
    url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${detail.publishedfileid}`,
  };
}

function parseModInfo(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1].toLowerCase()] = match[2];
  }
  return values;
}

function findFiles(root, targetName, maxDepth = 9, depth = 0, results = []) {
  if (!fs.existsSync(root) || depth > maxDepth) return results;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findFiles(full, targetName, maxDepth, depth + 1, results);
    else if (entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()) results.push(full);
  }
  return results;
}

function discoverMods({ workshopRoots = [], localModsRoot, activeWorkshopItems = [], activeModIds = [] }) {
  const packages = [];
  const seen = new Set();
  const scan = (root, source, workshopId = null) => {
    for (const infoPath of findFiles(root, 'mod.info')) {
      const info = parseModInfo(fs.readFileSync(infoPath, 'utf8'));
      const id = String(info.id || path.basename(path.dirname(infoPath))).trim();
      const identity = `${source}:${workshopId || ''}:${id}`;
      if (!id || seen.has(identity)) continue;
      seen.add(identity);
      packages.push({
        id, name: info.name || id, description: info.description || '',
        workshopId, source, path: path.dirname(infoPath),
        versionMin: info.versionmin || info.version || '',
        build42Compatible: !info.versionmin || /^42(?:\.|$)/.test(info.versionmin),
        active: activeModIds.includes(id),
        workshopActive: workshopId ? activeWorkshopItems.includes(workshopId) : false,
      });
    }
  };
  for (const workshopRoot of workshopRoots) {
    if (!fs.existsSync(workshopRoot)) continue;
    for (const item of fs.readdirSync(workshopRoot, { withFileTypes: true })) {
      if (item.isDirectory() && /^\d+$/.test(item.name)) scan(path.join(workshopRoot, item.name), 'workshop', item.name);
    }
  }
  scan(localModsRoot, 'local');
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

async function importZip({ installRoot, zipPath, localModsRoot, stagingRoot }) {
  assertInside(installRoot, zipPath);
  assertInside(installRoot, localModsRoot);
  assertInside(installRoot, stagingRoot);
  const staging = path.join(stagingRoot, `mod-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath ${quotePowerShell(zipPath)} -DestinationPath ${quotePowerShell(staging)} -Force`,
    ], { windowsHide: true, timeout: 180000 });
    const infos = findFiles(staging, 'mod.info');
    if (!infos.length) throw new Error('The ZIP does not contain a Project Zomboid mod.info file.');
    const installed = [];
    fs.mkdirSync(localModsRoot, { recursive: true });
    for (const infoPath of infos) {
      const info = parseModInfo(fs.readFileSync(infoPath, 'utf8'));
      const id = String(info.id || '').trim();
      if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) throw new Error('A mod.info file contains a missing or unsafe mod ID.');
      const destination = assertInside(localModsRoot, path.join(localModsRoot, id));
      fs.rmSync(destination, { recursive: true, force: true });
      fs.cpSync(path.dirname(infoPath), destination, { recursive: true, force: true });
      installed.push({ id, name: info.name || id });
    }
    return installed;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
  }
}

function removeLocalMod({ localModsRoot, modId }) {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(String(modId || ''))) throw new Error('Mod ID is invalid.');
  const target = assertInside(localModsRoot, path.join(localModsRoot, String(modId)));
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

module.exports = {
  WORKSHOP_APP_ID, discoverMods, importZip, joinList, lookupWorkshopItem,
  parseModInfo, parseWorkshopId, removeLocalMod, splitList,
};
