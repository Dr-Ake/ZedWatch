'use strict';

const state = {
  token: '',
  status: null,
  settings: null,
  manager: null,
  whitelist: [],
  mods: null,
  backups: null,
  dirty: { ini: {}, sandbox: {} },
  activePage: 'dashboard',
  settingsGroup: '',
  presetNotice: null,
  sharedPassword: '',
  sharedPasswordVisible: false,
  busy: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const pageNames = {
  dashboard: ['LIVE SITUATION', 'Exclusion zone overview'],
  settings: ['STABLE RULEBOOK', 'World settings'],
  players: ['PERIMETER CONTROL', 'Players & access'],
  mods: ['WORKSHOP DEPOT', 'Workshop mods'],
  backups: ['WORLD ARCHIVE', 'Saves & backups'],
  activity: ['COMMAND POST', 'Activity & tools'],
};
const ACTIVITY_LIMIT = 30;
const ACTIVITY_PREVIEW_LENGTH = 180;
const SETTING_GROUPS = [
  ['Identity & access', 'Server identity, joining, authentication, and account rules.'],
  ['Network & visibility', 'Ports, Steam connectivity, public discovery, and network behavior.'],
  ['Players & co-op', 'PvP, safety, sleep, factions, and safehouse rules.'],
  ['Communication', 'Chat, voice, welcome messages, names, and integrations.'],
  ['World & protection', 'World saves, maps, spawn behavior, resets, and protection.'],
  ['Sandbox gameplay', 'Zombies, loot, time, nature, farming, and animals.'],
  ['Mods & compatibility', 'Workshop, mod loading, Lua, and checksum behavior.'],
  ['Security', 'Anti-cheat, bans, kicks, speed limits, and server protection.'],
  ['Advanced server', 'Remaining installed and engine-level controls.'],
];

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const options = { method, headers: { ...headers } };
  if (method !== 'GET') options.headers['X-ZedWatch-Token'] = state.token;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  } else if (body !== undefined) {
    options.body = body;
  }
  const response = await fetch(`/api${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `ZedWatch request failed (${response.status}).`);
  return payload;
}

function toast(title, detail = '', kind = 'ok', duration = 4200) {
  const element = $('#toast');
  element.className = `toast show ${kind}`;
  element.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), duration);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** power)).toFixed(power > 2 ? 1 : 0)} ${units[power]}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function displayServerDescription(value) {
  const description = String(value || '').trim();
  if (/^Private Build 42 survival server(?: hosted with ZedWatch)?$/i.test(description)) {
    return 'Private Project Zomboid survival server hosted with ZedWatch';
  }
  return description || 'Private Project Zomboid survival server';
}

function displayLuaValue(entry) {
  if (entry.type === 'string' && /^".*"$/.test(entry.value)) {
    try { return JSON.parse(entry.value); } catch { return entry.value.slice(1, -1); }
  }
  return entry.value;
}

function setBusy(busy, message) {
  state.busy = busy;
  document.body.classList.toggle('is-busy', busy);
  $$('button').forEach((button) => {
    if (button.dataset.keepEnabled !== 'true') button.disabled = busy || button.dataset.locked === 'true';
  });
  if (busy && message) toast(message, 'Please keep this dashboard open.', 'working', 30000);
  else if (!busy) renderLocks();
}

async function runAction(label, operation, { refresh = true } = {}) {
  if (state.busy) return;
  setBusy(true, label);
  try {
    const result = await operation();
    toast(`${label} complete`);
    if (refresh) await refreshAll();
    return result;
  } catch (error) {
    toast(label, error.message, 'error', 7000);
    throw error;
  } finally {
    setBusy(false);
  }
}

function confirmAction(message) {
  return window.confirm(message);
}

async function copyText(value, label = 'Address copied') {
  if (!value || value === 'Unavailable') return;
  await navigator.clipboard.writeText(value);
  toast(label, value);
}

function showCredential(title, value, copy = 'Copy this now and send it privately.') {
  $('#credential-title').textContent = title;
  $('#credential-copy').textContent = copy;
  $('#credential-value').textContent = value;
  $('#credential-dialog').showModal();
}

function renderSharedPassword() {
  const input = $('#shared-password-current');
  if (!input) return;
  input.value = state.sharedPasswordVisible ? state.sharedPassword : '';
  input.type = state.sharedPasswordVisible ? 'text' : 'password';
  $('#toggle-shared-password').textContent = state.sharedPasswordVisible ? 'Hide password' : 'Show password';
  $('#copy-shared-password').disabled = state.busy || !state.sharedPasswordVisible || !state.sharedPassword;
}

function serverStateText(status) {
  if (status.transition?.type) return status.transition.type.replace(/-/g, ' ');
  if (status.updating) return 'updating';
  return status.running ? 'online' : 'offline';
}

function renderStatus() {
  const status = state.status;
  if (!status) return;
  const stateText = serverStateText(status);
  const transitional = Boolean(status.transition || status.updating);
  $('#manager-version').textContent = `v${status.managerVersion}`;
  $('#server-name').textContent = status.serverName || 'ZedWatch';
  $('#server-description').textContent = displayServerDescription(status.description);
  $('#player-count').textContent = status.players?.length || 0;
  $('#player-limit').textContent = status.maxPlayers || 8;
  $('#player-summary').textContent = status.running
    ? (status.players?.length ? status.players.join(', ') : 'No survivors connected')
    : 'World is offline';
  $('#memory').textContent = formatBytes(status.memoryBytes);
  $('#backup-count').textContent = (status.backups?.portable || 0) + (status.backups?.builtIn || 0);
  $('#backup-summary').textContent = `${status.backups?.portable || 0} portable + ${status.backups?.builtIn || 0} built-in`;
  $('#build-id').textContent = status.buildId || '—';
  const gameVersion = String(status.gameVersion || '').trim();
  $('#radar-version').textContent = gameVersion.split('.')[0] || 'PZ';
  $('#build-summary').textContent = gameVersion ? `Version ${gameVersion} · public stable` : 'Public stable Steam branch';
  $('#stable-version-ready').textContent = gameVersion ? `Project Zomboid ${gameVersion}` : 'Public stable installed';
  $('#lan-address').textContent = status.lanAddress || 'Unavailable';
  $('#public-address').textContent = status.publicAddress || 'Unavailable';
  $('#access-badge').textContent = String(status.accessMode || 'whitelist').toUpperCase();
  $('#public-listing').checked = Boolean(status.publicListing);
  $('#watchdog-enabled').checked = Boolean(status.watchdog?.enabled);
  $('#startup-enabled').checked = Boolean(status.startupEnabled);
  $('#watchdog-summary').textContent = status.watchdog?.enabled
    ? `${status.watchdog.maxRestarts || 3} tries in ${Math.round((status.watchdog.windowMs || 600000) / 60000)} minutes`
    : 'Crash recovery is disabled';
  $('#startup-ready').classList.toggle('muted', !status.startupEnabled);
  $('#mode-whitelist').classList.toggle('active', status.accessMode === 'whitelist');
  $('#mode-password').classList.toggle('active', status.accessMode === 'password');

  const pill = $('#status-pill');
  pill.className = `status-pill ${status.running ? 'online' : (transitional ? 'transitioning' : 'offline')}`;
  $('span', pill).textContent = stateText.charAt(0).toUpperCase() + stateText.slice(1);
  $('#hero-state').textContent = transitional
    ? `WATCH ${stateText.toUpperCase()}`
    : (status.running ? 'PERIMETER ACTIVE' : 'WATCH STANDING BY');
  $$('.running-only').forEach((element) => { element.hidden = !status.running; });
  $$('.stopped-only').forEach((element) => { element.hidden = status.running; });
  renderLocks();
}

function renderLocks() {
  const running = Boolean(state.status?.running);
  $('#settings-lock').hidden = !running;
  $('#mods-lock').hidden = !running;
  $('#access-lock-note').textContent = running
    ? 'Save and stop the world before changing access or listing.'
    : 'Access can be changed while the server is stopped.';
  ['#mode-whitelist', '#mode-password', '#public-listing', '#rotate-shared', '#create-backup',
    '#shared-password-new', '#shared-password-confirm', '#set-shared-password',
    '#workshop-value', '#mod-upload', '#advanced-file', '#advanced-content', '#save-advanced', '#settings-preset']
    .forEach((selector) => {
      const element = $(selector);
      if (!element) return;
      element.dataset.locked = String(running);
      element.disabled = state.busy || running || (selector === '#settings-preset' && !state.settings?.presets?.length)
        || (selector === '#advanced-content' && !$('#advanced-file').value)
        || (selector === '#save-advanced' && !$('#advanced-file').value);
    });
  $$('#settings-grid input, #settings-grid select, #settings-grid textarea').forEach((element) => {
    element.disabled = running || state.busy || element.dataset.locked === 'true';
  });
  $('#save-settings').disabled = running || state.busy || !hasDirtySettings();
  $('#discard-settings').disabled = running || state.busy || !hasDirtySettings();
  $('#toggle-shared-password').disabled = state.busy;
  $('#copy-shared-password').disabled = state.busy || !state.sharedPasswordVisible || !state.sharedPassword;
  $$('#mods-list button, #workshop-form button').forEach((element) => { element.disabled = running || state.busy; });
}

function settingControl(scope, entry) {
  const id = `${scope}-${entry.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const changed = Object.prototype.hasOwnProperty.call(state.dirty[scope], entry.key);
  const value = changed ? state.dirty[scope][entry.key] : (scope === 'sandbox' ? displayLuaValue(entry) : entry.value);
  let input;
  if (entry.type === 'boolean') {
    input = `<label class="switch setting-switch"><input id="${id}" type="checkbox" ${String(value).toLowerCase() === 'true' ? 'checked' : ''}><span></span></label>`;
  } else {
    const type = entry.type === 'number' ? 'number' : 'text';
    const bounds = `${entry.minimum !== undefined ? ` min="${entry.minimum}"` : ''}${entry.maximum !== undefined ? ` max="${entry.maximum}"` : ''}`;
    input = `<input id="${id}" type="${type}" value="${escapeHtml(value)}"${bounds}${entry.secret ? ' autocomplete="new-password"' : ''}>`;
  }
  return `<article class="setting-card${changed ? ' dirty' : ''}">
    <div class="setting-title"><span>${escapeHtml(entry.category)}</span><strong>${escapeHtml(entry.label || entry.key)}</strong></div>
    <p>${escapeHtml(entry.description)}</p>
    <div class="setting-input">${input}</div>
    <small>${escapeHtml(entry.key)} · ${entry.minimum !== undefined || entry.maximum !== undefined ? `Allowed: ${entry.minimum ?? 'any'} to ${entry.maximum ?? 'any'}` : `Installed value · ${entry.type}`}</small>
  </article>`;
}

function hasDirtySettings() {
  return Object.keys(state.dirty.ini).length + Object.keys(state.dirty.sandbox).length > 0;
}

function editableSettingsEntries() {
  return [
    ...state.settings.ini.filter((entry) => !entry.locked && !entry.secret).map((entry) => ({ ...entry, scope: 'ini' })),
    ...state.settings.sandbox.map((entry) => ({ ...entry, scope: 'sandbox' })),
  ];
}

function orderedSettingGroups(entries) {
  const available = new Set(entries.map((entry) => entry.category));
  const known = SETTING_GROUPS
    .filter(([name]) => available.has(name))
    .map(([name, description]) => ({ name, description }));
  const knownNames = new Set(known.map((group) => group.name));
  const unknown = [...available]
    .filter((name) => !knownNames.has(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name, description: 'Installed Project Zomboid options in this category.' }));
  return [...known, ...unknown];
}

