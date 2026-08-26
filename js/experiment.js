const TELEMETRY_STALE_MS = 3_000;
const HIGH_SPEED_MEASUREMENT_INTERVAL_MS = 50;

function now() {
  return performance.now();
}

export class ExperimentStoppedError extends Error {
  constructor(message = "Experiment stopped by user.") {
    super(message);
    this.name = "ExperimentStoppedError";
  }
}

export class ExperimentController extends EventTarget {
  constructor(device, logger, pythonControl) {
    super();
    this.device = device;
    this.logger = logger;
    this.pythonControl = pythonControl;
    this.running = false;
    this.stopRequested = false;
    this.fatalError = null;
    this.stopReason = "";
    this.startedAt = 0;
    this.emergencyOffPromise = null;
    this.releaseDelay = null;
    this.releaseMeasurementDelay = null;
    this.measurementPolling = false;
    this.measurementPollTask = null;
    this.lastEmittedMeasurementSequence = null;
    this.activeRun = null;
    this.lastCommandCurrent = null;
    this.wakeLock = null;

    device.addEventListener("disconnect", (event) => {
      if (this.running && !event.detail?.expected) {
        this.abort(event.detail?.error ?? new Error("USB接続が切断されました。"));
      }
    });
    device.addEventListener("error", (event) => {
      if (this.running) this.abort(event.detail?.error ?? new Error("通信エラーが発生しました。"));
    });
    device.addEventListener("telemetry", (event) => {
      const protection = event.detail?.state?.protectionState;
      if (this.running && protection) {
        this.abort(new Error(`DPS-150保護状態を検出しました: ${protection}`));
      }
      if (this.running && Number.isFinite(event.detail?.update?.measuredVoltage)) {
        this.captureMeasurement(event.detail.state);
      }
    });
  }

  async start(config) {
    if (this.running) throw new Error("実験はすでに実行中です。");
    if (!this.device.connected) throw new Error("DPS-150が接続されていません。");
    if (!this.pythonControl) throw new Error("ブラウザ内Python制御を利用できません。");

    this.running = true;
    this.stopRequested = false;
    this.fatalError = null;
    this.stopReason = "";
    this.emergencyOffPromise = null;
    this.lastEmittedMeasurementSequence = null;
    this.activeRun = null;
    this.lastCommandCurrent = null;
    this.startedAt = now();
    this.logger.clear();
    await this.acquireWakeLock();
    this.emit("started", { config });

    let iterations = 0;
    try {
      this.emit("pythonstatus", { state: "loading" });
      const runtime = await this.runPythonOperation(() => this.pythonControl.prepare(config.pythonSource));
      this.throwIfStopped();
      await this.runPythonOperation(() => this.pythonControl.begin({
        Vmax: config.voltageMax,
        Amax: config.currentMax,
      }));
      this.throwIfStopped();
      this.emit("pythonstatus", { state: "ready", version: runtime.version });

      let i = 0;
      let command = await this.calculateCommand(config);
      this.throwIfStopped();
      if (command.done) {
        await this.device.outputOff();
        const elapsedSeconds = (now() - this.startedAt) / 1_000;
        this.emit("completed", { elapsedSeconds, iterations, recordCount: this.logger.size });
        return { status: "completed", elapsedSeconds, iterations };
      }

      this.assertSafeCommand(command, config);
      await this.device.setCurrent(command.current);
      this.lastCommandCurrent = command.current;
      this.throwIfStopped();
      await this.waitUntil(now() + 60);
      this.throwIfStopped();
      await this.device.setVoltage(command.voltage);
      this.throwIfStopped();
      await this.waitUntil(now() + 60);
      this.throwIfStopped();
      await this.device.outputOn();
      this.throwIfStopped();

      this.activeRun = {
        i,
        voltageMax: config.voltageMax,
        currentMax: config.currentMax,
        controlCycleMs: config.controlCycleMs,
        commandVoltage: command.voltage,
        commandCurrent: command.current,
      };
      this.emit("segment", { config });
      this.startMeasurementPolling();
      this.recordCommand(config, i, command);
      iterations = 1;

      let nextTickAt = now() + config.controlCycleMs;
      i = 1;
      while (true) {
        await this.waitUntil(nextTickAt);
        this.throwIfStopped();

        command = await this.calculateCommand(config);
        this.throwIfStopped();
        if (command.done) break;

        this.assertSafeCommand(command, config);
        if (
          !Number.isFinite(this.lastCommandCurrent)
          || Math.abs(command.current - this.lastCommandCurrent) >= 0.0005
        ) {
          await this.device.setCurrent(command.current);
          this.lastCommandCurrent = command.current;
          this.throwIfStopped();
        }
        await this.device.setVoltage(command.voltage);
        this.throwIfStopped();

        this.activeRun = {
          ...this.activeRun,
          i,
          commandVoltage: command.voltage,
          commandCurrent: this.lastCommandCurrent,
        };
        this.recordCommand(config, i, command);
        iterations += 1;
        i += 1;

        nextTickAt += config.controlCycleMs;
        if (nextTickAt < now()) nextTickAt = now() + config.controlCycleMs;
      }

      await this.stopMeasurementPolling();
      await this.device.outputOff();
      const elapsedSeconds = (now() - this.startedAt) / 1_000;
      this.emit("completed", {
        elapsedSeconds,
        iterations,
        recordCount: this.logger.size,
      });
      return { status: "completed", elapsedSeconds, iterations };
    } catch (error) {
      if (error instanceof ExperimentStoppedError && !this.fatalError) {
        try {
          await (this.emergencyOffPromise ?? this.device.outputOff());
        } catch (outputError) {
          this.fatalError ??= outputError;
        }
        if (this.fatalError) {
          this.emit("error", {
            error: this.fatalError,
            elapsedSeconds: (now() - this.startedAt) / 1_000,
            recordCount: this.logger.size,
          });
          throw this.fatalError;
        }
        const elapsedSeconds = (now() - this.startedAt) / 1_000;
        this.emit("stopped", {
          elapsedSeconds,
          reason: this.stopReason || "ユーザーが停止しました。",
          recordCount: this.logger.size,
        });
        return { status: "stopped", elapsedSeconds, iterations };
      }

      const failure = this.fatalError ?? error;
      this.emit("error", {
        error: failure,
        elapsedSeconds: (now() - this.startedAt) / 1_000,
        recordCount: this.logger.size,
      });
      throw failure;
    } finally {
      await this.stopMeasurementPolling();
      try {
        await (this.emergencyOffPromise ?? this.device.outputOff());
      } catch {
        // USB removal can make OUTPUT OFF impossible; the UI reports the original error.
      }
      this.running = false;
      this.stopRequested = false;
      this.activeRun = null;
      this.lastCommandCurrent = null;
      this.releaseDelay?.();
      this.releaseDelay = null;
      this.pythonControl?.terminate();
      await this.releaseWakeLock();
    }
  }

