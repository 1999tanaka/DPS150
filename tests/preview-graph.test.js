import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPreviewStepPoints,
  MAX_PREVIEW_GRAPH_WIDTH,
  MAX_PREVIEW_RENDER_WIDTH,
  resolvePreviewGraphWidth,
  resolvePreviewTimeTickStep,
  resolveZoomedPreviewGraphWidth,
  resolvePreviewYDomain,
} from "../js/preview-graph.js";

test("preview graph pads a changing waveform domain", () => {
  const domain = resolvePreviewYDomain([13, 14]);
  assert.ok(domain.min < 13);
  assert.ok(domain.max > 14);
  assert.ok(domain.min >= 0);
});

test("preview graph gives a constant waveform visible vertical space", () => {
  const domain = resolvePreviewYDomain([13.5, 13.5]);
  assert.ok(domain.min < 13.5);
  assert.ok(domain.max > 13.5);
});

test("preview graph falls back safely for empty data", () => {
  assert.deepEqual(resolvePreviewYDomain([]), { min: 0, max: 1 });
});

test("preview graph holds each command until the next control cycle", () => {
  const path = buildPreviewStepPoints([
    { time: 0, commandVoltage: 13 },
    { time: 0.05, commandVoltage: 14 },
  ], 0.1, "commandVoltage");

  assert.deepEqual(path, [
    { time: 0, value: 13 },
    { time: 0.05, value: 13 },
    { time: 0.05, value: 14 },
    { time: 0.1, value: 14 },
  ]);
});

test("long previews become horizontally scrollable instead of compressed", () => {
  assert.equal(resolvePreviewGraphWidth({
    pointCount: 10_000,
    durationSeconds: 500,
    viewportWidth: 800,
  }), MAX_PREVIEW_GRAPH_WIDTH);
  assert.equal(resolvePreviewGraphWidth({
    pointCount: 100,
    durationSeconds: 5,
    viewportWidth: 800,
  }), 800);
});

test("wide preview graphs use readable time tick intervals", () => {
  assert.equal(resolvePreviewTimeTickStep(500, 10_000), 5);
  assert.equal(resolvePreviewTimeTickStep(5, 800), 1);
});

test("time zoom supports fit, zoom out, and zoom in widths", () => {
  const options = { baseWidth: 10_000, viewportWidth: 800 };
  assert.equal(resolveZoomedPreviewGraphWidth({ ...options, zoom: 0 }), 800);
  assert.equal(resolveZoomedPreviewGraphWidth({ ...options, zoom: 0.25 }), 2_500);
  assert.equal(resolveZoomedPreviewGraphWidth({ ...options, zoom: 1 }), 10_000);
  assert.equal(resolveZoomedPreviewGraphWidth({ ...options, zoom: 2 }), MAX_PREVIEW_RENDER_WIDTH);
});