function renderSettingsGroups(entries, groups) {
  const counts = entries.reduce((result, entry) => {
    result[entry.category] = (result[entry.category] || 0) + 1;
    return result;
  }, {});
  $('#settings-groups').innerHTML = groups.map((group) => {
    const active = group.name === state.settingsGroup;
    return `<button type="button" class="group-tab${active ? ' active' : ''}" data-settings-group="${escapeHtml(group.name)}" role="tab" aria-selected="${active}" tabindex="${active ? '0' : '-1'}">
      ${escapeHtml(group.name)} <span class="count">${counts[group.name] || 0}</span>
    </button>`;
  }).join('');
  $$('[data-settings-group]').forEach((button) => {
    button.addEventListener('click', () => {
      state.settingsGroup = button.dataset.settingsGroup;
      $('#settings-search').value = '';
      renderSettings();
    });
  });
}

function renderSettingsPreset() {
  const picker = $('#settings-preset');
  const presets = state.settings?.presets || [];
  picker.innerHTML = '<option value="">Choose a preset...</option>' +
    presets.map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</option>`).join('');
  picker.value = '';
  const notice = $('#settings-preset-status');
  notice.hidden = !state.presetNotice;
  notice.innerHTML = state.presetNotice ? `<strong>${escapeHtml(state.presetNotice.label)} staged</strong><span>${escapeHtml(state.presetNotice.description)} Review the highlighted changes, then press Save changes.</span>` : '';
}

function renderSettings() {
  if (!state.settings) return;
  const entries = editableSettingsEntries();
  const groups = orderedSettingGroups(entries);
  if (!groups.some((group) => group.name === state.settingsGroup)) {
    state.settingsGroup = groups[0]?.name || '';
  }
  renderSettingsPreset();
  renderSettingsGroups(entries, groups);

  const term = $('#settings-search').value.trim().toLowerCase();
  const visibleEntries = entries.filter((entry) => {
    if (!term) return entry.category === state.settingsGroup;
    return `${entry.key} ${entry.label || ''} ${entry.description} ${entry.category}`.toLowerCase().includes(term);
  });
  const activeGroup = groups.find((group) => group.name === state.settingsGroup);
  $('#settings-group-eyebrow').textContent = term ? 'SEARCH RESULTS' : 'SETTINGS CATEGORY';
  $('#settings-group-title').textContent = term ? `Results for “${$('#settings-search').value.trim()}”` : (activeGroup?.name || 'World settings');
  $('#settings-group-description').textContent = term
    ? 'Searching across every installed Project Zomboid server and sandbox option.'
    : (activeGroup?.description || 'Installed Project Zomboid options.');
  $('#settings-count').textContent = visibleEntries.length;
  $('#settings-grid').innerHTML = visibleEntries.map((entry) => settingControl(entry.scope, entry)).join('');
  for (const entry of visibleEntries) {
    const id = `#${entry.scope}-${entry.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    const input = $(id);
    if (!input) continue;
    input.dataset.scope = entry.scope;
    input.dataset.key = entry.key;
    input.dataset.type = entry.type;
    input.addEventListener('input', onSettingChanged);
    input.addEventListener('change', onSettingChanged);
  }
  const advanced = $('#advanced-file');
  const selected = advanced.value;
  advanced.innerHTML = '<option value="">Choose a file...</option>' +
    state.settings.advancedFiles.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  if (state.settings.advancedFiles.includes(selected)) advanced.value = selected;
  $('#settings-empty').hidden = visibleEntries.length > 0;
  renderLocks();
}

