import test from "node:test";
import assert from "node:assert/strict";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";

test("vendored Pyodide runs the default voltage and current control function", async () => {
  const runtimeDirectory = dirname(fileURLToPath(new URL("../vendor/pyodide/pyodide.mjs", import.meta.url)));
  const pyodide = await loadPyodide({ indexURL: `${runtimeDirectory}${sep}` });
  pyodide.runPython(`
import math

def control(t, A, T, cycle):
    voltage = (7 + A / 2) + (7 - A / 2) * math.sin(2 * math.pi * t / T)
    current = 0.100
    return voltage, current
`);
  const control = pyodide.globals.get("control");
  const result = control(0.25, 2, 1, 1);
  try {
    const [voltage, current] = result.toJs();
    assert.equal(pyodide.version, "314.0.6");
    assert.ok(Math.abs(voltage - 14) < 1e-12);
    assert.equal(current, 0.1);
  } finally {
    result.destroy();
    control.destroy();
  }
});
