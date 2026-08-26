import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";

const PYODIDE_INDEX_URL = new URL("../vendor/pyodide/", import.meta.url).href;
let pyodide;
let beginControl = null;
let nextControl = null;
let previewControl = null;

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
  beginControl?.destroy?.();
  nextControl?.destroy?.();
  previewControl?.destroy?.();
  beginControl = null;
  nextControl = null;
  previewControl = null;
}

async function compile(source) {
  disposeEvaluator();
  pyodide.globals.set("__dps_user_source", source);
  try {
    await pyodide.runPythonAsync(`
__dps_namespace = {}
exec(__dps_user_source, __dps_namespace)

if "control" not in __dps_namespace or not callable(__dps_namespace["control"]):
    raise TypeError("control(Vmax, Amax) ジェネレーター関数を定義してください。")

__dps_iterator = None

def __dps_begin_control(Vmax, Amax):
    global __dps_iterator
    result = __dps_namespace["control"](float(Vmax), float(Amax))
    try:
        __dps_iterator = iter(result)
    except TypeError as error:
        raise TypeError("control() は yield A, V を使うジェネレーターにしてください。") from error
    return True

def __dps_parse_control_result(result):
    if isinstance(result, dict):
        if "A" in result and "V" in result:
            current, voltage = result["A"], result["V"]
        elif "current" in result and "voltage" in result:
            current, voltage = result["current"], result["voltage"]
        else:
            raise TypeError("control() の辞書には A と V が必要です。")
    elif isinstance(result, (tuple, list)) and len(result) == 2:
        current, voltage = result
    else:
        raise TypeError("各回は yield A, V または yield {'A': A, 'V': V} としてください。")
    return float(current), float(voltage)

def __dps_next_control():
    if __dps_iterator is None:
        raise RuntimeError("Pythonジェネレーターが開始されていません。")
    try:
        result = next(__dps_iterator)
    except StopIteration:
        return True, 0.0, 0.0
    current, voltage = __dps_parse_control_result(result)
    return False, current, voltage

def __dps_preview_control(Vmax, Amax, max_points):
    max_points = int(max_points)
    if max_points < 1 or max_points > 10000:
        raise ValueError("プレビュー点数は1～10000点にしてください。")
    result = __dps_namespace["control"](float(Vmax), float(Amax))
    try:
        iterator = iter(result)
    except TypeError as error:
        raise TypeError("control() は yield A, V を使うジェネレーターにしてください。") from error

    flat_points = []
    for _ in range(max_points):
        try:
            item = next(iterator)
        except StopIteration:
            return False, flat_points
        current, voltage = __dps_parse_control_result(item)
        flat_points.extend((current, voltage))

    try:
        next(iterator)
    except StopIteration:
        return False, flat_points
    return True, flat_points
`);
    beginControl = pyodide.globals.get("__dps_begin_control");
    nextControl = pyodide.globals.get("__dps_next_control");
    previewControl = pyodide.globals.get("__dps_preview_control");
  } finally {
    pyodide.globals.delete("__dps_user_source");
  }
}

function begin(context) {
  if (!beginControl) throw new Error("Python制御コードがコンパイルされていません。");
  return Boolean(beginControl(context.Vmax, context.Amax));
}

function evaluate() {
  if (!nextControl) throw new Error("Python制御コードがコンパイルされていません。");
  const value = nextControl();
  try {
    const [done, current, voltage] = value.toJs();
    return done ? { done: true } : { done: false, current, voltage };
  } finally {
    value.destroy();
  }
}

function preview(context, maxPoints) {
  if (!previewControl) throw new Error("Python制御コードがコンパイルされていません。");
  const value = previewControl(context.Vmax, context.Amax, maxPoints);
  try {
    const [truncated, flatPoints] = value.toJs();
    return { truncated, flatPoints };
  } finally {
    value.destroy();
  }
}

self.addEventListener("message", async (event) => {
  const { id, type, source, context, maxPoints } = event.data ?? {};
  try {
    let result;
    if (type === "compile") {
      await compile(source);
      result = { compiled: true };
    } else if (type === "begin") {
      result = { started: begin(context) };
    } else if (type === "evaluate") {
      result = evaluate();
    } else if (type === "preview") {
      result = preview(context, maxPoints);
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