function onSettingChanged(event) {
  const input = event.currentTarget;
  state.dirty[input.dataset.scope][input.dataset.key] =
    input.dataset.type === 'boolean' ? String(input.checked) : input.value;
  input.closest('.setting-card')?.classList.add('dirty');
  renderLocks();
}

function settingsValuesEqual(entry, left, right) {
  if (entry.type === 'number') return Number(left) === Number(right);
  if (entry.type === 'boolean') return String(left).toLowerCase() === String(right).toLowerCase();
  return String(left ?? '') === String(right ?? '');
}

function applySettingsPreset(presetId) {
  if (!presetId || state.status?.running || state.busy) return;
  const preset = state.settings?.presets?.find((item) => item.id === presetId);
  if (!preset) return;
  let changed = 0;
  for (const entry of state.settings.sandbox) {
    if (!Object.prototype.hasOwnProperty.call(preset.values, entry.key)) continue;
    const presetValue = preset.values[entry.key];
    const installedValue = displayLuaValue(entry);
    if (settingsValuesEqual(entry, installedValue, presetValue)) {
      delete state.dirty.sandbox[entry.key];
    } else {
      state.dirty.sandbox[entry.key] = String(presetValue);
      changed += 1;
    }
  }
  state.presetNotice = { label: preset.label, description: preset.description };
  state.settingsGroup = 'Sandbox gameplay';
  $('#settings-search').value = '';
  renderSettings();
  toast(`${preset.label} preset staged`, `${changed} installed values will change after you press Save changes.`);
}

