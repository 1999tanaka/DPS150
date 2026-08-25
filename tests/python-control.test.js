import test from "node:test";
import assert from "node:assert/strict";

import { validatePythonControlResult } from "../js/python-control.js";

test("accepts finite Python voltage and current inside the safety limits", () => {
  const result = validatePythonControlResult(
    { voltage: 13.5, current: 0.1 },
    { maxVoltage: 24, maxCurrent: 0.2 },
  );
  assert.deepEqual(result, { voltage: 13.5, current: 0.1 });
  assert.equal(Object.isFrozen(result), true);
});

test("rejects unsafe or non-finite Python control values", () => {
  const limits = { maxVoltage: 24, maxCurrent: 0.2 };
  assert.throws(() => validatePythonControlResult({ voltage: 25, current: 0.1 }, limits));
  assert.throws(() => validatePythonControlResult({ voltage: 13, current: 0.3 }, limits));
  assert.throws(() => validatePythonControlResult({ voltage: Number.NaN, current: 0.1 }, limits));
  assert.throws(() => validatePythonControlResult({ voltage: 13, current: 0 }, limits));
});
