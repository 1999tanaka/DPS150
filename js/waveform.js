const MAX_SEQUENCE_STEPS = 10_000;
const ALLOWED_UPDATE_INTERVALS = new Set([10, 20, 50, 100]);

function assertFiniteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
}

function decimalPlaces(value) {
  const text = String(value).toLowerCase();
  if (text.includes("e-")) {
    const [coefficient, exponentText] = text.split("e-");
    const exponent = Number(exponentText);
    const decimals = coefficient.includes(".") ? coefficient.split(".")[1].length : 0;
    return exponent + decimals;
  }
  return text.includes(".") ? text.split(".")[1].length : 0;
}

export function calculateVoltage(A, T, t) {
  assertFiniteNumber(A, "A");
  assertFiniteNumber(T, "T");
  assertFiniteNumber(t, "t");
  if (T <= 0) {
    throw new RangeError("T must be greater than zero.");
  }

  return (
    (7 + A / 2)
    + (7 - A / 2) * Math.sin((2 * Math.PI * t) / T)
  );
}

export function calculateVoltageRange(A) {
  assertFiniteNumber(A, "A");
  const center = 7 + A / 2;
  const amplitude = Math.abs(7 - A / 2);
  return {
    min: center - amplitude,
    max: center + amplitude,
  };
}

export function buildAValues(start, end, step) {
  assertFiniteNumber(start, "A start");
  assertFiniteNumber(end, "A end");
  assertFiniteNumber(step, "A step");

  if (start > end) {
    throw new RangeError("A StartはA End以下にしてください。");
  }
  if (step <= 0) {
    throw new RangeError("A Stepは0より大きい値にしてください。");
  }

  const precision = Math.min(6, Math.max(
    decimalPlaces(start),
    decimalPlaces(end),
    decimalPlaces(step),
  ));
  const scale = 10 ** precision;
  const startInt = Math.round(start * scale);
  const endInt = Math.round(end * scale);
  const stepInt = Math.round(step * scale);

  if (stepInt <= 0) {
    throw new RangeError("A Stepが小さすぎます。");
  }

  const count = Math.floor((endInt - startInt) / stepInt) + 1;
  if (count > MAX_SEQUENCE_STEPS) {
    throw new RangeError(`A条件は${MAX_SEQUENCE_STEPS.toLocaleString()}件以下にしてください。`);
  }

  return Array.from({ length: count }, (_, index) => (
    (startInt + index * stepInt) / scale
  ));
}

export function calculateTotalDuration(aValues, periods, cycles) {
  if (!Array.isArray(aValues) || !Array.isArray(periods)) {
    throw new TypeError("A values and periods must be arrays.");
  }
  assertFiniteNumber(cycles, "Cycles");
  return aValues.length * periods.reduce((sum, period) => sum + period * cycles, 0);
}

export function validateExperimentConfig(input, deviceLimits = {}) {
  const aStart = Number(input.aStart);
  const aEnd = Number(input.aEnd);
  const aStep = Number(input.aStep);
  const currentLimit = Number(input.currentLimit);
  const cycles = Number(input.cycles);
  const updateInterval = Number(input.updateInterval);
  const periods = [...new Set((input.periods ?? []).map(Number))].sort((a, b) => a - b);

  for (const [value, label] of [
    [aStart, "A Start"],
    [aEnd, "A End"],
    [aStep, "A Step"],
    [currentLimit, "Current Limit"],
    [cycles, "Cycles"],
    [updateInterval, "Update Interval"],
  ]) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label}を入力してください。`);
    }
  }

  if (aStart < 2 || aStart > 14 || aEnd < 2 || aEnd > 14) {
    throw new RangeError("Version 1.0ではAを2.0～14.0の範囲で設定してください。");
  }
  if (aStart > aEnd) {
    throw new RangeError("A StartはA End以下にしてください。");
  }
  if (aStep <= 0) {
    throw new RangeError("A Stepは0より大きい値にしてください。");
  }
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 99) {
    throw new RangeError("Cyclesは1～99の整数にしてください。");
  }
  if (!ALLOWED_UPDATE_INTERVALS.has(updateInterval)) {
    throw new RangeError("Update Intervalは10、20、50、100 msから選択してください。");
  }
  if (periods.length === 0 || periods.some((period) => !Number.isFinite(period) || period <= 0)) {
    throw new RangeError("Periodを1つ以上選択してください。");
  }

  const reportedCurrentLimit = Number(deviceLimits.maxCurrent);
  const deviceMaxCurrent = Number.isFinite(reportedCurrentLimit) && reportedCurrentLimit > 0
    ? Math.min(reportedCurrentLimit, 5.1)
    : 5.0;
  if (currentLimit <= 0 || currentLimit > deviceMaxCurrent) {
    throw new RangeError(`Current Limitは0より大きく${deviceMaxCurrent.toFixed(2)} A以下にしてください。`);
  }

  const aValues = buildAValues(aStart, aEnd, aStep);
  const reportedVoltageLimit = Number(deviceLimits.maxVoltage);
  const deviceMaxVoltage = Number.isFinite(reportedVoltageLimit) && reportedVoltageLimit > 0
    ? reportedVoltageLimit
    : 24.0;

  let waveformMin = Number.POSITIVE_INFINITY;
  let waveformMax = Number.NEGATIVE_INFINITY;
  for (const A of aValues) {
    const range = calculateVoltageRange(A);
    waveformMin = Math.min(waveformMin, range.min);
    waveformMax = Math.max(waveformMax, range.max);
  }

  if (waveformMin < 0 || waveformMax > deviceMaxVoltage) {
    throw new RangeError(
      `計算電圧${waveformMin.toFixed(2)}～${waveformMax.toFixed(2)} VがDPS-150の使用可能範囲0～${deviceMaxVoltage.toFixed(2)} Vを超えます。`,
    );
  }

  const totalDuration = calculateTotalDuration(aValues, periods, cycles);
  return Object.freeze({
    aStart,
    aEnd,
    aStep,
    aValues: Object.freeze(aValues),
    periods: Object.freeze(periods),
    cycles,
    updateInterval,
    currentLimit,
    waveformMin,
    waveformMax,
    totalDuration,
    deviceMaxVoltage,
    deviceMaxCurrent,
  });
}

export function formatDuration(totalSeconds) {
  const safeSeconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}
