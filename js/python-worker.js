import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";

const PYODIDE_INDEX_URL = new URL("../vendor/pyodide/", import.meta.url).href;
let pyodide;
let evaluateControl = null;

try {
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  self.postMessage({ type: "ready", version: pyodide.version });
} catch (error) {
  self.postMessage({
    type: "fatal",
    error: { message: error?.message || String(error), traceback: error?.stack || "" },
  });
  throw error;
}

function disposeEvaluator() {
  evaluateControl?.destroy?.();
  evaluateControl = null;
}

async function compile(source) {
  disposeEvaluator();
  pyodide.globals.set("__dps_user_source", source);
  try {
    await pyodide.runPythonAsync(`
__dps_namespace = {}
exec(__dps_user_source, __dps_namespace)

if "control" not in __dps_namespace or not callable(__dps_namespace["control"]):
    raise TypeError("control(t, A, T, cycle) 関数を定義してください。")

def __dps_run_control(t, A, T, cycle):
    result = __dps_namespace["control"](float(t), float(A), float(T), int(cycle))
    if isinstance(result, dict):
        if "voltage" not in result or "current" not in result:
            raise TypeError("control() の辞書には voltage と current が必要です。")
        voltage = result["voltage"]
        current = result["current"]
    elif isinstance(result, (tuple, list)) and len(result) == 2:
        voltage, current = result
    else:
        raise TypeError("control() は {'voltage': V, 'current': A} または (V, A) を返してください。")
    return float(voltage), float(current)
`);
    evaluateControl = pyodide.globals.get("__dps_run_control");
  } finally {
    pyodide.globals.delete("__dps_user_source");
  }
}

function evaluate(context) {
  if (!evaluateControl) throw new Error("Python制御コードがコンパイルされていません。");
  const value = evaluateControl(context.t, context.A, context.T, context.cycle);
  try {
    const [voltage, current] = value.toJs();
    return { voltage, current };
  } finally {
    value.destroy();
  }
}

self.addEventListener("message", async (event) => {
  const { id, type, source, context } = event.data ?? {};
  try {
    let result;
    if (type === "compile") {
      await compile(source);
      result = { compiled: true };
    } else if (type === "evaluate") {
      result = evaluate(context);
    } else {
      throw new Error(`Unknown Python worker request: ${type}`);
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({
      id,
      error: {
        message: error?.message || String(error),
        traceback: error?.stack || "",
      },
    });
  }
});
