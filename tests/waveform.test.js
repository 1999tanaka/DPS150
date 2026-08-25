import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAValues,
  calculateTotalDuration,
  calculateVoltage,
  calculateVoltageRange,
  formatDuration,
  validateExperimentConfig,
} from "../js/waveform.js";

const closeTo = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not close to ${expected}`);
};

test("A=2.0 produces a 2–14 V sine wave", () => {
  closeTo(calculateVoltage(2, 1, 0), 8);
  closeTo(calculateVoltage(2, 1, 0.25), 14);
  closeTo(calculateVoltage(2, 1, 0.75), 2);
  assert.deepEqual(calculateVoltageRange(2), { min: 2, max: 14 });
});

test("A=14.0 stays at 14 V", () => {
  for (const time of [0, 0.1, 0.25, 1, 9.99]) {
    closeTo(calculateVoltage(14, 10, time), 14);
  }
  assert.deepEqual(calculateVoltageRange(14), { min: 14, max: 14 });
});

test("Formula Base B replaces both 7 constants", () => {
  closeTo(calculateVoltage(2, 1, 0, 6), 7);
  closeTo(calculateVoltage(2, 1, 0.25, 6), 12);
  closeTo(calculateVoltage(2, 1, 0.75, 6), 2);
  assert.deepEqual(calculateVoltageRange(2, 6), { min: 2, max: 12 });
});

test("integer-scaled A sequence has 121 exact conditions", () => {
  const values = buildAValues(2, 14, 0.1);
  assert.equal(values.length, 121);
  assert.equal(values[0], 2);
  assert.equal(values[1], 2.1);
  assert.equal(values[27], 4.7);
  assert.equal(values.at(-1), 14);
});

test("default experiment lasts 5,808 seconds", () => {
  const values = buildAValues(2, 14, 0.1);
  assert.equal(calculateTotalDuration(values, [1, 5, 10], 3), 5_808);
  assert.equal(formatDuration(5_808), "01:36:48");
});

test("default configuration validates and preserves limits", () => {
  const config = validateExperimentConfig({
    currentLimit: 1,
    baseVoltage: 7,
    aStart: 2,
    aEnd: 14,
    aStep: 0.1,
    periods: [1, 5, 10],
    cycles: 3,
    updateInterval: 50,
  }, { maxVoltage: 24, maxCurrent: 5.1 });

  assert.equal(config.aValues.length, 121);
  assert.equal(config.waveformMin, 2);
  assert.equal(config.waveformMax, 14);
  assert.equal(config.totalDuration, 5_808);
  assert.equal(config.baseVoltage, 7);
});

test("unsafe and malformed configurations are rejected", () => {
  const base = {
    currentLimit: 1,
    baseVoltage: 7,
    aStart: 2,
    aEnd: 14,
    aStep: 0.1,
    periods: [1, 5, 10],
    cycles: 3,
    updateInterval: 50,
  };
  assert.throws(() => validateExperimentConfig({ ...base, currentLimit: 0 }));
  assert.throws(() => validateExperimentConfig({ ...base, aStart: 1.9 }));
  assert.throws(() => validateExperimentConfig({ ...base, periods: [] }));
  assert.throws(() => validateExperimentConfig({ ...base, updateInterval: 25 }));
  assert.throws(() => validateExperimentConfig({ ...base, baseVoltage: -0.1 }));
  assert.throws(() => validateExperimentConfig({ ...base, baseVoltage: 13 }, { maxVoltage: 24 }));
  assert.throws(() => validateExperimentConfig(base, { maxVoltage: 12 }));
});
