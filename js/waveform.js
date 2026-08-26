const ALLOWED_CONTROL_CYCLES = new Set([10, 20, 50, 100]);

export function validateExperimentConfig(input, deviceLimits = {}) {
  const voltageMax = Number(input.voltageMax);
  const currentMax = Number(input.currentMax);
  const controlCycleMs = Number(input.controlCycleMs);
  const pythonSource = String(input.pythonSource ?? "").trim();

  for (const [value, label] of [
    [voltageMax, "Vmax"],
    [currentMax, "Amax"],
    [controlCycleMs, "Control Cycle"],
  ]) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label}を入力してください。`);
    }
  }

  const reportedVoltageLimit = Number(deviceLimits.maxVoltage);
  const deviceMaxVoltage = Number.isFinite(reportedVoltageLimit) && reportedVoltageLimit > 0
    ? reportedVoltageLimit
    : 24.0;
  const reportedCurrentLimit = Number(deviceLimits.maxCurrent);
  const deviceMaxCurrent = Number.isFinite(reportedCurrentLimit) && reportedCurrentLimit > 0
    ? Math.min(reportedCurrentLimit, 5.1)
    : 5.0;

  if (voltageMax <= 0 || voltageMax > deviceMaxVoltage) {
    throw new RangeError(`Vmaxは0より大きく${deviceMaxVoltage.toFixed(2)} V以下にしてください。`);
  }
  if (currentMax <= 0 || currentMax > deviceMaxCurrent) {
    throw new RangeError(`Amaxは0より大きく${deviceMaxCurrent.toFixed(2)} A以下にしてください。`);
  }
  if (!ALLOWED_CONTROL_CYCLES.has(controlCycleMs)) {
    throw new RangeError("Control Cycleは10、20、50、100 msから選択してください。");
  }
  if (!pythonSource) {
    throw new RangeError("Python制御コードを入力してください。");
  }

  return Object.freeze({
    voltageMax,
    currentMax,
    controlCycleMs,
    deviceMaxVoltage,
    deviceMaxCurrent,
    pythonSource,
  });
}

export function formatDuration(totalSeconds) {
  const safeSeconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}
