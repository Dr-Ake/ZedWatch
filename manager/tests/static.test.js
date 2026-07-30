'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.resolve(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
const manager = fs.readFileSync(path.resolve(__dirname, '..', 'server-manager.js'), 'utf8');

test('local dashboard assets are self-contained and branded ZedWatch', () => {
  assert.match(html, /ZedWatch Server Studio/);
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /href="\/styles\.css"/);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+https?:\/\//);
  assert.doesNotMatch(html, /<script[^>]*>\s*[^<]/);
  assert.ok(app.length > 10000);
  assert.ok(styles.length > 10000);
});

test('every navigation target has a dashboard panel', () => {
  const nav = [...html.matchAll(/data-page="([^"]+)"/g)].map((match) => match[1]);
  const panels = [...html.matchAll(/data-panel="([^"]+)"/g)].map((match) => match[1]);
  for (const target of nav) assert.ok(panels.includes(target), `${target} panel must exist`);
});

test('feature-parity surfaces and API controls are wired', () => {
  for (const id of [
    'mode-whitelist', 'mode-password', 'public-listing', 'settings-grid', 'whitelist-list',
    'workshop-form', 'mod-upload', 'portable-list', 'builtin-list', 'watchdog-enabled',
    'startup-enabled', 'advanced-file', 'broadcast-form', 'shared-password-form',
    'shared-password-current', 'toggle-shared-password', 'copy-shared-password',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /`\/server\/\$\{action\}`/);
  for (const route of [
    '/access', '/public-listing', '/whitelist/add', '/mods/workshop', '/mods/upload',
    '/backup', '/restore-built-in', '/advanced', '/startup', '/watchdog',
  ]) assert.ok(app.includes(route), `${route} must be wired`);
});

test('player-created accounts are explained and have an administrator reset path', () => {
  assert.match(html, /Password-mode accounts appear after their first successful connection/);
  assert.match(html, /Player-chosen passwords cannot be viewed/);
  assert.match(app, /data-user-action="reset"/);
  assert.match(app, /\/whitelist\/\$\{action\}/);
  assert.match(app, /Send this new account password to the player privately/);
  assert.match(manager, /setpassword \$\{quoteRcon\(username\)\} \$\{quoteRcon\(password\)\}/);
});

test('activity feed stays compact while retaining full logs on disk', () => {
  assert.match(app, /const ACTIVITY_LIMIT = 30;/);
  assert.ok(app.includes('compact.length > ACTIVITY_PREVIEW_LENGTH'));
  assert.doesNotMatch(app, /activity\?limit=120/);
  assert.match(styles, /\.activity-list \{ max-height:/);
  assert.match(styles, /overflow-y: auto/);
});

test('generated controls and stable-version branding remain visually safe', () => {
  assert.match(app, /class="backup-restore"/);
  assert.match(styles, /\.backup-restore \{/);
  assert.match(styles, /\.setting-title \{/);
  assert.match(styles, /\.upload-button \{[^}]*overflow: hidden/);
  assert.match(html, /id="radar-version">PZ</);
  assert.doesNotMatch(html, /BUILD 42 RULEBOOK|>42<\/span><small>STABLE/);
});

test('world settings use PalSphere-style grouped tabs with global search', () => {
  assert.match(html, /id="settings-groups"[^>]+role="tablist"/);
  assert.doesNotMatch(html, /id="settings-category"/);
  assert.match(html, /id="settings-group-description"/);
  assert.match(app, /data-settings-group=/);
  assert.match(app, /SEARCH RESULTS/);
  assert.match(app, /Searching across every installed Project Zomboid server and sandbox option/);
  assert.match(styles, /\.group-tab\.active/);
  assert.match(styles, /\.settings-groups \{[^}]*overflow-x: auto/);
});

test('world settings expose installed Project Zomboid presets as staged changes', () => {
  assert.match(html, /id="settings-preset"/);
  assert.match(html, /id="settings-preset-status"/);
  assert.match(app, /function applySettingsPreset/);
  assert.match(app, /preset staged/);
  assert.match(app, /press Save changes/);
  assert.match(styles, /\.preset-select/);
});

test('setting cards show readable labels, explanations, and technical keys', () => {
  assert.match(app, /entry\.label \|\| entry\.key/);
  assert.match(app, /escapeHtml\(entry\.description\)/);
  assert.match(app, /escapeHtml\(entry\.key\)/);
});

test('shared join passwords can be set, revealed, copied, and generated without logging values', () => {
  assert.match(app, /\/access\/shared-password\/reveal/);
  assert.match(app, /\/access\/shared-password/);
  assert.match(app, /Shared password copied/);
  assert.match(manager, /pathname === '\/api\/access\/shared-password\/reveal'/);
  assert.match(manager, /pathname === '\/api\/access\/shared-password'/);
  assert.match(manager, /Shared join password updated manually\./);
  assert.match(manager, /async function launchServer[\s\S]*?saveSecuritySettings\(\);[\s\S]*?detectPortCollisions\(\)/);
  assert.doesNotMatch(manager, /logEvent\([^)]*sharedJoinPassword/);
});
