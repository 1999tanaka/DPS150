import { DPS150 } from "./dps150.js?v=20260827.1";
import { ExperimentController } from "./experiment.js?v=20260827.1";
import { CurrentGraph, VoltageGraph } from "./graph.js?v=20260827.1";
import { ExperimentLogger } from "./logger.js?v=20260827.1";
import {
  PlannedWaveformGraph,
  PREVIEW_GRAPH_COLORS,
  resolvePreviewGraphWidth,
  resolveZoomedPreviewGraphWidth,
} from "./preview-graph.js?v=20260827.1";
import { PythonControlEngine } from "./python-control.js?v=20260827.1";
import { formatDuration, validateExperimentConfig } from "./waveform.js?v=20260827.1";

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
  voltageMax: byId("voltage-max"),
  currentMax: byId("current-max"),
  controlCycle: byId("control-cycle"),
  pythonCode: byId("python-code"),
  checkPython: byId("check-python"),
  previewPython: byId("preview-python"),
  pythonStatus: byId("python-status"),
  pythonRuntimeBadge: byId("python-runtime-badge"),
  voltageRange: byId("voltage-range"),
  validationMessage: byId("validation-message"),
  startButton: byId("start-button"),
  stopButton: byId("stop-button"),
  runState: byId("run-state"),
  runPulse: byId("run-pulse"),
  statusMessage: byId("status-message"),
  currentIteration: byId("current-iteration"),
  currentControlCycle: byId("current-control-cycle"),
  currentVmax: byId("current-vmax"),
  currentAmax: byId("current-amax"),
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
  previewDialog: byId("preview-dialog"),
  previewPoints: byId("preview-points"),
  previewDuration: byId("preview-duration"),
  previewVoltageRange: byId("preview-voltage-range"),
  previewCurrentRange: byId("preview-current-range"),
  previewNote: byId("preview-note"),
  previewZoom: byId("preview-zoom"),
  previewZoomOut: byId("preview-zoom-out"),
  previewZoomIn: byId("preview-zoom-in"),
  previewZoomFit: byId("preview-zoom-fit"),
  previewZoomValue: byId("preview-zoom-value"),
  previewScrollHint: byId("preview-scroll-hint"),
  previewGraphScroll: byId("preview-graph-scroll"),
  previewGraphs: byId("preview-graphs"),
  previewVoltageCanvas: byId("preview-voltage-graph"),
  previewCurrentCanvas: byId("preview-current-graph"),
  startDialog: byId("start-dialog"),
  safetyConfirm: byId("safety-confirm"),
  confirmStart: byId("confirm-start"),
  confirmVmax: byId("confirm-vmax"),
  confirmAmax: byId("confirm-amax"),
  confirmCycle: byId("confirm-cycle"),
  confirmStop: byId("confirm-stop"),
  confirmControl: byId("confirm-control"),
  confirmReturn: byId("confirm-return"),
};

const device = new DPS150();
const logger = new ExperimentLogger();
const pythonControl = new PythonControlEngine();
const voltageGraph = new VoltageGraph(elements.voltageGraphCanvas);
const previewVoltageGraph = new PlannedWaveformGraph(elements.previewVoltageCanvas, {
  key: "commandVoltage",
  color: PREVIEW_GRAPH_COLORS.voltage,
});
const previewCurrentGraph = new PlannedWaveformGraph(elements.previewCurrentCanvas, {
  key: "commandCurrent",
  color: PREVIEW_GRAPH_COLORS.current,
});
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
let previewBaseGraphWidth = 1;
const PREVIEW_ZOOM_LEVELS = Object.freeze([0, 0.25, 0.5, 1, 2]);

function readFormValues() {
  return {
    voltageMax: elements.voltageMax.value,
    currentMax: elements.currentMax.value,
    controlCycleMs: elements.controlCycle.value,
    pythonSource: elements.pythonCode.value,
  };
}

function deviceLimits() {
  const state = device.getState();
  return { maxVoltage: state.maxVoltage, maxCurrent: state.maxCurrent };
}

