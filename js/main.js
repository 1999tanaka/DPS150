import { DPS150 } from "./dps150.js?v=20260825.8";
import { ExperimentController } from "./experiment.js?v=20260825.8";
import { CurrentGraph, VoltageGraph } from "./graph.js?v=20260825.8";
import { ExperimentLogger } from "./logger.js?v=20260825.8";
import { PythonControlEngine } from "./python-control.js?v=20260825.8";
import {
  calculateVoltageRange,
  formatDuration,
  validateExperimentConfig,
} from "./waveform.js?v=20260825.8";

const byId = (id) => document.getElementById(id);

const elements = {
  compatibilityBanner: byId("compatibility-banner"),
  connectionState: byId("connection-state"),
  outputState: byId("output-state"),
  modelName: byId("model-name"),
  deviceConnectionDetail: byId("device-connection-detail"),
  hardwareVersion: byId("hardware-version"),
  firmwareVersion: byId("firmware-version"),
  connectButton: byId("connect-button"),
  settingsForm: byId("settings-form"),
  currentLimit: byId("current-limit"),
  aStart: byId("a-start"),
  aEnd: byId("a-end"),
  aStep: byId("a-step"),
  cycles: byId("cycles"),
  updateInterval: byId("update-interval"),
  pythonCode: byId("python-code"),
  checkPython: byId("check-python"),
  pythonStatus: byId("python-status"),
  pythonRuntimeBadge: byId("python-runtime-badge"),
  voltageRange: byId("voltage-range"),
  validationMessage: byId("validation-message"),
  startButton: byId("start-button"),
  stopButton: byId("stop-button"),
  runState: byId("run-state"),
  runPulse: byId("run-pulse"),
  statusMessage: byId("status-message"),
  currentA: byId("current-a"),
  aTotal: byId("a-total"),
  currentPeriod: byId("current-period"),
  currentCycle: byId("current-cycle"),
  currentStep: byId("current-step"),
  progressPercent: byId("progress-percent"),
  progressFill: byId("progress-fill"),
  progressTrack: document.querySelector(".progress-track"),
  elapsedTime: byId("elapsed-time"),
  remainingTime: byId("remaining-time"),
  finishTime: byId("finish-time"),
  commandVoltage: byId("command-voltage"),
  measuredVoltage: byId("measured-voltage"),
  commandCurrent: byId("command-current"),
  measuredCurrent: byId("measured-current"),
  measuredPower: byId("measured-power"),
  voltageGraphCanvas: byId("voltage-graph"),
  currentGraphCanvas: byId("current-graph"),
  voltageGraphWindow: byId("voltage-graph-window") ?? byId("graph-window"),
  currentGraphWindow: byId("current-graph-window"),
  voltageTelemetryRate: byId("voltage-telemetry-rate"),
  currentTelemetryRate: byId("current-telemetry-rate"),
  downloadCsv: byId("download-csv"),
  startDialog: byId("start-dialog"),
  safetyConfirm: byId("safety-confirm"),
  confirmStart: byId("confirm-start"),
  confirmA: byId("confirm-a"),
  confirmPeriods: byId("confirm-periods"),
  confirmCycles: byId("confirm-cycles"),
  confirmDuration: byId("confirm-duration"),
  confirmControl: byId("confirm-control"),
  confirmCurrent: byId("confirm-current"),
};

const device = new DPS150();
const logger = new ExperimentLogger();
const pythonControl = new PythonControlEngine();
const voltageGraph = new VoltageGraph(elements.voltageGraphCanvas);
// Current UI elements were added after the first public version. Treat them as
// optional so a briefly cached older index.html cannot abort an active run.
const currentGraph = elements.currentGraphCanvas
  ? new CurrentGraph(elements.currentGraphCanvas)
  : null;
const experiment = new ExperimentController(device, logger, pythonControl);

let pendingConfig = null;
let activeConfig = null;
let connectionBusy = false;
let activeRunPromise = null;
let pythonBusy = false;

function readFormValues() {
  return {
    currentLimit: elements.currentLimit.value,
    aStart: elements.aStart.value,
    aEnd: elements.aEnd.value,
    aStep: elements.aStep.value,
    periods: [...elements.settingsForm.querySelectorAll('input[name="period"]:checked')]
      .map((checkbox) => checkbox.value),
    cycles: elements.cycles.value,
    updateInterval: elements.updateInterval.value,
    pythonSource: elements.pythonCode.value,
  };
}