  stop(reason = "ユーザーがSTOPを押しました。") {
    if (!this.running) return Promise.resolve();
    this.stopRequested = true;
    this.stopReason = reason;
    this.releaseDelay?.();
    this.measurementPolling = false;
    this.releaseMeasurementDelay?.();
    this.pythonControl?.terminate(new Error("STOPによりPython制御を終了しました。"));
    this.emergencyOffPromise ??= this.device.outputOff().catch((error) => {
      this.fatalError ??= error;
      throw error;
    });
    return this.emergencyOffPromise;
  }

  abort(error) {
    if (!this.running || this.fatalError) return;
    this.fatalError = error instanceof Error ? error : new Error(String(error));
    this.stopRequested = true;
    this.stopReason = this.fatalError.message;
    this.releaseDelay?.();
    this.measurementPolling = false;
    this.releaseMeasurementDelay?.();
    this.pythonControl?.terminate(this.fatalError);
    this.emergencyOffPromise ??= this.device.outputOff().catch(() => undefined);
  }

  throwIfStopped() {
    if (this.fatalError) throw this.fatalError;
    if (this.stopRequested) throw new ExperimentStoppedError(this.stopReason);
  }

  assertSafeCommand(command, config) {
    if (
      !Number.isFinite(command.voltage)
      || command.voltage < 0
      || command.voltage > config.voltageMax
      || command.voltage > config.deviceMaxVoltage
    ) {
      throw new Error(
        `安全範囲外の電圧値を検出しました: ${command.voltage}（Vmax ${config.voltageMax.toFixed(3)} V）`,
      );
    }
    if (
      !Number.isFinite(command.current)
      || command.current <= 0
      || command.current > config.currentMax
      || command.current > config.deviceMaxCurrent
    ) {
      throw new Error(
        `安全範囲外の電流値を検出しました: ${command.current}（Amax ${config.currentMax.toFixed(3)} A）`,
      );
    }
  }

  calculateCommand(config) {
    return this.runPythonOperation(() => this.pythonControl.evaluate({
      maxVoltage: Math.min(config.voltageMax, config.deviceMaxVoltage),
      maxCurrent: Math.min(config.currentMax, config.deviceMaxCurrent),
    }));
  }

