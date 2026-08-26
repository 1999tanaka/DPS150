import test from "node:test";
import assert from "node:assert/strict";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";

test("vendored Pyodide runs the Vmax/Amax generator", async () => {
  const runtimeDirectory = dirname(fileURLToPath(new URL("../vendor/pyodide/pyodide.mjs", import.meta.url)));
  const pyodide = await loadPyodide({ indexURL: `${runtimeDirectory}${sep}` });
  pyodide.runPython(`
def control(Vmax, Amax):
    for i in range(100):
        V = min(Vmax, 13.0 + 0.01 * i)
        A = min(Amax, 0.100)
        yield A, V
`);
  const control = pyodide.globals.get("control");
  const iterator = control(14, 0.1);
  let result;
  for (let i = 0; i <= 25; i += 1) {
    result?.destroy?.();
    const step = iterator.next();
    assert.equal(step.done, false);
    result = step.value;
  }
  try {
    const [current, voltage] = result.toJs();
    assert.equal(pyodide.version, "314.0.6");
    assert.ok(Math.abs(voltage - 13.25) < 1e-12);
    assert.equal(current, 0.1);
    result.destroy();
    result = null;
    for (let i = 26; i < 100; i += 1) {
      const step = iterator.next();
      assert.equal(step.done, false);
      step.value.destroy();
    }
    assert.equal(iterator.next().done, true);
  } finally {
    result?.destroy?.();
    iterator.destroy();
    control.destroy();
  }
});