function deviceLimits() {
  const state = device.getState();
  return { maxVoltage: state.maxVoltage, maxCurrent: state.maxCurrent };
}

function getConfig({ preview = false } = {}) {
  const values = readFormValues();
  if (preview && !values.currentLimit) values.currentLimit = 1;
  return validateExperimentConfig(values, deviceLimits());
}

function setValidation(message = "") {
  elements.validationMessage.textContent = message;
  elements.validationMessage.hidden = !message;
}

function setStatus(message, type = "info") {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = `status-message status-${type}`;
}

function numericText(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function finishClock(remainingSeconds) {
  if (!Number.isFinite(remainingSeconds)) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(Date.now() + remainingSeconds * 1_000));
}

function setProgress(progress) {
  const clamped = Math.max(0, Math.min(1, progress || 0));
  const percent = clamped * 100;
  elements.progressPercent.textContent = `${percent.toFixed(1)}%`;
  elements.progressFill.style.width = `${percent}%`;
  elements.progressTrack.setAttribute("aria-valuenow", percent.toFixed(1));
}

function logSummary(recordCount) {
  const base = `${recordCount.toLocaleString()}件のログ`;
  return logger.truncated ? `${base}（上限到達のため以降は省略）` : base;
}

function setFormDisabled(disabled) {
  for (const control of elements.settingsForm.querySelectorAll("input, select, textarea")) {
    control.disabled = disabled;
  }
  elements.checkPython.disabled = disabled || pythonBusy;
}

function updateButtons() {
  const hasCurrentLimit = Number(elements.currentLimit.value) > 0;
  const hasPythonCode = Boolean(elements.pythonCode.value.trim());
  elements.connectButton.disabled = connectionBusy;
  elements.startButton.disabled = !device.connected
    || experiment.running
    || !hasCurrentLimit
    || !hasPythonCode
    || connectionBusy
    || pythonBusy;
  elements.stopButton.disabled = !experiment.running;
  elements.checkPython.disabled = experiment.running || pythonBusy || !hasPythonCode;
}

function updateDeviceState(state = device.getState()) {
  elements.connectionState.className = `state-value ${state.connected ? "state-on" : "state-off"}`;
  elements.connectionState.innerHTML = `<span class="status-dot" aria-hidden="true"></span>${state.connected ? "Connected" : "Disconnected"}`;
  elements.deviceConnectionDetail.textContent = state.connected ? "Connected · 115200 bps" : "Not connected";
  elements.connectButton.querySelector("span:last-child").textContent = state.connected ? "DISCONNECT DEVICE" : "CONNECT DEVICE";
  elements.modelName.textContent = state.modelName || "DPS-150";
  elements.hardwareVersion.textContent = state.hardwareVersion || "—";
  elements.firmwareVersion.textContent = state.firmwareVersion || "—";

  elements.outputState.textContent = state.outputEnabled ? "ON" : "OFF";
  elements.outputState.className = `output-badge ${state.outputEnabled ? "output-on" : "output-off"}`;
  if (elements.commandCurrent) {
    elements.commandCurrent.textContent = numericText(state.setCurrent, 3);
  }
  updateButtons();
}

function updateTelemetry(state = device.getState()) {
  elements.measuredVoltage.textContent = numericText(state.measuredVoltage, 3);
  elements.measuredCurrent.textContent = numericText(state.measuredCurrent, 3);
  elements.measuredPower.textContent = numericText(state.measuredPower, 3);
  const measurementRate = Number.isFinite(state.measurementRateHz)
    ? `Measured raw ${state.measurementRateHz.toFixed(1)} Hz · target 20 Hz`
    : "Measured raw — Hz · target 20 Hz";
  if (elements.voltageTelemetryRate) elements.voltageTelemetryRate.textContent = measurementRate;
  if (elements.currentTelemetryRate) elements.currentTelemetryRate.textContent = measurementRate;
  updateDeviceState(state);
}