function renderWhitelist() {
  const users = state.whitelist || [];
  $('#whitelist-count').textContent = `${users.length} USER${users.length === 1 ? '' : 'S'}`;
  $('#whitelist-list').innerHTML = users.length ? users.map((user) => `
    <div class="account-row">
      <div class="account-avatar">${escapeHtml(user.username.slice(0, 2).toUpperCase())}</div>
      <div><strong>${escapeHtml(user.username)}</strong><small>${user.enabled ? 'Cleared to enter' : 'Disabled'}</small></div>
      <span class="badge ${user.enabled ? 'safe' : ''}">${user.enabled ? 'ACTIVE' : 'DISABLED'}</span>
      <div class="row-actions">
        <button data-user-action="rotate" data-username="${escapeHtml(user.username)}">Rotate</button>
        <button data-user-action="${user.enabled ? 'disable' : 'rotate'}" data-username="${escapeHtml(user.username)}">${user.enabled ? 'Disable' : 'Re-enable'}</button>
        <button class="danger-link" data-user-action="remove" data-username="${escapeHtml(user.username)}">Remove</button>
      </div>
    </div>`).join('') : '<div class="empty">No whitelist accounts are recorded.</div>';
  $$('#whitelist-list button').forEach((button) => { button.disabled = !state.status?.running || state.busy; });
}

