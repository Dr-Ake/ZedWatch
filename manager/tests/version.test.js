'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { detectGameVersion, parseGameVersion } = require('../lib/version');

test('finds the newest Project Zomboid version in server output', () => {
  assert.equal(parseGameVersion('version=42.19.1 old\nversion=42.20.0 current'), '42.20.0');
  assert.equal(parseGameVersion('no version marker'), null);
});

test('detects a version from the first usable local log', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zedwatch-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const empty = path.join(root, 'empty.log');
  const server = path.join(root, 'server.log');
  fs.writeFileSync(empty, 'nothing useful', 'utf8');
  fs.writeFileSync(server, 'LOG > version=43.0.2 abc demo=false', 'utf8');
  assert.equal(detectGameVersion([empty, server]), '43.0.2');
});