function updatePreview() {
  let config;
  try {
    config = getConfig({ preview: true });
    elements.voltageRange.textContent = `Python output safety check 0—${config.deviceMaxVoltage.toFixed(2)} V`;
    elements.remainingTime.textContent = formatDuration(config.totalDuration);
    elements.aTotal.textContent = `/ ${config.aEnd.toFixed(1)}`;
    elements.currentStep.textContent = `0 / ${config.aValues.length}`;
    if (!experiment.running) elements.finishTime.textContent = finishClock(config.totalDuration);
  } catch {
    const start = Number(elements.aStart.value);
    const end = Number(elements.aEnd.value);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const startRange = calculateVoltageRange(start);
      const endRange = calculateVoltageRange(end);
      elements.voltageRange.textContent = `Expected range ${Math.min(startRange.min, endRange.min).toFixed(2)}—${Math.max(startRange.max, endRange.max).toFixed(2)} V`;
    } else {
      elements.voltageRange.textContent = "Check waveform settings";
    }
  }
  updateButtons();
}

async function handleConnect() {
  if (connectionBusy) return;
  connectionBusy = true;
  updateButtons();

  try {
    if (device.connected) {
      if (experiment.running) {
        const confirmed = window.confirm("実験を停止してDPS-150を切断しますか？\nOUTPUT OFFを送信します。");
        if (!confirmed) return;
        await experiment.stop("接続解除のため停止しました。");
        await activeRunPromise;
      }
      setStatus("DPS-150を安全に切断しています…", "warning");
      await device.disconnect();
      setStatus("Disconnected. DPS-150を接続してください。", "info");
    } else {
      setStatus("ブラウザの一覧からDPS-150のシリアルポートを選択してください。", "info");
      const state = await device.connect();
      updateDeviceState(state);
      updateTelemetry(state);
      setStatus("Connected. Python Current Safety Maxと実験条件を確認してください。", "success");
      setValidation();
    }
  } catch (error) {
    if (error?.name === "NotFoundError") {
      setStatus("ポート選択をキャンセルしました。", "info");
    } else {
      setStatus(`Connection error: ${error.message}`, "error");
    }
  } finally {
    connectionBusy = false;
    updateDeviceState();
    updatePreview();
  }
}