function renderMods() {
  const packages = state.mods?.packages || [];
  const serverVersion = String(state.status?.gameVersion || '');
  const serverMajor = serverVersion.match(/^(\d+)/)?.[1] || '';
  $('#mod-count').textContent = `${packages.length} MOD${packages.length === 1 ? '' : 'S'}`;
  $('#mods-empty').hidden = packages.length > 0;
  $('#mods-list').innerHTML = packages.map((mod) => {
    const declaredVersion = String(mod.versionMin || '');
    const declaredMajor = declaredVersion.match(/^(\d+)/)?.[1] || '';
    const warning = declaredMajor && serverMajor && declaredMajor !== serverMajor
      ? `<em>Declares version ${escapeHtml(declaredVersion)}; this server is ${escapeHtml(serverVersion)}.</em>`
      : '';
    return `
    <div class="mod-row">
      <div class="mod-icon">${mod.source === 'workshop' ? 'WS' : 'ZIP'}</div>
      <div class="mod-copy"><strong>${escapeHtml(mod.name)}</strong><small>${escapeHtml(mod.id)} · ${escapeHtml(mod.source)}${mod.workshopId ? ` · ${escapeHtml(mod.workshopId)}` : ''}</small>
        <p>${escapeHtml(mod.description || 'No package description provided.')}</p>
        ${warning}
      </div>
      <label class="switch"><input type="checkbox" data-mod-toggle="${escapeHtml(mod.id)}" ${mod.active ? 'checked' : ''}><span></span></label>
      <button class="danger-link" data-mod-remove="${escapeHtml(mod.id)}" data-workshop-id="${escapeHtml(mod.workshopId || '')}">Remove</button>
    </div>`;
  }).join('');
  renderLocks();
}

function backupRow(item, type) {
  return `<div class="backup-row">
    <div><strong>${escapeHtml(item.displayName || item.name)}</strong><small>${formatDate(item.createdAt)} · ${formatBytes(item.size)}</small><p>${escapeHtml(item.reason || (type === 'portable' ? 'Portable snapshot' : 'Project Zomboid built-in archive'))}</p></div>
    <button class="backup-restore" data-restore="${escapeHtml(item.name)}" data-backup-type="${type}">Restore</button>
  </div>`;
}

function renderBackups() {
  const backups = state.backups || { portable: [], builtIn: [] };
  $('#portable-count').textContent = backups.portable.length;
  $('#builtin-count').textContent = backups.builtIn.length;
  const latest = [...backups.portable, ...backups.builtIn].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  $('#latest-backup-time').textContent = latest ? formatDate(latest.createdAt) : '—';
  $('#portable-list').innerHTML = backups.portable.length
    ? backups.portable.map((item) => backupRow(item, 'portable')).join('')
    : '<div class="empty">No portable snapshots yet.</div>';
  $('#builtin-list').innerHTML = backups.builtIn.length
    ? backups.builtIn.map((item) => backupRow(item, 'built-in')).join('')
    : '<div class="empty">No built-in archives yet.</div>';
  $$('.backup-list button').forEach((button) => { button.disabled = state.status?.running || state.busy; });
}

function activityType(value) {
  return String(value || 'event').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'event';
}

function activityPreview(value) {
  const compact = String(value || 'ZedWatch event').replace(/\s+/g, ' ').trim();
  return compact.length > ACTIVITY_PREVIEW_LENGTH
    ? `${compact.slice(0, ACTIVITY_PREVIEW_LENGTH - 1)}…`
    : compact;
}

function renderActivity(items) {
  $('#activity-list').innerHTML = items.length ? items.map((item) => {
    const type = activityType(item.type);
    const label = type.replace(/-/g, ' ');
    return `
    <div class="activity-row ${type}">
      <i aria-hidden="true"></i>
      <div class="activity-copy">
        <div class="activity-meta">
          <b>${escapeHtml(label)}</b>
          <time>${formatDate(item.at || item.timestamp)}</time>
        </div>
        <span>${escapeHtml(activityPreview(item.message))}</span>
      </div>
    </div>`;
  }).join('') : '<div class="empty">No manager activity has been recorded yet.</div>';
}

