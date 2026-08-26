import test from "node:test";
import assert from "node:assert/strict";

import { formatDuration, validateExperimentConfig } from "../js/waveform.js";

const base = {
  voltageMax: 14,
  currentMax: 0.1,
  controlCycleMs: 50,
  pythonSource: "def control(Vmax, Amax):\n    yield Amax, Vmax",
};

test("Python configuration validates Vmax, Amax, and control cycle", () => {
  const config = validateExperimentConfig(base, { maxVoltage: 24, maxCurrent: 5.1 });

  assert.equal(config.voltageMax, 14);
  assert.equal(config.currentMax, 0.1);
  assert.equal(config.controlCycleMs, 50);
  assert.equal(config.deviceMaxVoltage, 24);
  assert.equal(config.deviceMaxCurrent, 5.1);
  assert.equal(Object.isFrozen(config), true);
});

test("unsafe and malformed Python configurations are rejected", () => {
  assert.throws(() => validateExperimentConfig({ ...base, voltageMax: 0 }));
  assert.throws(() => validateExperimentConfig({ ...base, voltageMax: 25 }, { maxVoltage: 24 }));
  assert.throws(() => validateExperimentConfig({ ...base, currentMax: 0 }));
  assert.throws(() => validateExperimentConfig({ ...base, currentMax: 6 }, { maxCurrent: 5.1 }));
  assert.throws(() => validateExperimentConfig({ ...base, controlCycleMs: 25 }));
  assert.throws(() => validateExperimentConfig({ ...base, pythonSource: "" }));
});

test("duration formatting remains available for elapsed time", () => {
  assert.equal(formatDuration(5_808), "01:36:48");
});
