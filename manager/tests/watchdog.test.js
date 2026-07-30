'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CrashWatchdog, normalizeWatchdogSettings } = require('../lib/watchdog');

function harness({ running = true, desiredRunning = false, settings = {} } = {}) {
  let now = Date.parse('2026-07-10T12:00:00.000Z');
  let updating = false;
  let restartCount = 0;
  const logs = [];
  const persisted = [];
  const timeouts = new Map();
  let nextTimer = 1;
  const watchdog = new CrashWatchdog({
    settings: { ...normalizeWatchdogSettings(), ...settings },
    desiredRunning,
    isRunning: async () => running,
    isUpdating: async () => updating,
    restart: async () => { restartCount += 1; running = true; },
    log: (type, message, details) => logs.push({ type, message, details }),
    persistDesired: (value) => persisted.push(value),
    now: () => now,
    setTimeoutFn: (callback) => { const id = nextTimer++; timeouts.set(id, callback); return id; },
    clearTimeoutFn: (id) => timeouts.delete(id),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  return {
    watchdog,
    logs,
    persisted,
    get running() { return running; },
    set running(value) { running = value; },
    set updating(value) { updating = value; },
    get restartCount() { return restartCount; },
    advance(milliseconds) { now += milliseconds; },
    async runNextTimeout() {
      const entry = timeouts.entries().next().value;
      assert.ok(entry, 'a recovery timer should be scheduled');
      timeouts.delete(entry[0]);
      await entry[1]();
      await new Promise((resolve) => setImmediate(resolve));
    },
    get timeoutCount() { return timeouts.size; },
  };
}

test('normalizes watchdog settings into safe operating bounds', () => {
  assert.deepEqual(normalizeWatchdogSettings({
    enabled: false,
    pollIntervalSeconds: 1,
    restartDelaySeconds: 9999,
    maxRestarts: 0,
    restartWindowMinutes: 90,
  }), {
    enabled: false,
    pollIntervalSeconds: 5,
    restartDelaySeconds: 600,
    maxRestarts: 1,
    restartWindowMinutes: 60,
  });
});

test('adopts a running server, detects a crash, and recovers it', async () => {
  const h = harness();
  await h.watchdog.start();
  assert.equal(h.watchdog.getStatus().desiredRunning, true);
  assert.deepEqual(h.persisted, [true]);

  h.running = false;
  await h.watchdog.tick();
  assert.equal(h.watchdog.getStatus().phase, 'waiting');
  assert.equal(h.timeoutCount, 1);
  assert.ok(h.logs.some((entry) => entry.type === 'crash' && /unexpectedly/.test(entry.message)));

  await h.runNextTimeout();
  assert.equal(h.restartCount, 1);
  assert.equal(h.running, true);
  assert.equal(h.watchdog.getStatus().phase, 'monitoring');
  assert.ok(h.logs.some((entry) => /recovered/.test(entry.message)));
});

test('intentional stop cancels a pending recovery', async () => {
  const h = harness();
  await h.watchdog.start();
  h.running = false;
  await h.watchdog.tick();
  assert.equal(h.timeoutCount, 1);

  h.watchdog.intentionalStopRequested('test stop');
  assert.equal(h.timeoutCount, 0);
  assert.equal(h.watchdog.getStatus().desiredRunning, false);
  await h.watchdog.tick();
  assert.equal(h.restartCount, 0);
});

test('locks automatic recovery after the configured restart limit', async () => {
  const h = harness({ settings: { maxRestarts: 3, restartWindowMinutes: 10 } });
  await h.watchdog.start();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    h.running = false;
    await h.watchdog.tick();
    await h.runNextTimeout();
    h.advance(30_000);
  }
  h.running = false;
  await h.watchdog.tick();

  assert.equal(h.restartCount, 3);
  assert.equal(h.watchdog.getStatus().phase, 'locked');
  assert.equal(h.timeoutCount, 0);
  assert.match(h.watchdog.getStatus().lastError, /paused after 3 restart attempts/);
});

test('manual start clears a lockout and disarms on maintenance', async () => {
  const h = harness({ running: false, desiredRunning: true, settings: { maxRestarts: 1 } });
  await h.watchdog.start({ adoptRunning: false });
  await h.runNextTimeout();
  h.running = false;
  await h.watchdog.tick();
  assert.equal(h.watchdog.getStatus().phase, 'locked');

  h.watchdog.manualStartRequested();
  assert.equal(h.watchdog.getStatus().attemptsInWindow, 0);
  assert.equal(h.watchdog.getStatus().phase, 'starting');
  h.watchdog.intentionalStopRequested('server update');
  assert.equal(h.watchdog.getStatus().desiredRunning, false);
});