async function refreshStatus() {
  state.status = await api('/status');
  renderStatus();
}

async function refreshAll() {
  const [status, manager, whitelist, backups, mods] = await Promise.all([
    api('/status'), api('/manager-settings'), api('/whitelist'), api('/backups'), api('/mods'),
  ]);
  state.status = status;
  state.manager = manager;
  state.whitelist = whitelist.users || [];
  state.backups = backups;
  state.mods = mods;
  renderStatus();
  renderWhitelist();
  renderBackups();
  renderMods();
  if (state.activePage === 'activity') renderActivity(await api(`/activity?limit=${ACTIVITY_LIMIT}`));
}

async function selectPage(name) {
  state.activePage = name;
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === name));
  $$('.page').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name));
  $('#page-kicker').textContent = pageNames[name][0];
  $('#page-title').textContent = pageNames[name][1];
  if (name === 'settings' && !state.settings) {
    state.settings = await api('/settings');
    renderSettings();
  }
  if (name === 'activity') renderActivity(await api(`/activity?limit=${ACTIVITY_LIMIT}`));
  if (name === 'backups') {
    state.backups = await api('/backups');
    renderBackups();
  }
  if (name === 'mods') {
    state.mods = await api('/mods');
    renderMods();
  }
}

async function serverAction(action) {
  const labels = {
    start: 'Starting world', stop: 'Saving and stopping', restart: 'Restarting world',
    save: 'Saving world', update: 'Updating stable build', 'force-stop': 'Force stopping',
    'launch-game': 'Opening Project Zomboid',
  };
  if (action === 'force-stop' && !confirmAction('Force stop the server? Use this only when a graceful stop cannot complete.')) return;
  if (action === 'update' && !confirmAction('Create a safety snapshot and validate the current stable server build?')) return;
  const endpoint = action === 'update' ? '/update' : (action === 'launch-game' ? '/launch-game' : `/server/${action}`);
  await runAction(labels[action], () => api(endpoint, { method: 'POST' }));
}

function bindNavigation() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => selectPage(button.dataset.page).catch(showError)));
  $$('[data-go]').forEach((button) => button.addEventListener('click', () => selectPage(button.dataset.go).catch(showError)));
}

function bindServerControls() {
  $$('[data-action]').forEach((button) => button.addEventListener('click', () => serverAction(button.dataset.action).catch(() => {})));
  $('#refresh').addEventListener('click', () => runAction('Refreshing dashboard', refreshAll).catch(() => {}));
  $('#copy-public').addEventListener('click', () => copyText(state.status?.publicAddress || 'Unavailable'));
  $('#copy-lan').addEventListener('click', () => copyText(state.status?.lanAddress || 'Unavailable'));
  $('#credential-value').addEventListener('click', () => copyText($('#credential-value').textContent, 'Credential copied'));
}