function openStartConfirmation() {
  try {
    if (!device.connected) throw new Error("DPS-150を先に接続してください。");
    pendingConfig = getConfig();
    setValidation();
  } catch (error) {
    setValidation(error.message);
    elements.settingsForm.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  elements.confirmA.textContent = `${pendingConfig.aStart.toFixed(1)} → ${pendingConfig.aEnd.toFixed(1)} / ${pendingConfig.aStep.toFixed(1)}`;
  elements.confirmPeriods.textContent = `${pendingConfig.periods.join(" / ")} sec`;
  elements.confirmCycles.textContent = `${pendingConfig.cycles} each`;
  elements.confirmDuration.textContent = formatDuration(pendingConfig.totalDuration);
  elements.confirmControl.textContent = "Browser Python · isolated Worker";
  elements.confirmCurrent.textContent = `${pendingConfig.currentLimit.toFixed(3)} A`;
  elements.safetyConfirm.checked = false;
  elements.confirmStart.disabled = true;
  elements.startDialog.returnValue = "cancel";
  elements.startDialog.showModal();
}

async function runExperiment(config) {
  activeConfig = config;
  voltageGraph.clear();
  currentGraph?.clear();
  setFormDisabled(true);
  elements.startButton.disabled = true;
  elements.stopButton.disabled = false;
  elements.downloadCsv.disabled = true;
  elements.runState.textContent = "Starting";
  elements.runPulse.classList.add("active");
  setStatus("Python制御を準備し、電流安全上限と初期電圧を設定しています…", "warning");

  try {
    activeRunPromise = experiment.start(config);
    await activeRunPromise;
  } catch {
    // The experiment error event has already updated the user-facing status.
  } finally {
    activeConfig = null;
    activeRunPromise = null;
    setFormDisabled(false);
    elements.runPulse.classList.remove("active");
    elements.downloadCsv.disabled = logger.size === 0;
    updateButtons();
    updatePreview();
  }
}

async function handleStop() {
  if (!experiment.running) return;
  elements.stopButton.disabled = true;
  elements.runState.textContent = "Stopping";
  setStatus("STOPを受け付けました。OUTPUT OFFを送信しています…", "warning");
  try {
    await experiment.stop();
  } catch (error) {
    setStatus(`Emergency stop error: ${error.message}`, "error");
  }
}

async function handleCheckPython() {
  if (experiment.running || pythonBusy) return;
  const source = elements.pythonCode.value.trim();
  if (!source) {
    elements.pythonStatus.textContent = "Pythonコードを入力してください。";
    elements.pythonStatus.className = "python-status python-status-error";
    return;
  }

  pythonBusy = true;
  elements.pythonStatus.textContent = "Loading browser Python…";
  elements.pythonStatus.className = "python-status python-status-loading";
  updateButtons();
  try {
    const runtime = await pythonControl.prepare(source);
    const state = device.getState();
    const configuredMax = Number(elements.currentLimit.value);
    const maxCurrent = Number.isFinite(configuredMax) && configuredMax > 0
      ? Math.min(configuredMax, state.maxCurrent || configuredMax)
      : (state.maxCurrent || 5);
    const sample = await pythonControl.evaluate({
      t: 0,
      A: Number(elements.aStart.value) || 2,
      T: Number(elements.settingsForm.querySelector('input[name="period"]:checked')?.value) || 1,
      cycle: 1,
    }, {
      maxVoltage: state.maxVoltage || 24,
      maxCurrent,
    });
    elements.pythonRuntimeBadge.textContent = `Python ${runtime.version} · Worker`;
    elements.pythonStatus.textContent = `Ready · t=0 → ${sample.voltage.toFixed(3)} V / ${sample.current.toFixed(3)} A`;
    elements.pythonStatus.className = "python-status python-status-ready";
    setValidation();
  } catch (error) {
    elements.pythonStatus.textContent = `Python error: ${error.message}`;
    elements.pythonStatus.className = "python-status python-status-error";
    setValidation(error.message);
  } finally {
    pythonBusy = false;
    updateButtons();
  }
}

elements.connectButton.addEventListener("click", handleConnect);
elements.startButton.addEventListener("click", openStartConfirmation);
elements.stopButton.addEventListener("click", handleStop);
elements.checkPython.addEventListener("click", handleCheckPython);
elements.settingsForm.addEventListener("submit", (event) => event.preventDefault());
elements.settingsForm.addEventListener("input", () => {
  setValidation();
  updatePreview();
});
elements.settingsForm.addEventListener("change", updatePreview);
elements.pythonCode.addEventListener("input", () => {
  elements.pythonStatus.textContent = "Not checked · code changed";
  elements.pythonStatus.className = "python-status";
});

elements.safetyConfirm.addEventListener("change", () => {
  elements.confirmStart.disabled = !elements.safetyConfirm.checked;
});

elements.startDialog.addEventListener("close", () => {
  if (elements.startDialog.returnValue !== "start" || !elements.safetyConfirm.checked || !pendingConfig) return;
  const config = pendingConfig;
  pendingConfig = null;
  void runExperiment(config);
});

elements.downloadCsv.addEventListener("click", () => {
  logger.download();
});

device.addEventListener("statechange", (event) => updateDeviceState(event.detail.state));
device.addEventListener("telemetry", (event) => updateTelemetry(event.detail.state));
device.addEventListener("disconnect", (event) => {
  updateDeviceState();
  if (!event.detail?.expected) {
    setStatus("ERROR — Communication lost. Output control stopped.", "error");
    elements.runState.textContent = "Error";
  }
});
device.addEventListener("error", (event) => {
  setStatus(`ERROR — ${event.detail.error.message} Output control stopped.`, "error");
  elements.runState.textContent = "Error";
});

experiment.addEventListener("started", () => {
  elements.runState.textContent = "Running";
  setStatus("Experiment running. このページを前面に保ち、PCをスリープさせないでください。", "success");
});

experiment.addEventListener("pythonstatus", (event) => {
  if (event.detail.state === "loading") {
    elements.pythonStatus.textContent = "Loading browser Python…";
    elements.pythonStatus.className = "python-status python-status-loading";
    setStatus("ブラウザ内Pythonを安全なWorkerで起動しています。OUTPUTはまだOFFです。", "warning");
  } else if (event.detail.state === "ready") {
    elements.pythonRuntimeBadge.textContent = `Python ${event.detail.version} · Worker`;
    elements.pythonStatus.textContent = "Running in isolated Worker";
    elements.pythonStatus.className = "python-status python-status-ready";
    setStatus("Python制御でExperiment running. このページを前面に保ってください。", "success");
  }
});

experiment.addEventListener("segment", () => {
  const voltageWindowSeconds = voltageGraph.setPeriod();
  const currentWindowSeconds = currentGraph?.setPeriod();
  if (elements.voltageGraphWindow) {
    elements.voltageGraphWindow.textContent = `Fixed window ${voltageWindowSeconds} s · 1 s ticks`;
  }
  if (elements.currentGraphWindow && currentWindowSeconds) {
    elements.currentGraphWindow.textContent = `Fixed window ${currentWindowSeconds} s · 1 s ticks`;
  }
});

experiment.addEventListener("progress", (event) => {
  const sample = event.detail;
  elements.currentA.textContent = sample.A.toFixed(1);
  elements.currentPeriod.textContent = `${sample.T} s`;
  elements.currentCycle.textContent = `${sample.cycle} / ${activeConfig?.cycles ?? "—"}`;
  elements.currentStep.textContent = `${sample.aIndex + 1} / ${sample.aCount}`;
  elements.commandVoltage.textContent = sample.commandVoltage.toFixed(3);
  if (elements.commandCurrent) {
    elements.commandCurrent.textContent = sample.commandCurrent.toFixed(3);
  }
  elements.elapsedTime.textContent = formatDuration(sample.elapsedSeconds);
  elements.remainingTime.textContent = formatDuration(sample.remainingSeconds);
  elements.finishTime.textContent = finishClock(sample.remainingSeconds);
  setProgress(sample.progress);
  voltageGraph.addPoint({
    time: sample.elapsedSeconds,
    commandVoltage: sample.commandVoltage,
  });
  currentGraph?.addPoint({
    time: sample.elapsedSeconds,
    commandCurrent: sample.commandCurrent,
  });
});

experiment.addEventListener("measurement", (event) => {
  const sample = event.detail;
  voltageGraph.addPoint({
    time: sample.measurementElapsedSeconds,
    measuredVoltage: sample.measuredVoltage,
  });
  currentGraph?.addPoint({
    time: sample.measurementElapsedSeconds,
    measuredCurrent: sample.measuredCurrent,
  });
});

experiment.addEventListener("completed", (event) => {
  elements.runState.textContent = "Completed";
  elements.runPulse.classList.remove("active");
  elements.elapsedTime.textContent = formatDuration(event.detail.elapsedSeconds);
  elements.remainingTime.textContent = "00:00:00";
  elements.finishTime.textContent = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  setProgress(1);
  setStatus(`Completed. OUTPUT OFF. ${logSummary(event.detail.recordCount)}を保存できます。`, "success");
  elements.downloadCsv.disabled = logger.size === 0;
  elements.pythonStatus.textContent = "Completed · Worker stopped";
  elements.pythonStatus.className = "python-status";
});

experiment.addEventListener("stopped", (event) => {
  elements.runState.textContent = "Stopped";
  elements.runPulse.classList.remove("active");
  elements.elapsedTime.textContent = formatDuration(event.detail.elapsedSeconds);
  setStatus(`Stopped. OUTPUT OFF. ${logSummary(event.detail.recordCount)}を保存できます。`, "warning");
  elements.downloadCsv.disabled = logger.size === 0;
  elements.pythonStatus.textContent = "Stopped · Worker terminated";
  elements.pythonStatus.className = "python-status";
});

experiment.addEventListener("error", (event) => {
  elements.runState.textContent = "Error";
  elements.runPulse.classList.remove("active");
  setStatus(`ERROR — ${event.detail.error.message} Output control stopped.`, "error");
  elements.downloadCsv.disabled = logger.size === 0;
  elements.pythonStatus.textContent = `Stopped · ${event.detail.error.message}`;
  elements.pythonStatus.className = "python-status python-status-error";
});

window.addEventListener("beforeunload", (event) => {
  if (!experiment.running) return;
  event.preventDefault();
  event.returnValue = "Experiment is running. Leaving this page will stop control.";
});

window.addEventListener("pagehide", () => {
  if (experiment.running) void experiment.stop("ページが閉じられたため停止しました。");
});

window.addEventListener("error", (event) => {
  if (experiment.running) experiment.abort(event.error ?? new Error(event.message || "JavaScript error"));
});

window.addEventListener("unhandledrejection", (event) => {
  if (experiment.running) {
    const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    experiment.abort(error);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && experiment.running) {
    void experiment.acquireWakeLock();
  }
});

if (!DPS150.isSupported) {
  elements.compatibilityBanner.hidden = false;
  elements.connectButton.disabled = true;
  setStatus("Web Serialを利用できません。HTTPS上のChromeまたはEdgeで開いてください。", "error");
}

updateDeviceState();
updatePreview();