function getConfig({ preview = false } = {}) {
  const values = readFormValues();
  if (preview && !values.voltageMax) values.voltageMax = 14;
  if (preview && !values.currentMax) values.currentMax = 0.1;
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

function numericRange(values, digits, unit) {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return "—";
  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  if (Math.abs(max - min) < 10 ** (-digits)) return `${min.toFixed(digits)} ${unit}`;
  return `${min.toFixed(digits)}—${max.toFixed(digits)} ${unit}`;
}

function preciseDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(3)} s`;
  return `${formatDuration(seconds)} (${seconds.toFixed(3)} s)`;
}

function applyPreviewZoom({ preserveCenter = true } = {}) {
  const index = Math.max(0, Math.min(
    PREVIEW_ZOOM_LEVELS.length - 1,
    Number.parseInt(elements.previewZoom.value, 10) || 0,
  ));
  const zoom = PREVIEW_ZOOM_LEVELS[index];
  const viewportWidth = Math.max(1, elements.previewGraphScroll.clientWidth);
  const previousScrollWidth = Math.max(viewportWidth, elements.previewGraphScroll.scrollWidth);
  const centerRatio = (
    elements.previewGraphScroll.scrollLeft + viewportWidth / 2
  ) / previousScrollWidth;
  const graphWidth = resolveZoomedPreviewGraphWidth({
    baseWidth: previewBaseGraphWidth,
    viewportWidth,
    zoom,
  });

  elements.previewGraphs.style.width = `${graphWidth}px`;
  const nextScrollWidth = Math.max(viewportWidth, elements.previewGraphScroll.scrollWidth);
  elements.previewGraphScroll.scrollLeft = preserveCenter
    ? centerRatio * nextScrollWidth - viewportWidth / 2
    : 0;
  elements.previewZoomValue.textContent = zoom === 0 ? "FIT" : `${zoom}×`;
  elements.previewZoomOut.disabled = index === 0;
  elements.previewZoomIn.disabled = index === PREVIEW_ZOOM_LEVELS.length - 1;
  elements.previewZoomFit.setAttribute("aria-pressed", String(zoom === 0));
  elements.previewScrollHint.textContent = graphWidth > viewportWidth + 1
    ? "↔ 左右へスワイプ／横スクロールして時間位置を移動できます。"
    : "波形全体を表示しています。拡大すると左右へ移動できます。";
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
  elements.previewPython.disabled = disabled || pythonBusy;
}

function updateButtons() {
  const hasVoltageMax = Number(elements.voltageMax.value) > 0;
  const hasCurrentMax = Number(elements.currentMax.value) > 0;
  const hasPythonCode = Boolean(elements.pythonCode.value.trim());
  elements.connectButton.disabled = connectionBusy;
  elements.startButton.disabled = !device.connected
    || experiment.running
    || !hasVoltageMax
    || !hasCurrentMax
    || !hasPythonCode
    || connectionBusy
    || pythonBusy;
  elements.stopButton.disabled = !experiment.running;
  elements.checkPython.disabled = experiment.running || pythonBusy || !hasPythonCode;
  elements.previewPython.disabled = experiment.running || pythonBusy || !hasPythonCode;
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
  try {
    const config = getConfig({ preview: true });
    elements.voltageRange.textContent = `Python output safety check 0—${config.voltageMax.toFixed(3)} V`;
    if (!experiment.running) {
      elements.currentIteration.textContent = "—";
      elements.currentControlCycle.textContent = `${config.controlCycleMs} ms`;
      elements.currentVmax.textContent = `${config.voltageMax.toFixed(3)} V`;
      elements.currentAmax.textContent = `${config.currentMax.toFixed(3)} A`;
      elements.remainingTime.textContent = "—";
      elements.finishTime.textContent = "generator end";
    }
  } catch {
    elements.voltageRange.textContent = "Check Vmax / Amax / Control Cycle";
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
      setStatus("Connected. Vmax・Amax・Control CycleとPythonコードを確認してください。", "success");
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

  elements.confirmVmax.textContent = `${pendingConfig.voltageMax.toFixed(3)} V`;
  elements.confirmAmax.textContent = `${pendingConfig.currentMax.toFixed(3)} A`;
  elements.confirmCycle.textContent = `${pendingConfig.controlCycleMs} ms`;
  elements.confirmStop.textContent = "break / generator end";
  elements.confirmControl.textContent = "Browser Python · isolated Worker";
  elements.confirmReturn.textContent = "A, V";
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
  setStatus("Pythonジェネレーターを準備し、最初の電流制限と電圧を安全確認しています…", "warning");

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
    const config = getConfig();
    const runtime = await pythonControl.prepare(source);
    await pythonControl.begin({
      Vmax: config.voltageMax,
      Amax: config.currentMax,
    });
    const sample = await pythonControl.evaluate({
      maxVoltage: Math.min(config.voltageMax, config.deviceMaxVoltage),
      maxCurrent: Math.min(config.currentMax, config.deviceMaxCurrent),
    });
    elements.pythonRuntimeBadge.textContent = `Python ${runtime.version} · Worker`;
    elements.pythonStatus.textContent = sample.done
      ? "Ready · yieldなし（実行すると直ちに正常終了）"
      : `Ready · i=0 → ${sample.current.toFixed(3)} A / ${sample.voltage.toFixed(3)} V`;
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

async function handlePreviewPython() {
  if (experiment.running || pythonBusy) return;
  const source = elements.pythonCode.value.trim();
  if (!source) {
    elements.pythonStatus.textContent = "Pythonコードを入力してください。";
    elements.pythonStatus.className = "python-status python-status-error";
    return;
  }

  pythonBusy = true;
  elements.pythonStatus.textContent = "Generating waveform preview…";
  elements.pythonStatus.className = "python-status python-status-loading";
  updateButtons();
  try {
    const config = getConfig();
    const runtime = await pythonControl.prepare(source);
    const preview = await pythonControl.preview({
      Vmax: config.voltageMax,
      Amax: config.currentMax,
    }, {
      maxVoltage: Math.min(config.voltageMax, config.deviceMaxVoltage),
      maxCurrent: Math.min(config.currentMax, config.deviceMaxCurrent),
    });
    if (preview.points.length === 0) {
      throw new Error("Pythonジェネレーターが波形点を1件もyieldしませんでした。");
    }

    const intervalSeconds = config.controlCycleMs / 1_000;
    const durationSeconds = preview.points.length * intervalSeconds;
    const points = preview.points.map((point, index) => ({
      time: index * intervalSeconds,
      commandVoltage: point.voltage,
      commandCurrent: point.current,
    }));
    const voltages = points.map((point) => point.commandVoltage);
    const currents = points.map((point) => point.commandCurrent);

    elements.previewPoints.textContent = preview.truncated
      ? `${preview.points.length.toLocaleString()}+ (truncated)`
      : preview.points.length.toLocaleString();
    elements.previewDuration.textContent = `${preview.truncated ? "≥ " : ""}${preciseDuration(durationSeconds)}`;
    elements.previewVoltageRange.textContent = numericRange(voltages, 3, "V");
    elements.previewCurrentRange.textContent = numericRange(currents, 3, "A");
    elements.previewNote.textContent = preview.truncated
      ? "Preview limit reached · Actual output continues beyond the displayed 10,000 points."
      : "Preview only · No serial command sent.";
    elements.previewNote.className = `preview-note${preview.truncated ? " preview-truncated" : ""}`;
    elements.pythonRuntimeBadge.textContent = `Python ${runtime.version} · Worker`;
    elements.pythonStatus.textContent = `Preview ready · ${preview.points.length.toLocaleString()} points · no output`;
    elements.pythonStatus.className = "python-status python-status-ready";
    setValidation();

    if (elements.previewDialog.open) elements.previewDialog.close();
    elements.previewDialog.showModal();
    const viewportWidth = elements.previewGraphScroll.clientWidth;
    previewBaseGraphWidth = resolvePreviewGraphWidth({
      pointCount: points.length,
      durationSeconds,
      viewportWidth,
    });
    elements.previewZoom.value = "3";
    applyPreviewZoom({ preserveCenter: false });
    previewVoltageGraph.setData(points, durationSeconds);
    previewCurrentGraph.setData(points, durationSeconds);
  } catch (error) {
    previewVoltageGraph.clear();
    previewCurrentGraph.clear();
    elements.previewGraphs.style.width = "";
    elements.previewGraphScroll.scrollLeft = 0;
    elements.pythonStatus.textContent = `Preview error: ${error.message}`;
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
elements.previewPython.addEventListener("click", handlePreviewPython);
elements.previewZoom.addEventListener("input", () => applyPreviewZoom());
elements.previewZoomOut.addEventListener("click", () => {
  elements.previewZoom.value = String(Math.max(0, Number(elements.previewZoom.value) - 1));
  applyPreviewZoom();
});
elements.previewZoomIn.addEventListener("click", () => {
  elements.previewZoom.value = String(Math.min(
    PREVIEW_ZOOM_LEVELS.length - 1,
    Number(elements.previewZoom.value) + 1,
  ));
  applyPreviewZoom();
});
elements.previewZoomFit.addEventListener("click", () => {
  elements.previewZoom.value = "0";
  applyPreviewZoom({ preserveCenter: false });
});
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
  setStatus("Python control running. break・ジェネレーター終了・STOPまで周期実行します。", "success");
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
  elements.currentIteration.textContent = String(sample.i);
  elements.currentControlCycle.textContent = `${sample.controlCycleMs} ms`;
  elements.currentVmax.textContent = `${sample.voltageMax.toFixed(3)} V`;
  elements.currentAmax.textContent = `${sample.currentMax.toFixed(3)} A`;
  elements.commandVoltage.textContent = sample.commandVoltage.toFixed(3);
  if (elements.commandCurrent) {
    elements.commandCurrent.textContent = sample.commandCurrent.toFixed(3);
  }
  elements.elapsedTime.textContent = formatDuration(sample.elapsedSeconds);
  elements.remainingTime.textContent = "—";
  elements.finishTime.textContent = "generator end";
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
  setStatus(`Completed at i=${event.detail.iterations}. OUTPUT OFF. ${logSummary(event.detail.recordCount)}を保存できます。`, "success");
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