function bindAccessControls() {
  $$('[data-mode]').forEach((button) => button.addEventListener('click', async () => {
    const mode = button.dataset.mode;
    if (mode === state.status?.accessMode || state.status?.running) return;
    if (!confirmAction(`Switch to ${mode} access? ZedWatch will create a safety snapshot and preserve all existing accounts.`)) return;
    await runAction(`Switching to ${mode} access`, () => api('/access', { method: 'POST', body: { mode } })).catch(() => {});
  }));
  $('#public-listing').addEventListener('change', async (event) => {
    const enabled = event.currentTarget.checked;
    try {
      await runAction(`${enabled ? 'Enabling' : 'Disabling'} server listing`, () => api('/public-listing', { method: 'POST', body: { enabled } }));
    } catch { event.currentTarget.checked = !enabled; }
  });
  $('#toggle-shared-password').addEventListener('click', async () => {
    if (state.sharedPasswordVisible) {
      state.sharedPasswordVisible = false;
      state.sharedPassword = '';
      renderSharedPassword();
      return;
    }
    try {
      const result = await runAction('Showing shared password',
        () => api('/access/shared-password/reveal', { method: 'POST' }), { refresh: false });
      state.sharedPassword = result.password;
      state.sharedPasswordVisible = true;
      renderSharedPassword();
    } catch {}
  });
  $('#copy-shared-password').addEventListener('click', () => copyText(state.sharedPassword, 'Shared password copied'));
  $('#credential-dialog').addEventListener('close', () => {
    $('#credential-value').textContent = '—';
  });
  $('#shared-password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = $('#shared-password-new').value;
    const confirmation = $('#shared-password-confirm').value;
    if (password !== confirmation) {
      toast('Passwords do not match', 'Type the same password in both boxes.', 'error');
      return;
    }
    if (!confirmAction('Replace the shared join password with your custom password?')) return;
    try {
      const result = await runAction('Setting shared password',
        () => api('/access/shared-password', { method: 'POST', body: { password } }), { refresh: false });
      state.sharedPassword = result.password;
      state.sharedPasswordVisible = true;
      event.currentTarget.reset();
      renderSharedPassword();
      showCredential('Shared password updated', result.password, 'This is the password friends use in password mode.');
    } catch {}
  });
  $('#rotate-shared').addEventListener('click', async () => {
    if (!confirmAction('Rotate the shared join password? The old code will stop working the next time password mode starts.')) return;
    try {
      const result = await runAction('Rotating shared password', () => api('/access/rotate-shared', { method: 'POST' }), { refresh: false });
      state.sharedPassword = result.password;
      state.sharedPasswordVisible = true;
      renderSharedPassword();
      showCredential('Shared password rotated', result.password);
    } catch {}
  });
  $('#add-user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('#new-username').value.trim();
    const password = $('#new-user-password').value;
    try {
      const result = await runAction('Adding whitelist account', () => api('/whitelist/add', { method: 'POST', body: { username, password } }));
      event.currentTarget.reset();
      showCredential(`${result.username} is cleared`, result.password);
    } catch {}
  });
  $('#whitelist-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-user-action]');
    if (!button) return;
    const { userAction: action, username } = button.dataset;
    if (action !== 'rotate' && !confirmAction(`${action === 'remove' ? 'Remove' : 'Disable'} ${username}?`)) return;
    try {
      const result = await runAction(`${action === 'rotate' ? 'Rotating' : action === 'remove' ? 'Removing' : 'Disabling'} ${username}`,
        () => api(`/whitelist/${action}`, { method: 'POST', body: { username } }));
      if (result.password) showCredential(`${username} password rotated`, result.password);
    } catch {}
  });
  $('#broadcast-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('#broadcast-message').value.trim();
    try {
      await runAction('Broadcasting message', () => api('/server/broadcast', { method: 'POST', body: { message } }), { refresh: false });
      event.currentTarget.reset();
    } catch {}
  });
}

function bindSettingsControls() {
  $('#settings-search').addEventListener('input', renderSettings);
  $('#settings-preset').addEventListener('change', (event) => applySettingsPreset(event.target.value));
  $('#discard-settings').addEventListener('click', () => {
    state.dirty = { ini: {}, sandbox: {} };
    state.presetNotice = null;
    renderSettings();
  });
  $('#save-settings').addEventListener('click', async () => {
    try {
      state.settings = await runAction('Saving world settings',
        () => api('/settings', { method: 'POST', body: state.dirty }), { refresh: false });
      state.dirty = { ini: {}, sandbox: {} };
      state.presetNotice = null;
      renderSettings();
      await refreshAll();
    } catch {}
  });
}

function bindModControls() {
  $('#workshop-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = $('#workshop-value').value.trim();
    try {
      const result = await runAction('Validating Workshop item',
        () => api('/mods/workshop', { method: 'POST', body: { value } }), { refresh: false });
      state.mods = result.mods;
      renderMods();
      event.currentTarget.reset();
      toast('Workshop item staged', result.detail.title);
    } catch {}
  });
  $('#mod-upload').addEventListener('change', async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      const result = await runAction('Importing local mod ZIP', () => api('/mods/upload', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/zip', 'X-Filename': file.name },
      }), { refresh: false });
      state.mods = result.mods;
      renderMods();
    } catch {} finally { event.currentTarget.value = ''; }
  });
  $('#mods-list').addEventListener('change', async (event) => {
    const input = event.target.closest('[data-mod-toggle]');
    if (!input) return;
    try {
      state.mods = await runAction(`${input.checked ? 'Enabling' : 'Disabling'} ${input.dataset.modToggle}`,
        () => api('/mods/toggle', { method: 'POST', body: { modId: input.dataset.modToggle, enabled: input.checked } }), { refresh: false });
      renderMods();
    } catch { input.checked = !input.checked; }
  });
  $('#mods-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-mod-remove]');
    if (!button || !confirmAction(`Remove ${button.dataset.modRemove} from ZedWatch?`)) return;
    try {
      state.mods = await runAction(`Removing ${button.dataset.modRemove}`, () => api('/mods/remove', {
        method: 'POST', body: { modId: button.dataset.modRemove, workshopId: button.dataset.workshopId },
      }), { refresh: false });
      renderMods();
    } catch {}
  });
}

