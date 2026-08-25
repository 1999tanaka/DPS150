const COLORS = Object.freeze({
  grid: "rgba(80, 110, 128, 0.22)",
  axis: "#587083",
  command: "#37d6cf",
  measured: "#ffb347",
  label: "#7890a1",
  empty: "#506777",
});

export class VoltageGraph {
  constructor(canvas, { maxPoints = 2_000, windowSeconds = 30 } = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new TypeError("VoltageGraph requires a canvas element.");
    }
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.maxPoints = maxPoints;
    this.windowSeconds = windowSeconds;
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
    if (period <= 1) this.windowSeconds = 10;
    else if (period <= 5) this.windowSeconds = 30;
    else this.windowSeconds = 60;
    this.requestDraw();
    return this.windowSeconds;
  }

  addPoint(point) {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.commandVoltage)) return;
    this.points.push({
      time: point.time,
      commandVoltage: point.commandVoltage,
      measuredVoltage: Number.isFinite(point.measuredVoltage) ? point.measuredVoltage : null,
    });
    if (this.points.length > this.maxPoints) {
      this.points.splice(0, this.points.length - this.maxPoints);
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

  draw() {
    const ctx = this.context;
    const { width, height } = this.prepareCanvas();
    const margin = { top: 14, right: 14, bottom: 27, left: 42 };
    const plotWidth = Math.max(1, width - margin.left - margin.right);
    const plotHeight = Math.max(1, height - margin.top - margin.bottom);
    const yMin = 0;
    const yMax = 15;
    const latestTime = this.points.at(-1)?.time ?? 0;
    const xMax = Math.max(this.windowSeconds, latestTime);
    const xMin = xMax - this.windowSeconds;

    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1;
    ctx.font = '9px "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = "middle";

    const xToCanvas = (value) => margin.left + ((value - xMin) / this.windowSeconds) * plotWidth;
    const yToCanvas = (value) => margin.top + ((yMax - value) / (yMax - yMin)) * plotHeight;

    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = COLORS.label;
    for (let tick = 0; tick <= 5; tick += 1) {
      const voltage = yMin + ((yMax - yMin) * tick) / 5;
      const y = yToCanvas(voltage);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(voltage.toFixed(0), margin.left - 8, y);
    }

    for (let tick = 0; tick <= 6; tick += 1) {
      const time = xMin + (this.windowSeconds * tick) / 6;
      const x = xToCanvas(time);
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, height - margin.bottom);
      ctx.stroke();
      ctx.textAlign = tick === 0 ? "left" : tick === 6 ? "right" : "center";
      ctx.fillText(`${Math.max(0, time).toFixed(0)}`, x, height - 12);
    }

    if (this.points.length === 0) {
      ctx.fillStyle = COLORS.empty;
      ctx.textAlign = "center";
      ctx.font = '11px "Cascadia Mono", Consolas, monospace';
      ctx.fillText("WAITING FOR EXPERIMENT DATA", margin.left + plotWidth / 2, margin.top + plotHeight / 2);
      return;
    }

    const visiblePoints = this.points.filter((point) => point.time >= xMin - 1);
    this.drawSeries(visiblePoints, "commandVoltage", COLORS.command, xToCanvas, yToCanvas, 1.8);
    this.drawSeries(visiblePoints, "measuredVoltage", COLORS.measured, xToCanvas, yToCanvas, 1.45);
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
