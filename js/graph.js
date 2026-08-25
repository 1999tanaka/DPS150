const COLORS = Object.freeze({
  grid: "rgba(80, 110, 128, 0.22)",
  commandVoltage: "#37d6cf",
  measuredVoltage: "#ffb347",
  commandCurrent: "#60a5fa",
  measuredCurrent: "#a8df4f",
  label: "#7890a1",
  empty: "#506777",
});

const LIVE_LEAD_SECONDS = 1;

export function resolveWindowSeconds(period) {
  if (period <= 1) return 10;
  if (period <= 5) return 20;
  return 30;
}

export function resolveTimeAxis(latestTime, windowSeconds) {
  const safeLatestTime = Math.max(0, Number.isFinite(latestTime) ? latestTime : 0);
  const xMax = safeLatestTime + LIVE_LEAD_SECONDS;
  const xMin = xMax - windowSeconds;
  const ticks = [];
  const firstTick = Math.max(0, Math.ceil(xMin));
  const lastTick = Math.floor(xMax);
  for (let time = firstTick; time <= lastTick; time += 1) ticks.push(time);
  return { xMin, xMax, ticks };
}

function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

class LiveGraph {
  constructor(canvas, {
    maxPoints = 10_000,
    windowSeconds = 30,
    fixedYMax = null,
    minimumYMax = 1,
    series = [],
    emptyLabel = "WAITING FOR EXPERIMENT DATA",
  } = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new TypeError("LiveGraph requires a canvas element.");
    }
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.maxPoints = maxPoints;
    this.windowSeconds = windowSeconds;
    this.fixedYMax = fixedYMax;
    this.minimumYMax = minimumYMax;
    this.series = series;
    this.emptyLabel = emptyLabel;
    this.points = [];
    this.frameRequested = false;
    this.resizeObserver = new ResizeObserver(() => this.requestDraw());
    this.resizeObserver.observe(canvas);
    this.requestDraw();
  }

  clear() {
    this.points.length = 0;
    this.requestDraw();
  }

  setPeriod(period) {
    this.windowSeconds = resolveWindowSeconds(period);
    this.requestDraw();
    return this.windowSeconds;
  }

  addPoint(point) {
    if (!Number.isFinite(point.time)) return;
    if (!this.series.some(({ key }) => Number.isFinite(point[key]))) return;
    const normalized = { time: point.time };
    for (const { key } of this.series) {
      normalized[key] = Number.isFinite(point[key]) ? point[key] : null;
    }
    this.points.push(normalized);
    if (this.points.length > this.maxPoints) {
      // Trim in batches so a long 10 ms run does not shift a 10,000-item
      // array on every single sample after the buffer becomes full.
      const overflow = this.points.length - this.maxPoints;
      const trimCount = Math.max(overflow, Math.floor(this.maxPoints * 0.1));
      this.points.splice(0, trimCount);
    }
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

  resolveYMax(visiblePoints) {
    if (Number.isFinite(this.fixedYMax)) return this.fixedYMax;
    let observedMax = this.minimumYMax;
    for (const point of visiblePoints) {
      for (const { key } of this.series) {
        if (Number.isFinite(point[key])) observedMax = Math.max(observedMax, point[key]);
      }
    }
    return niceCeiling(observedMax * 1.1);
  }

  draw() {
    const ctx = this.context;
    const { width, height } = this.prepareCanvas();
    const margin = { top: 14, right: 14, bottom: 27, left: 48 };
    const plotWidth = Math.max(1, width - margin.left - margin.right);
    const plotHeight = Math.max(1, height - margin.top - margin.bottom);
    const latestTime = this.points.at(-1)?.time ?? 0;
    const { xMin, xMax, ticks } = resolveTimeAxis(latestTime, this.windowSeconds);
    const visiblePoints = this.points.filter((point) => point.time >= xMin - 1);
    const yMin = 0;
    const yMax = this.resolveYMax(visiblePoints);
    const yDigits = yMax < 0.1 ? 3 : yMax < 1 ? 2 : yMax < 10 ? 1 : 0;

    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1;
    ctx.font = '9px "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = "middle";

    const xToCanvas = (value) => margin.left + ((value - xMin) / this.windowSeconds) * plotWidth;
    const yToCanvas = (value) => margin.top + ((yMax - value) / (yMax - yMin)) * plotHeight;

    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = COLORS.label;
    for (let tick = 0; tick <= 5; tick += 1) {
      const value = yMin + ((yMax - yMin) * tick) / 5;
      const y = yToCanvas(value);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(value.toFixed(yDigits), margin.left - 8, y);
    }

    for (const time of ticks) {
      const x = xToCanvas(time);
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, height - margin.bottom);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(`${time}`, x, height - 12);
    }

    if (this.points.length === 0) {
      ctx.fillStyle = COLORS.empty;
      ctx.textAlign = "center";
      ctx.font = '11px "Cascadia Mono", Consolas, monospace';
      ctx.fillText(this.emptyLabel, margin.left + plotWidth / 2, margin.top + plotHeight / 2);
      return;
    }

    for (const { key, color, lineWidth } of this.series) {
      this.drawSeries(visiblePoints, key, color, xToCanvas, yToCanvas, lineWidth);
    }

    this.drawLiveEdge(visiblePoints.at(-1), xToCanvas);
  }

  drawLiveEdge(latestPoint, xToCanvas) {
    if (!latestPoint) return;
    const x = xToCanvas(latestPoint.time);
    const ctx = this.context;
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "rgba(55, 214, 207, 0.42)";
    ctx.beginPath();
    ctx.moveTo(x, 14);
    ctx.lineTo(x, this.canvas.clientHeight - 27);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.commandVoltage;
    ctx.textAlign = "center";
    ctx.font = '700 8px "Cascadia Mono", Consolas, monospace';
    ctx.fillText("LIVE", x, 8);
    ctx.restore();
  }

  drawSeries(points, key, color, xToCanvas, yToCanvas, lineWidth) {
    const ctx = this.context;
    let drawing = false;
    ctx.beginPath();
    for (const point of points) {
      const value = point[key];
      if (!Number.isFinite(value)) {
        drawing = false;
        continue;
      }
      const x = xToCanvas(point.time);
      const y = yToCanvas(value);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }

  destroy() {
    this.resizeObserver.disconnect();
  }
}

export class VoltageGraph extends LiveGraph {
  constructor(canvas, options = {}) {
    super(canvas, {
      ...options,
      fixedYMax: 15,
      series: [
        { key: "commandVoltage", color: COLORS.commandVoltage, lineWidth: 1.8 },
        { key: "measuredVoltage", color: COLORS.measuredVoltage, lineWidth: 1.45 },
      ],
    });
  }
}

export class CurrentGraph extends LiveGraph {
  constructor(canvas, options = {}) {
    super(canvas, {
      ...options,
      minimumYMax: 0.1,
      series: [
        { key: "commandCurrent", color: COLORS.commandCurrent, lineWidth: 1.8 },
        { key: "measuredCurrent", color: COLORS.measuredCurrent, lineWidth: 1.45 },
      ],
    });
  }
}