function bindBackupControls() {
  $('#create-backup').addEventListener('click', async () => {
    try {
      await runAction('Creating portable snapshot', () => api('/backup', { method: 'POST', body: { reason: 'Manual dashboard snapshot' } }));
    } catch {}
  });
  $('.page[data-panel="backups"]').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-restore]');
    if (!button || !confirmAction(`Restore ${button.dataset.restore}? ZedWatch will first snapshot the current world.`)) return;
    const endpoint = button.dataset.backupType === 'built-in' ? '/restore-built-in' : '/restore';
    try {
      await runAction('Restoring world archive', () => api(endpoint, { method: 'POST', body: { name: button.dataset.restore } }));
    } catch {}
  });
}

function bindTools() {
  $('#refresh-activity').addEventListener('click', async () => renderActivity(await api(`/activity?limit=${ACTIVITY_LIMIT}`)));
  $('#watchdog-enabled').addEventListener('change', async (event) => {
    const enabled = event.currentTarget.checked;
    try {
      await runAction(`${enabled ? 'Enabling' : 'Disabling'} crash recovery`,
        () => api('/watchdog', { method: 'POST', body: { enabled } }));
    } catch { event.currentTarget.checked = !enabled; }
  });
  $('#startup-enabled').addEventListener('change', async (event) => {
    const enabled = event.currentTarget.checked;
    try {
      await runAction(`${enabled ? 'Enabling' : 'Disabling'} Windows startup`,
        () => api('/startup', { method: 'POST', body: { enabled } }));
    } catch { event.currentTarget.checked = !enabled; }
  });
  $$('.folder-grid button').forEach((button) => button.addEventListener('click', () =>
    api('/open-folder', { method: 'POST', body: { target: button.dataset.folder } }).catch(showError)));
  $('#advanced-file').addEventListener('change', async (event) => {
    const name = event.currentTarget.value;
    if (!name) {
      $('#advanced-content').value = '';
      renderLocks();
      return;
    }
    try {
      const result = await api(`/advanced?name=${encodeURIComponent(name)}`);
      $('#advanced-content').value = result.content;
      renderLocks();
    } catch (error) { showError(error); }
  });
  $('#save-advanced').addEventListener('click', async () => {
    const name = $('#advanced-file').value;
    if (!name || !confirmAction(`Replace ${name}? Unknown installed-version content in your edited file will be preserved exactly.`)) return;
    try {
      await runAction(`Saving ${name}`, () => api('/advanced', {
        method: 'POST', body: { name, content: $('#advanced-content').value },
      }));
    } catch {}
  });
  $('#close-studio').addEventListener('click', async () => {
    if (state.status?.running) return toast('Server is still running', 'Save and stop it before closing the studio.', 'error');
    if (!confirmAction('Close the local ZedWatch manager? You can reopen it from the Desktop launcher.')) return;
    try {
      await api('/close', { method: 'POST' });
      document.body.innerHTML = '<main class="closed-screen"><div class="brand-mark"><span>Z</span><i></i></div><h1>ZedWatch is closed</h1><p>You can close this tab. Double-click Launch ZedWatch.bat whenever the watch resumes.</p></main>';
    } catch (error) { showError(error); }
  });
}

function showError(error) {
  toast('ZedWatch could not complete that request', error.message, 'error', 7000);
}

async function initialize() {
  bindNavigation();
  bindServerControls();
  bindAccessControls();
  bindSettingsControls();
  bindModControls();
  bindBackupControls();
  bindTools();
  try {
    state.token = (await api('/session')).token;
    await refreshAll();
    $('#loading').hidden = true;
    $('#app').classList.remove('is-loading');
    setInterval(() => {
      if (!state.busy && !document.hidden) refreshStatus().catch(() => {});
    }, 3000);
  } catch (error) {
    $('.loading-screen strong').textContent = 'ZedWatch could not connect';
    $('.loading-screen p').textContent = error.message;
    $('.loading-line').hidden = true;
  }
}

initialize();