  async runPythonOperation(operation) {
    try {
      return await operation();
    } catch (error) {
      if (this.stopRequested && !this.fatalError) {
        throw new ExperimentStoppedError(this.stopReason);
      }
      throw error;
    }
  }

  recordCommand(config, i, command) {
    const telemetry = this.device.getState();
    if (telemetry.protectionState) {
      throw new Error(`DPS-150保護状態を検出しました: ${telemetry.protectionState}`);
    }
    if (Number.isFinite(telemetry.measurementAgeMs) && telemetry.measurementAgeMs > TELEMETRY_STALE_MS) {
      throw new Error("DPS-150のテレメトリ応答がタイムアウトしました。");
    }

    const elapsedSeconds = (now() - this.startedAt) / 1_000;
    const sample = {
      recordType: "command",
      elapsedSeconds,
      i,
      voltageMax: config.voltageMax,
      currentMax: config.currentMax,
      controlCycleMs: config.controlCycleMs,
      commandVoltage: command.voltage,
      commandCurrent: command.current,
      measuredVoltage: null,
      measuredCurrent: null,
      measuredPower: null,
      mode: telemetry.mode,
      protectionState: telemetry.protectionState,
      outputEnabled: telemetry.outputEnabled,
      measurementSequence: null,
      measurementElapsedSeconds: null,
    };
    this.logger.add(sample);
    this.emit("progress", sample);
  }

  waitUntil(deadline) {
    const delay = Math.max(0, deadline - now());
    if (delay === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.releaseDelay === finish) this.releaseDelay = null;
        resolve();
      };
      const timer = setTimeout(finish, delay);
      this.releaseDelay = finish;
    });
  }

  captureMeasurement(state) {
    const context = this.activeRun;
    if (!context || !Number.isFinite(state.measurementSequence)) return;
    if (state.measurementSequence === this.lastEmittedMeasurementSequence) return;
    this.lastEmittedMeasurementSequence = state.measurementSequence;

    const receivedAt = Number.isFinite(state.measurementReceivedAtMs)
      ? state.measurementReceivedAtMs
      : now();
    const elapsedSeconds = Math.max(0, (receivedAt - this.startedAt) / 1_000);
    const sample = {
      recordType: "measurement",
      elapsedSeconds,
      measurementElapsedSeconds: elapsedSeconds,
      i: context.i,
      voltageMax: context.voltageMax,
      currentMax: context.currentMax,
      controlCycleMs: context.controlCycleMs,
      commandVoltage: context.commandVoltage,
      commandCurrent: context.commandCurrent,
      measuredVoltage: state.measuredVoltage,
      measuredCurrent: state.measuredCurrent,
      measuredPower: state.measuredPower,
      mode: state.mode,
      protectionState: state.protectionState,
      outputEnabled: state.outputEnabled,
      measurementSequence: state.measurementSequence,
    };
    this.logger.add(sample);
    this.emit("measurement", sample);
  }

  startMeasurementPolling(intervalMs = HIGH_SPEED_MEASUREMENT_INTERVAL_MS) {
    if (this.measurementPollTask) return;
    this.measurementPolling = true;
    this.measurementPollTask = this.runMeasurementPolling(intervalMs)
      .catch((error) => {
        if (this.running && this.measurementPolling) this.abort(error);
      })
      .finally(() => {
        this.measurementPollTask = null;
      });
  }

  async stopMeasurementPolling() {
    this.measurementPolling = false;
    this.releaseMeasurementDelay?.();
    await this.measurementPollTask;
  }

  async runMeasurementPolling(intervalMs) {
    let nextPollAt = now() + intervalMs;
    while (this.measurementPolling && this.device.connected) {
      await this.waitForMeasurementPoll(nextPollAt);
      if (!this.measurementPolling || !this.device.connected) break;
      await this.device.requestMeasurements();
      nextPollAt += intervalMs;
      if (nextPollAt < now()) nextPollAt = now() + intervalMs;
    }
  }

  waitForMeasurementPoll(deadline) {
    const delay = Math.max(0, deadline - now());
    if (delay === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.releaseMeasurementDelay === finish) this.releaseMeasurementDelay = null;
        resolve();
      };
      const timer = setTimeout(finish, delay);
      this.releaseMeasurementDelay = finish;
    });
  }

  async acquireWakeLock() {
    if (this.wakeLock && !this.wakeLock.released) return;
    if (!globalThis.navigator?.wakeLock?.request) return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      this.wakeLock = null;
    }
  }

  async releaseWakeLock() {
    try {
      await this.wakeLock?.release();
    } catch {
      // Wake Lock release is best-effort.
    }
    this.wakeLock = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
