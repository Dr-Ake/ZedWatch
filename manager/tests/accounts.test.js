'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  discoverAuthenticatedAccounts,
  parseLogTimestamp,
  reconcileAccountLedger,
} = require('../lib/accounts');

function logLine({ at, event, username, steamId = '76561198000000000' }) {
  return `[${at}] event="${event}" message="" guid="1" ip="203.0.113.8" steam-id="${steamId}" role="user" username="${username}" connection-type="Steam".`;
}

test('discovers successful player accounts from current and archived connection logs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zedwatch-accounts-'));
  const archive = path.join(root, 'logs_2026-07-29');
  fs.mkdirSync(archive);
  fs.writeFileSync(path.join(archive, '2026-07-29_20-00_connections.txt'), [
    logLine({ at: '29-07-26 20:01:00.000', event: 'client-connect', username: 'Ignored' }),
    logLine({ at: '29-07-26 20:02:00.000', event: 'fully-connected', username: 'Drake' }),
  ].join('\n'));
  fs.writeFileSync(path.join(root, '2026-07-29_21-00_connections.txt'), [
    logLine({ at: '29-07-26 21:10:00.000', event: 'fully-connected', username: 'Drake' }),
    logLine({ at: '29-07-26 21:11:00.000', event: 'fully-connected', username: 'Rose', steamId: '76561198000000001' }),
    logLine({ at: '29-07-26 21:12:00.000', event: 'fully-connected', username: 'admin' }),
  ].join('\n'));

  const accounts = discoverAuthenticatedAccounts(root);
  assert.deepEqual(accounts.map((entry) => entry.username), ['Drake', 'Rose']);
  assert.equal(accounts[0].lastSeenAt, parseLogTimestamp('[29-07-26 21:10:00.000]'));
  assert.equal(accounts[1].steamId, '76561198000000001');
});

test('reconciles new accounts without resurrecting removed historical entries', () => {
  const joinedAt = '2026-07-29T21:10:00.000Z';
  const removalAt = '2026-07-29T22:00:00.000Z';
  const initial = [{
    username: 'Drake',
    enabled: false,
    removed: true,
    removedAt: removalAt,
    source: 'game',
  }];

  const historical = reconcileAccountLedger(initial, [{ username: 'Drake', lastSeenAt: joinedAt }]);
  assert.equal(historical.changed, false);
  assert.equal(historical.ledger[0].removed, true);

  const rejoined = reconcileAccountLedger(initial, [{
    username: 'Drake',
    lastSeenAt: '2026-07-29T23:00:00.000Z',
    steamId: '76561198000000000',
  }]);
  assert.equal(rejoined.ledger[0].removed, undefined);
  assert.equal(rejoined.ledger[0].enabled, true);
  assert.deepEqual(rejoined.restored, ['Drake']);

  const added = reconcileAccountLedger([], [{ username: 'Rose', lastSeenAt: joinedAt }]);
  assert.deepEqual(added.added, ['Rose']);
  assert.equal(added.ledger[0].source, 'game');
});
