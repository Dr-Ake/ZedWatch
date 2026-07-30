'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  discoverMods, joinList, lookupWorkshopItem, parseModInfo, parseWorkshopId, splitList,
} = require('../lib/mods');

test('accepts Steam Workshop URLs and rejects unrelated hosts', () => {
  assert.equal(parseWorkshopId('3625287786'), '3625287786');
  assert.equal(parseWorkshopId('https://steamcommunity.com/sharedfiles/filedetails/?id=3625287786'), '3625287786');
  assert.throws(() => parseWorkshopId('https://example.com/?id=3625287786'), /Steam Community/);
});

test('Workshop lookup enforces the Project Zomboid consumer app', async () => {
  const response = (consumerAppId) => ({
    ok: true,
    json: async () => ({ response: { publishedfiledetails: [{
      result: 1, publishedfileid: '3625287786', consumer_app_id: consumerAppId,
      title: 'Build 42 Mod', description: '[b]Description[/b]', time_updated: 1, file_size: 42,
    }] } }),
  });
  const item = await lookupWorkshopItem('3625287786', async () => response('108600'));
  assert.equal(item.title, 'Build 42 Mod');
  await assert.rejects(() => lookupWorkshopItem('3625287786', async () => response('123')), /does not belong to Project Zomboid/);
});

test('discovers local and Workshop mod.info packages with Build 42 warnings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zedwatch-mods-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workshopRoot = path.join(root, 'workshop');
  const workshopMod = path.join(workshopRoot, '3625287786', 'mods', 'Airwaves');
  const localRoot = path.join(root, 'local');
  const localMod = path.join(localRoot, 'Safehouse');
  fs.mkdirSync(workshopMod, { recursive: true });
  fs.mkdirSync(localMod, { recursive: true });
  fs.writeFileSync(path.join(workshopMod, 'mod.info'), 'name=Airwaves\nid=Airwaves\nversionMin=42.0');
  fs.writeFileSync(path.join(localMod, 'mod.info'), 'name=Safehouse\nid=Safehouse\nversionMin=41.78');
  const packages = discoverMods({
    workshopRoots: [workshopRoot], localModsRoot: localRoot,
    activeWorkshopItems: ['3625287786'], activeModIds: ['Airwaves'],
  });
  assert.equal(packages.length, 2);
  assert.equal(packages.find((item) => item.id === 'Airwaves').build42Compatible, true);
  assert.equal(packages.find((item) => item.id === 'Airwaves').active, true);
  assert.equal(packages.find((item) => item.id === 'Safehouse').build42Compatible, false);
  assert.deepEqual(parseModInfo('name=Example\nid=example'), { name: 'Example', id: 'example' });
});

test('semicolon setting lists are stable and deduplicated', () => {
  assert.deepEqual(splitList('A; B;;A'), ['A', 'B', 'A']);
  assert.equal(joinList(['A', 'B', 'A', '']), 'A;B');
});
