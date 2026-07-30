'use strict';

const DEFAULT_WATCHDOG_SETTINGS = Object.freeze({
  enabled: true,
  pollIntervalSeconds: 15,
  restartDelaySeconds: 30,
  maxRestarts: 3,
  restartWindowMinutes: 10,
});

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeWatchdogSettings(settings = {}) {
  return {
    enabled: settings.enabled !== false,
    pollIntervalSeconds: boundedInteger(settings.pollIntervalSeconds, DEFAULT_WATCHDOG_SETTINGS.pollIntervalSeconds, 5, 300),
    restartDelaySeconds: boundedInteger(settings.restartDelaySeconds, DEFAULT_WATCHDOG_SETTINGS.restartDelaySeconds, 5, 600),
    maxRestarts: boundedInteger(settings.maxRestarts, DEFAULT_WATCHDOG_SETTINGS.maxRestarts, 1, 10),
    restartWindowMinutes: boundedInteger(settings.restartWindowMinutes, DEFAULT_WATCHDOG_SETTINGS.restartWindowMinutes, 1, 60),
  };
}

class CrashWatchdog {
  constructor({
    settings,
    desiredRunning = false,
    isRunning,
    isUpdating,
    restart,
    log = () => {},
    persistDesired = () => {},
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.settings = normalizeWatchdogSettings(settings);
    this.desiredRunning = Boolean(desiredRunning);
    this.isRunning = isRunning;
    this.isUpdating = isUpdating;
    this.restart = restart;
    this.log = log;
    this.persistDesired = persistDesired;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;

    this.started = false;
    this.stopped = false;
    this.checkInFlight = false;
    this.observedRunning = null;
    this.phase = this.settings.enabled ? 'idle' : 'disabled';
    this.pendingTimer = null;
    this.pollTimer = null;
    this.nextRestartAt = null;
    this.restartHistory = [];
    this.lastCrashAt = null;
    this.lastRestartAt = null;
    this.lastError = null;
  }

  _iso(milliseconds = this.now()) {
    return new Date(milliseconds).toISOString();
  }

  _persistDesired() {
    this.persistDesired(this.desiredRunning);
  }

  _pruneHistory() {
    const cutoff = this.now() - (this.settings.restartWindowMinutes * 60 * 1000);
    this.restartHistory = this.restartHistory.filter((time) => time >= cutoff);
  }

  _cancelRecovery() {
    if (this.pendingTimer) this.clearTimeoutFn(this.pendingTimer);
    this.pendingTimer = null;
    this.nextRestartAt = null;
  }

  _resetPollTimer() {
    if (this.pollTimer) this.clearIntervalFn(this.pollTimer);
    this.pollTimer = null;
    if (!this.started || this.stopped) return;
    this.pollTimer = this.setIntervalFn(() => {
      this.tick().catch((error) => {
        this.lastError = error.message;
        this.log('error', `Crash watchdog check failed: ${error.message}`, { stack: error.stack });
      });
    }, this.settings.pollIntervalSeconds * 1000);
    this.pollTimer.unref?.();
  }

  _lockOut() {
    this._cancelRecovery();
    this.phase = 'locked';
    this.lastError = `Automatic recovery paused after ${this.settings.maxRestarts} restart attempts in ${this.settings.restartWindowMinutes} minutes.`;
    this.log('crash', this.lastError, {
      restartAttempts: this.restartHistory.length,
      restartWindowMinutes: this.settings.restartWindowMinutes,
    });
  }

  _scheduleRecovery(reason) {
    if (this.stopped || !this.settings.enabled || !this.desiredRunning) return;
    if (['waiting', 'restarting', 'starting', 'locked'].includes(this.phase)) return;
    this._pruneHistory();
    if (this.restartHistory.length >= this.settings.maxRestarts) {
      this._lockOut();
      return;
    }

    const delayMs = this.settings.restartDelaySeconds * 1000;
    this.phase = 'waiting';
    this.nextRestartAt = this._iso(this.now() + delayMs);
    this.log('watchdog', `Automatic restart scheduled in ${this.settings.restartDelaySeconds} seconds.`, {
      reason,
      nextRestartAt: this.nextRestartAt,
      attemptsInWindow: this.restartHistory.length,
      maxRestarts: this.settings.maxRestarts,
    });
    this.pendingTimer = this.setTimeoutFn(() => {
      this.pendingTimer = null;
      this.nextRestartAt = null;
      this._attemptRestart().catch((error) => {
        this.lastError = error.message;
        this.phase = 'idle';
        this.log('error', `Automatic restart failed: ${error.message}`, { stack: error.stack });
        this._scheduleRecovery('The previous automatic restart attempt failed.');
      });
    }, delayMs);
    this.pendingTimer.unref?.();
  }

  async _attemptRestart() {
    if (this.stopped || !this.settings.enabled || !this.desiredRunning) {
      this.phase = this.settings.enabled ? 'idle' : 'disabled';
      return;
    }
    if (await this.isUpdating()) {
      this.phase = 'idle';
      this._scheduleRecovery('Waiting for the server update to finish.');
      return;
    }
    if (await this.isRunning()) {
      this.observedRunning = true;
      this.phase = 'monitoring';
      return;
    }

    this._pruneHistory();
    if (this.restartHistory.length >= this.settings.maxRestarts) {
      this._lockOut();
      return;
    }

    const attemptAt = this.now();
    this.restartHistory.push(attemptAt);
    this.phase = 'restarting';
    this.lastError = null;
    this.log('watchdog', `Attempting automatic server restart (${this.restartHistory.length}/${this.settings.maxRestarts}).`, {
      attempt: this.restartHistory.length,
      maxRestarts: this.settings.maxRestarts,
    });

    let restartError = null;
    try {
      await this.restart();
    } catch (error) {
      restartError = error;
    }

    const running = await this.isRunning();
    this.observedRunning = running;
    if (running) {
      this.phase = 'monitoring';
      this.lastRestartAt = this._iso();
      this.lastError = null;
      this.log('watchdog', 'Server recovered and is running again.', {
        attempt: this.restartHistory.length,
        restartWarning: restartError?.message || null,
      });
      return;
    }

    this.phase = 'idle';
    this.lastError = restartError?.message || 'Project Zomboid was still offline after the restart attempt.';
    this.log('error', `Automatic restart did not recover the server: ${this.lastError}`, {
      attempt: this.restartHistory.length,
    });
    this._scheduleRecovery('The previous automatic restart attempt did not recover the server.');
  }

  async start({ adoptRunning = true } = {}) {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    const running = await this.isRunning();
    this.observedRunning = running;
    if (running && adoptRunning && !this.desiredRunning) {
      this.desiredRunning = true;
      this._persistDesired();
      this.log('watchdog', 'Crash recovery adopted the already-running Project Zomboid server.');
    }
    if (!this.settings.enabled) this.phase = 'disabled';
    else if (running && this.desiredRunning) this.phase = 'monitoring';
    else this.phase = 'idle';
    this._resetPollTimer();
    if (!running && this.desiredRunning && this.settings.enabled) {
      this._scheduleRecovery('Project Zomboid was expected to be online when ZedWatch started.');
    }
  }

  stop() {
    this.stopped = true;
    this._cancelRecovery();
    if (this.pollTimer) this.clearIntervalFn(this.pollTimer);
    this.pollTimer = null;
  }

  manualStartRequested() {
    this.desiredRunning = true;
    this._persistDesired();
    this.restartHistory = [];
    this.lastError = null;
    this._cancelRecovery();
    this.phase = 'starting';
  }

  noteStartSucceeded() {
    this.observedRunning = true;
    this.phase = this.settings.enabled ? 'monitoring' : 'disabled';
  }

  noteStartFailed(error) {
    this.observedRunning = false;
    this.lastError = error?.message || String(error);
    this.phase = this.settings.enabled ? 'idle' : 'disabled';
    this._scheduleRecovery('The manual server start did not stay online.');
  }

  intentionalStopRequested(reason = 'intentional stop') {
    this.desiredRunning = false;
    this._persistDesired();
    this.restartHistory = [];
    this.lastError = null;
    this._cancelRecovery();
    this.phase = this.settings.enabled ? 'idle' : 'disabled';
    this.log('watchdog', 'Automatic recovery disarmed for an intentional server stop.', { reason });
  }

  noteServerStopped() {
    this.observedRunning = false;
    this.phase = this.settings.enabled ? 'idle' : 'disabled';
  }

  async tick() {
    if (this.stopped || this.checkInFlight) return;
    this.checkInFlight = true;
    try {
      const [running, updating] = await Promise.all([this.isRunning(), this.isUpdating()]);
      const wasRunning = this.observedRunning;
      this.observedRunning = running;

      if (running) {
        this._cancelRecovery();
        this.phase = this.settings.enabled && this.desiredRunning ? 'monitoring' : (this.settings.enabled ? 'idle' : 'disabled');
        return;
      }

      if (wasRunning && this.desiredRunning && this.settings.enabled && !updating) {
        this.lastCrashAt = this._iso();
        this.lastError = null;
        this.phase = 'idle';
        this.log('crash', 'Project Zomboid stopped unexpectedly; crash recovery was triggered.', {
          detectedAt: this.lastCrashAt,
        });
        this._scheduleRecovery('The Project Zomboid server process exited unexpectedly.');
        return;
      }

      if (!this.settings.enabled) this.phase = 'disabled';
      else if (!this.desiredRunning) this.phase = 'idle';
      else if (updating) this.phase = 'idle';
      else if (!['waiting', 'restarting', 'starting', 'locked'].includes(this.phase)) {
        this._scheduleRecovery('Project Zomboid is offline but is expected to be online.');
      }
    } finally {
      this.checkInFlight = false;
    }
  }

  updateSettings(settings) {
    this.settings = normalizeWatchdogSettings(settings);
    this._cancelRecovery();
    this._resetPollTimer();
    if (!this.settings.enabled) this.phase = 'disabled';
    else if (this.observedRunning && this.desiredRunning) this.phase = 'monitoring';
    else {
      this.phase = 'idle';
      if (this.desiredRunning) this._scheduleRecovery('Crash recovery was enabled while Project Zomboid was expected online.');
    }
    return this.settings;
  }

  getStatus() {
    this._pruneHistory();
    return {
      ...this.settings,
      desiredRunning: this.desiredRunning,
      phase: this.phase,
      nextRestartAt: this.nextRestartAt,
      attemptsInWindow: this.restartHistory.length,
      lastCrashAt: this.lastCrashAt,
      lastRestartAt: this.lastRestartAt,
      lastError: this.lastError,
    };
  }
}

module.exports = {
  CrashWatchdog,
  DEFAULT_WATCHDOG_SETTINGS,
  normalizeWatchdogSettings,
};
