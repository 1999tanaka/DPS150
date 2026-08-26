const COLORS = Object.freeze({
  grid: "rgba(80, 110, 128, 0.24)",
  label: "#8ba0ae",
  voltage: "#37d6cf",
  current: "#60a5fa",
  empty: "#506777",
});

export function resolvePreviewYDomain(values, { minimum = 0 } = {}) {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return { min: minimum, max: minimum + 1 };
  let min = Math.min(...finiteValues);
  let max = Math.max(...finiteValues);
  const range = max - min;
  const padding = range > 0
    ? range * 0.08
    : Math.max(Math.abs(max) * 0.02, 0.01);
  min = Math.max(minimum, min - padding);
  max += padding;
  if (max <= min) max = min + 1;
  return { min, max };
}

function formatAxisValue(value, range) {
  if (range < 0.1) return value.toFixed(3);
  if (range < 1) return value.toFixed(2);
  if (range < 10) return value.toFixed(1);
  return value.toFixed(0);
}

export function buildPreviewStepPoints(points, durationSeconds, key) {
  if (points.length === 0) return [];
  const path = [{ time: points[0].time, value: points[0][key] }];
  for (let index = 1; index < points.length; index += 1) {
    path.push(
      { time: points[index].time, value: points[index - 1][key] },
      { time: points[index].time, value: points[index][key] },
    );
  }
  path.push({ time: durationSeconds, value: points.at(-1)[key] });
  return path;
}

export class PlannedWaveformGraph {
  constructor(canvas, {
    key,
    color,
    emptyLabel = "NO PREVIEW DATA",
  }) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new TypeError("PlannedWaveformGraph requires a canvas element.");
    }
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.key = key;
    this.color = color;
    this.emptyLabel = emptyLabel;
    this.points = [];
    this.durationSeconds = 1;
    this.frameRequested = false;
    this.resizeObserver = new ResizeObserver(() => this.requestDraw());
    this.resizeObserver.observe(canvas);
    this.requestDraw();
  }

  setData(points, durationSeconds) {
    this.points = points.filter((point) => (
      Number.isFinite(point.time) && Number.isFinite(point[this.key])
    ));
    this.durationSeconds = Math.max(
      Number(durationSeconds) || 0,
      this.points.at(-1)?.time ?? 0,
      0.001,
    );
    this.requestDraw();
  }

  clear() {
    this.points = [];
    this.durationSeconds = 1;
    this.requestDraw();
  }

  requestDraw() {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.draw();
    });
  }

  prepareCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const targetWidth = Math.round(width * pixelRatio);
    const targetHeight = Math.round(height * pixelRatio);
    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
    }
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    return { width, height };
  }

  draw() {
    const ctx = this.context;
    const { width, height } = this.prepareCanvas();
    const margin = { top: 14, right: 16, bottom: 31, left: 58 };
    const plotWidth = Math.max(1, width - margin.left - margin.right);
    const plotHeight = Math.max(1, height - margin.top - margin.bottom);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '9px "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = "middle";

    if (this.points.length === 0) {
      ctx.fillStyle = COLORS.empty;
      ctx.textAlign = "center";
      ctx.fillText(this.emptyLabel, margin.left + plotWidth / 2, margin.top + plotHeight / 2);
      return;
    }

    const values = this.points.map((point) => point[this.key]);
    const yDomain = resolvePreviewYDomain(values);
    const yRange = yDomain.max - yDomain.min;
    const xToCanvas = (value) => margin.left + (value / this.durationSeconds) * plotWidth;
    const yToCanvas = (value) => (
      margin.top + ((yDomain.max - value) / yRange) * plotHeight
    );

    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = COLORS.label;
    for (let tick = 0; tick <= 4; tick += 1) {
      const value = yDomain.min + (yRange * tick) / 4;
      const y = yToCanvas(value);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(formatAxisValue(value, yRange), margin.left - 8, y);
    }

    for (let tick = 0; tick <= 5; tick += 1) {
      const time = (this.durationSeconds * tick) / 5;
      const x = xToCanvas(time);
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, height - margin.bottom);
      ctx.stroke();
      ctx.textAlign = tick === 0 ? "left" : tick === 5 ? "right" : "center";
      ctx.fillText(formatAxisValue(time, this.durationSeconds), x, height - 15);
    }

    const stepPoints = buildPreviewStepPoints(this.points, this.durationSeconds, this.key);
    ctx.beginPath();
    stepPoints.forEach((point, index) => {
      const x = xToCanvas(point.time);
      const y = yToCanvas(point.value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }

  destroy() {
    this.resizeObserver.disconnect();
  }
}

export const PREVIEW_GRAPH_COLORS = Object.freeze({
  voltage: COLORS.voltage,
  current: COLORS.current,
});
