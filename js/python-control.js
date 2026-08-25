const READY_TIMEOUT_MS = 30_000;
const COMPILE_TIMEOUT_MS = 3_000;
const EVALUATION_TIMEOUT_MS = 750;

function asError(value, fallbackMessage) {
  if (value instanceof Error) return value;
  const message = value?.message || String(value || fallbackMessage);
  const error = new Error(message);
  if (value?.traceback) error.stack = `${message}\n${value.traceback}`;
  return error;
}

export function validatePythonControlResult(result, limits = {}) {
  const voltage = Number(result?.voltage);
  const current = Number(result?.current);
  const maxVoltage = Number.isFinite(Number(limits.maxVoltage)) ? Number(limits.maxVoltage) : 24;
  const maxCurrent = Number.isFinite(Number(limits.maxCurrent)) ? Number(limits.maxCurrent) : 5;

  if (!Number.isFinite(voltage) || voltage < 0 || voltage > maxVoltage) {
    throw new RangeError(
      `Pythonが安全範囲外の電圧を返しました: ${result?.voltage}（許容 0～${maxVoltage.toFixed(3)} V）`,
    );
  }
  if (!Number.isFinite(current) || current <= 0 || current > maxCurrent) {
    throw new RangeError(
      `Pythonが安全範囲外の電流を返しました: ${result?.current}（許容 0より大きく${maxCurrent.toFixed(3)} A以下）`,
    );
  }

  return Object.freeze({ voltage, current });
}

export class PythonControlEngine {
  constructor({
    workerUrl = new URL("./python-worker.js?v=20260825.8", import.meta.url),
    workerFactory = (url, options) => new Worker(url, options),
  } = {}) {
    this.workerUrl = workerUrl;
    this.workerFactory = workerFactory;
    this.worker = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyTimer = null;
    this.activeSource = "";
    this.version = "";
  }

  async prepare(source) {
    const normalizedSource = String(source ?? "").trim();
    if (!normalizedSource) throw new Error("Pythonコードを入力してください。");
    if (this.worker && this.activeSource === normalizedSource) {
      return { version: this.version };
    }

    this.terminate();
    this.createWorker();
    await this.readyPromise;
    await this.request("compile", { source: normalizedSource }, COMPILE_TIMEOUT_MS);
    this.activeSource = normalizedSource;
    return { version: this.version };
  }

  async evaluate(context, limits = {}) {
    if (!this.worker || !this.activeSource) {
      throw new Error("Python制御コードが準備されていません。");
    }
    const result = await this.request("evaluate", { context }, EVALUATION_TIMEOUT_MS);
    return validatePythonControlResult(result, limits);
  }

  createWorker() {
    const worker = this.workerFactory(this.workerUrl, {
      type: "module",
      name: "dps150-python-control",
    });
    this.worker = worker;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.readyTimer = setTimeout(() => {
        const error = new Error("ブラウザ内Pythonの起動が30秒以内に完了しませんでした。");
        this.terminate(error);
        reject(error);
      }, READY_TIMEOUT_MS);
    });

    worker.addEventListener("message", (event) => this.handleMessage(event));
    worker.addEventListener("error", (event) => {
      this.terminate(new Error(event.message || "ブラウザ内PythonのWorkerでエラーが発生しました。"));
    });
    worker.addEventListener("messageerror", () => {
      this.terminate(new Error("ブラウザ内Pythonとのデータ交換に失敗しました。"));
    });
  }

  handleMessage(event) {
    const message = event.data ?? {};
    if (message.type === "ready") {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.version = String(message.version || "unknown");
      this.resolveReady?.({ version: this.version });
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }
    if (message.type === "fatal") {
      this.terminate(asError(message.error, "ブラウザ内Pythonを起動できませんでした。"));
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(asError(message.error, "Pythonコードの実行に失敗しました。"));
    } else {
      pending.resolve(message.result);
    }
  }

  request(type, payload, timeoutMs) {
    if (!this.worker) return Promise.reject(new Error("ブラウザ内Pythonが起動していません。"));
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const label = type === "evaluate" ? "Python制御関数" : "Pythonコードの準備";
        const error = new Error(`${label}が${timeoutMs} ms以内に完了しませんでした。`);
        this.terminate(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  terminate(reason = new Error("ブラウザ内Pythonを終了しました。")) {
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.worker?.terminate();
    this.worker = null;
    this.activeSource = "";
    this.version = "";

    this.rejectReady?.(reason);
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}
