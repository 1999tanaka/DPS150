import { calculateVoltage } from "./waveform.js?v=20260825.7";

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
  constructor(device, logger) {
    super();
    this.device = device;
    this.logger = logger;
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
    this.activeSegment = null;
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

    this.running = true;
    this.stopRequested = false;
    this.fatalError = null;
    this.stopReason = "";
    this.emergencyOffPromise = null;
    this.lastEmittedMeasurementSequence = null;
    this.activeSegment = null;
    this.startedAt = now();
    this.logger.clear();
    await this.acquireWakeLock();
    this.emit("started", { config });

    let completedPlannedSeconds = 0;
    try {
      await this.device.setCurrent(config.currentLimit);
      this.throwIfStopped();
      await this.waitUntil(now() + 60);
      this.throwIfStopped();

      const firstVoltage = calculateVoltage(config.aValues[0], config.periods[0], 0);
      this.assertSafeVoltage(firstVoltage, config.deviceMaxVoltage);
      await this.device.setVoltage(firstVoltage);
      this.throwIfStopped();
      await this.waitUntil(now() + 60);
      this.throwIfStopped();
      await this.device.outputOn();
      this.throwIfStopped();
      this.startMeasurementPolling();

      for (let aIndex = 0; aIndex < config.aValues.length; aIndex += 1) {
        const A = config.aValues[aIndex];
        for (const T of config.periods) {
          this.throwIfStopped();
          const segmentDuration = T * config.cycles;
          const segmentStart = now();
          this.activeSegment = {
            A,
            T,
            aIndex,
            aCount: config.aValues.length,
            cycles: config.cycles,
            currentLimit: config.currentLimit,
            segmentStart,
          };
          this.emit("segment", { A, T, aIndex, config });

          while (true) {
            this.throwIfStopped();
            const tickStartedAt = now();
            const segmentElapsed = (tickStartedAt - segmentStart) / 1_000;
            if (segmentElapsed >= segmentDuration) break;

            const cycle = Math.min(config.cycles, Math.floor(segmentElapsed / T) + 1);
            const commandVoltage = calculateVoltage(A, T, segmentElapsed);
            this.assertSafeVoltage(commandVoltage, config.deviceMaxVoltage);
            await this.device.setVoltage(commandVoltage);
            this.throwIfStopped();

            const telemetry = this.device.getState();
            if (telemetry.protectionState) {
              throw new Error(`DPS-150保護状態を検出しました: ${telemetry.protectionState}`);
            }
            if (telemetry.measurementAgeMs > TELEMETRY_STALE_MS) {
              throw new Error("DPS-150のテレメトリ応答がタイムアウトしました。");
            }

            const tickCompletedAt = now();
            const elapsedSeconds = (tickCompletedAt - this.startedAt) / 1_000;
            const liveSegmentElapsed = Math.min((tickCompletedAt - segmentStart) / 1_000, segmentDuration);
            const plannedElapsed = completedPlannedSeconds + liveSegmentElapsed;
            const progress = Math.min(1, plannedElapsed / config.totalDuration);
            const remainingSeconds = progress > 0.002
              ? Math.max(0, elapsedSeconds / progress - elapsedSeconds)
              : Math.max(0, config.totalDuration - plannedElapsed);

            const sample = {
              recordType: "command",
              elapsedSeconds,
              plannedElapsed,
              progress,
              remainingSeconds,
              A,
              T,
              cycle,
              aIndex,
              aCount: config.aValues.length,
              commandVoltage,
              commandCurrent: config.currentLimit,
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

            const timeSinceSegmentStart = now() - segmentStart;
            const nextTickIndex = Math.floor(timeSinceSegmentStart / config.updateInterval) + 1;
            const nextTickAt = segmentStart + nextTickIndex * config.updateInterval;
            await this.waitUntil(nextTickAt);
          }

          completedPlannedSeconds += segmentDuration;
        }
      }

      await this.stopMeasurementPolling();
      await this.device.outputOff();
      const elapsedSeconds = (now() - this.startedAt) / 1_000;
      this.emit("completed", {
        elapsedSeconds,
        progress: 1,
        remainingSeconds: 0,
        recordCount: this.logger.size,
      });
      return { status: "completed", elapsedSeconds };
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
        return { status: "stopped", elapsedSeconds };
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
        // The UI reports the original communication error; USB removal can make OFF impossible.
      }
      this.running = false;
      this.stopRequested = false;
      this.activeSegment = null;
      this.releaseDelay?.();
      this.releaseDelay = null;
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
    this.emergencyOffPromise ??= this.device.outputOff().catch(() => undefined);
  }

  throwIfStopped() {
    if (this.fatalError) throw this.fatalError;
    if (this.stopRequested) throw new ExperimentStoppedError(this.stopReason);
  }

  assertSafeVoltage(voltage, deviceMaxVoltage) {
    if (!Number.isFinite(voltage) || voltage < 0 || voltage > deviceMaxVoltage) {
      throw new Error(`安全範囲外の電圧値を検出しました: ${voltage}`);
    }
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
    const context = this.activeSegment;
    if (!context || !Number.isFinite(state.measurementSequence)) return;
    if (state.measurementSequence === this.lastEmittedMeasurementSequence) return;
    this.lastEmittedMeasurementSequence = state.measurementSequence;

    const receivedAt = Number.isFinite(state.measurementReceivedAtMs)
      ? state.measurementReceivedAtMs
      : now();
    const elapsedSeconds = Math.max(0, (receivedAt - this.startedAt) / 1_000);
    const segmentElapsed = Math.max(0, (receivedAt - context.segmentStart) / 1_000);
    const cycle = Math.min(context.cycles, Math.floor(segmentElapsed / context.T) + 1);
    const sample = {
      recordType: "measurement",
      elapsedSeconds,
      measurementElapsedSeconds: elapsedSeconds,
      A: context.A,
      T: context.T,
      cycle,
      aIndex: context.aIndex,
      aCount: context.aCount,
      commandVoltage: state.setVoltage,
      commandCurrent: context.currentLimit,
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
    if (!navigator.wakeLock?.request) return;
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
