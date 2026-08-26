import test from "node:test";
import assert from "node:assert/strict";

import {
  validatePythonControlResult,
  validatePythonPreviewResult,
} from "../js/python-control.js";

test("accepts finite Python voltage and current inside the safety limits", () => {
  const result = validatePythonControlResult(
    { voltage: 13.5, current: 0.1 },
    { maxVoltage: 24, maxCurrent: 0.2 },
  );
  assert.deepEqual(result, { done: false, voltage: 13.5, current: 0.1 });
  assert.equal(Object.isFrozen(result), true);
});

test("accepts generator completion without voltage or current", () => {
  const result = validatePythonControlResult({ done: true });
  assert.deepEqual(result, { done: true });
  assert.equal(Object.isFrozen(result), true);
});

test("rejects unsafe or non-finite Python control values", () => {
  const limits = { maxVoltage: 24, maxCurrent: 0.2 };
  assert.throws(() => validatePythonControlResult({ voltage: 25, current: 0.1 }, limits));
  assert.throws(() => validatePythonControlResult({ voltage: 13, current: 0.3 }, limits));
  assert.throws(() => validatePythonControlResult({ voltage: Number.NaN, current: 0.1 }, limits));
  assert.throws(() => validatePythonControlResult({ voltage: 13, current: 0 }, limits));
});

test("validates a flat Python waveform preview", () => {
  const preview = validatePythonPreviewResult({
    truncated: false,
    flatPoints: [0.1, 13, 0.1, 14, 0.05, 13.5],
  }, { maxVoltage: 14, maxCurrent: 0.1 });

  assert.equal(preview.truncated, false);
  assert.deepEqual(preview.points, [
    { current: 0.1, voltage: 13 },
    { current: 0.1, voltage: 14 },
    { current: 0.05, voltage: 13.5 },
  ]);
  assert.equal(Object.isFrozen(preview.points), true);
});

test("rejects malformed or unsafe Python waveform previews", () => {
  assert.throws(() => validatePythonPreviewResult({ flatPoints: [0.1] }));
  assert.throws(() => validatePythonPreviewResult(
    { flatPoints: [0.2, 13] },
    { maxVoltage: 14, maxCurrent: 0.1 },
  ));
});
